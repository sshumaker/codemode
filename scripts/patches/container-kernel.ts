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
	/** base64 PNGs from display() calls or a renderable last expression. */
	images?: string[];
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
	/** Set when a torn-down session means the next cell starts with an empty namespace. */
	restarted = false;

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
				this.restarted = true;
				done?.({
					ok: false,
					stdout: "",
					stderr: "",
					repr: null,
					names: [],
					images: [],
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
				this.restarted = true;
				resolve({ ok: false, stdout: "", stderr: "", repr: null, names: [], images: [], error: "aborted" });
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

			// The model is multimodal; a rendered crop or chart is often the whole
			// answer on a document task. Dropping these was the single largest
			// self-inflicted handicap in this harness.
			const imageBlocks: ImageContent[] = (r.images ?? []).map((data) => ({
				type: "image",
				source: { type: "base64", media_type: "image/png", data },
			}));

			// A restarted session silently empties the namespace. Telling the model
			// is the difference between it rebuilding state and it reasoning over
			// variables that no longer exist.
			if (active.restarted && r.ok) {
				active.restarted = false;
				text = `[the kernel restarted — variables, imports and open resources from before are gone; recreate anything you still need]\n\n${text}`;
			}

			return {
				content: [{ type: "text", text: text || "" }, ...imageBlocks],
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
