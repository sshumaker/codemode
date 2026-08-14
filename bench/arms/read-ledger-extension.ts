/**
 * codemode read-gate arm: record what prime's `read` tool actually delivered.
 *
 * The gate rendered into `api/_client.py` refuses an API whose contract has not
 * been read. This is the half that makes that claim *verified* rather than
 * advertised: it is the only writer of the ledger the gate consults, and it can
 * only write what prime's own read tool returned.
 *
 * Why an extension and not a patch to the kernel: `read` is a prime-side builtin,
 * so the file never passes through the ipython kernel at all — an in-kernel `open`
 * patch would see `cat`/`open()` and miss the one tool the gate is about. prime
 * fires `tool_result` for builtins as well as extension tools (`afterToolCall` in
 * packages/coding-agent/dist/core/agent-session.js), which is the seam.
 *
 * The recorded window is what the model SAW, not what it asked for. read truncates
 * at 2000 lines / 50KB, and AppWorld's `api/spotify.py` is 60KB — a whole-file read
 * of it returns roughly the first 1,150 lines and nothing more. Recording the
 * requested range there would certify a contract the model never received, which is
 * exactly the class of bug this gate exists to close ("`find_spec` certified a
 * module that contained a syntax error").
 *
 * `grep` is logged and never satisfies anything. A grep hit is a line, not a
 * contract, and the whole point is that the default-argument sentence two lines
 * below the match is what gets missed.
 */
import { appendFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

const LEDGER = process.env.HARNESS_READ_LEDGER ?? "";

/** Line count when the tool truncated; see truncate.d.ts. */
interface Truncation {
	truncated?: boolean;
	outputLines?: number;
	firstLineExceedsLimit?: boolean;
}

/**
 * `api/<pkg>.py` -> `<pkg>`, for any other path -> null.
 *
 * Resolved against the agent's cwd (the run directory) rather than matched on the
 * string, so `api/gmail.py`, `./api/gmail.py` and an absolute path are one entry.
 */
function packageOf(rawPath: unknown, apiDir: string): string | null {
	if (typeof rawPath !== "string" || !rawPath) return null;
	const absolute = resolve(process.cwd(), rawPath);
	const name = basename(absolute);
	if (!name.endsWith(".py") || name.startsWith("_")) return null;
	return resolve(absolute, "..") === apiDir ? name.slice(0, -3) : null;
}

export default function (pi: ExtensionAPI) {
	if (!LEDGER) throw new Error("HARNESS_READ_LEDGER is required (path to the run's read ledger)");
	const apiDir = resolve(process.cwd(), "api");

	pi.on("tool_result", (event: ToolResultEvent) => {
		if (event.toolName !== "read" && event.toolName !== "grep") return;
		const input = (event.input ?? {}) as { path?: string; offset?: number; limit?: number; pattern?: string };
		const pkg = packageOf(input.path, apiDir);
		// grep with no path, or a path outside api/, still lands in the ledger as
		// evidence of what the agent looked at; it just carries no window.
		if (event.toolName === "grep") {
			append({ tool: "grep", pkg, path: input.path ?? null, pattern: input.pattern ?? null, isError: event.isError });
			return;
		}
		if (pkg === null) return;

		const start = typeof input.offset === "number" && input.offset > 0 ? Math.floor(input.offset) : 1;
		const truncation = (event.details as { truncation?: Truncation } | undefined)?.truncation;
		// Three cases, in the order read.js decides them:
		//   truncated      the tool says exactly how many lines it emitted,
		//   user limit     the tool honoured it exactly,
		//   neither        everything from `offset` to the end of the file.
		const emitted = truncation?.firstLineExceedsLimit
			? 0
			: truncation?.truncated
				? (truncation.outputLines ?? 0)
				: typeof input.limit === "number" && input.limit > 0
					? Math.floor(input.limit)
					: null;
		append({
			tool: "read",
			pkg,
			path: input.path,
			offset: input.offset ?? null,
			limit: input.limit ?? null,
			start,
			// `Number.MAX_SAFE_INTEGER` is "to the end of the file" — the gate only ever
			// compares against a span, and no span reaches it.
			end: emitted === null ? Number.MAX_SAFE_INTEGER : start + emitted - 1,
			truncated: Boolean(truncation?.truncated),
			isError: event.isError,
		});
	});

	/**
	 * Append-only and synchronous, because the reader is another process.
	 *
	 * The gate runs inside the ipython kernel and re-reads this file on every call.
	 * A buffered write that landed after the model's next cell would refuse a read
	 * that had already happened, which is the one failure mode that would make the
	 * gate look broken to the agent rather than strict.
	 */
	function append(entry: Record<string, unknown>) {
		appendFileSync(LEDGER, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
	}
}
