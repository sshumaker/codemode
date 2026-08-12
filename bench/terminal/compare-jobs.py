#!/usr/bin/env python3
"""Paired jobs-runtime ON vs OFF, on terminal-bench.

    bench/terminal/compare-jobs.py <off-run-id> <on-run-id>

The endpoints, in the order they decide the claim:

    wedged        did a cell fail to return? (`hitDeadline` with few turns)
    resolved      did the task pass its own tests?
    blockingSleep cells containing a blocking sleep — Plan A's A1 metric
    threadCells   cells starting a thread or forking
    jobsCells     adoption: cells that touched `jobs.`
    procsCreated  the arm-independent work counter (§6 "Work parity")
    cost, secs    reported per unit of work, never as a bare mean

Cost is reported three ways because a bare mean delta is not defensible when the
arms can do different amounts of work: per task (paired), as a rate ($ per
process created, defined on every task and independent of parity), and as the
count of tasks where ON is cheaper *including those where OFF created more
processes*. That last form is the one that cannot be an artefact of the measured
arm doing less.

n here is 3. This prints a decomposition, not a significance claim — `CLAUDE.md`
is explicit that under ~20 paired cells nothing can be ranked. The wedge endpoint
is binary and mechanistic, which is why it is the headline rather than cost.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / ".run" / "terminal-bench"


def load(run_id: str) -> dict[str, dict]:
    out = {}
    for results in sorted((RUNS / run_id).glob("*/*/results.json")):
        trial = json.loads(results.read_text())
        log_path = results.parent / "agent-logs" / "result.json"
        cond_path = results.parent / "agent-logs" / "condition.json"
        log = json.loads(log_path.read_text()) if log_path.is_file() else {}
        cond = json.loads(cond_path.read_text()) if cond_path.is_file() else {}
        out[trial["task_id"]] = {"trial": trial, "log": log, "cond": cond}
    return out


def wedged(log: dict) -> bool:
    """A cell that never returned.

    The signature is the agent process being killed by its in-container deadline
    while it had taken very few turns — a run that is *working* keeps producing
    turns. Deliberately not "the agent timed out": a genuinely hard task can
    exhaust its budget while acting, and that is a result, not a wedge.
    """
    return bool(log.get("hitDeadline")) and log.get("turns", 0) <= 6


def row(task: str, cell: dict) -> str:
    t, log = cell["trial"], cell["log"]
    cost = float(log.get("cost") or 0)
    procs = log.get("procsCreated")
    rate = f"{cost / procs:.5f}" if procs else "—"
    return (f"  {task:24s} {'PASS' if t.get('is_resolved') else 'fail':4s} "
            f"wedged={str(wedged(log))[:5]:5s} "
            f"turns={log.get('turns', '-'):>3} "
            f"sleep={log.get('blockingSleepCells', '-'):>2} "
            f"thread={log.get('threadCells', '-'):>2} "
            f"jobs={log.get('jobsCells', '-'):>2} "
            f"procs={str(procs):>5} "
            f"${cost:6.3f} $/proc={rate:>8} {log.get('seconds', '-'):>7}s")


def main(off_id: str, on_id: str) -> int:
    off, on = load(off_id), load(on_id)
    shared = sorted(set(off) & set(on))
    if not shared:
        print("no tasks in common", file=sys.stderr)
        return 1

    for label, runs in (("OFF", off), ("ON ", on)):
        print(f"{label}  ({off_id if label.strip() == 'OFF' else on_id})")
        for task in shared:
            print(row(task, runs[task]))
        print()

    print("paired, per task")
    cheaper = both = off_more_work = off_more_work_and_on_cheaper = 0
    for task in shared:
        a, b = off[task]["log"], on[task]["log"]
        ca, cb = float(a.get("cost") or 0), float(b.get("cost") or 0)
        pa, pb = a.get("procsCreated"), b.get("procsCreated")
        wa, wb = wedged(a), wedged(b)
        both += 1
        if cb < ca:
            cheaper += 1
        more = pa is not None and pb is not None and pa > pb
        if more:
            off_more_work += 1
            if cb < ca:
                off_more_work_and_on_cheaper += 1
        print(f"  {task:24s} wedge {str(wa)[:5]:5s} -> {str(wb)[:5]:5s}   "
              f"sleep {a.get('blockingSleepCells')} -> {b.get('blockingSleepCells')}   "
              f"jobs {a.get('jobsCells')} -> {b.get('jobsCells')}   "
              f"${ca:.3f} -> ${cb:.3f}")

    off_wedges = sum(wedged(off[t]["log"]) for t in shared)
    on_wedges = sum(wedged(on[t]["log"]) for t in shared)
    print()
    print(f"WEDGES      OFF {off_wedges}/{both}   ON {on_wedges}/{both}")
    print(f"resolved    OFF {sum(off[t]['trial'].get('is_resolved') for t in shared)}/{both}"
          f"   ON {sum(on[t]['trial'].get('is_resolved') for t in shared)}/{both}")
    print(f"jobs used   ON  {sum(1 for t in shared if (on[t]['log'].get('jobsCells') or 0) > 0)}/{both} tasks")
    print(f"cost        ON cheaper on {cheaper}/{both} tasks; "
          f"of the {off_more_work} where OFF did MORE work, ON cheaper on "
          f"{off_more_work_and_on_cheaper}")
    print("\nn=3: a decomposition, not a significance claim.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1], sys.argv[2]))
