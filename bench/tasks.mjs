/**
 * MCP-Bench task loading.
 *
 * Each task names the servers it needs plus a list of `distraction_servers` —
 * irrelevant servers deliberately mounted alongside. That is what makes this
 * benchmark the right fit: a "single-server" task really exposes ~11 servers'
 * worth of tools, which is the context-bloat condition under test.
 *
 * Tasks carry both a precise `task_description` and a vague `fuzzy_description`.
 * We use the fuzzy one — it forces retrieval rather than naming the tools, which
 * is where discovery cost actually shows up.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK_DIR = join(ROOT, "vendor/mcp-bench/tasks");
const SCHEMAS = join(ROOT, "bench/data/mcp-schemas.json");

const FILES = {
	single: "mcpbench_tasks_single_runner_format.json",
	multi2: "mcpbench_tasks_multi_2server_runner_format.json",
	multi3: "mcpbench_tasks_multi_3server_runner_format.json",
};

/**
 * Servers that need credentials we do not have.
 *
 * Their tools list and call successfully at the MCP layer but return an error
 * payload (National Parks answers 403), so a task depending on one cannot be
 * completed by either arm — it would score as a shared failure and add noise.
 * They stay eligible as *distractors*: their definitions still occupy the
 * vanilla arm's context, which is the condition under test.
 */
export const CREDENTIALED_SERVERS = new Set(["Google Maps", "National Parks", "NASA Data", "BioMCP"]);

/**
 * Servers whose work a model can simply do itself.
 *
 * Observed directly: on a Scientific Computing + Math MCP task, both arms
 * ignored the MCP tools and computed the answer with numpy. Codemode has a
 * general-purpose interpreter, so for any task reducible to computation it does
 * not need tools at all — which measures something real, but not the hypothesis.
 * Tasks *requiring* these are excluded; as distractors they are fine.
 */
export const SUBSTITUTABLE_SERVERS = new Set([
	"Math MCP",
	"Scientific Computing",
	"Unit Converter",
	"Medical Calculator",
	"Bibliomantic",
	"Car Price Evaluator",
	"Movie Recommender",
]);

/** Servers whose schemas we successfully dumped — anything else can't be run. */
export function availableServers() {
	if (!existsSync(SCHEMAS)) return new Set();
	const { catalogue } = JSON.parse(readFileSync(SCHEMAS, "utf8"));
	return new Set(catalogue.map((s) => s.server));
}

/**
 * Load tasks, flattened across server groups.
 *
 * @param opts.tier       "single" | "multi2" | "multi3" (default all)
 * @param opts.runnable   drop tasks needing a server we could not start (default true)
 * @param opts.grounded   also drop tasks whose required servers need credentials
 *                        we lack, or whose work a model can substitute for
 *                        (default true). Distractors are never filtered — their
 *                        definitions are the bloat being measured.
 */
export function loadTasks({ tier, runnable = true, grounded = true } = {}) {
	const available = availableServers();
	const tiers = tier ? [tier] : Object.keys(FILES);
	const tasks = [];

	for (const t of tiers) {
		const path = join(TASK_DIR, FILES[t]);
		if (!existsSync(path)) continue;
		const { server_tasks: groups } = JSON.parse(readFileSync(path, "utf8"));
		for (const group of groups) {
			for (const task of group.tasks) {
				const servers = group.servers ?? [group.server_name];
				const distractors = task.distraction_servers ?? [];
				tasks.push({
					id: task.task_id,
					tier: t,
					servers,
					distractors,
					// What the agent is actually given: its own servers plus the
					// distractors, exactly as MCP-Bench intends.
					exposedServers: [...new Set([...servers, ...distractors])],
					description: task.task_description ?? "",
					fuzzy: task.fuzzy_description ?? task.task_description ?? "",
					dependencies: task.dependency_analysis ?? null,
				});
			}
		}
	}

	if (!runnable) return tasks;

	return tasks
		.filter((task) => task.servers.every((s) => available.has(s)))
		.filter(
			(task) =>
				!grounded ||
				task.servers.every((s) => !CREDENTIALED_SERVERS.has(s) && !SUBSTITUTABLE_SERVERS.has(s)),
		)
		.map((task) => ({
			...task,
			// Silently dropping an unavailable distractor would understate the
			// bloat condition, so record what was removed.
			droppedDistractors: task.distractors.filter((s) => !available.has(s)),
			exposedServers: task.exposedServers.filter((s) => available.has(s)),
		}));
}

export function findTask(id) {
	const task = loadTasks({ runnable: true }).find((t) => t.id === id);
	if (!task) throw new Error(`unknown or unrunnable task: ${id}`);
	return task;
}

/**
 * A deterministic sample, stratified by tier.
 *
 * Fixed selection rather than random: every arm and model must see the identical
 * task set or the comparison is between samples, not arms.
 */
export function sampleTasks(perTier = 5) {
	const out = [];
	for (const tier of Object.keys(FILES)) {
		const tasks = loadTasks({ tier }).sort((a, b) => a.id.localeCompare(b.id));
		// Spread across the sorted list instead of taking a prefix, which would
		// over-sample whichever servers sort first.
		const step = Math.max(1, Math.floor(tasks.length / perTier));
		for (let i = 0; i < tasks.length && out.filter((t) => t.tier === tier).length < perTier; i += step) {
			out.push(tasks[i]);
		}
	}
	return out;
}
