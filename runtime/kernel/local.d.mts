import type {
  ExtraStartupFiles,
  KernelBackend,
  KernelContext,
  KernelSession,
  OutputFile,
  SchedulerRunner,
} from "./backend.mjs";

/** IPython startup file pointing matplotlib/fontconfig caches at the kernel's TMPDIR (HOME is read-denied). */
export declare const KERNEL_ENV_HOOK: string;
export declare const KERNEL_ENV_HOOK_NAME: "06-aw-env.py";

/** Every regular file under `workDir/outputs` (dotfiles skipped, 6 levels deep), sorted by path. */
export declare function walkOutputs(workDir: string): OutputFile[];
/** runtime/scheduler.py on this host, under `python` (falls back to python3 when it does not exist). */
export declare function hostScheduler(
  harnessRoot: string,
  python: string,
): SchedulerRunner;

export interface LocalKernelBackendOptions {
  /** Default: the harness checkout this module lives in. */
  harnessRoot?: string;
  /** The kernel venv's python (PRIME_AGENT_KERNEL_PYTHON). */
  kernelPython: string;
  /** false = `local-unsafe`: no srt sandbox at all. Container smoke tests only. */
  sandbox?: boolean;
  /** App startup files written into every kernel's IPython startup dir. */
  extraStartupFiles?: ExtraStartupFiles;
}

/** prime's own ipykernel under srt with harness's posture, sharing this host's filesystem. */
export declare class LocalKernelBackend implements KernelBackend {
  constructor(opts: LocalKernelBackendOptions);
  readonly name: "local" | "local-unsafe";
  open(ctx: KernelContext): Promise<KernelSession>;
}
