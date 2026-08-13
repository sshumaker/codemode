#!/usr/bin/env python3
"""
A stand-in for prime-agent's `-p --mode json` process, for tests.

It emits the same event shapes a real run emits — read off a real stream, the same
way `bench/terminal/test_prime_agent.py` pins them — so `subagent_run.py` can be
exercised end to end without a model call, a network request or an API key.

Behaviour is driven by the environment so one fixture covers every case:

    FAKE_TURNS=3    emit this many assistant turns (default 1)
    FAKE_HANG=20    after the turns, sleep this long (to be killed by a cap)
    FAKE_EXIT=2     exit with this code
    FAKE_DELAY=0.5  seconds between turns
    FAKE_WRITE=path write the received prompt here (proves argv delivery and cwd)

The trailing argument is the prompt, exactly as the real CLI takes it.
"""

import json
import os
import sys
import time


def emit(obj):
    print(json.dumps(obj), flush=True)


def main():
    prompt = sys.argv[-1]
    args = sys.argv[1:-1]
    # Noise on stdout that is not protocol, which the launcher must skip rather than
    # choke on — node prints warnings here in real runs.
    print("(node:1) ExperimentalWarning: fake agent", flush=True)

    if os.environ.get("FAKE_WRITE"):
        with open(os.environ["FAKE_WRITE"], "w") as fh:
            fh.write(prompt + "\n---\n" + " ".join(args) + "\n---\ncwd=" + os.getcwd())

    turns = int(os.environ.get("FAKE_TURNS", "1"))
    delay = float(os.environ.get("FAKE_DELAY", "0"))
    for i in range(1, turns + 1):
        if delay:
            time.sleep(delay)
        emit({"type": "tool_execution_start", "toolName": "ipython",
              "args": {"code": "print(1)"}})
        emit({"type": "tool_execution_end", "isError": False,
              "result": {"content": [{"text": "1"}]}})
        emit({
            "type": "message_end",
            "message": {
                "role": "assistant",
                "responseId": f"resp-{i}",
                "usage": {"input": 100, "output": 20, "cacheRead": 0, "cacheWrite": 0,
                          "cost": {"total": 0.01}},
                "content": [{"type": "text", "text": f"turn {i}: {prompt[:40]}"}],
            },
        })

    hang = float(os.environ.get("FAKE_HANG", "0"))
    if hang:
        time.sleep(hang)
    return int(os.environ.get("FAKE_EXIT", "0"))


if __name__ == "__main__":
    raise SystemExit(main())
