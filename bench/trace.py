#!/usr/bin/env python3
"""Summarize a prime-agent JSON event stream.

    bench/run.sh <env> <arm> <model> "<prompt>" | bench/trace.py

Prints one line per tool call, per assistant message, and per-turn token usage,
then a total. The raw stream is ~40 lines of JSON per turn; this is what you
actually want to look at while iterating.
"""
import json
import sys


def main() -> int:
    turns = tools = 0
    totals = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "cost": 0.0}
    seen: set[str] = set()

    for line in sys.stdin:
        line = line.strip()
        if not line.startswith("{"):
            if line:
                print(line)
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        kind = event.get("type")

        if kind == "tool_execution_start":
            tools += 1
            args = json.dumps(event.get("args", {}))
            print(f"  TOOL {event['toolName']} {args[:120]}")

        elif kind == "tool_execution_end":
            text = " ".join(c.get("text", "") for c in event["result"].get("content", []))
            flag = "ERROR " if event.get("isError") else ""
            print(f"    -> {flag}{text.strip()[:160]}")

        elif kind == "message_end" and event["message"].get("role") == "assistant":
            message = event["message"]
            for chunk in message.get("content", []):
                if chunk.get("type") == "text" and chunk.get("text"):
                    print(f"  TEXT {chunk['text'][:300]}")

            # Each assistant message is emitted more than once; count usage once.
            response_id = message.get("responseId")
            usage = message.get("usage", {})
            if response_id and response_id not in seen and usage.get("totalTokens"):
                seen.add(response_id)
                turns += 1
                for key in ("input", "output", "cacheRead", "cacheWrite"):
                    totals[key] += usage.get(key, 0)
                totals["cost"] += usage.get("cost", {}).get("total", 0.0)
                print(
                    f"    [in {usage['input']} out {usage['output']} "
                    f"cacheR {usage['cacheRead']} cacheW {usage['cacheWrite']} "
                    f"= ${usage['cost']['total']:.5f}]"
                )

    print(
        f"\n{turns} turns, {tools} tool calls | "
        f"in {totals['input']} out {totals['output']} "
        f"cacheR {totals['cacheRead']} cacheW {totals['cacheWrite']} | "
        f"${totals['cost']:.5f}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
