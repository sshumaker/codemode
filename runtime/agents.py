"""
`agents` — the subagent surface a model is taught.

    a = agents.spawn("research topic A ...", name="a")
    b = agents.spawn("research topic B ...", name="b")
    jobs.wait([a, b], wake_after="10m")          # LAST statement: the turn ends
    # ...resumed when both finish, when either messages you, or at the deadline:
    print(a.result, a.messages)
    a.send("also check 2025", mode="follow_up")  # redirect a running child

A child runs as a job (see subagents.py for why it is a process, not an await), so
`jobs.wait` is how a parent waits for one and `jobs.get(name)` still finds it. What
only an agent has — talking to it while it runs — lives here, on the handle
`agents.spawn` and `agents.get` return, and never on a job handle: jobs also cover
shell commands and submitted work, which cannot be spoken to.

In a child's kernel `agents` is the other end of the same conversation:

    agents.report("found 3 candidates so far; checking pricing next")   # non-blocking
    answer = agents.ask_parent("which date range: 2024 or 2025?")      # blocks, bounded
    if answer is None: ...                                               # no answer in time

A child cannot spawn (the depth limit is enforced by whatever starts children, not
only here), cannot reach the user, and talks to its siblings only when the harness
sets HARNESS_SUBAGENT_SIBLINGS=1.

Two transports, one surface. The file transport (a child forked here, or started by
`runtime/subagent_broker.py`) keeps the conversation in the child's mailbox
directory (`runtime/agent_mailbox.py`), which the child's launcher pumps into its
prime RPC process. The host transport (a remote kernel; the assistant gateway) sends
the same operations as `harness.subagent` host requests and the broker routes them.
"""

from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, List, Optional

import agent_mailbox as _mail
import jobs as _jobs
import subagents as _sub
from jobs import JobError

SIBLINGS_VAR = "HARNESS_SUBAGENT_SIBLINGS"
SELF_DIR_VAR = "HARNESS_SUBAGENT_SELF_DIR"
SELF_NAME_VAR = "HARNESS_SUBAGENT_NAME"
PARENT_JOB_DIR_VAR = "HARNESS_SUBAGENT_PARENT_JOB_DIR"

ASK_DEFAULT_SECONDS = int(os.environ.get("HARNESS_ASK_PARENT_SECONDS", "600"))
ASK_POLL_SECONDS = float(os.environ.get("HARNESS_ASK_PARENT_POLL", "1.0"))


def _raise(exc: Exception) -> None:
    if isinstance(exc, _mail.MailboxError):
        raise JobError(str(exc)) from None
    raise exc


class Message(dict):
    """One message in either direction: `.direction` (to_child / from_child), `.kind`, `.text`."""

    __getattr__ = dict.get

    def __repr__(self) -> str:
        arrow = "->" if self.get("direction") == "to_child" else "<-"
        return f"<{arrow} {self.get('kind')}: {str(self.get('text') or '')[:80]!r}>"


# ---------------------------------------------------------------------------------
# the parent's view of one child
# ---------------------------------------------------------------------------------


class _FileBackend:
    """A child whose mailbox is a directory this kernel can read."""

    def __init__(self, store: _jobs.JobStore, sender: str = "parent"):
        self._store = store
        self._sender = sender

    def job(self, name: str) -> Optional[_jobs.Job]:
        return self._store.get(name)

    def mailbox(self, name: str) -> _mail.Mailbox:
        rec = self._store._read(name) or {}
        box = (rec.get("meta") or {}).get("child_dir")
        if not box:
            raise JobError(f"{name!r} is not a subagent, so it has no mailbox.")
        return _mail.Mailbox(box)

    def messages(self, name: str) -> List[Dict[str, Any]]:
        box = self.mailbox(name)
        out = box.messages()
        if self._sender == "parent":
            box.mark_read()
        return out

    def unread(self, name: str) -> int:
        try:
            return self.mailbox(name).unread()
        except JobError:
            return 0

    def send(self, name: str, text: str, mode: str) -> Dict[str, Any]:
        job = self.job(name)
        if job is None or job.done:
            raise JobError(
                f"{name} has already finished, so nothing can reach it. Start a new agent if there is more to do."
            )
        try:
            return self.mailbox(name).send(text, mode, sender=self._sender)
        except _mail.MailboxError as exc:
            raise JobError(str(exc)) from None

    def names(self) -> List[str]:
        return [r["name"] for r in self._store.list(external=False) if r and r.get("kind") == "subagent"]


class _HostBackend:
    """A child the loop's broker runs: every operation is a host request."""

    def __init__(self, client: "_sub.HostSubagents"):
        self._client = client

    def job(self, name: str) -> Optional[_jobs.Job]:
        rec = self._client.one(name)
        return None if rec.get("state") == "missing" else _sub.HostSubagent(name, self._client, rec)

    def messages(self, name: str) -> List[Dict[str, Any]]:
        reply = self._client.request({"op": "messages", "name": name})
        return [m for m in reply.get("messages") or [] if isinstance(m, dict)]

    def unread(self, name: str) -> int:
        return int(self._client.one(name).get("unread") or 0)

    def send(self, name: str, text: str, mode: str) -> Dict[str, Any]:
        _mail.check_text(text)
        _mail.check_mode(mode)
        return self._client.request({"op": "send", "name": name, "text": text, "mode": mode})

    def names(self) -> List[str]:
        return [c.get("name") for c in self._client.children() if c.get("name")]


class AgentHandle:
    """
    A running (or finished) subagent: what it is doing, what it said, and a way to
    reach it. Returned by `agents.spawn` and `agents.get`.

        .name .model .state .done .ok .result .reason .cost .turns .transcript
        .messages      what it reported or asked, and what you sent it, oldest first
        .send(text, mode="follow_up" | "steer")
        .wait(wake_after=...)   same as jobs.wait(<this agent>, wake_after=...)

    `.result` is the child's final answer, and empty until it has finished.
    """

    __slots__ = ("name", "_backend")

    def __init__(self, name: str, backend: Any):
        self.name = name
        self._backend = backend

    def _job(self) -> _jobs.Job:
        job = self._backend.job(self.name)
        if job is None:
            raise JobError(f"no agent named {self.name!r} any more.")
        return job

    def __getattr__(self, attr: str) -> Any:
        # Everything else a job handle has (.output, .exit_code, .tool_calls ...),
        # so code written against spawn() returning a job keeps working.
        if attr.startswith("_") or attr in ("send",):
            raise AttributeError(attr)
        return getattr(self._job(), attr)

    def __repr__(self) -> str:
        try:
            job = self._job()
            extra = f" {job.turns} turns ${job.cost or 0:.4f}" if job.turns else ""
            return f"<Agent {self.name} {job.state} on {job.model or '?'}{extra}>"
        except JobError:
            return f"<Agent {self.name} missing>"

    @property
    def model(self) -> str:
        return self._job().model

    @property
    def state(self) -> str:
        return self._job().state

    @property
    def done(self) -> bool:
        return self._job().done

    @property
    def ok(self) -> bool:
        return self._job().ok

    @property
    def result(self) -> str:
        job = self._job()
        return job.result if job.done else ""

    @property
    def reason(self) -> Optional[str]:
        return self._job().reason

    @property
    def cost(self) -> Optional[float]:
        return self._job().cost

    @property
    def turns(self) -> Optional[int]:
        return self._job().turns

    @property
    def transcript(self) -> str:
        return self._job().transcript

    @property
    def messages(self) -> List[Message]:
        return [Message(m) for m in self._backend.messages(self.name)]

    def send(self, text: str, mode: str = "follow_up") -> None:
        """
        Tell the child something while it runs. `follow_up` (default) is queued after
        its current turn; `steer` interrupts it. If the child is waiting on
        `ask_parent`, this is the answer.
        """
        try:
            sent = self._backend.send(self.name, text, mode)
        except _mail.MailboxError as exc:
            raise JobError(str(exc)) from None
        kind = (sent or {}).get("kind") or mode
        print(f"[sent to {self.name} as {'the answer to its question' if kind == 'answer' else kind}]")

    def wait(self, wake_after: Any = None, mode: Optional[str] = None) -> None:
        """`jobs.wait(<this agent>, wake_after=...)`: the LAST statement of the cell."""
        _jobs.wait(self.name, wake_after=wake_after, mode=mode)


# ---------------------------------------------------------------------------------
# the namespaces
# ---------------------------------------------------------------------------------


class Agents:
    """`agents` in a parent's kernel: spawn, get, list."""

    def __init__(self, spawner: Optional[Callable[[], "_sub.Subagents"]] = None):
        self._spawner = spawner or _sub._spawner

    def _backend(self) -> Any:
        s = self._spawner()
        if s.transport() == "host":
            return _HostBackend(s.host())
        return _FileBackend(s.store)

    def spawn(self, prompt: Any, name: Optional[str] = None, **kw: Any) -> AgentHandle:
        """
        Start a child agent on a self-contained subtask; returns its handle at once.

        name= is required. The child sees `prompt` and nothing else. Keywords: model,
        tools, max_turns, max_cost, timeout, system_prompt, cwd, agent (a reusable
        Agent(...) definition). See help(agents.spawn) / api/subagents.md.
        """
        job = self._spawner().spawn(prompt, name, **kw)
        return AgentHandle(job.name, self._backend())

    def get(self, name: str) -> AgentHandle:
        """The handle for a child you started. Raises on a name that is not one."""
        backend = self._backend()
        names = backend.names()
        if name not in names:
            raise JobError(f"no agent named {name!r}. Your agents: {', '.join(names) or 'none yet'}.")
        return AgentHandle(name, backend)

    def list(self) -> List[Dict[str, Any]]:  # noqa: A003 - the surface's own name
        """Your children, newest state: name, model, state, turns, cost, unread messages."""
        backend = self._backend()
        rows = []
        for name in backend.names():
            job = backend.job(name)
            if job is None:
                continue
            rows.append(
                {
                    "name": name,
                    "model": job.model,
                    "state": job.state,
                    "turns": job.turns,
                    "cost": job.cost,
                    "unread": backend.unread(name),
                }
            )
        return rows

    def report(self, text: str) -> None:
        raise JobError("agents.report is for subagents: you are the top-level agent. Tell the user instead.")

    def ask_parent(self, question: str, timeout: Any = None) -> Optional[str]:
        raise JobError(
            "agents.ask_parent is for subagents: you are the top-level agent. Ask the user with api.user.ask instead."
        )

    def __repr__(self) -> str:
        return "<agents: spawn(prompt, name=...), get(name), list()>"


class _FileChannel:
    """The child's end of a file-transport mailbox."""

    def __init__(self, env: Any):
        self.box = _mail.Mailbox(env[SELF_DIR_VAR])
        self.name = env.get(SELF_NAME_VAR) or "child"
        self._parent_jobs = env.get(PARENT_JOB_DIR_VAR)

    def report(self, text: str) -> None:
        self.box.report(text)

    def ask(self, question: str) -> str:
        return self.box.ask(question)

    def answer(self, qid: str) -> Optional[str]:
        return self.box.answer_for(qid)

    def close(self, qid: str) -> None:
        self.box.close_question(qid)

    def siblings(self) -> Any:
        if not self._parent_jobs:
            raise JobError("this subagent cannot see its siblings.")
        return _FileBackend(_jobs.JobStore(self._parent_jobs, emit=lambda m: None), sender=self.name)


class _HostChannel:
    """The child's end, through its loop to the broker."""

    def __init__(self, client: "_sub.HostSubagents"):
        self._client = client

    def report(self, text: str) -> None:
        self._client.request({"op": "report", "text": text})

    def ask(self, question: str) -> str:
        return str(self._client.request({"op": "ask", "question": question}).get("id") or "")

    def answer(self, qid: str) -> Optional[str]:
        reply = self._client.request({"op": "ask_poll", "id": qid})
        return str(reply.get("text") or "") if reply.get("answered") else None

    def close(self, qid: str) -> None:
        try:
            self._client.request({"op": "ask_close", "id": qid})
        except JobError:
            pass

    def siblings(self) -> Any:
        return _HostBackend(self._client)


class ChildAgents:
    """`agents` in a subagent's kernel: report and ask_parent; siblings only when allowed."""

    def __init__(self, channel: Any, env: Any = None):
        self._channel = channel
        self._env = os.environ if env is None else env

    def _siblings_on(self) -> bool:
        return str(self._env.get(SIBLINGS_VAR, "")).strip() == "1"

    def report(self, text: str) -> None:
        """A progress note or finding for the agent that started you. Does not wait."""
        try:
            _mail.check_text(text, "report")
            self._channel.report(text)
        except _mail.MailboxError as exc:
            raise JobError(str(exc)) from None
        print("[reported to your parent]")

    def ask_parent(self, question: str, timeout: Any = None) -> Optional[str]:
        """
        Ask the agent that started you, and wait for its answer — at most `timeout`
        seconds (default 600, kept under the cell watchdog). Returns the answer, or
        None if none came: then make a reasonable choice, say so, and carry on.
        """
        try:
            _mail.check_text(question, "question")
        except _mail.MailboxError as exc:
            raise JobError(str(exc)) from None
        budget = _ask_budget(timeout)
        qid = self._channel.ask(question)
        deadline = time.monotonic() + budget
        while True:
            answer = self._channel.answer(qid)
            if answer is not None:
                return answer
            if time.monotonic() >= deadline:
                self._channel.close(qid)
                print(f"[no answer from your parent within {budget:.0f}s; carry on with your best judgment]")
                return None
            time.sleep(min(ASK_POLL_SECONDS, max(0.05, deadline - time.monotonic())))

    def spawn(self, *_a: Any, **_k: Any) -> None:
        raise JobError(
            "a subagent cannot start subagents. Do the work here, or report back "
            "(agents.report) so the agent that started you can."
        )

    def get(self, name: str) -> AgentHandle:
        backend = self._sibling_backend()
        names = backend.names()
        if name not in names:
            raise JobError(f"no sibling agent named {name!r}. Siblings: {', '.join(names) or 'none'}.")
        return AgentHandle(name, backend)

    def list(self) -> List[Dict[str, Any]]:  # noqa: A003
        backend = self._sibling_backend()
        return [{"name": n, "state": (backend.job(n).state if backend.job(n) else "missing")} for n in backend.names()]

    def _sibling_backend(self) -> Any:
        if not self._siblings_on():
            raise JobError(
                "messaging other subagents is off in this session. Report to your parent with agents.report instead."
            )
        return self._channel.siblings()

    def __repr__(self) -> str:
        return "<agents (subagent): report(text), ask_parent(question)>"


def _ask_budget(timeout: Any) -> float:
    seconds = float(ASK_DEFAULT_SECONDS if timeout is None else _jobs.parse_duration(timeout))
    ceiling = int(os.environ.get("HARNESS_CELL_CEILING", "0") or "0")
    if ceiling > 0:
        margin = int(os.environ.get("HARNESS_CELL_CEILING_MARGIN", "15") or "15")
        seconds = min(seconds, max(5.0, ceiling - margin - 5))
    return max(0.0, seconds)


def for_this_kernel(env: Any = None, host: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None) -> Any:
    """
    The `agents` this kernel should see: a parent's (it may spawn), a child's (it
    has a channel to its parent), or None (neither — subagents are off here).
    """
    env = os.environ if env is None else env
    spawner = _sub._spawner()
    try:
        depth = int(env.get(_sub.DEPTH_VAR, "0") or "0")
    except ValueError:
        depth = 0
    if depth > 0:
        if env.get(SELF_DIR_VAR):
            return ChildAgents(_FileChannel(env), env)
        if str(env.get(_sub.TRANSPORT_VAR, "")).strip().lower() == "host" and env.get("HARNESS_SUBAGENT_CHILD") == "1":
            return ChildAgents(_HostChannel(_sub.HostSubagents(host or _sub.host_request_sync)), env)
        return None
    if spawner.transport() == "host" and not spawner.enabled():
        return None
    return Agents()
