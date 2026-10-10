import type {
  KernelBackend,
  KernelBackendStartOptions,
  KernelContext,
  KernelSession,
  Placement,
  SweepOptions,
  SweepResult,
} from "./backend.mjs";

export type { Placement } from "./backend.mjs";

export declare function isPlacement(v: unknown): v is Placement;

/**
 * The device side of placement, supplied by an app (e.g. a relay over its own link to
 * the user's computer). Destroy is per user, because a device belongs to one.
 */
export interface DeviceBackend {
  open(ctx: KernelContext): Promise<KernelSession>;
  destroyFor(userId: string, conversationId: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface PlacedKernelBackendOptions {
  cloud: KernelBackend;
  /** Absent: a conversation placed on a device fails to open, with the reason. */
  device?: DeviceBackend;
  /** A conversation's stored placement and owner; undefined when it does not exist. */
  lookup: (
    conversationId: string,
  ) => { placement: Placement; userId: string } | undefined;
}

/** Routes each conversation to the cloud backend or the device backend, fixed for its life. */
export declare class PlacedKernelBackend implements KernelBackend {
  constructor(opts: PlacedKernelBackendOptions);
  readonly name: string;
  placementOf(conversationId: string): Placement;
  start(opts: KernelBackendStartOptions): Promise<void>;
  open(ctx: KernelContext): Promise<KernelSession>;
  destroy(conversationId: string): Promise<void>;
  sweepIdle(opts: SweepOptions): Promise<SweepResult>;
  drain(): Promise<void>;
  shutdown(): Promise<void>;
}
