"""
Tool invocations: one durable record per piece of work a session started, and the
owed-items rule that wakes the agent for every outcome it has not been given.

Design: docs/TOOL-INVOCATIONS.md. In short:

    <job_dir>/invocations/<quoted id>.json   one record per invocation
    <job_dir>/invocations/calls.jsonl        the inline backend's event log (#25's
                                             call journal, written by the kernel)

A record is pending -> running -> succeeded | failed | unknown | cancelled | expired.
It is OWED when it is terminal and its outcome has not been delivered to the model.
Blocking items (what the agent's latest jobs.wait named) wake as a set; every other
owed item wakes the session by itself.

Stdlib only: this module is imported inside the agent's kernel (via jobs.py).
"""

from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.parse
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

INVOCATIONS_DIR = "invocations"
CALL_LOG = "calls.jsonl"

PENDING, RUNNING = "pending", "running"
SUCCEEDED, FAILED, UNKNOWN, CANCELLED, EXPIRED = "succeeded", "failed", "unknown", "cancelled", "expired"
STATES = (PENDING, RUNNING, SUCCEEDED, FAILED, UNKNOWN, CANCELLED, EXPIRED)
TERMINAL = (SUCCEEDED, FAILED, UNKNOWN, CANCELLED, EXPIRED)

IDEMPOTENT, LOOKUP, AT_MOST_ONCE, AT_LEAST_ONCE, READ_ONLY = (
    "idempotent",
    "lookup",
    "at_most_once",
    "at_least_once",
    "read_only",
)
DELIVERY_MODES = (IDEMPOTENT, LOOKUP, AT_MOST_ONCE, AT_LEAST_ONCE, READ_ONLY)
# An undeclared tool may have side effects, so it is never resent.
DEFAULT_DELIVERY = AT_MOST_ONCE

UNKNOWN_ADVICE = "may or may not have taken effect — verify before retrying"


# -- identity and metadata -------------------------------------------------------


def invocation_dir(job_dir: str) -> str:
    return os.path.join(job_dir, INVOCATIONS_DIR)


def job_invocation_id(rec: dict) -> str:
    """A job's id: its name and the started_at submit() wrote before spawning anything."""
    kind = "subagent" if rec.get("kind") == "subagent" else "job"
    return f"{kind}:{rec['name']}@{int(float(rec['started_at']) * 1000)}"


def call_invocation_id(execution_id: str, seq: int) -> str:
    return f"call:{execution_id}:{seq}"


def params_hash(params: Any) -> Optional[str]:
    if params is None:
        return None
    blob = json.dumps(params, sort_keys=True, default=str, separators=(",", ":")).encode()
    return hashlib.sha256(blob).hexdigest()


def load_delivery_table(env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """HARNESS_TOOL_DELIVERY: a JSON file of {"server.tool" | "server.*": mode}."""
    env = os.environ if env is None else env
    path = env.get("HARNESS_TOOL_DELIVERY")
    if not path:
        return {}
    try:
        with open(path) as fh:
            table = json.load(fh)
    except (OSError, ValueError):
        return {}
    return {str(k): v for k, v in table.items() if v in DELIVERY_MODES} if isinstance(table, dict) else {}


def delivery_for(name: str, table: Optional[Dict[str, str]] = None) -> str:
    """Exact name, then `server.*`, then the safe default."""
    table = load_delivery_table() if table is None else table
    if name in table:
        return table[name]
    server = name.split(".", 1)[0]
    return table.get(f"{server}.*", DEFAULT_DELIVERY)


def _pid_alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, ValueError):
        return False
    # A zombie answers kill(0); it is not running anything.
    try:
        import subprocess

        out = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return bool(out.stdout.strip()) and not out.stdout.strip().startswith("Z")
    except Exception:  # noqa: BLE001 - unprobeable means assume alive: never invent an UNKNOWN
        return True


# -- the store --------------------------------------------------------------------


class InvocationStore:
    """
    The owed-items record for one session's job directory.

    Owns: invocation records, their state transitions, blocking flags, delivery
    (two-phase for the scheduler, direct for reads), and folding the inline call log.
    Not responsible for: running anything. Backends do the work and report events.
    """

    def __init__(
        self,
        job_dir: str,
        *,
        now: Callable[[], float] = time.time,
        pid_alive: Callable[[Optional[int]], bool] = _pid_alive,
    ):
        self.job_dir = job_dir
        self.dir = invocation_dir(job_dir)
        self._now = now
        self._pid_alive = pid_alive

    # -- storage
    def _path(self, inv_id: str) -> str:
        return os.path.join(self.dir, urllib.parse.quote(inv_id, safe="@._-") + ".json")

    def get(self, inv_id: str) -> Optional[dict]:
        try:
            with open(self._path(inv_id)) as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            return None
        return rec if isinstance(rec, dict) and rec.get("id") == inv_id else None

    def all(self) -> List[dict]:
        try:
            names = sorted(os.listdir(self.dir))
        except OSError:
            return []
        out = []
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.dir, name)) as fh:
                    rec = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(rec, dict) and rec.get("id"):
                out.append(rec)
        return sorted(out, key=lambda r: (r.get("created_at") or 0, r["id"]))

    def _write(self, rec: dict) -> dict:
        os.makedirs(self.dir, exist_ok=True)
        rec["updated_at"] = self._now()
        path = self._path(rec["id"])
        tmp = f"{path}.tmp-{os.getpid()}"
        with open(tmp, "w") as fh:
            json.dump(rec, fh)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
        try:
            dfd = os.open(self.dir, os.O_RDONLY)
            try:
                os.fsync(dfd)
            finally:
                os.close(dfd)
        except OSError:
            pass
        return rec

    # -- lifecycle
    def create(
        self,
        inv_id: str,
        *,
        kind: str,
        name: str,
        delivery: str = DEFAULT_DELIVERY,
        backend: str = "inline",
        params: Any = None,
        params_ref: Optional[str] = None,
        deadline: Optional[float] = None,
        state: str = PENDING,
        **extra: Any,
    ) -> dict:
        """Record an invocation. Idempotent: an id that exists is returned as it is."""
        existing = self.get(inv_id)
        if existing:
            return existing
        if delivery not in DELIVERY_MODES:
            raise ValueError(f"unknown delivery mode {delivery!r}")
        now = self._now()
        rec = {
            "id": inv_id,
            "kind": kind,
            "name": name,
            "delivery": delivery,
            "backend": backend,
            "params_hash": params_hash(params),
            "params_ref": params_ref,
            "state": state,
            "outcome": None,
            "blocking": False,
            "deadline": deadline,
            "created_at": now,
            "started_at": now if state == RUNNING else None,
            "finished_at": None,
            "delivering": None,
            "delivered_at": None,
            "attempts": 0,
            **extra,
        }
        return self._write(rec)

    def transition(self, inv_id: str, state: str, outcome: Optional[dict] = None, **fields: Any) -> Optional[dict]:
        """Move a record forward. A terminal state is final; returns the record either way."""
        if state not in STATES:
            raise ValueError(f"unknown state {state!r}")
        rec = self.get(inv_id)
        if rec is None:
            return None
        if rec["state"] in TERMINAL:
            return rec
        rec["state"] = state
        if outcome is not None:
            rec["outcome"] = outcome
        if state == RUNNING and not rec.get("started_at"):
            rec["started_at"] = self._now()
        if state in TERMINAL:
            rec["finished_at"] = fields.pop("finished_at", None) or self._now()
        rec.update(fields)
        return self._write(rec)

    def reopen(self, inv_id: str) -> Optional[dict]:
        """A retry of an UNKNOWN or orphaned claim that its delivery mode allows to act again."""
        rec = self.get(inv_id)
        if rec is None or rec["state"] not in (RUNNING, UNKNOWN):
            return rec
        rec.update(state=RUNNING, finished_at=None, retried=int(rec.get("retried") or 0) + 1)
        return self._write(rec)

    def resolve_unknown(self, inv_id: str, state: str, outcome: dict) -> Optional[dict]:
        """A LOOKUP answered what an UNKNOWN could not: the one move out of a terminal state."""
        rec = self.get(inv_id)
        if rec is None or rec["state"] != UNKNOWN or state not in (SUCCEEDED, FAILED):
            return rec
        rec.update(state=state, outcome={**outcome, "resolved_from": UNKNOWN})
        return self._write(rec)

    # -- owed items
    def is_owed(self, rec: dict) -> bool:
        return rec.get("state") in TERMINAL and not rec.get("delivered_at")

    def owed(self, *, include_delivering: bool = False) -> List[dict]:
        return [r for r in self.all() if self.is_owed(r) and (include_delivering or not r.get("delivering"))]

    def set_blocking(self, ids: Iterable[str]) -> None:
        """The agent's current choice: these block (a barrier), everything else watches."""
        wanted = set(ids)
        for rec in self.all():
            if rec.get("delivered_at"):
                continue
            blocking = rec["id"] in wanted
            if bool(rec.get("blocking")) != blocking:
                rec["blocking"] = blocking
                self._write(rec)

    def mark_delivered(self, ids: Iterable[str], by: str) -> None:
        now = self._now()
        for inv_id in ids:
            rec = self.get(inv_id)
            if rec and self.is_owed(rec):
                rec.update(delivered_at=now, delivered_by=by, delivering=None)
                self._write(rec)

    def begin_delivery(self, ids: Iterable[str], run_id: str) -> List[str]:
        """Phase one: these outcomes ride on run `run_id`. Returns the ids it took."""
        taken = []
        for inv_id in ids:
            rec = self.get(inv_id)
            if rec and self.is_owed(rec):
                rec["delivering"] = run_id
                self._write(rec)
                taken.append(inv_id)
        return taken

    def commit_delivery(self, run_id: str) -> List[str]:
        """Phase two: the run returned, so the model has them."""
        done = []
        for rec in self.all():
            if rec.get("delivering") == run_id and not rec.get("delivered_at"):
                rec.update(delivered_at=self._now(), delivered_by=f"turn {run_id}", delivering=None)
                self._write(rec)
                done.append(rec["id"])
        return done

    def rollback_delivery(self, run_id: str) -> List[str]:
        """The run crashed: owed again, so the next wake carries them again."""
        back = []
        for rec in self.all():
            if rec.get("delivering") == run_id and not rec.get("delivered_at"):
                rec["delivering"] = None
                rec.setdefault("redelivered", 0)
                rec["redelivered"] += 1
                self._write(rec)
                back.append(rec["id"])
        return back

    def expire_due(self) -> List[str]:
        """Past-deadline work this store owns the clock for. Jobs bind their own max_runtime."""
        now, out = self._now(), []
        for rec in self.all():
            deadline = rec.get("deadline")
            if (
                rec["state"] not in TERMINAL
                and deadline
                and now >= float(deadline)
                and rec.get("backend") != "local_job"
            ):
                self.transition(rec["id"], EXPIRED, {"summary": "deadline reached with no outcome"})
                out.append(rec["id"])
        return out

    # -- reconciliation (every reader calls this; it is derived from disk only)
    def refresh(self) -> None:
        self.sync_jobs()
        self.fold_call_log()
        self.expire_due()

    def sync_jobs(self) -> None:
        """Project every job record: closes a crash between a job write and its projection."""
        try:
            names = os.listdir(self.job_dir)
        except OSError:
            return
        for name in names:
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.job_dir, name)) as fh:
                    rec = json.load(fh)
            except (OSError, ValueError):
                continue
            if isinstance(rec, dict) and "started_at" in rec and rec.get("name"):
                project_job(self, rec)

    def fold_call_log(self, path: Optional[str] = None) -> None:
        """Fold the inline backend's event log into records. Idempotent."""
        path = path or os.path.join(self.dir, CALL_LOG)
        try:
            with open(path) as fh:
                lines = fh.read().splitlines()
        except OSError:
            return
        writer_pid, writer_of, calls, reported = None, {}, {}, {}
        for line in lines:
            try:
                ev = json.loads(line)
            except ValueError:
                continue  # a torn last line: its request was never sent
            if not isinstance(ev, dict):
                continue
            k = ev.get("k")
            if k == "open":
                writer_pid = ev.get("pid")
            elif k == "call":
                inv_id = ev.get("id") or call_invocation_id(str(ev.get("msg")), int(ev.get("n") or 0))
                key = (writer_pid, ev.get("n"))
                writer_of[key] = inv_id
                calls[inv_id] = {"ev": ev, "pid": writer_pid, "end": None}
            elif k == "end":
                inv_id = writer_of.get((writer_pid, ev.get("n")))
                if inv_id in calls:
                    calls[inv_id]["end"] = ev
            elif k == "reported":
                reported[str(ev.get("msg"))] = ev.get("at") or self._now()
        alive: Dict[Any, bool] = {}
        for inv_id, c in calls.items():
            if c["end"] is None and c["pid"] not in alive:
                alive[c["pid"]] = self._pid_alive(c["pid"])
            self._fold_one(inv_id, c, reported, alive.get(c["pid"], True))

    def _fold_one(self, inv_id: str, c: dict, reported: Dict[str, float], writer_alive: bool) -> None:
        ev, end = c["ev"], c["end"]
        rec = self.get(inv_id)
        if rec is None:
            rec = self.create(
                inv_id,
                kind="call",
                name=str(ev.get("name") or "?"),
                delivery=ev.get("delivery") if ev.get("delivery") in DELIVERY_MODES else DEFAULT_DELIVERY,
                backend="inline",
                state=RUNNING,
                execution=ev.get("msg"),
                path=ev.get("path") or "proxy",
                writer_pid=c["pid"],
            )
        if rec["state"] not in TERMINAL:
            if end is not None:
                state = {"completed": SUCCEEDED, "failed": FAILED}.get(end.get("outcome"), UNKNOWN)
                outcome = {"summary": end.get("summary")}
                if end.get("not_sent"):
                    outcome["not_sent"] = True
                # The caller got this answer (or this exception) in the cell: delivered.
                rec = self.transition(inv_id, state, outcome, delivered_at=self._now(), delivered_by="cell")
            elif not writer_alive:
                rec = self.transition(
                    inv_id, UNKNOWN, {"summary": "the kernel died before an answer came back; " + UNKNOWN_ADVICE}
                )
        msg = str(ev.get("msg"))
        if rec and msg in reported and self.is_owed(rec):
            self.mark_delivered([inv_id], by="dead-cell report")


# -- the local_job backend's projection ---------------------------------------------

_JOB_STATES = {
    "starting": PENDING,
    "requested": PENDING,
    "running": RUNNING,
    "died": UNKNOWN,
    "deadline": EXPIRED,
    "killed": CANCELLED,
    "pruned": CANCELLED,
}


def job_state(rec: dict) -> str:
    state = rec.get("state")
    if state == "done":
        return SUCCEEDED if rec.get("exit_code") == 0 else FAILED
    return _JOB_STATES.get(state, RUNNING)


def project_job(store: InvocationStore, rec: dict) -> Optional[dict]:
    """A job record's write, reflected on its invocation. Owns state and outcome only."""
    inv_id = job_invocation_id(rec)
    started = float(rec["started_at"])
    limit = rec.get("max_runtime")
    inv = store.get(inv_id) or store.create(
        inv_id,
        kind="subagent" if rec.get("kind") == "subagent" else "job",
        name=rec["name"],
        delivery=AT_MOST_ONCE,
        backend="local_job",
        params={"cmd": rec.get("cmd")},
        params_ref=os.path.join(store.job_dir, f"{rec['name']}.json"),
        deadline=started + float(limit) if limit else None,
    )
    state = job_state(rec)
    if inv["state"] == state or inv["state"] in TERMINAL:
        return inv
    outcome = None
    if state in TERMINAL:
        outcome = {"summary": rec.get("reason") or state, "exit_code": rec.get("exit_code")}
        if state == UNKNOWN:
            outcome["summary"] = f"{outcome['summary']}; its work {UNKNOWN_ADVICE}"
    return store.transition(inv_id, state, outcome, finished_at=rec.get("finished_at"))


# -- describing an owed item to the model -----------------------------------------


def describe(rec: dict) -> str:
    kind, name, state = rec.get("kind"), rec.get("name"), rec.get("state")
    summary = ((rec.get("outcome") or {}).get("summary") or "").strip()
    label = {"job": f"job {name!r}", "subagent": f"agent {name!r}"}.get(kind, f"{kind} {name}")
    if kind == "call":
        label = f"call {name} ({rec['id']})"
    if state == UNKNOWN:
        word = (
            f"UNKNOWN — {summary}"
            if UNKNOWN_ADVICE in summary
            else f"UNKNOWN — {summary + '; ' if summary else ''}{UNKNOWN_ADVICE}"
        )
    elif kind in ("job", "subagent") and state in (SUCCEEDED, FAILED):
        code = (rec.get("outcome") or {}).get("exit_code")
        word = "succeeded (exit 0)" if state == SUCCEEDED else f"failed (exit {code})"
    else:
        word = f"{state}{' — ' + summary if summary else ''}"
    return f"{label}: {word}"


# -- the inline backend: delivery modes for a synchronous call ---------------------


class NotSent(Exception):
    """Raised by a sender when the request provably never left (connection refused)."""


class ToolFailed(Exception):
    """Raised by a sender when the tool answered with an error: an outcome, not a transport failure."""


class UnknownOutcome(Exception):
    """The call was sent and its outcome is not known. It must not be resent blindly."""

    def __init__(self, rec: dict):
        super().__init__(describe(rec))
        self.record = rec


def _is_not_sent(exc: BaseException) -> bool:
    if isinstance(exc, NotSent):
        return True
    reason = getattr(exc, "reason", exc)
    return isinstance(reason, (ConnectionRefusedError, FileNotFoundError))


def call_inline(
    store: InvocationStore,
    inv_id: str,
    name: str,
    send: Callable[[str], Any],
    *,
    params: Any = None,
    delivery: Optional[str] = None,
    lookup: Optional[Callable[[str], Any]] = None,
    retries: int = 2,
) -> Any:
    """
    Run one synchronous call under its delivery mode. `send(key)` performs it, `key`
    being the invocation id (an idempotency key for tools that take one); it returns
    the answer, raises ToolFailed for an error answer, NotSent when nothing left.
    `lookup(key)` (LOOKUP mode) returns the earlier answer, or None if the tool never
    saw the key. Re-entering with the same id after a crash is a retry.
    """
    delivery = delivery or delivery_for(name)
    rec = store.get(inv_id)
    if rec and rec["state"] in (SUCCEEDED, FAILED):
        return _replay(rec)
    if rec and rec["state"] == UNKNOWN and delivery not in (IDEMPOTENT, LOOKUP, AT_LEAST_ONCE, READ_ONLY):
        raise _told(store, rec)
    if rec and rec["state"] in (RUNNING, UNKNOWN):
        # A claim with no outcome: the previous attempt may have acted.
        if delivery == AT_MOST_ONCE:
            raise _told(
                store,
                store.transition(
                    inv_id, UNKNOWN, {"summary": "claimed and sent with no outcome recorded; " + UNKNOWN_ADVICE}
                )
                or rec,
            )
        # Every other mode may act again: reopen the record so the retry's outcome lands.
        store.reopen(inv_id)
        if delivery == LOOKUP and lookup is not None:
            found = lookup(inv_id)
            if found is not None:
                return _settle(store, inv_id, SUCCEEDED, found)
    if rec is None and delivery != AT_LEAST_ONCE:
        # Claim (fsync'd) before acting. READ_ONLY records too, for the report, but
        # nothing depends on the record surviving.
        store.create(inv_id, kind="call", name=name, delivery=delivery, params=params, state=RUNNING)
    attempts = 0
    while True:
        attempts += 1
        try:
            answer = send(inv_id)
        except ToolFailed as exc:
            _ensure(store, inv_id, name, delivery, params)
            store.transition(inv_id, FAILED, {"summary": str(exc)[:200]}, attempts=attempts, delivered_at=store._now(), delivered_by="caller")
            raise
        except Exception as exc:  # noqa: BLE001 - classified below
            _ensure(store, inv_id, name, delivery, params)
            if _is_not_sent(exc) and attempts <= retries:
                continue  # provably never left: safe in every mode
            if _is_not_sent(exc):
                store.transition(inv_id, FAILED, {"summary": f"not sent: {exc}", "not_sent": True}, attempts=attempts, delivered_at=store._now(), delivered_by="caller")
                raise
            if delivery in (IDEMPOTENT, AT_LEAST_ONCE, READ_ONLY) and attempts <= retries:
                continue
            if delivery == LOOKUP and lookup is not None and attempts <= retries:
                found = lookup(inv_id)
                if found is not None:
                    return _settle(store, inv_id, SUCCEEDED, found, attempts)
                continue
            rec = store.transition(
                inv_id,
                UNKNOWN,
                {"summary": f"sent, no answer ({type(exc).__name__}: {exc}); {UNKNOWN_ADVICE}"},
                attempts=attempts,
            )
            raise _told(store, rec) from exc
        _ensure(store, inv_id, name, delivery, params)
        return _settle(store, inv_id, SUCCEEDED, answer, attempts)


def _told(store: InvocationStore, rec: dict) -> UnknownOutcome:
    """The caller is about to be told the outcome is unknown: that is its delivery."""
    store.mark_delivered([rec["id"]], by="caller")
    return UnknownOutcome(store.get(rec["id"]) or rec)


def _ensure(store: InvocationStore, inv_id: str, name: str, delivery: str, params: Any) -> None:
    if store.get(inv_id) is None:  # AT_LEAST_ONCE: act, then record
        store.create(inv_id, kind="call", name=name, delivery=delivery, params=params, state=RUNNING)


def _settle(store: InvocationStore, inv_id: str, state: str, answer: Any, attempts: int = 1) -> Any:
    text = answer if isinstance(answer, str) else json.dumps(answer, default=str)
    store.transition(
        inv_id,
        state,
        {"summary": text[:200], "answer": answer},
        attempts=attempts,
        delivered_at=store._now(),
        delivered_by="caller",
    )
    return answer


def _replay(rec: dict) -> Any:
    """Memoise on replay: a retry of a settled call gets the recorded outcome, never a resend."""
    if rec["state"] == FAILED:
        raise ToolFailed((rec.get("outcome") or {}).get("summary") or "failed")
    return (rec.get("outcome") or {}).get("answer")


def ids_for_jobs(job_dir: str, names: Sequence[str]) -> List[str]:
    """The invocation ids of the named jobs' current records."""
    out = []
    for name in names:
        try:
            with open(os.path.join(job_dir, f"{name}.json")) as fh:
                rec = json.load(fh)
            out.append(job_invocation_id(rec))
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return out
