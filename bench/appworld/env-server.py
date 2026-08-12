#!/usr/bin/env python3
"""
One AppWorld task world, behind the same HTTP protocol both arms already speak.

    bench/appworld/env-server.py --task-id 82e2fac_1 --run-dir .run/appworld/<runId> \
                                 [--port 0] [--arm codemode]

Endpoints
---------
POST /call      {server, tool, args, meta}  -> {ok, text}   both arms
POST /execute   {code}                      -> {ok, text}   native control arm only
POST /evaluate  {}                          -> full grader report
GET  /snapshot                              -> world diff the grader is about to read
GET  /health                                -> {ok, ready, taskId}
POST /shutdown

Why an HTTP server in front of an in-process object
---------------------------------------------------
`/call` is byte-compatible with `bench/mcp-proxy.mjs`, so the generated `api/`
tree (`_client.py`) and the vanilla arm's tool extension both work against it
**unchanged**. That is not a convenience; it is the fairness invariant. On
MCP-Bench, 78% of the vanilla arm's bash calls were `curl` straight past its own
tool surface, and the fix that held was making one transport the only way to
reach the world. One transport also means one log containing every call either
arm made, which is the thing §4 of docs/TAC-HANDOFF.md exists about.

`/call` dispatches through `world.execute("print(apis.<app>.<api>(**args))")` —
which is literally what upstream's own function-calling agent does
(experiments/code/simplified/function_calling_agent.py:185). Poking
`world.requester` directly would be faster and would also be a reimplementation
of the harness; TAC bug #1 was measuring the clone instead of the thing.

What gets logged, and why each one
----------------------------------
`env-calls.jsonl`   every call: arm, server, tool, args, the exact code executed,
                    the full response text, ok/error, start and end timestamps.
                    AppWorld's own `api_calls.jsonl` records `{method, url, data}`
                    and **no response** (src/appworld/requester.py:82), so without
                    this we would record what the agent asked and not what the
                    world answered — and the world is in-memory SQLite that stops
                    existing when this process exits.
`evaluation.json`   the grader's verdicts AND its inputs: per-test pass/fail with
                    tracebacks, plus the ground-truth answer and the answer the
                    agent actually committed.
`world-diff.json`   every added/updated/removed database record, per model, taken
                    **before** grading. This is the evidence behind a rule-based
                    verdict. TAC lost a disputed checkpoint permanently because
                    the deciding input lived in mutable state that had already
                    been reset.
`dbs/`              AppWorld's own state dump (`save_state`, "changes" format).
                    Diff against the pinned `data/base_dbs` and the verdict is
                    re-derivable tomorrow without this process.
`phases.json`       wall-clock boundaries for world-up / agent / snapshot / grade.

Safety
------
`raise_on_failure=False`, matching upstream's verifier (src/appworld/verify.py:154).
Under the default, an API error raises inside the interpreter and kills the rest
of the cell — which is not arm-neutral, since codemode issues many calls per cell
and vanilla issues one. Measured: 11 of 147 ground-truth solutions fail under the
default. See docs/BENCHMARK-SELECTION.md §4.1.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import socketserver
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer

# --- CLI ---------------------------------------------------------------------

parser = argparse.ArgumentParser()
parser.add_argument("--task-id", required=True)
parser.add_argument("--run-dir", required=True, help="where logs and snapshots are written")
parser.add_argument("--port", type=int, default=0, help="0 = pick a free port and print it")
parser.add_argument("--arm", default="unknown")
parser.add_argument("--experiment-name", default=None)
parser.add_argument("--appworld-root", default=None)
parser.add_argument(
    "--max-api-calls-per-interaction",
    type=int,
    default=None,
    help="AppWorld default if unset. One /call is one interaction, so this caps a single tool call.",
)
args = parser.parse_args()

RUN_DIR = os.path.abspath(args.run_dir)
os.makedirs(RUN_DIR, exist_ok=True)
CALL_LOG = os.path.join(RUN_DIR, "env-calls.jsonl")
HTTP_LOG = os.path.join(RUN_DIR, "http-calls.jsonl")

# ---------------------------------------------------------------------------
# Everything in this block must happen BEFORE `import appworld`. Both of these
# were silent, measured failures, not precautions.
#
# 1. `SafetyGuard` (src/appworld/common/safety_guard.py) replaces
#    `builtins.open`, `os.open`, `os.write`, `io.open`, `shutil.copy*` and more
#    with functions that refuse — process-wide — for the duration of every
#    `world.execute`, and restores them afterwards
#    (environment.py:1000 enable / 1020 disable). It is there to stop agent code
#    touching the machine, and it cannot tell agent code from ours.
#
#    So a log write issued from an HTTP thread while ANY cell is mid-execution
#    hits the disabled `open` and raises — which `record()` swallowed, because
#    "logging must never break the run it is observing". Measured: 8 concurrent
#    /call requests produced **1** log line, and the real vanilla run lost 3 of 8
#    calls. Note the shape of the bias: lines are lost in proportion to how many
#    calls an arm issues concurrently, so the arm that batches more is logged
#    less, silently.
#
#    Holding an already-open file object is immune — the guard swaps the factory,
#    not the handle. Same for a saved reference to the real `open`.
#
# 2. AppWorld freezes the clock to the task's own datetime with freezegun, so
#    every event of every run is stamped 1684411200.0. The first trajectory read
#    showed every timestamp identical, which defeats the point of stamping them.
#
#    Saving a reference to `time.time` before the freeze does NOT help: freezegun
#    walks `sys.modules` and swaps every alias of the functions it fakes, so our
#    own module-level name gets replaced too. Measured under `freeze_time`:
#
#        time.time()        1684411200.0
#        saved reference    1684411200.0   <- the obvious fix, and it does not work
#        time.monotonic()   1684411200.0
#        time.time_ns()     1684411200000000000
#        time.perf_counter_ns()  1684411200000000000
#        time.clock_gettime(CLOCK_REALTIME)  1786434734.086358   <- real
#
#    `clock_gettime` is the one clock freezegun leaves alone.
import shutil as _shutil  # noqa: E402 — captured before the guard sees it

_REAL_OPEN = open
_REAL_COPYTREE = _shutil.copytree


def _REAL_TIME() -> float:  # noqa: N802 — reads as a constant-like clock source
    """Wall-clock seconds, unaffected by AppWorld's frozen clock."""
    return time.clock_gettime(time.CLOCK_REALTIME)
# buffering=1 is line-buffered, so a crashed run keeps everything up to the crash.
_LOG_FH = _REAL_OPEN(CALL_LOG, "a", buffering=1)
_HTTP_FH = _REAL_OPEN(HTTP_LOG, "a", buffering=1)
# Long AppWorld responses (a 92-song library listing) are kept whole: they are the
# grounding evidence for the agent's claims, and the whole point of logging the
# response side is that we cannot get it back later.
_write_lock = threading.Lock()

PHASES: dict[str, float] = {}

# Everything that touches the world runs on the MAIN thread.
#
# `world.execute` installs a `signal.alarm` for its per-cell timeout, and
# `signal.signal` raises "signal only works in main thread of the main
# interpreter" anywhere else. A plain mutex around the world is therefore not
# enough — the call has to be *handed to* the main thread, not merely serialized.
# HTTP handlers push a thunk onto this queue and block on its result; the main
# thread is a loop that drains it. That also gives strict serialization for free,
# which the world needs anyway.
_JOBS: "queue.Queue[tuple[object, object]]" = None  # set in __main__


def in_world(fn):
    """Run `fn()` on the main thread and return its value (or re-raise)."""
    done = threading.Event()
    box: dict[str, object] = {}

    def job() -> None:
        try:
            box["value"] = fn()
        except BaseException as exc:  # noqa: BLE001 — forwarded to the caller
            box["error"] = exc
        finally:
            done.set()

    _JOBS.put(job)
    done.wait()
    if "error" in box:
        raise box["error"]  # type: ignore[misc]
    return box["value"]


_dropped_log_lines = 0


def record(entry: dict) -> None:
    """Append one line to env-calls.jsonl through the pre-opened handle.

    Never uses `open` — see the SafetyGuard note above. A failure here is counted
    and reported at shutdown rather than swallowed: "logging must never break the
    run" turned into "logging silently did not happen", which is worse.
    """
    global _dropped_log_lines
    with _write_lock:
        try:
            _LOG_FH.write(json.dumps(entry, default=str) + "\n")
        except Exception as exc:  # noqa: BLE001
            _dropped_log_lines += 1
            log(f"[env-server] LOG WRITE FAILED ({_dropped_log_lines} so far): {exc}")


_http_lock = threading.Lock()


def record_http(entry: dict) -> None:
    """One line per underlying HTTP request, from bench/appworld/requester_trace.py."""
    global _dropped_log_lines
    with _http_lock:
        try:
            _HTTP_FH.write(json.dumps(entry, default=str) + "\n")
        except Exception as exc:  # noqa: BLE001
            _dropped_log_lines += 1
            log(f"[env-server] HTTP LOG WRITE FAILED ({_dropped_log_lines} so far): {exc}")


def log(*parts: object) -> None:
    print(*parts, file=sys.stderr, flush=True)


# --- world -------------------------------------------------------------------

if args.appworld_root:
    os.chdir(args.appworld_root)

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

from appworld import AppWorld  # noqa: E402

# Wrap the transport BEFORE any world is built, so seeding and every agent call
# funnel through the traced methods. See bench/appworld/requester_trace.py for why
# this exists alongside env-calls.jsonl.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requester_trace  # noqa: E402

requester_trace.install(record=record_http, clock=_REAL_TIME)

EXPERIMENT = args.experiment_name or f"harness_{os.path.basename(RUN_DIR)}"

PHASES["world_start"] = _REAL_TIME()
_extra = ({"max_api_calls_per_interaction": args.max_api_calls_per_interaction}
          if args.max_api_calls_per_interaction is not None else {})


def _open_world(ground_truth_mode: str) -> AppWorld:
    return AppWorld(
        task_id=args.task_id,
        experiment_name=EXPERIMENT,
        # See the module docstring: this flag is not cosmetic and not arm-neutral.
        raise_on_failure=False,
        load_ground_truth=True,
        ground_truth_mode=ground_truth_mode,
        **_extra,
    )


# `full` on train/dev, `minimal` on the test splits.
#
# The test splits ship only `minimal` ground truth — the licence forbids
# distributing their solutions — and asking for `full` raises outright:
# "The ground truth for 3d9a636_1 available in minimal mode, and so cannot be
# loaded in full mode." `minimal` is enough to grade; what it costs is
# `required_apis`, which is analysis-only and must never reach an arm anyway.
#
# Hardcoding `full` would have worked on every task validated so far and failed on
# every task of the split the real run uses. That is the TAC validation mistake
# exactly: four fast near-ceiling tasks, then failures living entirely in the
# family the validation set did not contain.
try:
    WORLD = _open_world("full")
    GROUND_TRUTH_MODE = "full"
except Exception as exc:  # noqa: BLE001
    log(f"[env-server] full ground truth unavailable ({exc}); falling back to minimal")
    WORLD = _open_world("minimal")
    GROUND_TRUTH_MODE = "minimal"
WORLD.__enter__()
PHASES["world_ready"] = _REAL_TIME()
log(f"[env-server] world ready: task={args.task_id} experiment={EXPERIMENT} ground_truth={GROUND_TRUTH_MODE}")


def python_literal(value: object) -> str:
    """Render an argument dict as a Python literal for the dispatch line.

    `repr` on a dict of JSON scalars is a valid Python literal, and JSON's
    true/false/null do not survive `json.dumps` into Python source. Upstream does
    the same via `str(json.loads(...))`.
    """
    return repr(value)


def call_code(app: str, api: str, kwargs: dict) -> str:
    # `print(...)` is how the result reaches the execute() return value; upstream's
    # function-calling agent builds the identical line.
    return f"print(apis.{app}.{api}(**{python_literal(kwargs)}))"


# --- handlers ----------------------------------------------------------------


def handle_call(payload: dict) -> tuple[int, dict]:
    """MCP-proxy-compatible: {server, tool, args, meta} -> {ok, text}."""
    app = payload.get("server")
    api = payload.get("tool")
    call_args = payload.get("args") or {}
    meta = payload.get("meta") or {}
    if not app or not api:
        return 400, {"ok": False, "error": "both 'server' (app) and 'tool' (api) are required"}
    # Arguments explicitly set to None are dropped, matching renderClient(): several
    # AppWorld APIs reject an explicit null where an omitted optional is fine.
    call_args = {k: v for k, v in call_args.items() if v is not None}

    code = call_code(app, api, call_args)
    entry = {
        "t": _REAL_TIME(),
        "kind": "call",
        "arm": meta.get("arm", args.arm),
        "runId": meta.get("runId", ""),
        "app": app,
        "api": api,
        "args": call_args,
        "code": code,
    }
    started = _REAL_TIME()
    try:
        text = in_world(lambda: WORLD.execute(code))
        ok = True
        error = None
    except Exception as exc:  # noqa: BLE001 — surfaced to the agent as-is
        text = ""
        ok = False
        error = f"{type(exc).__name__}: {exc}"
        entry["traceback"] = traceback.format_exc()
    interaction = WORLD.interaction_number()
    entry.update({
        "ok": ok,
        "error": error,
        # The full response. This is the irreplaceable half — everything else can
        # be re-derived from the code, this cannot.
        "response": text,
        "response_len": len(text or ""),
        # A malformed call — unknown API, wrong argument name — comes back as
        # AppWorld's own traceback text rather than a transport error.
        #
        # It is deliberately NOT converted into a failed response. Returning
        # {"ok": false} would make codemode's `_client` raise McpError inside the
        # cell and destroy the rest of that cell's work, while vanilla would lose
        # only the one tool call — the same asymmetry as `raise_on_failure` (see
        # docs/BENCHMARK-SELECTION.md §4.1). Both arms get the traceback as text
        # and both carry on; this flag is how the failure is still counted.
        "execFailed": bool(text) and text.lstrip().startswith("Execution failed"),
        "interaction": interaction,
        "seconds": round(_REAL_TIME() - started, 4),
        "t_end": _REAL_TIME(),
    })
    record(entry)
    if not ok:
        return 200, {"ok": False, "error": error}
    return 200, {"ok": True, "text": text}


def handle_execute(payload: dict) -> tuple[int, dict]:
    """Raw code into AppWorld's own interpreter — the native control arm only."""
    code = payload.get("code")
    if not isinstance(code, str):
        return 400, {"ok": False, "error": "'code' (string) is required"}
    meta = payload.get("meta") or {}
    entry = {"t": _REAL_TIME(), "kind": "execute", "arm": meta.get("arm", args.arm),
             "runId": meta.get("runId", ""), "code": code}
    started = _REAL_TIME()
    try:
        text = in_world(lambda: WORLD.execute(code))
        ok, error = True, None
    except Exception as exc:  # noqa: BLE001
        text, ok = "", False
        error = f"{type(exc).__name__}: {exc}"
        entry["traceback"] = traceback.format_exc()
    interaction = WORLD.interaction_number()
    entry.update({"ok": ok, "error": error, "response": text,
                  "response_len": len(text or ""), "interaction": interaction,
                  "execFailed": bool(text) and text.lstrip().startswith("Execution failed"),
                  "seconds": round(_REAL_TIME() - started, 4), "t_end": _REAL_TIME()})
    record(entry)
    return 200, ({"ok": True, "text": text} if ok else {"ok": False, "error": error})


def build_world_diff() -> dict:
    """Every database record the agent added, changed or removed.

    Rebuilt with AppWorld's own `ModelCollectionPair`, constructed exactly as
    `evaluator.evaluate_task` does, so this is the grader's view of the world and
    not a parallel notion of it.
    """
    from appworld.collections.models import ModelCollection, ModelCollectionPair
    from appworld.common.path_store import path_store
    from appworld.apps.lib.models.db import get_db_home_path
    from appworld.task import Task

    task = Task.load(task_id=args.task_id)
    end_in_memory = get_db_home_path(storage_type="memory", type="task_output", task_id=args.task_id)
    end_on_disk = os.path.join(path_store.experiment_outputs, EXPERIMENT, "tasks", args.task_id, "dbs")
    models_start = task.model_collection
    models_end = ModelCollection.load(
        to_db_home_path=end_in_memory,
        from_db_home_path=end_on_disk,
        load_apps=task.allowed_apps,
    )
    pair = ModelCollectionPair(
        start_db_home_path=models_start.from_db_home_path,
        start_model_collection=models_start,
        end_db_home_path=end_in_memory,
        end_model_collection=models_end,
    )

    def rows(records: list) -> list[dict]:
        out = []
        for record_ in records:
            try:
                out.append(json.loads(record_.model_dump_json()))
            except Exception:
                out.append({"_repr": repr(record_)})
        return out

    # Two calls, unioned. `include=` **restricts** the candidate set rather than
    # adding to it (`candidate_model_names = include_model_names`,
    # collections/models.py:407) — so the obvious one-liner
    # `changed_model_names(include=["supervisor.Task"])` returned *only*
    # supervisor.Task and silently threw away the entire world diff. Caught by
    # reading one run: the grader passed 8/8 on assertions about
    # `file_system.File` and `file_system.Directory` while world-diff.json claimed
    # nothing but the task record had changed.
    #
    # `supervisor.Task` needs its own call because the no-argument form ignores it
    # by design (it always changes) — and it holds the committed answer, the single
    # most disputed field in any verdict.
    #
    # Fresh lists each time: `_changed_model_names` appends to the `ignore` list it
    # is given.
    changed = sorted(set(pair.changed_model_names()) | set(pair.changed_model_names(include=["supervisor.Task"])))
    diff: dict[str, object] = {"changedModelNames": changed, "models": {}}
    for name in changed:
        try:
            added, updated, removed = pair.changed_records(name)
            diff["models"][name] = {
                "added": rows(added), "updated": rows(updated), "removed": rows(removed),
            }
        except Exception as exc:  # noqa: BLE001
            diff["models"][name] = {"error": f"{type(exc).__name__}: {exc}"}
    return diff


def handle_snapshot() -> tuple[int, dict]:
    PHASES.setdefault("snapshot_start", _REAL_TIME())
    def work():
        # Flush the in-memory DB to disk first: build_world_diff and the grader
        # both read the on-disk copy, and `save_logs` writes AppWorld's own
        # api_calls.jsonl / environment_io.md next to it.
        WORLD.save_state()
        WORLD.save_logs()
        try:
            return build_world_diff(), None
        except Exception as exc:  # noqa: BLE001
            return {}, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"

    diff, err = in_world(work)
    payload = {
        "ok": err is None,
        "taskId": args.task_id,
        "experimentName": EXPERIMENT,
        "interactions": WORLD.interaction_number(),
        "taskCompleted": _safe(lambda: in_world(WORLD.task_completed)),
        "diff": diff,
        "error": err,
    }
    with _REAL_OPEN(os.path.join(RUN_DIR, "world-diff.json"), "w") as fh:
        json.dump(payload, fh, indent=1, default=str)
    PHASES["snapshot_end"] = _REAL_TIME()
    return 200, payload


def _safe(fn):
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001
        return f"error: {type(exc).__name__}: {exc}"


def handle_evaluate() -> tuple[int, dict]:
    PHASES["grade_start"] = _REAL_TIME()
    def work():
        WORLD.save_state()
        WORLD.save_logs()
        try:
            tracker = WORLD.evaluate(suppress_errors=True)
            report = tracker.to_dict()
            payload = {
                "ok": True,
                "taskId": args.task_id,
                # TGC. Never rank on pass/total: a do-nothing run scores 1/2 on a
                # read-only task because "no collateral damage" passes trivially.
                # See docs/BENCHMARK-SELECTION.md §4.2.
                "success": bool(tracker.success),
                "passCount": tracker.pass_count,
                "failCount": tracker.fail_count,
                "totalCount": tracker.total_count,
                "numTests": tracker.num_tests,
                "passPercentage": tracker.pass_percentage,
                "difficulty": report.get("difficulty"),
                # Per-test verdicts with tracebacks — the grader's reasoning, not
                # just its conclusion.
                "report": report,
                "textReport": tracker.report(print_it=False, colorize=False),
            }
        except Exception as exc:  # noqa: BLE001
            payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}",
                       "traceback": traceback.format_exc()}
        return payload

    payload = in_world(work)

    # The grader's *inputs*, recorded alongside its verdicts. A verdict without
    # them is exactly what made a TAC checkpoint permanently undiagnosable.
    payload["groundTruthMode"] = GROUND_TRUTH_MODE
    try:
        gt = WORLD.task.ground_truth
        payload["groundTruthAnswer"] = gt.answer if gt else None
    except Exception as exc:  # noqa: BLE001
        payload["groundTruthError"] = f"{type(exc).__name__}: {exc}"
    # Analysis only, and unavailable on the test splits (minimal ground truth).
    # Never shown to an arm.
    try:
        payload["requiredApis"] = list(WORLD.task.ground_truth.required_apis)
    except Exception as exc:  # noqa: BLE001
        payload["requiredApis"] = None
        payload["requiredApisError"] = f"{type(exc).__name__}: {exc}"
    payload["committedAnswer"] = _safe(lambda: in_world(_committed_answer))
    payload["taskCompleted"] = _safe(lambda: in_world(WORLD.task_completed))
    PHASES["grade_end"] = _REAL_TIME()
    payload["phases"] = dict(PHASES)

    with _REAL_OPEN(os.path.join(RUN_DIR, "evaluation.json"), "w") as fh:
        json.dump(payload, fh, indent=1, default=str)
    return 200, payload


def _committed_answer():
    """The answer the agent actually submitted via supervisor.complete_task."""
    from appworld.task import Task
    from appworld.collections.models import ModelCollection
    from appworld.common.path_store import path_store
    from appworld.apps.lib.models.db import get_db_home_path

    task = Task.load(task_id=args.task_id)
    models_end = ModelCollection.load(
        to_db_home_path=get_db_home_path(storage_type="memory", type="task_output", task_id=args.task_id),
        from_db_home_path=os.path.join(path_store.experiment_outputs, EXPERIMENT, "tasks", args.task_id, "dbs"),
        load_apps=task.allowed_apps,
    )
    tasks = models_end.supervisor.Task.all()
    if not tasks:
        return None
    return {"answer": tasks[0].answer, "status": tasks[0].status}


# --- HTTP --------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence per-request stderr spam
        pass

    def _send(self, status: int, body: dict) -> None:
        raw = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "ready": True, "taskId": args.task_id,
                             "interactions": WORLD.interaction_number()})
        elif self.path == "/snapshot":
            self._send(*handle_snapshot())
        else:
            self._send(404, {"ok": False, "error": f"no such path: {self.path}"})

    def do_POST(self):
        payload = self._body()
        if self.path == "/call":
            self._send(*handle_call(payload))
        elif self.path == "/execute":
            self._send(*handle_execute(payload))
        elif self.path == "/evaluate":
            self._send(*handle_evaluate())
        elif self.path == "/phases":
            # The harness reports agent-phase boundaries it alone knows about.
            PHASES.update({k: float(v) for k, v in (payload or {}).items()})
            self._send(200, {"ok": True, "phases": PHASES})
        elif self.path == "/shutdown":
            self._send(200, {"ok": True})
            threading.Thread(target=_shutdown, daemon=True).start()
        else:
            self._send(404, {"ok": False, "error": f"no such path: {self.path}"})


class Threaded(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


SERVER = Threaded(("127.0.0.1", args.port), Handler)


_STOP = object()


def _shutdown() -> None:
    time.sleep(0.2)
    SERVER.shutdown()
    _JOBS.put(_STOP)


if __name__ == "__main__":
    _JOBS = queue.Queue()
    port = SERVER.server_address[1]
    with _REAL_OPEN(os.path.join(RUN_DIR, "env-server.json"), "w") as fh:
        json.dump({"port": port, "taskId": args.task_id, "experimentName": EXPERIMENT,
                   "pid": os.getpid(), "callLog": CALL_LOG}, fh, indent=1)
    # The harness blocks on this line before starting the agent. An unrecorded run
    # otherwise looks identical to a recorded one — the same reason TAC's proxy
    # verifies it is listening first.
    print(f"ENV_SERVER_READY port={port}", flush=True)
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()
    try:
        # The main thread is the world. See `in_world`: signal-based cell timeouts
        # only work here, so requests are executed on this loop rather than on the
        # thread that received them.
        while True:
            job = _JOBS.get()
            if job is _STOP:
                break
            job()
    except KeyboardInterrupt:
        pass
    finally:
        with _REAL_OPEN(os.path.join(RUN_DIR, "phases.json"), "w") as fh:
            json.dump({**PHASES, "droppedLogLines": _dropped_log_lines}, fh, indent=1)
        if _dropped_log_lines:
            log(f"[env-server] WARNING: {_dropped_log_lines} call log lines were lost")
        for fh in (_LOG_FH, _HTTP_FH):
            try:
                fh.flush()
                fh.close()
            except Exception:
                pass
        try:
            WORLD.__exit__(None, None, None)
        except Exception:
            pass
        # Make the run directory self-contained.
        #
        # AppWorld writes its own artefacts under
        # experiments/outputs/<experiment>/tasks/<task>/ — the `dbs/` state dump the
        # verdict is re-derivable from, its `logs/api_calls.jsonl`, and
        # `logs/environment_io.md` (every cell it executed). Those live outside the
        # run directory and the next run's `experiment_name` is different, so
        # nothing overwrites them — but leaving a run's evidence in two places is
        # how it gets separated from the run. Copy, do not move: upstream's
        # `appworld evaluate` reads the original location.
        try:
            from appworld.common.path_store import path_store

            src = os.path.join(path_store.experiment_outputs, EXPERIMENT, "tasks", args.task_id)
            dst = os.path.join(RUN_DIR, "appworld-output")
            if os.path.isdir(src):
                # dirs_exist_ok, because `docker cp`-style "copies *into* an existing
                # directory" has bitten this project twice.
                _REAL_COPYTREE(src, dst, dirs_exist_ok=True)
                log(f"[env-server] copied appworld artefacts -> {dst}")
        except Exception as exc:  # noqa: BLE001
            log(f"[env-server] could not copy appworld artefacts: {exc}")
