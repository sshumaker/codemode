"""Pins the wedge detector against the false-negative that hid the mailman wedge.

The original `wedged()` required agent-level `hitDeadline and turns<=6`. The
per-cell timeout (HARNESS_CELL_TIMEOUT_MS) *bounds* the §7.2 pipe wedge: the cell
is killed at the timeout and the agent recovers and keeps taking turns, so the
agent-level deadline is never hit. p8m-off and p8m-on both wedged (cell 7 / cell
17, `mailman ... start | tail`) at 29 / 48 turns and were scored `wedged=False`.
The real signal is the per-cell interrupt notice, read from the stream.
"""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "compare_jobs", Path(__file__).with_name("compare-jobs.py"))
cj = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cj)


def test_cell_interrupt_is_a_wedge_even_with_many_turns():
    # The exact shape that was false-negatived: a bounded cell wedge that
    # recovered, so many turns and no agent-level deadline.
    log = {"hitDeadline": False, "turns": 29, "cellWedgeCells": [7]}
    assert cj.wedged(log) is True


def test_no_interrupt_is_not_a_wedge():
    log = {"hitDeadline": False, "turns": 29, "cellWedgeCells": []}
    assert cj.wedged(log) is False


def test_legacy_fallback_still_fires_when_no_stream_signal():
    # A run recorded before a per-cell timeout existed: agent-level deadline with
    # few turns, and no cell-interrupt signal available.
    log = {"hitDeadline": True, "turns": 3, "cellWedgeCells": []}
    assert cj.wedged(log) is True


def test_hard_task_exhausting_budget_while_working_is_not_a_wedge():
    log = {"hitDeadline": True, "turns": 40, "cellWedgeCells": []}
    assert cj.wedged(log) is False


def test_interrupt_mark_matches_the_harness_notice():
    # If neutralize-prime.mjs changes the notice wording, this catches it.
    notice = "[this cell was INTERRUPTED after 600s and did not finish. ...]"
    assert cj.INTERRUPT_MARK in notice


def test_watchdog_interrupt_counts_as_a_wedge_and_is_tracked_as_taught(tmp=None):
    # The prelude watchdog fires at ceiling-margin and preempts the harness's
    # INTERRUPT_MARK, so a fixed run carries only WATCHDOG_MARK. The kernel was
    # still held ~585s, so it is still wedged — counting only INTERRUPT_MARK would
    # score the fix a cure (True->False) when it is a teaching interrupt at the same
    # wall-clock. Both are wedges; the watchdog one is additionally "taught".
    import json as _json
    import tempfile
    d = Path(tempfile.mkdtemp())
    logs = d / "agent-logs"
    logs.mkdir()
    rows = [
        {"type": "tool_execution_end", "result": "ok, done"},
        {"type": "tool_execution_end",
         "result": "RuntimeError: this cell held the kernel for 585s ... jobs.submit(...)"},
    ]
    (logs / "stream.jsonl").write_text("\n".join(_json.dumps(r) for r in rows))
    wedged_idx, taught_idx = cj._cell_wedge_indices(d)
    assert wedged_idx == [1], wedged_idx      # the watchdog cell is wedged
    assert taught_idx == [1], taught_idx      # and it was taught, not bare-killed
    assert cj.wedged({"cellWedgeCells": wedged_idx}) is True


def test_harness_interrupt_is_wedged_but_not_taught():
    import json as _json
    import tempfile
    d = Path(tempfile.mkdtemp())
    logs = d / "agent-logs"
    logs.mkdir()
    rows = [{"type": "tool_execution_end",
             "result": "[this cell was INTERRUPTED after 600s and did not finish.]"}]
    (logs / "stream.jsonl").write_text("\n".join(_json.dumps(r) for r in rows))
    wedged_idx, taught_idx = cj._cell_wedge_indices(d)
    assert wedged_idx == [0]
    assert taught_idx == []                   # a bare harness kill teaches nothing


if __name__ == "__main__":
    import traceback

    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"ok   {fn.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL {fn.__name__}")
            traceback.print_exc()
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
