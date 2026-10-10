import type { KernelLog } from "./backend.mjs";
import type { ConnectionInfo } from "./daytona.mjs";

export interface PoolSandbox {
  id: string;
  setLabels(labels: Record<string, string>): Promise<unknown>;
}

/** The slice of runtime/daytona/provider.mjs a warm pool needs, on a provider whose labels mark the pool. */
export interface PoolProvider {
  ensure(id: string): Promise<ConnectionInfo>;
  /** The server `info` describes still answers, from outside (one round trip); undefined if not. */
  verify(info: ConnectionInfo): Promise<unknown>;
  keepAlive(id: string, opts?: { intervalMs?: number }): () => void;
  destroy(id: string): Promise<unknown>;
  find(id: string): Promise<PoolSandbox | undefined>;
  listOrphans(): Promise<
    { sandboxId: string; conversationId?: string; state?: string }[]
  >;
}

/** A pool sandbox now labelled to a conversation. */
export interface Claim {
  sandboxId: string;
  /** Its connection, when its server answered at claim time; absent means run ensure() on it. */
  info?: ConnectionInfo;
}

export interface WarmPoolOptions {
  provider: PoolProvider;
  size: number;
  /** The labels a claimed sandbox gets, replacing the pool's own (Daytona merges on update). */
  labelsFor: (conversationId: string) => Record<string, string>;
  /** How long a claim waits for a sandbox already warming (default 180 s). */
  warmWaitMs?: number;
  log?: KernelLog;
}

/** Sandboxes warmed ahead of time and relabelled to a conversation on claim. */
export declare class WarmPool {
  constructor(opts: WarmPoolOptions);
  readonly readyCount: number;
  /** Adopt leftovers from a previous process (same owner), then fill. Idempotent. */
  start(): Promise<void>;
  /** Relabel a ready (or soon-ready) sandbox to `conversationId`; undefined means create cold. */
  claim(conversationId: string): Promise<Claim | undefined>;
  /** Stop refilling and delete every ready sandbox. In-flight ones delete themselves when they land. */
  close(timeoutMs?: number): Promise<void>;
}
