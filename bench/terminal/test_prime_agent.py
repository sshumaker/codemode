"""Pin the shape of prime's `--mode json` stream.

This file exists because of a bug, not a policy. `PrimeAgent._accumulate` was
first written against Claude Code's `tool_use`/`tool_result` event vocabulary,
which prime does not use. The result: a trial that ran one `ipython` cell, wrote
the file and passed its tests was recorded `"toolCalls": 0, "valid": false` —
the validity gate firing on a healthy run.

That is the failure mode `CLAUDE.md` names twice: a check that records a verdict
without its evidence, and a metric computed over the wrong shape. So the fixture
below is a *verbatim* excerpt from a real recorded run
(`.run/terminal-bench/p1-prime-hello/.../trajectory.jsonl`), and the assertions
are on the observable effect — a tool call was counted, a cost was priced, a cell
source was retained.

    uv run pytest bench/terminal/test_prime_agent.py -q
"""

import json

from bench.terminal.prime_agent import PrimeAgent

# Verbatim from a recorded run. Trimmed to the events that carry information;
# nothing rewritten.
STREAM = [
    {"type": "session", "version": 3, "cwd": "/app"},
    {"type": "agent_start"},
    {"type": "turn_start"},
    {"type": "message_end", "message": {
        "role": "user",
        "content": [{"type": "text", "text": "Create a file called /app/hello.txt."}],
    }},
    {"type": "message_end", "message": {
        "role": "assistant",
        "content": [{
            "type": "toolCall", "id": "toolu_01Btj", "name": "ipython",
            "arguments": {"code": "open('/app/hello.txt','w').write('Hello, world!\\n')"},
        }],
        "model": "claude-opus-5", "stopReason": "toolUse",
        "usage": {"input": 2, "output": 86, "cacheRead": 884, "cacheWrite": 5212,
                  "totalTokens": 6184,
                  "cost": {"input": 1e-05, "output": 0.00215, "cacheRead": 0.000442,
                           "cacheWrite": 0.032575, "total": 0.035177}},
    }},
    {"type": "message_end", "message": {
        "role": "toolResult", "toolCallId": "toolu_01Btj", "toolName": "ipython",
        "content": [{"type": "text", "text": "Hello, world!\n\n"}],
        "details": {"durationMs": 7, "status": "ok", "kernelRestarted": False},
        "isError": False,
    }},
    {"type": "turn_end", "message": {"role": "assistant", "content": []}, "toolResults": []},
    {"type": "message_end", "message": {
        "role": "assistant",
        "content": [{"type": "text", "text": 'Created /app/hello.txt.'}],
        "stopReason": "stop",
        "usage": {"input": 2, "output": 22, "cacheRead": 6096, "cacheWrite": 98,
                  "totalTokens": 6218,
                  "cost": {"input": 1e-05, "output": 0.00055, "cacheRead": 0.003048,
                           "cacheWrite": 0.0006125, "total": 0.0042205}},
    }},
    {"type": "turn_end", "message": {"role": "assistant", "content": []}, "toolResults": []},
    {"type": "agent_end"},
]


def _run(events):
    s = {"turns": 0, "toolCalls": 0, "toolErrors": 0, "toolNames": [], "cost": 0.0,
         "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "finalText": "",
         "ctx0": 0, "kernelRestarts": 0, "cells": []}
    for ev in events:
        PrimeAgent._accumulate(ev, s)
    return s


def test_tool_call_is_counted():
    """The regression itself. Zero here means the arm looks like it never acted."""
    s = _run(STREAM)
    assert s["toolCalls"] == 1
    assert s["toolNames"] == ["ipython"]


def test_turn_end_is_not_double_counted():
    """`turn_end` repeats its message; counting both inflates turns 2x."""
    assert _run(STREAM)["turns"] == 2


def test_cost_and_tokens_are_summed_from_assistant_messages():
    s = _run(STREAM)
    assert abs(s["cost"] - (0.035177 + 0.0042205)) < 1e-9
    assert s["output"] == 86 + 22
    assert s["cacheWrite"] == 5212 + 98


def test_ctx0_is_the_first_assistant_turn_only():
    """Residency is measured on the wire, not inferred, and only on turn one."""
    assert _run(STREAM)["ctx0"] == 2 + 884 + 5212


def test_cell_source_is_retained():
    """The environment is destroyed after the trial; unretained evidence is gone."""
    assert "hello.txt" in _run(STREAM)["cells"][0]


def test_vanilla_bash_command_is_retained_too():
    """The vanilla arm's `bash` tool takes `command`, not `code`.

    Reading only `code` left `cells` empty for every vanilla run, so
    `blockingSleepCells` / `daemonCells` / `threadCells` were a structural zero
    on that arm — which reads as "vanilla never blocks" and is really "nobody
    looked". Same false-null shape as the L1 arm that advertised tools it could
    never call.
    """
    events = json.loads(json.dumps(STREAM))
    call = events[4]["message"]["content"][0]
    call["name"] = "bash"
    call["arguments"] = {"command": "nohup make -j8 > /tmp/b.log 2>&1 &\nsleep 120"}
    s = _run(events)
    assert s["toolNames"] == ["bash"]
    assert s["cells"] and "sleep 120" in s["cells"][0]


def test_tool_errors_and_kernel_restarts_are_observed():
    events = json.loads(json.dumps(STREAM))
    events[5]["message"]["isError"] = True
    events[5]["message"]["details"]["kernelRestarted"] = True
    s = _run(events)
    assert s["toolErrors"] == 1
    assert s["kernelRestarts"] == 1


def test_a_run_that_never_reaches_the_transport_is_invalid():
    """Assert the arm reaches the transport at all — the check that was missing
    when the 'L1' arm advertised tools it could never call."""
    s = _run([e for e in STREAM if not (
        e.get("type") == "message_end"
        and (e.get("message") or {}).get("role") in ("assistant", "toolResult")
    )])
    assert s["toolCalls"] == 0
