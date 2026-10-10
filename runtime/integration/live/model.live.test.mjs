/**
 * Live: the integration worlds with a REAL model (HARNESS_LIVE_MODEL, default
 * anthropic/claude-haiku-4-5) instead of the scripted one. What the scripted tier
 * proves about the machinery, this checks the model actually uses: it ends a turn
 * without waiting, is woken by the scheduler with an outcome, and acts on it.
 *
 * Run through `npm run test:live -- --env-file PATH` only (it sources the file).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { missingPrereqs, scenario, sleep, until } from "../lib.mjs";
import { costOf, overBudget, record } from "./budget.mjs";

const MODEL = process.env.HARNESS_LIVE_MODEL ?? "anthropic/claude-haiku-4-5";
const hasKey = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "ZAI_API_KEY"].some((k) => process.env[k]);
const skip =
	process.env.HARNESS_LIVE !== "1"
		? "live tier: run via npm run test:live -- --env-file PATH"
		: !hasKey
			? "no model API key in the env file"
			: missingPrereqs().join("; ") || false;

const textOf = (m) => (Array.isArray(m?.content) ? m.content.map((c) => c.text ?? "").join("") : String(m?.content ?? ""));
const finalText = (w) =>
	textOf(w.primeEvents().filter((e) => e.type === "message_end" && e.message?.role === "assistant").at(-1)?.message);

async function liveScenario(t, label, body) {
	const over = overBudget();
	if (over) return t.skip(over);
	let w;
	try {
		await scenario(label, { liveModel: MODEL }, async (world) => {
			w = world;
			await body(world);
		});
	} finally {
		if (w) record(label, costOf(w.primeEvents()));
	}
}

describe(`live model (${MODEL})`, { skip }, () => {
	it("starts a job, ends the turn without waiting, is woken with the outcome, and uses it", { timeout: 420_000 }, async (t) => {
		const n = randomBytes(3).toString("hex");
		await liveScenario(t, "live-unwaited", async (w) => {
			w.post(
				`Use the ipython tool. In ONE cell, submit the shell job \`sleep 5; echo LIVE-${n}\` with jobs.submit(..., name='bg'). ` +
					"Do NOT wait for it: end your turn right after submitting, with one short sentence. " +
					"You will be woken when it finishes; then reply with the exact line it printed.",
			);
			w.startScheduler();
			await until(() => w.wakes().length >= 2 && !w.turn(), { what: "the woken turn to finish", timeoutMs: 300_000, everyMs: 1000 });
			await sleep(4000);
			const wakes = w.wakes();
			assert.match(wakes[1], /job 'bg': succeeded \(exit 0\)/, wakes.join("\n"));
			const bg = w.invocations().find((r) => r.kind === "job" && r.name === "bg");
			assert.ok(bg?.delivered_at, "the outcome was delivered");
			assert.match(finalText(w), new RegExp(`LIVE-${n}`), `the model did not use the outcome: ${finalText(w)}`);
		});
	});

	it("waits on a barrier of three jobs, one failing, and reports the failure after one wake", { timeout: 420_000 }, async (t) => {
		await liveScenario(t, "live-barrier", async (w) => {
			w.post(
				"Use the ipython tool. In ONE cell: submit three shell jobs with jobs.submit — `sleep 2; echo A` named 'a', " +
					"`sleep 3; exit 3` named 'b', `sleep 4; echo C` named 'c' — then call jobs.wait('a', 'b', 'c', wake_after='3m') " +
					"as the cell's last statement. When woken, reply with one line naming which job failed and its exit code.",
			);
			w.startScheduler();
			await until(() => w.wakes().length >= 2 && !w.turn() && !w.inbox().some((f) => f.endsWith(".json")), {
				what: "the barrier wake's turn to finish",
				timeoutMs: 300_000,
				everyMs: 1000,
			});
			await sleep(4000);
			const wakes = w.wakes();
			assert.equal(wakes.length, 2, `one barrier wake:\n${wakes.join("\n")}`);
			assert.match(wakes[1], /all finished: .*b \(failed \(exit 3\)\)/);
			assert.match(finalText(w), /\bb\b.*3|3.*\bb\b/i, `the model did not report b's failure: ${finalText(w)}`);
		});
	});
});

