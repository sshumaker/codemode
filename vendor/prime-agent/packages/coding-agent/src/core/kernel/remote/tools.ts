/**
 * The process-wide remote runtime: one shared link, the path map, the tool-proxy
 * tunnel, and the remote child process the file tools run through.
 *
 * Everything that crosses into the sandbox from this process goes through the one
 * link built here, so the kernel, read/grep/find/ls/write/edit/bash, and tunnelled
 * tool calls share a single WebSocket (and a single reconnect story).
 */
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { PassThrough, type Readable } from "node:stream";
import type { KernelManagerOptions } from "../index.js";
import { isRemoteKernelEnabled, type RemoteKernelConfig, remoteKernelConfigFromEnv } from "./config.js";
import { RemoteKernelLink } from "./link.js";
import { dispatchHostRequest, RemoteKernelManager } from "./manager.js";
import { RemotePathMap } from "./pathmap.js";
import type { PathMapping, ServerMessage } from "./protocol.js";

export interface RemoteRuntime {
	config: RemoteKernelConfig;
	link: RemoteKernelLink;
	pathMap(): RemotePathMap;
}

let runtime: RemoteRuntime | undefined;
let localCwd: string | undefined;

export function remoteToolsActive(): boolean {
	return isRemoteKernelEnabled();
}

/** The loop's cwd, which maps to the kernel's cwd in the sandbox. First caller wins. */
export function registerRemoteLocalCwd(cwd: string): void {
	localCwd ??= cwd;
}

function mappings(config: RemoteKernelConfig): PathMapping[] {
	const cwdMapping: PathMapping[] = localCwd ? [{ local: localCwd, remote: config.remoteCwd ?? localCwd }] : [];
	return [...cwdMapping, ...config.pathMap];
}

export function remoteRuntime(): RemoteRuntime {
	if (runtime) return runtime;
	const config = remoteKernelConfigFromEnv();
	const link = new RemoteKernelLink({
		connection: config.connection,
		graceMs: config.graceMs,
		pingIntervalMs: config.pingIntervalMs,
		deadAfterMs: config.deadAfterMs,
		log: process.env.HARNESS_REMOTE_KERNEL_DEBUG === "1" ? (line) => process.stderr.write(`${line}\n`) : undefined,
	});
	link.handlers.hostRequest = dispatchHostRequest;
	link.handlers.httpRequest = (message, signal) => forwardToolCall(config, message, signal);
	installExitHooks(link);
	runtime = { config, link, pathMap: () => new RemotePathMap(mappings(config)) };
	return runtime;
}

/** Replace the process runtime (tests drive several servers from one process). */
export function setRemoteRuntimeForTest(next: RemoteRuntime | undefined, cwd?: string): void {
	runtime = next;
	localCwd = cwd;
}

let exitHooksInstalled = false;

function installExitHooks(link: RemoteKernelLink): void {
	if (exitHooksInstalled) return;
	exitHooksInstalled = true;
	// With `bye` the server disposes this process's kernels now, flushing their
	// namespace snapshots; without it they would sit out the grace window first.
	const leave = (code: number) => {
		void link.close({ bye: true }).finally(() => process.exit(code));
	};
	process.once("SIGTERM", () => leave(143));
	process.once("SIGINT", () => leave(130));
	process.once("exit", () => link.closeSync());
}

export interface RemoteKernelManagerInit extends KernelManagerOptions {
	localCwd: string;
	snapshotKey?: string;
}

export function createRemoteKernelManager(init: RemoteKernelManagerInit): RemoteKernelManager {
	registerRemoteLocalCwd(init.localCwd);
	const rt = remoteRuntime();
	return new RemoteKernelManager({
		...init,
		link: rt.link,
		remoteCwd: rt.config.remoteCwd,
		pathMap: rt.pathMap(),
		snapshotKey: init.snapshotKey,
	});
}

/** The cwd cells run in, as the file tools and guards should see it. */
export function remoteKernelCwd(): string | undefined {
	return isRemoteKernelEnabled() ? (remoteKernelConfigFromEnv().remoteCwd ?? localCwd) : undefined;
}

/** Forward one tunnelled tool-proxy request to the real proxy, adding the egress token here. */
export function forwardToolCall(
	config: Pick<RemoteKernelConfig, "toolProxy" | "egressToken" | "toolTimeoutMs">,
	message: Extract<ServerMessage, { op: "http_request" }>,
	signal: AbortSignal,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
	if (!config.toolProxy) return Promise.reject(new Error("no HARNESS_MCP_PROXY on the loop"));
	const base = new URL(config.toolProxy);
	const target = new URL(base.pathname.replace(/\/$/, "") + message.path, base);
	const headers: Record<string, string> = { ...message.headers };
	delete headers["x-egress-token"];
	if (config.egressToken) headers["x-egress-token"] = config.egressToken;
	const body = Buffer.from(message.body, "base64");
	if (body.length > 0) headers["content-length"] = String(body.length);
	const send = target.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolve, reject) => {
		// No socket timeout: a call legitimately blocks while a human decides. The
		// deadline is ours, and generous (HARNESS_REMOTE_TOOL_TIMEOUT_MS).
		const req = send(target, { method: message.method, headers, timeout: 0 }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => {
				clearTimeout(deadline);
				const out: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (typeof v === "string" && k !== "transfer-encoding" && k !== "connection" && k !== "content-length")
						out[k] = v;
				}
				resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks).toString("base64") });
			});
			res.on("error", reject);
		});
		const deadline = setTimeout(
			() => req.destroy(new Error(`no answer in ${config.toolTimeoutMs}ms`)),
			config.toolTimeoutMs,
		);
		deadline.unref();
		signal.addEventListener("abort", () => req.destroy(new Error("cancelled by the kernel")), { once: true });
		req.on("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		req.end(body);
	});
}

/** What the file tools need from a child process; ChildProcess and RemoteToolChild both satisfy it. */
export interface ToolChild {
	readonly stdout: Readable;
	readonly stderr: Readable;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals | number): boolean;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface RemoteSpawnOptions {
	env?: Record<string, string>;
	cwd?: string;
	stdin?: Buffer;
	/** Rewrite sandbox paths in stdout back to loop paths, line by line (rg, fd). */
	mapOutput?: boolean;
}

/** A child process running in the sandbox, driven over the shared link. */
export class RemoteToolChild extends EventEmitter implements ToolChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	killed = false;
	private id?: number;
	private pendingSignal?: string;
	private partial = "";

	constructor(
		private readonly link: RemoteKernelLink,
		private readonly pathMap: RemotePathMap,
		bin: string,
		args: string[],
		options: RemoteSpawnOptions,
	) {
		super();
		void this.run(bin, args, options);
	}

	private async run(bin: string, args: string[], options: RemoteSpawnOptions): Promise<void> {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(options.env ?? {}))
			env[k] = k.endsWith("_PATH") ? this.pathMap.toRemote(v) : v;
		try {
			const call = await this.link.start<{ code: number | null; signal: NodeJS.Signals | null }>(
				(id) => ({
					op: "spawn",
					id,
					bin,
					args: this.pathMap.argsToRemote(args),
					env,
					cwd: options.cwd ? this.pathMap.toRemote(options.cwd) : undefined,
					stdin: options.stdin?.toString("base64"),
				}),
				{ onSpawnData: (fd, data) => this.onData(fd, data, options.mapOutput === true) },
			);
			this.id = call.id;
			if (this.pendingSignal) this.link.post({ op: "signal", id: call.id, signal: this.pendingSignal });
			const exit = await call.done;
			this.flush(options.mapOutput === true);
			this.stdout.end();
			this.stderr.end();
			// Like ChildProcess: "close" only after the output has been read out, or a
			// reader (readline in grep/find) would see the exit before its last lines.
			await Promise.all([this.stdout, this.stderr].map(drained));
			this.emit("close", exit.code, exit.signal);
		} catch (error) {
			this.stdout.end();
			this.stderr.end();
			this.emit("error", error instanceof Error ? error : new Error(String(error)));
		}
	}

	private onData(fd: 1 | 2, data: Buffer, mapOutput: boolean): void {
		if (fd === 2) {
			this.stderr.write(data);
			return;
		}
		if (!mapOutput) {
			this.stdout.write(data);
			return;
		}
		const text = this.partial + data.toString("utf8");
		const cut = text.lastIndexOf("\n");
		if (cut < 0) {
			this.partial = text;
			return;
		}
		this.partial = text.slice(cut + 1);
		const lines = text
			.slice(0, cut)
			.split("\n")
			.map((l) => this.pathMap.lineToLocal(l));
		this.stdout.write(`${lines.join("\n")}\n`);
	}

	private flush(mapOutput: boolean): void {
		if (mapOutput && this.partial) this.stdout.write(this.pathMap.lineToLocal(this.partial));
		this.partial = "";
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		this.killed = true;
		const name = typeof signal === "number" ? "SIGTERM" : signal;
		if (this.id === undefined) this.pendingSignal = name;
		else this.link.post({ op: "signal", id: this.id, signal: name });
		return true;
	}
}

function drained(stream: Readable): Promise<void> {
	return new Promise((resolve) => {
		if (stream.readableEnded) {
			resolve();
			return;
		}
		// A stream nobody reads never ends; don't hold the exit on it.
		const timer = setTimeout(resolve, 2000);
		stream.once("end", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

/** Run `bin` (a bare tool name: rg, fd, python, bash) in the sandbox. */
export function remoteToolChild(bin: string, args: string[], options: RemoteSpawnOptions = {}): RemoteToolChild {
	const rt = remoteRuntime();
	return new RemoteToolChild(rt.link, rt.pathMap(), bin, args, options);
}
