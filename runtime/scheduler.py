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
                     — written once by whoever creates the session
      wake.json      the pending wake, written by the RUNTIME (jobs.wait) when a
                     turn ends waiting: {"wake_at": <epoch>, "watch": [names]}
                     — absence means the session is not waiting on anything
      jobs/          the session's HARNESS_JOB_DIR
      lease/         single-writer lock while a harness is running

The loop: a session wakes when its deadline passes OR any watched job stops
being live — whichever comes first, exactly the `wake_after` contract. The
scheduler acquires the lease, appends the wake reason to the harness argv,
runs the harness to exit, and releases. The harness's runtime writes a new
wake.json if the agent waits again; a session with no wake.json after a run is
finished business.

Crash-safety is inherited, not implemented: every decision above is derived
from disk, so a scheduler that is SIGKILLed and restarted resumes correctly by
construction — the same invariant runtime/test_chaos.py pins for jobs. The
lease carries pid + process start identity (prime session-lease's defence) so
a stale lease from a dead scheduler is reclaimed and a live one never is.
"""

import json
import os
import shutil
import subprocess
import time
import uuid
from typing import Callable, List, Optional, Sequence

import jobs as J
from agent_mailbox import Mailbox

WAKE_FILE = "wake.json"
SESSION_FILE = "session.json"
LEASE_DIR = "lease"
INBOX_DIR = "inbox"


# -- lease: single-writer, stale-reclaimable, identity-checked ---------------------

def _self_identity() -> dict:
    pid = os.getpid()
    return {"pid": pid, "pid_start": J._real_probe(pid)[1]}


def _lease_owner_alive(owner: dict, probe=None) -> bool:
    probe = probe or J._real_probe
    pid = owner.get("pid")
    if not pid:
        return False
    status, start = probe(pid)
    if status == "dead":
        return False
    recorded = owner.get("pid_start")
    # No identity recorded (or unprobeable): assume alive — never steal a lease
    # on missing evidence; a wrongly-stolen lease is two harnesses on one session.
    return not (recorded and start and start != recorded)


def acquire_lease(session_dir: str, probe=None) -> Optional[str]:
    """The lease directory, or None if another live harness holds it."""
    path = os.path.join(session_dir, LEASE_DIR)
    candidate = f"{path}.candidate-{os.getpid()}-{uuid.uuid4().hex[:8]}"
    os.makedirs(candidate)
    with open(os.path.join(candidate, "owner.json"), "w") as fh:
        json.dump(_self_identity(), fh)
    try:
        os.rename(candidate, path)
        return path
    except OSError:
        shutil.rmtree(candidate, ignore_errors=True)
    try:
        with open(os.path.join(path, "owner.json")) as fh:
            owner = json.load(fh)
    except (OSError, ValueError):
        owner = {}
    if _lease_owner_alive(owner, probe):
        return None
    # Stale: the holder is provably gone. Reclaim via rename so two reclaimers
    # cannot both win — only the one whose rename succeeds proceeds.
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
    someone spoke to it. Otherwise a missing/unreadable wake.json is "not waiting",
    never a wake, and a present one is judged by `reason_for`.
    """
    users = pending_user_messages(session_dir)
    if users:
        return _user_reason(users)
    wake = _read_wake(session_dir)
    if wake is None:
        return None
    return reason_for(wake, _job_dir(session_dir, wake), now)


def reason_for(wake: dict, job_dir: Optional[str] = None, now: Callable[[], float] = time.time) -> Optional[str]:
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
    """
    store = J.JobStore(job_dir or wake.get("job_dir"), emit=lambda m: None)
    watch = wake.get("watch") or []
    mode = wake.get("mode")
    finished = {}
    for name in watch:
        rec = store._refresh(store._read(name))
        if rec and rec.get("state") not in J.LIVE_STATES:
            finished[name] = describe_finish(rec)
    spoke = _messages_since(wake.get("mailboxes") or {}, wake.get("armed_at"))
    if spoke:
        return "; ".join(f"agent {n!r} sent you a message: {t}" for n, t in spoke.items())
    streamed = _new_output(wake.get("streams") or {})
    if mode == "all" and len(watch) > 1:
        if all(n in finished or n in streamed for n in watch):
            parts = [f"{n} ({finished[n]})" if n in finished else f"{n} (new output)" for n in watch]
            return "all finished: " + ", ".join(parts) + _stream_tail(streamed)
    elif streamed:
        name, text = next(iter(streamed.items()))
        return f"job {name!r} printed new output since you waited:{_indent(text)}"
    elif finished:
        name, why = next(iter(finished.items()))
        return f"job {name!r} finished: {why}"
    wake_at = wake.get("wake_at")
    if wake_at is not None and now() >= wake_at:
        return f"the requested wait of {wake.get('wake_after', '?')}s elapsed"
    return None


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
        json.dump({"from": sender, "text": text, "at": time.time()}, fh)
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
        msg["path"] = os.path.join(box, name)
        out.append(msg)
    return out


def _user_reason(messages: List[dict]) -> str:
    who = sorted({str(m.get("from") or "user") for m in messages})
    n = len(messages)
    return f"{n} new message{'s' if n != 1 else ''} from {', '.join(who)}"


def _consume_user_messages(messages: List[dict]) -> None:
    """Delivered messages are renamed, not deleted: a crash mid-run leaves evidence."""
    for msg in messages:
        path = msg.get("path")
        if path:
            try:
                os.replace(path, f"{path}.delivered")
            except OSError:
                pass


def wake_message(reason: str, user_messages: Sequence[dict] = (), cancelled_wait: bool = False) -> str:
    """
    The opening message of a woken turn: why it started, then anything said to it.

    One format for every host that wakes a session — the scheduler, print mode's own
    wake, and RPC hosts that want to match — so a transcript reads the same
    whichever woke it.
    """
    if not user_messages:
        return f"[woken: {reason}] Check your jobs and continue the task."
    lines = [f"[woken: {reason}]"]
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


# -- running one wake ----------------------------------------------------------------

def run_wake(session_dir: str, reason: str, *, runner=subprocess.run) -> int:
    """
    Invoke the session's harness once, to exit.

    The wake.json is consumed BEFORE the run: the runtime writes a fresh one if
    the agent waits again, and a stale request must not double-fire. It is
    renamed (not deleted) so a crash mid-run leaves evidence of what fired. User
    messages are consumed the same way and delivered in the turn's opening message;
    a wait they interrupt is cancelled, and the message says so.
    """
    with open(os.path.join(session_dir, SESSION_FILE)) as fh:
        spec = json.load(fh)
    wake_path = os.path.join(session_dir, WAKE_FILE)
    was_waiting = os.path.exists(wake_path)
    if was_waiting:
        os.replace(wake_path, f"{wake_path}.fired")
    users = pending_user_messages(session_dir)
    _consume_user_messages(users)

    argv = list(spec["argv"]) + [wake_message(reason, users, cancelled_wait=was_waiting and bool(users))]
    env = dict(os.environ)
    env["HARNESS_JOB_DIR"] = os.path.join(session_dir, "jobs")
    env["HARNESS_WAKE_FILE"] = wake_path
    # The spec's env WINS: it is the session's identity (its kernel's job dir,
    # its wait mode), and the defaults above are only for sessions that say
    # nothing.
    env.update(spec.get("env") or {})
    result = runner(argv, cwd=spec.get("cwd") or session_dir, env=env)
    return getattr(result, "returncode", 0)


def scan_once(sessions_root: str, *, now=time.time, runner=subprocess.run,
              probe=None, log: Callable[[str], None] = print) -> List[str]:
    """One pass over every session; returns the names of sessions woken."""
    woken = []
    try:
        entries = sorted(os.listdir(sessions_root))
    except OSError:
        return woken
    for name in entries:
        session_dir = os.path.join(sessions_root, name)
        if not os.path.isfile(os.path.join(session_dir, SESSION_FILE)):
            continue
        reason = wake_reason(session_dir, now)
        if not reason:
            continue
        lease = acquire_lease(session_dir, probe)
        if lease is None:
            continue  # a live harness already owns this session
        try:
            # Re-derive under the lease: the world may have moved between the
            # unlocked check and now, and a consumed wake must not re-fire.
            reason = wake_reason(session_dir, now)
            if not reason:
                continue
            log(f"[scheduler] waking {name}: {reason}")
            consume_messages(session_dir)
            code = run_wake(session_dir, reason, runner=runner)
            log(f"[scheduler] {name} exited {code}")
            woken.append(name)
        finally:
            release_lease(lease)
    return woken


def drain(sessions_root: str, *, interval: float = 5.0, deadline: Optional[float] = None,
          now=time.time, runner=subprocess.run, log: Callable[[str], None] = print) -> bool:
    """
    Serve until NO session has a pending wake, then return True — the mode a
    finite run (one terminal-bench task) wants. Returns False on deadline.
    A session whose harness writes a new wake.json keeps the drain alive.
    """
    started = now()
    while True:
        scan_once(sessions_root, now=now, runner=runner, log=log)
        pending = [
            n for n in (os.listdir(sessions_root) if os.path.isdir(sessions_root) else [])
            if os.path.exists(os.path.join(sessions_root, n, WAKE_FILE))
            or pending_user_messages(os.path.join(sessions_root, n))
        ]
        if not pending:
            log("[scheduler] nothing left waiting; drained")
            return True
        if deadline is not None and now() - started > deadline:
            log(f"[scheduler] deadline after {int(now() - started)}s with {pending} still waiting")
            return False
        time.sleep(interval)


def serve(sessions_root: str, *, interval: float = 5.0, now=time.time,
          runner=subprocess.run, log: Callable[[str], None] = print) -> None:
    """The loop. Ctrl-C to stop; state is on disk, so stopping is always safe."""
    log(f"[scheduler] watching {sessions_root} every {interval}s")
    while True:
        scan_once(sessions_root, now=now, runner=runner, log=log)
        time.sleep(interval)


def _reason_for_request_cli(consume: bool) -> None:
    """
    `scheduler.py --reason-for-request [--consume]`: a wait request (JSON) on stdin,
    `{"reason", "message"}` on stdout — reason null while nothing is due.

    For hosts that are not this scheduler but share the kernel's filesystem: print
    mode's own wake, and RPC hosts, which receive the request on `agent_end`.
    --consume marks a waking message read, as the scheduler's wake does.
    """
    import sys

    wake = json.load(sys.stdin)
    reason = reason_for(wake, wake.get("job_dir"))
    if reason and consume:
        for box in (wake.get("mailboxes") or {}).values():
            Mailbox(box).mark_read()
    print(json.dumps({"reason": reason, "message": wake_message(reason) if reason else None}))


if __name__ == "__main__":
    import argparse
    import sys as _sys

    if "--reason-for-request" in _sys.argv:
        _reason_for_request_cli("--consume" in _sys.argv)
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
