#!/usr/bin/env python3
"""
A stand-in for prime-agent's `--mode rpc` process (and the older `-p --mode json`),
for tests.

It emits the same event shapes a real run emits — read off a real stream, the same
way `bench/terminal/test_prime_agent.py` pins them — so `subagent_run.py` can be
exercised end to end without a model call, a network request or an API key.

In RPC mode the prompt is the first `{"type": "prompt"}` command on stdin, and the
process stays up until stdin closes. A `prompt` that arrives while it is "working"
(it polls stdin before each turn) is queued the way prime queues a
`streamingBehavior` prompt and handled as one more turn of the same run, whose text
quotes it; one that arrives after `agent_end` starts a new run.

Behaviour is driven by the environment so one fixture covers every case:

    FAKE_TURNS=3    emit this many assistant turns (default 1)
    FAKE_HANG=20    after the turns, sleep this long (to be killed by a cap)
    FAKE_EXIT=2     exit with this code
    FAKE_DELAY=0.5  seconds between turns
    FAKE_WAIT=2     end the FIRST run the way a cell ending in jobs.wait does:
                    agent_end with stopReason "waiting" and a deadline-only wait
                    request of this many seconds
    FAKE_WRITE=path write the received prompt here (proves delivery and cwd)
    FAKE_REPORT_ENV=VAR  also record this variable's value from the child's own
                    environment. Which environment a child inherits is the whole
                    subagent-broker question, and it is answerable offline: a
                    variable present only in the broker's environment shows up
                    here if and only if the broker started the child.
"""

import json
import os
import select
import sys
import time


def emit(obj):
    print(json.dumps(obj), flush=True)


def turn(i, text):
    emit({"type": "tool_execution_start", "toolName": "ipython", "args": {"code": "print(1)"}})
    emit({"type": "tool_execution_end", "isError": False, "result": {"content": [{"text": "1"}]}})
    emit(
        {
            "type": "message_end",
            "message": {
                "role": "assistant",
                "responseId": f"resp-{i}",
                "usage": {"input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0, "cost": {"total": 0.01}},
                "content": [{"type": "text", "text": text}],
            },
        }
    )


def record(prompt, args):
    if not os.environ.get("FAKE_WRITE"):
        return
    reported = ""
    if os.environ.get("FAKE_REPORT_ENV"):
        var = os.environ["FAKE_REPORT_ENV"]
        reported = f"\n---\nenv:{var}={os.environ.get(var, '')}"
    with open(os.environ["FAKE_WRITE"], "w") as fh:
        fh.write(prompt + "\n---\n" + " ".join(args) + "\n---\ncwd=" + os.getcwd() + reported)


def print_mode():
    prompt = sys.argv[-1]
    record(prompt, sys.argv[1:-1])
    turns = int(os.environ.get("FAKE_TURNS", "1"))
    delay = float(os.environ.get("FAKE_DELAY", "0"))
    for i in range(1, turns + 1):
        if delay:
            time.sleep(delay)
        turn(i, f"turn {i}: {prompt[:40]}")
    hang = float(os.environ.get("FAKE_HANG", "0"))
    if hang:
        time.sleep(hang)
    return int(os.environ.get("FAKE_EXIT", "0"))


class Stdin:
    def __init__(self):
        self.buf = b""
        self.eof = False

    def commands(self, timeout):
        """Whatever complete prompt commands are on stdin within `timeout` seconds."""
        out = []
        if not self.eof:
            ready, _, _ = select.select([sys.stdin.buffer], [], [], timeout)
            if ready:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    self.eof = True
                self.buf += chunk
        while b"\n" in self.buf:
            line, self.buf = self.buf.split(b"\n", 1)
            if line.strip():
                cmd = json.loads(line)
                emit({"type": "response", "command": cmd.get("type"), "success": True})
                if cmd.get("type") == "prompt":
                    out.append(cmd)
        return out


def rpc_mode():
    stdin = Stdin()
    first = []
    while not first and not stdin.eof:
        first = stdin.commands(5)
    if not first:
        return 1
    prompt = first[0]["message"]
    emit({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}})
    record(prompt, sys.argv[1:])
    turns = int(os.environ.get("FAKE_TURNS", "1"))
    delay = float(os.environ.get("FAKE_DELAY", "0"))
    queue = first[1:]
    waited = False
    n = 0
    for _ in range(turns):
        if delay:
            time.sleep(delay)
        queue += stdin.commands(0)
        n += 1
        turn(n, f"turn {n}: {prompt[:40]}")
    while True:
        queue += stdin.commands(0)
        while queue:
            msg = queue.pop(0)["message"]
            emit({"type": "message_end", "message": {"role": "user", "content": [{"type": "text", "text": msg}]}})
            n += 1
            turn(n, f"turn {n}: handled {msg.splitlines()[-1][:60]}")
            queue += stdin.commands(0)
        wait_s = os.environ.get("FAKE_WAIT")
        if wait_s and not waited:
            waited = True
            seconds = float(wait_s)
            request = {"wake_at": time.time() + seconds, "wake_after": seconds, "armed_at": time.time(),
                       "watch": [], "targets": [], "job_dir": os.getcwd()}
            emit({"type": "agent_end", "messages": [], "stopReason": "waiting",
                  "wait": {"seconds": seconds, "targets": [], "watch": [], "request": request}})
        else:
            emit({"type": "agent_end", "messages": []})
        hang = float(os.environ.get("FAKE_HANG", "0"))
        if hang:
            time.sleep(hang)
        # Idle: a new prompt starts another run; stdin closing ends the process.
        while not queue and not stdin.eof:
            queue += stdin.commands(1)
        if not queue:
            return int(os.environ.get("FAKE_EXIT", "0"))


def main():
    # Noise on stdout that is not protocol, which the launcher must skip rather than
    # choke on — node prints warnings here in real runs.
    print("(node:1) ExperimentalWarning: fake agent", flush=True)
    args = sys.argv[1:]
    if "--mode" in args and args[args.index("--mode") + 1] == "rpc":
        return rpc_mode()
    return print_mode()


if __name__ == "__main__":
    raise SystemExit(main())
