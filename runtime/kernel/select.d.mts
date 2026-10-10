import type { ExtraStartupFiles, KernelBackend, KernelLog } from "./backend.mjs";
import type { DaytonaKernelBackendOptions } from "./daytona.mjs";

export declare const KERNEL_BACKEND_NAMES: readonly [
  "local",
  "local-unsafe",
  "daytona",
];

export interface CreateKernelBackendOptions {
  /** `local` | `local-unsafe` | `daytona`; anything else throws. */
  name: string;
  /** Default: the harness checkout this module lives in. */
  harnessRoot?: string;
  /** The kernel venv's python, for the local backends. */
  kernelPython: string;
  /** Default process.platform (`local` refuses off macOS). */
  platform?: NodeJS.Platform;
  /** Default process.env (`daytona` refuses without DAYTONA_API_KEY). */
  env?: NodeJS.ProcessEnv;
  daytona?: Pick<
    DaytonaKernelBackendOptions,
    | "labels"
    | "poolSize"
    | "poolOwner"
    | "autoDeleteMinutes"
    | "providerOptions"
  >;
  extraStartupFiles?: ExtraStartupFiles;
  log?: KernelLog;
}

export declare function createKernelBackend(
  opts: CreateKernelBackendOptions,
): KernelBackend;
