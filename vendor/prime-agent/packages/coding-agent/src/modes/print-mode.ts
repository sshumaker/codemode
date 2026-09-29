/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import { spawn as spawnChild } from "node:child_process";
import { join as joinPath } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { type AgentAutonomousStatus, type AutonomousLimitReason, autonomousLimitReason } from "../core/autonomous.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";
import { InProcessAgentConnection } from "./agent-connection/in-process-agent-connection.js";
import type { AgentConnection } from "./agent-connection/types.js";
import { latestAutonomousGateAttempt, selectHeadlessTerminalResult } from "./headless-completion.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

function describeAutonomousLimit(status: AgentAutonomousStatus, reason: AutonomousLimitReason): string {
	if (reason === "maxContinuations") {
		return `maxContinuations reached (${status.continuationsUsed}/${status.limits.maxContinuations})`;
	}
	if (reason === "maxTurns") {
		return `maxTurns reached (${status.turnsUsed}/${status.limits.maxTurns})`;
	}
	if (reason === "maxTokens") {
		return `maxTokens reached (${status.tokensUsed}/${status.limits.maxTokens})`;
	}
	const elapsed = status.startedAt === undefined ? 0 : Math.max(0, Date.now() - status.startedAt);
	return `timeoutMs reached (${elapsed}/${status.limits.timeoutMs})`;
}

/**
 * Harness: a print run that ends waiting, with nothing outside it to wake it, wakes
 * itself.
 *
 * `jobs.wait` ends the turn (scripts/neutralize-prime.mjs). Under the scheduler
 * (HARNESS_WAKE_FILE, HARNESS_WAIT_MODE=exit) the process exits and
 * runtime/scheduler.py re-invokes it; an RPC host arms its own wake from `agent_end`.
 * A bare `-p` run has neither, and ending it at the first wait would silently end
 * the task — so print mode plays the scheduler's part in-process: it waits for the
 * same wake sources, then opens a new turn with the same `[woken: …]` message.
 *
 * The wake decision is runtime/scheduler.py's own (`--reason-for-request`, polled),
 * when HARNESS_RUNTIME_DIR names it; otherwise only the deadline wakes, which is
 * what the old in-tool sleep did. HARNESS_PRINT_SELF_WAKE=0 turns it off.
 */
interface HarnessAgentEnd {
	stopReason?: string;
	wait?: { seconds?: number; wakeAtMs?: number; request?: Record<string, unknown> };
}

function harnessPrintShouldSelfWake(): boolean {
	const mode = process.env.HARNESS_WAIT_MODE;
	return (
		process.env.HARNESS_PRINT_SELF_WAKE !== "0" && !process.env.HARNESS_WAKE_FILE && mode !== "exit" && mode !== "wake"
	);
}

async function harnessAskScheduler(request: Record<string, unknown>): Promise<string | null | undefined> {
	const runtimeDir = process.env.HARNESS_RUNTIME_DIR;
	if (!runtimeDir) return undefined;
	return new Promise((resolve) => {
		const child = spawnChild("python3", [joinPath(runtimeDir, "scheduler.py"), "--reason-for-request", "--consume"], {
			cwd: runtimeDir,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => {
			if (code !== 0) return resolve(undefined);
			try {
				const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { message?: string | null };
				resolve(parsed.message ?? null);
			} catch {
				resolve(undefined);
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

/** The opening message of the woken turn: the scheduler's, or the deadline's. */
async function harnessAwaitWake(wait: NonNullable<HarnessAgentEnd["wait"]>): Promise<string> {
	const seconds = Number(wait.seconds ?? 0);
	const deadline = wait.wakeAtMs ?? Date.now() + seconds * 1000;
	const pollMs = Number(process.env.HARNESS_SELF_WAKE_POLL_MS ?? 2000);
	let schedulerUsable = Boolean(wait.request);
	while (Date.now() < deadline) {
		if (schedulerUsable && wait.request) {
			const message = await harnessAskScheduler(wait.request);
			if (message === undefined) schedulerUsable = false;
			else if (message) return message;
		}
		const remaining = deadline - Date.now();
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, schedulerUsable ? Math.min(pollMs, remaining) : remaining)));
	}
	return `[woken: the requested wait of ${seconds}s elapsed] Check your jobs and continue the task.`;
}

async function harnessPrintSelfWake(
	connection: AgentConnection,
	takeWaitingEnd: () => HarnessAgentEnd | undefined,
): Promise<void> {
	if (!harnessPrintShouldSelfWake()) return;
	for (let end = takeWaitingEnd(); end?.wait; end = takeWaitingEnd()) {
		await connection.promptAndWait(await harnessAwaitWake(end.wait));
	}
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const connection = new InProcessAgentConnection(runtimeHost);
	return runPrintModeWithConnectionInternal(connection, options, () => connection.bindHeadlessExtensions());
}

export async function runPrintModeWithConnection(
	connection: AgentConnection,
	options: PrintModeOptions,
): Promise<number> {
	return runPrintModeWithConnectionInternal(connection, options);
}

async function runPrintModeWithConnectionInternal(
	connection: AgentConnection,
	options: PrintModeOptions,
	bindHeadlessExtensions?: () => Promise<void>,
): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let disposed = false;
	let unsubscribe: (() => void) | undefined;
	let lastAgentEnd: HarnessAgentEnd | undefined;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeConnection = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await connection.dispose();
	};

	for (const signal of [
		"SIGINT",
		"SIGTERM",
		...(process.platform === "win32" ? [] : ["SIGHUP"]),
	] as NodeJS.Signals[]) {
		const handler = () => {
			killTrackedDetachedChildren();
			void disposeConnection().finally(() => {
				const exitCode = signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143;
				process.exit(exitCode);
			});
		};
		process.on(signal, handler);
		signalCleanupHandlers.push(() => process.off(signal, handler));
	}

	try {
		if (mode === "json") {
			const header = await connection.getSessionHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		unsubscribe = connection.subscribe((event) => {
			if (event.type === "session_event" && event.event.type === "agent_end") {
				lastAgentEnd = event.event as HarnessAgentEnd;
			}
			if (mode === "json" && event.type === "session_event") {
				writeRawStdout(`${JSON.stringify(event.event)}\n`);
			}
			if (event.type === "extension_error") {
				console.error(`Extension error (${event.extensionPath}): ${event.error}`);
			}
		});
		await bindHeadlessExtensions?.();

		if (initialMessage) {
			await connection.promptAndWait(initialMessage, { images: initialImages });
		}
		for (const message of messages) {
			await connection.promptAndWait(message);
		}
		await harnessPrintSelfWake(connection, () => {
			const end = lastAgentEnd;
			lastAgentEnd = undefined;
			return end?.stopReason === "waiting" ? end : undefined;
		});

		const autonomousStatus = await connection.waitForHeadlessCompletion();
		if (mode === "text") {
			const { primary, compactionOutcomes } = selectHeadlessTerminalResult(await connection.getMessages());
			if (primary?.role === "assistant") {
				if (primary.stopReason === "error" || primary.stopReason === "aborted") {
					console.error(primary.errorMessage || `Request ${primary.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of primary.content) {
						if (content.type === "text") {
							writeRawStdout(`${content.text}\n`);
						}
					}
				}
			} else if (primary) {
				writeRawStdout(`${primary.content}\n`);
				if (!primary.details.success || primary.details.severity === "error") exitCode = 1;
			}
			for (const outcome of compactionOutcomes) {
				console.error(outcome.content);
				if (outcome.details.outcome === "failed") exitCode = 1;
			}
		}

		const autonomousLimit = autonomousLimitReason(autonomousStatus);
		if (autonomousStatus.enabled && autonomousStatus.gates.commands.length > 0 && autonomousStatus.lastGateFailure) {
			const limitText = autonomousLimit
				? `; autonomous limit reached: ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`
				: "";
			console.error(
				`Autonomous quality gate still failing after attempt ${latestAutonomousGateAttempt(autonomousStatus)}/${autonomousStatus.gates.maxRetries}: ${autonomousStatus.lastGateFailure.exitText}${limitText}`,
			);
			exitCode = 1;
		} else if (autonomousStatus.enabled && autonomousStatus.gates.commands.length === 0 && autonomousLimit) {
			console.error(
				`Autonomous run stopped before terminal evidence; ${describeAutonomousLimit(autonomousStatus, autonomousLimit)}`,
			);
			exitCode = 1;
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeConnection();
		await flushRawStdout();
	}
}
