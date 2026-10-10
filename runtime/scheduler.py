"""
The wake scheduler — the one new component the cloud harness needs
(docs/CLOUD-HARNESS-DESIGN.md §5).

Everything else already exists: the harness (prime's print loop) runs a turn and
exits, the kernel is rebuildable, jobs are files. What is missing is the party
that notices "this session's wait is due" and re-invokes a fresh harness on it.
prime's daemon solves this with 18k lines of live-process coordination; with the
log-as-truth invariant there is no live process to coordinate, so this is small.

A SESSION is a directory:

    <session-dir>/
      session.json   how to invoke the harness: {"argv": [...], "cwd", "env"}
                     — written once by whoever creates the session. Optional
                     "transcript_dir" names where the harness keeps its session
                     JSONL when it is not prime's default (see _transcript_dirs).
                     Optional end controls (see "the end of a session"):
                     "deadline" (absolute epoch seconds), "deadline_grace_s"
                     (default 300), "end_when_idle" (default false), "reap_grace_s"
      wake.json      the pending wake, written by the RUNTIME (jobs.wait) when a
                     turn ends waiting: {"wake_at": <epoch>, "watch": [names]}
                     — absence means the session is not waiting on anything
      inbox/         user messages: <name>.json pending, .delivering while a turn
                     carries them, .delivered once that turn returned
      turn.json      the turn in flight (see "two-phase delivery" below)
      jobs/          the session's HARNESS_JOB_DIR
      lease/         single-writer lock while a harness is running
      end.json       the session is ending/ended: how, why, what was settled
      reap.json      evidence of every process the end signalled (or would not)

The loop: a session wakes when its deadline passes OR any watched job stops
being live — whichever comes first, exactly the `wake_after` contract. The
scheduler acquires the lease, appends the wake reason to the harness argv,
runs the harness to exit, and releases. The harness's runtime writes a new
wake.json if the agent waits again; a session with no wake.json after a run is
finished business.

Crash-safety is derived from disk, so a scheduler that is SIGKILLed and
restarted resumes correctly — the same invariant runtime/test_chaos.py pins for
jobs. Two pieces make that true for the turn itself, not just the wait:

  - The LEASE covers the agent, not only the scheduler. The scheduler's pid +
    process start identity is in lease/owner.json (prime session-lease's
    defence), and the turn's supervisor and harness child are recorded in
    turn.json. A lease is reclaimed only when all of them are provably gone, so
    a scheduler killed mid-turn never lets a second harness start on a session
    whose first one is still running: the orphan is waited out.

  - TWO-PHASE DELIVERY. Before the run, wake.json becomes wake.json.fired and
    each message <m>.json becomes <m>.json.delivering, with turn.json recording
    the run. When the run returns (any exit code) the messages become
    .delivered and turn.json becomes turn.json.last. A turn.json still present
    when nothing is running is a turn that crashed, and the next scan recovers
    it (`_recover_turn`): messages the transcript never received are re-queued,
    and the session is re-woken once, saying the previous turn was interrupted.
    Recovery is bounded (MAX_CRASH_RECOVERIES) so a crash-looping turn stops.
    A harness that cannot be spawned at all gets its wake and messages back,
    and after MAX_SPAWN_FAILURES in a row is left alone the same way.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from typing import Callable, List, Optional, Sequence

import jobs as J
from agent_mailbox import Mailbox

try:
    import invocations as INV
except ImportError:  # staged without it: wakes work as before, nothing is owed
    INV = None

WAKE_FILE = "wake.json"
SESSION_FILE = "session.json"
LEASE_DIR = "lease"
INBOX_DIR = "inbox"
TURN_FILE = "turn.json"
# Consecutive crashed turns a session is re-woken for before it is left alone.
MAX_CRASH_RECOVERIES = 3
# Consecutive runs whose harness could not even be spawned before the session is left alone.
MAX_SPAWN_FAILURES = 3
# The supervisor's exit when its run was already settled by a recovery.
EXIT_TURN_SUPERSEDED = 75


# -- lease: single-writer, stale-reclaimable, identity-checked ---------------------

def _self_identity() -> dict:
    pid = os.getpid()
    return {"pid": pid, "pid_start": J._real_probe(pid)[1]}


def _identity_alive(ident: Optional[dict], probe=None) -> bool:
    """Is the process this {pid, pid_start} record names still the one that wrote it?"""
    probe = probe or J._real_probe
    pid = (ident or {}).get("pid")
    if not pid:
        return False
    status, start = probe(pid)
    if status == "dead":
        return False
    recorded = ident.get("pid_start")
    # No identity recorded (or unprobeable): assume alive — never steal a lease
    # on missing evidence; a wrongly-stolen lease is two harnesses on one session.
    return not (recorded and start and start != recorded)


def _lease_owner_alive(owner: dict, probe=None) -> bool:
    return _identity_alive(owner, probe)


def _lease_supervisor_alive(lease_path: str, probe=None) -> bool:
    """The turn supervisor the scheduler recorded the instant it spawned it."""
    try:
        with open(os.path.join(lease_path, "supervisor.json")) as fh:
            return _identity_alive(json.load(fh), probe)
    except (OSError, ValueError):
        return False


def turn_processes_alive(session_dir: str, probe=None) -> Optional[dict]:
    """
    The live process of a turn in flight — its supervisor or the harness child —
    or None. A scheduler that dies mid-turn leaves both running; until both are
    provably gone the session is still being served, whoever started it.
    """
    turn = _read_turn(session_dir)
    if not turn or turn.get("state") not in IN_FLIGHT:
        return None
    for role in ("child", "supervisor"):
        if _identity_alive(turn.get(role), probe):
            return dict(turn[role], role=role, run_id=turn.get("run_id"))
    return None


def acquire_lease(session_dir: str, probe=None) -> Optional[str]:
    """
    The lease directory, or None if a live harness holds the session.

    "Live" is the scheduler that took the lease OR the turn it started: a lease
    whose scheduler is dead but whose harness child still runs is not stale.
    """
    path = os.path.join(session_dir, LEASE_DIR)
    candidate = f"{path}.candidate-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    os.makedirs(candidate)
    with open(os.path.join(candidate, "owner.json"), "w") as fh:
        json.dump(_self_identity(), fh)
    try:
        os.rename(candidate, path)
    except OSError:
        shutil.rmtree(candidate, ignore_errors=True)
    else:
        # A turn's processes can outlive a lease that was released (or never
        # recorded them): the lease is ours, the session still is not.
        if turn_processes_alive(session_dir, probe):
            release_lease(path)
            return None
        return path
    try:
        with open(os.path.join(path, "owner.json")) as fh:
            owner = json.load(fh)
    except (OSError, ValueError):
        owner = {}
    if (_lease_owner_alive(owner, probe) or _lease_supervisor_alive(path, probe)
            or turn_processes_alive(session_dir, probe)):
        return None
    # Stale: the holder and its turn are provably gone. Reclaim via rename so two
    # reclaimers cannot both win — only the one whose rename succeeds proceeds.
    stale = f"{path}.stale-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    try:
        os.rename(path, stale)
    except OSError:
        return None  # somebody else reclaimed first
    shutil.rmtree(stale, ignore_errors=True)
    return acquire_lease(session_dir, probe)


def release_lease(lease_path: str) -> None:
    shutil.rmtree(lease_path, ignore_errors=True)


# -- wake decisions, derived from disk only -----------------------------------------

def wake_reason(session_dir: str, now: Callable[[], float] = time.time) -> Optional[str]:
    """
    Why this session should wake NOW, or None.

    A user message in the session's inbox wakes it whether or not it is waiting —
    someone spoke to it. So does a turn that did not finish (turn.json): a crashed
    one is re-woken, and one still in flight is a reason to try the lease, which
    the live turn's processes refuse. Otherwise a missing/unreadable wake.json is
    "not waiting", never a wake, and a present one is judged by `reason_for`.
    A session that is ending or has ended (end.json) is never woken this way.
    """
    return wake_decision(session_dir, now)[0]


def wake_decision(session_dir: str, now: Callable[[], float] = time.time) -> tuple:
    """(reason, owed invocation ids the woken turn delivers) — `wake_reason` with its payload."""
    if os.path.exists(os.path.join(session_dir, END_FILE)):
        return None, []
    wake = _read_wake(session_dir)
    job_dir = _job_dir(session_dir, wake)
    turn = _turn_reason(session_dir)
    users = pending_user_messages(session_dir)
    if users or turn:
        reason = f"{_user_reason(users)}; {turn}" if users and turn else (_user_reason(users) if users else turn)
        owed = owed_items(job_dir)
        lines = [INV.describe(r) for r in owed]
        if lines:
            reason = f"{reason}; also: {'; '.join(lines)}"
        return reason, [r["id"] for r in owed]
    _, reason, ids = decide_owed(wake, job_dir, now)
    return reason, ids


def reason_for(
    wake: dict,
    job_dir: Optional[str] = None,
    now: Callable[[], float] = time.time,
    agents: Optional[dict] = None,
) -> Optional[str]:
    """
    Why a wait request (wake.json, or the `request` on an RPC `agent_end`) is due NOW.

    The wake sources, first match wins:
      - a named subagent wrote to its parent since the wait (either mode);
      - a named expect="stream" job printed new output since the wait was armed;
      - the watched jobs finished — all of them for mode "all", the first otherwise.
        A condition job (`until <cond>; do sleep N; done`) finishing IS its
        condition firing, and says whether it succeeded, failed or timed out;
      - the wake_after deadline, the backstop for all of them.
    A wait with no names watches every job live when it waited, as it always did.

    `agents` is for a host that owns the subagents itself (the gateway's broker):
    `{name: {"state", "reason", "unread": [{"kind", "text"}]}}`. The host supplies the
    facts only it has; the ordering and the words stay here, so every host wakes the
    same way.
    """
    return decide(wake, job_dir, now, agents)[1]


def decide(
    wake: dict,
    job_dir: Optional[str] = None,
    now: Callable[[], float] = time.time,
    agents: Optional[dict] = None,
) -> tuple:
    """`reason_for`, with which source fired: (source, reason), both None while nothing is due.

    Sources: "message" (a named agent wrote), "stream" (a stream job printed),
    "finished" (the watched jobs or agents finished), "owed" (an item the wait did not
    name finished undelivered), "deadline".
    """
    # A caller of this API does not mark what it reports delivered, so an owed item
    # counts only if it ended after the wait was armed: it wakes such a host once.
    source, reason, _ = decide_owed(wake, job_dir, now, agents, since=(wake or {}).get("armed_at"))
    return source, reason


def owed_items(job_dir: Optional[str]) -> List[dict]:
    """Every terminal, undelivered invocation of this job dir, reconciled from disk first."""
    if INV is None or not job_dir or not os.path.isdir(job_dir):
        return []
    store = INV.InvocationStore(job_dir)
    try:
        # Judge every job from the OS first: a job is owed the moment it ends, not
        # the moment something happens to read its record.
        jobs = J.JobStore(job_dir, emit=lambda m: None)
        for rec in jobs._all():
            jobs._refresh(rec)
        store.refresh()
        return store.owed()
    except Exception:  # noqa: BLE001 - bookkeeping must never stop a wake
        return []


def _owed_lines(owed: List[dict], skip_names: Sequence[str] = ()) -> List[str]:
    return [INV.describe(r) for r in owed
            if not (r.get("kind") in ("job", "subagent") and r.get("name") in skip_names)]


def decide_owed(
    wake: Optional[dict],
    job_dir: Optional[str] = None,
    now: Callable[[], float] = time.time,
    agents: Optional[dict] = None,
    since: Optional[float] = None,
) -> tuple:
    """
    (source, reason, ids) — `decide` plus the owed-items rule (docs/TOOL-INVOCATIONS.md).

    `since` limits the owed items to those that ended after it, for a host that
    cannot mark delivery (it would otherwise be woken by the same item every wait).

    The wait's named targets block as a set, exactly as before. Any other owed item —
    a job nobody waited on, a call whose kernel died — wakes by itself. Whatever fires,
    every owed outcome rides on the wake and `ids` names them, so the caller can mark
    them delivered (in two phases, under the scheduler).
    """
    wake = wake or {}
    root = job_dir or wake.get("job_dir")
    owed = owed_items(root)
    if since is not None:
        owed = [r for r in owed if float(r.get("finished_at") or 0) >= float(since)]
    source, reason = _decide_wait(wake, root, now, agents) if wake else (None, None)
    watch = wake.get("watch") or []
    blocking = set(wake.get("blocking") or []) | {r["id"] for r in owed if r.get("blocking")}
    if source is None:
        loose = [r for r in owed if r["id"] not in blocking
                 and not (r.get("kind") in ("job", "subagent") and r.get("name") in watch)]
        if loose:
            source, reason = "owed", "; ".join(INV.describe(r) for r in loose)
            return source, reason + _also(owed, loose, watch), [r["id"] for r in owed]
        if wake:
            source, reason = _deadline(wake, now)
        if source is None:
            return None, None, []
    extra = _owed_lines(owed, watch)
    if extra:
        reason = f"{reason}; also: {'; '.join(extra)}"
    return source, reason, [r["id"] for r in owed]


def _also(owed: List[dict], said: List[dict], watch: Sequence[str]) -> str:
    rest = [r for r in owed if r not in said]
    lines = _owed_lines(rest, watch) + [INV.describe(r) for r in rest
                                        if r.get("kind") in ("job", "subagent") and r.get("name") in watch]
    return f"; also: {'; '.join(lines)}" if lines else ""


def _deadline(wake: dict, now: Callable[[], float]) -> tuple:
    wake_at = wake.get("wake_at")
    if wake_at is not None and now() >= wake_at:
        return "deadline", f"the requested wait of {wake.get('wake_after', '?')}s elapsed"
    return None, None


def _decide_wait(
    wake: dict,
    job_dir: Optional[str] = None,
    now: Callable[[], float] = time.time,
    agents: Optional[dict] = None,
) -> tuple:
    """The wait's own sources, deadline excluded (the owed rule outranks a bare deadline)."""
    agents = agents or {}
    root = job_dir or wake.get("job_dir")
    # A host evaluating only its own facts (a remote kernel's jobs live elsewhere) passes
    # a job dir that is not here; constructing a store would create it.
    store = J.JobStore(root, emit=lambda m: None) if root and os.path.isdir(root) else None
    watch = wake.get("watch") or []
    mode = wake.get("mode")
    finished = {}
    for name in watch:
        if name in agents:
            fact = agents[name] or {}
            if fact.get("state") not in (None, "running"):
                finished[name] = describe_agent_finish(fact)
            continue
        rec = store._refresh(store._read(name)) if store else None
        if rec and rec.get("state") not in J.LIVE_STATES:
            finished[name] = describe_finish(rec)
    spoke = _messages_since(wake.get("mailboxes") or {}, wake.get("armed_at"))
    spoke.update(_agent_messages({n: agents[n] for n in watch if n in agents}))
    if spoke:
        return "message", "; ".join(f"agent {n!r} sent you a message: {t}" for n, t in spoke.items())
    streamed = _new_output(wake.get("streams") or {})
    if mode == "all" and len(watch) > 1:
        if all(n in finished or n in streamed for n in watch):
            parts = [f"{n} ({finished[n]})" if n in finished else f"{n} (new output)" for n in watch]
            return "finished", "all finished: " + ", ".join(parts) + _stream_tail(streamed)
    elif streamed:
        name, text = next(iter(streamed.items()))
        return "stream", f"job {name!r} printed new output since you waited:{_indent(text)}"
    elif finished:
        name, why = next(iter(finished.items()))
        kind = "agent" if name in agents else "job"
        return "finished", f"{kind} {name!r} finished: {why}"
    return None, None


def mark_owed_delivered(job_dir: Optional[str], ids: Sequence[str], by: str) -> None:
    """One-phase delivery, for hosts with no turn record to roll back (RPC, print self-wake)."""
    if INV is not None and job_dir and ids and os.path.isdir(job_dir):
        INV.InvocationStore(job_dir).mark_delivered(ids, by=by)


def describe_agent_finish(fact: dict) -> str:
    """How a host-owned subagent ended: its state, and the host's reason when it has one."""
    state, reason = str(fact.get("state") or "done"), str(fact.get("reason") or "")
    word = {"done": "completed"}.get(state, state)
    return f"{word} — {reason}".strip(" —")


def _agent_messages(agents: dict) -> dict:
    """name -> the newest unread message each host-owned agent sent, as _messages_since words it."""
    out = {}
    for name, fact in agents.items():
        unread = (fact or {}).get("unread") or []
        if unread:
            last = unread[-1]
            label = "asks" if last.get("kind") == "ask" else "reports"
            text = str(last.get("text") or "").strip()
            out[name] = f"{label}: {(text.splitlines() or [''])[0][:200]}"
    return out


def describe_finish(rec: dict) -> str:
    """How a job ended, in words the agent's next action depends on."""
    state, reason = rec.get("state"), rec.get("reason") or ""
    if state == "done":
        code = rec.get("exit_code")
        return "succeeded (exit 0)" if code == 0 else f"failed (exit {code})"
    if state == "deadline":
        return f"timed out — {reason}".strip(" —")
    return f"{state} — {reason}".strip(" —")


# How much of a stream's new output a wake message carries; the rest is in the log.
STREAM_WAKE_LINES = 20
STREAM_WAKE_BYTES = 4096


def _new_output(streams: dict) -> dict:
    """name -> the output each watched stream job wrote after its arming offset."""
    out = {}
    for name, spec in streams.items():
        try:
            with open(spec.get("log") or "", "rb") as fh:
                fh.seek(int(spec.get("offset") or 0))
                data = fh.read(STREAM_WAKE_BYTES)
        except (OSError, ValueError):
            continue
        text = data.decode("utf-8", errors="replace")
        if text.strip():
            out[name] = "\n".join(text.rstrip("\n").splitlines()[-STREAM_WAKE_LINES:])
    return out


def _indent(text: str) -> str:
    return "".join(f"\n    {line}" for line in text.splitlines())


def _stream_tail(streamed: dict) -> str:
    return "".join(f"\n  {n}:{_indent(t)}" for n, t in streamed.items())


def _read_wake(session_dir: str) -> Optional[dict]:
    try:
        with open(os.path.join(session_dir, WAKE_FILE)) as fh:
            wake = json.load(fh)
    except (OSError, ValueError):
        return None
    return wake if isinstance(wake, dict) else None


def _messages_since(mailboxes: dict, armed_at: Optional[float]) -> dict:
    """
    name -> the newest message each named agent sent that the parent has not read.

    Unread, not "since the wait was armed": a report or a question sent while the
    parent was still in its turn would otherwise neither wake it nor ever be shown,
    and a child blocked in ask_parent would wait out its whole timeout.
    """
    out = {}
    for name, box in mailboxes.items():
        fresh = Mailbox(box).unread_messages()
        if fresh:
            last = fresh[-1]
            label = "asks" if last.get("kind") == "ask" else "reports"
            text = str(last.get("text") or "").strip()
            out[name] = f"{label}: {(text.splitlines() or [''])[0][:200]}"
    return out


# -- user messages: the one wake source that is not the agent's own ------------------
#
# A message for the session is a file in <session>/inbox/, written atomically. It
# wakes the session whether or not it is waiting, and it is delivered as the new
# turn's opening message, after the line saying why the turn started.

def post_user_message(session_dir: str, text: str, sender: str = "user") -> str:
    """Queue a message for the session's next turn. Returns the message file."""
    box = os.path.join(session_dir, INBOX_DIR)
    os.makedirs(box, exist_ok=True)
    name = f"{time.time():.6f}-{uuid.uuid4().hex[:8]}.json"
    tmp = os.path.join(box, f".{name}.tmp")
    with open(tmp, "w") as fh:
        json.dump({"id": f"u-{uuid.uuid4().hex[:12]}", "from": sender, "text": text, "at": time.time()}, fh)
    final = os.path.join(box, name)
    os.replace(tmp, final)
    return final


def pending_user_messages(session_dir: str) -> List[dict]:
    """Undelivered inbox messages, oldest first, each with its file path."""
    box = os.path.join(session_dir, INBOX_DIR)
    try:
        names = sorted(n for n in os.listdir(box) if n.endswith(".json") and not n.startswith("."))
    except OSError:
        return []
    out = []
    for name in names:
        try:
            with open(os.path.join(box, name)) as fh:
                msg = json.load(fh)
        except (OSError, ValueError):
            continue
        if not isinstance(msg, dict):
            continue
        msg["path"] = os.path.join(box, name)
        # Messages queued before ids existed get one from their file name, which
        # is unique and survives the .delivering -> .json round trip of a recovery.
        msg.setdefault("id", name[: -len(".json")])
        out.append(msg)
    return out


def _user_reason(messages: List[dict]) -> str:
    who = sorted({str(m.get("from") or "user") for m in messages})
    n = len(messages)
    return f"{n} new message{'s' if n != 1 else ''} from {', '.join(who)}"


def _move_message(path: str, src_suffix: str, dst_suffix: str) -> None:
    try:
        os.replace(path + src_suffix, path + dst_suffix)
    except OSError:
        pass


def wake_message(reason: str, user_messages: Sequence[dict] = (), cancelled_wait: bool = False,
                 closing: bool = False) -> str:
    """
    The opening message of a woken turn: why it started, then anything said to it.

    One format for every host that wakes a session — the scheduler, print mode's own
    wake, and RPC hosts that want to match — so a transcript reads the same
    whichever woke it. `closing` is the session's last turn (its deadline): it says so
    instead of "continue the task".
    """
    if not user_messages:
        return f"[woken: {reason}] {CLOSING_INSTRUCTION if closing else 'Check your jobs and continue the task.'}"
    lines = [f"[woken: {reason}]"]
    if closing:
        lines.append(f"[{CLOSING_INSTRUCTION}]")
    ids = [str(m["id"]) for m in user_messages if m.get("id")]
    if ids:
        # The ids are how a crash recovery tells, from the transcript, whether
        # this turn's opening message was recorded before it died.
        lines.append(f"[message ids: {', '.join(ids)}]")
    if cancelled_wait:
        lines.append("[your pending jobs.wait was cancelled by this; wait again if you still need to]")
    for msg in user_messages:
        lines.append("")
        lines.append(str(msg.get("text") or ""))
    return "\n".join(lines)


def consume_messages(session_dir: str) -> None:
    """The wake that carries a message marks it read, so waiting again does not re-fire on it."""
    try:
        with open(os.path.join(session_dir, WAKE_FILE)) as fh:
            wake = json.load(fh)
    except (OSError, ValueError):
        return
    for box in (wake.get("mailboxes") or {}).values():
        Mailbox(box).mark_read()


def _job_dir(session_dir: str, wake: Optional[dict] = None) -> str:
    """The session's job dir: session.json may name one (a kernel whose jobs
    live elsewhere, e.g. /tmp/harness/jobs on terminal-bench); failing that, the
    one the kernel recorded in its wake request; default is the session-local jobs/."""
    try:
        with open(os.path.join(session_dir, SESSION_FILE)) as fh:
            spec = json.load(fh)
        configured = (spec.get("env") or {}).get("HARNESS_JOB_DIR")
        if configured:
            return configured
    except (OSError, ValueError):
        pass
    recorded = (wake or {}).get("job_dir")
    if recorded and os.path.isdir(recorded):
        return recorded
    return os.path.join(session_dir, "jobs")


# -- the turn in flight: two-phase delivery ----------------------------------------
#
# turn.json is the run's record, and its "state" is how far the run got:
#
#   starting     written by the scheduler before it consumes anything
#   launching    the supervisor is up (its identity recorded); the harness is not yet
#   running      the harness child is up (its identity recorded)
#   exited       the harness returned; the supervisor recorded its exit code
#   interrupted  written by a recovery: the turn crashed and the session is owed
#                one re-wake saying so
#
# A run that returns to the scheduler ends as turn.json.last. Anything else left
# behind is a crash, recovered by the next scheduler to hold the lease.

IN_FLIGHT = ("starting", "launching", "running", "exited")
INTERRUPTED = (
    "the previous turn was interrupted (crash) and may have partly run"
)


def _turn_path(session_dir: str) -> str:
    return os.path.join(session_dir, TURN_FILE)


def _read_turn(session_dir: str) -> Optional[dict]:
    try:
        with open(_turn_path(session_dir)) as fh:
            turn = json.load(fh)
    except (OSError, ValueError):
        return None
    return turn if isinstance(turn, dict) else None


def _write_json(path: str, obj: dict) -> None:
    tmp = f"{path}.tmp-{os.getpid()}-{uuid.uuid4().hex[:6]}"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=1)
    os.replace(tmp, path)


def _update_turn(turn_path: str, run_id: str, **fields) -> bool:
    """
    Merge into turn.json, but only if it is still this run's record. Only the
    supervisor calls this while a run is live, so there is one writer at a time.
    """
    try:
        with open(turn_path) as fh:
            turn = json.load(fh)
    except (OSError, ValueError):
        return False
    if turn.get("run_id") != run_id:
        return False
    turn.update(fields)
    _write_json(turn_path, turn)
    return True


def _turn_reason(session_dir: str) -> Optional[str]:
    turn = _read_turn(session_dir)
    if not turn:
        return None
    if turn.get("state") == "spawn-failed":
        # The restored wake and messages are the reason; a crash this run was
        # answering is still owed its re-wake.
        turn = turn.get("recovering") or {}
        if not turn:
            return None
    if turn.get("state") == "interrupted":
        woke = turn.get("interrupted_reason")
        return f"{INTERRUPTED} (it was woken for: {woke})" if woke else INTERRUPTED
    return "a previous turn did not finish"


def _finish_turn(session_dir: str, turn: dict, **fields) -> None:
    """The run returned: its messages were delivered, and the record becomes evidence."""
    for msg in turn.get("messages") or []:
        _move_message(msg["path"], ".delivering", ".delivered")
    _delivery(session_dir, "commit", turn.get("run_id"))
    turn.update(fields, ended_at=turn.get("ended_at") or time.time())
    _write_json(_turn_path(session_dir) + ".last", turn)
    try:
        os.remove(_turn_path(session_dir))
    except OSError:
        pass


def _recover_turn(session_dir: str, log: Callable[[str], None] = print) -> Optional[str]:
    """
    Settle a turn.json left by a run that is gone. Call only under the lease, and
    only after acquire_lease proved the run's scheduler, supervisor and child dead.

    Returns what was decided, for the log; None when there was nothing to settle.
    A "launching" turn (supervisor up, child unrecorded) counts as crashed: whether
    a harness started is unknowable, and a spurious re-wake is the safe error.
    """
    turn = _read_turn(session_dir)
    if not turn or turn.get("state") not in IN_FLIGHT:
        return None
    state = turn["state"]
    if state == "exited":
        # The harness returned and said so; only the scheduler's bookkeeping died.
        _finish_turn(session_dir, turn, state="done", settled_by="recovery")
        return f"turn {turn.get('run_id')} had exited {turn.get('exit_code')}; finished its bookkeeping"
    if state == "starting":
        return _restore_unstarted(session_dir, turn)
    return _recover_crashed(session_dir, turn, log)


def _delivery(session_dir: str, phase: str, run_id: Optional[str], ids: Sequence[str] = ()) -> List[str]:
    """Two-phase delivery of owed invocations, alongside the run's messages."""
    if INV is None or not run_id:
        return []
    store = INV.InvocationStore(_job_dir(session_dir))
    if phase == "begin":
        return store.begin_delivery(ids, run_id)
    if phase == "commit":
        return store.commit_delivery(run_id)
    return store.rollback_delivery(run_id)


def _unconsume(session_dir: str, turn: dict) -> None:
    """Undo phase one: the run's messages are pending again, and so is its wake."""
    _delivery(session_dir, "rollback", turn.get("run_id"))
    for msg in turn.get("messages") or []:
        _move_message(msg["path"], ".delivering", "")
    wake = os.path.join(session_dir, WAKE_FILE)
    if turn.get("wake_fired") and not os.path.exists(wake):
        try:
            os.replace(f"{wake}.fired", wake)
        except OSError:
            pass


def _restore_unstarted(session_dir: str, turn: dict) -> str:
    """
    No supervisor ever recorded itself, so no harness was started: undo the
    consumption and let the original wake fire as if this run never happened.
    """
    _unconsume(session_dir, turn)
    turn.update(state="never-started", settled_at=time.time())
    _write_json(_turn_path(session_dir) + ".last", turn)
    os.remove(_turn_path(session_dir))
    return f"turn {turn.get('run_id')} never started a harness; its wake and messages are pending again"


def _record_spawn_failure(session_dir: str, error: BaseException, log: Callable[[str], None]) -> None:
    """
    The harness could not be started at all (a bad argv, a missing interpreter).
    Nothing ran, so the wake and messages go back — but a failure that repeats
    every pass would retry forever, so after MAX_SPAWN_FAILURES in a row the
    session is left alone with the error, as a crash loop is.
    """
    name = os.path.basename(session_dir)
    turn = _read_turn(session_dir)
    if not turn or turn.get("state") != "starting":
        log(f"[scheduler] {name}: run failed outside a turn: {error!r}")
        return
    failures = int(turn.get("spawn_failures") or 0) + 1
    turn.update(spawn_failures=failures, last_error=repr(error), failed_at=time.time())
    if failures >= MAX_SPAWN_FAILURES:
        _delivery(session_dir, "rollback", turn.get("run_id"))
        for msg in turn.get("messages") or []:
            _move_message(msg["path"], ".delivering", ".undelivered")
        turn.update(state="abandoned")
        _write_json(_turn_path(session_dir) + ".abandoned", turn)
        os.remove(_turn_path(session_dir))
        log(f"[scheduler] {name}: the harness failed to start {failures} times in a row; "
            f"NOT retrying (last error: {error!r}; evidence in {TURN_FILE}.abandoned)")
        return
    _unconsume(session_dir, turn)
    _write_json(_turn_path(session_dir), {
        "run_id": turn.get("run_id"),
        "state": "spawn-failed",
        "spawn_failures": failures,
        "last_error": repr(error),
        "recovering": turn.get("recovering"),
        "failed": turn,
    })
    log(f"[scheduler] {name}: the harness failed to start "
        f"(attempt {failures}/{MAX_SPAWN_FAILURES}): {error!r}")


def _recover_crashed(session_dir: str, turn: dict, log: Callable[[str], None]) -> str:
    messages = turn.get("messages") or []
    seen = _ids_in_transcript(session_dir, turn, [m["id"] for m in messages])
    received = [m for m in messages if m["id"] in seen]
    lost = [m for m in messages if m["id"] not in seen]
    for msg in received:
        _move_message(msg["path"], ".delivering", ".delivered")
    evidence = {
        "received": [m["id"] for m in received],
        "redelivered": [m["id"] for m in lost],
        "recovered_at": time.time(),
    }
    if os.path.exists(os.path.join(session_dir, WAKE_FILE)):
        # The turn reached jobs.wait, which ends it: whatever killed it killed an
        # exit, not work. The new wait (and any lost message) wakes it normally.
        for msg in lost:
            _move_message(msg["path"], ".delivering", "")
        _finish_turn(session_dir, turn, state="ended-in-wait", **evidence)
        return f"turn {turn.get('run_id')} died after it waited again; no re-wake needed"
    # The crashed turn may not have shown its owed outcomes: owed again, re-delivered once.
    evidence["redelivered_invocations"] = _delivery(session_dir, "rollback", turn.get("run_id"))
    recoveries = int(turn.get("recoveries") or 0) + 1
    if recoveries > MAX_CRASH_RECOVERIES:
        for msg in lost:
            _move_message(msg["path"], ".delivering", ".undelivered")
        turn.update(state="abandoned", **evidence)
        _write_json(_turn_path(session_dir) + ".abandoned", turn)
        os.remove(_turn_path(session_dir))
        log(f"[scheduler] {os.path.basename(session_dir)}: {recoveries - 1} consecutive crashed "
            f"turns; not re-waking (evidence in {TURN_FILE}.abandoned)")
        return "abandoned"
    for msg in lost:
        _move_message(msg["path"], ".delivering", "")
    _write_json(_turn_path(session_dir), {
        "run_id": turn.get("run_id"),
        "state": "interrupted",
        "recoveries": recoveries,
        "interrupted_reason": (turn.get("recovering") or {}).get("interrupted_reason") or turn.get("reason"),
        "crashed": turn,
        **evidence,
    })
    return (f"turn {turn.get('run_id')} crashed (recovery {recoveries}/{MAX_CRASH_RECOVERIES}); "
            f"{len(received)} message(s) already received, {len(lost)} re-queued")


# -- did the crashed turn receive its opening message? ------------------------------

PRIME_ENV_PREFIX = "PRIME_AGENT"
TRANSCRIPT_SLACK_SECONDS = 5.0


def _transcript_dirs(spec: dict, env: dict) -> List[str]:
    """
    Where the harness keeps its session JSONL, in prime's own precedence:
    --session-dir, then $PRIME_AGENT_SESSION_DIR (and its legacy name), then
    $PRIME_AGENT_CODING_AGENT_DIR/sessions, then ~/.prime/agent/sessions
    (vendor/prime-agent/packages/coding-agent/src/config.ts). session.json's
    "transcript_dir" overrides all of them, for a harness that is not prime.
    """
    if spec.get("transcript_dir"):
        return [os.path.expanduser(spec["transcript_dir"])]
    argv = [str(a) for a in spec.get("argv") or []]
    for i, arg in enumerate(argv[:-1]):
        if arg == "--session-dir":
            return [os.path.expanduser(argv[i + 1])]
    for key in (f"{PRIME_ENV_PREFIX}_SESSION_DIR", f"{PRIME_ENV_PREFIX}_CODING_AGENT_SESSION_DIR"):
        if env.get(key):
            return [os.path.expanduser(env[key])]
    agent_dir = env.get(f"{PRIME_ENV_PREFIX}_CODING_AGENT_DIR")
    if agent_dir:
        return [os.path.join(os.path.expanduser(agent_dir), "sessions")]
    home = env.get("HOME") or os.path.expanduser("~")
    return [os.path.join(home, ".prime", "agent", "sessions")]


def _ids_in_transcript(session_dir: str, turn: dict, ids: List[str]) -> set:
    """
    The message ids that appear in a transcript the crashed turn could have
    written: any JSONL in the harness's session dir modified since it started.
    An id is a random token that only reaches a transcript inside the turn's
    opening message, so a hit is exact. Unreadable or absent transcripts prove
    nothing, and the message is re-delivered: a duplicate beats a loss.
    """
    if not ids:
        return set()
    try:
        with open(os.path.join(session_dir, SESSION_FILE)) as fh:
            spec = json.load(fh)
    except (OSError, ValueError):
        return set()
    since = float(turn.get("started_at") or 0) - TRANSCRIPT_SLACK_SECONDS
    found = set()
    for d in _transcript_dirs(spec, _turn_env(session_dir, spec)):
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for name in names:
            path = os.path.join(d, name)
            try:
                if not name.endswith(".jsonl") or os.path.getmtime(path) < since:
                    continue
                with open(path, "rb") as fh:
                    data = fh.read()
            except OSError:
                continue
            found.update(i for i in ids if i.encode() in data)
    return found


# -- running one wake ----------------------------------------------------------------

def _turn_env(session_dir: str, spec: dict) -> dict:
    env = dict(os.environ)
    env["HARNESS_JOB_DIR"] = os.path.join(session_dir, "jobs")
    env["HARNESS_WAKE_FILE"] = os.path.join(session_dir, WAKE_FILE)
    # The spec's env WINS: it is the session's identity (its kernel's job dir,
    # its wait mode), and the defaults above are only for sessions that say
    # nothing.
    env.update(spec.get("env") or {})
    return env


def _spawn_supervised(argv: List[str], cwd: str, env: dict, session_dir: str) -> int:
    """
    The default runner: start the supervisor and record it in the lease before
    waiting. The supervisor records itself in turn.json too; whichever lands first
    closes the window in which this scheduler's death leaves the turn unrecorded.
    """
    proc = subprocess.Popen(argv, cwd=cwd, env=env)
    lease = os.path.join(session_dir, LEASE_DIR)
    if os.path.isdir(lease):
        try:
            _write_json(os.path.join(lease, "supervisor.json"),
                        {"pid": proc.pid, "pid_start": J._real_probe(proc.pid)[1]})
        except OSError:
            pass
    return proc.wait()


def run_wake(session_dir: str, reason: str, *, runner=None, closing: bool = False,
             deliver: Optional[Sequence[str]] = None) -> int:
    """
    Invoke the session's harness once, to exit — with two-phase delivery.

    Phase one, before the run: turn.json records the run, then wake.json becomes
    wake.json.fired and each pending user message <m>.json becomes .delivering.
    The fired wake can never fire again, and a waiting session a message
    interrupts has its wait cancelled (the opening message says so). The harness
    runs under `--supervise-turn`, which records its own and the child's
    identity in turn.json — that is what keeps the lease held if this
    scheduler dies mid-turn — and the child's exit code when it returns.

    Phase two, when the run returns (any exit code): messages become .delivered
    and turn.json becomes turn.json.last. If this process dies instead, turn.json
    stays, and the next scheduler to hold the lease recovers it (_recover_turn).

    `runner(argv, cwd=, env=)` replaces the real spawn (tests); it gets the
    supervised argv, whose last element is still the wake message.
    """
    with open(os.path.join(session_dir, SESSION_FILE)) as fh:
        spec = json.load(fh)
    wake_path = os.path.join(session_dir, WAKE_FILE)
    turn_path = _turn_path(session_dir)
    previous = _read_turn(session_dir) or {}
    was_waiting = os.path.exists(wake_path)
    users = pending_user_messages(session_dir)
    run_id = f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
    turn = {
        "run_id": run_id,
        "state": "starting",
        "reason": reason,
        "started_at": time.time(),
        "scheduler": _self_identity(),
        "wake_fired": was_waiting,
        "messages": [{"id": m["id"], "path": m["path"]} for m in users],
        # Owed outcomes this run's opening message carries (docs/TOOL-INVOCATIONS.md).
        "invocations": list(deliver or []),
        # Both counts are carried only by the run that answers a crash or a failed
        # spawn, so a clean run resets them.
        "recoveries": 0,
        "spawn_failures": previous.get("spawn_failures", 0) if previous.get("state") == "spawn-failed" else 0,
    }
    if previous.get("state") == "spawn-failed":
        previous = previous.get("recovering") or {}
    if previous.get("state") == "interrupted":
        turn["recoveries"] = previous.get("recoveries", 0)
        turn["recovering"] = previous  # the crash this run answers, kept as evidence
    _write_json(turn_path, turn)
    _delivery(session_dir, "begin", run_id, turn["invocations"])
    if was_waiting:
        os.replace(wake_path, f"{wake_path}.fired")
    for msg in users:
        _move_message(msg["path"], "", ".delivering")

    message = wake_message(reason, users, cancelled_wait=was_waiting and bool(users), closing=closing)
    argv = [sys.executable, os.path.abspath(__file__), "--supervise-turn", turn_path, run_id,
            "--", *spec["argv"], message]
    env = _turn_env(session_dir, spec)
    cwd = spec.get("cwd") or session_dir
    if runner is None:
        code = _spawn_supervised(argv, cwd, env, session_dir)
    else:
        code = getattr(runner(argv, cwd=cwd, env=env), "returncode", 0)
    # Reached only when the run returned to us: a scheduler that dies above leaves
    # turn.json in flight, which is the whole point.
    _finish_turn(session_dir, _read_turn(session_dir) or turn, state="done", returncode=code)
    return code


# -- the end of a session -------------------------------------------------------------
#
# A session ENDS — once, for good — in one of three ways:
#
#   deadline   session.json's "deadline" (absolute epoch seconds) passed. The agent is
#              woken ONCE more to wrap up, and the session ends when that turn returns.
#              A turn already in flight at the deadline is the last one instead: it is
#              not interrupted with a wrap-up it could not receive, only bounded.
#   explicit   the host asked: end_session() / `scheduler.py --end <session-dir>`.
#   idle       opt-in, "end_when_idle": true — a turn returned without waiting and
#              nothing is pending. Off by default on purpose: a session that is not
#              waiting is still resumable by a user message, and a benchmark grades
#              the server a finished agent deliberately left running. HOSTED-RUNTIME's
#              "terminate and reap when the final message is a terminal answer" keys
#              on a judgement the runtime cannot make from disk; a host that knows its
#              sessions are one-shot says so here.
#
# Ending writes end.json, settles anything left in flight (a fired wake, undelivered
# messages, a crashed turn — renamed, never deleted), and reaps the tree: every job and
# subagent process group the session's job dir owns, SIGTERM then SIGKILL, each pid
# vouched for by its start identity (jobs._reap). reap.json is the evidence. Every step
# is a rename or a re-checkable signal, so a finalize SIGKILLed anywhere is finished by
# the next scheduler to hold the lease. An ended session is never woken again.
#
# ABANDONMENT (MAX_CRASH_RECOVERIES crashed turns, or MAX_SPAWN_FAILURES failed spawns,
# in a row) reaps the tree the same way but does NOT end the session: no agent is left
# to care about what it started, yet a new message is a new conversation and still
# wakes it (#24's contract). The reap is owed until turn.json.abandoned says
# "reaped_at", so a scheduler killed between the abandonment and the reap still does it.
#
# Every turn is also bounded by the session's end: the turn supervisor stops its harness
# (SIGTERM, then SIGKILL) at deadline + deadline_grace_s, or an explicit end's
# requested_at + deadline_grace_s. Nothing of a session outlives its deadline by more
# than the grace, a scan interval and the kill grace.

END_FILE = "end.json"
REAP_FILE = "reap.json"
DEFAULT_DEADLINE_GRACE_SECONDS = 300.0
WRAPUP_REASON = "session deadline reached — finish up; this is the last turn"
CLOSING_INSTRUCTION = (
    "Wrap up now: say what is done and what is not. The session ends when this turn "
    "does, and any job or subagent still running is stopped."
)
SUPERVISE_POLL_SECONDS = float(os.environ.get("HARNESS_SUPERVISE_POLL_SECONDS", "0.5"))
TURN_KILL_GRACE_SECONDS = float(os.environ.get("HARNESS_TURN_KILL_GRACE_SECONDS", "10"))


def _read_json_file(path: str) -> Optional[dict]:
    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _read_spec(session_dir: str) -> dict:
    return _read_json_file(os.path.join(session_dir, SESSION_FILE)) or {}


def session_deadline(spec: dict) -> Optional[float]:
    try:
        return float(spec["deadline"]) if spec.get("deadline") is not None else None
    except (TypeError, ValueError):
        return None


def deadline_grace(spec: dict) -> float:
    try:
        return float(spec.get("deadline_grace_s", DEFAULT_DEADLINE_GRACE_SECONDS))
    except (TypeError, ValueError):
        return DEFAULT_DEADLINE_GRACE_SECONDS


def read_end(session_dir: str) -> Optional[dict]:
    return _read_json_file(os.path.join(session_dir, END_FILE))


def is_ended(session_dir: str) -> bool:
    return (read_end(session_dir) or {}).get("state") == "ended"


def request_end(session_dir: str, kind: str, reason: str, state: str = "requested") -> dict:
    """Record that the session is ending. The first decision stands: never overwritten."""
    existing = read_end(session_dir)
    if existing:
        return existing
    end = {"kind": kind, "reason": reason, "state": state, "requested_at": time.time()}
    _write_json(os.path.join(session_dir, END_FILE), end)
    return end


def end_session(session_dir: str, reason: str = "ended by its host") -> dict:
    """Ask for the session to end. The scheduler finalizes it as soon as no turn is live,
    and a live turn is stopped by its supervisor deadline_grace_s after this."""
    return request_end(session_dir, "explicit", reason)


def _last_turn_spans(session_dir: str, deadline: float) -> bool:
    """Was a turn in flight at the deadline — started before it, and ended (or died) after?"""
    turn = _read_turn(session_dir)
    if turn and turn.get("state") != "spawn-failed":
        # Still recorded: in flight, or crashed and owed a re-wake. A crash is dated by
        # the recovery that found it; a turn still in flight has not ended at all.
        started = float((turn.get("crashed") or turn).get("started_at") or 0)
        ended = turn.get("recovered_at") if turn.get("state") == "interrupted" else None
        if started and started < deadline and (ended is None or float(ended) >= deadline):
            return True
    last = _read_json_file(_turn_path(session_dir) + ".last")
    if last and last.get("state") != "never-started":
        return float(last.get("started_at") or 0) < deadline <= float(last.get("ended_at") or 0)
    return False


def _is_idle(session_dir: str) -> bool:
    return (not os.path.exists(os.path.join(session_dir, WAKE_FILE))
            and not os.path.exists(_turn_path(session_dir))
            and not pending_user_messages(session_dir)
            and not owed_items(_job_dir(session_dir))
            and os.path.exists(_turn_path(session_dir) + ".last"))


def end_due(session_dir: str, now: Callable[[], float] = time.time) -> Optional[tuple]:
    """
    ("end", kind, reason) when the session must be finalized now, ("wrapup", "deadline",
    reason) when it is owed its one wrap-up turn first, or None. Derived from disk only.
    A live turn is not judged here: the lease keeps the scheduler away from it, and its
    supervisor bounds it.
    """
    end = read_end(session_dir)
    if end:
        if end.get("state") == "ended":
            return None
        return ("end", end.get("kind"), end.get("reason"))
    spec = _read_spec(session_dir)
    deadline = session_deadline(spec)
    if deadline is not None and now() >= deadline:
        if _last_turn_spans(session_dir, deadline):
            return ("end", "deadline", "the deadline passed during a turn; that turn was the last")
        if now() >= deadline + deadline_grace(spec):
            return ("end", "deadline", "the deadline and its grace passed before a wrap-up turn could run")
        return ("wrapup", "deadline", WRAPUP_REASON)
    if spec.get("end_when_idle") and _is_idle(session_dir):
        return ("end", "idle", "the agent ended its turn without waiting for anything")
    return None


def turn_hard_stop(session_dir: str) -> Optional[tuple]:
    """(epoch, why) at which a turn of this session must be stopped, or None."""
    spec = _read_spec(session_dir)
    grace = deadline_grace(spec)
    stops = []
    deadline = session_deadline(spec)
    if deadline is not None:
        stops.append((deadline + grace, f"the session deadline passed and its {int(grace)}s grace ran out"))
    end = read_end(session_dir)
    if end and end.get("kind") != "deadline" and end.get("state") != "ended":
        stops.append((float(end.get("requested_at") or 0) + grace,
                      f"the session was ended ({end.get('reason')}) and its {int(grace)}s grace ran out"))
    return min(stops) if stops else None


def _settle_for_end(session_dir: str) -> List[str]:
    """
    Nothing pending may survive the end: a crashed turn's record, a wake, messages
    nobody will read. Each is RENAMED to say so — evidence, never deleted.
    """
    notes = []
    turn = _read_turn(session_dir)
    if turn:
        _delivery(session_dir, "rollback", turn.get("run_id"))
        turn.update(ended_session=True, settled_at=time.time())
        _write_json(_turn_path(session_dir) + ".ended", turn)
        os.remove(_turn_path(session_dir))
        notes.append(f"turn {turn.get('run_id')} ({turn.get('state')}) will not be re-run")
    wake = os.path.join(session_dir, WAKE_FILE)
    if os.path.exists(wake):
        os.replace(wake, f"{wake}.ended")
        notes.append("its pending wait was dropped")
    box = os.path.join(session_dir, INBOX_DIR)
    try:
        names = sorted(os.listdir(box))
    except OSError:
        names = []
    for name in names:
        for suffix in (".json", ".json.delivering"):
            if name.endswith(suffix) and not name.startswith("."):
                _move_message(os.path.join(box, name[: -len(suffix)] + ".json"),
                              suffix[len(".json"):], ".undelivered")
                notes.append(f"message {name} was not delivered")
    return notes


def finalize_session(session_dir: str, kind: str, reason: str, *, probe=None,
                     log: Callable[[str], None] = print) -> dict:
    """
    End the session: settle what is pending, reap its process tree, record it all.
    Call only under the lease. Idempotent — an ended session is returned as is, and
    one whose finalize was interrupted is finished from where the disk says it got.
    """
    end = read_end(session_dir) or {}
    if end.get("state") == "ended":
        return end
    end.setdefault("kind", kind)
    end.setdefault("reason", reason)
    end.setdefault("requested_at", time.time())
    end.update(state="reaping", finalize_attempts=int(end.get("finalize_attempts") or 0) + 1)
    end_path = os.path.join(session_dir, END_FILE)
    _write_json(end_path, end)
    _recover_turn(session_dir, log)
    settled = _settle_for_end(session_dir)
    spec = _read_spec(session_dir)
    run = J._reap(_job_dir(session_dir), reason=f"the session ended ({end['kind']}: {end['reason']})",
                 evidence_path=os.path.join(session_dir, REAP_FILE), probe=probe,
                 grace=spec.get("reap_grace_s"))
    end.update(state="ended", ended_at=time.time(), settled=end.get("settled", []) + settled,
               reaped=run["summary"], closed_jobs=run["closed"])
    _write_json(end_path, end)
    log(f"[scheduler] {os.path.basename(session_dir)}: ended ({end['kind']}: {end['reason']}); "
        f"reaped {run['summary'] or 'nothing'}")
    return end


def _owed_abandonment_reap(session_dir: str) -> Optional[dict]:
    abandoned = _read_json_file(_turn_path(session_dir) + ".abandoned")
    if abandoned and not abandoned.get("reaped_at"):
        return abandoned
    return None


def _reap_if_abandoned(session_dir: str, *, probe=None, log: Callable[[str], None] = print) -> None:
    """Under the lease: an abandoned session's tree is reaped once; the session stays open."""
    abandoned = _owed_abandonment_reap(session_dir)
    if not abandoned:
        return
    why = ("its harness kept failing to start"
           if int(abandoned.get("spawn_failures") or 0) >= MAX_SPAWN_FAILURES
           else "its turns kept crashing")
    run = J._reap(_job_dir(session_dir), reason=f"the session was abandoned ({why})",
                  evidence_path=os.path.join(session_dir, REAP_FILE), probe=probe,
                  grace=_read_spec(session_dir).get("reap_grace_s"))
    abandoned.update(reaped_at=time.time(), reaped=run["summary"])
    _write_json(_turn_path(session_dir) + ".abandoned", abandoned)
    log(f"[scheduler] {os.path.basename(session_dir)}: abandoned; reaped {run['summary'] or 'nothing'}")


def enforce_job_limits(session_dir: str, probe=None) -> None:
    """
    Refresh every job record the session owns, its subagents' included. A record is
    only judged when something reads it, so a job nobody waits on or lists ran past its
    max_runtime for as long as nobody looked; the scheduler looks every scan.
    """
    job_dir = _job_dir(session_dir)
    if os.path.isdir(job_dir):
        J._refresh_tree(job_dir, probe=probe)


def scan_once(sessions_root: str, *, now=time.time, runner=None,
              probe=None, log: Callable[[str], None] = print) -> List[str]:
    """One pass over every session; returns the names of sessions woken."""
    woken = []
    try:
        entries = sorted(os.listdir(sessions_root))
    except OSError:
        return woken
    for name in entries:
        session_dir = os.path.join(sessions_root, name)
        if not os.path.isfile(os.path.join(session_dir, SESSION_FILE)) or is_ended(session_dir):
            continue
        enforce_job_limits(session_dir, probe)
        if (not end_due(session_dir, now) and not wake_reason(session_dir, now)
                and not _owed_abandonment_reap(session_dir)):
            continue
        lease = acquire_lease(session_dir, probe)
        if lease is None:
            orphan = turn_processes_alive(session_dir, probe)
            if orphan:
                log(f"[scheduler] {name}: turn {orphan['run_id']} still running "
                    f"({orphan['role']} pid {orphan['pid']}); not starting another")
            continue  # a live harness already owns this session
        try:
            settled = _recover_turn(session_dir, log)
            if settled:
                log(f"[scheduler] {name}: {settled}")
            _reap_if_abandoned(session_dir, probe=probe, log=log)
            if _serve_session(session_dir, now=now, runner=runner, log=log):
                woken.append(name)
            _reap_if_abandoned(session_dir, probe=probe, log=log)
            due = end_due(session_dir, now)
            if due and due[0] == "end":
                finalize_session(session_dir, due[1], due[2], probe=probe, log=log)
        finally:
            release_lease(lease)
    return woken


def _serve_session(session_dir: str, *, now, runner, log: Callable[[str], None]) -> bool:
    """
    Under the lease: run the one turn this session is owed, if any — its wrap-up turn
    when the deadline has passed, else the ordinary wake. True when a harness ran.
    Re-derived here: the world may have moved since the unlocked check, and a
    consumed wake must not re-fire.
    """
    name = os.path.basename(session_dir)
    due = end_due(session_dir, now)
    if due and due[0] == "end":
        return False
    closing = bool(due)
    if closing:
        # Recorded before the run, so the wrap-up is owed once: a scheduler that dies
        # during it leaves a session that is finalized, not woken again.
        request_end(session_dir, due[1], due[2], state="wrapping-up")
        reason = due[2]
        owed = owed_items(_job_dir(session_dir))
        if owed:
            reason = f"{reason}; also: {'; '.join(INV.describe(r) for r in owed)}"
        deliver = [r["id"] for r in owed]
    else:
        reason, deliver = wake_decision(session_dir, now)
        if not reason:
            return False
    log(f"[scheduler] waking {name}: {reason}")
    consume_messages(session_dir)
    try:
        code = run_wake(session_dir, reason, runner=runner, closing=closing, deliver=deliver)
    except Exception as error:  # noqa: BLE001 - any spawn failure is bounded the same way
        _record_spawn_failure(session_dir, error, log)
        return False
    log(f"[scheduler] {name} exited {code}")
    return True


def _has_pending(session_dir: str, now: Callable[[], float] = time.time) -> bool:
    """Is there anything left for a scheduler to do here — a wait, a turn, a message, an end?"""
    if is_ended(session_dir):
        return False
    return bool(
        os.path.exists(os.path.join(session_dir, WAKE_FILE))
        or os.path.exists(os.path.join(session_dir, TURN_FILE))
        or os.path.exists(os.path.join(session_dir, END_FILE))
        or pending_user_messages(session_dir)
        or end_due(session_dir, now)
        or owed_items(_job_dir(session_dir))
    )


def drain(sessions_root: str, *, interval: float = 5.0, deadline: Optional[float] = None,
          now=time.time, runner=None, log: Callable[[str], None] = print) -> bool:
    """
    Serve until NO session has a pending wake, then return True — the mode a
    finite run (one terminal-bench task) wants. Returns False on deadline.
    A session whose harness writes a new wake.json keeps the drain alive, and so
    does a turn.json: a crashed turn owed a re-wake, or an orphaned one (its
    scheduler died) still running. So does an end in progress; an ended session
    is done whatever its inbox holds.
    """
    started = now()
    while True:
        scan_once(sessions_root, now=now, runner=runner, log=log)
        pending = [
            n for n in (os.listdir(sessions_root) if os.path.isdir(sessions_root) else [])
            if _has_pending(os.path.join(sessions_root, n), now)
        ]
        if not pending:
            log("[scheduler] nothing left waiting; drained")
            return True
        if deadline is not None and now() - started > deadline:
            log(f"[scheduler] deadline after {int(now() - started)}s with {pending} still waiting")
            return False
        time.sleep(interval)


def serve(sessions_root: str, *, interval: float = 5.0, now=time.time,
          runner=None, log: Callable[[str], None] = print) -> None:
    """The loop. Ctrl-C to stop; state is on disk, so stopping is always safe."""
    log(f"[scheduler] watching {sessions_root} every {interval}s")
    while True:
        scan_once(sessions_root, now=now, runner=runner, log=log)
        time.sleep(interval)


def _reason_for_request_cli(consume: bool) -> None:
    """
    `scheduler.py --reason-for-request [--consume]`: a wait request (JSON) on stdin,
    `{"reason", "message", "source"}` on stdout — reason null while nothing is due.

    For hosts that are not this scheduler but share the kernel's filesystem: print
    mode's own wake, and RPC hosts, which receive the request on `agent_end`.
    stdin is the request itself, or `{"request": ..., "agents": {...}}` from a host
    that owns its subagents (see reason_for).
    --consume marks a waking message read, as the scheduler's wake does.
    """
    import sys

    payload = json.load(sys.stdin)
    envelope = isinstance(payload.get("request"), dict)
    wake = payload["request"] if envelope else payload
    agents = payload.get("agents") if envelope else None
    source, reason, owed = decide_owed(wake, wake.get("job_dir"), agents=agents,
                                       since=None if consume else wake.get("armed_at"))
    if reason and consume:
        for box in (wake.get("mailboxes") or {}).values():
            Mailbox(box).mark_read()
        mark_owed_delivered(wake.get("job_dir"), owed, by="wake (--consume)")
    print(json.dumps({"reason": reason, "message": wake_message(reason) if reason else None, "source": source}))


def _user_wake_cli() -> None:
    """
    `scheduler.py --user-wake`: `{"messages": [{"from", "text"}], "cancelled_wait": bool}`
    on stdin, `{"reason", "message"}` on stdout — the opening of a turn a user message
    started, in the words the scheduler's own inbox wake uses.
    """
    import sys

    payload = json.load(sys.stdin)
    messages = [m for m in payload.get("messages") or [] if isinstance(m, dict)]
    reason = _user_reason(messages)
    print(json.dumps({"reason": reason, "message": wake_message(reason, messages, bool(payload.get("cancelled_wait")))}))


def _supervise_turn(turn_path: str, run_id: str, argv: List[str]) -> int:
    """
    `scheduler.py --supervise-turn <turn.json> <run_id> -- <harness argv...>`.

    Runs the harness as its child and writes into turn.json what only a process
    beside the harness can know: that it started (with an identity a pid-reusing
    stranger cannot fake) and how it exited. A scheduler killed mid-turn does not
    take this process with it, so the turn is still recorded as live, and still
    finishes with an exit code, after its scheduler is gone.

    Stays in the scheduler's process group: killing the group (Ctrl-C, a
    supervisor's killpg) stops the turn with it, which recovery then handles.

    It also bounds the turn by the session's end (turn_hard_stop): past the deadline's
    grace, or an explicit end's, the harness is stopped — SIGTERM, then SIGKILL after
    TURN_KILL_GRACE_SECONDS — and turn.json says why. That holds for an orphaned turn
    too, whose scheduler is not there to do it.
    """
    if not _update_turn(turn_path, run_id, state="launching", supervisor=_self_identity()):
        # The run was settled without us — our scheduler died before we got here
        # and a recovery restored its wake. Starting the harness now would be a
        # second agent on the session.
        return EXIT_TURN_SUPERSEDED
    child = subprocess.Popen(argv)

    def forward(signum, _frame):
        try:
            child.send_signal(signum)
        except OSError:
            pass

    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, forward)
    signal.signal(signal.SIGINT, signal.SIG_IGN)  # the child gets the terminal's own
    _update_turn(turn_path, run_id, state="running",
                 child={"pid": child.pid, "pid_start": J._real_probe(child.pid)[1]})
    code = _wait_bounded(child, turn_path, run_id)
    _update_turn(turn_path, run_id, state="exited", exit_code=code, ended_at=time.time())
    return code if code >= 0 else 128 - code


def _wait_bounded(child: "subprocess.Popen", turn_path: str, run_id: str) -> int:
    """The child's exit code — or, past the session's hard stop, the code it was stopped with."""
    session_dir = os.path.dirname(os.path.abspath(turn_path))
    while True:
        try:
            return child.wait(timeout=SUPERVISE_POLL_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        stop = turn_hard_stop(session_dir)
        if stop and time.time() >= stop[0]:
            _update_turn(turn_path, run_id, stopped={"reason": stop[1], "at": time.time()})
            child.terminate()
            try:
                return child.wait(timeout=TURN_KILL_GRACE_SECONDS)
            except subprocess.TimeoutExpired:
                child.kill()
                return child.wait()


def _end_cli(session_dir: str, reason: str) -> None:
    """
    `scheduler.py --end <session-dir> [reason...]`: ask for the session to end, and end
    it now if no turn holds it (else its supervisor stops the turn after the grace and
    the next scan finishes the job). Prints end.json.
    """
    end_session(session_dir, reason)
    lease = acquire_lease(session_dir)
    if lease is not None:
        try:
            end = read_end(session_dir) or {}
            finalize_session(session_dir, end.get("kind") or "explicit", end.get("reason") or reason)
        finally:
            release_lease(lease)
    print(json.dumps(read_end(session_dir)))


if __name__ == "__main__":
    import argparse
    import sys as _sys

    if len(_sys.argv) > 4 and _sys.argv[1] == "--supervise-turn" and _sys.argv[4] == "--":
        raise SystemExit(_supervise_turn(_sys.argv[2], _sys.argv[3], _sys.argv[5:]))
    if "--reason-for-request" in _sys.argv:
        _reason_for_request_cli("--consume" in _sys.argv)
        raise SystemExit(0)
    if "--user-wake" in _sys.argv:
        _user_wake_cli()
        raise SystemExit(0)
    if len(_sys.argv) > 2 and _sys.argv[1] == "--end":
        _end_cli(_sys.argv[2], " ".join(_sys.argv[3:]) or "ended by its host")
        raise SystemExit(0)

    ap = argparse.ArgumentParser(description="wake scheduler over a sessions root")
    ap.add_argument("sessions_root")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--once", action="store_true", help="one scan, then exit (cron mode)")
    ap.add_argument("--drain", action="store_true",
                    help="serve until no session is waiting, then exit (finite-run mode)")
    ap.add_argument("--deadline", type=float, default=None,
                    help="with --drain: give up after this many seconds")
    args = ap.parse_args()
    if args.once:
        scan_once(args.sessions_root)
    elif args.drain:
        raise SystemExit(0 if drain(args.sessions_root, interval=args.interval,
                                    deadline=args.deadline) else 1)
    else:
        serve(args.sessions_root, interval=args.interval)
