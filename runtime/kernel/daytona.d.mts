import type { DaytonaKernelProviderOptions } from "../daytona/provider.js";
import type {
  ExtraStartupFiles,
  KernelBackend,
  KernelBackendStartOptions,
  KernelContext,
  KernelLog,
  KernelSession,
  OutputFile,
  SweepOptions,
  SweepResult,
} from "./backend.mjs";

/** The slice of runtime/daytona/provider.mjs's KernelConnectionInfo this backend uses. */
export interface ConnectionInfo {
  sandboxId: string;
  url: string;
  token: string;
  headers: Record<string, string>;
  remoteCwd: string;
  mounts: { local: string; remote: string }[];
  posture: { boundary: string; egress: string };
  /** Kernel-server bundle version; verify() checks the server still runs it. */
  version?: string;
  created: boolean;
  timings: Record<string, number>;
}

/** The slice of runtime/daytona/provider.mjs's DaytonaKernelProvider this backend uses (see provider.d.ts). */
export interface Provider {
  ensure(
    conversationId: string,
    opts?: { mounts?: { local: string; remote: string }[] },
  ): Promise<ConnectionInfo>;
  stop(conversationId: string): Promise<unknown>;
  destroy(conversationId: string): Promise<unknown>;
  keepAlive(conversationId: string, opts?: { intervalMs?: number }): () => void;
  uploadFile(
    conversationId: string,
    path: string,
    data: Buffer,
  ): Promise<string>;
  listTree(conversationId: string, dir?: string): Promise<OutputFile[]>;
  readFile(conversationId: string, path: string): Promise<Buffer>;
  /** The kernel venv's python in the sandbox, with stdin; resolves to stdout. */
  runKernelPython?(
    conversationId: string,
    args: string[],
    stdin?: string,
    timeoutSec?: number,
  ): Promise<string>;
  close(): Promise<void>;
  /** The conversation's sandbox, if one exists (used to decide whether to claim a warm one). */
  find?(conversationId: string): Promise<unknown>;
  /** A sandbox was just relabelled to this conversation: fetch it by id, not by label search. */
  bind?(conversationId: string, sandboxId: string): void;
  /** The server `info` describes answers through the preview proxy (one round trip); undefined if not. */
  verify?(info: ConnectionInfo): Promise<unknown>;
  /** Every sandbox carrying this provider's labels, with Daytona's own last-activity time. */
  listOrphans?(): Promise<
    {
      sandboxId: string;
      conversationId: string;
      state: string;
      lastActivityAt?: string;
    }[]
  >;
}

/** What this backend imports from runtime/daytona/provider.mjs (tests inject a stand-in). */
export interface ProviderModule {
  DaytonaKernelProvider: new (opts: {
    labels?: Record<string, string>;
    autoStopMinutes?: number;
    autoDeleteMinutes?: number;
    log?: (line: string) => void;
  }) => Provider;
  connectionEnv(info: ConnectionInfo): Record<string, string>;
  connectFileContents(info: ConnectionInfo): string;
}

/** A sandbox whose conversation is gone is kept this long before a sweep deletes it (1 h). */
export declare const ORPHAN_GRACE_MS: number;
/** Where the prelude looks for its modules, jobs and status marker in the sandbox. */
export declare const REMOTE_PRELUDE_ENV: {
  HARNESS_RUNTIME_DIR: string;
  HARNESS_JOB_DIR: string;
  HARNESS_PRELUDE_MARKER: string;
};

/** The kernel env prime needs that follows from the mounts alone (known before the sandbox is). */
export declare function predictedKernelEnv(
  mounts: { local: string; remote: string }[],
): {
  HARNESS_REMOTE_KERNEL_CWD: string;
  HARNESS_REMOTE_KERNEL_PATH_MAP: string;
};
/** What every conversation's sandbox gets uploaded: api/, skill roots, startup hooks, the prelude's runtime. */
export declare function sandboxMounts(
  apiTreeDir: string,
  skillRoots: string[],
  startupHooksDir: string,
  runtimeDir?: string,
): { local: string; remote: string }[];

export interface DaytonaKernelBackendOptions {
  /** Default: the harness checkout this module lives in. */
  harnessRoot?: string;
  /** Added to every sandbox's labels (provider.mjs always adds app=assistant-workspace). */
  labels?: Record<string, string>;
  /** Tests inject a stand-in for runtime/daytona/provider.mjs. */
  providerModule?: ProviderModule;
  /** Passed through to every DaytonaKernelProvider (apiKey/apiUrl/target, resources, snapshot, a `daytona` client). */
  providerOptions?: Partial<DaytonaKernelProviderOptions>;
  /** Warm sandboxes kept ready for new conversations (0 disables). */
  poolSize?: number;
  /** Distinguishes this installation's pool and sweep from another host's on the same account. */
  poolOwner?: string;
  /** Daytona's own delete-after-stopped backstop; -1 (the default) disables. */
  autoDeleteMinutes?: number;
  /** App startup files uploaded into every sandbox's IPython startup dir. */
  extraStartupFiles?: ExtraStartupFiles;
  log?: KernelLog;
}

/** A Daytona sandbox per conversation; prime stays on the host and speaks one WebSocket to it. */
export declare class DaytonaKernelBackend implements KernelBackend {
  constructor(opts?: DaytonaKernelBackendOptions);
  readonly name: "daytona";
  start(opts: KernelBackendStartOptions): Promise<void>;
  open(ctx: KernelContext): Promise<KernelSession>;
  sweepIdle(opts: SweepOptions): Promise<SweepResult>;
  destroy(conversationId: string): Promise<void>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}
