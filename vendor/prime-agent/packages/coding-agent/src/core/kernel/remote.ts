// SPIKE: loop-side stand-in for KernelManager. Same public surface; every call crosses one
// WebSocket to remote-server.ts, which drives prime's real KernelManager inside the sandbox.
// @ts-expect-error ws ships no types in this tree
import WebSocketCtor from "ws";

// biome-ignore lint/suspicious/noExplicitAny: untyped ws in this tree
type WebSocket = any;
const WebSocket = WebSocketCtor as any;
import type { SnapshotResult, RestoreResult } from "./state-snapshot.js";
import {
  type ExecuteOptions,
  type ExecuteResult,
  KernelBusyAfterInterruptError,
  type KernelManagerOptions,
  type KernelStartOptions,
} from "./index.js";
import type { ClientFrame, ServerFrame, WireError } from "./remote-protocol.js";

export interface RemoteKernelManagerOptions extends KernelManagerOptions {
  url: string;
  headers?: Record<string, string>;
  /** App-level shared secret checked by the server's first frame (defence in depth). */
  token?: string;
  /** Working directory inside the sandbox; the loop's own cwd is meaningless there. */
  remoteCwd?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onStream?: ExecuteOptions["onStream"];
  onLate?: ExecuteOptions["onLateSentAgentMessage"];
  onProgress?: (message: string) => void;
}

function fromWire(error: WireError): Error {
  if (error.name === "KernelBusyAfterInterruptError")
    return new KernelBusyAfterInterruptError();
  const e = new Error(error.message);
  e.name = error.name;
  return e;
}

/** Last round-trip timings, for the spike's overhead measurements. */
export interface RemoteTiming {
  clientMs: number;
  serverMs: number;
}

export class RemoteKernelManager {
  private ws?: WebSocket;
  private connecting?: Promise<WebSocket>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private running = false;
  private closed = false;
  lastTiming?: RemoteTiming;

  constructor(private readonly options: RemoteKernelManagerOptions) {}

  get ownerSessionId(): string | undefined {
    return this.options.sessionId;
  }

  get isRunning(): boolean {
    return this.running && !this.closed;
  }

  private connect(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN)
      return Promise.resolve(this.ws);
    this.connecting ??= new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.options.url, {
        headers: this.options.headers,
        maxPayload: 64 * 1024 * 1024,
      });
      ws.once("open", () => {
        if (this.options.token)
          ws.send(
            JSON.stringify({
              t: "hello",
              token: this.options.token,
            } satisfies ClientFrame),
          );
        this.ws = ws;
        resolve(ws);
      });
      ws.once("error", (err: Error) => {
        this.connecting = undefined;
        reject(err);
      });
      ws.on("message", (raw: unknown) =>
        this.onFrame(JSON.parse(String(raw)) as ServerFrame),
      );
      ws.on("close", (code: number, reason: unknown) => this.onClose(code, String(reason)));
    });
    return this.connecting;
  }

  private onClose(code: number, reason: string): void {
    this.running = false;
    this.ws = undefined;
    this.connecting = undefined;
    // Worded so ipython.ts' HARNESS_KERNEL_AUTORESTART path treats it as a dead kernel.
    const err = new Error(
      `Kernel exited: remote connection closed (${code} ${reason})`,
    );
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "result": {
        const p = this.pending.get(frame.id);
        this.pending.delete(frame.id);
        this.running = frame.isRunning;
        if (!p) return;
        if (frame.ok) p.resolve(frame.value);
        else p.reject(fromWire(frame.error));
        return;
      }
      case "stream":
        this.pending.get(frame.id)?.onStream?.(frame.chunk, frame.name);
        return;
      case "late":
        this.pending.get(frame.id)?.onLate?.(frame.message);
        return;
      case "progress":
        this.pending.get(frame.id)?.onProgress?.(frame.message);
        return;
      case "host_request":
        void this.handleHostRequest(frame.reqId, frame.payload);
        return;
      case "pong":
        this.pending.get(frame.id)?.resolve(null);
        this.pending.delete(frame.id);
        return;
    }
  }

  private async handleHostRequest(
    reqId: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const type = typeof payload.type === "string" ? payload.type : "";
    const handler = this.options.hostHandlers?.[type];
    let frame: ClientFrame;
    try {
      if (!handler)
        throw new Error(
          `host request type "${type}" is not available in this session`,
        );
      frame = {
        t: "host_response",
        reqId,
        ok: true,
        value: await handler(payload),
      };
    } catch (error) {
      frame = {
        t: "host_response",
        reqId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    this.ws?.send(JSON.stringify(frame));
  }

  private async request<T>(
    build: (id: number) => ClientFrame,
    hooks: Omit<Pending, "resolve" | "reject"> = {},
  ): Promise<T> {
    const ws = await this.connect();
    const id = this.nextId++;
    const t0 = performance.now();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        ...hooks,
        resolve: (v) => resolve(v as T),
        reject,
      });
      ws.send(JSON.stringify(build(id)));
    }).finally(() => {
      this.lastTiming = { clientMs: performance.now() - t0, serverMs: 0 };
    });
  }

  async start(options: KernelStartOptions = {}): Promise<void> {
    if (options.signal?.aborted) throw new Error("Kernel startup aborted");
    this.closed = false;
    await this.request<void>(
      (id) => ({
        t: "start",
        id,
        options: {
          python: this.options.python,
          cwd: this.options.remoteCwd,
          env: this.options.env,
          sessionId: this.options.sessionId,
          username: this.options.username,
          pythonSkills: this.options.pythonSkills,
          snapshot: this.options.snapshot,
          hostHandlerTypes: Object.keys(this.options.hostHandlers ?? {}),
        },
      }),
      { onProgress: options.onBootstrapProgress },
    );
    this.running = true;
  }

  async execute(
    code: string,
    opts: ExecuteOptions = {},
  ): Promise<ExecuteResult> {
    const ws = await this.connect();
    const id = this.nextId++;
    const onAbort = () =>
      ws.send(JSON.stringify({ t: "abort", id } satisfies ClientFrame));
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const t0 = performance.now();
    try {
      const result = await new Promise<ExecuteResult>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (v) => resolve(v as ExecuteResult),
          reject,
          onStream: opts.onStream,
          onLate: opts.onLateSentAgentMessage,
        });
        ws.send(
          JSON.stringify({
            t: "execute",
            id,
            code,
            maxOutputChars: opts.maxOutputChars,
            internal: opts.internal,
            wantLate: Boolean(opts.onLateSentAgentMessage),
          } satisfies ClientFrame),
        );
      });
      this.lastTiming = {
        clientMs: performance.now() - t0,
        serverMs: result.durationMs,
      };
      return result;
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }

  private call<T>(
    method: Extract<ClientFrame, { t: "call" }>["method"],
    args?: { snapshot?: boolean },
  ): Promise<T> {
    return this.request<T>((id) => ({ t: "call", id, method, args }));
  }

  async ping(): Promise<number> {
    const t0 = performance.now();
    await this.request<null>((id) => ({ t: "ping", id }));
    return performance.now() - t0;
  }

  restart(): Promise<void> {
    return this.call("restart");
  }

  async shutdown(opts: { snapshot?: boolean } = {}): Promise<void> {
    if (!this.ws) return;
    await this.call("shutdown", opts).catch(() => {});
    this.running = false;
  }

  async kill(): Promise<void> {
    if (!this.ws) return;
    await this.call("kill").catch(() => {});
    this.close();
  }

  snapshotState(): Promise<SnapshotResult | null> {
    return this.call<SnapshotResult | null>("snapshotState").catch(() => null);
  }

  restoreState(): Promise<RestoreResult | null> {
    return this.call<RestoreResult | null>("restoreState").catch(() => null);
  }

  listNamespaceNames(_signal?: AbortSignal): Promise<string[] | null> {
    return this.isRunning
      ? this.call<string[] | null>("listNamespaceNames").catch(() => null)
      : Promise.resolve(null);
  }

  async dispose(): Promise<void> {
    if (this.ws) await this.call("dispose").catch(() => {});
    this.close();
  }

  disposeSync(): void {
    this.close();
  }

  private close(): void {
    this.closed = true;
    this.running = false;
    this.ws?.close();
    this.ws = undefined;
  }
}
