#!/usr/bin/env node
/**
 * Draw a sample stratified by ground-truth API-call count.
 *
 *   node bench/appworld/stratify.mjs [--per-stratum 10] [--seed 0] [--json]
 *
 * Why not `--sample N`
 * --------------------
 * TGC is saturated: every condition scores 6–8 of 9 and fails the same tasks, so
 * more paired cells only tightens a confidence interval around zero. The live
 * variable is the cost decomposition in §10, and the thing that drives it is how
 * many API calls a task needs. So the sample should vary *that*, deliberately.
 *
 * This is CLAUDE.md's "do not hillclimb efficiency on the fast subset" turned the
 * right way round. A sample chosen for convenience silently selects on the axis
 * being measured — `quick.mjs` picks fast tasks, and tasks are fast because they
 * need fewer calls, which is the axis. Choosing on the axis on purpose makes it a
 * test instead of a bias.
 *
 * The prediction being tested: if the representation term is composition (one cell
 * issuing N calls versus N tool calls), the tools/code cost ratio stays small in
 * the low stratum and grows in the high one. If residency is doing more work than
 * the decomposition suggests, the ratio persists in the low stratum too.
 *
 * Two things it controls for
 * --------------------------
 * - **Family pseudo-replication.** Task ids are `<generator>_<variant>`; the three
 *   variants of a generator are the same scenario with different data. Ten tasks
 *   drawn blind can be three scenarios. At most one variant per generator.
 * - **Predictor leakage.** Upstream's APIPredictor few-shots on
 *   `82e2fac_1 / 29caf6f_1 / d0b1f43_1` with their ground-truth `required_apis` in
 *   the prompt, so those generators are excluded outright.
 *
 * Ground-truth call counts exist only for train+dev (the licence withholds test
 * solutions), which is why the sample is drawn from there. That is fine here: the
 * question is about cost, not about score, and train's score ceiling is irrelevant
 * to it. Any *score* claim still needs test_normal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const APPWORLD = join(ROOT, "vendor/appworld");
const PYTHON = join(APPWORLD, ".venv/bin/python3");
const CACHE = join(ROOT, "bench/data/appworld-gt-calls.json");

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf(`--${n}`);
	return i >= 0 ? argv[i + 1] : d;
};
const perStratum = Number(flag("per-stratum", 10));
const seed = Number(flag("seed", 0));
const lowMax = Number(flag("low-max", 20));
const highMin = Number(flag("high-min", 60));

/** Generators whose ground-truth API list is in upstream's predictor prompt. */
const PREDICTOR_DEMO_GENERATORS = new Set(["82e2fac", "29caf6f", "d0b1f43"]);

/**
 * Executed ground-truth call counts per task.
 *
 * Measured by running each ground-truth solution, not read off `required_apis` —
 * that field is the count of *distinct* APIs (mean 26) and the quantity that drives
 * cost is the number of *calls* (mean 53, max 244). Cached because it takes ~30s
 * for all 147 and never changes for a pinned data version.
 */
function groundTruthCallCounts() {
	if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8"));
	const script = `
import warnings, json, os
warnings.filterwarnings("ignore")
from multiprocessing import Pool
from appworld import AppWorld, load_task_ids

def one(tid):
    import warnings as w; w.filterwarnings("ignore")
    try:
        with AppWorld(task_id=tid, experiment_name="gt_calls_" + tid, timeout_seconds=300,
                      load_ground_truth=True, ground_truth_mode="full",
                      raise_on_failure=False) as world:
            gt = world.task.ground_truth
            world.execute(gt.compiled_solution_code + "\\nsolution(apis, requester)")
            tr = world.evaluate()
            world.save_logs()
            calls = AppWorld.parse_api_calls_log(
                file_path=os.path.join(world.output_logs_directory, "api_calls.jsonl"))
            return {"task": tid, "nCalls": len(calls), "gtPassed": bool(tr.success),
                    "nTests": tr.total_count}
    except Exception as e:
        return {"task": tid, "error": f"{type(e).__name__}: {e}"}

if __name__ == "__main__":
    ids = load_task_ids("train") + load_task_ids("dev")
    with Pool(6) as p:
        rows = p.map(one, ids)
    print("<<<JSON>>>" + json.dumps(rows))
`;
	console.error("[stratify] measuring ground-truth call counts (one-time, ~40s)…");
	// Written to a FILE, not passed with `-c`.
	//
	// macOS defaults multiprocessing to the `spawn` start method, and spawn
	// re-imports the main module in every child. A `-c` script has no module to
	// re-import, so `Pool(6)` hangs forever with no children and no error — which is
	// exactly what it did: 11 minutes, node alive, zero python workers in `ps`.
	const scriptPath = join(mkdtempSync(join(tmpdir(), "appworld-gt-")), "gt_calls.py");
	writeFileSync(scriptPath, script);
	const out = execFileSync(PYTHON, [scriptPath], { cwd: APPWORLD, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	const rows = JSON.parse(out.slice(out.indexOf("<<<JSON>>>") + 10));
	writeFileSync(CACHE, `${JSON.stringify(rows, null, 1)}\n`);
	return rows;
}

function mulberry32(a) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const rows = groundTruthCallCounts().filter((r) => !r.error && r.gtPassed !== false);
const generator = (task) => task.split("_")[0];
const eligible = rows.filter((r) => !PREDICTOR_DEMO_GENERATORS.has(generator(r.task)));

/** One variant per generator, chosen by the seeded shuffle, then take N. */
function draw(candidates, rng) {
	const shuffled = [...candidates];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
	}
	const picked = [];
	const seenGenerators = new Set();
	for (const row of shuffled) {
		if (seenGenerators.has(generator(row.task))) continue;
		seenGenerators.add(generator(row.task));
		picked.push(row);
		if (picked.length >= perStratum) break;
	}
	return picked.sort((a, b) => a.nCalls - b.nCalls);
}

const rng = mulberry32(seed);
const low = draw(
	eligible.filter((r) => r.nCalls <= lowMax),
	rng,
);
const high = draw(
	eligible.filter((r) => r.nCalls >= highMin),
	rng,
);

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const summary = {
	seed,
	perStratum,
	thresholds: { lowMax, highMin },
	excludedGenerators: [...PREDICTOR_DEMO_GENERATORS],
	low: { tasks: low.map((r) => r.task), calls: low.map((r) => r.nCalls), meanCalls: mean(low.map((r) => r.nCalls)) },
	high: { tasks: high.map((r) => r.task), calls: high.map((r) => r.nCalls), meanCalls: mean(high.map((r) => r.nCalls)) },
};

if (argv.includes("--json")) {
	console.log(JSON.stringify(summary, null, 1));
} else {
	console.error(`low  stratum (<=${lowMax} gt calls, mean ${summary.low.meanCalls.toFixed(1)}): ${low.map((r) => `${r.task}(${r.nCalls})`).join(" ")}`);
	console.error(`high stratum (>=${highMin} gt calls, mean ${summary.high.meanCalls.toFixed(1)}): ${high.map((r) => `${r.task}(${r.nCalls})`).join(" ")}`);
	console.error(`\ngrader tests/task: low ${mean(low.map((r) => r.nTests)).toFixed(1)}  high ${mean(high.map((r) => r.nTests)).toFixed(1)}  (balanced = the strata differ on call volume, not structural complexity)`);
	// stdout is the --tasks argument, so this composes: --tasks "$(stratify.mjs)"
	console.log([...low, ...high].map((r) => r.task).join(","));
}
