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
from typing import Callable, List, Optional

import jobs as J

WAKE_FILE = "wake.json"
SESSION_FILE = "session.json"
LEASE_DIR = "lease"


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

    A missing/unreadable wake.json is "not waiting" — never a wake. A watched
    job that has left the live states wakes the session immediately (that is
    what makes `wake_after` a deadline rather than a sleep); the deadline is
    the backstop.
    """
    try:
        with open(os.path.join(session_dir, WAKE_FILE)) as fh:
            wake = json.load(fh)
    except (OSError, ValueError):
        return None
    store = J.JobStore(os.path.join(session_dir, "jobs"), emit=lambda m: None)
    for name in wake.get("watch") or []:
        rec = store._refresh(store._read(name))
        if rec and rec.get("state") not in J.LIVE_STATES:
            return f"job {name!r} finished: {rec.get('state')} — {rec.get('reason') or ''}".strip(" —")
    wake_at = wake.get("wake_at")
    if wake_at is not None and now() >= wake_at:
        return f"the requested wait of {wake.get('wake_after', '?')}s elapsed"
    return None


# -- running one wake ----------------------------------------------------------------

def run_wake(session_dir: str, reason: str, *, runner=subprocess.run) -> int:
    """
    Invoke the session's harness once, to exit.

    The wake.json is consumed BEFORE the run: the runtime writes a fresh one if
    the agent waits again, and a stale request must not double-fire. It is
    renamed (not deleted) so a crash mid-run leaves evidence of what fired.
    """
    with open(os.path.join(session_dir, SESSION_FILE)) as fh:
        spec = json.load(fh)
    wake_path = os.path.join(session_dir, WAKE_FILE)
    os.replace(wake_path, f"{wake_path}.fired")

    argv = list(spec["argv"]) + [f"[woken: {reason}] Check your jobs and continue the task."]
    env = dict(os.environ)
    env.update(spec.get("env") or {})
    env["HARNESS_JOB_DIR"] = os.path.join(session_dir, "jobs")
    env["HARNESS_WAKE_FILE"] = wake_path
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
            code = run_wake(session_dir, reason, runner=runner)
            log(f"[scheduler] {name} exited {code}")
            woken.append(name)
        finally:
            release_lease(lease)
    return woken


def serve(sessions_root: str, *, interval: float = 5.0, now=time.time,
          runner=subprocess.run, log: Callable[[str], None] = print) -> None:
    """The loop. Ctrl-C to stop; state is on disk, so stopping is always safe."""
    log(f"[scheduler] watching {sessions_root} every {interval}s")
    while True:
        scan_once(sessions_root, now=now, runner=runner, log=log)
        time.sleep(interval)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="wake scheduler over a sessions root")
    ap.add_argument("sessions_root")
    ap.add_argument("--interval", type=float, default=5.0)
    ap.add_argument("--once", action="store_true", help="one scan, then exit (cron mode)")
    args = ap.parse_args()
    if args.once:
        scan_once(args.sessions_root)
    else:
        serve(args.sessions_root, interval=args.interval)
