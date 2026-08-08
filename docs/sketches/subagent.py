"""Subagents as processes — API sketch.

Design rule: every shape here must already exist in pretraining. `spawn` is
`subprocess.Popen`-shaped, the context manager is the standard cleanup idiom,
and `async for` is the standard streaming idiom. Nothing bespoke.

Underneath, each subagent is a real child process running the same harness
binary, so `--tools` makes the child inherit the parent's arm automatically:

    prime-agent -p --mode json --tools <arm> --autonomous-max-tokens N <prompt>
"""


async def run(prompt: str, *, name: str, model: str | None = None,
              tools: str | None = None, max_tokens: int | None = None,
              timeout: float | None = None) -> str:
    """Run a subagent to completion and return its final response.

    The blocking convenience form. Use `spawn` instead when you need to steer
    the subagent mid-run, stream its output, or run several concurrently.

    Args:
        prompt: The task for the subagent. Self-contained — the child does not
            inherit the parent's conversation or kernel namespace.
        name: Short descriptive label, e.g. "test-fixer". Required. Appears in
            `ps`, in `list_subagents()`, and in completion notifications.
        model: Provider/model selector. Defaults to the parent's model.
        tools: Tool registry for the child. Defaults to the parent's arm.
        max_tokens: Token budget. The child is killed when it is exceeded.
        timeout: Wall-clock limit in seconds. Raises TimeoutError on expiry.

    Returns:
        The subagent's final assistant message.

    Raises:
        SubagentError: The child exited non-zero or exceeded its budget.
        TimeoutError: `timeout` elapsed before completion.

    Example:
        >>> summary = await run("summarize the failing tests in ./tests",
        ...                     name="test-summary")
    """


def spawn(prompt: str, *, name: str, model: str | None = None,
          tools: str | None = None, max_tokens: int | None = None) -> "Subagent":
    """Start a subagent and return a handle without waiting for it.

    You do not need to poll. When the child finishes or stops, a one-line
    notification arrives at the top of your next turn naming it and pointing at
    its session directory; read that directory only if you need the detail.

    Prefer the context-manager form, which guarantees the child is reaped even
    if the parent's cell raises:

        async with spawn("run the migration") as a:
            async for event in a:
                if event.type == "tool_call":
                    await a.send("skip the destructive ones")
            result = await a.result()

    Concurrent fan-out is ordinary asyncio:

        agents = [spawn(p, name=f"worker-{i}") for i, p in enumerate(prompts)]
        results = await asyncio.gather(*(a.result() for a in agents))

    Args: see `run`.

    Returns:
        A `Subagent` handle. The child is already running on return.
    """


class Subagent:
    """A running subagent process.

    Handles are *not* durable across kernel restarts: the child process
    outlives the variable referencing it. Each subagent writes a pidfile and
    session directory under the agent run root, so a handle lost to a kernel
    reset can be recovered with `attach(pid)` rather than orphaned.
    """

    name: str
    pid: int
    session_dir: str
    returncode: int | None

    async def send(self, text: str) -> None:
        """Queue feedback for the subagent's next turn.

        This is a mailbox, not a stream. Text is buffered and delivered whole
        as a single user message at the top of the child's next turn — it does
        not interrupt a turn in progress. Call `stop` for that.
        """

    async def result(self) -> str:
        """Wait for completion and return the final assistant message."""

    async def stop(self, *, grace: float = 5.0) -> None:
        """Interrupt the subagent.

        Sends SIGINT to let the child checkpoint its session, then SIGKILL to
        the process group after `grace` seconds.
        """

    def __aiter__(self):
        """Stream the child's events as they arrive (JSON event stream)."""


async def attach(pid: int) -> Subagent:
    """Reattach to a subagent whose handle was lost to a kernel restart.

    List recoverable children with `list_subagents()`.
    """


async def list_subagents() -> list[Subagent]:
    """Return all live subagents spawned by this agent run, including orphans."""
