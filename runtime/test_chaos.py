"""
The SIGKILL-replay invariant, as a test (docs/CLOUD-HARNESS-DESIGN.md §3.1):

    After `kill -9` of every harness/kernel/job process at any instant, a fresh
    harness reading only the disk must reach a correct state: finished jobs
    report finished, dead jobs report dead-with-evidence (never `running`
    forever), the next turn is constructible, and no action is executed twice.

Everything here uses REAL processes, real SIGKILLs and real fresh JobStores —
no fakes — because the invariant is about what survives on disk when memory is
gone. "A fresh store over the same directory IS a new kernel."

These are the review's P2 findings converted from five patches into one
principle. Each test names the finding it pins.
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import shutil
import unittest

import jobs as J
import scheduler as S

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEDULER = os.path.join(HERE, "scheduler.py")


def wait_until(predicate, timeout=20.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class ChaosBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="chaos-")
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)

    def tearDown(self):
        # Kill anything still running so the suite never leaks processes.
        for rec in self.store._all():
            pid = rec.get("pid")
            if pid:
                try:
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
                except OSError:
                    pass
        shutil.rmtree(self.dir, ignore_errors=True)

    def fresh_kernel(self):
        """A new store over the same directory: files, no memory."""
        return J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)

    def fresh_process_view(self, name):
        """
        The strongest form: a SEPARATE python process reads the store. Nothing
        held by this process — Popen handles, interned records — can leak in.
        """
        out = subprocess.run(
            [sys.executable, "-c",
             "import sys, json; sys.path.insert(0, sys.argv[1]); import jobs as J; "
             "s = J.JobStore(sys.argv[2], emit=lambda m: None); "
             "r = s._refresh(s._read(sys.argv[3])); "
             "print(json.dumps({k: r.get(k) for k in ('state', 'reason', 'exit_code')}))",
             os.path.dirname(os.path.abspath(__file__)), self.dir, name],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        return json.loads(out.stdout.strip().splitlines()[-1])

    def sigkill(self, name):
        rec = self.store._read(name)
        os.killpg(os.getpgid(rec["pid"]), signal.SIGKILL)

    def confirm_death_window(self):
        """Death needs two sightings DEATH_CONFIRM_SECONDS apart; wait it out."""
        time.sleep(J.DEATH_CONFIRM_SECONDS + 0.1)


class TestFinishedWorkSurvivesEverything(ChaosBase):
    def test_a_completed_job_is_done_in_a_process_that_never_saw_it(self):
        self.store.submit("echo payload-42", name="quick")
        self.assertTrue(wait_until(lambda: self.store.get("quick").done))
        view = self.fresh_process_view("quick")
        self.assertEqual(view["state"], "done")
        self.assertEqual(view["exit_code"], 0)

    def test_a_failed_job_reports_its_exit_code_after_replay(self):
        self.store.submit("exit 7", name="bad", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("bad").done))
        view = self.fresh_process_view("bad")
        self.assertEqual(view["state"], "done")
        self.assertEqual(view["exit_code"], 7)


class TestEvictionIsNotForever(ChaosBase):
    """H2: the record said `running` forever after a marker-less death."""

    def test_a_sigkilled_job_is_declared_dead_with_evidence(self):
        self.store.submit("echo started; sleep 300", name="victim", strict=False)
        self.assertTrue(wait_until(
            lambda: (self.store._read("victim") or {}).get("state") == "running"))
        # "running" is recorded before the command's first line has run; kill it
        # before the echo lands and there is no tail to be the evidence.
        self.assertTrue(wait_until(lambda: "started" in self.store.get("victim").output))
        self.sigkill("victim")
        # First sighting stamps, second confirms — the fresh kernel polls.
        kernel = self.fresh_kernel()
        kernel.get("victim").state
        self.confirm_death_window()
        self.assertTrue(wait_until(lambda: kernel.get("victim").state == "died", timeout=10))
        rec = kernel._read("victim")
        self.assertIn("without writing an exit marker", rec["reason"])
        self.assertIn("started", rec["output_tail"], "the log tail is the evidence")
        self.assertTrue(kernel.get("victim").done, "died must be terminal")

    def test_a_transient_misread_does_not_kill_a_live_job(self):
        # The one-way flip needs two confirmed sightings: a probe that lies once
        # (ps under load) must not end a job that is still running.
        flaky = {"n": 0}

        def lying_probe(pid):
            flaky["n"] += 1
            return ("dead", None) if flaky["n"] == 1 else J._real_probe(pid)

        store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None, probe=lying_probe)
        store.submit("sleep 300", name="alive", strict=False)
        wait_until(lambda: (store._read("alive") or {}).get("state") == "running")
        store.get("alive").state  # first (lying) sighting stamps dead_seen_at
        self.confirm_death_window()
        self.assertEqual(store.get("alive").state, "running",
                         "a single misread became a permanent death")
        self.assertIsNone(store._read("alive").get("dead_seen_at"),
                          "the live sighting must clear the stamp")


class TestNothingRunsTwice(ChaosBase):
    """The other half of the invariant: replay must not double-execute."""

    def test_an_interrupted_submit_is_refused_on_replay(self):
        # A `starting` record with no process is the crash-between-write-and-spawn
        # window. The fresh kernel must refuse the name, not run the work again.
        rec = {
            "name": "half", "cmd": "expensive", "expect": "once", "pid": None,
            "log": self.store._log_path("half"),
            "exit_marker": os.path.join(self.dir, "half.exit"),
            "pid_file": self.store._pid_path("half"),
            "state": "starting", "reason": None, "started_at": time.time(),
            "max_runtime": None, "lint": [], "events": 0, "silent": False,
            "kind": "job", "meta": {},
        }
        self.store._write(rec)
        kernel = self.fresh_kernel()
        with self.assertRaises(J.JobError) as ctx:
            kernel.submit("expensive", name="half")
        self.assertIn("run the work twice", str(ctx.exception))

    def test_a_done_job_stays_done_it_is_never_respawned(self):
        self.store.submit("echo once >> ran.txt", name="once", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("once").done))
        # Replay from three fresh kernels; the work must have run exactly once.
        for _ in range(3):
            self.assertEqual(self.fresh_kernel().get("once").state, "done")
        with open(os.path.join(self.dir, "ran.txt")) as fh:
            self.assertEqual(fh.read().count("once"), 1)


class TestAHalfWrittenMarkerIsNotAnExitCode(ChaosBase):
    """
    `echo $? > marker` creates the file and fills it a moment later, so a refresh
    can land on an empty one. Reading that as an exit code invented a failure for
    a healthy job — and the flip is one-way, so the invention was permanent.

    Found as an intermittent failure of the subagent CLI round-trip (exitCode -1
    from a child that exited 0), which only showed up once the suite ran enough
    processes to make the window likely.
    """

    def test_an_empty_marker_means_not_finished_yet_not_finished_badly(self):
        job = self.store.submit("sleep 30", name="live", strict=False)
        rec = self.store._read("live")
        open(rec["exit_marker"], "w").close()  # exactly the mid-write instant
        fresh = self.store._refresh(self.store._read("live"))
        self.assertEqual(fresh["state"], "running",
                         "a half-written marker was read as an exit code")
        self.assertIsNone(fresh.get("exit_code"))
        self.assertFalse(job.done)
        # And the real code, once it lands, is still picked up.
        with open(rec["exit_marker"], "w") as fh:
            fh.write("0\n")
        self.assertTrue(job.done)
        self.assertTrue(job.ok)

    def test_a_marker_that_never_fills_is_reported_as_a_death_not_a_verdict(self):
        # The one thing "defer" must not do is hang forever. A process that is
        # gone gets the liveness fallback, which says so with evidence.
        self.store.submit("echo started; sleep 300", name="victim", strict=False)
        self.assertTrue(wait_until(
            lambda: (self.store._read("victim") or {}).get("state") == "running"))
        rec = self.store._read("victim")
        open(rec["exit_marker"], "w").close()
        self.sigkill("victim")
        kernel = self.fresh_kernel()
        kernel.get("victim").state
        self.confirm_death_window()
        self.assertTrue(wait_until(lambda: kernel.get("victim").state == "died", timeout=10))
        self.assertIn("without writing an exit marker", kernel._read("victim")["reason"])


class TestKillSignalsOnlyWhatItCanVouchFor(ChaosBase):
    """H3: killpg on a stale pid must never reach a stranger."""

    def test_kill_on_a_reused_pid_does_not_signal_the_stranger(self):
        # A record whose pid now belongs to a DIFFERENT process (start identities
        # differ). kill() must decline to signal and say so.
        decoy = subprocess.Popen(["sleep", "60"], start_new_session=True)
        try:
            self.store.submit("sleep 300", name="stale", strict=False)
            wait_until(lambda: (self.store._read("stale") or {}).get("state") == "running")
            rec = self.store._read("stale")
            original_pid = rec["pid"]
            # Simulate reuse: the record now points at the decoy with the ORIGINAL
            # process's start identity.
            os.killpg(os.getpgid(original_pid), signal.SIGKILL)
            rec["pid"] = decoy.pid
            rec["pid_start"] = "Thu Jan  1 00:00:00 1970"  # not the decoy's
            self.store._write(rec)

            self.store.kill("stale")
            self.assertIsNone(decoy.poll(), "kill() signalled a process it could not vouch for")
            self.assertIn("nothing was signalled", self.store._read("stale")["reason"])
        finally:
            try:
                os.killpg(os.getpgid(decoy.pid), signal.SIGKILL)
            except OSError:
                pass


class TestBrokerServicesEachRequestExactlyOnce(ChaosBase):
    """
    The SIGKILL-replay invariant for the request side (subagent_broker.py).

    A brokered job is started by a process that may die at any instant, and the
    thing it starts costs real money — so "no action is executed twice" is not a
    tidiness property here, it is the whole reason the request file is a rename
    token rather than a flag.

    These build the disk state a dead broker leaves and ask a FRESH broker what it
    does with it, because that is the actual question: everything a broker knows
    is in files, and the ones that matter are written by processes that are gone.
    """

    def setUp(self):
        super().setUp()
        import subagent_broker

        self.mod = subagent_broker
        self.ran = os.path.join(self.dir, "ran.txt")

    def broker(self, **kw):
        return self.mod.Broker(self.dir, log=lambda m: None, **kw)

    def request_a_job(self, name="work"):
        """A brokered job whose command leaves one line per execution."""
        return self.store.submit(f"echo once >> {self.ran}", name=name,
                                 via_broker=True, strict=False)

    def executions(self):
        try:
            with open(self.ran) as fh:
                return fh.read().count("once")
        except OSError:
            return 0

    def dead_pid(self):
        """A pid that provably belongs to nothing: started, killed, and reaped."""
        proc = subprocess.Popen(["sleep", "30"])
        proc.kill()
        proc.wait()
        return proc.pid

    def stage_claim(self, name, *, owner_pid, intent, launch):
        """
        The disk as a broker that died would have left it.

        Written by hand rather than by interrupting a real broker, because the
        invariant is about what a fresh process can derive from these files — so
        the files are the input, and producing them directly is the honest test.
        """
        req = os.path.join(self.dir, "requests", f"{name}.json")
        with open(req) as fh:
            payload = json.load(fh)
        token = f"{owner_pid}-dead"
        base = os.path.join(self.dir, "requests")
        with open(os.path.join(base, f"{name}@claim-{token}.json"), "w") as fh:
            json.dump({"pid": owner_pid, "pid_start": "Thu Jan  1 00:00:00 1970"}, fh)
        os.rename(req, os.path.join(base, f"{name}@claimed-{token}.json"))
        if intent:
            with open(os.path.join(base, f"{name}@intent-{token}"), "w") as fh:
                fh.write("{}")
        if launch:
            J._real_spawn(payload["wrapped"], payload["log"], payload["cwd"])
        return token

    # -- the three the brief names -------------------------------------------------

    def test_an_unclaimed_request_is_serviced_once_and_only_once(self):
        job = self.request_a_job()
        self.assertEqual(job.state, "requested")
        self.assertEqual(self.broker().scan_once(), ["work"])
        self.assertTrue(wait_until(lambda: job.done), f"never finished: {job!r}")
        self.assertTrue(job.ok)
        # Three more brokers over the same directory must find nothing to do.
        for _ in range(3):
            self.assertEqual(self.broker().scan_once(), [])
        self.assertEqual(self.executions(), 1)

    def test_a_job_named_like_the_brokers_own_bookkeeping_is_still_serviced(self):
        # Job names may contain dots, so `claim-1.claim-1` is a legal name whose
        # request file would read as a broker's note about a job — and a request
        # the broker skips is a subagent that never starts and never says why.
        # The `@` separator is what keeps the two namespaces disjoint.
        job = self.store.submit(f"echo once >> {self.ran}", name="claim-1.claimed-9",
                                via_broker=True, strict=False)
        self.assertEqual(self.broker().scan_once(), ["claim-1.claimed-9"])
        self.assertTrue(wait_until(lambda: job.done))
        self.assertEqual(self.executions(), 1)

    def test_two_brokers_racing_for_one_request_produce_one_launch(self):
        self.request_a_job()
        path = os.path.join(self.dir, "requests", "work.json")
        first, second = self.broker(), self.broker()
        won = first.claim(path)
        lost = second.claim(path)
        self.assertIsNotNone(won, "the first broker did not get the request")
        self.assertIsNone(lost, "both brokers claimed the same request")
        first.launch(*(won[0], won[1]))
        self.assertTrue(wait_until(lambda: self.store.get("work").done))
        self.assertEqual(self.executions(), 1)

    def test_a_broker_that_died_before_forking_is_reclaimed_and_the_work_runs(self):
        job = self.request_a_job()
        self.stage_claim("work", owner_pid=self.dead_pid(), intent=False, launch=False)
        self.assertEqual(self.broker().recover(), ["work"],
                         "a claim held by a dead broker was never reclaimed")
        self.assertTrue(wait_until(lambda: job.done))
        self.assertTrue(job.ok)
        self.assertEqual(self.executions(), 1)
        self.assertEqual(self.broker().scan_once(), [], "reclaimed twice")

    def test_a_broker_that_died_after_launching_does_not_launch_it_twice(self):
        job = self.request_a_job()
        self.stage_claim("work", owner_pid=self.dead_pid(), intent=True, launch=True)
        self.assertTrue(wait_until(lambda: job.done), f"the staged launch never ran: {job!r}")
        # The claim is stale and its owner is dead, but the pid file proves the
        # work started — adopt it, never repeat it.
        self.assertEqual(self.broker().recover(), [])
        self.assertEqual(self.executions(), 1)
        self.assertTrue(job.ok)

    # -- the case the brief does not name, which is the one that must not guess -----

    def test_a_death_inside_the_fork_window_is_reported_rather_than_retried(self):
        job = self.request_a_job()
        # Intent written, nothing forked: from disk alone, "did it start?" has no
        # answer. Running it again could double a paid model run, so it does not.
        self.stage_claim("work", owner_pid=self.dead_pid(), intent=True, launch=False)
        self.assertEqual(self.broker().recover(), [])
        self.assertEqual(self.executions(), 0)
        self.assertTrue(wait_until(lambda: job.done), f"left in limbo: {job!r}")
        self.assertEqual(job.exit_code, self.mod.EXIT_AMBIGUOUS)
        self.assertIn("cannot be determined", job.output)
        self.assertIn("NOT started again", job.output)

    def test_the_broker_kept_the_evidence_for_every_decision(self):
        # CLAUDE.md: log the inputs. Recovery decisions are made from files the
        # decision then renames, so without this the reason a request was
        # relaunched (or was not) is unrecoverable an instant later.
        self.request_a_job()
        self.stage_claim("work", owner_pid=self.dead_pid(), intent=False, launch=False)
        self.broker().recover()
        with open(os.path.join(self.dir, "requests", "broker.jsonl")) as fh:
            events = [json.loads(l) for l in fh if l.strip()]
        kinds = [e["event"] for e in events]
        self.assertIn("recovering", kinds)
        self.assertIn("reclaimed", kinds)
        self.assertIn("launched", kinds)
        seen = next(e for e in events if e["event"] == "recovering")
        # Not just the verdict: the three facts the verdict was derived from.
        for field in ("pid_file", "exit_marker", "intent", "owner"):
            self.assertIn(field, seen)

    # -- a real broker, really killed ------------------------------------------------

    def test_a_real_broker_sigkilled_at_each_stage_leaves_a_recoverable_state(self):
        """
        The invariant end to end: a real broker process, a real SIGKILL, once at
        each stage of the chain, and a fresh broker asked to finish the job.

        The stages are named rather than sampled because a timing-sampled version
        of this passed vacuously: the kill landed before the claim on 10 of 10
        attempts, so it only ever tested the easy path while looking like a chaos
        test. Waiting for the stage's own file — and asserting that the wait did
        not time out — is what makes each run land where it says it does.
        """
        module = os.path.join(os.path.dirname(os.path.abspath(__file__)), "subagent_broker.py")
        reqs = os.path.join(self.dir, "requests")
        stages = ("claim-", "claimed-", "intent-", "launched-")

        def reached_at_least(name, stage):
            """
            AT LEAST this stage, not exactly it — `claimed-` is renamed away by a
            successful launch, so a poll can miss it entirely and read "never got
            there" about a broker that got all the way. The later markers persist,
            so the floor is observable even when the stage itself is not.
            """
            wanted = stages[stages.index(stage):]
            return any(f.startswith(f"{name}@{s}") for f in os.listdir(reqs) for s in wanted)

        for stage in stages:
            name = f"work{stage.strip('-')}"
            job = self.store.submit(f"echo once >> {self.ran}", name=name,
                                    via_broker=True, strict=False)
            broker = subprocess.Popen(
                [sys.executable, module, self.dir, "--interval", "0.02"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                # Generous: this waits on a real interpreter starting up, and the
                # suite runs it alongside everything else. A timeout here is a
                # loaded machine, not a broken invariant, and it must not look
                # like one.
                reached = wait_until(lambda: reached_at_least(name, stage),
                                     timeout=60, interval=0.002)
                broker.kill()
            finally:
                broker.wait()
            self.assertTrue(reached, f"the broker never reached {stage} for {name}")

            before = self.executions()
            # A fresh broker with nothing in memory. Two passes: one to recover,
            # one to prove recovery is not itself a way to run something twice.
            self.broker().scan_once()
            self.assertTrue(wait_until(lambda: self.store.get(name).done, timeout=60),
                            f"{name} was neither started nor failed: {self.store.get(name)!r}")
            self.broker().scan_once()
            time.sleep(0.3)
            after = self.executions()

            self.assertLessEqual(after - before, 1,
                                 f"{name} ran {after - before} times for one request "
                                 f"(killed at {stage})")
            if after == before:
                self.assertIn("cannot be determined", self.store.get(name).output,
                              f"{name} never ran and never said why (killed at {stage})")


class TestConfigIsReadAtConstruction(ChaosBase):
    """M6: a host that re-targets HARNESS_JOB_DIR before resuming must win."""

    def test_env_retarget_after_import_is_honoured(self):
        other = tempfile.mkdtemp(prefix="chaos-retarget-")
        saved = os.environ.get("HARNESS_JOB_DIR")
        try:
            os.environ["HARNESS_JOB_DIR"] = other
            self.assertEqual(J.JobStore(emit=lambda m: None).job_dir, other)
        finally:
            if saved is None:
                os.environ.pop("HARNESS_JOB_DIR", None)
            else:
                os.environ["HARNESS_JOB_DIR"] = saved
            shutil.rmtree(other, ignore_errors=True)


class TestBoundedReads(ChaosBase):
    """M2: a verbose job's log must not OOM the kernel at .output."""

    def test_output_is_tail_bounded_and_names_the_full_log(self):
        self.store.submit("yes x | head -c 500000", name="loud", strict=False)
        self.assertTrue(wait_until(lambda: self.store.get("loud").done))
        out = self.store.get("loud").output
        self.assertLess(len(out), 300_000, "output is not bounded")
        self.assertIn("earlier bytes in", out, "the truncation must name the full log")


HARNESS = r"""
import json, os, signal, sys, time
log, transcripts, mode = sys.argv[1], sys.argv[2], sys.argv[3]
message = sys.argv[-1]
first = not os.path.exists(log)
if mode == "record-then-hang" and first:
    # Before the log line: the test kills once it sees the line, and must find
    # the transcript already written.
    with open(os.path.join(transcripts, "session.jsonl"), "a") as fh:
        fh.write(json.dumps({"type": "message", "role": "user", "content": message}) + "\n")
with open(log, "a") as fh:
    fh.write(json.dumps({"pid": os.getpid(), "message": message}) + "\n")
if mode == "hold-first" and first:
    while not os.path.exists(os.path.join(os.path.dirname(log), "release")):
        time.sleep(0.05)
elif mode in ("record-then-hang", "hang-first") and first:
    time.sleep(300)
elif mode == "kill-everything":
    # The whole turn dies with its scheduler, every time: a crash loop.
    os.killpg(os.getpgid(0), signal.SIGKILL)
"""


class TestSchedulerKilledMidTurn(unittest.TestCase):
    """
    The scheduler's own SIGKILL-replay, for the turn rather than the wait: a real
    scheduler runs a real (stand-in) harness through the real supervisor, and is
    SIGKILLed while the turn is live.

    Two claims. A scheduler killed ALONE leaves its harness running, and no fresh
    scheduler may start a second harness on that session until the first is gone.
    A turn killed WITH its scheduler is not silently consumed: a fresh scheduler
    re-wakes the session once, re-delivering the user's message only if the
    transcript never received it — and stops re-waking a turn that keeps dying.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="chaos-sched-")
        self.sessions = os.path.join(self.root, "sessions")
        self.session = os.path.join(self.sessions, "s")
        self.transcripts = os.path.join(self.root, "transcripts")
        self.log = os.path.join(self.root, "harness.log")
        os.makedirs(os.path.join(self.session, "jobs"))
        os.makedirs(self.transcripts)
        self.script = os.path.join(self.root, "harness.py")
        with open(self.script, "w") as fh:
            fh.write(HARNESS)
        self.procs = []

    def tearDown(self):
        for proc in self.procs:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except OSError:
                pass
            proc.wait()
        for run in self.harness_runs():
            try:
                os.kill(run["pid"], signal.SIGKILL)
            except OSError:
                pass
        shutil.rmtree(self.root, ignore_errors=True)

    def configure(self, mode):
        with open(os.path.join(self.session, S.SESSION_FILE), "w") as fh:
            json.dump({"argv": [sys.executable, self.script, self.log, self.transcripts, mode],
                       "cwd": self.session, "transcript_dir": self.transcripts}, fh)

    def scheduler(self):
        """A real scheduler in its own process group, so the test can kill it alone or whole."""
        proc = subprocess.Popen([sys.executable, SCHEDULER, self.sessions, "--interval", "0.1"],
                                cwd=HERE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=True)
        self.procs.append(proc)
        return proc

    def once(self):
        """A fresh scheduler, one pass: what a restarted cron/drain does first."""
        out = subprocess.run([sys.executable, SCHEDULER, self.sessions, "--once"],
                             cwd=HERE, capture_output=True, text=True, timeout=60,
                             start_new_session=True)
        return out.stdout + out.stderr

    def harness_runs(self):
        try:
            with open(self.log) as fh:
                return [json.loads(line) for line in fh if line.strip()]
        except OSError:
            return []

    def turn(self):
        return S._read_turn(self.session) or {}

    def start_turn_and_kill(self, mode, whole_group):
        self.configure(mode)
        S.post_user_message(self.session, "please deploy to staging")
        proc = self.scheduler()
        # Both: "running" is recorded the moment the child exists, before it has
        # done anything, and a kill landing there would test a different window.
        self.assertTrue(wait_until(lambda: self.turn().get("state") == "running"
                                   and len(self.harness_runs()) == 1, timeout=60),
                        f"the turn never reached a live harness: {self.turn()}")
        if whole_group:
            os.killpg(proc.pid, signal.SIGKILL)
        else:
            os.kill(proc.pid, signal.SIGKILL)
        proc.wait()
        return proc

    # -- fix 1: the lease covers the agent ----------------------------------------------

    def test_a_scheduler_killed_alone_never_lets_a_second_harness_start(self):
        self.start_turn_and_kill("hold-first", whole_group=False)
        child = self.turn()["child"]
        self.assertTrue(S._identity_alive(child), "the harness should have outlived its scheduler")
        for _ in range(3):
            out = self.once()
            self.assertIn("still running", out)
        self.assertEqual(len(self.harness_runs()), 1, "a second harness ran beside the orphan")

        open(os.path.join(self.root, "release"), "w").close()
        self.assertTrue(wait_until(lambda: self.turn().get("state") == "exited", timeout=30),
                        f"the supervisor did not record the orphan's exit: {self.turn()}")
        self.assertTrue(wait_until(lambda: not S._identity_alive(self.turn().get("supervisor")), timeout=30))
        self.once()
        self.once()
        self.assertEqual(len(self.harness_runs()), 1,
                         "a turn that finished on its own was re-woken as if it crashed")
        with open(os.path.join(self.session, S.TURN_FILE + ".last")) as fh:
            last = json.load(fh)
        self.assertEqual((last["state"], last["exit_code"]), ("done", 0))
        box = os.listdir(os.path.join(self.session, S.INBOX_DIR))
        self.assertTrue(box[0].endswith(".json.delivered"), box)

    # -- fix 2: a crashed turn is recovered, not consumed -------------------------------

    def test_a_turn_killed_before_its_transcript_got_the_message_redelivers_it(self):
        self.start_turn_and_kill("hang-first", whole_group=True)
        self.once()
        runs = self.harness_runs()
        self.assertEqual(len(runs), 2, runs)
        self.assertIn("interrupted (crash)", runs[1]["message"])
        self.assertIn("please deploy to staging", runs[1]["message"],
                      "the message the crash swallowed never reached a completed turn")
        self.once()
        self.assertEqual(len(self.harness_runs()), 2, "recovered more than once")

    def test_a_turn_killed_after_its_transcript_got_the_message_does_not_repeat_it(self):
        self.start_turn_and_kill("record-then-hang", whole_group=True)
        self.once()
        runs = self.harness_runs()
        self.assertEqual(len(runs), 2, runs)
        self.assertIn("interrupted (crash)", runs[1]["message"])
        self.assertNotIn("please deploy to staging", runs[1]["message"],
                         "re-injected a message the resumed transcript already holds")
        box = os.listdir(os.path.join(self.session, S.INBOX_DIR))
        self.assertTrue(box[0].endswith(".json.delivered"), box)

    def test_a_turn_that_always_takes_its_scheduler_down_is_abandoned(self):
        self.configure("kill-everything")
        S.post_user_message(self.session, "this turn crashes")
        for _ in range(S.MAX_CRASH_RECOVERIES + 3):
            self.once()
        runs = self.harness_runs()
        self.assertEqual(len(runs), 1 + S.MAX_CRASH_RECOVERIES,
                         "the crash loop was not bounded")
        self.assertTrue(all("this turn crashes" in r["message"] for r in runs),
                        "a message no transcript received must ride every retry")
        self.assertTrue(os.path.exists(os.path.join(self.session, S.TURN_FILE + ".abandoned")))
        self.assertFalse(os.path.exists(os.path.join(self.session, S.TURN_FILE)))
        box = os.listdir(os.path.join(self.session, S.INBOX_DIR))
        self.assertTrue(box[0].endswith(".json.undelivered"), box)


if __name__ == "__main__":
    unittest.main()
