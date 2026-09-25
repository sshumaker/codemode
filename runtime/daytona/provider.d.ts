import type { Daytona } from "@daytonaio/sdk";

export declare const APP_LABEL: "assistant-workspace";
export declare const KERNEL_PORT: 8765;

export interface DaytonaKernelProviderOptions {
	/** Defaults: DAYTONA_API_KEY / DAYTONA_API_URL / DAYTONA_TARGET. */
	apiKey?: string;
	apiUrl?: string;
	target?: string;
	/** Inject a client (tests). */
	daytona?: Daytona;
	/** Added to {app: "assistant-workspace"} on every sandbox, and required on every list/reap. */
	labels?: Record<string, string>;
	/** Daytona's own safety net if stop() is never called. Default 15. */
	autoStopMinutes?: number;
	/** Delete this long after stopping; -1 (default) keeps stopped sandboxes. */
	autoDeleteMinutes?: number;
	/** Snapshot to create from; default harness-assistant-kernel-<bundle version>, else the newest one, else the stock image. */
	snapshot?: string;
	resources?: { cpu?: number; memory?: number; disk?: number };
	log?: (line: string) => void;
}

/** A local directory made available read-only in the sandbox (api/, skills/). */
export interface Mount {
	local: string;
	/** Absolute, or relative to the work dir. */
	remote: string;
}

export interface ServerPosture {
	boundary: string;
	egress: "blocked" | "open";
	egressOverride?: string;
	probe: { target: string; outcome: string }[];
	serverVersion: string;
}

export interface KernelConnectionInfo {
	conversationId: string;
	sandboxId: string;
	/** wss://8765-<id>.<proxy> */
	url: string;
	/** The kernel server's shared secret (hello frame). */
	token: string;
	/** Upgrade headers: {"x-daytona-preview-token": ...}. */
	headers: Record<string, string>;
	/** The kernel's cwd in the sandbox, with inputs/ and outputs/. */
	remoteCwd: string;
	mounts: Mount[];
	posture: ServerPosture;
	/** Kernel-server bundle version running in the sandbox. */
	version: string;
	created: boolean;
	timings: Record<string, number>;
}

export interface SandboxFile {
	name: string;
	path: string;
	/** Relative to the work dir, e.g. "outputs/chart.png". */
	relPath: string;
	isDir: boolean;
	size: number;
	modTime: string;
}

export interface Orphan {
	sandboxId: string;
	conversationId: string;
	state: string;
	lastActivityAt?: string;
}

export declare class DaytonaKernelProvider {
	constructor(options?: DaytonaKernelProviderOptions);
	ensure(conversationId: string, opts?: { mounts?: Mount[] }): Promise<KernelConnectionInfo>;
	stop(conversationId: string): Promise<{ stopped: boolean; sandboxId?: string; state?: string }>;
	destroy(conversationId: string): Promise<{ destroyed: boolean; sandboxId?: string }>;
	touch(conversationId: string): Promise<void>;
	/** refreshActivity() every intervalMs (default 60 s) until the returned function is called. */
	keepAlive(conversationId: string, opts?: { intervalMs?: number }): () => void;
	/** Every regular file under dir (default "outputs"), recursively: {path relative to the work dir, size, mtimeMs}. */
	listTree(conversationId: string, dir?: string): Promise<{ path: string; size: number; mtimeMs: number }[]>;
	listOrphans(opts?: { knownConversationIds?: Iterable<string>; includeDestroyed?: boolean }): Promise<Orphan[]>;
	/** Deletes every orphan and waits (up to waitMs, default 120 s) until Daytona stops listing them. */
	reap(opts?: { knownConversationIds?: Iterable<string>; waitMs?: number }): Promise<Orphan[]>;
	uploadFile(conversationId: string, path: string, data: Buffer | string): Promise<string>;
	listFiles(conversationId: string, dir?: string): Promise<SandboxFile[]>;
	readFile(conversationId: string, path: string): Promise<Buffer>;
	serverLog(sandbox: unknown, lines?: number): Promise<string>;
}

/** Env vars for the prime process that should use this kernel. */
export declare function connectionEnv(info: KernelConnectionInfo): Record<string, string>;
/** Contents for the file HARNESS_REMOTE_KERNEL_CONNECT_FILE names. */
export declare function connectFileContents(info: KernelConnectionInfo): string;
