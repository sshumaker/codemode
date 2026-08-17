"""
`spawn` — subagents, as jobs.

    spawn("read every test file and report the 5 that touch auth", name="scout")
    jobs.wait(wake_after=120)          # last statement of the cell
    # ...next turn:
    s = jobs.get("scout")
    if s.done: print(s.result)

Why a job and not an await
--------------------------
docs/DESIGN.md §Subagents originally specified `result = await spawn(prompt)`. That
is wrong for the same reason `time.sleep` is: a blocking await holds this
single-threaded kernel for the child's entire lifetime — minutes — and the cell
watchdog would interrupt it long before the child finished. Subagents are not a
second mechanism parallel to jobs; **they are jobs**, so they inherit durability,
kernel-death recovery, the manifest, the guards and the wait/wake path, all of which
already exist and are tested. `spawn` composes an argv and hands it to
`jobs.submit`; everything after that is the job machinery.

What the child is
-----------------
A real prime-agent process (`dist/bundle/cli.js -p --mode json`) with its own fresh
kernel, not an in-process call. The handoff is serializable in both directions —
a prompt string in, final text plus files out — because sharing the parent's kernel
namespace would destroy token attribution, race on concurrent children, and let a
crashing child corrupt the parent (DESIGN §Subagents).

Who STARTS it, and why that is not this process
-----------------------------------------------
The child is a brain, and a brain holds a real API credential. The architecture
(docs/CLOUD-HARNESS-DESIGN.md §3.3) puts brains harness-side and leaves the sandbox
running python cells only, so `spawn` may not fork the child from the kernel: it
would place a credential-holding model loop inside the sandbox and hand it the
kernel's environment. With the kernel env allow-list in force
(`HARNESS_KERNEL_ENV_ALLOW`, or the older deny-list `HARNESS_KERNEL_ENV_SCRUB`) that
environment no longer has a key at all, and the child fails as a *weak subagent*
rather than as a harness error.

So with `HARNESS_SUBAGENT_BROKER=1` this writes a REQUEST (`jobs.submit(via_broker=
True)`) and `runtime/subagent_broker.py`, running in the loop's world, starts the
child detached. Nothing about the agent-facing surface moves: `spawn` still returns
immediately, and the result still arrives through `jobs.get(name)`, because a
brokered job records itself on disk exactly like any other job.

Two properties fall out of "the child is a separate process":

*   The parent cannot be wedged by a child. `spawn` returns the moment the job is
    recorded; the child's whole lifetime happens outside this kernel.
*   The child survives the parent's kernel. `jobs.get(name)` reaches it from a fresh
    kernel exactly as it reaches any other job.

Definitions
-----------
Which tools a child gets, which model, and its caps travel together, so they are
worth naming once and reusing:

    scout = Agent(tools=["read", "grep", "ls"], max_turns=20, max_cost=0.25)
    spawn("find the auth tests", name="a", agent=scout)
    spawn("find the billing tests", name="b", agent=scout)

`agent=` also accepts a plain dict, which is what an agent reaches for first and
needs no class to exist. Inline keywords override the definition.

Testability
-----------
Everything that touches the world is injected: the JobStore (itself injectable),
the environment mapping, and the resolver that finds node and the CLI. The unit
tests spawn no process and call no model.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from typing import Any, Dict, List, Mapping, Optional, Sequence, Union

import jobs as _jobs
from jobs import Job, JobError

# How many children may be in flight at once. A cap exists because a loop that
# spawns is one keystroke from spawning a hundred, each of which is a real model
# process with a real bill — and unlike a runaway thread, nothing here dies with the
# kernel. The number is deliberately small and the error names the manifest, so the
# fix ("look at what is already running") is the next thing the agent reads.
MAX_CONCURRENT = int(os.environ.get("HARNESS_MAX_SUBAGENTS", "4"))

# Children may not spawn grandchildren in v1. A tree is not a v1 feature: the cost of
# a runaway is multiplicative, the manifest is per-session so a grandchild's jobs are
# invisible to the root, and nothing here has been measured at depth. The child is
# told its depth through the environment and refuses at the point of use.
MAX_DEPTH = int(os.environ.get("HARNESS_SUBAGENT_MAX_DEPTH", "1"))
DEPTH_VAR = "HARNESS_SUBAGENT_DEPTH"

# The child's default tool surface. `ipython` alone is the codemode arm's own
# surface, which is the right default for an experiment whose subject is that
# surface — a child that silently got seven extra tools would not be the arm under
# test.
DEFAULT_TOOLS = os.environ.get("HARNESS_SUBAGENT_TOOLS", "ipython")

# Wall-clock ceiling for a child, enforced by the launcher (SIGALRM) rather than by
# the parent, which is not running while the child is.
DEFAULT_TIMEOUT = int(os.environ.get("HARNESS_SUBAGENT_TIMEOUT", "1800"))

LAUNCHER = "subagent_run.py"

# Set by a harness that runs `runtime/subagent_broker.py` alongside its loop. Off
# by default, because a request nobody services is a job that never starts: the
# runners that stage subagents INSIDE a container (bench/tac/run-task.mjs,
# bench/terminal/prime_agent.py) put the whole brain in there deliberately and
# have no harness side to broker from. The runner that has the split turns it on.
BROKER_VAR = "HARNESS_SUBAGENT_BROKER"

# Environment the child's own kernel needs in order to get the SAME boundary the
# parent's kernel has. Under the broker the child inherits the broker's
# environment, not the kernel's, so anything that defines the sandbox has to
# travel in the spec or the child would quietly run less confined than its parent
# — the one difference that must never appear by accident.
BOUNDARY_VARS = (
    "HARNESS_KERNEL_ENV_ALLOW",
    "HARNESS_KERNEL_ENV_SCRUB",
    "HARNESS_KERNEL_SANDBOX_SETTINGS",
    "HARNESS_KERNEL_SANDBOX_BIN",
)


def _runtime_dir() -> str:
    """Where this module lives. The launcher is its sibling, always."""
    return os.path.dirname(os.path.abspath(__file__))


# ---------------------------------------------------------------------------------
# locating the real agent binary
# ---------------------------------------------------------------------------------
#
# CLAUDE.md: run the real harness, not a reimplementation of it. The child is prime's
# own CLI, so the only question here is where that CLI is on *this* machine — the
# repo checkout on a laptop, the read-only /agent volume inside a task container.
#
# Resolution is explicit and it FAILS LOUDLY. A missing CLI that fell through to
# `node cli.js` would produce a job that exits 127 with "cannot find module", which
# the manifest reports as an ordinary non-zero exit — a plausible number rather than
# an error, which is the failure mode this project keeps paying for.

_CLI_CANDIDATES = (
    "/agent/prime/dist/bundle/cli.js",
    os.path.join(_runtime_dir(), "..", "vendor/prime-agent/packages/coding-agent/dist/cli.js"),
)
_NODE_CANDIDATES = ("/agent/node/bin/node",)


def resolve_cli(env: Mapping[str, str]) -> str:
    explicit = env.get("HARNESS_SUBAGENT_CLI")
    if explicit:
        if not os.path.exists(explicit):
            raise JobError(
                f"HARNESS_SUBAGENT_CLI={explicit!r} does not exist, so no subagent can be started."
            )
        return os.path.abspath(explicit)
    for path in _CLI_CANDIDATES:
        if os.path.exists(path):
            return os.path.abspath(path)
    raise JobError(
        "cannot find the agent CLI, so there is nothing to spawn. Looked at:\n  "
        + "\n  ".join(os.path.abspath(p) for p in _CLI_CANDIDATES)
        + "\nSet HARNESS_SUBAGENT_CLI to the path of prime-agent's dist/bundle/cli.js."
    )


def resolve_node(env: Mapping[str, str]) -> str:
    explicit = env.get("HARNESS_SUBAGENT_NODE")
    if explicit:
        return explicit
    for path in _NODE_CANDIDATES:
        if os.path.exists(path):
            return path
    return "node"  # on PATH; the launcher reports the exec failure with the argv


def resolve_model(env: Mapping[str, str], explicit: Optional[str]) -> str:
    """
    The child's model, which must be *stated* rather than guessed.

    DESIGN §Subagents requires the child to run the same model as the parent, and the
    kernel does not know what the parent is running — the model is a CLI flag on a
    process the kernel is a child of, not an environment variable. Defaulting to a
    hard-coded model would silently confound every cost comparison the moment the
    parent is run on anything else, so an unset model raises here instead.
    """
    model = explicit or env.get("HARNESS_SUBAGENT_MODEL") or env.get("PRIME_MODEL")
    if not model:
        raise JobError(
            "no model for the subagent. Pass model=... to spawn(), or set "
            "HARNESS_SUBAGENT_MODEL in the environment (the harness sets it to the "
            "parent's own model so parent and child are comparable)."
        )
    return model


# ---------------------------------------------------------------------------------
# the definition
# ---------------------------------------------------------------------------------

class Agent:
    """
    A reusable child configuration: tools, model, caps.

    Every field is optional and `None` means "use the default", so a definition can
    carry exactly the part that is worth naming:

        reader = Agent(tools=["read", "grep", "ls"], max_turns=15)
        spawn("summarise docs/DESIGN.md", name="d", agent=reader)
        spawn("summarise docs/TAC-HANDOFF.md", name="t", agent=reader, max_turns=40)

    Args:
        tools: tool names the child may use — a list or a comma-separated string.
            Defaults to `ipython` (the codemode surface). A child given
            `["read", "grep"]` genuinely cannot write files; this is the child's
            whole permission model.
        model: provider/model id, e.g. `anthropic/claude-sonnet-5`. Defaults to
            HARNESS_SUBAGENT_MODEL / PRIME_MODEL, and raises if neither is set.
        max_turns: assistant-turn cap. The child is killed when it is reached and
            its partial result is still collectable.
        max_cost: dollar cap, checked as usage streams in. Same kill semantics.
        timeout: wall-clock seconds for the whole child (default 1800).
        system_prompt: extra text appended to the child's system prompt.
        cwd: working directory for the child. Defaults to the parent's.
    """

    __slots__ = ("tools", "model", "max_turns", "max_cost", "timeout", "system_prompt", "cwd")

    def __init__(
        self,
        *,
        tools: Union[str, Sequence[str], None] = None,
        model: Optional[str] = None,
        max_turns: Optional[int] = None,
        max_cost: Optional[float] = None,
        timeout: Any = None,
        system_prompt: Optional[str] = None,
        cwd: Optional[str] = None,
    ):
        self.tools = tools
        self.model = model
        self.max_turns = max_turns
        self.max_cost = max_cost
        self.timeout = timeout
        self.system_prompt = system_prompt
        self.cwd = cwd

    def __repr__(self) -> str:
        bits = [f"{f}={getattr(self, f)!r}" for f in self.__slots__ if getattr(self, f) is not None]
        return f"Agent({', '.join(bits)})"

    def as_dict(self) -> Dict[str, Any]:
        return {f: getattr(self, f) for f in self.__slots__}

    @classmethod
    def coerce(cls, spec: Union["Agent", Mapping[str, Any], None]) -> "Agent":
        """Accept a definition, a plain dict, or nothing."""
        if spec is None:
            return cls()
        if isinstance(spec, Agent):
            return spec
        if isinstance(spec, Mapping):
            unknown = set(spec) - set(cls.__slots__)
            if unknown:
                raise TypeError(
                    f"unknown agent field(s) {sorted(unknown)}; "
                    f"an agent definition takes {sorted(cls.__slots__)}"
                )
            return cls(**dict(spec))
        raise TypeError(
            f"agent= takes an Agent(...) or a dict of its fields, got {type(spec).__name__}"
        )

    def merge(self, **overrides: Any) -> "Agent":
        """A copy with the non-None overrides applied. Inline keywords win."""
        fields = self.as_dict()
        for key, value in overrides.items():
            if value is not None:
                fields[key] = value
        return Agent(**fields)


def _tool_list(tools: Union[str, Sequence[str], None]) -> str:
    if tools is None:
        return DEFAULT_TOOLS
    if isinstance(tools, str):
        names = [t.strip() for t in tools.split(",")]
    else:
        names = [str(t).strip() for t in tools]
    names = [n for n in names if n]
    if not names:
        raise ValueError(
            "tools= is empty, so the child would have no way to act. Pass at least one "
            "tool name, or leave it out to get the default (%r)." % DEFAULT_TOOLS
        )
    return ",".join(names)


# ---------------------------------------------------------------------------------
# spawning
# ---------------------------------------------------------------------------------

class Subagents:
    """
    The spawner. Holds the store, the environment and the resolvers so a test can
    drive the whole surface without a process, a model call or a real CLI on disk.
    """

    def __init__(
        self,
        store: Optional[_jobs.JobStore] = None,
        *,
        env: Optional[Mapping[str, str]] = None,
        cli: Optional[str] = None,
        node: Optional[str] = None,
        python: Optional[str] = None,
        runtime_dir: Optional[str] = None,
        max_concurrent: int = MAX_CONCURRENT,
        max_depth: int = MAX_DEPTH,
    ):
        self._store_override = store
        self._env = os.environ if env is None else env
        self._cli = cli
        self._node = node
        self._python = python or sys.executable or "python3"
        self._runtime_dir = runtime_dir or _runtime_dir()
        self._max_concurrent = max_concurrent
        self._max_depth = max_depth

    @property
    def store(self) -> _jobs.JobStore:
        # Deliberately not captured at construction: the prelude and the tests both
        # repoint the module-level store, and a spawner holding a stale one would
        # write its jobs somewhere the agent's own `jobs.get` cannot see them.
        return self._store_override if self._store_override is not None else _jobs._store()

    # -- guards ------------------------------------------------------------------

    def depth(self) -> int:
        try:
            return int(self._env.get(DEPTH_VAR, "0") or "0")
        except ValueError:
            return 0

    def _check_depth(self) -> None:
        depth = self.depth()
        if depth >= self._max_depth:
            raise JobError(
                f"this agent is itself a subagent (depth {depth}), and subagents cannot spawn "
                f"subagents. Do the work here, or report back to the parent so it can spawn "
                f"the next one — its final text is what the parent collects."
            )

    def live_children(self) -> List[str]:
        return [
            rec["name"]
            for rec in self.store.list()
            if rec and rec.get("kind") == "subagent" and rec.get("state") in _jobs.LIVE_STATES
        ]

    def brokered(self) -> bool:
        """Whether this harness starts children out here, or in the kernel."""
        return str(self._env.get(BROKER_VAR, "")).strip() == "1"

    def _check_credentials(self) -> None:
        """
        Refuse to fork a brain out of a kernel that has had its credentials taken.

        This is the failure the broker exists to prevent, and it is worth an error
        rather than an attempt: a child spawned from a scrubbed kernel inherits the
        scrubbed environment, so it reaches the provider with no key and dies
        inside its own loop. Measured shape of that (the smoke that motivated the
        sandbox's provider allowance): "Connection error" x3 in the child, every
        mechanism check on the parent's side green — a weak subagent, not a
        harness fault, and nothing says otherwise.

        Named vars only, and only ones the harness itself removed: this must not
        start guessing which environment variable a provider needs.

        Under an allow-list there is no such list to check — the environment was
        BUILT from the allowed names, so what is missing is everything nobody
        named, which cannot be enumerated from in here. That posture is itself
        the answer: a harness that constructs the kernel's environment has
        decided the kernel holds no credentials, and forking a brain out of it
        is the configuration error either way.
        """
        if self.brokered():
            return
        allowed = (self._env.get("HARNESS_KERNEL_ENV_ALLOW") or "").strip()
        if allowed:
            raise JobError(
                "this kernel cannot start a subagent: the harness built its environment "
                f"from an allow-list ({allowed}), so a child started from here would run "
                "without provider credentials and fail inside its own loop.\n"
                "That is a harness configuration problem, not something to work around from a "
                "cell — the harness must run runtime/subagent_broker.py and set "
                f"{BROKER_VAR}=1. Report it and do the work here instead."
            )
        scrubbed = [n.strip() for n in
                    (self._env.get("HARNESS_KERNEL_ENV_SCRUB") or "").split(",") if n.strip()]
        missing = [n for n in scrubbed if not self._env.get(n)]
        if missing:
            raise JobError(
                f"this kernel cannot start a subagent: the harness removed {', '.join(missing)} "
                f"from its environment, so a child started from here would run without "
                f"credentials and fail inside its own loop.\n"
                f"That is a harness configuration problem, not something to work around from a "
                f"cell — the harness must run runtime/subagent_broker.py and set "
                f"{BROKER_VAR}=1. Report it and do the work here instead."
            )

    def _check_concurrency(self) -> None:
        live = self.live_children()
        if len(live) >= self._max_concurrent:
            raise JobError(
                f"{len(live)} subagents are already running ({', '.join(live)}) and the limit is "
                f"{self._max_concurrent}. `print(jobs.manifest())` to see them; collect one with "
                f"jobs.get(name) or stop one with jobs.kill(name) before spawning another."
            )

    # -- the surface -------------------------------------------------------------

    def spawn(
        self,
        prompt: Any,
        name: Optional[str] = None,
        *,
        agent: Union[Agent, Mapping[str, Any], None] = None,
        tools: Union[str, Sequence[str], None] = None,
        model: Optional[str] = None,
        max_turns: Optional[int] = None,
        max_cost: Optional[float] = None,
        timeout: Any = None,
        system_prompt: Optional[str] = None,
        cwd: Optional[str] = None,
    ) -> Job:
        if callable(prompt):
            raise TypeError(
                "spawn takes a prompt STRING, not a callable. The child is a separate "
                "process with its own kernel, so nothing in this namespace reaches it — "
                "say what you want in words, and read the answer back from its result."
            )
        if not isinstance(prompt, str) or not prompt.strip():
            raise TypeError(
                "spawn(prompt, name=...) needs a non-empty prompt describing the whole "
                "subtask. The child sees this text and nothing else — not your variables, "
                "not your files-in-progress, not the conversation so far."
            )
        if not name or not isinstance(name, str) or not name.strip():
            raise TypeError(
                "spawn requires name=. It is the child's durable identity: what appears in "
                "jobs.manifest(), what jobs.get(name) takes, and how its result is found "
                "after a kernel restart. e.g. spawn(prompt, name='scout')."
            )
        name = name.strip()

        self._check_depth()
        self._check_credentials()
        self._check_concurrency()

        cfg = Agent.coerce(agent).merge(
            tools=tools,
            model=model,
            max_turns=max_turns,
            max_cost=max_cost,
            timeout=timeout,
            system_prompt=system_prompt,
            cwd=cwd,
        )
        spec = self._build_spec(name, prompt, cfg)

        os.makedirs(spec["child_dir"], exist_ok=True)
        spec_path = os.path.join(spec["child_dir"], "spec.json")
        with open(spec_path, "w") as fh:
            json.dump(spec, fh, indent=2)

        # The command is three tokens and a path. Every string the child needs — the
        # prompt, the system prompt, the environment — travels in the spec file, so
        # nothing is quoted into a shell twice. Escaping a multi-line prompt through
        # a shell string is precisely what mangled a patch earlier in this project
        # (CLAUDE.md, scripts/patches).
        command = " ".join(
            shlex.quote(x)
            for x in (self._python, os.path.join(self._runtime_dir, LAUNCHER), spec_path)
        )
        return self.store.submit(
            command,
            name=name,
            max_runtime=spec["timeout"],
            expect="once",
            cwd=spec["cwd"],
            kind="subagent",
            # The only line where the architecture shows through. Everything else
            # — the argv, the spec, the caps, the collection — is identical either
            # way, which is the point: what moved is who forks the child.
            via_broker=self.brokered(),
            meta={
                "model": spec["model"],
                "tools": spec["tools"],
                "prompt": prompt,
                "result": spec["result"],
                "transcript": spec["transcript"],
                "meta_path": spec["meta"],
                "stderr": spec["stderr"],
                "max_turns": spec["max_turns"],
                "max_cost": spec["max_cost"],
                "depth": self.depth() + 1,
                "argv": spec["argv"][:-1] + ["<prompt>"],
            },
        )

    # -- argv composition --------------------------------------------------------

    def _build_spec(self, name: str, prompt: str, cfg: Agent) -> Dict[str, Any]:
        env = self._env
        cli = self._cli or resolve_cli(env)
        node = self._node or resolve_node(env)
        model = resolve_model(env, cfg.model)
        tools = _tool_list(cfg.tools)
        cwd = cfg.cwd or env.get("HARNESS_JOB_CWD") or self.store._cwd

        job_dir = self.store.job_dir
        child_dir = os.path.join(job_dir, f"{name}.d")

        appended: List[str] = []
        inherited = self._inherited_prompt(tools)
        if inherited:
            appended.append(inherited)
        if cfg.system_prompt:
            appended.append(cfg.system_prompt)

        argv = [
            node,
            cli,
            "-p",
            "--mode",
            "json",
            "--model",
            model,
            "--tools",
            tools,
            "--cwd",
            cwd,
            "--no-context-files",
            "--no-prompt-templates",
            "--no-extensions",
            # Per-child daemon socket. Without it the CLI reuses a GLOBAL daemon:
            # the first child ever spawned auto-starts one from inside ITS
            # sandbox, it outlives the run, and every later child's writes then
            # happen in a process confined to the wrong run's write scope.
            # Measured: smoke2's child got "EPERM mkdir <its own run dir>" from
            # daemon-errors.js because smoke1's daemon was still serving.
            "--daemon-socket",
            os.path.join(child_dir, "daemon.sock"),
        ]
        for text in appended:
            argv += ["--append-system-prompt", text]
        # Turn caps are enforced by the launcher, not by `--autonomous-max-turns`:
        # that flag only applies under `--autonomous`, and print mode is not
        # autonomous mode. Enforcing it where the stream is already being read means
        # one mechanism for both caps, and the same one the benchmark runners use
        # (bench/run-task.mjs enforceBudget).
        argv.append(prompt)

        return {
            "name": name,
            "argv": argv,
            "cwd": cwd,
            "model": model,
            "tools": tools,
            "max_turns": int(cfg.max_turns) if cfg.max_turns else None,
            "max_cost": float(cfg.max_cost) if cfg.max_cost else None,
            "timeout": _jobs.parse_duration(cfg.timeout) if cfg.timeout is not None else DEFAULT_TIMEOUT,
            "env": self._child_env(child_dir),
            # The result sits beside the job's own log, because it is what the parent
            # reads and `<name>.result.txt` next to `<name>.log` is guessable from an
            # `ls`. Everything else goes UNDER `<name>.d/`, and that is not tidiness:
            # JobStore._all() treats every `*.json` in the job directory as a job
            # record, so a `<name>.meta.json` sibling was read back as a job called
            # "<name>.meta" and `jobs.manifest()` raised KeyError('started_at') — the
            # manifest, the prelude's startup announcement and `jobs.list()` all
            # broken by a file that merely shared a suffix. Caught by a test; it would
            # have looked like a jobs bug, not a subagent one.
            "result": os.path.join(job_dir, f"{name}.result.txt"),
            "transcript": os.path.join(child_dir, "stream.jsonl"),
            "meta": os.path.join(child_dir, "meta.json"),
            "stderr": os.path.join(child_dir, "stderr.txt"),
            "child_dir": child_dir,
        }

    def _child_env(self, child_dir: str) -> Dict[str, str]:
        """
        What the child's environment must differ in. Everything else is inherited.

        The two overrides that matter are both about not sharing durable state: the
        child gets its own job directory (or `jobs.submit(name='build')` in the child
        collides with the parent's `build`, which is the exact cross-talk
        `_default_job_dir` exists to prevent) and its own agent home. The depth
        counter is what makes the grandchild guard work at all — the child reads it
        from here.

        The boundary variables are carried for a different reason. Under the broker
        the child's environment comes from the BROKER's process, not from this
        kernel, so the sandbox settings and the env scrub that confine the parent's
        kernel would not reach the child's unless they travel in the spec. A child
        whose kernel is less confined than its parent's is the one divergence that
        must never appear by accident — the child runs model-authored code too.
        """
        env = {
            DEPTH_VAR: str(self.depth() + 1),
            "HARNESS_JOB_DIR": os.path.join(child_dir, "jobs"),
            "HARNESS_JOB_CWD": "",  # inherit the child's own --cwd
            "PRIME_AGENT_CODING_AGENT_DIR": os.path.join(child_dir, "agent-home"),
            "HARNESS_PRELUDE_MARKER": os.path.join(child_dir, "prelude-status.txt"),
        }
        for var in BOUNDARY_VARS:
            value = self._env.get(var)
            if value:
                env[var] = value
        return env

    def _inherited_prompt(self, tools: str) -> str:
        """
        Give a child with a kernel the same jobs guidance its parent has.

        Not politeness: the prelude is installed per-IPYTHONDIR, so a child running
        `ipython` gets the guards whether or not it gets the guidance — and a guarded
        agent with no guidance is the measured worst case. On TheAgentCompany, the
        runtime staged without its prompt took a run from 43 turns to 198 and $0.67
        to $3.32, because suppressing the bad wait without teaching the good one
        converts a kernel-holding problem into a turn-burning one.

        The subagent section is deliberately NOT included: the child cannot spawn.
        """
        if "ipython" not in tools.split(","):
            return ""
        ipython_dir = self._env.get("IPYTHONDIR")
        if not ipython_dir:
            return ""
        startup = os.path.join(ipython_dir, "profile_default", "startup")
        try:
            staged = any(f.endswith(".py") for f in os.listdir(startup))
        except OSError:
            staged = False
        return _jobs.PROMPT if staged else ""


# ---------------------------------------------------------------------------------
# module-level surface
# ---------------------------------------------------------------------------------

_default: Optional[Subagents] = None


def _spawner() -> Subagents:
    global _default
    if _default is None:
        _default = Subagents()
    return _default


def use_spawner(spawner: Subagents) -> None:
    """Point the module-level `spawn` at another spawner. Tests and the prelude."""
    global _default
    _default = spawner


def spawn(prompt: str, name: Optional[str] = None, **kw: Any) -> Job:
    """
    Start a subagent on a self-contained subtask. Returns immediately.

    The child is a real agent process with its own fresh kernel and its own context.
    It receives `prompt` and nothing else — not this namespace, not the conversation
    so far — and hands back its final text plus whatever it wrote to disk. That is
    the whole handoff, in both directions.

    Because it is a job, it does not block: `spawn` returns as soon as the child is
    recorded, and the child outlives this cell and this kernel.

        spawn("read every file under tests/ and report the 5 that touch auth, "
              "with one line each on what they cover", name="scout")
        jobs.wait(wake_after=180)          # LAST statement of the cell
        # ...you are called again afterwards:
        s = jobs.get("scout")
        if s.done and s.ok:
            print(s.result)                # the child's final text
        else:
            print(s.state, s.reason)

    Args:
        prompt: the whole subtask, in words. Self-contained: name the files, the
            directory, the question, and what the answer should look like.
        name: REQUIRED. The child's durable identity — what `jobs.manifest()` lists,
            what `jobs.get(name)` takes, and how its result is found after a kernel
            restart.
        agent: a reusable `Agent(...)` definition or a dict of the same fields.
            Inline keywords below override it.
        tools: which tools the child may use, e.g. `["read", "grep", "ls"]` for a
            read-only scout or `["ipython"]` (the default) for one that computes.
            This is the child's entire permission model.
        model: provider/model id. Defaults to the harness's HARNESS_SUBAGENT_MODEL
            so parent and child are comparable; raises if neither is set.
        max_turns: assistant-turn cap. The child is stopped there and its partial
            work is still collectable.
        max_cost: dollar cap, applied as the child's usage streams in.
        timeout: wall-clock ceiling, default 30m. Accepts "10m", "1h", 600.
        system_prompt: extra text appended to the child's system prompt.
        cwd: the child's working directory. Defaults to yours.

    Returns:
        A Job whose `.result` is the child's final text once `.done`, `.transcript`
        the path to its full JSON trajectory, and `.cost` / `.turns` its usage.
        `.output` is the job log: a header, one line per turn, then the final text.

    Raises:
        TypeError: no prompt, or no name.
        JobError: the concurrency cap is reached, this agent is itself a subagent,
            no model is configured, or the agent CLI cannot be found.

    When to use it:
        A subtask that is self-contained, that can run while you do something else,
        or whose intermediate reading would swamp your own context — "explore this
        repo and report the five relevant files" is the canonical case. NOT for work
        that needs your variables, your half-finished edits, or the conversation so
        far: none of that reaches the child.
    """
    return _spawner().spawn(prompt, name, **kw)


def list_subagents() -> List[dict]:
    """Every subagent this session has started, newest state, as records."""
    return [r for r in _jobs.list() if r and r.get("kind") == "subagent"]


# ---------------------------------------------------------------------------------
# telling the model this exists
# ---------------------------------------------------------------------------------
#
# Three lines resident, for the same reason jobs.PROMPT is short: it is re-billed on
# every turn of every task, including the ones with no subtask in them. Name the
# capability, say the one thing that is not guessable (name= is required), and say
# WHEN — because the failure mode here is not misuse of the API, it is delegating
# work that needed the parent's state, and no error can catch that after the fact.
#
# The mechanics (collection, caps, definitions) stay in the docstring and in
# api/subagents.md, which cost nothing until read.

PROMPT = """\
## Subagents

`spawn(prompt, name=...)` starts a child agent on a subtask and returns immediately —
it is a job, so you collect it exactly like one:

    spawn("read every file under tests/ and report the 5 that touch auth",
          name="scout", tools=["read", "grep", "ls"])
    jobs.wait(wake_after=180)      # LAST statement of the cell
    print(jobs.get("scout").result)    # next turn: the child's final text

name= is required. The child is a separate process with a fresh kernel: it sees your
prompt and nothing else. Delegate a subtask that is self-contained, that can run
while you work, or whose reading would swamp your context; do NOT delegate anything
that needs your variables, your edits in progress, or this conversation.\
"""


HELP = """\
spawn — subagents, as jobs

  spawn(prompt, name=..., agent=None, tools=None, model=None,
        max_turns=None, max_cost=None, timeout=None, system_prompt=None, cwd=None)

A child agent
    spawn("read every file under tests/ and report the 5 that touch auth, one line "
          "each on what they cover", name="scout", tools=["read", "grep", "ls"])
    jobs.wait(wake_after=180)          # last line; the kernel is released
    # ... next turn:
    s = jobs.get("scout")
    if s.done and s.ok:
        print(s.result)                # the child's final text

A subagent IS a job
    Same manifest, same jobs.get / jobs.kill, same survival across a kernel restart.
    spawn() returns the moment the child is recorded — it never blocks — and the
    child runs in its own process with its own fresh kernel.

    .result      the child's final text            .transcript  path to its full JSON stream
    .turns       assistant turns it took           .cost        dollars it spent
    .output      the job log: header, one line per turn, then the final text
    .done .ok .state .reason .exit_code            as for any job

Reusable definitions
    scout = Agent(tools=["read", "grep", "ls"], max_turns=20, max_cost=0.25)
    spawn("find the auth tests",    name="a", agent=scout)
    spawn("find the billing tests", name="b", agent=scout, max_turns=40)

    agent= also takes a plain dict. Inline keywords override the definition.

    tools        which tools the child may use — its whole permission model.
                 Default "ipython". A child given ["read","grep"] cannot write.
    model        defaults to the parent's model via HARNESS_SUBAGENT_MODEL
    max_turns    turn cap; the child is stopped and its partial work kept
    max_cost     dollar cap, applied as usage streams in
    timeout      wall clock, default 30m ("10m", "1h", 600 all work)

The handoff is serializable, both ways
    In: the prompt string. Out: the final text, plus whatever the child wrote to
    disk. The child does NOT share your kernel namespace — that would race between
    concurrent children and let a crashing child corrupt you. So a subtask that
    needs your variables or your half-finished edits is not a subagent task.

Limits
    At most 4 children in flight (HARNESS_MAX_SUBAGENTS); the error lists what is
    already running. A subagent cannot spawn subagents — it reports back instead.\
"""


def help() -> str:  # noqa: A001 - deliberately shadows builtins inside the kernel
    """The full surface and the idioms, printed on demand."""
    print(HELP)
    return HELP


# ---------------------------------------------------------------------------------
# the same capability, for a harness that is not Python
# ---------------------------------------------------------------------------------
#
# DESIGN §Subagents: both arms get subagents, "sharing one implementation, so only
# the invocation surface differs" — codemode calls `spawn()` in the kernel, vanilla
# calls a `task` tool. The fairness rule (§"one source, two renderings") makes that
# load-bearing rather than tidy: if the vanilla tool composed its own argv, the two
# arms would be running different children under one name, and the experiment would
# be measuring that difference.
#
# So the tool shells out to these two verbs. The child, the caps, the environment,
# the guards and the job record are then identical by construction.
#
#   subagents.py --spawn --name scout --tools read,grep --prompt-file p.txt
#   subagents.py --collect --name scout
#
# Both print one line of JSON, because the caller is a program.

def _cli(argv: List[str]) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="subagents.py", add_help=False)
    parser.add_argument("--prompt", action="store_true")
    parser.add_argument("--docs", action="store_true")
    parser.add_argument("--spawn", action="store_true")
    parser.add_argument("--collect", action="store_true")
    parser.add_argument("--name")
    parser.add_argument("--prompt-file")
    parser.add_argument("--prompt-text")
    parser.add_argument("--tools")
    parser.add_argument("--model")
    parser.add_argument("--max-turns", type=int)
    parser.add_argument("--max-cost", type=float)
    parser.add_argument("--timeout")
    parser.add_argument("--cwd")
    args, _unknown = parser.parse_known_args(argv)

    if args.prompt:
        print(PROMPT)
        return 0
    if args.docs:
        print(f"# spawn (subagents)\n\nAvailable in every cell as `spawn`; no import "
              f"needed.\n\n```\n{HELP}\n```")
        return 0

    if args.spawn or args.collect:
        # stdout is the JSON channel and nothing else may write to it. The default
        # store emits "submitted <name> (pid ...)" through `print`, which is right
        # for a kernel — the agent reads it — and wrong here: it prepended a line of
        # prose to the payload and the caller's JSON.parse failed on a spawn that
        # had in fact succeeded. Diagnostics go to stderr.
        _jobs.use_store(_jobs.JobStore(
            _jobs.DEFAULT_JOB_DIR, emit=lambda m: print(m, file=sys.stderr)))

    if args.spawn:
        # The prompt comes through a FILE by default. It is multi-line free text
        # written by a model, and a shell is the one place in this path where that
        # could be re-parsed.
        if args.prompt_file:
            with open(args.prompt_file) as fh:
                text = fh.read()
        else:
            text = args.prompt_text or ""
        try:
            job = spawn(
                text, args.name, tools=args.tools, model=args.model,
                max_turns=args.max_turns, max_cost=args.max_cost,
                timeout=args.timeout, cwd=args.cwd,
            )
        except (TypeError, ValueError, JobError) as exc:
            # A refusal is a RESULT, not a crash: the caller is a tool wrapper that
            # has to hand the reason back to its model, and a traceback on stderr
            # would arrive as an opaque non-zero exit.
            print(json.dumps({"ok": False, "error": str(exc)}))
            return 1
        rec = _jobs._store()._read(job.name) or {}
        print(json.dumps({"ok": True, "name": job.name, "state": job.state,
                          "log": rec.get("log"),
                          "result": (rec.get("meta") or {}).get("result"),
                          "transcript": (rec.get("meta") or {}).get("transcript")}))
        return 0

    if args.collect:
        job = _jobs.get(args.name)
        if job is None:
            print(json.dumps({"ok": False, "error": f"no subagent named {args.name!r}"}))
            return 1
        out = {"ok": True, "name": args.name, "state": job.state, "done": job.done,
               "exitCode": job.exit_code, "reason": job.reason}
        if isinstance(job, _jobs.Subagent):
            out.update({"result": job.result, "turns": job.turns, "cost": job.cost,
                        "toolCalls": job.tool_calls, "transcript": job.transcript})
        print(json.dumps(out))
        return 0

    print(__doc__)
    print("usage: subagents.py [--prompt | --docs]\n"
          "       subagents.py --spawn --name N (--prompt-file F | --prompt-text T) "
          "[--tools T] [--model M] [--max-turns N] [--max-cost C] [--timeout T] [--cwd D]\n"
          "       subagents.py --collect --name N")
    return 2


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
