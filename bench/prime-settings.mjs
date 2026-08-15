/**
 * The settings.json every per-run agent-home starts from.
 *
 * autoRefine is OFF. `neutralize-prime.mjs` only removes the harness-state
 * *prompt injection*; the review-and-refine machinery itself defaults on
 * (settings-manager.ts: enabled ?? true, turnInterval 25) and print mode
 * force-enables serialized refine. Measured on the AppWorld corpus: 78 runs
 * paid unbudgeted `reviewAutoRefine` model calls past turn 25 and wrote
 * harness_state.json files nothing reads (2026-08-15 review, P0.2). A cost
 * and latency confound on exactly the long tasks where cost is the endpoint.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PRIME_SETTINGS = { autoRefine: { enabled: false } };

/**
 * Write the run's settings.json into `agentHome`, creating the dir.
 * Returns the path so callers can seed and assign in one expression:
 *   PRIME_AGENT_CODING_AGENT_DIR: seedPrimeSettings(join(runDir, "agent-home"))
 */
export function seedPrimeSettings(agentHome) {
	mkdirSync(agentHome, { recursive: true });
	writeFileSync(join(agentHome, "settings.json"), `${JSON.stringify(PRIME_SETTINGS, null, "\t")}\n`);
	return agentHome;
}
