/** Kernel backends: where a conversation's kernel runs. README "Kernel backends". */
export { DaytonaKernelBackend, ORPHAN_GRACE_MS, predictedKernelEnv, REMOTE_PRELUDE_ENV, sandboxMounts } from "./daytona.mjs";
export { WarmPool } from "./daytona-pool.mjs";
export { hostScheduler, KERNEL_ENV_HOOK, KERNEL_ENV_HOOK_NAME, LocalKernelBackend, walkOutputs } from "./local.mjs";
export { isPlacement, PlacedKernelBackend } from "./placed.mjs";
export {
	HARNESS_ROOT,
	PRELUDE_STARTUP_NAME,
	STARTUP_HOOKS,
	stagePrelude,
	stageRemoteStartup,
	stageRuntime,
	stageStartupHooks,
} from "./prelude.mjs";
export { createKernelBackend, KERNEL_BACKEND_NAMES } from "./select.mjs";
export { SWEEP_FIRST_DELAY_MS, SWEEP_INTERVAL_MS, startIdleSweep } from "./sweep.mjs";
export { HostWorkspaceFiles, SandboxWorkspaceFiles, WorkspaceFileError } from "./workspace-files.mjs";
