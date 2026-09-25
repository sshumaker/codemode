/**
 * RemoteKernelManager: prime's KernelManager surface, with the kernel in a sandbox.
 *
 * It *is* a KernelManager (same type, so the provisioner, ipython.ts and every
 * kernelManagerRef consumer take it unchanged) whose every public method crosses the
 * shared RemoteKernelLink to the kernel server, which drives a real KernelManager
 * there. Nothing here reimplements kernel behaviour; the local base-class state is
 * never used.
 *
 * Differences a caller can observe, all deliberate:
 *   - snapshots live on the sandbox's disk, keyed by `snapshotKey` (the prime session
 *     id), so stop -> start of the sandbox and a restarted loop both revive the same
 *     namespace. `snapshotExists()` asks the sandbox; the local path is meaningless.
 *   - a lost session surfaces as "Kernel exited: remote ..." so the provisioner's
 *     dead-kernel path (HARNESS_KERNEL_AUTORESTART) boots a fresh kernel.
 */
import { randomUUID } from "node:crypto";
import type { KernelPythonSkill } from "../bootstrap.js";
import {
	type ExecuteOptions,
	type ExecuteResult,
	type HostRequestHandlers,
	KernelBusyAfterInterruptError,
	KernelManager,
	type KernelManagerOptions,
	type KernelStartOptions,
} from "../index.js";
import type { RestoreResult, SnapshotResult } from "../state-snapshot.js";
import { forwardedKernelEnv } from "./config.js";
import type { RemoteKernelLink } from "./link.js";
import { RemoteKernelError } from "./link.js";
import type { RemotePathMap } from "./pathmap.js";
import type { KernelMethod, ServerPosture } from "./protocol.js";
import { placeSkills, remoteSkill, tarSkillPackage } from "./skills.js";

export interface RemoteKernelManagerOptions extends KernelManagerOptions {
	link: RemoteKernelLink;
	/** The kernel's cwd inside the sandbox. */
	remoteCwd?: string;
	pathMap: RemotePathMap;
	/** Stable per conversation; the sandbox keeps this kernel's namespace snapshot under it. */
	snapshotKey?: string;
}

/** Remote timings of the most recent call, for measurement. */
export interface RemoteTiming {
	clientMs: number;
	serverMs: number;
}

const hostHandlerRegistry = new Map<string, HostRequestHandlers>();

/** The link's host-request handler: route each request to the kernel that made it. */
export async function dispatchHostRequest(
	kernel: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const type = typeof payload.type === "string" ? payload.type : "";
	const handler = hostHandlerRegistry.get(kernel)?.[type];
	if (!handler) throw new Error(`host request type "${type}" is not available in this session`);
	return handler(payload);
}

function mapError(error: unknown): Error {
	if (error instanceof RemoteKernelError && error.code === "busy_after_interrupt") {
		return new KernelBusyAfterInterruptError();
	}
	return error instanceof Error ? error : new Error(String(error));
}

export class RemoteKernelManager extends KernelManager {
	readonly kernelId = randomUUID();
	private readonly remote: RemoteKernelManagerOptions;
	private running = false;
	private shutDown = false;
	private releaseHold?: () => void;
	private unsubscribe?: () => void;
	posture?: ServerPosture;
	lastTiming?: RemoteTiming;

	constructor(options: RemoteKernelManagerOptions) {
		super(options);
		this.remote = options;
		hostHandlerRegistry.set(this.kernelId, options.hostHandlers ?? {});
	}

	override get isRunning(): boolean {
		return this.running && !this.shutDown;
	}

	private get link(): RemoteKernelLink {
		return this.remote.link;
	}

	private async uploadSkills(): Promise<KernelPythonSkill[]> {
		const placements = placeSkills(this.remote.pythonSkills);
		if (placements.length === 0) return [];
		const have = await this.link.request<{ missing: string[]; skillsDir: string }>((id) => ({
			op: "skills_have",
			id,
			hashes: [...new Set(placements.map((p) => p.hash))],
		}));
		const missing = new Set(have.missing);
		for (const p of placements) {
			if (!missing.has(p.hash)) continue;
			missing.delete(p.hash);
			const tgz = tarSkillPackage(p.skill.packagePath).toString("base64");
			await this.link.request((id) => ({ op: "skills_put", id, hash: p.hash, name: p.name, tgz }));
		}
		return placements.map((p) => remoteSkill(p, have.skillsDir));
	}

	override async start(options: KernelStartOptions = {}): Promise<void> {
		if (options.signal?.aborted) throw new Error("Kernel startup aborted");
		this.shutDown = false;
		this.releaseHold ??= this.link.hold();
		this.unsubscribe ??= this.link.onSessionLost(() => {
			this.running = false;
		});
		try {
			const pythonSkills = await this.uploadSkills();
			const result = await this.link.request<{ posture: ServerPosture }>(
				(id) => ({
					op: "start",
					id,
					kernel: this.kernelId,
					options: {
						cwd: this.remote.remoteCwd,
						env: { ...forwardedKernelEnv(), ...this.remote.env },
						sessionId: this.remote.sessionId,
						username: this.remote.username,
						pythonSkills,
						snapshot: this.remote.snapshotKey ? { key: this.remote.snapshotKey } : undefined,
						hostHandlerTypes: Object.keys(this.remote.hostHandlers ?? {}),
						pathMap: [...this.remote.pathMap.entries],
					},
				}),
				{ onProgress: options.onBootstrapProgress },
			);
			this.posture = result?.posture;
			this.running = true;
			if (this.posture) {
				options.onBootstrapProgress?.(
					`Kernel boundary: ${this.posture.boundary}; egress ${this.posture.egress}` +
						(this.posture.egressOverride ? ` (allowed: ${this.posture.egressOverride})` : ""),
				);
			}
		} catch (error) {
			throw mapError(error);
		}
	}

	override async execute(code: string, opts: ExecuteOptions = {}): Promise<ExecuteResult> {
		if (this.shutDown) throw new Error("Kernel has been shut down");
		const t0 = performance.now();
		let id: number | undefined;
		const onAbort = () => {
			if (id !== undefined) this.link.post({ op: "abort", id });
		};
		try {
			const call = await this.link.start<ExecuteResult>(
				(requestId) => ({
					op: "execute",
					id: requestId,
					kernel: this.kernelId,
					code,
					maxOutputChars: opts.maxOutputChars,
					internal: opts.internal,
					wantLate: Boolean(opts.onLateSentAgentMessage),
				}),
				{
					onStream: opts.onStream,
					onLate: opts.onLateSentAgentMessage,
					onResult: (running) => {
						if (running !== undefined) this.running = running;
					},
				},
			);
			id = call.id;
			if (opts.signal?.aborted) onAbort();
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			const result = await call.done;
			this.lastTiming = { clientMs: performance.now() - t0, serverMs: result.durationMs };
			return result;
		} catch (error) {
			throw mapError(error);
		} finally {
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}

	private async call<T>(method: KernelMethod, args?: { snapshot?: boolean }): Promise<T> {
		try {
			return await this.link.request<T>((id) => ({ op: "call", id, kernel: this.kernelId, method, args }), {
				onResult: (running) => {
					if (running !== undefined) this.running = running;
				},
			});
		} catch (error) {
			throw mapError(error);
		}
	}

	override async restart(): Promise<void> {
		await this.call("restart");
		this.running = true;
	}

	override async shutdown(opts: { snapshot?: boolean } = {}): Promise<void> {
		if (this.running) await this.call("shutdown", opts).catch(() => {});
		this.running = false;
	}

	override async kill(): Promise<void> {
		if (this.running) await this.call("kill").catch(() => {});
		this.finish();
	}

	override snapshotState(): Promise<SnapshotResult | null> {
		return this.isRunning
			? this.call<SnapshotResult | null>("snapshotState").catch(() => null)
			: Promise.resolve(null);
	}

	override restoreState(): Promise<RestoreResult | null> {
		return this.call<RestoreResult | null>("restoreState").catch(() => null);
	}

	/** Whether the sandbox holds a namespace snapshot for this kernel's key. */
	snapshotExists(): Promise<boolean> {
		return this.remote.snapshotKey ? this.call<boolean>("snapshotExists").catch(() => false) : Promise.resolve(false);
	}

	override listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> {
		return this.isRunning
			? this.call<string[] | null>("listNamespaceNames").catch(() => null)
			: Promise.resolve(null);
	}

	override async dispose(): Promise<void> {
		if (!this.shutDown && this.link.state !== "closed") await this.call("dispose").catch(() => {});
		this.finish();
	}

	override disposeSync(): void {
		this.finish();
	}

	private finish(): void {
		this.shutDown = true;
		this.running = false;
		hostHandlerRegistry.delete(this.kernelId);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.releaseHold?.();
		this.releaseHold = undefined;
	}
}
