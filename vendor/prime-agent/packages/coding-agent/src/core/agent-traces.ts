/**
 * Slim build: the full-transcript upload has been removed.
 * Installed by scripts/slim-prime.mjs; the original is 968 LOC.
 *
 * Upstream `installAgentTraceUpload` is called unconditionally and no
 * environment variable gates it — `PI_OFFLINE` does not reach this module. When
 * a credential is present it PUTs the entire session JSONL, with cwd and git
 * repo/commit headers attached, to the vendor's trace endpoint. It never fired
 * in this repo only because no credential existed, which is luck rather than a
 * control (2026-08-15 audit, P2.6).
 *
 * scripts/neutralize-prime.mjs wraps the install site in a
 * `PRIME_AGENT_TRACES === "1"` opt-in and that patch is deliberately left in
 * place — it is the anchor the neutralize script asserts on, and a gate in
 * front of a no-op is still a no-op. This file is the belt to that suspenders:
 * even with the flag set, nothing leaves the machine.
 *
 * Every exported name and result shape is preserved; interactive-mode's
 * `/traces` command switches exhaustively over these unions.
 */

import type { AuthStorage } from "./auth-storage.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

export type AgentTraceCredentialSource = "environment" | "stored" | "prime-inference" | "prime-cli";

export interface AgentTraceCredential {
	apiKey: string;
	source: AgentTraceCredentialSource;
	label: string;
}

export type AgentTraceUploadResult =
	| {
			status: "uploaded";
			sessionId: string;
			traceId: string;
			bytesStored: number;
			key?: string;
	  }
	| { status: "disabled" }
	| { status: "missing_credentials" }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "too_large"; size: number; maxBytes: number }
	| { status: "failed"; statusCode?: number; message: string };

export interface AgentTraceUploadOptions {
	sessionFile: string | undefined;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	requireEnabled?: boolean;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	reloadConfig?: boolean;
	requestTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface AgentTraceSessionUploadOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionManager: SessionManager;
}

export interface AgentTraceUploadInstallOptions {
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
}

export type AgentTracePreviewResult =
	| {
			status: "ready";
			sessionFile: string;
			sessionId: string;
			traceId: string;
			parentSessionId?: string;
			cwd: string;
			size: number;
			maxBytes: number;
			uploadable: boolean;
			endpoint: string;
			gitRepo?: string;
			gitCommit?: string;
			contentPreview: string;
			truncated: boolean;
	  }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "failed"; message: string };

export interface AgentTracePreviewOptions {
	sessionFile: string | undefined;
	baseUrl?: string;
	maxContentChars?: number;
}

export interface AgentTraceUploadAllProgress {
	completed: number;
	total: number;
	sessionFile?: string;
	result?: AgentTraceUploadResult;
}

export interface AgentTraceUploadAllOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionDir?: string;
	concurrency?: number;
	onProgress?: (progress: AgentTraceUploadAllProgress) => void;
}

export interface AgentTraceUploadAllResult {
	total: number;
	uploaded: number;
	failed: number;
	skipped: number;
	bytesStored: number;
	results: Array<{ sessionFile: string; result: AgentTraceUploadResult }>;
}

const REMOVED = "trace upload was removed in this build (scripts/slim-prime.mjs)";

export function activeGitContext<T>(_body: unknown, header: T): T {
	return header;
}

export async function previewAgentTraceFile(_options: AgentTracePreviewOptions): Promise<AgentTracePreviewResult> {
	return { status: "failed", message: REMOVED };
}

export async function findAgentTraceFiles(_sessionDir?: string): Promise<string[]> {
	return [];
}

export async function uploadAllAgentTraces(_options: AgentTraceUploadAllOptions): Promise<AgentTraceUploadAllResult> {
	return { total: 0, uploaded: 0, failed: 0, skipped: 0, bytesStored: 0, results: [] };
}

export async function getPrimeAgentTraceCredential(
	_authStorage: AuthStorage,
	_options: { reloadAuth?: boolean; configPath?: string } = {},
): Promise<AgentTraceCredential | undefined> {
	return undefined;
}

export async function uploadAgentTraceFile(_options: AgentTraceUploadOptions): Promise<AgentTraceUploadResult> {
	return { status: "disabled" };
}

export async function uploadAgentTraceSession(
	_options: AgentTraceSessionUploadOptions,
): Promise<AgentTraceUploadResult> {
	return { status: "disabled" };
}

export function installAgentTraceUpload(
	_sessionManager: SessionManager,
	_options: AgentTraceUploadInstallOptions,
): void {}

export async function flushAgentTraceUpload(
	_sessionManager: SessionManager,
): Promise<AgentTraceUploadResult | undefined> {
	return undefined;
}
