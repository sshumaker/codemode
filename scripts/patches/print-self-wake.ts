/**
 * Harness: a print run that ends waiting, with nothing outside it to wake it, wakes
 * itself.
 *
 * `jobs.wait` ends the turn (scripts/neutralize-prime.mjs). Under the scheduler
 * (HARNESS_WAKE_FILE, HARNESS_WAIT_MODE=exit) the process exits and
 * runtime/scheduler.py re-invokes it; an RPC host arms its own wake from `agent_end`.
 * A bare `-p` run has neither, and ending it at the first wait would silently end
 * the task — so print mode plays the scheduler's part in-process: it waits for the
 * same wake sources, then opens a new turn with the same `[woken: …]` message.
 *
 * The wake decision is runtime/scheduler.py's own (`--reason-for-request`, polled),
 * when HARNESS_RUNTIME_DIR names it; otherwise only the deadline wakes, which is
 * what the old in-tool sleep did. HARNESS_PRINT_SELF_WAKE=0 turns it off.
 */
interface HarnessAgentEnd {
	stopReason?: string;
	wait?: { seconds?: number; wakeAtMs?: number; request?: Record<string, unknown> };
}

function harnessPrintShouldSelfWake(): boolean {
	const mode = process.env.HARNESS_WAIT_MODE;
	return (
		process.env.HARNESS_PRINT_SELF_WAKE !== "0" && !process.env.HARNESS_WAKE_FILE && mode !== "exit" && mode !== "wake"
	);
}

async function harnessAskScheduler(request: Record<string, unknown>): Promise<string | null | undefined> {
	const runtimeDir = process.env.HARNESS_RUNTIME_DIR;
	if (!runtimeDir) return undefined;
	return new Promise((resolve) => {
		const child = spawnChild("python3", [joinPath(runtimeDir, "scheduler.py"), "--reason-for-request", "--consume"], {
			cwd: runtimeDir,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let out = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => {
			if (code !== 0) return resolve(undefined);
			try {
				const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { message?: string | null };
				resolve(parsed.message ?? null);
			} catch {
				resolve(undefined);
			}
		});
		child.stdin.end(JSON.stringify(request));
	});
}

/** The opening message of the woken turn: the scheduler's, or the deadline's. */
async function harnessAwaitWake(wait: NonNullable<HarnessAgentEnd["wait"]>): Promise<string> {
	const seconds = Number(wait.seconds ?? 0);
	const deadline = wait.wakeAtMs ?? Date.now() + seconds * 1000;
	const pollMs = Number(process.env.HARNESS_SELF_WAKE_POLL_MS ?? 2000);
	let schedulerUsable = Boolean(wait.request);
	while (Date.now() < deadline) {
		if (schedulerUsable && wait.request) {
			const message = await harnessAskScheduler(wait.request);
			if (message === undefined) schedulerUsable = false;
			else if (message) return message;
		}
		const remaining = deadline - Date.now();
		await new Promise((resolve) => setTimeout(resolve, Math.max(0, schedulerUsable ? Math.min(pollMs, remaining) : remaining)));
	}
	return `[woken: the requested wait of ${seconds}s elapsed] Check your jobs and continue the task.`;
}

async function harnessPrintSelfWake(
	connection: AgentConnection,
	takeWaitingEnd: () => HarnessAgentEnd | undefined,
): Promise<void> {
	if (!harnessPrintShouldSelfWake()) return;
	for (let end = takeWaitingEnd(); end?.wait; end = takeWaitingEnd()) {
		await connection.promptAndWait(await harnessAwaitWake(end.wait));
	}
}
