/**
 * The optional Temporal invocation backend (runtime/invocations_temporal.py) against a
 * REAL `temporal server start-dev` (ephemeral port and db, started and stopped here),
 * with its worker as a separate process the test SIGKILLs mid-activity.
 *
 * The backend is not wired into any host or into the scheduler, so this tests the
 * boundary it does have: a host submits into the session's invocation store
 * (temporal/submit.py, as a host would), the workflow's report activity writes the
 * outcome into that store, and the real scheduler wakes the real session with it.
 *
 * Needs the integration venv (.venv-itest with temporalio, scripts/dev-env.sh) and the
 * `temporal` CLI; skips cleanly without either.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ROOT, RUNTIME, SCRIPTS, identify, identityAlive, missingPrereqs, scenario, sleep, stopProcesses, until } from "./lib.mjs";

const VENV_PY = join(ROOT, ".venv-itest/bin/python");
const TEMPORAL = process.env.HARNESS_TEMPORAL_CLI ?? "temporal";
const HERE = join(RUNTIME, "integration/temporal");

const missing = missingPrereqs();
if (!existsSync(VENV_PY)) missing.push("no .venv-itest (temporalio); run scripts/dev-env.sh");
else if (spawnSync(VENV_PY, ["-c", "import temporalio"]).status !== 0) missing.push(".venv-itest has no temporalio; run scripts/dev-env.sh");
if (spawnSync(TEMPORAL, ["--version"]).status !== 0) missing.push(`no \`${TEMPORAL}\` CLI on PATH (set HARNESS_TEMPORAL_CLI)`);
const skip = missing.length ? missing.join("; ") : false;

const freePort = () =>
	new Promise((resolve) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

function spawnLogged(w, cmd, args, opts = {}) {
	const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true, ...opts });
	const h = { proc, out: "", ident: identify(proc.pid), exited: null };
	proc.stdout.on("data", (d) => {
		h.out += d;
	});
	proc.stderr.on("data", (d) => {
		h.out += d;
	});
	proc.on("exit", (code, signal) => {
		h.exited = { code, signal };
	});
	w.cleanups.unshift(async () => {
		try {
			process.kill(-proc.pid, "SIGTERM");
		} catch {}
		await until(() => h.exited, { timeoutMs: 8000, what: `${cmd} to exit` }).catch(() => {
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch {}
		});
	});
	return h;
}

const ledger = (path) =>
	existsSync(path)
		? readFileSync(path, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

describe("integration: Temporal invocation backend (real dev server)", { skip }, () => {
	it("survives a worker killed mid-activity; outcomes land in the store and wake the session", { timeout: 240_000 }, async () => {
		const n = randomBytes(3).toString("hex");
		await scenario("temporal", { script: join(SCRIPTS, "temporal.json"), vars: { NONCE: n } }, async (w) => {
			const port = await freePort();
			const address = `127.0.0.1:${port}`;
			const server = spawnLogged(w, TEMPORAL, [
				"server", "start-dev", "--headless", "--ip", "127.0.0.1", "--port", String(port),
				"--http-port", String(await freePort()), "--metrics-port", String(await freePort()),
				"--db-filename", join(w.root, "temporal.db"), "--log-level", "error",
			]);
			const pyEnv = { ...process.env, PYTHONPATH: RUNTIME };
			const queue = `itest-${n}`;
			const ledgerPath = join(w.root, "ledger.jsonl");
			const startWorker = () => spawnLogged(w, VENV_PY, ["-u", join(HERE, "worker.py"), address, queue, ledgerPath], { env: pyEnv });
			// The worker connects once the server answers; retry until it says ready.
			let worker;
			await until(
				async () => {
					worker = startWorker();
					const ok = await until(() => /worker ready/.test(worker.out) || worker.exited, { timeoutMs: 15_000 }).catch(() => false);
					return ok && !worker.exited;
				},
				{ timeoutMs: 60_000, everyMs: 1000, what: "the dev server to accept a worker" },
			);
			assert.ok(!server.exited, `the dev server is up: ${server.out.slice(-500)}`);

			// The session's first turn ends with nothing waiting.
			w.post(`INDIA-${n} hello`);
			w.startScheduler();
			await until(() => w.model.served() === 1 && !w.turn(), { what: "the first turn to finish", timeoutMs: 60_000 });

			const submit = (id, tool, delivery) =>
				spawnLogged(w, VENV_PY, ["-u", join(HERE, "submit.py"), address, queue, w.jobs, id, tool, delivery, JSON.stringify({ seconds: tool === "itest.once" ? 30 : 2 }), "4"], { env: pyEnv });
			const idem = `call:itest-${n}:1`;
			const once = `call:itest-${n}:2`;
			submit(idem, "itest.slow", "idempotent");
			submit(once, "itest.once", "at_most_once");
			await until(() => ledger(ledgerPath).filter((e) => e.event === "start").length === 2, { what: "both activities to start", timeoutMs: 30_000 });
			const firstWorker = worker.ident;
			process.kill(worker.proc.pid, "SIGKILL");
			await until(() => !identityAlive(firstWorker), { what: "the worker to die" });
			worker = startWorker();
			await until(() => /worker ready/.test(worker.out), { what: "the replacement worker" });

			await until(
				() => {
					const recs = w.invocations().filter((r) => r.backend === "temporal");
					return recs.length === 2 && recs.every((r) => r.delivered_at) && !w.turn();
				},
				{ what: "both outcomes to be delivered", timeoutMs: 90_000 },
			);
			await sleep(3000);

			const recs = Object.fromEntries(w.invocations().filter((r) => r.backend === "temporal").map((r) => [r.id, r]));
			assert.equal(recs[idem].state, "succeeded");
			assert.equal(recs[idem].workflow_id, `inv-${idem}`);
			assert.equal(recs[once].state, "unknown");
			assert.match(recs[once].outcome.summary, /may or may not have taken effect/);

			const events = ledger(ledgerPath);
			const starts = (key) => events.filter((e) => e.event === "start" && e.key === key);
			assert.equal(starts(idem).length, 2, "the idempotent call was resent once, on the new worker");
			assert.deepEqual(new Set(starts(idem).map((e) => e.pid)).size, 2);
			assert.ok(events.some((e) => e.event === "done" && e.key === idem && e.pid === worker.proc.pid));
			assert.equal(starts(once).length, 1, "the at_most_once call was never resent");

			// What the model saw: each outcome opened exactly one turn, and nothing else woke it.
			assert.deepEqual(w.model.errors, []);
			const shown = (id) => w.model.requests.filter((r) => r.last.includes(id));
			assert.equal(shown(idem).length, 1, "the success was shown once");
			assert.match(shown(idem)[0].last, new RegExp(`call itest\\.slow \\(${idem}\\): succeeded`));
			assert.equal(shown(once).length, 1, "the UNKNOWN was shown once");
			assert.match(shown(once)[0].last, new RegExp(`call itest\\.once \\(${once}\\): UNKNOWN`));
			assert.equal(w.wakes().length, w.model.requests.length, "one wake per model turn, no spurious wake");
			await stopProcesses([worker.ident]);
		});
	});
});
