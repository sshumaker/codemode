/**
 * Choosing a cloud kernel backend by name, refusing the ones this machine cannot run
 * safely rather than degrading to no boundary.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DaytonaKernelBackend } from "./daytona.mjs";
import { LocalKernelBackend } from "./local.mjs";
import { HARNESS_ROOT } from "./prelude.mjs";

export const KERNEL_BACKEND_NAMES = ["local", "local-unsafe", "daytona"];

/**
 * `local` (srt, macOS only), `local-unsafe` (no sandbox; throwaway smoke tests), or
 * `daytona` (needs DAYTONA_API_KEY and a harness with runtime/daytona/). Anything else
 * throws: an app with its own backend implements KernelBackend instead.
 */
export function createKernelBackend(opts) {
	const harnessRoot = opts.harnessRoot ?? HARNESS_ROOT;
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const common = { harnessRoot, extraStartupFiles: opts.extraStartupFiles };
	switch (opts.name) {
		case "local":
			if (platform !== "darwin") {
				throw new Error(
					`KERNEL_BACKEND=local runs the kernel under srt, which only sets up on macOS (this is ${platform}). ` +
						"Use KERNEL_BACKEND=daytona, or KERNEL_BACKEND=local-unsafe for a throwaway smoke test.",
				);
			}
			return new LocalKernelBackend({ ...common, kernelPython: opts.kernelPython });
		case "local-unsafe":
			opts.log?.warn("kernel sandbox disabled (KERNEL_BACKEND=local-unsafe)");
			return new LocalKernelBackend({ ...common, kernelPython: opts.kernelPython, sandbox: false });
		case "daytona":
			if (!env.DAYTONA_API_KEY) {
				throw new Error(
					"KERNEL_BACKEND=daytona needs DAYTONA_API_KEY (and optionally DAYTONA_API_URL, DAYTONA_TARGET). " +
						"Refusing to start without a sandbox; set KERNEL_BACKEND=local-unsafe only for a throwaway smoke test.",
				);
			}
			if (!existsSync(join(harnessRoot, "runtime/daytona/provider.mjs"))) {
				throw new Error(`KERNEL_BACKEND=daytona needs a harness with runtime/daytona/ (HARNESS_ROOT=${harnessRoot})`);
			}
			return new DaytonaKernelBackend({ ...common, ...opts.daytona, log: opts.log });
		default:
			throw new Error(
				`KERNEL_BACKEND=${opts.name} is not built into the harness; implement KernelBackend (runtime/kernel/backend.d.ts)`,
			);
	}
}
