#!/usr/bin/env python3
"""Report a terminal-bench run, with the triage taxonomy attached.

`tb run` prints Resolved / Unresolved / Accuracy. That is exactly the number this
scout is under instruction not to produce: a low score on this benchmark has five
causes that look identical in aggregate, and only one of them is a result.

So every trial is classified before anything is averaged:

    AGENT        the agent had the surface, reached it, and got it wrong
    HARNESS      env/tooling broke under it (preflight failed, no tool call ever
                 reached the transport, the agent timed out)
    GRADER       grading misfired — `parse_error`, or the container's own pytest
                 could not run (`broken-python` under a failing agent)
    REFERENCE    the reference answer is wrong (only ever set by hand, after
                 reading the task's own tests)
    INTEGRATION  our wiring — docker socket, dataset staging, agent kwargs
    UNCLASSIFIED anything the rules below do not cover; must be read by a human

A cause other than AGENT is not a score. It is a bug with a number attached.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / ".run" / "terminal-bench"

# Set by hand from docs/SCOUT-terminal-bench.md §1.3 after reading the task's own
# tests. Nothing infers these; a task is only excluded when someone has explained
# why in the failure log.
KNOWN_BAD = {
    "build-tcc-qemu": ("HARNESS", "hardcodes qemu-system-x86_64 + arch/x86/boot/"
                                  "bzImage; the arm64 host builds an arm64 kernel"),
}


def classify(trial: dict, agent_log: dict | None, agent: str = "") -> tuple[str, str]:
    task = trial.get("task_id", "")
    fm = trial.get("failure_mode", "unset")

    if trial.get("is_resolved"):
        return "PASS", ""

    if task in KNOWN_BAD:
        return KNOWN_BAD[task]

    # An oracle failure is NEVER an agent failure — the oracle runs the task's own
    # shipped `solution.sh`. Without this branch the report labelled
    # `make-mips-interpreter` "AGENT: tests ran and failed" for a run in which no
    # model was called at all. A taxonomy that can assign a cause the run could
    # not have had is worse than no taxonomy. Same for `nop`, in reverse: a nop
    # failure is the negative control working, not a result.
    if agent == "oracle":
        return "REFERENCE", ("the task's own solution.sh does not pass here — "
                             "read the task's tests before believing any agent "
                             "number on it")
    if agent == "nop":
        return "CONTROL", "nop is expected to fail; this is the negative control"

    if agent_log is not None:
        if agent_log.get("valid") is False and "preflight" in agent_log:
            return "HARNESS", f"preflight failed: {agent_log.get('preflight')}"
        if agent_log.get("toolCalls") == 0:
            return "HARNESS", "no tool call reached the transport"
        if agent_log.get("kernelRestarts"):
            return "HARNESS", f"kernel restarted {agent_log['kernelRestarts']}x"

    if fm in ("parse_error",):
        return "GRADER", "test output unparseable — the grader itself did not run"
    if fm == "agent_timeout":
        # An agent that acted and ran out of the task's OWN budget is a result,
        # not a broken harness. One that never acted is the opposite. The
        # distinction is the tool-call count, which is why it is recorded.
        if agent_log and agent_log.get("toolCalls", 0) > 0:
            return "AGENT", (f"timed out after {agent_log['toolCalls']} tool calls "
                             "within the task's own max_agent_timeout_sec")
        return "HARNESS", "agent timed out without reaching the transport"
    if fm == "test_timeout":
        return "GRADER", "run-tests.sh exceeded max_test_timeout_sec"
    if fm in ("agent_installation_failed", "unknown_agent_error"):
        return "INTEGRATION", fm
    if fm == "unset" and trial.get("parser_results"):
        return "AGENT", "tests ran and failed"
    return "UNCLASSIFIED", f"failure_mode={fm}, parser_results={trial.get('parser_results')}"


def main(run_id: str) -> int:
    run_dir = RUNS / run_id
    if not run_dir.is_dir():
        print(f"no such run: {run_dir}", file=sys.stderr)
        return 1

    agent = ""
    meta = run_dir / "run_metadata.json"
    if meta.is_file():
        agent = (json.loads(meta.read_text()) or {}).get("agent_name") or ""

    rows = []
    for results in sorted(run_dir.glob("*/*/results.json")):
        trial = json.loads(results.read_text())
        agent_log = None
        p = results.parent / "agent-logs" / "result.json"
        if p.is_file():
            try:
                agent_log = json.loads(p.read_text())
            except json.JSONDecodeError:
                agent_log = None
        cause, why = classify(trial, agent_log, agent)
        rows.append((trial, agent_log, cause, why))

    w = max((len(t["task_id"]) for t, _, _, _ in rows), default=10)
    print(f"{'task'.ljust(w)}  {'verdict':12s} {'turns':>5} {'tools':>5} "
          f"{'ctx0':>7} {'cost':>7} {'secs':>6}  why")
    total_cost = 0.0
    for trial, log, cause, why in rows:
        log = log or {}
        cost = float(log.get("cost") or 0.0)
        total_cost += cost
        print(f"{trial['task_id'].ljust(w)}  {cause:12s} "
              f"{log.get('turns', '-'):>5} {log.get('toolCalls', '-'):>5} "
              f"{log.get('ctx0', '-'):>7} {cost:>7.3f} "
              f"{log.get('seconds', '-'):>6}  {why}")

    counts: dict[str, int] = {}
    for _, _, cause, _ in rows:
        counts[cause] = counts.get(cause, 0) + 1
    n = len(rows) or 1
    print()
    print(f"agent: {agent or '(unknown)'}")
    print("taxonomy:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    non_pass = n - counts.get("PASS", 0)
    dirty = sum(v for k, v in counts.items()
                if k not in ("PASS", "AGENT", "CONTROL"))
    print(f"trials {n} | pass {counts.get('PASS', 0)} | non-pass {non_pass} "
          f"| AGENT-attributable {counts.get('AGENT', 0)}/{non_pass or 1}")
    print(f"tier is {'CLEAN' if dirty == 0 else f'DIRTY ({dirty} non-AGENT)'} "
          f"— {'may ratchet' if dirty == 0 else 'debug, do not scale'}")
    print(f"cost ${total_cost:.3f} over {n} trials "
          f"(${total_cost / n:.3f}/trial)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1] if len(sys.argv) > 1 else ""))
