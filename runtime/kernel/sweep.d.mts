import type { KernelBackend, SweepOptions, SweepResult } from "./backend.mjs";

export declare const SWEEP_FIRST_DELAY_MS: number;
export declare const SWEEP_INTERVAL_MS: number;

export interface IdleSweepOptions extends SweepOptions {
  /** Default 60 s after start. */
  firstDelayMs?: number;
  /** Default 6 h. */
  intervalMs?: number;
  onSwept?: (result: SweepResult) => void;
  onError?: (err: unknown) => void;
}

/** Run `backend.sweepIdle` shortly after start and then on an interval; returns stop(). No-op when it cannot sweep. */
export declare function startIdleSweep(
  backend: KernelBackend,
  opts: IdleSweepOptions,
): () => void;
