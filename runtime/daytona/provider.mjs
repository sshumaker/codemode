/**
 * DaytonaKernelProvider: one Daytona sandbox per conversation, with the harness
 * kernel server running in it and its egress locked. The gateway calls this; prime
 * never does — prime only sees the env vars `connectionEnv()` returns.
 *
 * Owns: finding/creating/starting/stopping/deleting the conversation's sandbox,
 * putting the kernel runtime into it (prebuilt snapshot when one exists, upload
 * otherwise), launching and health-checking the kernel server, locking and
 * verifying egress, syncing read-only trees (api/, skills/), conversation files
 * (inputs/ in, outputs/ out), and reaping sandboxes nobody owns.
 *
 * Not responsible for: the kernel protocol (vendored prime, core/kernel/remote/),
 * deciding when a conversation is idle (the gateway calls stop()), or tool calls
 * (they arrive at the gateway's own proxy through prime).
 *
 * Every sandbox it creates carries labels {app: "assistant-workspace",
 * conversation: <id>, ...extraLabels}; list/reap only ever touch sandboxes whose
 * labels match all of those, so unlabelled or foreign sandboxes are invisible to it.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { Daytona } from "@daytonaio/sdk";
import { buildKernelServerBundle, ZEROMQ_VERSION } from "./bundle.mjs";
import { IMAGE_RUNTIME_ROOT, listKernelSnapshots, runtimeEnv, snapshotName } from "./snapshot.mjs";

export const APP_LABEL = "assistant-workspace";
export const KERNEL_PORT = 8765;
const SERVER_LOG = "kernel-server.log";

function sh(value) {
	return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function slug(conversationId) {
	const clean = String(conversationId).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40);
	const hash = createHash("sha256").update(String(conversationId)).digest("hex").slice(0, 8);
	return `aw-${clean}-${hash}`;
}

function tarDir(dir) {
	const r = spawnSync("tar", ["-czf", "-", "-C", dir, "."], {
		maxBuffer: 1024 * 1024 * 1024,
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	if (r.status !== 0) throw new Error(`tar ${dir}: ${r.stderr.toString()}`);
	return r.stdout;
}

function hashDir(dir) {
	const hash = createHash("sha256");
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (e.name === "__pycache__" || e.name === ".DS_Store") continue;
			const full = join(d, e.name);
			const st = statSync(full);
			if (st.isDirectory()) walk(full);
			else if (st.isFile()) {
				hash.update(relative(dir, full));
				hash.update("\0");
				hash.update(readFileSync(full));
				hash.update("\0");
			}
		}
	};
	walk(dir);
	return hash.digest("hex").slice(0, 16);
}

/** Daytona's edge answers 502/503/504 now and then; setup commands here are idempotent. */
async function retryTransient(fn, attempts = 4) {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (error) {
			const status = error?.statusCode;
			if (i >= attempts || ![502, 503, 504].includes(status)) throw error;
			await new Promise((r) => setTimeout(r, 1000 * i));
		}
	}
}

/** A remote path under the conversation's work dir; refuses anything that escapes it. */
function underWork(workDir, rel) {
	const p = posix.normalize(rel.startsWith("/") ? rel : posix.join(workDir, rel));
	if (p !== workDir && !p.startsWith(`${workDir}/`)) throw new Error(`${rel} is outside the conversation's work dir`);
	return p;
}

export class DaytonaKernelProvider {
	/**
	 * @param {import("./provider.d.ts").DaytonaKernelProviderOptions} [options]
	 */
	constructor(options = {}) {
		this.daytona =
			options.daytona ??
			new Daytona({
				apiKey: options.apiKey ?? process.env.DAYTONA_API_KEY,
				apiUrl: options.apiUrl ?? process.env.DAYTONA_API_URL,
				target: options.target ?? process.env.DAYTONA_TARGET,
			});
		this.labels = { app: APP_LABEL, ...(options.labels ?? {}) };
		this.autoStopMinutes = options.autoStopMinutes ?? 15;
		this.autoDeleteMinutes = options.autoDeleteMinutes ?? -1;
		this.snapshot = options.snapshot;
		this.log = options.log ?? (() => {});
		this.resources = options.resources;
		this.bundle = undefined;
		this.locks = new Map();
	}

	/** Serialise lifecycle calls per conversation: two ensure()s must not race a create. */
	withLock(conversationId, fn) {
		const prev = this.locks.get(conversationId) ?? Promise.resolve();
		const next = prev.catch(() => {}).then(fn);
		this.locks.set(
			conversationId,
			next.finally(() => {
				if (this.locks.get(conversationId) === next) this.locks.delete(conversationId);
			}),
		);
		return next;
	}

	async bundleInfo() {
		this.bundle ??= await buildKernelServerBundle();
		return this.bundle;
	}

	async find(conversationId) {
		for await (const sb of this.daytona.list({ labels: { ...this.labels, conversation: String(conversationId) } })) {
			return sb;
		}
		return undefined;
	}

	/**
	 * Create or start the conversation's sandbox, make sure the kernel server is
	 * running the current bundle with egress locked, sync `mounts`, and return how
	 * to reach it.
	 * @returns {Promise<import("./provider.d.ts").KernelConnectionInfo>}
	 */
	ensure(conversationId, opts = {}) {
		return this.withLock(conversationId, () => this.ensureUnlocked(conversationId, opts));
	}

	async ensureUnlocked(conversationId, opts) {
		const t0 = Date.now();
		const timings = {};
		const mark = (name, since) => {
			timings[name] = Date.now() - since;
		};
		const { dir: bundleDir, version } = await this.bundleInfo();
		let sb = await this.find(conversationId);
		let created = false;
		if (!sb) {
			const t = Date.now();
			sb = await this.create(conversationId, version);
			created = true;
			mark("createMs", t);
		} else if (sb.state !== "started") {
			const t = Date.now();
			await sb.start(120);
			mark("startMs", t);
		}
		const home = (await sb.getUserHomeDir()) ?? "/home/daytona";
		const layout = await this.layoutOf(sb, home);
		if (layout.version !== version) {
			const t = Date.now();
			await this.installRuntime(sb, layout, bundleDir, version);
			mark("installMs", t);
		}
		const t1 = Date.now();
		const relocked = await this.lockEgress(sb);
		mark("lockMs", t1);
		const t2 = Date.now();
		const server = await this.ensureServer(sb, layout, version, relocked);
		mark("serverMs", t2);
		const t3 = Date.now();
		const mounts = await this.syncMounts(sb, layout, opts.mounts ?? []);
		if (opts.mounts?.length) mark("mountsMs", t3);
		const link = await sb.getPreviewLink(KERNEL_PORT);
		timings.totalMs = Date.now() - t0;
		return {
			conversationId: String(conversationId),
			sandboxId: sb.id,
			url: link.url.replace(/^http/, "ws"),
			token: server.token,
			headers: { "x-daytona-preview-token": link.token },
			remoteCwd: layout.workDir,
			mounts,
			posture: server.posture,
			version,
			created,
			timings,
		};
	}

	async create(conversationId, version) {
		const exact = this.snapshot ?? snapshotName(version);
		const snapshots = await listKernelSnapshots(this.daytona).catch(() => []);
		const usable = snapshots.filter((s) => s.state === "active");
		const pick = usable.find((s) => s.name === exact) ?? usable.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
		const params = {
			name: slug(conversationId),
			labels: { ...this.labels, conversation: String(conversationId) },
			autoStopInterval: this.autoStopMinutes,
			autoDeleteInterval: this.autoDeleteMinutes,
			public: false,
			// With the exact snapshot nothing needs the network, so it is never open.
			networkBlockAll: pick?.name === exact,
			...(pick ? { snapshot: pick.name } : {}),
			...(this.resources ? { resources: this.resources } : {}),
		};
		this.log(`creating ${params.name} from ${pick?.name ?? "the default image"}`);
		return this.daytona.create(params, { timeout: 180 });
	}

	/** Where the runtime is in this sandbox, and which bundle version it holds. */
	async layoutOf(sb, home) {
		const probe = await retryTransient(() =>
			sb.process.executeCommand(
			`for r in ${IMAGE_RUNTIME_ROOT} ${home}/.harness-runtime; do if [ -f $r/kpkg/VERSION ]; then echo "$r $(cat $r/kpkg/VERSION)"; exit 0; fi; done; echo "none"`,
			),
		);
		const [root, version] = probe.result.trim().split(/\s+/);
		const runtimeRoot = root === "none" ? `${home}/.harness-runtime` : root;
		return { home, root: runtimeRoot, version: root === "none" ? undefined : version, workDir: `${home}/work` };
	}

	async exec(sb, command, timeoutSec = 600) {
		const r = await retryTransient(() => sb.process.executeCommand(command, undefined, undefined, timeoutSec));
		if (r.exitCode !== 0) throw new Error(`sandbox command failed (${r.exitCode}): ${command.slice(0, 120)}\n${r.result.slice(-2000)}`);
		return r.result;
	}

	/**
	 * Put the current bundle into the sandbox and build the venv. Needs network, so
	 * egress is opened for the duration and locked again by the caller.
	 */
	async installRuntime(sb, layout, bundleDir, version) {
		this.log(`installing runtime ${version} into ${sb.id} (${layout.root})`);
		await sb.updateNetworkSettings({ networkBlockAll: false });
		const env = runtimeEnv(layout.root);
		const envStr = Object.entries(env)
			.map(([k, v]) => `${k}=${sh(v)}`)
			.join(" ");
		await sb.fs.uploadFile(tarDir(bundleDir), `${layout.home}/.kpkg-upload.tgz`);
		await this.exec(
			sb,
			`set -e; mkdir -p ${layout.root}/kpkg ${layout.root}/bin; cd ${layout.root}/kpkg; ` +
				`rm -rf dist VERSION package.json; tar -xzf ${layout.home}/.kpkg-upload.tgz; rm ${layout.home}/.kpkg-upload.tgz; ` +
				`[ -d node_modules/zeromq ] || npm install --omit=dev --no-audit --no-fund --no-package-lock zeromq@${ZEROMQ_VERSION} >/dev/null 2>&1; ` +
				`[ -x ${layout.root}/bin/uv ] || (curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=${layout.root}/bin UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1)`,
			600,
		);
		const prebake = await this.exec(
			sb,
			`cd ${layout.root}/kpkg && env ${envStr} KERNEL_SERVER_CWD=${sh(layout.workDir)} node dist/kernel-server.mjs --prebake 2>&1 | tail -5`,
			900,
		);
		this.log(prebake.trim());
	}

	/** Block all egress and prove it from inside: the sandbox must not reach the internet. */
	async lockEgress(sb) {
		await sb.refreshData();
		if (sb.networkBlockAll) return false;
		await sb.updateNetworkSettings({ networkBlockAll: true });
		return true;
	}

	/** The server's /healthz, asked from inside the sandbox; `probe` forces a fresh egress probe. */
	async health(sb, probe = false) {
		const r = await retryTransient(() =>
			sb.process.executeCommand(
			`node -e "fetch('http://127.0.0.1:${KERNEL_PORT}/healthz${probe ? "?probe=1" : ""}').then(r=>r.text()).then(t=>console.log(t),()=>console.log('DOWN'))"`,
			undefined,
			undefined,
			30,
			),
		);
		const text = r.result.trim();
		return text.startsWith("{") ? JSON.parse(text) : undefined;
	}

	async readServerState(sb, layout) {
		try {
			return JSON.parse((await sb.fs.downloadFile(`${layout.root}/state/server.json`)).toString());
		} catch {
			return undefined;
		}
	}

	async ensureServer(sb, layout, version, reprobe) {
		const state = await this.readServerState(sb, layout);
		let health = await this.health(sb, reprobe);
		if (!(health?.ok && health.version === version && state?.token)) {
			const token = randomBytes(24).toString("base64url");
			await this.launchServer(sb, layout, version, token);
			health = await this.waitHealthy(sb, version);
			return this.checkPosture({ token, posture: health.posture });
		}
		return this.checkPosture({ token: state.token, posture: health.posture });
	}

	checkPosture(server) {
		if (server.posture?.egress !== "blocked") {
			throw new Error(
				`sandbox egress is not locked (probe: ${JSON.stringify(server.posture?.probe)}); refusing to hand out a kernel`,
			);
		}
		return server;
	}

	async launchServer(sb, layout, version, token) {
		const env = {
			...runtimeEnv(layout.root),
			HOME: layout.home,
			UV_OFFLINE: "1",
			KERNEL_SERVER_TOKEN: token,
			KERNEL_SERVER_PORT: String(KERNEL_PORT),
			KERNEL_SERVER_CWD: layout.workDir,
			KERNEL_SERVER_BOUNDARY: "daytona-sandbox",
			KERNEL_SERVER_VERSION: version,
		};
		const envStr = Object.entries(env)
			.map(([k, v]) => `${k}=${sh(v)}`)
			.join(" ");
		await this.exec(
			sb,
			`pkill -f kernel-server.mjs || true; mkdir -p ${layout.root}/state ${layout.workDir}/inputs ${layout.workDir}/outputs; ` +
				`umask 077; printf '%s' ${sh(JSON.stringify({ token, version, port: KERNEL_PORT }))} > ${layout.root}/state/server.json`,
		);
		const session = `kernel-server-${Date.now()}`;
		await sb.process.createSession(session);
		await sb.process.executeSessionCommand(session, {
			command: `cd ${layout.root}/kpkg && exec env ${envStr} node dist/kernel-server.mjs >> ${layout.root}/state/${SERVER_LOG} 2>&1`,
			runAsync: true,
		});
	}

	async waitHealthy(sb, version, timeoutMs = 30_000) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			const h = await this.health(sb).catch(() => undefined);
			if (h?.ok && h.version === version) return h;
			await new Promise((r) => setTimeout(r, 300));
		}
		throw new Error(`kernel server did not come up; log tail:\n${await this.serverLog(sb).catch(() => "?")}`);
	}

	async serverLog(sb, lines = 40) {
		const layout = await this.layoutOf(sb, (await sb.getUserHomeDir()) ?? "/home/daytona");
		return (await sb.process.executeCommand(`tail -${lines} ${layout.root}/state/${SERVER_LOG}`)).result;
	}

	/** Upload each {local, remote} directory once per content hash. Returns the mappings. */
	async syncMounts(sb, layout, mounts) {
		const out = [];
		for (const m of mounts) {
			const remote = m.remote.startsWith("/") ? m.remote : posix.join(layout.workDir, m.remote);
			const hash = hashDir(m.local);
			const marker = `${remote}/.harness-sync-${hash}`;
			const have = await sb.process.executeCommand(`test -f ${sh(marker)} && echo yes || echo no`);
			if (have.result.trim() !== "yes") {
				await sb.fs.uploadFile(tarDir(m.local), `${layout.home}/.mount-upload.tgz`);
				await this.exec(
					sb,
					`rm -rf ${sh(remote)} && mkdir -p ${sh(remote)} && tar -xzf ${layout.home}/.mount-upload.tgz -C ${sh(remote)} && rm ${layout.home}/.mount-upload.tgz && touch ${sh(marker)}`,
				);
			}
			out.push({ local: m.local, remote });
		}
		return out;
	}

	/** Stop on idle. The kernel server is told first, so kernels flush their snapshots. */
	stop(conversationId) {
		return this.withLock(conversationId, async () => {
			const sb = await this.find(conversationId);
			if (!sb || sb.state !== "started") return { stopped: false, state: sb?.state };
			await sb.process.executeCommand("pkill -TERM -f kernel-server.mjs; sleep 1", undefined, undefined, 15).catch(() => {});
			await sb.stop(120);
			return { stopped: true, sandboxId: sb.id };
		});
	}

	/** Delete the conversation's sandbox and everything in it. */
	destroy(conversationId) {
		return this.withLock(conversationId, async () => {
			const sb = await this.find(conversationId);
			if (!sb) return { destroyed: false };
			await sb.delete(120, true);
			return { destroyed: true, sandboxId: sb.id };
		});
	}

	/** Keep an active conversation's sandbox from auto-stopping. */
	async touch(conversationId) {
		const sb = await this.find(conversationId);
		await sb?.refreshActivity();
	}

	/**
	 * Hold a conversation's sandbox awake while a turn runs. Traffic on the kernel's
	 * WebSocket does NOT count as Daytona activity (measured: a sandbox with a live,
	 * heartbeating kernel link auto-stopped on schedule), so a turn that waits 15
	 * minutes on an approval would otherwise be stopped under it. Returns release().
	 */
	keepAlive(conversationId, { intervalMs = 60_000 } = {}) {
		let sandbox;
		const beat = async () => {
			try {
				sandbox ??= await this.find(conversationId);
				await sandbox?.refreshActivity();
			} catch (error) {
				this.log(`keepAlive ${conversationId}: ${error.message}`);
			}
		};
		void beat();
		const timer = setInterval(beat, intervalMs);
		timer.unref?.();
		return () => clearInterval(timer);
	}

	/** Every regular file under `dir` (default `outputs`), recursively, in one sandbox call. */
	async listTree(conversationId, dir = "outputs") {
		const { sb, workDir } = await this.started(conversationId);
		const root = underWork(workDir, dir);
		const r = await retryTransient(() =>
			sb.process.executeCommand(
				`cd ${sh(workDir)} && [ -d ${sh(root)} ] && find ${sh(posix.relative(workDir, root) || ".")} -type f -not -name '.*' -printf '%p\\t%s\\t%T@\\n' || true`,
			),
		);
		return r.result
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [path, size, mtime] = line.split("\t");
				return { path, size: Number(size), mtimeMs: Math.round(Number(mtime) * 1000) };
			})
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	/**
	 * Sandboxes carrying this provider's labels. With `knownConversationIds`, only
	 * those whose conversation is not in the set (the gateway deleted it, or crashed
	 * before recording it); without, every labelled sandbox.
	 */
	async listOrphans({ knownConversationIds, includeDestroyed = false } = {}) {
		const known = knownConversationIds ? new Set([...knownConversationIds].map(String)) : undefined;
		const out = [];
		for await (const sb of this.daytona.list({ labels: this.labels })) {
			if (!Object.entries(this.labels).every(([k, v]) => sb.labels?.[k] === v)) continue;
			const conversation = sb.labels?.conversation;
			if (known && known.has(conversation)) continue;
			if (!includeDestroyed && sb.state === "destroyed") continue;
			out.push({ sandboxId: sb.id, conversationId: conversation, state: sb.state, lastActivityAt: sb.lastActivityAt });
		}
		return out;
	}

	/**
	 * Delete every orphan (see listOrphans), and wait until Daytona no longer lists
	 * them: a sandbox reads "destroying" for a while after delete() returns.
	 */
	async reap({ knownConversationIds, waitMs = 120_000 } = {}) {
		const orphans = await this.listOrphans({ knownConversationIds });
		for (const o of orphans) {
			if (o.state === "destroying" || o.state === "destroyed") continue;
			const sb = await this.daytona.get(o.sandboxId);
			await sb.delete(120, true);
		}
		const ids = new Set(orphans.map((o) => o.sandboxId));
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const still = (await this.listOrphans()).filter((o) => ids.has(o.sandboxId) && o.state !== "destroyed");
			if (still.length === 0) break;
			await new Promise((r) => setTimeout(r, 2000));
		}
		return orphans;
	}

	async started(conversationId) {
		const sb = await this.find(conversationId);
		if (!sb) throw new Error(`no sandbox for conversation ${conversationId}`);
		if (sb.state !== "started") await sb.start(120);
		const home = (await sb.getUserHomeDir()) ?? "/home/daytona";
		return { sb, workDir: `${home}/work` };
	}

	/** Put a file into the conversation's work dir (e.g. `inputs/report.pdf`). Returns its sandbox path. */
	async uploadFile(conversationId, path, data) {
		const { sb, workDir } = await this.started(conversationId);
		const target = underWork(workDir, path);
		await sb.fs.createFolder(dirname(target), "755").catch(() => {});
		await sb.fs.uploadFile(Buffer.isBuffer(data) ? data : Buffer.from(data), target);
		return target;
	}

	/** List a directory under the work dir (default `outputs`). */
	async listFiles(conversationId, dir = "outputs") {
		const { sb, workDir } = await this.started(conversationId);
		const target = underWork(workDir, dir);
		const files = await sb.fs.listFiles(target);
		return files.map((f) => ({
			name: f.name,
			path: posix.join(target, f.name),
			relPath: posix.relative(workDir, posix.join(target, f.name)),
			isDir: f.isDir,
			size: f.size,
			modTime: f.modTime,
		}));
	}

	/** Read a file under the work dir. */
	async readFile(conversationId, path) {
		const { sb, workDir } = await this.started(conversationId);
		return sb.fs.downloadFile(underWork(workDir, path));
	}
}

/** The env prime needs to use the kernel `ensure()` returned. */
export function connectionEnv(info) {
	return {
		HARNESS_REMOTE_KERNEL_URL: info.url,
		HARNESS_REMOTE_KERNEL_TOKEN: info.token,
		HARNESS_REMOTE_KERNEL_HEADERS: JSON.stringify(info.headers ?? {}),
		HARNESS_REMOTE_KERNEL_CWD: info.remoteCwd,
		HARNESS_REMOTE_KERNEL_PATH_MAP: JSON.stringify(info.mounts ?? []),
	};
}

/** The same, as the JSON file HARNESS_REMOTE_KERNEL_CONNECT_FILE names (re-read on every reconnect). */
export function connectFileContents(info) {
	return `${JSON.stringify({ url: info.url, token: info.token, headers: info.headers ?? {} })}\n`;
}
