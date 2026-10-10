/**
 * Live: the Daytona kernel backend (runtime/kernel/daytona.mjs) against a real Daytona
 * account. Gated on DAYTONA_API_KEY from the env file; run through
 * `npm run test:live -- --env-file PATH` only.
 *
 * Every sandbox this file causes carries `pool_owner=<this run's owner>` (the backend's
 * own scoping label) plus {purpose: harness-live, env: test}, and Daytona's
 * autoDeleteMinutes is set as a backstop. The final `after` deletes every sandbox with
 * this run's owner label — whatever happened above it — then asserts none remain and
 * prints what it deleted.
 *
 * The model is the scripted one: these scenarios cost sandbox time, not tokens.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Daytona } from "@daytonaio/sdk";
import { DaytonaKernelBackend } from "../../kernel/daytona.mjs";
import { missingPrereqs, runPrime, scenario, until } from "../lib.mjs";
import { overBudget } from "./budget.mjs";

const skip =
	process.env.HARNESS_LIVE !== "1"
		? "live tier: run via npm run test:live -- --env-file PATH"
		: !process.env.DAYTONA_API_KEY
			? "no DAYTONA_API_KEY in the env file"
			: missingPrereqs().join("; ") || false;

const OWNER = `harness-live-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
const LABELS = { purpose: "harness-live", env: "test" };
const log = { info: (m, d) => console.log(`[daytona] ${m}`, d ?? ""), warn: (m, d) => console.log(`[daytona] WARN ${m}`, d ?? "") };
const backends = [];
const client = () =>
	new Daytona({ apiKey: process.env.DAYTONA_API_KEY, apiUrl: process.env.DAYTONA_API_URL, target: process.env.DAYTONA_TARGET });

function newBackend(opts = {}) {
	const b = new DaytonaKernelBackend({ labels: LABELS, poolOwner: OWNER, autoDeleteMinutes: 60, log, ...opts });
	backends.push(b);
	return b;
}

/** Every sandbox on the account carrying this run's owner label. */
async function ours(daytona) {
	const out = [];
	for await (const sb of daytona.list({ labels: { pool_owner: OWNER } })) {
		if (sb.labels?.pool_owner === OWNER && sb.state !== "destroyed") out.push(sb);
	}
	return out;
}

/** A conversation context whose host dirs live in the world (the shapes kernel/backend.d.mts names). */
function context(w, id) {
	const conv = join(w.root, id);
	for (const d of ["work/inputs", "work/outputs", "api", "bin"]) mkdirSync(join(conv, d), { recursive: true });
	const tmp = join(w.tmp, id);
	mkdirSync(tmp, { recursive: true });
	return {
		conversationId: `${OWNER}-${id}`,
		userId: "harness-live",
		convDir: conv,
		workDir: join(conv, "work"),
		apiTreeDir: join(conv, "api"),
		skillRoots: [],
		tmpDir: tmp,
		agentBinDir: join(conv, "bin"),
		egressToken: `tok-${id}`,
		toolProxyPath: "/tool-proxy",
		localBaseUrl: "http://127.0.0.1:9",
	};
}

const SCRIPT = {
	turns: [
		{ expect: "KILO", ipython: "print(open('inputs/hello.txt').read())\nopen('outputs/out.txt', 'w').write('from-the-sandbox')" },
		{ expect: "hello-from-host", text: "Read the input, wrote the output." },
	],
};

describe("live: Daytona kernel backend", { skip }, () => {
	after(async () => {
		if (skip) return;
		for (const b of backends) await b.shutdown?.().catch((e) => console.log(`[daytona] shutdown: ${e.message}`));
		const daytona = client();
		const deleted = [];
		for (const sb of await ours(daytona)) {
			try {
				await sb.delete(120);
				deleted.push(sb.id);
			} catch (e) {
				console.log(`[daytona] could not delete ${sb.id}: ${e.message}`);
			}
		}
		const left = await ours(daytona);
		console.log(`[daytona] owner ${OWNER}: deleted ${deleted.length} sandbox(es) in cleanup; ${left.length} left`);
		assert.deepEqual(left.map((s) => s.id), [], `sandboxes left on the account (owner label ${OWNER}) — delete them by hand`);
	});

	it("create: a conversation's sandbox runs a real prime turn; files cross both ways; destroy removes it", { timeout: 900_000 }, async (t) => {
		if (overBudget()) return t.skip(overBudget());
		await scenario("dt-create", { script: SCRIPT }, async (w) => {
			const backend = newBackend();
			const ctx = context(w, "create");
			const session = await backend.open(ctx);
			await session.ready;
			writeFileSync(join(ctx.workDir, "inputs/hello.txt"), "hello-from-host");
			await session.putInput("inputs/hello.txt", join(ctx.workDir, "inputs/hello.txt"));
			const { HARNESS_KERNEL_SANDBOX, IPYTHONDIR, HARNESS_RUNTIME_DIR, HARNESS_JOB_CWD, ...base } = w.env;
			const run = await runPrime(w, { env: { ...base, ...session.primeEnv, TMPDIR: ctx.tmpDir }, cwd: session.primeCwd, message: "KILO go" });
			await session.release();
			assert.equal(run.code, 0, run.stderr.slice(-2000));
			assert.deepEqual(w.model.errors, []);
			assert.match(w.model.requests[1].last, /hello-from-host/);
			assert.equal((await session.readOutput("outputs/out.txt")).toString(), "from-the-sandbox");
			assert.ok((await session.listOutputs()).some((f) => f.path === "outputs/out.txt"));
			const before = await ours(client());
			assert.ok(before.some((sb) => sb.labels?.conversation === ctx.conversationId), "the sandbox carries the run's owner label");
			await backend.destroy(ctx.conversationId);
			const afterDestroy = await ours(client());
			assert.ok(!afterDestroy.some((sb) => sb.labels?.conversation === ctx.conversationId), "destroy removed it");
		});
	});

	it("warm pool: a new conversation claims the pre-warmed sandbox; drain deletes the rest", { timeout: 900_000 }, async (t) => {
		if (overBudget()) return t.skip(overBudget());
		await scenario("dt-pool", { script: { turns: [] } }, async (w) => {
			const backend = newBackend({ poolSize: 1 });
			const ctx = context(w, "pool");
			await backend.start({ apiTreeDir: ctx.apiTreeDir, skillRoots: [], dataDir: w.root });
			const daytona = client();
			const warm = await until(
				async () => (await ours(daytona)).find((sb) => sb.labels?.pool === "warm" && sb.state === "started"),
				{ what: "a warm sandbox", timeoutMs: 600_000, everyMs: 5000 },
			);
			const session = await backend.open(ctx);
			await session.ready;
			const mine = (await ours(daytona)).find((sb) => sb.labels?.conversation === ctx.conversationId);
			assert.equal(mine?.id, warm.id, "the conversation got the warm sandbox, relabelled");
			await session.release();
			await backend.destroy(ctx.conversationId);
			await backend.drain?.();
		});
	});

	it("sweep and restore: an idle sandbox is swept; reopening restores the workspace from the host", { timeout: 900_000 }, async (t) => {
		if (overBudget()) return t.skip(overBudget());
		await scenario("dt-sweep", { script: { turns: [] } }, async (w) => {
			const backend = newBackend();
			const ctx = context(w, "sweep");
			const kept = join(w.root, "host-copy-r.txt");
			writeFileSync(kept, "restored-from-host");
			const restoreCtx = { ...ctx, restoreFiles: () => [{ relPath: "outputs/r.txt", hostPath: kept }] };
			const first = await backend.open(restoreCtx);
			await first.ready;
			assert.equal(await first.restored, 0, "a first sandbox restores nothing");
			await first.release();
			const swept = await backend.sweepIdle({ olderThanMs: 0, lastActive: () => new Date(0), isOpen: () => false });
			assert.ok(swept.deleted.length >= 1, `the idle sandbox was swept: ${JSON.stringify(swept)}`);
			const again = await backend.open(restoreCtx);
			await again.ready;
			assert.equal(await again.restored, 1, "the recreated sandbox got the host's copy back");
			assert.equal((await again.readOutput("outputs/r.txt")).toString(), "restored-from-host");
			await again.release();
			await backend.destroy(ctx.conversationId);
		});
	});
});
