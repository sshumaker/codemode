"""Pin the triage taxonomy.

Written after `report.py` classified an **oracle** run's failure as
`AGENT: tests ran and failed` — a run in which no model was called at all. The
number it printed ("AGENT-attributable 1/1") was exactly the number this scout
exists to avoid producing.

The generalisable form, and the reason this file is committed rather than left as
a fixed line: a taxonomy that can assign a cause the run could not possibly have
had will do so silently, and the output looks the same either way.

    uv run pytest bench/terminal/test_report.py -q
"""

from bench.terminal.report import classify


def trial(**kw):
    base = {"task_id": "some-task", "is_resolved": False, "failure_mode": "unset"}
    base.update(kw)
    return base


def test_oracle_failure_is_never_agent():
    """The oracle runs the task's own shipped solution.sh."""
    cause, _ = classify(trial(parser_results={"t": "failed"}), None, agent="oracle")
    assert cause == "REFERENCE"


def test_nop_failure_is_the_control_working():
    cause, _ = classify(trial(parser_results={"t": "failed"}), None, agent="nop")
    assert cause == "CONTROL"


def test_a_real_agent_failing_tests_is_the_only_result_that_counts():
    cause, why = classify(
        trial(parser_results={"t": "failed"}), {"toolCalls": 9}, agent="prime")
    assert cause == "AGENT"
    assert "tests ran and failed" in why


def test_no_tool_call_reaching_the_transport_is_harness_not_agent():
    """The check that was missing when an arm advertised tools it could never
    call: 70 turns, 78 tool calls, 0 reaching the transport, reported as a
    failed task."""
    cause, _ = classify(trial(parser_results={"t": "failed"}),
                        {"toolCalls": 0}, agent="prime")
    assert cause == "HARNESS"


def test_parse_error_is_grader_not_agent():
    """`broken-python`'s run-tests.sh needs the very pip the task broke."""
    cause, _ = classify(trial(failure_mode="parse_error"), None, agent="prime")
    assert cause == "GRADER"


def test_agent_timeout_splits_on_whether_the_agent_ever_acted():
    acted, _ = classify(trial(failure_mode="agent_timeout"),
                        {"toolCalls": 40}, agent="prime")
    idle, _ = classify(trial(failure_mode="agent_timeout"),
                       {"toolCalls": 0}, agent="prime")
    assert acted == "AGENT"
    assert idle == "HARNESS"


def test_known_platform_failure_is_excluded_by_name():
    cause, why = classify(trial(task_id="build-tcc-qemu",
                                parser_results={"t": "failed"}),
                          {"toolCalls": 5}, agent="prime")
    assert cause == "HARNESS"
    assert "x86" in why


def test_an_unrecognised_failure_mode_is_never_silently_an_agent_failure():
    cause, _ = classify(trial(failure_mode="something_new"), None, agent="prime")
    assert cause == "UNCLASSIFIED"
