/**
 * The kernel server: runs INSIDE the sandbox and drives prime's own KernelManager
 * (not a reimplementation) on behalf of a loop that lives elsewhere.
 *
 * Owns: the WebSocket endpoint and its sessions, one ReliableChannel per session,
 * the grace window a session survives a dropped socket for, the kernels each
 * session started, the loopback HTTP listener that stands in for the tool proxy,
 * the file-tool process executor, the Python-skill package store, the namespace
 * snapshot locations, and the egress probe that decides whether a kernel may start.
 *
 * Not responsible for: creating or locking the sandbox (runtime/daytona/provider.mjs
 * does that), the model, or any credential. Nothing here ever holds a model key or
 * a connector token: tool calls leave the sandbox only as messages on the socket,
 * and the loop adds the egress token on its side.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { ensureTool } from "../../../utils/tools-manager.js";
import { getKernelVenvDir, type KernelPythonSkill } from "../bootstrap.js";
import { cellProgress, type HostRequestHandlers, KernelBusyAfterInterruptError, KernelManager } from "../index.js";
import { manifestPathIn, snapshotPathIn } from "../state-snapshot.js";
import { ReliableChannel } from "./channel.js";
import {
	type ClientMessage,
	type ControlFrame,
	decodeClientFrame,
	encodeFrame,
	type Frame,
	type KernelMethod,
	PROTOCOL_VERSION,
	type RemoteStartOptions,
	type ServerMessage,
	type ServerPosture,
	type WireError,
	type WireErrorCode,
} from "./protocol.js";

export interface KernelServerConfig {
	port: number;
	/** The tool tunnel's loopback port; 0 picks one. Fixed, for a sandbox that allows loopback per port. */
	tunnelPort: number;
	host: string;
	/** Shared secret the loop presents in `hello`; unset only for the in-process fake. */
	token?: string;
	defaultCwd: string;
	stateDir: string;
	/**
	 * Python skill packages, content-addressed. Defaults to `<stateDir>/skills`. Separate so
	 * several servers (one per conversation, each with its own stateDir) can share one
	 * prebaked set, which the venv records by exact path, read-only to all of them.
	 */
	skillsDir: string;
	/** What contains the kernel, reported in every welcome: "daytona-sandbox", "none (local fake)". */
	boundary: string;
	/** Start kernels even with open egress; the reason is recorded in the posture. */
	allowOpenEgress?: string;
	graceMs: number;
	idleSocketMs: number;
	toolTimeoutMs: number;
	version: string;
	probeTargets: { host: string; port: number }[];
	probeTimeoutMs: number;
	log: (line: string) => void;
}

const DEFAULT_PROBE_TARGETS = [
	{ host: "1.1.1.1", port: 443 },
	{ host: "8.8.8.8", port: 53 },
	{ host: "pypi.org", port: 443 },
];

export function kernelServerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KernelServerConfig {
	const stateDir = env.KERNEL_SERVER_STATE_DIR ?? join(homedir(), ".harness");
	return {
		port: Number(env.KERNEL_SERVER_PORT ?? 8765),
		tunnelPort: Number(env.KERNEL_SERVER_TUNNEL_PORT ?? 0),
		host: env.KERNEL_SERVER_HOST ?? "0.0.0.0",
		token: env.KERNEL_SERVER_TOKEN || undefined,
		defaultCwd: env.KERNEL_SERVER_CWD ?? join(homedir(), "work"),
		stateDir,
		skillsDir: env.KERNEL_SERVER_SKILLS_DIR ?? join(stateDir, "skills"),
		boundary: env.KERNEL_SERVER_BOUNDARY ?? "unspecified",
		allowOpenEgress: env.KERNEL_SERVER_ALLOW_OPEN_EGRESS || undefined,
		graceMs: Number(env.KERNEL_SERVER_GRACE_MS ?? 5 * 60_000),
		idleSocketMs: Number(env.KERNEL_SERVER_IDLE_SOCKET_MS ?? 45_000),
		toolTimeoutMs: Number(env.KERNEL_SERVER_TOOL_TIMEOUT_MS ?? 20 * 60_000),
		version: env.KERNEL_SERVER_VERSION ?? "dev",
		probeTargets: env.KERNEL_SERVER_PROBE_TARGETS
			? env.KERNEL_SERVER_PROBE_TARGETS.split(",").map((hp) => {
					const [host, port] = hp.split(":");
					return { host, port: Number(port ?? 443) };
				})
			: DEFAULT_PROBE_TARGETS,
		probeTimeoutMs: Number(env.KERNEL_SERVER_PROBE_TIMEOUT_MS ?? 2000),
		log: (line) => process.stdout.write(`[kernel-server] ${line}\n`),
	};
}

/** Env names the kernel and file-tool children may inherit from the server process. */
export const CHILD_ENV_ALLOW = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TZ",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TMPDIR",
	"UV_*",
	"PRIME_AGENT_*",
	"XDG_*",
];

/** A loop-supplied env name that must never reach a sandboxed process. */
const SECRET_ENV_NAME = /(KEY|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE)|(^|_)TOKEN$/i;
/** Loop-side paths the runtime writes to; the server gives each kernel its own copy. */
const REMAPPED_ENV_DIRS = ["RLM_SESSION_DIR", "RLM_HARNESS_STATE_DIR", "RLM_GLOBAL_HARNESS_STATE_DIR"];
/** Loop env the kernel legitimately needs even though the name looks like a secret. */
const NONSECRET_ENV = new Set(["HARNESS_WAIT_TOKEN"]);

function matchesAllow(name: string, allow: readonly string[]): boolean {
	return allow.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

export function childBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && matchesAllow(name, CHILD_ENV_ALLOW)) out[name] = value;
	}
	return out;
}

/**
 * The kernel's per-start environment, from what the loop asked for. Secret-shaped
 * names are dropped (the loop's websearch key, for one, rides in KernelOptions.env),
 * loop-local state dirs are replaced with sandbox ones, and the tool proxy is always
 * this server's loopback listener, never whatever the loop's own env said.
 */
export function kernelEnvFor(
	requested: Record<string, string> | undefined,
	kernelStateDir: string,
	toolProxyUrl: string,
): { env: Record<string, string>; dropped: string[] } {
	const env: Record<string, string> = {};
	const dropped: string[] = [];
	for (const [name, value] of Object.entries(requested ?? {})) {
		if (REMAPPED_ENV_DIRS.includes(name)) {
			env[name] = join(kernelStateDir, name.toLowerCase());
		} else if (SECRET_ENV_NAME.test(name) && !NONSECRET_ENV.has(name)) {
			dropped.push(name);
		} else {
			env[name] = value;
		}
	}
	delete env.HARNESS_EGRESS_TOKEN;
	env.HARNESS_MCP_PROXY = toolProxyUrl;
	return { env, dropped };
}

/**
 * Names a token without revealing it, so /healthz can say which launch is answering.
 * runtime/daytona/provider.mjs computes the same to tell its own server from an old one.
 */
export function tokenFingerprint(token: string): string {
	return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function toWireError(error: unknown): WireError {
	const name = error instanceof Error ? error.name : "Error";
	const message = error instanceof Error ? error.message : String(error);
	let code: WireErrorCode = "internal";
	if (error instanceof KernelBusyAfterInterruptError) code = "busy_after_interrupt";
	else if (/^Kernel exited/.test(message)) code = "kernel_died";
	else if (/Kernel has been shut down/.test(message)) code = "kernel_shutdown";
	else if (error instanceof RemoteRequestError) code = error.code;
	const progress = cellProgress(error);
	return progress ? { code, name, message, progress } : { code, name, message };
}

export class RemoteRequestError extends Error {
	constructor(
		readonly code: WireErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RemoteRequestError";
	}
}

/** Try to reach the internet; `blocked` only if every target fails. */
export async function probeEgress(
	targets: readonly { host: string; port: number }[],
	timeoutMs: number,
): Promise<ServerPosture["probe"]> {
	const one = async (target: { host: string; port: number }) => {
		const label = `${target.host}:${target.port}`;
		try {
			// A blocked resolver can take far longer than the connect timeout to give up.
			const address = /^[\d.]+$/.test(target.host)
				? target.host
				: (
						await Promise.race([
							lookup(target.host),
							new Promise<never>((_, reject) =>
								setTimeout(
									() => reject(Object.assign(new Error("timeout"), { code: `timeout after ${timeoutMs}ms` })),
									timeoutMs,
								).unref(),
							),
						])
					).address;
			const outcome = await new Promise<string>((resolve) => {
				const socket = netConnect({ host: address, port: target.port });
				const timer = setTimeout(() => {
					socket.destroy();
					resolve(`timeout after ${timeoutMs}ms`);
				}, timeoutMs);
				socket.once("connect", () => {
					clearTimeout(timer);
					socket.destroy();
					resolve("CONNECTED");
				});
				socket.once("error", (err: NodeJS.ErrnoException) => {
					clearTimeout(timer);
					resolve(err.code ?? err.message);
				});
			});
			return { target: label, outcome };
		} catch (error) {
			return { target: label, outcome: `dns: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
		}
	};
	return Promise.all(targets.map(one));
}

interface ServerKernel {
	id: string;
	manager: KernelManager;
	session: ServerSession;
	snapshotKey?: string;
}

interface Waiter<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

/** One logical loop connection; survives its socket for `graceMs`. */
class ServerSession {
	readonly channel: ReliableChannel<ClientMessage, ServerMessage>;
	socket?: WebSocket;
	lastSeen = Date.now();
	graceTimer?: ReturnType<typeof setTimeout>;
	readonly kernels = new Set<string>();
	readonly aborts = new Map<number, AbortController>();
	readonly children = new Map<number, ChildProcess>();
	readonly hostWaiters = new Map<number, Waiter<Record<string, unknown>>>();
	readonly httpWaiters = new Map<number, Waiter<{ status: number; headers: Record<string, string>; body: string }>>();
	disposed = false;

	constructor(
		readonly id: string,
		onMessage: (message: ClientMessage) => void,
		sendAck: (seq: number) => void,
	) {
		this.channel = new ReliableChannel<ClientMessage, ServerMessage>({ onMessage, onAckDue: sendAck });
	}

	sendControl(frame: ControlFrame): void {
		if (this.socket?.readyState === this.socket?.OPEN) this.socket?.send(encodeFrame(frame));
	}
}

export class KernelServer {
	private readonly sessions = new Map<string, ServerSession>();
	private readonly kernels = new Map<string, ServerKernel>();
	private nextReqId = 1;
	private http?: Server;
	private tunnel?: Server;
	private wss?: WebSocketServer;
	private tunnelPort = 0;
	private posture?: ServerPosture;
	private probing?: Promise<ServerPosture>;
	private idleTimer?: ReturnType<typeof setInterval>;
	private probeTimer?: ReturnType<typeof setInterval>;
	private kernelPython?: string;

	constructor(private readonly config: KernelServerConfig) {}

	get port(): number {
		const address = this.http?.address();
		return typeof address === "object" && address ? address.port : this.config.port;
	}

	get toolProxyPort(): number {
		return this.tunnelPort;
	}

	async listen(): Promise<void> {
		mkdirSync(this.config.stateDir, { recursive: true });
		mkdirSync(this.config.defaultCwd, { recursive: true });
		this.tunnel = createServer((req, res) => void this.onTunnelRequest(req, res));
		this.tunnel.requestTimeout = 0;
		this.tunnel.headersTimeout = 60_000;
		await new Promise<void>((resolve) => this.tunnel?.listen(this.config.tunnelPort, "127.0.0.1", resolve));
		const tunnelAddress = this.tunnel.address();
		this.tunnelPort = typeof tunnelAddress === "object" && tunnelAddress ? tunnelAddress.port : 0;
		this.http = createServer((req, res) => void this.onHttp(req, res));
		this.wss = new WebSocketServer({ server: this.http, maxPayload: 256 * 1024 * 1024 });
		this.wss.on("connection", (ws: WebSocket) => this.onConnection(ws));
		await new Promise<void>((resolve) => this.http?.listen(this.config.port, this.config.host, resolve));
		this.idleTimer = setInterval(() => this.reapIdleSockets(), 5000);
		this.idleTimer.unref();
		void this.refreshPosture();
		this.probeTimer = setInterval(() => void this.refreshPosture(), 60_000);
		this.probeTimer.unref();
		this.config.log(
			`listening on ${this.port} (tool proxy 127.0.0.1:${this.tunnelPort}, version ${this.config.version})`,
		);
	}

	async close(): Promise<void> {
		if (this.idleTimer) clearInterval(this.idleTimer);
		if (this.probeTimer) clearInterval(this.probeTimer);
		await Promise.allSettled([...this.sessions.values()].map((s) => this.disposeSession(s, "server closing")));
		for (const client of this.wss?.clients ?? []) client.terminate();
		this.wss?.close();
		this.http?.closeAllConnections();
		this.tunnel?.closeAllConnections();
		await Promise.all(
			[this.http, this.tunnel].map(
				(s) => new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve())),
			),
		);
	}

	/**
	 * The latest egress verdict. Probed at boot and every 60 s in the background, so a
	 * kernel start never waits on a probe's timeout once the first one has finished;
	 * a lock (or unlock) applied later is seen within a minute, or at once via
	 * /healthz?probe=1.
	 */
	private currentPosture(): Promise<ServerPosture> {
		return this.posture ? Promise.resolve(this.posture) : this.refreshPosture();
	}

	private refreshPosture(): Promise<ServerPosture> {
		this.probing ??= probeEgress(this.config.probeTargets, this.config.probeTimeoutMs)
			.then((probe) => {
				const open = probe.some((p) => p.outcome === "CONNECTED");
				this.posture = {
					boundary: this.config.boundary,
					egress: open ? "open" : "blocked",
					egressOverride: open ? this.config.allowOpenEgress : undefined,
					probe,
					serverVersion: this.config.version,
				};
				return this.posture;
			})
			.finally(() => {
				this.probing = undefined;
			});
		return this.probing;
	}

	private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
		if (req.url === "/healthz" || req.url === "/healthz?probe=1") {
			// ?probe=1: re-probe now, e.g. right after the provider locked egress.
			const posture = await (req.url.endsWith("probe=1") ? this.refreshPosture() : this.currentPosture());
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					version: this.config.version,
					tokenId: this.config.token ? tokenFingerprint(this.config.token) : undefined,
					sessions: this.sessions.size,
					kernels: this.kernels.size,
					posture,
				}),
			);
			return;
		}
		res.writeHead(426, { "content-type": "text/plain" });
		res.end("websocket required");
	}

	private onConnection(ws: WebSocket): void {
		let session: ServerSession | undefined;
		ws.on("message", (raw: RawData) => {
			let frame: Frame<ClientMessage>;
			try {
				frame = decodeClientFrame(raw as Buffer);
			} catch (error) {
				this.config.log(`bad frame: ${(error as Error).message}`);
				ws.close(4400, "bad frame");
				return;
			}
			if (!session) {
				session = this.onHello(ws, frame);
				return;
			}
			if (session.socket !== ws) return;
			session.lastSeen = Date.now();
			this.onFrame(session, frame);
		});
		ws.on("close", () => {
			if (session && session.socket === ws) this.onSocketGone(session);
		});
		ws.on("error", () => {});
	}

	private reject(ws: WebSocket, code: "unauthorized" | "version" | "bad_hello", message: string): undefined {
		ws.send(encodeFrame<ServerMessage>({ t: "reject", code, message }));
		ws.close(code === "unauthorized" ? 4401 : 4400, code);
		return undefined;
	}

	private tokenOk(presented: string | undefined): boolean {
		if (!this.config.token) return true;
		if (!presented) return false;
		const a = Buffer.from(presented);
		const b = Buffer.from(this.config.token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	private onHello(ws: WebSocket, frame: Frame<ClientMessage>): ServerSession | undefined {
		if (frame.t !== "hello") return this.reject(ws, "bad_hello", "first frame must be hello");
		if (!this.tokenOk(frame.token)) return this.reject(ws, "unauthorized", "bad token");
		if (frame.v !== PROTOCOL_VERSION) {
			return this.reject(ws, "version", `server speaks v${PROTOCOL_VERSION}, loop sent v${frame.v}`);
		}
		let session = this.sessions.get(frame.session);
		let resumed = true;
		if (session?.channel.isBroken) {
			void this.disposeSession(session, "outbox overflowed while detached");
			session = undefined;
		}
		if (!session) {
			resumed = false;
			session = this.newSession(frame.session);
		}
		if (session.socket && session.socket !== ws) session.socket.close(4409, "replaced by a newer connection");
		if (session.graceTimer) clearTimeout(session.graceTimer);
		session.graceTimer = undefined;
		session.socket = ws;
		session.lastSeen = Date.now();
		const target = session;
		void this.currentPosture().then((posture) => {
			if (target.socket !== ws) return;
			target.sendControl({
				t: "welcome",
				v: PROTOCOL_VERSION,
				session: target.id,
				resumed,
				resume: target.channel.received,
				posture,
			});
			target.channel.attach({ send: (raw) => ws.send(raw) }, resumed ? frame.resume : 0);
		});
		this.config.log(`session ${session.id.slice(0, 8)} ${resumed ? "resumed" : "opened"}`);
		return session;
	}

	private newSession(id: string): ServerSession {
		const session: ServerSession = new ServerSession(
			id,
			(message) => this.onMessage(session, message),
			(seq) => session.sendControl({ t: "ack", seq }),
		);
		this.sessions.set(id, session);
		return session;
	}

	private onFrame(session: ServerSession, frame: Frame<ClientMessage>): void {
		switch (frame.t) {
			case "d":
				try {
					session.channel.receive(frame);
				} catch (error) {
					this.config.log(`session ${session.id.slice(0, 8)}: ${(error as Error).message}`);
					session.socket?.close(4400, "protocol error");
				}
				return;
			case "ping":
				session.channel.acknowledge(frame.ack);
				session.channel.markAcked();
				session.sendControl({ t: "pong", n: frame.n, ack: session.channel.received });
				return;
			case "ack":
				session.channel.acknowledge(frame.seq);
				return;
			case "bye":
				void this.disposeSession(session, "loop said bye");
				session.socket?.close(1000, "bye");
				return;
			default:
				return;
		}
	}

	private onSocketGone(session: ServerSession): void {
		session.socket = undefined;
		session.channel.detach();
		if (session.disposed) return;
		this.config.log(`session ${session.id.slice(0, 8)} detached; grace ${Math.round(this.config.graceMs / 1000)}s`);
		session.graceTimer = setTimeout(
			() => void this.disposeSession(session, "grace window expired"),
			this.config.graceMs,
		);
		session.graceTimer.unref();
	}

	private reapIdleSockets(): void {
		const now = Date.now();
		for (const session of this.sessions.values()) {
			if (session.socket && now - session.lastSeen > this.config.idleSocketMs) {
				this.config.log(
					`session ${session.id.slice(0, 8)} silent for ${now - session.lastSeen}ms; dropping socket`,
				);
				session.socket.terminate();
				this.onSocketGone(session);
			}
		}
	}

	private async disposeSession(session: ServerSession, why: string): Promise<void> {
		if (session.disposed) return;
		session.disposed = true;
		if (session.graceTimer) clearTimeout(session.graceTimer);
		this.sessions.delete(session.id);
		this.config.log(`session ${session.id.slice(0, 8)} disposed: ${why}`);
		for (const ac of session.aborts.values()) ac.abort();
		for (const child of session.children.values()) killTree(child, "SIGKILL");
		const gone = new Error(`loop disconnected (${why})`);
		for (const w of session.hostWaiters.values()) w.reject(gone);
		for (const w of session.httpWaiters.values()) w.reject(gone);
		session.hostWaiters.clear();
		session.httpWaiters.clear();
		await Promise.allSettled([...session.kernels].map((id) => this.disposeKernel(id)));
	}

	private async disposeKernel(id: string): Promise<void> {
		const kernel = this.kernels.get(id);
		if (!kernel) return;
		this.kernels.delete(id);
		kernel.session.kernels.delete(id);
		// dispose() flushes the namespace snapshot first, so an orphaned kernel's
		// state is on disk for whichever loop starts the conversation next.
		await kernel.manager.dispose().catch(() => {});
	}

	private send(session: ServerSession, message: ServerMessage): void {
		if (!session.disposed) session.channel.send(message);
	}

	private reply(session: ServerSession, id: number, fn: () => Promise<unknown>, kernelId?: string): void {
		const started = Date.now();
		const isRunning = () => (kernelId ? (this.kernels.get(kernelId)?.manager.isRunning ?? false) : undefined);
		fn().then(
			(value) =>
				this.send(session, {
					op: "result",
					id,
					ok: true,
					value: value ?? null,
					isRunning: isRunning(),
					serverMs: Date.now() - started,
				}),
			(error) =>
				this.send(session, {
					op: "result",
					id,
					ok: false,
					error: toWireError(error),
					isRunning: isRunning(),
					serverMs: Date.now() - started,
				}),
		);
	}

	private kernelOf(session: ServerSession, id: string): ServerKernel {
		const kernel = this.kernels.get(id);
		if (!kernel || kernel.session !== session) {
			throw new RemoteRequestError("kernel_shutdown", "Kernel has been shut down (remote: no such kernel)");
		}
		return kernel;
	}

	private onMessage(session: ServerSession, message: ClientMessage): void {
		switch (message.op) {
			case "start":
				this.reply(session, message.id, () => this.startKernel(session, message), message.kernel);
				return;
			case "execute":
				this.execute(session, message);
				return;
			case "abort":
				session.aborts.get(message.id)?.abort();
				return;
			case "call":
				this.reply(
					session,
					message.id,
					() => this.callKernel(session, message.kernel, message.method, message.args),
					message.kernel,
				);
				return;
			case "spawn":
				this.spawnChild(session, message);
				return;
			case "signal":
				killTree(session.children.get(message.id), message.signal as NodeJS.Signals);
				return;
			case "skills_have":
				this.reply(session, message.id, async () => ({
					missing: message.hashes.filter((h) => !existsSync(join(this.skillsDir, h, ".complete"))),
					skillsDir: this.skillsDir,
				}));
				return;
			case "skills_put":
				this.reply(session, message.id, () => this.putSkill(message.hash, message.name, message.tgz));
				return;
			case "noop":
				this.reply(session, message.id, async () => null);
				return;
			case "host_response": {
				const waiter = session.hostWaiters.get(message.reqId);
				session.hostWaiters.delete(message.reqId);
				if (!waiter) return;
				if (message.ok) waiter.resolve(message.value);
				else waiter.reject(new Error(message.error));
				return;
			}
			case "http_response": {
				const waiter = session.httpWaiters.get(message.reqId);
				session.httpWaiters.delete(message.reqId);
				waiter?.resolve(message);
				return;
			}
		}
	}

	get skillsDir(): string {
		return this.config.skillsDir;
	}

	private async putSkill(hash: string, name: string, tgz: string): Promise<{ path: string }> {
		if (!/^[a-f0-9]{16,64}$/.test(hash) || !/^[A-Za-z0-9._-]+$/.test(name)) {
			throw new RemoteRequestError("bad_request", `bad skill package id ${hash}/${name}`);
		}
		const dir = join(this.skillsDir, hash);
		if (!existsSync(join(dir, ".complete"))) {
			await rm(dir, { recursive: true, force: true });
			await mkdir(dir, { recursive: true });
			const archive = join(dir, ".package.tgz");
			await writeFile(archive, Buffer.from(tgz, "base64"));
			await runQuiet("tar", ["-xzf", archive, "-C", dir]);
			await rm(archive, { force: true });
			await writeFile(join(dir, ".complete"), "");
		}
		return { path: join(dir, name) };
	}

	private snapshotDirFor(key: string): string {
		return join(this.config.stateDir, "snapshots", key.replace(/[^A-Za-z0-9._-]/g, "_"));
	}

	private async startKernel(
		session: ServerSession,
		message: Extract<ClientMessage, { op: "start" }>,
	): Promise<unknown> {
		const posture = await this.currentPosture();
		if (posture.egress === "open" && !this.config.allowOpenEgress) {
			throw new RemoteRequestError(
				"egress_open",
				`refusing to start a remote kernel: the sandbox can reach the internet (${posture.probe
					.map((p) => `${p.target} ${p.outcome}`)
					.join(", ")}). The sandbox is the kernel's only boundary, so its egress must be locked first.`,
			);
		}
		let kernel = this.kernels.get(message.kernel);
		if (!kernel) {
			const snapshotKey = message.options.snapshot?.key;
			if (snapshotKey) await this.retireSnapshotOwners(snapshotKey, message.kernel);
			kernel = {
				id: message.kernel,
				manager: this.buildManager(session, message.kernel, message.options),
				session,
				snapshotKey,
			};
			this.kernels.set(kernel.id, kernel);
			session.kernels.add(kernel.id);
		}
		const target = kernel;
		await target.manager.start({
			onBootstrapProgress: (text) => this.send(session, { op: "progress", id: message.id, message: text }),
		});
		return { posture };
	}

	/** Two kernels must never race over one snapshot file: finish the old one's final flush first. */
	private async retireSnapshotOwners(key: string, except: string): Promise<void> {
		const owners = [...this.kernels.values()].filter((k) => k.snapshotKey === key && k.id !== except);
		await Promise.allSettled(owners.map((k) => this.disposeKernel(k.id)));
	}

	private buildManager(session: ServerSession, kernelId: string, options: RemoteStartOptions): KernelManager {
		const kernelStateDir = join(this.config.stateDir, "kernels", kernelId);
		mkdirSync(kernelStateDir, { recursive: true });
		const { env, dropped } = kernelEnvFor(
			options.env,
			kernelStateDir,
			`http://127.0.0.1:${this.tunnelPort}/k/${kernelId}`,
		);
		if (dropped.length)
			this.config.log(`kernel ${kernelId.slice(0, 8)}: dropped secret-shaped env ${dropped.join(",")}`);
		adoptHarnessFlags(env);
		const cwd = options.cwd ?? this.config.defaultCwd;
		mkdirSync(cwd, { recursive: true });
		for (const mapping of options.pathMap ?? []) mirrorPath(mapping.local, mapping.remote, this.config.log);
		const snapshotDir = options.snapshot ? this.snapshotDirFor(options.snapshot.key) : undefined;
		if (snapshotDir) mkdirSync(snapshotDir, { recursive: true });
		return new KernelManager({
			cwd,
			env,
			sessionId: options.sessionId,
			username: options.username,
			pythonSkills: options.pythonSkills as KernelPythonSkill[] | undefined,
			hostHandlers: this.hostHandlers(session, kernelId, options.hostHandlerTypes),
			snapshot:
				snapshotDir && options.snapshot
					? {
							path: snapshotPathIn(snapshotDir),
							manifestPath: manifestPathIn(snapshotDir),
							maxBytes: options.snapshot.maxBytes,
							debounceMs: options.snapshot.debounceMs,
						}
					: undefined,
		});
	}

	private hostHandlers(session: ServerSession, kernelId: string, types: string[]): HostRequestHandlers {
		const handlers: HostRequestHandlers = {};
		for (const type of types) {
			handlers[type] = (payload) =>
				new Promise((resolve, reject) => {
					if (session.disposed) {
						reject(new Error("loop disconnected"));
						return;
					}
					const reqId = this.nextReqId++;
					session.hostWaiters.set(reqId, { resolve, reject });
					this.send(session, { op: "host_request", reqId, kernel: kernelId, payload });
				});
		}
		return handlers;
	}

	private execute(session: ServerSession, message: Extract<ClientMessage, { op: "execute" }>): void {
		const ac = new AbortController();
		session.aborts.set(message.id, ac);
		this.reply(
			session,
			message.id,
			async () => {
				try {
					return await this.kernelOf(session, message.kernel).manager.execute(message.code, {
						signal: ac.signal,
						maxOutputChars: message.maxOutputChars,
						internal: message.internal,
						onStream: (chunk, name) => this.send(session, { op: "stream", id: message.id, chunk, name }),
						onLateSentAgentMessage: message.wantLate
							? (late) => this.send(session, { op: "late", id: message.id, message: late })
							: undefined,
					});
				} finally {
					session.aborts.delete(message.id);
				}
			},
			message.kernel,
		);
	}

	private async callKernel(
		session: ServerSession,
		kernelId: string,
		method: KernelMethod,
		args?: { snapshot?: boolean },
	): Promise<unknown> {
		if (method === "dispose") {
			if (this.kernels.get(kernelId)?.session === session) await this.disposeKernel(kernelId);
			return null;
		}
		const kernel = this.kernels.get(kernelId);
		if (method === "snapshotExists") {
			const key = kernel?.snapshotKey;
			return key ? existsSync(snapshotPathIn(this.snapshotDirFor(key))) : false;
		}
		const k = this.kernelOf(session, kernelId).manager;
		switch (method) {
			case "restart":
				return k.restart();
			case "shutdown":
				return k.shutdown(args ?? {});
			case "kill": {
				await k.kill();
				this.kernels.delete(kernelId);
				session.kernels.delete(kernelId);
				return null;
			}
			case "snapshotState":
				return k.snapshotState();
			case "restoreState":
				return k.restoreState();
			case "listNamespaceNames":
				return k.listNamespaceNames();
		}
	}

	private async resolveBin(bin: string): Promise<string> {
		switch (bin) {
			case "python": {
				this.kernelPython ??=
					process.env.PRIME_AGENT_KERNEL_PYTHON ??
					[join(getKernelVenvDir(), "bin", "python"), "/usr/bin/python3"].find((p) => existsSync(p)) ??
					"python3";
				return this.kernelPython;
			}
			case "rg":
			case "fd":
				// prime's own resolution (PATH, then its managed bin dir); prebake fetched them.
				return (await ensureTool(bin, true)) ?? (bin === "fd" ? await which("fdfind") : undefined) ?? bin;
			case "bash":
				return "/bin/bash";
			default:
				throw new RemoteRequestError("bad_request", `the sandbox does not run '${bin}' for tools`);
		}
	}

	private spawnChild(session: ServerSession, message: Extract<ClientMessage, { op: "spawn" }>): void {
		this.reply(session, message.id, async () => {
			const bin = await this.resolveBin(message.bin);
			const env: Record<string, string> = { ...childBaseEnv() };
			for (const [name, value] of Object.entries(message.env ?? {})) {
				if (name.startsWith("HARNESS_TOOL_SANDBOX_")) env[name] = value;
			}
			const cwd = message.cwd && existsSync(message.cwd) ? message.cwd : this.config.defaultCwd;
			// Its own process group, so a kill reaches whatever a bash command started too.
			const child = spawn(bin, message.args, {
				cwd,
				env,
				detached: true,
				stdio: [message.stdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
			session.children.set(message.id, child);
			child.stdout?.on("data", (d: Buffer) =>
				this.send(session, { op: "spawn_data", id: message.id, fd: 1, data: d.toString("base64") }),
			);
			child.stderr?.on("data", (d: Buffer) =>
				this.send(session, { op: "spawn_data", id: message.id, fd: 2, data: d.toString("base64") }),
			);
			if (message.stdin && child.stdin) child.stdin.end(Buffer.from(message.stdin, "base64"));
			return new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
				child.once("error", (error) => {
					session.children.delete(message.id);
					reject(error);
				});
				child.once("close", (code, signal) => {
					session.children.delete(message.id);
					resolve({ code, signal });
				});
			});
		});
	}

	private async onTunnelRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const match = /^\/k\/([^/]+)(\/.*)?$/.exec(req.url ?? "");
		const kernel = match ? this.kernels.get(match[1]) : undefined;
		if (!match || !kernel || kernel.session.disposed) {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: "no such kernel on this tool proxy" }));
			return;
		}
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const headers: Record<string, string> = {};
		for (const [name, value] of Object.entries(req.headers)) {
			if (typeof value === "string" && name !== "x-egress-token" && name !== "host" && name !== "content-length") {
				headers[name] = value;
			}
		}
		const session = kernel.session;
		const reqId = this.nextReqId++;
		const timer = setTimeout(() => {
			session.httpWaiters.get(reqId)?.reject(new Error(`no answer from the loop in ${this.config.toolTimeoutMs}ms`));
			session.httpWaiters.delete(reqId);
		}, this.config.toolTimeoutMs);
		timer.unref();
		res.on("close", () => {
			if (!res.writableFinished && session.httpWaiters.delete(reqId)) {
				this.send(session, { op: "http_cancel", reqId });
			}
		});
		try {
			const answer = await new Promise<{ status: number; headers: Record<string, string>; body: string }>(
				(resolve, reject) => {
					session.httpWaiters.set(reqId, { resolve, reject });
					this.send(session, {
						op: "http_request",
						reqId,
						kernel: kernel.id,
						method: req.method ?? "GET",
						path: match[2] ?? "/",
						headers,
						body: Buffer.concat(chunks).toString("base64"),
					});
				},
			);
			res.writeHead(answer.status, answer.headers);
			res.end(Buffer.from(answer.body, "base64"));
		} catch (error) {
			if (res.headersSent || res.destroyed) return;
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: false, error: `tool proxy tunnel: ${(error as Error).message}` }));
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Flags this server itself enforces; a loop cannot turn them. */
const SERVER_OWNED = new Set([
	"HARNESS_KERNEL_SANDBOX",
	"HARNESS_KERNEL_ENV_ALLOW",
	"HARNESS_MCP_PROXY",
	"HARNESS_EGRESS_TOKEN",
]);

/**
 * Some harness flags are read by KernelManager itself (HARNESS_DISPLAY_IMAGES, the boot
 * timeouts), in this process, not the kernel's. One server serves one conversation, so
 * adopting the loop's flags process-wide is the same thing a local kernel's loop would
 * have had in its own env.
 */
export function adoptHarnessFlags(env: Record<string, string>, target: NodeJS.ProcessEnv = process.env): string[] {
	const adopted: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (!name.startsWith("HARNESS_") || SERVER_OWNED.has(name)) continue;
		target[name] = value;
		adopted.push(name);
	}
	return adopted;
}

/**
 * Make a loop-side path resolve inside the sandbox too, by symlinking it to where the
 * files really are. Cells sometimes use the absolute path the system prompt showed
 * them; with the mirror in place that path works here as well. Best effort: a path
 * whose parent cannot be created (no sudo) is left unmapped, and the file tools still
 * translate it on the loop side.
 */
export function mirrorPath(local: string, remote: string, log: (line: string) => void): void {
	if (!local.startsWith("/") || local === remote || existsSync(local)) return;
	try {
		mkdirSync(dirname(local), { recursive: true });
		symlinkSync(remote, local);
		return;
	} catch {
		// fall through to sudo
	}
	const user = process.env.USER ?? basename(homedir());
	const sudo = spawn(
		"sudo",
		[
			"-n",
			"sh",
			"-c",
			'mkdir -p "$1" && chown "$3" "$1" && ln -s "$2" "$4"',
			"_",
			dirname(local),
			remote,
			user,
			local,
		],
		{ stdio: "ignore" },
	);
	sudo.on("error", () => log(`could not mirror ${local} -> ${remote}`));
}

function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
	if (!child?.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function runQuiet(bin: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr?.on("data", (d: Buffer) => {
			err += d.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.trim()}`))));
	});
}

async function which(name: string): Promise<string | undefined> {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	return undefined;
}

export function newSessionId(): string {
	return randomUUID();
}
