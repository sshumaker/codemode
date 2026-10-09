/**
 * Wire protocol between the loop (RemoteKernelLink) and the kernel server that runs
 * inside the sandbox. Placed into the vendored tree by scripts/neutralize-prime.mjs.
 *
 * Two layers share one WebSocket:
 *
 *   control   hello / welcome / reject / ping / pong / ack / bye. Never buffered,
 *             never replayed: they describe the socket, not the session.
 *   data      `{t: "d", seq, m}`. Every data frame is numbered per direction and
 *             kept by its sender until the peer acknowledges it, so a dropped socket
 *             loses nothing: on reattach each side replays what the other has not
 *             acknowledged (ReliableChannel, channel.ts).
 *
 * A data frame's `m` is one application message. Requests carry an `id` chosen by
 * the loop; the server answers each with exactly one `result`, preceded by any
 * number of `stream` / `late` / `progress` / `spawn_data` for the same id. Requests
 * the server makes of the loop (host requests, tool-proxy HTTP calls) carry a
 * `reqId` chosen by the server and are answered with the matching `*_response`.
 */
import type { KernelPythonSkill } from "../bootstrap.js";
import type { CellProgress, ExecuteResult, KernelSentAgentMessage } from "../index.js";

export const PROTOCOL_VERSION = 2;

/** Why a remote call failed, in a form both sides agree on. */
export type WireErrorCode =
	| "kernel_died"
	| "kernel_shutdown"
	| "busy_after_interrupt"
	| "egress_open"
	| "no_kernel"
	| "bad_request"
	| "session_lost"
	| "internal";

export interface WireError {
	code: WireErrorCode;
	name: string;
	message: string;
	/** How far the cell got before the kernel died, when the failure ended one. */
	progress?: CellProgress;
}

/** What the sandbox side says about its own boundary, reported once per socket. */
export interface ServerPosture {
	/** The thing that contains model-authored code: e.g. "daytona-sandbox", "none (local fake)". */
	boundary: string;
	/** "blocked" only when the server's own probe could not reach the internet. */
	egress: "blocked" | "open";
	/** Present when the kernel is allowed to start despite open egress, and why. */
	egressOverride?: string;
	/** Hosts the probe tried, with what happened, so the verdict can be re-derived. */
	probe: { target: string; outcome: string }[];
	serverVersion: string;
}

export interface RemoteSnapshotRequest {
	/** Stable per-conversation key; the server derives the on-disk location from it. */
	key: string;
	maxBytes?: number;
	debounceMs?: number;
}

/** A local path prefix and where the same files live inside the sandbox. */
export interface PathMapping {
	local: string;
	remote: string;
}

export interface RemoteStartOptions {
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	username?: string;
	/** Python skills with their packagePath already rewritten to the server's copy. */
	pythonSkills?: readonly KernelPythonSkill[];
	snapshot?: RemoteSnapshotRequest;
	/** Host handler names the loop registered; the server proxies each back over the socket. */
	hostHandlerTypes: string[];
	/** The loop's own path layout, so the server can mirror it (see server.ts mirrorPaths). */
	pathMap?: PathMapping[];
}

export type KernelMethod =
	| "restart"
	| "shutdown"
	| "kill"
	| "snapshotState"
	| "restoreState"
	| "snapshotExists"
	| "listNamespaceNames"
	| "dispose";

/** Messages the loop sends. */
export type ClientMessage =
	| { op: "start"; id: number; kernel: string; options: RemoteStartOptions }
	| {
			op: "execute";
			id: number;
			kernel: string;
			code: string;
			maxOutputChars?: number;
			internal?: boolean;
			wantLate?: boolean;
	  }
	| { op: "abort"; id: number }
	| {
			op: "call";
			id: number;
			kernel: string;
			method: KernelMethod;
			args?: { snapshot?: boolean };
	  }
	| {
			op: "spawn";
			id: number;
			/** A bare tool name the server resolves itself: "rg", "fd", "python", "bash". */
			bin: string;
			args: string[];
			env?: Record<string, string>;
			cwd?: string;
			/** base64 bytes written to the child's stdin, which is then closed. */
			stdin?: string;
	  }
	| { op: "signal"; id: number; signal: string }
	| { op: "skills_have"; id: number; hashes: string[] }
	| { op: "skills_put"; id: number; hash: string; name: string; tgz: string }
	| { op: "noop"; id: number }
	| {
			op: "host_response";
			reqId: number;
			ok: true;
			value: Record<string, unknown>;
	  }
	| { op: "host_response"; reqId: number; ok: false; error: string }
	| {
			op: "http_response";
			reqId: number;
			status: number;
			headers: Record<string, string>;
			body: string;
	  };

/** Messages the server sends. */
export type ServerMessage =
	| {
			op: "result";
			id: number;
			ok: true;
			value: unknown;
			isRunning?: boolean;
			serverMs: number;
	  }
	| {
			op: "result";
			id: number;
			ok: false;
			error: WireError;
			isRunning?: boolean;
			serverMs: number;
	  }
	| { op: "stream"; id: number; chunk: string; name: "stdout" | "stderr" }
	| { op: "late"; id: number; message: KernelSentAgentMessage }
	| { op: "progress"; id: number; message: string }
	| { op: "spawn_data"; id: number; fd: 1 | 2; data: string }
	| {
			op: "host_request";
			reqId: number;
			kernel: string;
			payload: Record<string, unknown>;
	  }
	| {
			op: "http_request";
			reqId: number;
			kernel: string;
			method: string;
			path: string;
			headers: Record<string, string>;
			body: string;
	  }
	| { op: "http_cancel"; reqId: number };

export type ControlFrame =
	| { t: "hello"; v: number; token?: string; session: string; resume: number }
	| {
			t: "welcome";
			v: number;
			session: string;
			resumed: boolean;
			resume: number;
			posture: ServerPosture;
	  }
	| {
			t: "reject";
			code: "unauthorized" | "version" | "bad_hello";
			message: string;
	  }
	| { t: "ping"; n: number; ack: number }
	| { t: "pong"; n: number; ack: number }
	| { t: "ack"; seq: number }
	| { t: "bye" };

export type DataFrame<M> = { t: "d"; seq: number; m: M };

export type Frame<M> = ControlFrame | DataFrame<M>;

export class ProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolError";
	}
}

const CONTROL_TYPES = new Set(["hello", "welcome", "reject", "ping", "pong", "ack", "bye"]);
const CLIENT_OPS = new Set([
	"start",
	"execute",
	"abort",
	"call",
	"spawn",
	"signal",
	"skills_have",
	"skills_put",
	"noop",
	"host_response",
	"http_response",
]);
const SERVER_OPS = new Set([
	"result",
	"stream",
	"late",
	"progress",
	"spawn_data",
	"host_request",
	"http_request",
	"http_cancel",
]);

export function encodeFrame<M>(frame: Frame<M>): string {
	return JSON.stringify(frame);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeq(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeFrame<M>(raw: string | Buffer | ArrayBuffer | Buffer[], ops: Set<string>): Frame<M> {
	const text = Array.isArray(raw)
		? Buffer.concat(raw).toString("utf8")
		: raw instanceof ArrayBuffer
			? Buffer.from(raw).toString("utf8")
			: raw.toString();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ProtocolError(`frame is not JSON: ${text.slice(0, 80)}`);
	}
	if (!isRecord(parsed) || typeof parsed.t !== "string") throw new ProtocolError("frame has no type");
	if (parsed.t === "d") {
		if (!isSeq(parsed.seq) || parsed.seq < 1) throw new ProtocolError("data frame has no sequence number");
		if (!isRecord(parsed.m) || typeof parsed.m.op !== "string" || !ops.has(parsed.m.op)) {
			throw new ProtocolError(`data frame carries an unknown message: ${JSON.stringify(parsed.m).slice(0, 80)}`);
		}
		return parsed as DataFrame<M>;
	}
	if (!CONTROL_TYPES.has(parsed.t)) throw new ProtocolError(`unknown frame type ${parsed.t}`);
	if ((parsed.t === "ping" || parsed.t === "pong") && !isSeq(parsed.ack))
		throw new ProtocolError("heartbeat without ack");
	if (parsed.t === "ack" && !isSeq(parsed.seq)) throw new ProtocolError("ack without sequence number");
	if (parsed.t === "hello" && (typeof parsed.session !== "string" || !isSeq(parsed.resume))) {
		throw new ProtocolError("hello without session");
	}
	return parsed as ControlFrame;
}

/** Decode a frame the loop sent (server side). */
export function decodeClientFrame(raw: string | Buffer | ArrayBuffer | Buffer[]): Frame<ClientMessage> {
	return decodeFrame<ClientMessage>(raw, CLIENT_OPS);
}

/** Decode a frame the server sent (loop side). */
export function decodeServerFrame(raw: string | Buffer | ArrayBuffer | Buffer[]): Frame<ServerMessage> {
	return decodeFrame<ServerMessage>(raw, SERVER_OPS);
}

export type RemoteExecuteResult = ExecuteResult;
