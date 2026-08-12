"""Phase-0 grader-trust probes for the AppWorld *test_challenge* split.

Two controls, run against the same `AppWorld.evaluate()` path the harness uses
(`bench/appworld/env-server.py:handle_evaluate`):

  negative   open the world, do nothing, grade  -> `success` MUST be False
  positive   execute a solution, grade          -> `success` MUST be True

The challenge split ships `minimal` ground truth only (no `solution.py`), so the
positive control cannot be driven from upstream's `compiled_solution_code` the
way `appworld verify tasks` does on train/dev. Solutions used here are written by
hand into `bench/appworld/challenge-solutions/<task_id>.py` and are the evidence
for the positive control; they are logged with the verdict.

  python challenge-p0.py negative --n 12 [--seed 0]
  python challenge-p0.py positive --tasks 5238afc_1,...
  python challenge-p0.py status                      # current verdict per task
  python challenge-p0.py show --tasks 5238afc_1

Everything it sees is appended to .run/appworld/p0-challenge.jsonl — the
"log the inputs, not just the verdicts" rule: the evaluation source, the answer,
the per-test report, and the solution code that produced it.

The log is **append-only, and the last record for a (control, taskId) wins.**

That is not a detail. Iterating on a hand-written solution leaves the failed
attempts in the log, and a reader — human or test — cannot tell a superseded
attempt from an outstanding failure. It already misled one: `07bb666_3` is logged
failing 2/6 at 19:49:43 with a `> 4.3` boundary and passing 6/6 at 19:51:24 with
`>= 4.3`, and a downstream consumer reasonably read the first record as a live
wrong reference. `solutionDigest` on each positive record makes the supersession
visible, and `status` computes latest-wins so nothing downstream has to infer it
from timestamps.

Logging the evidence was necessary and was not sufficient: what was missing was
which record is *current*.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import sys
import traceback
import warnings
from datetime import datetime, timezone

warnings.filterwarnings("ignore")

from appworld import AppWorld, load_task_ids  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LOG = os.path.join(ROOT, ".run", "appworld", "p0-challenge.jsonl")
SOLUTIONS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "challenge-solutions")


def record(entry: dict) -> None:
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    entry["_t"] = datetime.now(timezone.utc).isoformat()
    with open(LOG, "a") as handle:
        handle.write(json.dumps(entry, default=str) + "\n")


def open_world(task_id: str) -> AppWorld:
    # Same construction as env-server.py, minus the arm-facing plumbing.
    return AppWorld(
        task_id=task_id,
        experiment_name=f"p0_{task_id}",
        raise_on_failure=False,
        load_ground_truth=True,
        ground_truth_mode="minimal",
    )


def grade(world: AppWorld) -> dict:
    world.save_state()
    tracker = world.evaluate(suppress_errors=True)
    report = tracker.to_dict()
    return {
        "success": bool(tracker.success),
        "passCount": tracker.pass_count,
        "failCount": tracker.fail_count,
        "totalCount": tracker.total_count,
        "numTests": tracker.num_tests,
        "difficulty": report.get("difficulty"),
        "report": report,
    }


def cmd_negative(args) -> int:
    ids = load_task_ids("test_challenge")
    if args.tasks:
        picks = args.tasks.split(",")
    else:
        rng = random.Random(args.seed)
        picks = rng.sample(ids, args.n)
    bad = []
    for task_id in picks:
        try:
            with open_world(task_id) as world:
                verdict = grade(world)
                instruction = world.task.instruction
        except Exception as exc:  # noqa: BLE001
            record({"control": "negative", "taskId": task_id, "error": f"{type(exc).__name__}: {exc}",
                    "traceback": traceback.format_exc()})
            print(f"  ERROR  {task_id}  {type(exc).__name__}: {exc}")
            bad.append(task_id)
            continue
        record({"control": "negative", "taskId": task_id, "instruction": instruction, **verdict})
        ok = verdict["success"] is False
        print(f"  {'ok  ' if ok else 'BAD '}  {task_id}  success={verdict['success']} "
              f"pass={verdict['passCount']}/{verdict['totalCount']} tests={verdict['numTests']} "
              f"difficulty={verdict['difficulty']}")
        if not ok:
            bad.append(task_id)
    print(f"\nnegative control: {len(picks) - len(bad)}/{len(picks)} correctly failed")
    if bad:
        print("MUST-FAIL tasks that did not fail (or errored):", ",".join(bad))
    return 1 if bad else 0


def cmd_positive(args) -> int:
    bad = []
    picks = args.tasks.split(",")
    for task_id in picks:
        path = os.path.join(SOLUTIONS, f"{task_id}.py")
        if not os.path.exists(path):
            print(f"  MISSING solution: {path}")
            bad.append(task_id)
            continue
        with open(path) as handle:
            code = handle.read()
        try:
            with open_world(task_id) as world:
                output = world.execute(code)
                verdict = grade(world)
                instruction = world.task.instruction
        except Exception as exc:  # noqa: BLE001
            record({"control": "positive", "taskId": task_id, "solution": code,
                    "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()})
            print(f"  ERROR  {task_id}  {type(exc).__name__}: {exc}")
            bad.append(task_id)
            continue
        record({"control": "positive", "taskId": task_id, "instruction": instruction,
                "solution": code, "solutionDigest": hashlib.sha256(code.encode()).hexdigest()[:12],
                "executeOutput": output, "answerJson": ground_truth_answer(task_id),
                **verdict})
        ok = verdict["success"] is True
        print(f"  {'ok  ' if ok else 'BAD '}  {task_id}  success={verdict['success']} "
              f"pass={verdict['passCount']}/{verdict['totalCount']}")
        if not ok:
            print(textwrap_indent(verdict["report"]))
            print("--- execute output ---")
            print(output[-3000:])
            bad.append(task_id)
    print(f"\npositive control: {len(picks) - len(bad)}/{len(picks)} passed")
    return 1 if bad else 0


def textwrap_indent(report) -> str:
    return "\n".join("    " + line for line in json.dumps(report, indent=1, default=str).splitlines())


def ground_truth_answer(task_id: str):
    path = os.path.join(os.environ.get("APPWORLD_ROOT", os.path.join(ROOT, "vendor", "appworld")),
                        "data", "tasks", task_id, "ground_truth", "answer.json")
    try:
        with open(path) as handle:
            return json.load(handle)
    except Exception:  # noqa: BLE001
        return None


def current_verdicts() -> dict[tuple[str, str], dict]:
    """Latest record per (control, taskId) — the log's actual semantics.

    Earlier records for the same pair are superseded attempts, not open failures.
    Returned keyed so a caller can report both halves of the control pair without
    re-deriving supersession from timestamps.
    """
    latest: dict[tuple[str, str], dict] = {}
    if not os.path.exists(LOG):
        return latest
    with open(LOG) as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            key = (entry.get("control"), entry.get("taskId"))
            if key[0] is None or key[1] is None:
                continue
            latest[key] = entry  # file order is append order; last wins
    return latest


def cmd_status(args) -> int:
    latest = current_verdicts()
    if not latest:
        print(f"no records in {LOG} — run `negative` and `positive` first")
        return 1
    superseded = 0
    with open(LOG) as handle:
        superseded = sum(1 for line in handle if line.strip()) - len(latest)
    bad = []
    for control, want in (("positive", True), ("negative", False)):
        rows = sorted((k[1], v) for k, v in latest.items() if k[0] == control)
        print(f"\n{control} control — {control == 'positive' and 'must PASS' or 'must FAIL'} ({len(rows)} tasks)")
        for task_id, entry in rows:
            if "error" in entry:
                print(f"  ERROR  {task_id}  {entry['error']}")
                bad.append((control, task_id))
                continue
            ok = entry.get("success") is want
            digest = entry.get("solutionDigest")
            print(f"  {'ok  ' if ok else 'BAD '}  {task_id}  success={entry.get('success')} "
                  f"{entry.get('passCount')}/{entry.get('totalCount')}"
                  f"{f'  solution:{digest}' if digest else ''}")
            if not ok:
                bad.append((control, task_id))
    print(f"\n{superseded} superseded record(s) in the log are not shown; latest per (control, task) wins.")
    if bad:
        print("CURRENT verdicts that violate the control: " + ", ".join(f"{c}/{t}" for c, t in bad))
        return 1
    print("both halves of the null-policy control hold on every task's current verdict.")
    return 0


def cmd_show(args) -> int:
    for task_id in args.tasks.split(","):
        base = os.path.join(os.path.join(ROOT, "vendor", "appworld"), "data", "tasks", task_id, "ground_truth")
        with open_world(task_id) as world:
            print(f"=== {task_id} ===")
            print("instruction:", world.task.instruction)
            print("supervisor :", world.task.supervisor.first_name, world.task.supervisor.last_name,
                  world.task.supervisor.email)
            print("datetime   :", world.task.datetime)
        for name in ("metadata.json", "answer.json"):
            with open(os.path.join(base, name)) as handle:
                print(f"--- {name} ---")
                print(handle.read().strip()[:2000])
        with open(os.path.join(base, "evaluation.py")) as handle:
            print("--- evaluation.py ---")
            print(handle.read())
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    neg = sub.add_parser("negative")
    neg.add_argument("--n", type=int, default=12)
    neg.add_argument("--seed", type=int, default=0)
    neg.add_argument("--tasks", default="")
    neg.set_defaults(func=cmd_negative)
    pos = sub.add_parser("positive")
    pos.add_argument("--tasks", required=True)
    pos.set_defaults(func=cmd_positive)
    st = sub.add_parser("status")
    st.set_defaults(func=cmd_status)
    show = sub.add_parser("show")
    show.add_argument("--tasks", required=True)
    show.set_defaults(func=cmd_show)
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
