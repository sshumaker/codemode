/**
 * Slim build: the continual-harness ("/refine") subsystem has been removed.
 * Installed by scripts/slim-prime.mjs; the original engine is 1,018 LOC.
 *
 * What it did: every 25 turns, an unbudgeted model call reviewed the transcript
 * and wrote "learned" prompt notes, memories, skills and subagent specs into
 * `harness_state.json`, which was then folded back into the system prompt.
 *
 * Why it cannot stay in a benchmark harness: run N's prompt depends on run
 * N-1's state, so runs are neither reproducible nor order-independent.
 * scripts/neutralize-prime.mjs already cut the prompt injection; the
 * 2026-08-15 review then found the *review call itself* still firing under
 * print mode's forced `serializedRefine`, with 78 harness_state.json files in
 * the corpus to show for it. A settings flag turns it off; deleting the engine
 * means it cannot come back on.
 *
 * The module keeps every exported name and signature — agent-session.ts imports
 * twenty of them and core/extensions/types.ts publishes a RefineCompleteEvent —
 * so the types survive and only the behaviour is inert. Path helpers keep their
 * real implementations: they are pure `join` calls, and returning a truthful
 * path costs nothing while a fake one would be a lie the caller stores.
 */

import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../config.js";
import type { CustomEntry } from "../session-manager.js";

const REMOVED = "the /refine continual harness was removed in this build (scripts/slim-prime.mjs)";
const HARNESS_STATE_DIR_NAME = "harness";
const REFINEMENT_HISTORY_FILE_NAME = "refinements.jsonl";

export const REFINEMENT_CUSTOM_TYPE = "prime-agent.refinement";
export const REFINE_SKILL_NAME = "refine";

export type RefinementKind = "prompt" | "memory" | "skill" | "subagent";
export type RefinementAction = "create" | "update" | "delete";
export type HarnessScope = "local" | "global";

export interface HarnessEntry {
	id: string;
	kind: RefinementKind;
	title: string;
	content: string;
	path: string;
	scope?: HarnessScope;
	reference: Record<string, unknown>;
	arguments: Record<string, unknown>;
	metadata: Record<string, unknown>;
	source: string;
	created_at: string;
	updated_at: string;
	version: number;
}

export interface HarnessRefinementEvent {
	id: string;
	trigger: string;
	changes: string[];
	evidence: string;
	outcome: string;
	created_at: string;
}

export interface HarnessState {
	schema: number;
	entries: Record<RefinementKind, Record<string, HarnessEntry>>;
	refinements: HarnessRefinementEvent[];
}

export interface RefinementEdit {
	action: RefinementAction;
	kind: RefinementKind;
	id?: string;
	title?: string;
	content?: string;
	path?: string;
	reference?: Record<string, unknown>;
	arguments?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	reason?: string;
}

export interface RefinementProposal {
	summary: string;
	rationale: string;
	edits: RefinementEdit[];
	expectedOutcome: string;
}

export interface AppliedRefinementEdit extends RefinementEdit {
	id: string;
	before?: HarnessEntry;
	after?: HarnessEntry;
	applied: boolean;
	error?: string;
}

export interface RefinementResult {
	id: string;
	summary: string;
	rationale: string;
	expectedOutcome: string;
	appliedEdits: AppliedRefinementEdit[];
	harnessStatePath: string;
	rollbackOf?: string;
	scope?: HarnessScope;
}

export interface RefineOptions {
	instructions?: string;
	rollbackId?: string;
	global?: boolean;
}

export type AutoRefineReason = "turn_interval" | "compact";

export interface AutoRefineReviewContext {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

export interface AutoRefineReview {
	shouldRefine: boolean;
	rationale: string;
	instructions?: string;
}

export interface RefinementPlan {
	proposal: RefinementProposal;
	id: string;
	rollbackOf?: string;
	rollbackScope?: HarnessScope;
	baselineState?: HarnessState;
}

function emptyHarnessState(): HarnessState {
	return {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
}

// --- paths (unchanged: pure, and callers persist what these return) ----------

export function getGlobalHarnessStateDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, HARNESS_STATE_DIR_NAME);
}

export function getLocalHarnessStateDir(sessionArtifactDir: string | undefined): string | undefined {
	return sessionArtifactDir ? join(sessionArtifactDir, HARNESS_STATE_DIR_NAME) : undefined;
}

export function getHarnessStatePath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, "harness_state.json");
}

export function getRefinementHistoryPath(harnessStateDir: string = getGlobalHarnessStateDir()): string {
	return join(harnessStateDir, REFINEMENT_HISTORY_FILE_NAME);
}

// --- state: always empty, never written --------------------------------------

export function loadHarnessState(
	_harnessStateDir: string = getGlobalHarnessStateDir(),
	_scope: HarnessScope = "global",
): HarnessState {
	return emptyHarnessState();
}

export function mergeHarnessStates(_globalState: HarnessState, _localState?: HarnessState): HarnessState {
	return emptyHarnessState();
}

export function saveHarnessState(harnessStateDir: string, _state: HarnessState): string {
	return getHarnessStatePath(harnessStateDir);
}

export function appendGlobalRefinement(harnessStateDir: string, _result: RefinementResult): string {
	return getRefinementHistoryPath(harnessStateDir);
}

export function loadGlobalRefinementHistory(_harnessStateDir: string = getGlobalHarnessStateDir()): RefinementResult[] {
	return [];
}

export function mergeRefinementHistory(
	_global: readonly RefinementResult[],
	_session: readonly RefinementResult[],
): RefinementResult[] {
	return [];
}

export function getRefinementHistory(_entries: readonly CustomEntry[]): RefinementResult[] {
	return [];
}

export function inferRefinementResultScope(_result: RefinementResult): HarnessScope | undefined {
	return undefined;
}

/** The system-prompt fold-in. Empty string == nothing appended to the prompt. */
export function formatHarnessStateForPrompt(
	_state: HarnessState,
	_options: {
		maxEntriesPerKind?: number;
		maxRefinements?: number;
		maxContentLength?: number;
		includeIpythonExamples?: boolean;
		includeShellExamples?: boolean;
		includeRefineExamples?: boolean;
	} = {},
): string {
	return "";
}

// --- the model calls: gone ----------------------------------------------------
//
// reviewAutoRefine declines instead of throwing — it is called automatically
// every N turns, and an exception there would surface as a spurious turn error
// on a run that asked for nothing. The explicit entry points throw, because a
// user who typed `/refine` deserves to be told it is not there.

export async function reviewAutoRefine(
	_messages: AgentMessage[],
	_state: HarnessState,
	_history: RefinementResult[],
	_model: Model<any>,
	_apiKey: string,
	_context: AutoRefineReviewContext,
	_headers?: Record<string, string>,
	_signal?: AbortSignal,
	_thinkingLevel?: ThinkingLevel,
): Promise<AutoRefineReview> {
	return { shouldRefine: false, rationale: REMOVED };
}

export async function planRefinement(
	_messages: AgentMessage[],
	_state: HarnessState,
	_history: RefinementResult[],
	_model: Model<any>,
	_apiKey: string,
	_options: RefineOptions = {},
	_headers?: Record<string, string>,
	_signal?: AbortSignal,
	_thinkingLevel?: ThinkingLevel,
): Promise<RefinementPlan> {
	throw new Error(REMOVED);
}

export function applyRefinementProposal(
	_state: HarnessState,
	_proposal: RefinementProposal,
	_options: { id: string; rollbackOf?: string; scope?: HarnessScope; baselineState?: HarnessState },
): RefinementResult {
	throw new Error(REMOVED);
}

export async function refineHarness(
	_messages: AgentMessage[],
	_state: HarnessState,
	_history: RefinementResult[],
	_model: Model<any>,
	_apiKey: string,
	_options: RefineOptions = {},
	_headers?: Record<string, string>,
	_signal?: AbortSignal,
	_thinkingLevel?: ThinkingLevel,
): Promise<RefinementResult> {
	throw new Error(REMOVED);
}
