// TODO: reconsider whether the persistent kernel is needed once RLM-1 weights land.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { IMAGE_MIME_TYPES } from "../../utils/mime.js";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.js";
import { withKernelBootPermit } from "../kernel/boot-gate.js";
import type { KernelBootstrapProgressHandler } from "../kernel/bootstrap.js";
import {
	type ExecuteResult,
	type HostRequestHandlers,
	type KernelAttachment,
	KernelBusyAfterInterruptError,
	type KernelDiffDisplay,
	KernelManager,
	type KernelSentAgentMessage,
} from "../kernel/index.js";
import { manifestPathIn, type RestoreResult, snapshotPathIn } from "../kernel/state-snapshot.js";
import type { PythonSkillRuntimeInfo } from "../skills.js";
import { parseIpythonBashCell } from "./ipython-cell-code.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";

const RLM_BOOTSTRAP_BASE_CODE = `
import asyncio
import os as _prime_agent_os

_prime_agent_os.environ["NO_COLOR"] = "1"
get_ipython().colors = "nocolor"

try:
    import nest_asyncio as _prime_agent_nest_asyncio
    _prime_agent_nest_asyncio.apply()
except Exception:
    pass

try:
    import rlm as _prime_agent_rlm_module
    rlm = _prime_agent_rlm_module.rlm
except Exception as _prime_agent_rlm_error:
    _PRIME_AGENT_RLM_IMPORT_ERROR = str(_prime_agent_rlm_error)

    class _PrimeAgentMissingRlm:
        def _raise_missing(self):
            raise RuntimeError(
                "prime-agent-runtime is not installed in this IPython kernel. "
                "Remove ~/.prime/agent/kernel-venv so prime-agent can rebuild it, or set "
                "PRIME_AGENT_KERNEL_PYTHON to a kernel environment with prime-agent-runtime installed. "
                f"Import error: {_PRIME_AGENT_RLM_IMPORT_ERROR}"
            )

        async def run(self, prompt, **kwargs):
            self._raise_missing()

        async def find_models(self, query="", limit=8):
            self._raise_missing()

        async def list_subagents(self):
            self._raise_missing()

        async def delete_subagent(self, target):
            self._raise_missing()

        async def __call__(self, prompt, **kwargs):
            return await self.run(prompt, **kwargs)

    rlm = _PrimeAgentMissingRlm()
`.trim();

export function buildRlmBootstrapCode(pythonSkills: readonly PythonSkillRuntimeInfo[] = []): string {
	const importNames = [...new Set(pythonSkills.map((skill) => skill.importName))];
	if (importNames.length === 0) {
		return RLM_BOOTSTRAP_BASE_CODE;
	}

	return `
${RLM_BOOTSTRAP_BASE_CODE}

import importlib as _prime_agent_importlib
import inspect as _prime_agent_inspect
import sys as _prime_agent_sys
import types as _prime_agent_types

class _PrimeAgentCallableSkillModule(_prime_agent_types.ModuleType):
    async def __call__(self, *args, **kwargs):
        result = self.run(*args, **kwargs)
        if _prime_agent_inspect.isawaitable(result):
            return await result
        return result

class _PrimeAgentUnavailableSkill:
    def __init__(self, name, error):
        self.__name__ = name
        self._prime_agent_import_error = error
        self.__doc__ = f"Python skill {name} is unavailable: {error}"

    async def run(self, *args, **kwargs):
        raise RuntimeError(
            f"Python skill {self.__name__} is unavailable in this IPython kernel. "
            f"Import error: {self._prime_agent_import_error}"
        )

    async def __call__(self, *args, **kwargs):
        return await self.run(*args, **kwargs)

    def __repr__(self):
        return f"<unavailable Python skill {self.__name__!r}: {self._prime_agent_import_error}>"

def _prime_agent_wrap_skill_module(module):
    run = getattr(module, "run", None)
    if not callable(run):
        return module
    if isinstance(module, _PrimeAgentCallableSkillModule):
        return module
    wrapped = _PrimeAgentCallableSkillModule(module.__name__)
    wrapped.__dict__.update(module.__dict__)
    try:
        wrapped.__signature__ = _prime_agent_inspect.signature(run)
    except Exception:
        pass
    doc = getattr(run, "__doc__", None)
    if doc:
        wrapped.__doc__ = doc
    _prime_agent_sys.modules[module.__name__] = wrapped
    return wrapped

_PRIME_AGENT_SKILL_IMPORT_ERRORS = {}

for _prime_agent_skill_name in ${JSON.stringify(importNames)}:
    try:
        globals()[_prime_agent_skill_name] = _prime_agent_wrap_skill_module(
            _prime_agent_importlib.import_module(_prime_agent_skill_name)
        )
    except Exception as _prime_agent_skill_error:
        _PRIME_AGENT_SKILL_IMPORT_ERRORS[_prime_agent_skill_name] = str(_prime_agent_skill_error)
        globals()[_prime_agent_skill_name] = _PrimeAgentUnavailableSkill(
            _prime_agent_skill_name,
            str(_prime_agent_skill_error),
        )
`.trim();
}

const ipythonSchema = Type.Object({
	code: Type.String({
		description:
			"Python scratchpad code or `%%bash` shell cells to execute in the agent kernel. Use the target project's own environment for project imports, tests, scripts, CLIs, and dependency checks instead of direct kernel imports.",
	}),
});

const BUSY_KERNEL_WAIT_CHOICE = "Wait and preserve state";
const BUSY_KERNEL_KILL_CHOICE = "Kill kernel and restart";
const BUSY_KERNEL_PROMPT = [
	"Interrupted IPython cell is still running",
	"Ctrl+C sent an interrupt, but the previous cell has not stopped yet. A new IPython command cannot start until it finishes.",
	"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables, imports, and running tasks.",
].join("\n");
const KERNEL_RESTART_NOTICE = [
	"<ipython_kernel_reset>",
	"The IPython kernel was restarted after a previous interrupted cell kept running. Variables, imports, async tasks, and open resources from before the restart are no longer available; recreate them before using them.",
	"</ipython_kernel_reset>",
].join("\n");

function createAbortError(): Error {
	return new Error("IPython execution aborted");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined, onAbort?: () => void): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		onAbort?.();
		return Promise.reject(createAbortError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", abort);
		const abort = () => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			onAbort?.();
			reject(createAbortError());
		};
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

function createLinkedAbortSignal(sources: readonly (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const cleanups: Array<() => void> = [];
	const abort = () => controller.abort();
	for (const source of sources) {
		if (!source) {
			continue;
		}
		if (source.aborted) {
			controller.abort();
			continue;
		}
		const listener = () => abort();
		source.addEventListener("abort", listener, { once: true });
		cleanups.push(() => source.removeEventListener("abort", listener));
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const cleanup of cleanups) {
				cleanup();
			}
		},
	};
}

function setWorkingMessage(ctx: ExtensionContext | undefined, message?: string): void {
	try {
		ctx?.ui.setWorkingMessage(message);
	} catch {
		// Stale UI context; cosmetic only.
	}
}

export type IpythonToolInput = Static<typeof ipythonSchema>;

export interface IpythonToolDetails {
	durationMs?: number;
	status?: "ok" | "error" | "aborted" | "starting";
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	/** Diffs streamed from file edits, rendered by the IPython cell. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments loaded into context (e.g. by the attach-image skill). */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** True when this result came after killing and restarting a busy kernel. */
	kernelRestarted?: boolean;
	error?: {
		ename: string;
		evalue: string;
		traceback: string[];
	};
}

export interface IpythonToolOptions {
	/** Python override. Must have `ipykernel` installed. */
	python?: string;
	env?: Record<string, string>;
	/** Command prefix prepended to every %%bash cell. */
	commandPrefix?: string;
	/** Optional explicit shell path for bare %%bash cells. */
	shellPath?: string;
	sessionId?: string;
	/** Typed host request handlers for the kernel↔host bridge (rlm.run, goal.*, …). */
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly PythonSkillRuntimeInfo[];
	/** Per-session artifact dir where the kernel namespace snapshot is stored. Omit to disable snapshots. */
	snapshotDir?: string;
	/** Resolves before this kernel starts — e.g. the previous provisioner's dispose, so a
	 * /reload's old-kernel snapshot flush can't race the new kernel's restore. */
	readyGate?: Promise<unknown>;
	/** Filled with the live KernelManager after the first kernel start; cleared on construction. */
	kernelManagerRef?: { current?: KernelManager };
	/**
	 * Fires once per kernel start when a previous session's namespace was revived
	 * (some names restored or some failed), so the session can tell the model.
	 */
	onRestore?: (result: RestoreResult) => void;
	onLateSentAgentMessage?: (toolCallId: string, message: KernelSentAgentMessage) => void;
	/** Shared provisioner owning the kernel lifecycle. When provided, the remaining options are ignored. */
	provisioner?: IpythonKernelProvisioner;
}

function quoteScriptMagicArgument(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function applyShellSettingsToBashMagicCell(
	code: string,
	options: Pick<IpythonToolOptions, "commandPrefix" | "shellPath"> | undefined,
): string {
	const commandPrefix = options?.commandPrefix;
	const shellPath = options?.shellPath?.trim();
	if (!commandPrefix && !shellPath) return code;

	const bashCell = parseIpythonBashCell(code);
	if (!bashCell) return code;

	const firstLine =
		shellPath && bashCell.magicArguments.trim().length === 0
			? `${bashCell.indent}%%script ${quoteScriptMagicArgument(shellPath)}`
			: `${bashCell.indent}%%bash${bashCell.magicArguments}`;
	const nextBody = commandPrefix ? `${commandPrefix}${bashCell.body ? `\n${bashCell.body}` : ""}` : bashCell.body;
	return `${bashCell.leadingWhitespace}${firstLine}${bashCell.lineBreak || "\n"}${nextBody}`;
}

/**
 * Owns the lazy create+start+runtime-bootstrap of one session's IPython kernel.
 *
 * Concurrent ensure() calls await the same in-flight startup, a failed startup
 * clears the memo so the next call retries fresh, and progress listeners can
 * attach mid-flight (a tool call racing a background prewarm()).
 */
export class IpythonKernelProvisioner {
	private managerPromise?: Promise<KernelManager>;
	private startedManager?: KernelManager;
	private readonly startupListeners = new Set<KernelBootstrapProgressHandler>();
	private lastStartupMessage?: string;
	private _lastRestore?: RestoreResult;
	private readonly disposeController = new AbortController();

	constructor(
		private readonly cwd: string,
		private readonly options?: Omit<IpythonToolOptions, "provisioner">,
	) {
		if (options?.kernelManagerRef) {
			options.kernelManagerRef.current = undefined;
		}
	}

	/** The kernel manager, once a startup has completed successfully. */
	get manager(): KernelManager | undefined {
		return this.startedManager;
	}

	/** Result of reviving a prior session's namespace on the last kernel start, if any. */
	get lastRestore(): RestoreResult | undefined {
		return this._lastRestore;
	}

	/** Start the kernel in the background. Failures are swallowed here and surface on the next ensure(). */
	prewarm(): void {
		void this.ensure().catch(() => {});
	}

	/** Whether a kernel has finished starting and is currently running. */
	get hasRunningKernel(): boolean {
		return this.startedManager?.isRunning ?? false;
	}

	/** Live user-defined names in the kernel namespace, or null if listing failed / no kernel. */
	async listNamespaceNames(signal?: AbortSignal): Promise<string[] | null> {
		const m = this.startedManager ?? (await this.managerPromise?.catch(() => undefined));
		return (await m?.listNamespaceNames(signal)) ?? null;
	}

	/** Dispose the kernel owned by this provisioner, including one still starting up. */
	async dispose(): Promise<void> {
		// Drops a still-queued boot out of the semaphore and short-circuits an
		// in-flight startKernel before it spawns, so a disposed session's boot
		// doesn't waste a slot during a fan-out.
		this.disposeController.abort();
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.dispose();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	async kill(): Promise<void> {
		const pending = this.managerPromise;
		this.managerPromise = undefined;
		this.startedManager = undefined;
		if (this.options?.kernelManagerRef) {
			this.options.kernelManagerRef.current = undefined;
		}
		if (!pending) return;
		try {
			const m = await pending;
			await m.kill();
		} catch {
			// a failed startup already cleaned up after itself
		}
	}

	ensure(onProgress?: KernelBootstrapProgressHandler, signal?: AbortSignal): Promise<KernelManager> {
		if (signal?.aborted) {
			return Promise.reject(createAbortError());
		}
		let cleanupProgressListener: (() => void) | undefined;
		if (onProgress && !this.startedManager) {
			this.startupListeners.add(onProgress);
			cleanupProgressListener = () => {
				this.startupListeners.delete(onProgress);
				signal?.removeEventListener("abort", cleanupProgressListener!);
			};
			signal?.addEventListener("abort", cleanupProgressListener, { once: true });
			// Joining an in-flight startup: replay the current stage.
			if (this.managerPromise && this.lastStartupMessage) {
				onProgress(this.lastStartupMessage);
			}
		}
		if (!this.managerPromise) {
			const startup = this.startKernel(signal);
			this.managerPromise = startup;
			startup.then(
				(m) => {
					if (this.managerPromise === startup) {
						this.startedManager = m;
					}
					this.settleStartup();
				},
				() => {
					// Clear the memo so the next ensure() retries instead of
					// rethrowing a cached rejection forever.
					if (this.managerPromise === startup) {
						this.managerPromise = undefined;
					}
					this.settleStartup();
				},
			);
		}
		return raceWithAbort(this.managerPromise, signal).finally(() => {
			cleanupProgressListener?.();
		});
	}

	private settleStartup(): void {
		this.startupListeners.clear();
		this.lastStartupMessage = undefined;
	}

	private emitStartupProgress(message: string): void {
		this.lastStartupMessage = message;
		for (const listener of [...this.startupListeners]) {
			listener(message);
		}
	}

	private async startKernel(signal?: AbortSignal): Promise<KernelManager> {
		const startupAbort = createLinkedAbortSignal([this.disposeController.signal, signal]);
		const startupSignal = startupAbort.signal;
		// Wait for a previous provisioner (e.g. on /reload) to finish disposing — and
		// flushing its final snapshot — before we read that snapshot back, so the two
		// kernels can't race over the same on-disk file. Guarded so the common
		// no-gate path stays synchronous (callers rely on prompt startup progress).
		try {
			if (this.options?.readyGate) {
				await raceWithAbort(
					this.options.readyGate.catch(() => {}),
					startupSignal,
				);
			}
			const snapshotDir = this.options?.snapshotDir;
			const m = new KernelManager({
				python: this.options?.python,
				cwd: this.cwd,
				env: this.options?.env,
				sessionId: this.options?.sessionId,
				hostHandlers: this.options?.hostHandlers,
				pythonSkills: this.options?.pythonSkills,
				// Only persistent sessions (which have an artifact dir) get a revivable snapshot.
				snapshot: snapshotDir
					? { path: snapshotPathIn(snapshotDir), manifestPath: manifestPathIn(snapshotDir) }
					: undefined,
			});
			let pendingRestore: RestoreResult | undefined;
			try {
				// Emitted synchronously (before the permit await) so a listener attaching
				// mid-flight can replay the current stage.
				this.emitStartupProgress("Starting IPython kernel...");
				// Only the process spawn + port resolve contends for OS resources under a
				// fan-out, and it is bounded by start()'s own timeouts — so the permit
				// covers only start(). Restore/bootstrap run per-kernel afterwards and are
				// unbounded execute()s; holding the global permit across them could pin it
				// forever on a wedged bootstrap and starve every other session's boot.
				await withKernelBootPermit(() => {
					// Disposed while queued for the permit — don't spawn a kernel nobody wants.
					if (startupSignal.aborted) throw new Error("Kernel provisioner disposed before start");
					return m.start({
						onBootstrapProgress: (message) => this.emitStartupProgress(message),
						signal: startupSignal,
					});
				}, startupSignal);
				// Revive a prior session's namespace before the bootstrap, so the bootstrap
				// then overwrites live handles (rlm, skills) on top of anything restored.
				if (snapshotDir) {
					const snapshotExisted = existsSync(snapshotPathIn(snapshotDir));
					this.emitStartupProgress("Restoring IPython state...");
					const restore = await raceWithAbort(m.restoreState(), startupSignal);
					if (snapshotExisted) {
						pendingRestore = restore ?? { restored: [], failed: [], path: snapshotPathIn(snapshotDir) };
					}
				}
				this.emitStartupProgress("Preparing IPython runtime...");
				const bootstrap = await m.execute(buildRlmBootstrapCode(this.options?.pythonSkills), {
					signal: startupSignal,
				});
				if (bootstrap.status !== "ok") {
					const details = [bootstrap.stderr, bootstrap.error?.traceback.join("\n")].filter(Boolean).join("\n");
					throw new Error(`Failed to initialize rlm runtime in the IPython kernel:\n${details}`);
				}
			} catch (error) {
				// Never leak the kernel's ZMQ sockets / temp dir if startup fails after spawn.
				void m.dispose();
				throw error;
			}
			// Only tell the model what was revived once the kernel is actually usable —
			// a notice claiming restored state must never outlive a failed bootstrap.
			if (pendingRestore) {
				this._lastRestore = pendingRestore;
				this.options?.onRestore?.(pendingRestore);
			}
			if (this.options?.kernelManagerRef) {
				this.options.kernelManagerRef.current = m;
			}
			return m;
		} finally {
			startupAbort.cleanup();
		}
	}
}

async function chooseBusyKernelAction(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal | undefined,
): Promise<"wait" | "kill" | "cancel"> {
	if (!ctx?.hasUI) {
		return "cancel";
	}
	const choice = await ctx.ui.select(BUSY_KERNEL_PROMPT, [BUSY_KERNEL_WAIT_CHOICE, BUSY_KERNEL_KILL_CHOICE], {
		signal,
	});
	if (choice === BUSY_KERNEL_WAIT_CHOICE) {
		return "wait";
	}
	if (choice === BUSY_KERNEL_KILL_CHOICE) {
		return "kill";
	}
	return "cancel";
}

async function executeWithBusyKernelChoice(
	provisioner: IpythonKernelProvisioner,
	reportStartupProgress: KernelBootstrapProgressHandler,
	toolCallId: string,
	code: string,
	signal: AbortSignal | undefined,
	onStream: (chunk: string, name: "stdout" | "stderr") => void,
	onWorkingMessage: (message?: string) => void,
	onLateSentAgentMessage: ((toolCallId: string, message: KernelSentAgentMessage) => void) | undefined,
	ctx: ExtensionContext | undefined,
): Promise<{ result: ExecuteResult; kernelRestarted: boolean }> {
	let kernelRestarted = false;
	while (true) {
		const m = await provisioner.ensure(reportStartupProgress, signal);
		try {
			return {
				result: await m.execute(code, {
					signal,
					onStream,
					onLateSentAgentMessage: onLateSentAgentMessage
						? (message) => onLateSentAgentMessage(toolCallId, message)
						: undefined,
				}),
				kernelRestarted,
			};
		} catch (error) {
			if (!(error instanceof KernelBusyAfterInterruptError) || signal?.aborted) {
				throw error;
			}
			const action = await chooseBusyKernelAction(ctx, signal);
			if (action === "wait") {
				onWorkingMessage("Waiting for IPython kernel...");
				continue;
			}
			if (action === "kill") {
				onWorkingMessage("Restarting IPython kernel...");
				await provisioner.kill();
				kernelRestarted = true;
				continue;
			}
			throw error;
		}
	}
}

/** Turn kernel image attachments into `ImageContent` blocks; non-image types are dropped. */
export function imageBlocksFromAttachments(attachments: readonly KernelAttachment[] | undefined): ImageContent[] {
	if (!attachments) return [];
	return attachments
		.filter((a) => IMAGE_MIME_TYPES.has(a.mimeType))
		.map((a) => ({ type: "image", data: a.data, mimeType: a.mimeType }));
}

/**
 * Provenance for top-level bindings, and the cell transcript they refer to.
 *
 * Injected into ipython.ts by scripts/neutralize-prime.mjs. Kept as real
 * TypeScript because embedding it as an escaped string mangled every backslash.
 *
 * Each executed cell is written to `.cells/turn-N.py` under the working
 * directory, and every binding records the right-hand side that produced it plus
 * a `turn-N.py:LINE` reference. The model can therefore see not just which names
 * exist but what they hold and where they came from — and can `cat` the cell if
 * it needs the surrounding code.
 *
 * The right-hand side is more useful than a type name: `await api.reddit.hot(...)`
 * says both what the value is and that it came from a call already made, which is
 * the thing that stops it being fetched twice.
 *
 * Imports and loop/with targets are tracked so they can be excluded: `json`, `f`
 * and `target` are noise, and the listing exists to remind the model what *data*
 * it is already holding.
 */
interface Provenance {
	rhs: string;
	turn: number;
	line: number;
}

const assignedAt = new Map<string, Provenance>();
/** Names bound by import, `for` or `with` — excluded from the listing. */
const nonData = new Set<string>();
/** What has already been shown to the model, for delta mode. */
const shownNames = new Map<string, string>();
let cellTurn = 0;

function recordAssignments(code: string, cwd: string): void {
	cellTurn += 1;

	// Persist the cell so the `turn-N.py:LINE` references resolve to a real file.
	try {
		const dir = pathJoin(cwd, ".cells");
		mkdirSync(dir, { recursive: true });
		writeFileSync(pathJoin(dir, `turn-${cellTurn}.py`), code);
	} catch {
		// Transcript is a convenience; never fail a cell over it.
	}

	const lines = code.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// `import x`, `import x as y`, `from m import a, b as c`
		const imp = /^\s*(?:from\s+[\w.]+\s+)?import\s+(.+)$/.exec(line);
		if (imp) {
			for (const part of imp[1].split(",")) {
				const alias = /\s+as\s+([A-Za-z_]\w*)\s*$/.exec(part);
				const name = alias ? alias[1] : part.trim().split(".")[0].trim();
				if (name) nonData.add(name);
			}
			continue;
		}

		// Loop targets and context managers: `for x in …`, `with … as f:`
		const loop = /^\s*(?:async\s+)?for\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s/.exec(line);
		if (loop) {
			for (const n of loop[1].split(",")) nonData.add(n.trim());
			continue;
		}
		for (const m of line.matchAll(/\bas\s+([A-Za-z_]\w*)/g)) nonData.add(m[1]);

		// Comprehension and lambda locals leak into the listing as bare names with
		// no provenance, and they are never data the model needs reminding of.
		for (const m of line.matchAll(/\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\b/g)) {
			for (const n of m[1].split(",")) nonData.add(n.trim());
		}
		for (const m of line.matchAll(/\blambda\s+([^:]+):/g)) {
			for (const n of m[1].split(",")) {
				const bare = n.trim().split("=")[0].trim();
				if (/^[A-Za-z_]\w*$/.test(bare)) nonData.add(bare);
			}
		}
		// Walrus targets are intermediates, not results: `if (m := re.search(…))`.
		for (const m of line.matchAll(/([A-Za-z_]\w*)\s*:=/g)) nonData.add(m[1]);
		// Function and class definitions.
		const def = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/.exec(line);
		if (def) nonData.add(def[1]);

		// Top-level bindings only: no leading indentation, single or tuple target.
		const m = /^([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?!=)/.exec(line);
		if (!m) continue;
		const rhs = line.slice(line.indexOf("=") + 1).trim().slice(0, 72) || "…";
		for (const name of m[1].split(",").map((n) => n.trim())) {
			assignedAt.set(name, { rhs, turn: cellTurn, line: i + 1 });
			nonData.delete(name);
		}
	}
}

/**
 * Render the listing, collapsing tuple unpacking.
 *
 * `a, b, c = await gather(...)` binds three names from one expression; repeating
 * that expression once per name was accurate and unreadable. Names sharing a
 * provenance are grouped onto a single line.
 */
function describeNamespace(names: string[]): string[] {
	const groups = new Map<string, { names: string[]; p: Provenance | undefined }>();
	for (const n of names) {
		if (nonData.has(n)) continue;
		const p = assignedAt.get(n);
		const key = p ? `${p.turn}:${p.line}:${p.rhs}` : `bare:${n}`;
		if (!groups.has(key)) groups.set(key, { names: [], p });
		groups.get(key)!.names.push(n);
	}
	return [...groups.values()].map(({ names: ns, p }) =>
		p ? `${ns.join(", ")}  # = ${p.rhs}, turn-${p.turn}.py:${p.line}` : ns.join(", "),
	);
}

/**
 * An `ipython` tool whose kernel lives inside a TheAgentCompany task container.
 *
 * Injected into ipython.ts by scripts/neutralize-prime.mjs, and used only when
 * HARNESS_EXEC_CONTAINER names a running container. Kept as real TypeScript for
 * the same reason as the other patches: embedding it as an escaped string
 * mangled every backslash.
 *
 * Why not prime's own kernel: it talks to ipykernel over ZMQ on dynamically
 * chosen ports. The agent runs on macOS while the task container runs inside the
 * colima VM, and those ports are not forwarded, so the connection cannot be
 * made. `docker exec -i` crosses that boundary with a pipe, which is all a REPL
 * needs. bench/tac/kernel.py is the other end.
 *
 * The tool keeps prime's name, schema and description exactly. The model must
 * not be able to tell that the backend changed — otherwise a TheAgentCompany
 * result could not be compared against the MCP-Bench result for the same arm.
 */
interface ContainerCellResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	repr: string | null;
	error: string | null;
	names: string[];
}

/**
 * One long-lived `docker exec` per session, so the namespace persists across
 * tool calls the way a REPL must. Requests are serialised: the kernel is a
 * single Python process and the tool is registered `executionMode: "sequential"`,
 * but a queue makes that guarantee local rather than assumed.
 */
class ContainerKernel {
	private proc: ReturnType<typeof nodeSpawn> | undefined;
	private buffer = "";
	private pending: ((r: ContainerCellResult) => void) | undefined;
	private ready: Promise<void> | undefined;
	private tail = "";

	constructor(private readonly container: string) {}

	private start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = new Promise<void>((resolve, reject) => {
			const proc = nodeSpawn(
				"docker",
				["exec", "-i", this.container, "/agent/venv/bin/python", "/agent/kernel.py"],
				{ stdio: ["pipe", "pipe", "pipe"] },
			);
			this.proc = proc;

			proc.stdout.setEncoding("utf8");
			proc.stdout.on("data", (chunk: string) => {
				this.buffer += chunk;
				let idx = this.buffer.indexOf("\n");
				while (idx >= 0) {
					const line = this.buffer.slice(0, idx);
					this.buffer = this.buffer.slice(idx + 1);
					if (line.trim()) {
						let msg: Record<string, unknown> | undefined;
						try {
							msg = JSON.parse(line);
						} catch {
							// Anything the kernel did not emit as JSON — a warning printed
							// during import, say — is not a cell result. Dropping it keeps
							// the protocol in sync.
						}
						if (msg?.ready === true) resolve();
						else if (msg) {
							const done = this.pending;
							this.pending = undefined;
							done?.(msg as unknown as ContainerCellResult);
						}
					}
					idx = this.buffer.indexOf("\n");
				}
			});

			// stderr is the container's, not a cell's — surfaced only if start-up fails.
			proc.stderr.setEncoding("utf8");
			proc.stderr.on("data", (c: string) => (this.tail = (this.tail + c).slice(-2000)));

			proc.on("error", reject);
			proc.on("exit", (code: number | null) => {
				const done = this.pending;
				this.pending = undefined;
				// A dead kernel must fail the in-flight cell rather than hang it.
				done?.({
					ok: false,
					stdout: "",
					stderr: "",
					repr: null,
					names: [],
					error: `kernel exited (code ${code}) in container ${this.container}\n${this.tail}`,
				});
				reject(new Error(`kernel exited during start-up (code ${code})\n${this.tail}`));
			});
		});
		return this.ready;
	}

	async run(code: string, signal?: AbortSignal): Promise<ContainerCellResult> {
		await this.start();
		return new Promise<ContainerCellResult>((resolve) => {
			this.pending = resolve;
			const onAbort = () => {
				// Interrupting a cell mid-flight would desynchronise the line protocol,
				// so the session is torn down instead. Losing the namespace is the
				// honest outcome of an abort, and the next cell rebuilds it.
				this.dispose();
				resolve({ ok: false, stdout: "", stderr: "", repr: null, names: [], error: "aborted" });
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			this.proc?.stdin?.write(`${JSON.stringify({ code })}\n`);
		});
	}

	dispose(): void {
		this.proc?.kill("SIGKILL");
		this.proc = undefined;
		this.ready = undefined;
		this.pending = undefined;
	}
}

const containerKernels = new Map<string, ContainerKernel>();

export function createContainerIpythonToolDefinition(
	container: string,
	cwd: string,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	let kernel = containerKernels.get(container);
	if (!kernel) {
		kernel = new ContainerKernel(container);
		containerKernels.set(container, kernel);
	}
	const active = kernel;

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (_toolCallId, params, signal) => {
			const started = Date.now();
			const r = await active.run(params.code, signal);

			// IPython already renders the traceback into stdout, so `error` is a
			// signal rather than something to print again. Echoing both was the
			// difference between a 3KB and a 7KB failed cell.
			let text = r.stdout ?? "";
			if (r.stderr) text += (text ? "\n" : "") + r.stderr;
			if (!r.ok && r.error && !text.includes(r.error.trim().split("\n").pop() ?? "")) {
				text += (text ? "\n" : "") + r.error;
			}

			// Same namespace visibility as the local kernel — see the note in
			// createIpythonToolDefinition for why full beats delta.
			const nsMode = process.env.HARNESS_SHOW_NAMESPACE;
			if (nsMode === "1" || nsMode === "delta") {
				try {
					recordAssignments(params.code, cwd);
					const lines = describeNamespace(r.names ?? []);
					if (lines.length > 0) {
						if (nsMode === "delta") {
							const fresh = lines.filter((l) => !shownNames.has(l));
							for (const l of lines) shownNames.set(l, l);
							if (fresh.length > 0) {
								text += `${text ? "\n\n" : ""}[now available in the kernel:\n  ${fresh.join("\n  ")}\n]`;
							}
						} else {
							text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${lines.join("\n  ")}\n]`;
						}
					}
				} catch {
					// Namespace listing is a convenience; never fail a cell over it.
				}
			}

			return {
				content: [{ type: "text", text: text || "" }],
				details: {
					durationMs: Date.now() - started,
					status: r.ok ? "ok" : "error",
					stdout: r.stdout,
					stderr: r.stderr,
					result: r.repr ?? undefined,
				} as IpythonToolDetails,
				isError: !r.ok,
			};
		},
	};
}

export function createIpythonToolDefinition(
	cwd: string,
	options?: IpythonToolOptions,
): ToolDefinition<typeof ipythonSchema, IpythonToolDetails> {
	const execContainer = process.env.HARNESS_EXEC_CONTAINER;
	if (execContainer) return createContainerIpythonToolDefinition(execContainer, cwd);

	const provisioner = options?.provisioner ?? new IpythonKernelProvisioner(cwd, options);

	return {
		name: "ipython",
		label: "ipython",
		description:
			"Execute Python scratchpad code and `%%bash` shell cells in a persistent IPython kernel. Variables, imports, and loaded data persist across calls, and are revived on a best-effort basis when a session is resumed (objects that cannot be serialized are dropped and reported). Project imports, tests, scripts, CLIs, and dependency checks should run through the target project's own environment.",
		promptSnippet: "ipython - persistent agent notebook for Python scratchpad code and %%bash orchestration",
		// The kernel is single-threaded — pi must not run two ipython calls in parallel within a batch.
		executionMode: "sequential",
		parameters: ipythonSchema,
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			let hasWorkingMessage = false;
			const setToolWorkingMessage = (message?: string) => {
				setWorkingMessage(ctx, message);
				hasWorkingMessage = message !== undefined;
			};
			const reportStartupProgress: KernelBootstrapProgressHandler = (message) => {
				setToolWorkingMessage(message);
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { status: "starting" },
				});
			};

			// Bound each cell so one hang cannot consume the run. Abort drives the
			// kernel's own interrupt, so variables and imports survive.
			const cellTimeoutMs = Number(process.env.HARNESS_CELL_TIMEOUT_MS ?? 0);
			const cellAbort = new AbortController();
			let cellTimedOut = false;
			const forwardAbort = () => cellAbort.abort();
			signal?.addEventListener("abort", forwardAbort, { once: true });
			const cellTimer =
				cellTimeoutMs > 0
					? setTimeout(() => {
							cellTimedOut = true;
							cellAbort.abort();
						}, cellTimeoutMs)
					: undefined;
			try {
				const code = applyShellSettingsToBashMagicCell(params.code, options);
				const { result: r, kernelRestarted } = await executeWithBusyKernelChoice(
					provisioner,
					reportStartupProgress,
					toolCallId,
					code,
					cellAbort.signal,
					(chunk) => {
						onUpdate?.({
							content: [{ type: "text", text: chunk }],
							details: { status: "ok" },
						});
					},
					setToolWorkingMessage,
					options?.onLateSentAgentMessage,
					ctx,
				);

				// The cell has returned, so stop the cell clock HERE rather than in the
				// finally below. Everything after this point is host-side time — the
				// jobs.wait sleep — and letting the timer run through it marked a cell
				// that finished in milliseconds as "INTERRUPTED after 60s" whenever the
				// requested wait exceeded the cell timeout. The agent was told its work
				// had been cut off when it had completed, which is precisely the wrong
				// lesson about the primitive it had just used correctly.
				clearTimeout(cellTimer);
				const cellTimedOutWhileExecuting = cellTimedOut;

				let text = r.stdout;
				// jobs.wait(wake_after=N) — the cell has already returned, so this
				// sleep holds nothing. See runtime/jobs.py.
				const waitMatch = /__HARNESS_WAIT_SECONDS__:(\d+)/.exec(text);
				if (waitMatch) {
					const secs = Math.min(Number(waitMatch[1]), Number(process.env.HARNESS_MAX_WAIT_SECONDS ?? 3600));
					setToolWorkingMessage(`waiting ${secs}s (kernel released)`);
					await new Promise((resolve) => setTimeout(resolve, secs * 1000));
					text = text.replace(waitMatch[0], `[waited ${secs}s outside the kernel]`);
				}
				if (cellTimedOutWhileExecuting) {
					text =
						`[this cell was INTERRUPTED after ${Math.round(cellTimeoutMs / 1000)}s and did not finish. ` +
						`Any output below is partial, and whatever it was computing did NOT complete. ` +
						`Variables bound before this cell are still available. Do not assume this ` +
						`worked. For work that legitimately takes this long, hand it to a job so it ` +
						`outlives the cell:\n` +
						`    jobs.submit('your command', name='pick-a-name')\n` +
						`    jobs.wait(wake_after=120)   # last line of the cell\n` +
						`then jobs.get('pick-a-name') to collect it.]\n\n${text}`;
				}
				if (r.stderr) text += (text ? "\n" : "") + r.stderr;
				if (r.result) text += (text ? "\n" : "") + r.result;
				if (r.status === "error" && r.error) {
					text += (text ? "\n" : "") + r.error.traceback.join("\n");
				}
				if (kernelRestarted) {
					text = text ? `${KERNEL_RESTART_NOTICE}\n\n${text}` : KERNEL_RESTART_NOTICE;
				}

				// See scripts/neutralize-prime.mjs — opt-in kernel state visibility.
				//
				// The largest score gap is redundancy: 29% of MCP calls are byte-identical
				// repeats, because the model cannot see what it already fetched. Telling it to
				// run `%whos` costs a turn and relies on it remembering to look; appending the
				// namespace to every cell result costs a few tokens and no turn.
				//
				//   HARNESS_SHOW_NAMESPACE=1      full namespace after every cell
				//   HARNESS_SHOW_NAMESPACE=delta  only bindings that are new or changed
				//
				// Measured: full beats delta (0.702 vs 0.679) *and* uses fewer total tokens,
				// because the repetition is what keeps the model from re-fetching, and each
				// avoided call saves more context than the listing costs. Delta remains useful
				// if a namespace ever grows large enough for the listing itself to dominate.
				const nsMode = process.env.HARNESS_SHOW_NAMESPACE;
				if (nsMode === "1" || nsMode === "delta") {
					try {
						recordAssignments(code, cwd);
						const names = await provisioner.listNamespaceNames(signal);
						if (names && names.length > 0) {
							const lines = describeNamespace(names);
							if (nsMode === "delta") {
								const fresh = lines.filter((l) => !shownNames.has(l));
								for (const l of lines) shownNames.set(l, l);
								if (fresh.length > 0) {
									text += `${text ? "\n\n" : ""}[now available in the kernel:\n  ${fresh.join("\n  ")}\n]`;
								}
							} else if (lines.length > 0) {
								text += `${text ? "\n\n" : ""}[kernel — already available, do not re-fetch (cells in .cells/):\n  ${lines.join("\n  ")}\n]`;
							}
						}
					} catch {
						// Namespace listing is a convenience; never fail a cell over it.
					}
				}

				const imageBlocks = imageBlocksFromAttachments(r.attachments);
				const content: (TextContent | ImageContent)[] = [{ type: "text", text: text || "" }, ...imageBlocks];

				return {
					content,
					details: {
						durationMs: r.durationMs,
						status: r.status,
						errorEname: r.error?.ename,
						stdout: r.stdout,
						stderr: r.stderr,
						result: r.result,
						diffs: r.diffs,
						attachments: r.attachments,
						sentAgentMessages: r.sentAgentMessages,
						kernelRestarted,
						error: r.error,
					},
					isError: r.status === "error" || r.status === "aborted",
				};
				// Say so explicitly: an interrupted cell otherwise looks like an
				// inscrutable empty failure, and the model needs to know the work was
				// cut off rather than wrong so it can bound the next attempt.
			} finally {
				clearTimeout(cellTimer);
				signal?.removeEventListener("abort", forwardAbort);
				if (hasWorkingMessage) {
					setToolWorkingMessage();
				}
			}
		},
	};
}

export function createIpythonTool(cwd: string, options?: IpythonToolOptions): AgentTool<typeof ipythonSchema> {
	return wrapToolDefinition(createIpythonToolDefinition(cwd, options));
}
