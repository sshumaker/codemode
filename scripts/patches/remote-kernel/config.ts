/**
 * Loop-side configuration of the remote kernel, read from the environment the
 * gateway (or any launcher) starts prime with. runtime/daytona/provider.mjs
 * produces exactly these variables from `ensure()`.
 *
 *   HARNESS_REMOTE_KERNEL_URL           ws(s):// (or http(s)://) of the kernel server
 *   HARNESS_REMOTE_KERNEL_TOKEN         the server's shared secret (hello frame)
 *   HARNESS_REMOTE_KERNEL_HEADERS       JSON object of extra upgrade headers
 *   HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN shorthand for {"x-daytona-preview-token": ...}
 *   HARNESS_REMOTE_KERNEL_CONNECT_FILE  JSON {url, token, headers}; re-read on every
 *                                       (re)connect and wins over the three above, so
 *                                       a restarted sandbox's new preview token reaches
 *                                       a running loop without restarting it
 *   HARNESS_REMOTE_KERNEL_CWD           the kernel's working directory in the sandbox
 *   HARNESS_REMOTE_KERNEL_PATH_MAP      JSON [{local, remote}] for trees the gateway
 *                                       uploaded (api/, skills/); the loop cwd -> the
 *                                       remote cwd mapping is always added
 *   HARNESS_REMOTE_KERNEL_GRACE_MS      how long to keep reconnecting a dropped socket
 *   HARNESS_REMOTE_KERNEL_PING_MS       heartbeat interval
 *   HARNESS_REMOTE_KERNEL_DEAD_MS       silence after which the socket is presumed dead
 *   HARNESS_REMOTE_TOOL_PROXY           where tunnelled tool calls go; default HARNESS_MCP_PROXY
 *   HARNESS_EGRESS_TOKEN                added to tunnelled tool calls on the loop side only
 *   HARNESS_REMOTE_TOOL_TIMEOUT_MS      per tool call; default 16 min (a call may wait
 *                                       15 min for a human's approval)
 */
import { readFileSync } from "node:fs";
import type { PathMapping } from "./protocol.js";

export interface RemoteKernelConnection {
	url: string;
	token?: string;
	headers?: Record<string, string>;
}

export interface RemoteKernelConfig {
	connection: () => RemoteKernelConnection;
	remoteCwd?: string;
	pathMap: PathMapping[];
	graceMs: number;
	pingIntervalMs: number;
	deadAfterMs: number;
	toolProxy?: string;
	egressToken?: string;
	toolTimeoutMs: number;
}

export function isRemoteKernelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return Boolean(env.HARNESS_REMOTE_KERNEL_URL || env.HARNESS_REMOTE_KERNEL_CONNECT_FILE);
}

export function toWebSocketUrl(url: string): string {
	return url.replace(/^http(s?):\/\//, "ws$1://");
}

function parseJson<T>(name: string, text: string | undefined, fallback: T): T {
	if (!text) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new Error(`${name} is not valid JSON`);
	}
}

function connectionFromEnv(env: NodeJS.ProcessEnv): RemoteKernelConnection {
	const file = env.HARNESS_REMOTE_KERNEL_CONNECT_FILE;
	if (file) {
		const fromFile = parseJson<Partial<RemoteKernelConnection>>(file, readFileSync(file, "utf8"), {});
		if (!fromFile.url) throw new Error(`${file} has no url`);
		return { url: toWebSocketUrl(fromFile.url), token: fromFile.token, headers: fromFile.headers };
	}
	const headers = parseJson<Record<string, string>>(
		"HARNESS_REMOTE_KERNEL_HEADERS",
		env.HARNESS_REMOTE_KERNEL_HEADERS,
		{},
	);
	if (env.HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN)
		headers["x-daytona-preview-token"] = env.HARNESS_REMOTE_KERNEL_PREVIEW_TOKEN;
	return {
		url: toWebSocketUrl(env.HARNESS_REMOTE_KERNEL_URL ?? ""),
		token: env.HARNESS_REMOTE_KERNEL_TOKEN,
		headers,
	};
}

export function remoteKernelConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteKernelConfig {
	const pathMap = parseJson<PathMapping[]>("HARNESS_REMOTE_KERNEL_PATH_MAP", env.HARNESS_REMOTE_KERNEL_PATH_MAP, []);
	return {
		connection: () => connectionFromEnv(env),
		remoteCwd: env.HARNESS_REMOTE_KERNEL_CWD || undefined,
		pathMap,
		graceMs: Number(env.HARNESS_REMOTE_KERNEL_GRACE_MS ?? 4 * 60_000),
		pingIntervalMs: Number(env.HARNESS_REMOTE_KERNEL_PING_MS ?? 10_000),
		deadAfterMs: Number(env.HARNESS_REMOTE_KERNEL_DEAD_MS ?? 30_000),
		toolProxy: env.HARNESS_REMOTE_TOOL_PROXY || env.HARNESS_MCP_PROXY || undefined,
		egressToken: env.HARNESS_EGRESS_TOKEN || undefined,
		toolTimeoutMs: Number(env.HARNESS_REMOTE_TOOL_TIMEOUT_MS ?? 16 * 60_000),
	};
}
