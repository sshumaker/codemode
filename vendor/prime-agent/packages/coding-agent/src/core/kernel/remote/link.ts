/**
 * The loop's end of the remote kernel: one WebSocket to the kernel server, shared by
 * every RemoteKernelManager and every remote file tool in this process.
 *
 * Owns the connection state machine and nothing above it:
 *
 *   idle ──ensureOpen()──► connecting ──welcome──► open
 *                              ▲                    │ socket closed / silent past deadAfterMs
 *                              │                    ▼
 *                              └──── backoff ◄── reconnecting ──graceMs elapsed──► lost
 *
 * While reconnecting, requests stay pending and new ones queue in the channel: the
 * server keeps the session (and its kernels, mid-cell or not) for its own grace
 * window, and on reattach both sides replay what the other has not acknowledged, so
 * a dropped socket costs latency, not state. A session is *lost* only when the
 * reconnect window runs out or the server answers the resume with `resumed: false`
 * (it restarted, or its grace expired first). Then every pending request fails with
 * "Kernel exited: ..." — the wording ipython.ts's auto-restart path recognises — and
 * the next request starts a fresh session.
 *
 * Not responsible for: kernel semantics (manager.ts), tool routing (tools.ts), or
 * what a host request / tool call does (the handlers registered here).
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { ReliableChannel } from "./channel.js";
import type { RemoteKernelConnection } from "./config.js";
import {
	type ClientMessage,
	type ControlFrame,
	decodeServerFrame,
	encodeFrame,
	type Frame,
	PROTOCOL_VERSION,
	type ServerMessage,
	type ServerPosture,
	type WireError,
} from "./protocol.js";

export type LinkState = "idle" | "connecting" | "open" | "reconnecting" | "lost" | "closed";

/** What a result's `value` resolves to, keyed by the request that produced it. */
export interface PendingHooks {
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLate?: (message: Extract<ServerMessage, { op: "late" }>["message"]) => void;
	onProgress?: (message: string) => void;
	onSpawnData?: (fd: 1 | 2, data: Buffer) => void;
	onResult?: (running: boolean | undefined) => void;
}

interface Pending extends PendingHooks {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export interface LinkHandlers {
	hostRequest?: (kernel: string, payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
	httpRequest?: (
		message: Extract<ServerMessage, { op: "http_request" }>,
		signal: AbortSignal,
	) => Promise<{ status: number; headers: Record<string, string>; body: string }>;
}

export interface RemoteKernelLinkOptions {
	connection: () => RemoteKernelConnection;
	graceMs?: number;
	pingIntervalMs?: number;
	deadAfterMs?: number;
	connectTimeoutMs?: number;
	/** Replaces the ws client, for tests that need to cut or stall the socket. */
	socketFactory?: (url: string, headers: Record<string, string>) => WebSocket;
	log?: (line: string) => void;
}

/** A remote call failed; `code` says how, `message` keeps the wording prime matches on. */
export class RemoteKernelError extends Error {
	constructor(
		readonly code: WireError["code"],
		message: string,
		name = "RemoteKernelError",
	) {
		super(message);
		this.name = name;
	}
}

const BACKOFF_MS = [100, 250, 500, 1000, 2000, 4000, 5000];

export class RemoteKernelLink {
	private readonly options: Required<Omit<RemoteKernelLinkOptions, "socketFactory" | "log">> &
		Pick<RemoteKernelLinkOptions, "socketFactory" | "log">;
	private sessionId = randomUUID();
	private channel: ReliableChannel<ServerMessage, ClientMessage>;
	private ws?: WebSocket;
	private _state: LinkState = "idle";
	private openWaiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly httpAborts = new Map<number, AbortController>();
	private readonly listeners = new Set<(reason: string) => void>();
	private heartbeat?: ReturnType<typeof setInterval>;
	private lastHeard = 0;
	private pingN = 0;
	private droppedAt = 0;
	private attempt = 0;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private everOpened = false;
	/** Kernels (and other long-lived users) that want the session kept alive. */
	private holders = 0;
	handlers: LinkHandlers = {};
	posture?: ServerPosture;
	/** Wall time of the most recent successful resume, for measurement. */
	lastReattachMs?: number;
	reconnects = 0;

	constructor(options: RemoteKernelLinkOptions) {
		this.options = {
			graceMs: 4 * 60_000,
			pingIntervalMs: 10_000,
			deadAfterMs: 30_000,
			connectTimeoutMs: 20_000,
			...options,
		};
		this.channel = this.newChannel();
	}

	get state(): LinkState {
		return this._state;
	}

	get session(): string {
		return this.sessionId;
	}

	/** Called with a reason whenever the session is lost; kernels mark themselves dead. */
	onSessionLost(listener: (reason: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** A kernel is alive on the server: keep reconnecting through drops while held. */
	hold(): () => void {
		this.holders++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.holders--;
		};
	}

	private newChannel(): ReliableChannel<ServerMessage, ClientMessage> {
		return new ReliableChannel<ServerMessage, ClientMessage>({
			onMessage: (m) => this.onMessage(m),
			onAckDue: (seq) => this.sendControl({ t: "ack", seq }),
		});
	}

	private log(line: string): void {
		this.options.log?.(`[remote-kernel] ${line}`);
	}

	private sendControl(frame: ControlFrame): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeFrame(frame));
	}

	/** Resolves once a session is attached; starts connecting if nothing is. */
	ensureOpen(): Promise<void> {
		if (this._state === "closed")
			return Promise.reject(new RemoteKernelError("session_lost", "remote kernel link is closed"));
		if (this._state === "open") return Promise.resolve();
		const waiter = new Promise<void>((resolve, reject) => this.openWaiters.push({ resolve, reject }));
		if (this._state === "idle" || this._state === "lost") {
			this._state = "connecting";
			this.attempt = 0;
			this.connectOnce();
		}
		return waiter;
	}

	private connectOnce(): void {
		let connection: RemoteKernelConnection;
		try {
			connection = this.options.connection();
		} catch (error) {
			this.onConnectFailed(error as Error);
			return;
		}
		const headers = connection.headers ?? {};
		const ws = this.options.socketFactory
			? this.options.socketFactory(connection.url, headers)
			: new WebSocket(connection.url, {
					headers,
					maxPayload: 256 * 1024 * 1024,
					handshakeTimeout: this.options.connectTimeoutMs,
				});
		this.ws = ws;
		const started = Date.now();
		let welcomed = false;
		const welcomeTimer = setTimeout(() => {
			if (!welcomed) ws.terminate();
		}, this.options.connectTimeoutMs);
		welcomeTimer.unref();
		ws.on("open", () => {
			ws.send(
				encodeFrame<ClientMessage>({
					t: "hello",
					v: PROTOCOL_VERSION,
					token: connection.token,
					session: this.sessionId,
					resume: this.channel.received,
				}),
			);
		});
		ws.on("message", (raw) => {
			let frame: Frame<ServerMessage>;
			try {
				frame = decodeServerFrame(raw as Buffer);
			} catch (error) {
				this.log(`bad frame from server: ${(error as Error).message}`);
				ws.terminate();
				return;
			}
			this.lastHeard = Date.now();
			if (!welcomed) {
				if (frame.t === "welcome") {
					welcomed = true;
					clearTimeout(welcomeTimer);
					this.onWelcome(ws, frame, Date.now() - started);
				} else if (frame.t === "reject") {
					clearTimeout(welcomeTimer);
					this.fail(
						new RemoteKernelError(
							"session_lost",
							`Kernel exited: remote kernel server refused the connection (${frame.code}: ${frame.message})`,
						),
					);
					ws.close();
				}
				return;
			}
			this.onFrame(frame);
		});
		ws.on("close", (code, reason) => {
			clearTimeout(welcomeTimer);
			if (this.ws !== ws) return;
			this.ws = undefined;
			if (welcomed) this.onDropped(`${code} ${reason.toString()}`.trim());
			else this.onConnectFailed(new Error(`socket closed before welcome (${code} ${reason.toString()})`.trim()));
		});
		ws.on("error", (error) => {
			if (!welcomed && this.ws === ws) this.log(`connect error: ${error.message}`);
		});
	}

	private onWelcome(ws: WebSocket, frame: Extract<ControlFrame, { t: "welcome" }>, elapsedMs: number): void {
		this.posture = frame.posture;
		const wasResuming = this._state === "reconnecting";
		if (!frame.resumed && this.everOpened) {
			// The server has no memory of us: whatever it was running for this session is gone.
			this.loseSession("the sandbox side no longer has this session (server restarted or its grace window expired)");
			this.channel = this.newChannel();
		}
		this.channel.attach({ send: (raw) => ws.send(raw) }, frame.resumed ? frame.resume : 0);
		this._state = "open";
		this.everOpened = true;
		this.attempt = 0;
		if (wasResuming) {
			this.reconnects++;
			this.lastReattachMs = Date.now() - this.droppedAt;
			this.log(`reattached after ${this.lastReattachMs}ms (${frame.resumed ? "session resumed" : "new session"})`);
		} else {
			this.log(`connected in ${elapsedMs}ms; boundary ${frame.posture.boundary}, egress ${frame.posture.egress}`);
		}
		this.startHeartbeat();
		const waiters = this.openWaiters.splice(0);
		for (const w of waiters) w.resolve();
	}

	private onConnectFailed(error: Error): void {
		if (this._state === "closed") return;
		if (this._state === "reconnecting" && Date.now() - this.droppedAt < this.options.graceMs) {
			this.scheduleRetry();
			return;
		}
		if (this._state === "connecting" && this.attempt < 2) {
			this.attempt++;
			this.scheduleRetry();
			return;
		}
		const lost = this._state === "reconnecting";
		this._state = lost ? "lost" : "idle";
		// A fresh identity for the next attempt: if the server still holds the old
		// session, it must expire there (flushing its kernels' snapshots) rather than
		// be resumed into kernels this side has already declared dead.
		if (lost) this.sessionId = randomUUID();
		const reason = lost
			? `connection lost and not re-established within ${Math.round(this.options.graceMs / 1000)}s (${error.message})`
			: `sandbox unreachable (${error.message})`;
		if (lost) this.loseSession(reason);
		this.fail(new RemoteKernelError("session_lost", `Kernel exited: remote ${reason}`));
	}

	private scheduleRetry(): void {
		const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
		this.attempt++;
		// Not unref'd: a request waiting on this reconnect must keep the process alive,
		// or a print-mode loop with nothing else to do exits with the call unsettled.
		this.retryTimer = setTimeout(() => this.connectOnce(), delay);
	}

	private onDropped(why: string): void {
		this.stopHeartbeat();
		this.channel.detach();
		if (this._state === "closed") return;
		const needed = this.holders > 0 || this.pending.size > 0 || this.channel.unacked > 0;
		if (!needed) {
			// Nothing on the server depends on this session; reconnect lazily next time.
			this._state = "idle";
			return;
		}
		this.log(`socket dropped (${why}); reconnecting for up to ${Math.round(this.options.graceMs / 1000)}s`);
		this._state = "reconnecting";
		this.droppedAt = Date.now();
		this.attempt = 0;
		this.scheduleRetry();
	}

	private loseSession(reason: string): void {
		const error = new RemoteKernelError("session_lost", `Kernel exited: remote ${reason}`);
		const pending = [...this.pending.values()];
		this.pending.clear();
		for (const p of pending) p.reject(error);
		for (const ac of this.httpAborts.values()) ac.abort();
		this.httpAborts.clear();
		for (const listener of this.listeners) listener(reason);
	}

	private fail(error: Error): void {
		const waiters = this.openWaiters.splice(0);
		for (const w of waiters) w.reject(error);
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		this.lastHeard = Date.now();
		this.heartbeat = setInterval(() => {
			if (Date.now() - this.lastHeard > this.options.deadAfterMs) {
				this.log(`no traffic for ${Date.now() - this.lastHeard}ms; presuming the socket dead`);
				this.ws?.terminate();
				return;
			}
			this.sendControl({ t: "ping", n: ++this.pingN, ack: this.channel.received });
			this.channel.markAcked();
		}, this.options.pingIntervalMs);
		this.heartbeat.unref();
	}

	private stopHeartbeat(): void {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = undefined;
	}

	private onFrame(frame: Frame<ServerMessage>): void {
		switch (frame.t) {
			case "d":
				try {
					this.channel.receive(frame);
				} catch (error) {
					this.log((error as Error).message);
					this.ws?.terminate();
				}
				return;
			case "pong":
			case "ping":
				this.channel.acknowledge(frame.ack);
				return;
			case "ack":
				this.channel.acknowledge(frame.seq);
				return;
			default:
				return;
		}
	}

	private onMessage(message: ServerMessage): void {
		switch (message.op) {
			case "result": {
				const p = this.pending.get(message.id);
				if (!p) return;
				this.pending.delete(message.id);
				p.onResult?.(message.isRunning);
				if (message.ok) p.resolve(message.value);
				else p.reject(new RemoteKernelError(message.error.code, message.error.message, message.error.name));
				return;
			}
			case "stream":
				this.pending.get(message.id)?.onStream?.(message.chunk, message.name);
				return;
			case "late":
				this.pending.get(message.id)?.onLate?.(message.message);
				return;
			case "progress":
				this.pending.get(message.id)?.onProgress?.(message.message);
				return;
			case "spawn_data":
				this.pending.get(message.id)?.onSpawnData?.(message.fd, Buffer.from(message.data, "base64"));
				return;
			case "host_request":
				void this.answerHostRequest(message);
				return;
			case "http_request":
				void this.answerHttpRequest(message);
				return;
			case "http_cancel":
				this.httpAborts.get(message.reqId)?.abort();
				this.httpAborts.delete(message.reqId);
				return;
		}
	}

	private async answerHostRequest(message: Extract<ServerMessage, { op: "host_request" }>): Promise<void> {
		let reply: ClientMessage;
		try {
			if (!this.handlers.hostRequest) throw new Error("no host request handler on this loop");
			reply = {
				op: "host_response",
				reqId: message.reqId,
				ok: true,
				value: await this.handlers.hostRequest(message.kernel, message.payload),
			};
		} catch (error) {
			reply = {
				op: "host_response",
				reqId: message.reqId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		this.post(reply);
	}

	private async answerHttpRequest(message: Extract<ServerMessage, { op: "http_request" }>): Promise<void> {
		const ac = new AbortController();
		this.httpAborts.set(message.reqId, ac);
		let answer: { status: number; headers: Record<string, string>; body: string };
		try {
			if (!this.handlers.httpRequest) throw new Error("this loop has no tool proxy configured");
			answer = await this.handlers.httpRequest(message, ac.signal);
		} catch (error) {
			const text = JSON.stringify({
				ok: false,
				error: `tool proxy: ${error instanceof Error ? error.message : String(error)}`,
			});
			answer = {
				status: 502,
				headers: { "content-type": "application/json" },
				body: Buffer.from(text).toString("base64"),
			};
		} finally {
			this.httpAborts.delete(message.reqId);
		}
		if (ac.signal.aborted) return;
		this.post({ op: "http_response", reqId: message.reqId, ...answer });
	}

	/** Fire-and-forget message; buffered through drops like everything else. */
	post(message: ClientMessage): void {
		if (this._state === "closed") return;
		this.channel.send(message);
	}

	/** Send a request and resolve with its result's value. */
	async request<T>(build: (id: number) => ClientMessage, hooks: PendingHooks = {}): Promise<T> {
		await this.ensureOpen();
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { ...hooks, resolve: (v) => resolve(v as T), reject });
			this.channel.send(build(id));
		});
	}

	/** Allocate an id and send, returning the id so the caller can address the request later. */
	async start<T>(
		build: (id: number) => ClientMessage,
		hooks: PendingHooks = {},
	): Promise<{ id: number; done: Promise<T> }> {
		await this.ensureOpen();
		const id = this.nextId++;
		const done = new Promise<T>((resolve, reject) => {
			this.pending.set(id, { ...hooks, resolve: (v) => resolve(v as T), reject });
		});
		this.channel.send(build(id));
		return { id, done };
	}

	/** Round trip of one heartbeat-free request through the whole stack. */
	async ping(): Promise<number> {
		const t0 = performance.now();
		await this.request<null>((id) => ({ op: "noop", id }));
		return performance.now() - t0;
	}

	/** Test hook: cut the socket as a network failure would, without telling the server. */
	dropSocketForTest(): void {
		this.ws?.terminate();
	}

	/**
	 * Close for good. With `bye`, the server disposes this session's kernels now
	 * (flushing their namespace snapshots) instead of waiting out its grace window.
	 */
	async close(opts: { bye?: boolean } = {}): Promise<void> {
		if (this._state === "closed") return;
		const ws = this.ws;
		// Closed first, so the socket's own close event is not taken for a drop.
		this._state = "closed";
		if (opts.bye && ws?.readyState === WebSocket.OPEN) {
			ws.send(encodeFrame<ClientMessage>({ t: "bye" }));
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 3000);
				timer.unref();
				ws.once("close", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		this.stopHeartbeat();
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.loseSession("link closed");
		this.fail(new RemoteKernelError("session_lost", "remote kernel link is closed"));
		this.ws?.close();
		this.ws = undefined;
	}

	/** Synchronous best effort, for process exit. */
	closeSync(): void {
		this._state = "closed";
		this.stopHeartbeat();
		this.ws?.terminate();
	}
}
