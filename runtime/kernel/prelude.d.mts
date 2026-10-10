import type { ExtraStartupFiles } from "./backend.mjs";

/** The harness checkout these modules live in. */
export declare const HARNESS_ROOT: string;
export declare const PRELUDE_STARTUP_NAME: "10-harness-prelude.py";
/** `[source under runtime/, startup file name]`, in load order. */
export declare const STARTUP_HOOKS: [string, string][];

/** Copy the prelude into `startupDir`. False when this harness has none. */
export declare function stagePrelude(
  harnessRoot: string,
  startupDir: string,
): boolean;
/** Copy the runtime modules the prelude imports into `dir` (HARNESS_RUNTIME_DIR). */
export declare function stageRuntime(harnessRoot: string, dir: string): void;
/** Copy harness's startup hooks into `startupDir`, and write the app's extra startup files beside them. */
export declare function stageStartupHooks(
  harnessRoot: string,
  startupDir: string,
  extraStartupFiles?: ExtraStartupFiles,
): void;
/** A remote kernel's startup directory (and the runtime dir, when there is a prelude), staged under `parentDir` for upload. */
export declare function stageRemoteStartup(
  harnessRoot: string,
  parentDir: string,
  extraStartupFiles?: ExtraStartupFiles,
): { hooksDir: string; runtimeDir?: string };
