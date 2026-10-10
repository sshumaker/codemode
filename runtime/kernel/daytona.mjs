/**
 * The daytona kernel backend: one Daytona sandbox per conversation, over
 * runtime/daytona/provider.mjs.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { WarmPool } from "./daytona-pool.mjs";
import { HARNESS_ROOT, stageRemoteStartup } from "./prelude.mjs";
import { SandboxWorkspaceFiles } from "./workspace-files.mjs";

const SILENT = { info() {}, warn() {} };

/** A sandbox whose conversation is gone is kept this long first: a subagent's sandbox exists before its row. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const SANDBOX_HOME = "/home/daytona";
const SANDBOX_WORK = `${SANDBOX_HOME}/work`;
const SANDBOX_RUNTIME = `${SANDBOX_HOME}/harness-runtime`;
/** Where the prelude looks for its modules, jobs and status marker in the sandbox. */
export const REMOTE_PRELUDE_ENV = {
	HARNESS_RUNTIME_DIR: SANDBOX_RUNTIME,
	HARNESS_JOB_DIR: `${SANDBOX_WORK}/.jobs`,
	HARNESS_PRELUDE_MARKER: `${SANDBOX_HOME}/.harness-prelude-status.txt`,
};
/** provider.mjs's own app label: every sandbox it creates carries it. */
const APP_LABEL = "assistant-workspace";
/** The connect file before the sandbox is ready: prime's kernel link waits on it. */
const PENDING_CONNECT = `${JSON.stringify({ pending: true })}\n`;
/** Marker in the conversation dir: this conversation has had a sandbox (so a fresh one is a recreation). */
const SANDBOX_MARKER = "daytona-sandbox";

/**
 * The kernel env prime needs that does not depend on which sandbox it gets: the work
 * dir and the path map follow from the mounts, the same way the provider resolves them
 * (a relative remote is under the work dir). Known before the sandbox is, so prime can
 * start in parallel with it; open() checks the real connection agrees.
 */
export function predictedKernelEnv(mounts) {
	const resolved = mounts.map((m) => ({
		local: m.local,
		remote: m.remote.startsWith("/") ? m.remote : posix.join(SANDBOX_WORK, m.remote),
	}));
	return { HARNESS_REMOTE_KERNEL_CWD: SANDBOX_WORK, HARNESS_REMOTE_KERNEL_PATH_MAP: JSON.stringify(resolved) };
}

/**
 * What every conversation's sandbox gets uploaded: the api/ tree, the skill roots, the
 * IPython startup hooks (the prelude among them) and the harness runtime it imports.
 */
export function sandboxMounts(apiTreeDir, skillRoots, startupHooksDir, runtimeDir) {
	return [
		{ local: apiTreeDir, remote: "api" },
		...skillRoots.map((root, i) => ({ local: root, remote: `${SANDBOX_HOME}/skills/${i}-${basename(root)}` })),
		{ local: startupHooksDir, remote: `${SANDBOX_HOME}/.ipython/profile_default/startup` },
		...(runtimeDir ? [{ local: runtimeDir, remote: SANDBOX_RUNTIME }] : []),
	];
}

/**
 * The kernel runs in a Daytona sandbox per conversation (runtime/daytona/): prime stays
 * on the host, speaks one WebSocket to a kernel server in the sandbox, and all of its
 * file tools run there too. The sandbox has no outbound network; tool calls come back
 * over the socket to prime, which posts them to the host's proxy on loopback with the
 * egress token, so the token never enters the sandbox.
 *
 * Files: the host work dir is not shared. Attachments are uploaded on putInput, outputs
 * are listed and read through the sandbox's file API. The api/ tree, the skill roots and
 * the IPython startup hooks are uploaded once per content hash by ensure(). A
 * conversation that had a sandbox before and gets a fresh one (the old one was deleted
 * after a long idle) has `ctx.restoreFiles()` put back before the kernel is handed over.
 *
 * Lifecycle: open() returns at once with prime's env and a connect file that reads
 * "pending"; the sandbox comes up behind `ready` (a warm-pool claim, else ensure()), and
 * prime's kernel link waits on the file, so prime starts in parallel with the sandbox.
 * Once ready the backend holds a Daytona keep-alive while prime runs (kernel-socket
 * traffic is not Daytona activity); release() drops it, and Daytona's own auto-stop
 * (15 min) stops the sandbox; destroy() deletes it; sweepIdle() deletes long-idle ones.
 */
export class DaytonaKernelBackend {
	constructor(opts = {}) {
		this.name = "daytona";
		this.harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
		this.labels = opts.labels ?? {};
		/** Tests inject a stand-in for runtime/daytona/provider.mjs. */
		this.mod = opts.providerModule;
		/** Passed to every DaytonaKernelProvider (apiKey, a `daytona` client in tests, resources...). */
		this.providerOptions = opts.providerOptions ?? {};
		this.poolSize = opts.poolSize ?? 0;
		/** Distinguishes this installation's pool and sweep from another host's on the same account. */
		this.poolOwner = opts.poolOwner ?? "default";
		/**
		 * Daytona deletes a sandbox itself once it has been stopped this long: the backstop for
		 * a host that is gone and so never sweeps. -1 disables. sweepIdle is the primary
		 * mechanism and runs well before this.
		 */
		this.autoDeleteMinutes = opts.autoDeleteMinutes ?? -1;
		this.extraStartupFiles = opts.extraStartupFiles ?? {};
		this.log = opts.log ?? SILENT;
		this.provider = undefined;
		this.pool = undefined;
		this.poolProvider = undefined;
		/** Conversations known to have a sandbox already (no pool claim needed). */
		this.bound = new Set();
		/** Where the startup hooks are staged; shared, so a pool sandbox's mounts are a conversation's. */
		this.hooksDir = undefined;
		/** The staged harness runtime (HARNESS_RUNTIME_DIR in the sandbox), when the prelude is installed. */
		this.runtimeDir = undefined;
	}

	async loadModule() {
		this.mod ??= await import(pathToFileURL(join(this.harnessRoot, "runtime/daytona/provider.mjs")).href);
		return this.mod;
	}

	newProvider(mod, labels, logMsg) {
		return new mod.DaytonaKernelProvider({
			...this.providerOptions,
			labels,
			autoStopMinutes: 15,
			autoDeleteMinutes: this.autoDeleteMinutes,
			log: (line) => this.log.info(logMsg, { line }),
		});
	}

	/** Start the warm pool, with the same uploads a conversation gets, so a claim only relabels. */
	async start(opts) {
		this.hooksDir = this.stageStartupHooks(opts.dataDir);
		if (this.poolSize <= 0) return;
		const mod = await this.loadModule();
		await this.load();
		const mounts = sandboxMounts(opts.apiTreeDir, opts.skillRoots, this.hooksDir, this.runtimeDir);
		const raw = this.newProvider(mod, { ...this.labels, pool: "warm", pool_owner: this.poolOwner }, "daytona pool");
		const provider = {
			ensure: (id) => raw.ensure(id, { mounts }),
			verify: (info) => raw.verify(info),
			keepAlive: (id, o) => raw.keepAlive(id, o),
			destroy: (id) => raw.destroy(id),
			find: (id) => raw.find(id),
			listOrphans: () => raw.listOrphans(),
		};
		this.pool = new WarmPool({
			provider,
			size: this.poolSize,
			log: this.log,
			// Daytona merges labels on update: overwrite the pool's own keys explicitly, or a
			// claimed sandbox would still read pool=warm and a restart would adopt it back.
			labelsFor: (conversationId) => ({
				app: APP_LABEL,
				...this.labels,
				pool: "claimed",
				pool_owner: this.poolOwner,
				conversation: conversationId,
			}),
		});
		this.poolProvider = raw;
		this.log.info("daytona warm pool starting", { size: this.poolSize, owner: this.poolOwner });
		await this.pool.start();
	}

	async load() {
		const mod = await this.loadModule();
		// The owner label is what scopes sweepIdle to this host's sandboxes: other hosts (a
		// laptop, CI) share the account and must never be swept by this one.
		this.provider ??= this.newProvider(mod, { ...this.labels, pool_owner: this.poolOwner }, "daytona");
		return { provider: this.provider, mod };
	}

	/** The startup hooks, staged in a host dir the provider can upload. */
	stageStartupHooks(parentDir) {
		const staged = stageRemoteStartup(this.harnessRoot, parentDir, this.extraStartupFiles);
		if (staged.runtimeDir) this.runtimeDir = staged.runtimeDir;
		return staged.hooksDir;
	}

	async open(ctx) {
		const { provider, mod } = await this.load();
		const id = ctx.conversationId;
		const hooksDir = this.hooksDir ?? this.stageStartupHooks(ctx.convDir);
		const mounts = sandboxMounts(ctx.apiTreeDir, ctx.skillRoots, hooksDir, this.runtimeDir);
		const predicted = predictedKernelEnv(mounts);
		// Re-read by prime on every reconnect, so a restarted sandbox's new preview token
		// reaches a daemon that outlived the client that started it.
		const connectFile = join(ctx.convDir, "remote-kernel.json");
		writeFileSync(connectFile, PENDING_CONNECT, { mode: 0o600 });
		const hadSandbox = existsSync(join(ctx.convDir, SANDBOX_MARKER));
		let resolveRestored = () => {};
		const restored = new Promise((r) => (resolveRestored = r));
		if (!hadSandbox) resolveRestored(0);
		let released = false;
		let releaseKeepAlive;
		const ready = this.bringUp(ctx, mounts, provider).then(async ({ info, fresh }) => {
			resolveRestored(hadSandbox && fresh ? await this.restore(ctx, provider) : 0);
			const env = mod.connectionEnv(info);
			for (const k of ["HARNESS_REMOTE_KERNEL_CWD", "HARNESS_REMOTE_KERNEL_PATH_MAP"]) {
				if (env[k] !== predicted[k])
					throw new Error(`the sandbox's ${k} (${env[k]}) is not the one prime was started with (${predicted[k]})`);
			}
			writeFileSync(connectFile, mod.connectFileContents(info), { mode: 0o600 });
			// Without an explicit keep-alive, Daytona stops a sandbox mid-turn: traffic on the
			// kernel's socket does not count as activity. Held while prime is alive.
			if (!released) releaseKeepAlive = provider.keepAlive(id, { intervalMs: 60_000 });
		});
		ready.catch(() => resolveRestored(0));
		ready.catch((err) => {
			// Fail prime's waiting kernel connect now, with the reason, rather than at its timeout.
			writeFileSync(connectFile, `${JSON.stringify({ error: err.message.slice(0, 500) })}\n`, { mode: 0o600 });
		});
		return {
			primeCwd: ctx.workDir,
			ready,
			restored,
			primeEnv: {
				// The connect file alone switches prime to the remote kernel; the URL, token and
				// preview header live in it, out of every process listing.
				HARNESS_REMOTE_KERNEL_CONNECT_FILE: connectFile,
				...predicted,
				HARNESS_KERNEL_AUTORESTART: "1",
				// Path-shaped HARNESS_* vars are not forwarded to a remote kernel by name.
				...(this.runtimeDir ? { HARNESS_REMOTE_KERNEL_ENV: JSON.stringify(REMOTE_PRELUDE_ENV) } : {}),
				// Read on the LOOP side: the tunnel forwards the kernel's calls here.
				HARNESS_MCP_PROXY: `${ctx.localBaseUrl}${ctx.toolProxyPath}`,
				HARNESS_EGRESS_TOKEN: ctx.egressToken,
			},
			putInput: async (relPath, hostPath) => {
				await ready;
				await provider.uploadFile(id, relPath, readFileSync(hostPath));
			},
			listOutputs: async () => {
				await ready;
				return provider.listTree(id, "outputs");
			},
			readOutput: async (relPath) => {
				await ready;
				return provider.readFile(id, relPath);
			},
			files: new SandboxWorkspaceFiles(provider, id, ready),
			workDirAliases: [SANDBOX_WORK],
			// A waited-on job lives in the sandbox, so the scheduler judging it runs there.
			...(this.runtimeDir && provider.runKernelPython
				? {
						scheduler: async (args, stdin) => {
							await ready;
							return provider.runKernelPython(id, [`${SANDBOX_RUNTIME}/scheduler.py`, ...args], stdin, 60);
						},
						schedulerPollMs: 15_000,
					}
				: {}),
			// No stop() here: prime exits on idle eviction and on every host restart, and a stop
			// issued now can land after the next open() has already reused the sandbox (another
			// host process has no lock to order it against). Releasing the keep-alive hands the
			// sandbox to Daytona's auto-stop (15 min), which cannot race.
			release: async () => {
				released = true;
				releaseKeepAlive?.();
			},
		};
	}

	/** Put a recreated sandbox's workspace back from the host's copies; files gone from the host are skipped. */
	async restore(ctx, provider) {
		if (!ctx.restoreFiles) return 0;
		let n = 0;
		for (const f of ctx.restoreFiles()) {
			if (!existsSync(f.hostPath)) continue;
			await provider.uploadFile(ctx.conversationId, f.relPath, readFileSync(f.hostPath));
			n++;
		}
		this.log.info("daytona workspace restored", { conversationId: ctx.conversationId, files: n });
		return n;
	}

	/**
	 * The conversation's sandbox, ready: a warm one whose server answered at claim time is
	 * used as warmed; anything else (no pool, none ready, a claim that did not verify, a
	 * conversation that had a sandbox already) goes through ensure().
	 */
	async bringUp(ctx, mounts, provider) {
		const id = ctx.conversationId;
		const t0 = Date.now();
		let claim;
		if (this.pool && !this.bound.has(id) && (await this.hasNoSandbox(ctx, provider))) claim = await this.pool.claim(id);
		this.bound.add(id);
		if (claim) provider.bind?.(id, claim.sandboxId);
		const info = claim?.info ? { ...claim.info, created: false } : await provider.ensure(id, { mounts });
		this.log.info("daytona sandbox ready", {
			conversationId: id,
			sandboxId: info.sandboxId,
			created: info.created,
			fromPool: !!claim,
			rebound: !!claim?.info,
			egress: info.posture?.egress,
			ms: Date.now() - t0,
			timings: claim?.info ? undefined : info.timings,
		});
		// Recorded whether or not a pool was involved: it is how a later open() knows this
		// conversation had a sandbox (and so what a fresh one has to get back).
		const marker = join(ctx.convDir, SANDBOX_MARKER);
		if (!existsSync(marker)) writeFileSync(marker, `${new Date().toISOString()}\n`);
		return { info, fresh: !!claim || info.created };
	}

	/**
	 * Delete this host's conversation sandboxes idle longer than `olderThanMs`. Only
	 * sandboxes carrying this host's owner label are considered, the warm pool is never
	 * touched, and a conversation with a live process is skipped. A sandbox whose
	 * conversation no longer exists goes after a short grace period (a subagent's sandbox is
	 * created before its row), everything else only when both the conversation and Daytona
	 * agree it has been idle that long.
	 */
	async sweepIdle(opts) {
		const { provider } = await this.load();
		if (!provider.listOrphans) return { deleted: [], kept: 0 };
		const now = Date.now();
		const deleted = [];
		let kept = 0;
		for (const s of await provider.listOrphans()) {
			const id = s.conversationId;
			if (!id || id.startsWith("pool-") || opts.isOpen(id)) {
				kept++;
				continue;
			}
			const daytonaIdle = s.lastActivityAt ? now - Date.parse(s.lastActivityAt) : Number.POSITIVE_INFINITY;
			const last = opts.lastActive(id);
			const stale = last
				? now - last.getTime() > opts.olderThanMs && daytonaIdle > opts.olderThanMs
				: daytonaIdle > ORPHAN_GRACE_MS;
			if (!stale) {
				kept++;
				continue;
			}
			try {
				await provider.destroy(id);
				this.bound.delete(id);
				deleted.push(id);
			} catch (err) {
				this.log.warn("sweep: could not delete an idle sandbox", { conversationId: id, error: String(err) });
				kept++;
			}
		}
		if (deleted.length) this.log.info("sweep: deleted idle sandboxes", { count: deleted.length, kept });
		return { deleted, kept };
	}

	/**
	 * True when this conversation certainly has no sandbox yet. The first open writes a
	 * marker before any sandbox can exist for it, so a missing marker answers without a
	 * label search (a Daytona round trip on every new chat); with one, ask Daytona.
	 */
	async hasNoSandbox(ctx, provider) {
		const marker = join(ctx.convDir, SANDBOX_MARKER);
		if (!existsSync(marker)) {
			writeFileSync(marker, `${new Date().toISOString()}\n`);
			return true;
		}
		return !!provider.find && !(await provider.find(ctx.conversationId));
	}

	async destroy(conversationId) {
		const { provider } = await this.load();
		this.bound.delete(conversationId);
		await provider.destroy(conversationId);
	}

	/** Delete the warm pool's ready sandboxes; safe to run while conversations shut down. */
	async drain() {
		await this.pool?.close();
	}

	async shutdown() {
		await this.pool?.close();
		await this.poolProvider?.close();
		await this.provider?.close();
	}
}
