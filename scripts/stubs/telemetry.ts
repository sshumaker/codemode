/**
 * Slim build: product analytics has been removed.
 * Installed by scripts/slim-prime.mjs; the original is 797 LOC.
 *
 * Upstream this is ON by default for every session, including every `-p` print
 * run, and batches events ("agent started", "agent run completed", token
 * usage, model ids, install method) to the vendor's analytics endpoint. Our
 * env sets happened to cover it; a host must not have to know that.
 * docs/CLOUD-HARNESS-DESIGN.md §3.3 makes it a rule rather than a setting.
 *
 * `isTelemetryEnabled` returns false unconditionally, which means every caller
 * that guards on it — including the install site in agent-session-services.ts —
 * takes the already-existing no-op path.
 */

import type { AgentExecutionMode } from "./agent-session-config.js";
import type { AuthCredential, AuthStatus } from "./auth-storage.js";
import type { SettingsManager } from "./settings-manager.js";

export type TelemetryEventName =
	| "agent started"
	| "onboarding completed"
	| "agent command used"
	| "agent run completed"
	| "agent session ended";

export type TelemetryExecutionMode = AgentExecutionMode | "unknown";
export type TelemetryOnboardingOutcome = "success" | "error" | "aborted";
export type TelemetryAuthCategory = "none" | "oauth" | "api-key" | "unknown";

export interface TelemetryEvent {
	event: TelemetryEventName;
	properties: Record<string, string | number | boolean | null>;
}

export interface TelemetryBatch {
	events: TelemetryEvent[];
}

export interface TelemetrySink {
	capture(event: TelemetryEvent): void;
	flush(): Promise<void>;
}

export interface CaptureOnboardingCompletedOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	durationMs: number;
	outcome: TelemetryOnboardingOutcome;
	provider?: string;
	authSource?: AuthStatus["source"];
	storedCredentialType?: AuthCredential["type"];
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

export interface CaptureAgentCommandUsedOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	commandName: string;
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

interface InstallAgentTelemetryOptions {
	agentDir: string;
	settingsManager: SettingsManager;
	executionMode?: AgentExecutionMode;
	sink?: TelemetrySink;
	now?: () => number;
	randomId?: () => string;
}

/** Always false in this build. See the header. */
export function isTelemetryEnabled(_settingsManager: SettingsManager): boolean {
	return false;
}

export function getOrCreateTelemetryInstallationId(_agentDir: string, _randomId?: () => string): string {
	return "00000000-0000-0000-0000-000000000000";
}

export function telemetryProviderCategory(_provider: string | undefined): string {
	return "unknown";
}

export function telemetryAuthCategory(
	_authSource?: AuthStatus["source"],
	_credentialType?: AuthCredential["type"],
): TelemetryAuthCategory {
	return "unknown";
}

export async function captureOnboardingCompleted(_options: CaptureOnboardingCompletedOptions): Promise<void> {}

export async function captureAgentCommandUsed(_options: CaptureAgentCommandUsedOptions): Promise<void> {}

export function installAgentTelemetry(_session: unknown, _options: InstallAgentTelemetryOptions): void {}
