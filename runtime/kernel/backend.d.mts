/**
 * Where a conversation's Python kernel runs.
 *
 * The host (a gateway, a bench runner) never talks to the kernel itself: prime does,
 * through its own `KernelManager`. A backend's job is to (1) tell the prime child how to
 * reach or launch its kernel (env + cwd), (2) tell the kernel how to reach the tool
 * proxy, and (3) move files across whatever boundary separates the kernel's filesystem
 * from the host's (attachments in, outputs out).
 *
 * Built in (runtime/kernel/): `local` (prime's own KernelManager, ipykernel under srt on
 * this machine, sharing the host filesystem, so file movement is a no-op), `daytona`
 * (prime gets a RemoteKernelManager speaking one WebSocket to a kernel server in a
 * Daytona sandbox; runtime/daytona/provider.mjs), and `PlacedKernelBackend`, which routes
 * each conversation to a cloud backend or an app-supplied device backend. README
 * "Kernel backends" has the whole contract.
 */

/** Where a conversation's code runs: the host's own backend, or the user's computer. */
export type Placement = "cloud" | "device";

export interface KernelContext {
  conversationId: string;
  /** Where this kernel runs, when the caller decided (a subagent); else the conversation's own. */
  placement?: Placement;
  userId: string;
  /** The conversation's own directory on the host (e.g. `$DATA_DIR/conversations/<id>`). */
  convDir: string;
  /** Host-side working directory (`inputs/`, `outputs/`, `api -> tree`). The source of truth for local. */
  workDir: string;
  /** Resolved api/ tree shared by every conversation. */
  apiTreeDir: string;
  /** Skill roots passed to prime (read by the sandboxed file tools). */
  skillRoots: string[];
  /**
   * Scratch dir for prime and the kernel (TMPDIR). Short, because prime's daemon puts its
   * unix socket under it and sun_path is 104 bytes on macOS.
   */
  tmpDir: string;
  /** Directory holding rg/fd for prime's grep/find tools. */
  agentBinDir: string;
  /** Per-conversation token the kernel sends as `x-egress-token` to the tool proxy. */
  egressToken: string;
  /** The user's IANA time zone, for the kernel's TZ (so date math in cells is theirs), when known. */
  timeZone?: string;
  /** Path of the tool proxy on the host, e.g. `/tool-proxy` (the client appends `/call`). */
  toolProxyPath: string;
  /**
   * The workspace files to put back when this conversation's sandbox had to be recreated
   * (it was deleted after a long idle): uploaded inputs and the latest version of each
   * artifact, from the host's own copies. Only a remote backend uses it.
   */
  restoreFiles?: () => { relPath: string; hostPath: string }[];
  /** The host's own loopback base URL, e.g. `http://127.0.0.1:8787`. */
  localBaseUrl: string;
}

export interface OutputFile {
  /** Relative to the work dir, always starting with `outputs/`. */
  path: string;
  size: number;
  mtimeMs: number;
}

/** Reads and writes files relative to a conversation's work dir, wherever that lives. */
export interface WorkspaceFiles {
  /** A regular file's bytes; WorkspaceFileError if it is missing, not a regular file, or over `maxBytes`. */
  readFile(relPath: string, maxBytes: number): Promise<Buffer>;
  writeFile(relPath: string, data: Buffer): Promise<void>;
}

/** runtime/scheduler.py, run where a kernel's jobs are: `(argv after the script, stdin) -> stdout`. */
export type SchedulerRunner = (
  args: string[],
  stdin: string,
) => Promise<string>;

export interface KernelSession {
  /**
   * Merged into the prime child's environment. Must include HARNESS_MCP_PROXY. Known at
   * open(), before the kernel side is ready, so prime can start in parallel with it.
   */
  readonly primeEnv: Record<string, string>;
  /**
   * Settles when the kernel side is reachable (a remote sandbox up, its connect info
   * written). Rejects if it never will be; the file methods below wait on it.
   */
  readonly ready: Promise<void>;
  /** `--cwd` for prime: the path the kernel and file tools treat as the working directory. */
  readonly primeCwd: string;
  /** Copy an attachment (already stored at `workDir/<relPath>`) to where the kernel can read it. */
  putInput(relPath: string, hostPath: string): Promise<void>;
  /** Every regular file under `outputs/`. */
  listOutputs(): Promise<OutputFile[]>;
  readOutput(relPath: string): Promise<Buffer>;
  /** Workspace files (`inputs/`, `outputs/`) where the kernel sees them, for tools that take or return a file. */
  readonly files: WorkspaceFiles;
  /** Other absolute spellings of the work dir the kernel may use in a path (a sandbox's own). */
  readonly workDirAliases: string[];
  /**
   * Resolves with how many workspace files were put back because the conversation's
   * sandbox was recreated; 0 when it was not (or the backend keeps files on the host).
   */
  readonly restored?: Promise<number>;
  /** The prime child has exited (idle eviction, stop, crash). Release sandbox resources. */
  release(): Promise<void>;
  /**
   * The wake scheduler (runtime/scheduler.py), run where this kernel's jobs are: a
   * waited-on job or condition job is only visible there. Absent: the host judges on its
   * own machine, which still sees the deadline and its subagents.
   */
  readonly scheduler?: SchedulerRunner;
  /** How often to re-ask while a wait names such a job (a sandbox call is not free). */
  readonly schedulerPollMs?: number;
}

export interface SweepOptions {
  olderThanMs: number;
  /** The conversation's own last activity; undefined when it no longer exists. */
  lastActive: (conversationId: string) => Date | undefined;
  /** Whether a live turn or process holds the conversation. */
  isOpen: (conversationId: string) => boolean;
}

export interface SweepResult {
  deleted: string[];
  kept: number;
}

export interface KernelBackendStartOptions {
  apiTreeDir: string;
  skillRoots: string[];
  dataDir: string;
}

export interface KernelBackend {
  readonly name: string;
  /** Once, at host startup, after the api tree is built (e.g. warm a sandbox pool). Not awaited. */
  start?(opts: KernelBackendStartOptions): Promise<void>;
  open(ctx: KernelContext): Promise<KernelSession>;
  /** The conversation was deleted: destroy anything durable (a stopped sandbox, its volume). */
  destroy?(conversationId: string): Promise<void>;
  /**
   * Delete this host's conversation sandboxes that have been idle longer than
   * `olderThanMs`. `lastActive` is the conversation's own last activity (undefined when it
   * no longer exists); `isOpen` says whether a live turn or process holds it.
   */
  sweepIdle?(opts: SweepOptions): Promise<SweepResult>;
  /** Shutdown has begun: release anything idle (a warm pool) while conversations wind down. */
  drain?(): Promise<void>;
  shutdown?(): Promise<void>;
}

/** Structured log sink the backends write to; the default discards. */
export interface KernelLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Extra IPython startup files an app installs in every kernel, `{fileName: source}`
 * (e.g. `{"07-computer-fs.py": ...}`). Names sort into IPython's load order beside
 * harness's own hooks (00-05), environment hook (06) and prelude (10).
 */
export type ExtraStartupFiles = Record<string, string>;
