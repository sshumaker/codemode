#!/usr/bin/env python3
"""
The subagent launcher: the process a spawned child actually runs as.

`spawn()` writes a spec file and submits `python3 subagent_run.py <spec>` as an
ordinary job. This is that command. It starts the real prime-agent CLI in RPC mode,
sends it the prompt, reads its event stream, and turns it into the two things a
parent needs:

    <name>.result.txt   the child's final text — cheap to collect
    <name>.meta.json    turns, cost, tokens, tool calls, why it stopped

plus `<name>.stream.jsonl`, the full trajectory, and `<name>.stderr.txt`.

Why RPC mode and not `-p`
-------------------------
A one-shot print run cannot be spoken to once it starts. In RPC mode the prompt is
the first command on stdin, and this launcher keeps the pipe open for the child's
whole life: every message the parent `send`s lands in the child's mailbox
(`runtime/agent_mailbox.py`), and the launcher hands it to prime as a `prompt` with
`streamingBehavior` "steer" (interrupt the current turn) or "followUp" (queue after
it). When the run ends with nothing left in the inbox, the launcher closes stdin and
prime exits once idle; a message that arrives after the last turn but before that
close starts one more turn instead of being lost.

Why a launcher process rather than a shell one-liner
----------------------------------------------------
Three things have to happen around the child that a shell cannot do:

1.  **The caps.** prime has no `--max-cost`, and `--autonomous-max-turns` only
    applies under `--autonomous`, which print mode is not. Both benchmark runners
    enforce budgets by watching the JSON stream and killing the child
    (`bench/run-task.mjs:enforceBudget`); this is the same mechanism in the same
    place, so a subagent's cap and a benchmark's cap cannot drift.
2.  **The quoting.** The prompt is multi-line free text. It travels in the spec
    file and is passed to `execve` as one argv element, so it is never parsed by a
    shell — the escaping failure that mangled `\\n` into a literal newline earlier
    in this project (CLAUDE.md, scripts/patches) has no way to happen here.
3.  **The evidence.** CLAUDE.md: log the inputs, not just the verdicts. The exact
    argv, the model, the stop reason and the full stream are written next to the
    result, so "why did this child answer that" is answerable tomorrow rather than
    re-derived from a container that no longer exists.

Everything printed on stdout becomes the job's log, which is what `.output` returns:
a header, one line per turn while it runs, then the final text. So a parent that
does the obvious thing — `print(jobs.get("scout").output)` — gets a readable
account, and `.result` gives the answer alone.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time

from agent_mailbox import Mailbox

# Exit codes the parent can read off `.exit_code`. 124 is `timeout(1)`'s, kept the
# same so it means the same thing everywhere in this harness.
EXIT_TIMEOUT = 124
EXIT_CAPPED = 3
EXIT_LAUNCH_FAILED = 127


def _emit(line: str) -> None:
    print(line, flush=True)


INBOX_POLL_SECONDS = float(os.environ.get("HARNESS_SUBAGENT_INBOX_POLL", "0.3"))
# After an agent_end with a message still untaken, how long to wait for prime's next run.
LATE_RUN_GRACE_SECONDS = float(os.environ.get("HARNESS_SUBAGENT_LATE_RUN_GRACE", "10"))
# How often a child that ended its turn in jobs.wait is checked for being due.
WAKE_POLL_SECONDS = float(os.environ.get("HARNESS_SUBAGENT_WAKE_POLL", "1.0"))


def _wake_reason(request: dict) -> "str | None":
    """scheduler.reason_for when the scheduler is staged beside this file; else the deadline."""
    try:
        import scheduler
    except ImportError:
        wake_at = request.get("wake_at")
        if wake_at is not None and time.time() >= wake_at:
            return f"the requested wait of {request.get('wake_after', '?')}s elapsed"
        return None
    reason = scheduler.reason_for(request, request.get("job_dir"))
    if reason and request.get("mailboxes"):
        from agent_mailbox import Mailbox as _Box

        for box in request["mailboxes"].values():
            _Box(box).mark_read()
    return reason


def _wake_message(reason: str) -> str:
    try:
        import scheduler
    except ImportError:
        return f"[woken: {reason}] Check your jobs and continue the task."
    return scheduler.wake_message(reason)


def wrap_message(msg: dict) -> str:
    """What the child reads: who is speaking, and whether it interrupts."""
    sender = msg.get("from") or "parent"
    who = "the agent that started you" if sender == "parent" else f"your sibling agent {sender!r}"
    how = "it interrupts what you were doing" if msg.get("mode") == "steer" else "a follow-up"
    return f"[Message from {who} ({how})]\n{msg.get('text', '')}"


class RpcChild:
    """
    One prime `--mode rpc` process and the parent's inbox, pumped into it.

    The stdin pipe is the only writer's resource, so every write holds the lock; a
    closed pipe means the run is over and later inbox lines are left for the
    parent to see as undelivered rather than written into a dead process.
    """

    def __init__(self, proc: "subprocess.Popen", mailbox: Mailbox, name: str):
        self.proc = proc
        self.mailbox = mailbox
        self.name = name
        self.lock = threading.Lock()
        self.closed = False
        self.idle = False
        # Messages handed to prime that it has not yet taken in as a user message.
        # prime runs a queued follow-up as its own run AFTER agent_end, so an
        # agent_end with any of these outstanding is not the end.
        self.untaken = 0
        self._prompt_seen = False
        self._activity = 0
        # The wait request of a run that ended in jobs.wait, until something wakes it.
        self.waiting: "dict | None" = None
        self._next_wake_check = 0.0
        self._stop = threading.Event()
        self._pump = threading.Thread(target=self._run, name=f"inbox-{name}", daemon=True)

    def _write(self, command: dict) -> bool:
        if self.closed or self.proc.stdin is None:
            return False
        try:
            self.proc.stdin.write((json.dumps(command) + "\n").encode())
            self.proc.stdin.flush()
            return True
        except (BrokenPipeError, OSError, ValueError):
            self.closed = True
            return False

    def start(self, prompt: str) -> None:
        with self.lock:
            self._write({"type": "prompt", "message": prompt})
        self._pump.start()

    def _deliver_pending(self) -> int:
        """Hand every undelivered inbox message to prime. Caller holds the lock."""
        sent = 0
        for msg in self.mailbox.pending():
            # A message wakes a waiting child: its turn opens with the message.
            self.waiting = None
            if self.idle:
                command = {"type": "prompt", "message": wrap_message(msg)}
                self.idle = False
            else:
                behaviour = "steer" if msg.get("mode") == "steer" else "followUp"
                command = {"type": "prompt", "message": wrap_message(msg), "streamingBehavior": behaviour}
            if not self._write(command):
                break
            self.untaken += 1
            self.mailbox.mark_delivered(int(msg.get("seq", 0)))
            _emit(f"[{self.name}] <- {msg.get('from') or 'parent'} ({msg.get('mode')}): "
                  f"{str(msg.get('text', '')).splitlines()[0][:120] if msg.get('text') else ''}")
            sent += 1
        return sent

    def _run(self) -> None:
        while not self._stop.wait(INBOX_POLL_SECONDS):
            with self.lock:
                if self.closed:
                    return
                self._deliver_pending()
                self._wake_if_due()

    def _wake_if_due(self) -> None:
        """
        A run that ended in jobs.wait is this launcher's to wake: it is the child's
        RPC host. Same decision and same opening message as the scheduler's. Caller
        holds the lock.
        """
        if self.waiting is None or not self.idle or time.monotonic() < self._next_wake_check:
            return
        self._next_wake_check = time.monotonic() + WAKE_POLL_SECONDS
        reason = _wake_reason(self.waiting)
        if not reason:
            return
        if self._write({"type": "prompt", "message": _wake_message(reason)}):
            _emit(f"[{self.name}] woken: {reason.splitlines()[0][:160]}")
            self.waiting = None
            self.idle = False
            self.untaken += 1

    def saw_event(self, ev: dict) -> None:
        # Only the start of a run counts as prime keeping its promise: a response to
        # a command, or anything else, must not cancel the late-run check.
        if ev.get("type") in ("agent_start", "message_start"):
            self._activity += 1

    def refused(self) -> None:
        """prime refused a prompt we handed it: it will never take that one in."""
        with self.lock:
            self.untaken = max(0, self.untaken - 1)

    def took_message(self) -> None:
        """prime took a user message into the conversation (the first is the task)."""
        with self.lock:
            if self._prompt_seen:
                self.untaken = max(0, self.untaken - 1)
            self._prompt_seen = True
            self.idle = False

    def agent_ended(self, event: "dict | None" = None) -> bool:
        """
        The run went idle. True if it is over (stdin now closed), False if prime
        still holds a message for another run, the inbox had more for it, or the
        run ended waiting (`stopReason: "waiting"`) — then it is woken, not closed.
        """
        with self.lock:
            self.idle = True
            wait = (event or {}).get("wait") or {}
            if (event or {}).get("stopReason") == "waiting" and isinstance(wait.get("request"), dict):
                self.waiting = wait["request"]
                self._next_wake_check = 0.0
                _emit(f"[{self.name}] waiting: {', '.join(wait.get('targets') or []) or 'deadline'} "
                      f"(up to {wait.get('seconds')}s)")
                return False
            if self.untaken > 0:
                self.idle = False
                self._expect_another_run(self._activity)
                return False
            if self._deliver_pending():
                return False
            # Refuse sends from here on; anything that beat the close gets one more run.
            if self.mailbox.close_inbox() and self._deliver_pending():
                return False
            self.closed = True
            self._stop.set()
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except OSError:
                pass
            return True

    def _expect_another_run(self, seen: int) -> None:
        """If prime never starts the run it owes, end anyway rather than hang to the timeout."""
        def check():
            with self.lock:
                if self.closed or self._activity != seen:
                    return
                self.untaken = 0
            self.agent_ended()

        timer = threading.Timer(LATE_RUN_GRACE_SECONDS, check)
        timer.daemon = True
        timer.start()

    def close(self) -> None:
        # No lock: this runs from the SIGALRM handler too, which may interrupt the
        # main thread while it holds it. A write racing the close fails in _write.
        self.closed = True
        self._stop.set()
        self.mailbox.mark_closed()
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except (OSError, ValueError):
            pass


class Collector:
    """Accumulates the child's stream. Shapes read off a real run, not guessed."""

    def __init__(self) -> None:
        self.turns = 0
        self.tool_calls = 0
        self.tool_names: list = []
        self.tool_errors = 0
        self.cost = 0.0
        self.input = 0
        self.output = 0
        self.cache_read = 0
        self.cache_write = 0
        self.final_text = ""
        self.ctx0 = 0
        self._counted: set = set()

    def feed(self, ev: dict) -> bool:
        """Returns True when this event ended an assistant turn."""
        kind = ev.get("type")
        if kind == "tool_execution_start":
            self.tool_calls += 1
            name = ev.get("toolName") or (ev.get("args") or {}).get("name")
            if name:
                self.tool_names.append(name)
            return False
        if kind == "tool_execution_end" and ev.get("isError"):
            self.tool_errors += 1
            return False
        if kind != "message_end":
            return False
        msg = ev.get("message") or {}
        if msg.get("role") != "assistant":
            return False

        usage = msg.get("usage") or {}
        # Dedup by responseId BEFORE counting anything: a retried or re-emitted
        # message would otherwise inflate `turns`, and the max_turns cap is
        # enforced off that number — a duplicate event ended a child early having
        # done less work than the cap allows (2026-08-15 review, H5). Cost and
        # turns must move together, under one guard.
        rid = msg.get("responseId")
        if rid is None or rid not in self._counted:
            self.turns += 1
            if rid is not None:
                self._counted.add(rid)
            first = self.input + self.cache_read + self.cache_write == 0
            self.input += usage.get("input", 0) or 0
            self.output += usage.get("output", 0) or 0
            self.cache_read += usage.get("cacheRead", 0) or 0
            self.cache_write += usage.get("cacheWrite", 0) or 0
            self.cost += float((usage.get("cost") or {}).get("total", 0) or 0)
            if first:
                self.ctx0 = ((usage.get("input", 0) or 0)
                             + (usage.get("cacheRead", 0) or 0)
                             + (usage.get("cacheWrite", 0) or 0))
        texts = [p.get("text") for p in (msg.get("content") or [])
                 if p.get("type") == "text" and p.get("text")]
        if texts:
            # The LAST assistant text is the answer; earlier ones are narration
            # between tool calls.
            self.final_text = "\n".join(texts)
        return True

    def as_dict(self) -> dict:
        return {
            "turns": self.turns,
            "toolCalls": self.tool_calls,
            "toolNames": self.tool_names,
            "toolErrors": self.tool_errors,
            "cost": round(self.cost, 6),
            "input": self.input,
            "output": self.output,
            "cacheRead": self.cache_read,
            "cacheWrite": self.cache_write,
            "ctx0": self.ctx0,
            "finalTextChars": len(self.final_text),
        }


def main(argv: list) -> int:
    if len(argv) != 2:
        print(f"usage: {os.path.basename(argv[0])} <spec.json>", file=sys.stderr)
        return 2
    with open(argv[1]) as fh:
        spec = json.load(fh)

    name = spec["name"]
    env = dict(os.environ)
    env.update({k: str(v) for k, v in (spec.get("env") or {}).items()})
    os.makedirs(spec["child_dir"], exist_ok=True)

    started = time.time()
    stopped = None  # why it ended, if not by finishing

    _emit(f"[subagent {name}] model={spec['model']} tools={spec['tools']} "
          f"timeout={spec['timeout']}s"
          + (f" max_turns={spec['max_turns']}" if spec.get("max_turns") else "")
          + (f" max_cost=${spec['max_cost']}" if spec.get("max_cost") else ""))
    _emit(f"[subagent {name}] transcript {spec['transcript']}")

    collector = Collector()
    # Specs written before RPC children still carry the prompt as the last argv
    # element; they run one-shot, as they were built to.
    rpc = bool(spec.get("rpc"))

    def finish(code: int) -> int:
        meta = collector.as_dict()
        meta.update({
            "name": name,
            "model": spec["model"],
            "tools": spec["tools"],
            "seconds": round(time.time() - started, 1),
            "exitCode": code,
            "stopped": stopped,
            "transcript": spec["transcript"],
            "result": spec["result"],
            "argv": spec["argv"] if rpc else spec["argv"][:-1] + ["<prompt>"],
        })
        # Result and meta are written even on a cap or a crash: a child stopped at
        # its turn limit has usually done most of the work, and throwing that away
        # because it did not exit 0 would be the harness deciding for the parent.
        with open(spec["result"], "w") as fh:
            fh.write(collector.final_text)
        with open(spec["meta"], "w") as fh:
            json.dump(meta, fh, indent=2)
        _emit("")
        _emit(f"--- {name}: final response ---")
        _emit(collector.final_text or "(the child produced no final text)")
        _emit(f"[subagent {name}] exit={code} turns={meta['turns']} "
              f"tools={meta['toolCalls']} ${meta['cost']:.4f} in {meta['seconds']}s"
              + (f" — STOPPED: {stopped}" if stopped else ""))
        return code

    try:
        stream = open(spec["transcript"], "wb")
        errfile = open(spec["stderr"], "wb")
        child = subprocess.Popen(
            spec["argv"],
            stdin=subprocess.PIPE if rpc else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=errfile,
            cwd=spec["cwd"] or None,
            env=env,
            # Its own process group, so a cap or a timeout kills the agent AND the
            # kernel it spawned. Killing only the agent leaves an orphaned kernel
            # holding pipes open — the TAC bug where a `docker exec -i` orphan
            # outlived its agent by twenty minutes.
            start_new_session=True,
        )
    except OSError as exc:
        stopped = f"could not start the agent: {exc}"
        _emit(f"[subagent {name}] {stopped}")
        _emit(f"[subagent {name}] argv was: {spec['argv'][:2]}")
        return finish(EXIT_LAUNCH_FAILED)

    driver = RpcChild(child, Mailbox(spec["child_dir"]), name) if rpc else None
    if driver is not None:
        driver.start(spec["prompt"])

    def kill_child(reason: str) -> None:
        nonlocal stopped
        if stopped is None:
            stopped = reason
        if driver is not None:
            driver.close()
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except OSError:
            pass

    def on_alarm(signum, frame):
        # Killing the child closes the pipe, so the read loop below ends on its own
        # — no exception has to be raised through it.
        kill_child(f"timeout after {spec['timeout']}s")

    if spec.get("timeout"):
        try:
            signal.signal(signal.SIGALRM, on_alarm)
            signal.alarm(int(spec["timeout"]))
        except (ValueError, AttributeError):
            pass  # no SIGALRM here; the job's own max_runtime is the backstop

    max_turns = spec.get("max_turns")
    max_cost = spec.get("max_cost")

    assert child.stdout is not None
    for raw in child.stdout:
        stream.write(raw)
        stream.flush()
        text = raw.decode("utf-8", errors="replace").strip()
        if not text.startswith("{"):
            continue  # node warnings and other non-protocol noise; kept in the file
        try:
            ev = json.loads(text)
        except json.JSONDecodeError:
            continue
        if driver is not None:
            driver.saw_event(ev)
        if driver is not None and ev.get("type") == "agent_end":
            driver.agent_ended(ev)
            continue
        if (driver is not None and ev.get("type") == "message_end"
                and (ev.get("message") or {}).get("role") == "user"):
            driver.took_message()
        if driver is not None and ev.get("type") == "response" and ev.get("success") is False:
            _emit(f"[subagent {name}] prime refused {ev.get('command')}: {ev.get('error')}")
            if ev.get("command") == "prompt":
                driver.refused()
            continue
        if not collector.feed(ev):
            continue
        _emit(f"[{name} turn {collector.turns}] {collector.tool_calls} tool calls, "
              f"${collector.cost:.4f}")
        if max_cost and collector.cost >= max_cost:
            kill_child(f"max_cost ${max_cost} reached (${collector.cost:.4f})")
            break
        if max_turns and collector.turns >= max_turns:
            kill_child(f"max_turns {max_turns} reached")
            break

    child.stdout.close()
    if driver is not None:
        driver.close()
    code = child.wait()
    try:
        signal.alarm(0)
    except (ValueError, AttributeError):
        pass
    stream.close()
    errfile.close()

    if stopped and "timeout" in stopped:
        return finish(EXIT_TIMEOUT)
    if stopped:
        return finish(EXIT_CAPPED)
    return finish(code)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
