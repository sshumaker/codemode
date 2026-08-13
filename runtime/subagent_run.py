#!/usr/bin/env python3
"""
The subagent launcher: the process a spawned child actually runs as.

`spawn()` writes a spec file and submits `python3 subagent_run.py <spec>` as an
ordinary job. This is that command. It starts the real prime-agent CLI, reads its
`--mode json` stream, and turns it into the two things a parent needs:

    <name>.result.txt   the child's final text — cheap to collect
    <name>.meta.json    turns, cost, tokens, tool calls, why it stopped

plus `<name>.stream.jsonl`, the full trajectory, and `<name>.stderr.txt`.

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
import time

# Exit codes the parent can read off `.exit_code`. 124 is `timeout(1)`'s, kept the
# same so it means the same thing everywhere in this harness.
EXIT_TIMEOUT = 124
EXIT_CAPPED = 3
EXIT_LAUNCH_FAILED = 127


def _emit(line: str) -> None:
    print(line, flush=True)


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

        self.turns += 1
        usage = msg.get("usage") or {}
        # Dedup by responseId: a retried or re-emitted message would otherwise be
        # billed twice, and the cap is enforced off this number.
        rid = msg.get("responseId")
        if rid is None or rid not in self._counted:
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
            "argv": spec["argv"][:-1] + ["<prompt>"],
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

    def kill_child(reason: str) -> None:
        nonlocal stopped
        if stopped is None:
            stopped = reason
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
