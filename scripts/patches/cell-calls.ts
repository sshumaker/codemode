import { readFileSync as callJournalReadFileSync, statSync as callJournalStatSync } from "node:fs";

/**
 * Every call a cell made out of the kernel, in arrival order, with what came of it.
 *
 * A cell whose kernel died mid-run is reported, not sent again (cell-progress.ts),
 * and the model is told to check what landed. This is what it checks against: the
 * host performs or proxies those calls, so it can say which ones happened.
 *
 * One journal per execution. A call's identity is (execution id, seq), seq being its
 * position in arrival order. Three paths feed it:
 *
 *   host    a host request (rlm host_request comm, or the remote link's host_request),
 *           begun and settled here around the handler;
 *   tool    a tool-proxy request tunnelled from a remote kernel, begun and settled by
 *           the loop's forwarder (remote-kernel/tools.ts);
 *   proxy   a request a LOCAL kernel sent straight to HARNESS_MCP_PROXY, which this
 *           process never sees. The kernel appends it to HARNESS_CALL_JOURNAL before
 *           the request leaves and again when the answer is in
 *           (scripts/patches/call-journal.py); the file is read when the kernel dies.
 *
 * Outcomes are what the CALLER knew: an answer received is completed or failed; a
 * request with no answer before the kernel died is unknown — it may or may not
 * have taken effect. A call that settles after the death (a host handler still
 * running) is reported with its late outcome and marked as such.
 */
export type CallOutcome = "completed" | "failed" | "unknown";
export type CallPath = "host" | "tool" | "proxy";

export interface CellCall {
	id: string;
	seq: number;
	path: CallPath;
	name: string;
	outcome: CallOutcome;
	summary?: string;
	/** Settled after the kernel had already died: the cell never saw this answer. */
	late?: boolean;
	/** Made by a background task an earlier cell started, not by this cell. */
	background?: boolean;
}

interface CallEntry {
	path: CallPath;
	name: string;
	at: number;
	outcome: CallOutcome;
	summary?: string;
	late?: boolean;
	background?: boolean;
	settled: boolean;
}

export const CALL_JOURNAL_FILE = "calls.jsonl";
const CALL_SUMMARY_CHARS = 120;
const CALLS_LISTED_HEAD = 8;
const CALLS_LISTED_TAIL = 4;

export class CallJournal {
	private readonly entries: CallEntry[] = [];
	private dead = false;
	private readonly kernelOffset: number;
	/** Whether proxy calls from a local kernel were observable for this execution. */
	private proxyObserved: boolean;
	/** The kernel wrote that it picked this execution up (pre_run_cell), whatever iopub managed to say. */
	kernelStarted = false;

	/**
	 * @param kernelFile the local kernel's HARNESS_CALL_JOURNAL, if it has one.
	 * @param tunnelled true when every proxy call passes through this process (remote kernel).
	 */
	constructor(
		readonly executionId: string,
		private readonly options: { kernelFile?: string; tunnelled?: boolean } = {},
	) {
		this.proxyObserved = Boolean(options.tunnelled);
		this.kernelOffset = options.kernelFile ? fileSize(options.kernelFile) : 0;
	}

	get size(): number {
		return this.entries.length;
	}

	get isDead(): boolean {
		return this.dead;
	}

	/** Record a call leaving the kernel; settle it with the returned function when the answer is in. */
	begin(path: CallPath, name: string): (outcome: CallOutcome, summary?: string) => void {
		const entry: CallEntry = {
			path,
			name,
			at: Date.now(),
			outcome: "unknown",
			settled: false,
		};
		this.entries.push(entry);
		return (outcome, summary) => {
			if (entry.settled) return;
			entry.settled = true;
			entry.outcome = outcome;
			entry.summary = summary;
			entry.late = this.dead;
		};
	}

	/** The kernel died: fold in what a local kernel wrote, and mark later settles as late. */
	died(): void {
		if (this.dead) return;
		this.dead = true;
		if (this.options.kernelFile) this.readKernelFile(this.options.kernelFile);
	}

	/** Every call so far, in arrival order. */
	calls(): CellCall[] {
		return [...this.entries]
			.sort((a, b) => a.at - b.at)
			.map((e, i) => ({
				id: `${this.executionId}:${i + 1}`,
				seq: i + 1,
				path: e.path,
				name: e.name,
				outcome: e.outcome,
				...(e.summary ? { summary: e.summary } : {}),
				...(e.late ? { late: true } : {}),
				...(e.background ? { background: true } : {}),
			}));
	}

	/** Which ways out of the kernel this journal saw, for the report's honesty line. */
	get coversProxy(): boolean {
		return this.proxyObserved;
	}

	private readKernelFile(path: string): void {
		let text: string;
		try {
			text = callJournalReadFileSync(path, "utf8");
		} catch {
			return;
		}
		const byCall = new Map<number, CallEntry>();
		let offset = 0;
		for (const line of text.split("\n")) {
			const start = offset;
			offset += Buffer.byteLength(line, "utf8") + 1;
			const record = parseJournalLine(line);
			if (!record) continue;
			if (record.k === "open") {
				this.proxyObserved = true;
				continue;
			}
			if (record.k === "start") {
				if (start >= this.kernelOffset && record.msg === this.executionId) this.kernelStarted = true;
				continue;
			}
			const n = typeof record.n === "number" ? record.n : undefined;
			if (n === undefined) continue;
			if (record.k === "call" && start >= this.kernelOffset) {
				const entry: CallEntry = {
					path: "proxy",
					name: typeof record.name === "string" ? record.name : "?",
					at: typeof record.at === "number" ? record.at : Date.now(),
					outcome: "unknown",
					settled: false,
					...(typeof record.msg === "string" && record.msg !== this.executionId ? { background: true } : {}),
				};
				byCall.set(n, entry);
				this.entries.push(entry);
			} else if (record.k === "end") {
				const entry = byCall.get(n);
				if (!entry) continue;
				const outcome = record.outcome;
				if (outcome === "completed" || outcome === "failed" || outcome === "unknown") entry.outcome = outcome;
				if (typeof record.summary === "string") {
					entry.summary =
						entry.outcome === "completed" ? summarizeCallResult(record.summary) : clipSummary(record.summary);
				}
				entry.settled = true;
			}
		}
	}
}

function fileSize(path: string): number {
	try {
		return callJournalStatSync(path).size;
	} catch {
		return 0;
	}
}

function parseJournalLine(line: string): Record<string, unknown> | undefined {
	if (!line.trim()) return undefined;
	try {
		const value = JSON.parse(line);
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function clipSummary(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > CALL_SUMMARY_CHARS ? `${flat.slice(0, CALL_SUMMARY_CHARS - 1)}…` : flat;
}

const ID_KEYS = ["id", "job_id", "jobId", "name", "handle", "task_id", "taskId", "status", "state"];

/** A short line for what a call returned: its id-like fields if it has any, else the start of it. */
export function summarizeCallResult(value: unknown): string {
	let v = value;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			return clipSummary(v as string);
		}
	}
	if (typeof v === "object" && v !== null && !Array.isArray(v)) {
		const record = v as Record<string, unknown>;
		const ids = ID_KEYS.filter((k) => typeof record[k] === "string" || typeof record[k] === "number").slice(0, 3);
		if (ids.length > 0) return clipSummary(ids.map((k) => `${k}=${record[k]}`).join(" "));
	}
	return clipSummary(typeof v === "string" ? v : stringifyLoosely(v));
}

/** JSON when it encodes, String() when it does not: a summary must never fail the call it describes. */
function stringifyLoosely(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** Run one call through the journal: begun now, settled by how the handler ends. */
export async function journaled<T>(
	journal: CallJournal | undefined,
	path: CallPath,
	name: string,
	run: () => Promise<T>,
): Promise<T> {
	const settle = journal?.begin(path, name);
	let value: T;
	try {
		value = await run();
	} catch (error) {
		settle?.("failed", clipSummary(error instanceof Error ? error.message : String(error)));
		throw error;
	}
	settle?.("completed", summarizeCallResult(value));
	return value;
}

/** Attach the execution's journal to the error that ends it; a cell with any call has "called". */
export function markCellCalls<E extends Error>(error: E, journal: CallJournal | undefined): E {
	if (!journal) return error;
	journal.died();
	(error as { cellCalls?: CallJournal }).cellCalls = journal;
	if (journal.size > 0) return markCellProgress(error, "called");
	return journal.kernelStarted ? markCellProgress(error, "started") : error;
}

export function cellCallJournal(error: unknown): CallJournal | undefined {
	const journal = (error as { cellCalls?: unknown } | undefined)?.cellCalls;
	return journal instanceof CallJournal ? journal : undefined;
}

function describeCall(call: CellCall): string {
	const where = call.background ? " (from a background task an earlier cell started)" : "";
	let what: string;
	if (call.outcome === "unknown") {
		const reason = call.summary ? ` (${call.summary})` : "";
		what = `UNKNOWN — no answer came back${reason}, so it may or may not have taken effect`;
	} else {
		const late = call.late ? " after the kernel died (the cell never saw it)" : "";
		what = `${call.outcome}${late}${call.summary ? `: ${call.summary}` : ""}`;
	}
	return `  ${call.seq}. ${call.path} ${call.name}${where} — ${what}`;
}

function tallyOutcomes(calls: readonly CellCall[]): string {
	return (["completed", "failed", "unknown"] as const)
		.map((o) => [o, calls.filter((c) => c.outcome === o).length] as const)
		.filter(([, n]) => n > 0)
		.map(([o, n]) => `${n} ${o}`)
		.join(", ");
}

/** The died-mid-run report: unchanged when no call was recorded, else the calls and what they covered. */
export function describeCellDeath(head: string, journal: CallJournal | undefined): string {
	const tail = "Check what landed before repeating any of it.";
	const calls = journal?.calls() ?? [];
	if (calls.length === 0) return `${head} ${tail}`;
	const counts = tallyOutcomes(calls);
	const lines = [`Calls it made, in the order they left the kernel (${counts}; execution ${journal!.executionId}):`];
	if (calls.length <= CALLS_LISTED_HEAD + CALLS_LISTED_TAIL) lines.push(...calls.map(describeCall));
	else {
		const hidden = calls.slice(CALLS_LISTED_HEAD, -CALLS_LISTED_TAIL);
		const unknown = hidden.filter((c) => c.outcome === "unknown");
		const range = `${hidden[0].seq}–${hidden[hidden.length - 1].seq}`;
		lines.push(...calls.slice(0, CALLS_LISTED_HEAD).map(describeCall));
		lines.push(
			`  … calls ${range} not listed (${tallyOutcomes(hidden)})${unknown.length ? "; the unknown ones:" : ""}`,
		);
		// An unknown outcome is the one thing the model must not miss, wherever it falls.
		lines.push(...unknown.slice(0, CALLS_LISTED_TAIL).map(describeCall));
		if (unknown.length > CALLS_LISTED_TAIL) lines.push(`  … and ${unknown.length - CALLS_LISTED_TAIL} more unknown`);
		lines.push(...calls.slice(-CALLS_LISTED_TAIL).map(describeCall));
	}
	lines.push(
		journal!.coversProxy
			? "That is every host request and every call to the tool proxy (HARNESS_MCP_PROXY) the cell made; nothing else left the kernel by those paths. Anything it did directly — files written, subprocesses, other network traffic — is not tracked here."
			: "That is every host request the cell made. Calls to the tool proxy (HARNESS_MCP_PROXY) were not observable for this kernel, so it may have made others; anything it did directly — files written, subprocesses, other network traffic — is not tracked either.",
	);
	return `${head}\n\n${lines.join("\n")}\n\n${tail}`;
}

/** The kernel's env, with HARNESS_CALL_JOURNAL pointed into its own temp dir when dead cells are reported. */
export function withCallJournal(
	env: Record<string, string> | undefined,
	tempDir: string,
): Record<string, string> | undefined {
	if (process.env.HARNESS_KERNEL_AUTORESTART !== "1") return env;
	return { ...env, HARNESS_CALL_JOURNAL: `${tempDir}/${CALL_JOURNAL_FILE}` };
}
