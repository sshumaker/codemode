#!/usr/bin/env python3
"""
The broker — the harness-side half of `spawn()`.

    python3 runtime/subagent_broker.py <job-dir> --serve

Why anything runs out here at all
---------------------------------
A subagent is a *brain*: a model loop that holds a real API credential. The
architecture (docs/CLOUD-HARNESS-DESIGN.md §3.3, and Scott 2026-08-16) says the
brain is stateless, harness-side, and holds the credentials, while the sandbox
runs python cells and nothing else. `spawn()` used to fork the child straight
out of the kernel, which put a brain inside the sandbox and handed it the
kernel's environment — so the moment the kernel env was scrubbed of
`ANTHROPIC_API_KEY` (`HARNESS_KERNEL_ENV_SCRUB`, eval task `keyleak`) that child
became a subagent with no key: a *weak subagent* rather than a harness error,
which is the failure mode this project keeps paying for.

So the kernel leaves a request and this process starts the work, in the loop's
world, with the loop's environment. The agent-facing API does not move an inch:
`spawn()` still returns immediately and the result still arrives through
`jobs.get(name)`, because a brokered job records itself on disk exactly like any
other job.

Exactly-once, derived from disk
-------------------------------
The request file IS the token, and `rename` is the only primitive two processes
cannot both win — the scheduler's `wake.json` -> `wake.json.fired` pattern, one
level down. Claiming, reclaiming and launching are a chain of renames, so a
broker SIGKILLed at any instant leaves a state a fresh broker can read:

    requests/<name>.json                  unclaimed — anybody may claim it
    requests/<name>@claim-<token>.json    who claimed it (pid + start identity)
    requests/<name>@claimed-<token>.json  claimed, launch in progress
    requests/<name>@intent-<token>        a fork was ATTEMPTED (written pre-fork)
    requests/<name>@launched-<token>.json launched, with the pid
    requests/<name>@abandoned-<token>.json  gave up, with the reason

The `@` is load-bearing: job names are `[A-Za-z0-9_.-]+`, so a name may contain a
dot but never an at-sign, and a request can therefore never be mistaken for a
broker's note about one (a job called `x.claim-1` otherwise writes a request that
reads as bookkeeping, and no broker ever services it).

The owner file is written BEFORE the claiming rename, so a broker that dies
between the two leaves an orphan owner file and an unclaimed request — the safe
direction. The intent marker is written before the fork, which makes the one
genuinely ambiguous window ("did the fork happen?") *nameable* from disk:

    dead owner, no intent                   -> nothing was forked. Relaunch.
    dead owner, intent, pid file or marker  -> it launched. Adopt, never relaunch.
    dead owner, intent, neither             -> unknowable. Fail the job, say why.

The last case is the project's standing answer to "may or may not have started"
(`submit`'s `starting` state): refuse to double-run, and make the ambiguity
visible instead of resolving it by guessing. It costs one subagent in a window a
few milliseconds wide; a wrong guess costs a duplicated model run.

The children are `setsid` detached, so they outlive this broker, the agent loop
and the kernel — which is what a wait that ends the turn requires.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import uuid
from typing import Callable, Dict, List, Optional

import jobs as J

# Exit codes the broker writes into a job's exit marker when the job could not be
# started. They are the job's OWN reporting channel — the parent reads
# `.exit_code` and `.output` and needs no knowledge that a broker exists.
EXIT_LAUNCH_FAILED = 127
EXIT_AMBIGUOUS = 70

# `@` separates a broker's bookkeeping from the request it is about, and it is
# `@` rather than `.` because job names are `[A-Za-z0-9_.-]+` — so a name can
# contain a dot but never an at-sign. With a dot, a job legitimately called
# `x.claim-1` would write `x.claim-1.json`, which reads as bookkeeping, and the
# broker would skip the request forever while the kernel waited for it. The
# separator is what makes "a request" and "a broker's note" disjoint by
# construction rather than by convention.
_CLAIMED = re.compile(r"^(?P<name>.+)@claimed-(?P<token>[^.]+)\.json$")


class Broker:
    """
    One broker over one job directory.

    Everything that touches the world is injected — the clock, the process probe,
    the spawner — so the exactly-once behaviour can be tested against a dead
    owner and a torn claim without killing real processes for every case.
    """

    def __init__(
        self,
        job_dir: str,
        *,
        now: Callable[[], float] = time.time,
        probe: Optional[Callable[[int], tuple]] = None,
        spawn: J.SpawnFn = J._real_spawn,
        log: Callable[[str], None] = lambda m: print(m, flush=True),
    ):
        self.job_dir = os.path.abspath(job_dir)
        self.requests_dir = os.path.join(self.job_dir, J.REQUESTS_DIR)
        self._now = now
        self._probe = probe or J._real_probe
        self._spawn = spawn
        self._log = log
        self._audit_path = os.path.join(self.requests_dir, "broker.jsonl")
        os.makedirs(self.requests_dir, exist_ok=True)

    # -- evidence ----------------------------------------------------------------

    def _audit(self, event: str, **fields) -> None:
        """
        Append what was seen, not just what was decided.

        CLAUDE.md: log the inputs. A broker's decisions are made from files that
        it then renames, so the evidence for "why did this request get relaunched"
        is destroyed by the act of relaunching unless it is copied out first.
        """
        line = dict(fields, event=event, at=self._now(), broker_pid=os.getpid())
        try:
            with open(self._audit_path, "a") as fh:
                fh.write(json.dumps(line) + "\n")
        except OSError:
            pass

    def _identity(self) -> dict:
        pid = os.getpid()
        return {"pid": pid, "pid_start": self._probe(pid)[1], "at": self._now()}

    def _owner_alive(self, owner: dict) -> bool:
        """
        Whether the process that holds a claim still exists.

        Lifted from the scheduler's lease check, and it errs the same way: on
        missing or unprobeable evidence, assume alive. A wrongly-stolen claim is a
        second copy of a paid model run; a claim held slightly too long is a
        subagent that starts late.
        """
        pid = owner.get("pid")
        if not pid:
            return False
        status, start = self._probe(pid)
        if status == "dead":
            return False
        recorded = owner.get("pid_start")
        return not (recorded and start and start != recorded)

    # -- paths -------------------------------------------------------------------

    def _p(self, *parts: str) -> str:
        return os.path.join(self.requests_dir, *parts)

    def _new_token(self) -> str:
        return f"{os.getpid()}-{uuid.uuid4().hex[:8]}"

    # -- the two halves of a scan -------------------------------------------------

    def pending(self) -> List[str]:
        """Unclaimed request files, oldest first."""
        try:
            names = sorted(os.listdir(self.requests_dir))
        except OSError:
            return []
        out = []
        for f in names:
            if not f.endswith(".json") or "@" in f or f == "broker.jsonl":
                continue
            out.append(self._p(f))
        return out

    def claims(self) -> List[tuple]:
        """(path, name, token) for every claim currently in flight."""
        try:
            names = sorted(os.listdir(self.requests_dir))
        except OSError:
            return []
        out = []
        for f in names:
            m = _CLAIMED.match(f)
            if m:
                out.append((self._p(f), m.group("name"), m.group("token")))
        return out

    def claim(self, request_path: str) -> Optional[tuple]:
        """
        Take a request, exactly once. Returns (payload, token) or None.

        Owner file first, rename second. The reverse order has a window in which a
        claim exists with no way to tell who holds it — and a claim whose holder
        cannot be identified can never be reclaimed, which turns one dead broker
        into a request that hangs forever.
        """
        name = os.path.basename(request_path)[: -len(".json")]
        token = self._new_token()
        # Identity first, then one atomic write. `_identity()` shells out to `ps`,
        # which takes milliseconds — evaluated inside the `open()` it left an EMPTY
        # owner file visible for that whole window, and an owner file that cannot
        # be parsed is one a reclaimer reads as "nobody holds this". It is safe
        # today only because the claiming rename comes after; making the file
        # appear complete-or-not-at-all removes the need for that argument.
        owner = json.dumps(self._identity())
        try:
            tmp = self._p(f"{name}@claim-{token}.writing")
            with open(tmp, "w") as fh:
                fh.write(owner)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._p(f"{name}@claim-{token}.json"))
        except OSError as exc:
            self._log(f"[broker] cannot write a claim for {name}: {exc}")
            return None
        claimed = self._p(f"{name}@claimed-{token}.json")
        try:
            os.rename(request_path, claimed)
        except OSError:
            return None  # another broker got there first; its rename won
        try:
            with open(claimed) as fh:
                payload = json.load(fh)
        except (OSError, ValueError) as exc:
            self._abandon(name, token, f"the request file is unreadable: {exc}")
            return None
        self._audit("claimed", name=name, token=token, request=payload)
        return payload, token

    def launch(self, payload: dict, token: str) -> Optional[int]:
        """
        Start the work, detached, in THIS process's environment.

        `jobs._real_spawn` rather than a Popen of our own: the wrapper, the
        session detachment and the log handling are what make a job observable
        from disk, and a second implementation of them here would be a second
        implementation wearing one name.
        """
        name = payload["name"]
        intent = self._p(f"{name}@intent-{token}")
        try:
            with open(intent, "w") as fh:
                fh.write(json.dumps({"at": self._now(), "cwd": payload.get("cwd")}))
        except OSError as exc:
            self._abandon(name, token, f"could not record the launch intent: {exc}")
            return None

        try:
            pid = self._spawn(payload["wrapped"], payload["log"], payload.get("cwd") or None)
        except BaseException as exc:  # noqa: BLE001 - reported, then re-raised is wrong here
            self._fail_job(payload, EXIT_LAUNCH_FAILED,
                           f"the harness could not start this job: {exc}")
            self._abandon(name, token, f"spawn failed: {exc}")
            return None

        with open(self._p(f"{name}@launched-{token}.json"), "w") as fh:
            json.dump({"pid": pid, "at": self._now(), "cwd": payload.get("cwd")}, fh)
        try:
            os.remove(self._p(f"{name}@claimed-{token}.json"))
        except OSError:
            pass
        self._audit("launched", name=name, token=token, pid=pid, cmd=payload.get("cmd"))
        self._log(f"[broker] started {name} (pid {pid})")
        return pid

    def service(self, request_path: str) -> Optional[str]:
        """Claim and launch one request. Returns the name if THIS broker ran it."""
        got = self.claim(request_path)
        if got is None:
            return None
        payload, token = got
        return payload["name"] if self.launch(payload, token) is not None else None

    # -- what a dead broker left behind -------------------------------------------

    def recover(self) -> List[str]:
        """
        Re-derive every in-flight claim from disk. Returns the names relaunched.

        This is the SIGKILL-replay invariant for the request side: a fresh broker
        that has never seen any of this must reach a correct state from files
        alone, and must not run anything twice.
        """
        relaunched = []
        for path, name, token in self.claims():
            owner = {}
            try:
                with open(self._p(f"{name}@claim-{token}.json")) as fh:
                    owner = json.load(fh)
            except (OSError, ValueError):
                owner = {}
            if self._owner_alive(owner):
                continue  # its broker is still working on it

            try:
                with open(path) as fh:
                    payload = json.load(fh)
            except (OSError, ValueError) as exc:
                self._abandon(name, token, f"claimed request unreadable: {exc}")
                continue

            launched = os.path.exists(payload.get("pid_file") or "")
            finished = os.path.exists(payload.get("exit_marker") or "")
            intent = os.path.exists(self._p(f"{name}@intent-{token}"))
            self._audit("recovering", name=name, token=token, owner=owner,
                        pid_file=launched, exit_marker=finished, intent=intent)

            if launched or finished:
                # It ran. The job records itself; the parent's `jobs.get` finds
                # the pid in the pid file with no help from us.
                os.replace(path, self._p(f"{name}@adopted-{token}.json"))
                self._log(f"[broker] {name} was already started by a dead broker; adopted")
                continue
            if intent:
                # The one unknowable window: forked-or-not, between the intent
                # write and the shell's first command. Refusing is the standing
                # answer — a duplicate model run is worse than a reported failure.
                self._fail_job(payload, EXIT_AMBIGUOUS, (
                    "the harness process that was starting this job died in the instant "
                    "between forking it and the job recording its pid, so whether it "
                    "started cannot be determined from disk. It was NOT started again, "
                    "because running a subagent twice is worse than not running it. "
                    "Spawn it again under a different name if you still need it."))
                self._abandon(name, token, "died inside the fork window; not relaunched")
                continue

            # Died before forking anything: provably nothing ran. Reclaim by the
            # same rename that claimed it, so two reclaimers cannot both win.
            token2 = self._new_token()
            owner2 = json.dumps(self._identity())
            try:
                with open(self._p(f"{name}@claim-{token2}.json"), "w") as fh:
                    fh.write(owner2)
                os.rename(path, self._p(f"{name}@claimed-{token2}.json"))
            except OSError:
                continue  # somebody else reclaimed it first
            self._audit("reclaimed", name=name, token=token, new_token=token2, owner=owner)
            self._log(f"[broker] reclaiming {name} from a dead broker (pid {owner.get('pid')})")
            if self.launch(payload, token2) is not None:
                relaunched.append(name)
        return relaunched

    # -- failure reporting, through the job's own channels -------------------------

    def _fail_job(self, payload: dict, code: int, message: str) -> None:
        """
        Tell the PARENT, in the only vocabulary it already reads.

        Deliberately not a write to the job record: the record's writer is the
        kernel side, and two writers on one file is how fields get silently lost.
        A line in the log and an exit marker is the same thing every other failed
        job produces — `.output` explains it and `.exit_code` is non-zero — so
        nothing on the parent's side needs to know a broker exists.
        """
        try:
            with open(payload["log"], "a") as fh:
                fh.write(f"\n[broker] {message}\n")
        except OSError:
            pass
        try:
            with open(payload["exit_marker"], "w") as fh:
                fh.write(str(code))
        except OSError:
            pass
        self._audit("failed", name=payload.get("name"), code=code, message=message)

    def _abandon(self, name: str, token: str, reason: str) -> None:
        try:
            os.replace(self._p(f"{name}@claimed-{token}.json"),
                       self._p(f"{name}@abandoned-{token}.json"))
        except OSError:
            pass
        self._audit("abandoned", name=name, token=token, reason=reason)
        self._log(f"[broker] abandoned {name}: {reason}")

    # -- the loop -------------------------------------------------------------------

    def scan_once(self) -> List[str]:
        """Recover first, then take new work. Returns names started this pass."""
        started = self.recover()
        for path in self.pending():
            name = self.service(path)
            if name:
                started.append(name)
        return started

    def serve(self, interval: float = 0.5, deadline: Optional[float] = None) -> None:
        self._log(f"[broker] watching {self.requests_dir} every {interval}s")
        started = self._now()
        while True:
            self.scan_once()
            if deadline is not None and self._now() - started > deadline:
                self._log("[broker] deadline reached; exiting")
                return
            time.sleep(interval)


def main(argv: List[str]) -> int:
    ap = argparse.ArgumentParser(description="service brokered job requests")
    ap.add_argument("job_dir", help="the HARNESS_JOB_DIR whose requests/ to service")
    ap.add_argument("--once", action="store_true", help="one pass, then exit")
    ap.add_argument("--interval", type=float, default=0.5)
    ap.add_argument("--deadline", type=float, default=None,
                    help="stop serving after this many seconds")
    args = ap.parse_args(argv)

    broker = Broker(args.job_dir)
    if args.once:
        for name in broker.scan_once():
            print(f"started {name}")
        return 0
    broker.serve(interval=args.interval, deadline=args.deadline)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
