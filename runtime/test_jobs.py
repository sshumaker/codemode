"""
Unit tests for runtime/jobs.py — fully mocked: no process is spawned, nothing sleeps.

Run: python3 -m unittest discover -s runtime -p 'test_*.py' -v

The clock, the spawner and the kill are injected, so every lifecycle transition that
would normally depend on wall-clock or on a real child process is driven directly.
That matters here beyond speed: the interesting states of this module are "deadline
elapsed with nothing emitted" and "kernel died and came back", and neither is
reachable in a test that has to wait for them.
"""

import json
import os
import shutil
import tempfile
import unittest

import jobs as J


class FakeWorld:
    """A controllable clock plus a spawner that records instead of forking."""

    def __init__(self, start=1000.0):
        self.t = start
        self.spawned = []
        self.killed = []

    def now(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds

    def spawn(self, wrapped, log_path, cwd):
        self.spawned.append({"cmd": wrapped, "log": log_path, "cwd": cwd})
        # A real job creates its log immediately; emit nothing by default so that
        # "has produced no output" is the default state under test.
        open(log_path, "a").close()
        return 4000 + len(self.spawned)

    def kill(self, pid):
        self.killed.append(pid)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="jobs-test-")
        self.world = FakeWorld()
        self.emitted = []
        self.store = J.JobStore(
            self.dir,
            now=self.world.now,
            spawn=self.world.spawn,
            kill=self.world.kill,
            cwd="/workspace",
            emit=self.emitted.append,
        )

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write_log(self, name, text):
        with open(os.path.join(self.dir, f"{name}.log"), "w") as fh:
            fh.write(text)

    def finish(self, name, code=0):
        """Simulate the job's own exit-marker write."""
        with open(os.path.join(self.dir, f"{name}.exit"), "w") as fh:
            fh.write(str(code))


# ---------------------------------------------------------------------------------
# duration parsing
# ---------------------------------------------------------------------------------

class TestParseDuration(unittest.TestCase):
    def test_accepts_the_forms_the_doc_uses(self):
        self.assertEqual(J.parse_duration(60), 60)
        self.assertEqual(J.parse_duration("60"), 60)
        self.assertEqual(J.parse_duration("90s"), 90)
        self.assertEqual(J.parse_duration("5m"), 300)
        self.assertEqual(J.parse_duration("1h"), 3600)
        self.assertEqual(J.parse_duration("2d"), 172800)

    def test_fractional(self):
        self.assertEqual(J.parse_duration("1.5m"), 90)

    def test_rejects_nonsense_rather_than_silently_returning_zero(self):
        # A duration that parses to 0 would arm a job with an instant deadline, which
        # looks like "the condition never fired" — a wrong answer, not an error.
        for bad in ("", "abc", "5x", "m"):
            with self.assertRaises(ValueError):
                J.parse_duration(bad)

    def test_rejects_negative_and_bool(self):
        with self.assertRaises(ValueError):
            J.parse_duration(-5)
        with self.assertRaises(TypeError):
            J.parse_duration(True)


# ---------------------------------------------------------------------------------
# arming lint — the guard against the silent failure this API is prone to
# ---------------------------------------------------------------------------------

class TestLintOnce(unittest.TestCase):
    def codes(self, cmd, expect="once"):
        return [c for c, _ in J.lint_condition(cmd, expect)]

    def test_recommended_shape_passes(self):
        # The doc's own example: exits on success, bounded by its own condition.
        self.assertEqual(self.codes("until curl -sf localhost:5000/health; do sleep 2; done"), [])

    def test_bounded_command_passes(self):
        self.assertEqual(self.codes("gradle build"), [])
        self.assertEqual(self.codes("python work/fetch.py"), [])

    def test_tail_f_for_a_one_shot_need_is_rejected(self):
        self.assertIn("ONCE_NEVER_EXITS", self.codes('tail -f run.log | grep "Ready"'))

    def test_while_true_is_rejected(self):
        self.assertIn("ONCE_NEVER_EXITS", self.codes("while true; do check; sleep 5; done"))

    def test_grep_m1_does_not_rescue_tail_f(self):
        # Explicit in the design doc: if the stream goes quiet, tail never receives
        # SIGPIPE, so -m1 does not bound it. This is the case most likely to be
        # "fixed" by someone reading the first error, so it gets its own test.
        self.assertIn("ONCE_NEVER_EXITS", self.codes('tail -f run.log | grep -m 1 "Ready"'))

    def test_message_names_the_fix(self):
        problems = J.lint_condition('tail -f run.log | grep "Ready"', "once")
        text = " ".join(m for _, m in problems)
        self.assertIn("until curl", text)
        self.assertIn("SIGPIPE", text)


class TestLintStream(unittest.TestCase):
    def codes(self, cmd):
        return [c for c, _ in J.lint_condition(cmd, "stream")]

    def test_following_source_passes(self):
        self.assertEqual(self.codes("tail -f run.log"), [])

    def test_bounded_command_for_a_watch_is_rejected(self):
        # "exits immediately" — one check, no watch, and it looks like it worked.
        self.assertIn("STREAM_EXITS_IMMEDIATELY", self.codes("curl -sf localhost/health"))

    def test_non_flushing_grep_midpipeline_is_flagged(self):
        self.assertIn("NON_FLUSHING", self.codes('tail -f log | grep "x" | wc -l'))

    def test_line_buffered_grep_is_accepted(self):
        self.assertNotIn("NON_FLUSHING", self.codes('tail -f log | grep --line-buffered "x" | wc -l'))

    def test_awk_without_fflush_is_flagged(self):
        self.assertIn("NON_FLUSHING", self.codes("tail -f log | awk '{print $1}' | wc -l"))

    def test_awk_with_fflush_is_accepted(self):
        self.assertNotIn("NON_FLUSHING", self.codes("tail -f log | awk '{print $1; fflush()}' | wc -l"))

    def test_sed_without_u_is_flagged(self):
        self.assertIn("NON_FLUSHING", self.codes("tail -f log | sed 's/a/b/' | wc -l"))

    def test_head_cannot_flush_at_all(self):
        self.assertIn("CANNOT_FLUSH", self.codes("tail -f log | head -n 5"))

    def test_last_stage_grep_is_not_flagged(self):
        # Nothing downstream is waiting on it, so buffering there is harmless.
        self.assertNotIn("NON_FLUSHING", self.codes('tail -f log | grep "x"'))


class TestLintValidation(unittest.TestCase):
    def test_unknown_expect_is_an_error_not_a_silent_default(self):
        codes = [c for c, _ in J.lint_condition("gradle build", "sometimes")]
        self.assertEqual(codes, ["BAD_EXPECT"])

    def test_lint_is_pure(self):
        # No I/O, so it is safe to call at arm time and cheap to test exhaustively.
        before = os.listdir(".")
        J.lint_condition("tail -f x | head -1", "stream")
        self.assertEqual(before, os.listdir("."))


# ---------------------------------------------------------------------------------
# submit
# ---------------------------------------------------------------------------------

class TestSubmit(Base):
    def test_happy_path_records_and_spawns_once(self):
        job = self.store.submit("gradle build", name="build", max_runtime="1h")
        self.assertEqual(job.name, "build")
        self.assertEqual(job.state, "running")
        self.assertEqual(len(self.world.spawned), 1)
        with open(os.path.join(self.dir, "build.json")) as fh:
            rec = json.load(fh)
        self.assertEqual(rec["max_runtime"], 3600)
        self.assertEqual(rec["expect"], "once")
        self.assertEqual(rec["cmd"], "gradle build")

    def test_name_is_required(self):
        # §5: name is what appears in list(), the manifest and the wake event, and it
        # is how a job survives a kernel restart. An auto-generated one is unusable.
        with self.assertRaises(TypeError) as ctx:
            self.store.submit("gradle build")
        self.assertIn("requires name=", str(ctx.exception))

    def test_blank_name_is_rejected(self):
        with self.assertRaises(TypeError):
            self.store.submit("gradle build", name="   ")

    def test_illegal_name_is_rejected(self):
        with self.assertRaises(ValueError):
            self.store.submit("gradle build", name="../escape")

    def test_callable_payload_is_refused_with_the_fix(self):
        with self.assertRaises(TypeError) as ctx:
            self.store.submit(lambda: 1, name="f")
        self.assertIn("cannot be reconstructed", str(ctx.exception))

    def test_list_payload_is_shell_quoted(self):
        self.store.submit(["echo", "a b"], name="e")
        self.assertIn("'a b'", self.world.spawned[0]["cmd"])

    def test_wraps_in_a_subshell_so_exit_does_not_kill_the_wrapper(self):
        # A command ending in `exit N` inside { } exits the OUTER shell, so the marker
        # was never written and every job reported "running" forever.
        self.store.submit("do_thing; exit 3", name="x")
        cmd = self.world.spawned[0]["cmd"]
        self.assertTrue(cmd.startswith("( "))
        self.assertIn("echo $? >", cmd)

    def test_duplicate_running_name_is_refused(self):
        self.store.submit("sleep 1", name="dup")
        with self.assertRaises(J.JobError):
            self.store.submit("sleep 1", name="dup")

    def test_name_can_be_reused_once_finished(self):
        self.store.submit("sleep 1", name="dup")
        self.finish("dup", 0)
        self.assertTrue(self.store.get("dup").done)
        self.store.submit("sleep 1", name="dup")
        self.assertEqual(len(self.world.spawned), 2)

    def test_resubmit_clears_the_previous_exit_marker(self):
        # Otherwise the new job is born "done" from its predecessor's marker — a
        # plausible-looking result for work that never ran.
        self.store.submit("sleep 1", name="dup")
        self.finish("dup", 0)
        self.store.submit("sleep 1", name="dup")
        self.assertEqual(self.store.get("dup").state, "running")

    def test_lint_failure_blocks_arming_by_default(self):
        with self.assertRaises(J.JobError) as ctx:
            self.store.submit('tail -f run.log | grep "Ready"', name="ready", expect="once")
        self.assertIn("ONCE_NEVER_EXITS", str(ctx.exception))
        self.assertEqual(self.world.spawned, [], "must not spawn a job it just rejected")

    def test_strict_false_arms_anyway_but_warns(self):
        self.store.submit('tail -f run.log | grep "Ready"', name="ready", expect="once", strict=False)
        self.assertEqual(len(self.world.spawned), 1)
        self.assertTrue(any("ONCE_NEVER_EXITS" in m for m in self.emitted))
        with open(os.path.join(self.dir, "ready.json")) as fh:
            rec = json.load(fh)
        self.assertEqual(rec["lint"], ["ONCE_NEVER_EXITS"])


# ---------------------------------------------------------------------------------
# lifecycle: completion, deadline, silence
# ---------------------------------------------------------------------------------

class TestLifecycle(Base):
    def test_completion_is_read_from_the_marker_not_the_pid(self):
        # os.kill(pid, 0) succeeds on zombies, which reported finished jobs as running.
        job = self.store.submit("gradle build", name="build")
        self.assertEqual(job.state, "running")
        self.finish("build", 0)
        self.assertEqual(job.state, "done")
        self.assertTrue(job.ok)
        self.assertEqual(job.exit_code, 0)
        self.assertEqual(job.reason, "completed")

    def test_nonzero_exit_is_done_but_not_ok(self):
        job = self.store.submit("false", name="f")
        self.finish("f", 3)
        self.assertEqual(job.state, "done")
        self.assertFalse(job.ok)
        self.assertEqual(job.exit_code, 3)
        self.assertEqual(job.reason, "exited non-zero")

    def test_unreadable_marker_does_not_wedge_the_job(self):
        job = self.store.submit("x", name="x")
        with open(os.path.join(self.dir, "x.exit"), "w") as fh:
            fh.write("garbage")
        self.assertEqual(job.state, "done")
        self.assertIsNone(job.exit_code)

    def test_deadline_kills_and_says_it_never_fired(self):
        job = self.store.submit("until false; do sleep 1; done", name="ready", max_runtime="60s")
        self.world.advance(61)
        self.assertEqual(job.state, "deadline")
        self.assertEqual(job.reason, "deadline reached, never fired")
        self.assertIn(4001, self.world.killed)

    def test_deadline_distinguishes_fired_from_never_fired(self):
        # The distinction Monitor's silent timeout cannot make, and the one that tells
        # you whether the condition was wrong or merely slow.
        job = self.store.submit("tail -f log", name="w", expect="stream", max_runtime="60s")
        self.write_log("w", "something happened\n")
        self.world.advance(61)
        self.assertEqual(job.reason, "deadline reached, condition fired")

    def test_silence_is_flagged_before_the_deadline(self):
        job = self.store.submit("until false; do sleep 1; done", name="ready", max_runtime="100s")
        self.world.advance(30)
        self.assertFalse(self.store.list()[0]["silent"])
        self.world.advance(20)  # 50s of 100s, past the 0.4 fraction
        self.assertTrue(self.store.list()[0]["silent"])
        self.assertIn("never fired", repr(job))

    def test_output_suppresses_the_silence_flag(self):
        self.store.submit("until false; do sleep 1; done", name="ready", max_runtime="100s")
        self.write_log("ready", "progress\n")
        self.world.advance(50)
        self.assertFalse(self.store.list()[0]["silent"])

    def test_no_deadline_means_no_silence_flag(self):
        # Without max_runtime there is no fraction to be late against.
        self.store.submit("until false; do sleep 1; done", name="ready")
        self.world.advance(100000)
        self.assertFalse(self.store.list()[0]["silent"])

    def test_kill_marks_and_reports(self):
        job = self.store.submit("sleep 100", name="s")
        self.assertTrue(self.store.kill("s"))
        self.assertEqual(job.state, "killed")
        self.assertEqual(job.reason, "killed by agent")
        self.assertFalse(self.store.kill("s"), "killing a dead job is a no-op, not an error")

    def test_output_is_readable_while_running(self):
        job = self.store.submit("x", name="x")
        self.write_log("x", "partial")
        self.assertEqual(job.output, "partial")


# ---------------------------------------------------------------------------------
# wait
# ---------------------------------------------------------------------------------

class TestWait(Base):
    def waiting(self, **kw):
        """wait() ends the cell by raising; capture that and return the signal."""
        with self.assertRaises(J.WaitSignal) as ctx:
            self.store.wait(**kw)
        return ctx.exception

    def test_emits_the_sentinel_and_does_not_block(self):
        # The entire point: the cell ends, the host sleeps, the kernel is released.
        t_before = self.world.t
        self.waiting(wake_after=120)
        self.assertEqual(self.world.t, t_before, "wait must not consume time in-kernel")
        self.assertIn(f"{J.WAIT_SENTINEL}:120", self.emitted)

    def test_ends_the_cell_so_trailing_code_cannot_run(self):
        # The invariant is established, not checked: statements after wait() are
        # unreachable because the cell is over, not because something inspected it.
        ran = []
        def cell():
            self.store.wait(wake_after=120)
            ran.append("trailing")  # unreachable
        with self.assertRaises(J.WaitSignal):
            cell()
        self.assertEqual(ran, [], "code after wait() must not run")

    def test_signal_is_not_swallowed_by_a_broad_except(self):
        # BaseException, so `except Exception:` around the agent's own code cannot
        # catch it and silently resurrect the trailing-code bug.
        self.assertTrue(issubclass(J.WaitSignal, BaseException))
        self.assertFalse(issubclass(J.WaitSignal, Exception))
        caught = None
        try:
            try:
                self.store.wait(wake_after=120)
            except Exception as exc:
                caught = exc
        except J.WaitSignal:
            pass
        self.assertIsNone(caught, "a broad except must not swallow the wait signal")

    def test_signal_carries_the_duration(self):
        # The prelude's handler prints it, so it has to be there.
        self.assertEqual(self.waiting(wake_after=120).args[0], 120)

    def test_requires_a_duration(self):
        with self.assertRaises(TypeError) as ctx:
            self.store.wait()
        self.assertIn("wake_after", str(ctx.exception))

    def test_clamps_to_the_ceiling(self):
        self.waiting(wake_after="10h")
        self.assertIn(f"{J.WAIT_SENTINEL}:{J.MAX_WAIT}", self.emitted)

    def test_clamps_up_to_the_floor(self):
        # A 2s wait costs a whole turn to save nothing; §9 puts pacing in submit.
        self.waiting(wake_after=2)
        self.assertIn(f"{J.WAIT_SENTINEL}:{J.MIN_WAIT}", self.emitted)
        self.assertTrue(any("clamped" in m for m in self.emitted))

    def test_lists_running_jobs_and_marks_silent_ones(self):
        self.store.submit("until false; do sleep 1; done", name="ready", max_runtime="100s")
        self.world.advance(50)
        self.waiting(wake_after=60)
        line = [m for m in self.emitted if m.startswith("[waiting")][0]
        self.assertIn("ready", line)
        self.assertIn("never fired", line)

    def test_reports_none_when_nothing_is_running(self):
        self.waiting(wake_after=60)
        self.assertIn("none", [m for m in self.emitted if m.startswith("[waiting")][0])


# ---------------------------------------------------------------------------------
# surviving a kernel restart — via jobs.get(), not via rebound variables
# ---------------------------------------------------------------------------------

class TestKernelRestart(Base):
    def fresh_store(self):
        """A new store over the same directory IS a new kernel: files, no memory."""
        return J.JobStore(self.dir, now=self.world.now, spawn=self.world.spawn,
                          kill=self.world.kill, emit=self.emitted.append)

    def test_get_recovers_a_job_in_a_brand_new_store(self):
        self.store.submit("gradle build", name="build")
        self.write_log("build", "compiling\n")
        job = self.fresh_store().get("build")
        self.assertIsNotNone(job)
        self.assertEqual(job.state, "running")
        self.assertEqual(job.output, "compiling\n")

    def test_no_namespace_injection_is_offered_at_all(self):
        # Auto-binding creates shadowing, aliasing and burial problems that a lookup
        # simply does not have. The absence is the design.
        self.assertFalse(hasattr(J, "rehydrate"))
        self.assertFalse(hasattr(J, "check_bindings"))
        self.assertFalse(hasattr(self.store, "rehydrate"))

    def test_names_need_not_be_python_identifiers(self):
        # A direct benefit of dropping auto-binding: a name is a key, not a variable,
        # so it only has to be a legal filename.
        self.store.submit("x", name="my.job-1")
        self.assertEqual(self.store.get("my.job-1").state, "running")
        self.assertIn("my.job-1", self.store.manifest())

    def test_get_returns_the_same_handle_each_time(self):
        job = self.store.submit("x", name="x")
        self.assertIs(job, self.store.get("x"))
        self.assertIs(self.store.get("x"), self.store.get("x"))

    def test_missing_job_is_None_not_an_exception(self):
        self.assertIsNone(self.store.get("never-existed"))

    def test_dead_job_comes_back_as_a_tombstone_that_explains_itself(self):
        # Not None: touching None raises AttributeError three lines later and reveals
        # nothing. The tombstone explains itself at the point of use.
        self.store.submit("gradle build", name="build")
        self.store.prune("build", "container was recycled")
        job = self.fresh_store().get("build")
        self.assertIsInstance(job, J.Tombstone)
        self.assertTrue(job.done)
        self.assertFalse(job.ok)
        with self.assertRaises(J.JobError) as ctx:
            _ = job.output
        self.assertIn("container was recycled", str(ctx.exception))

    def test_manifest_is_how_a_fresh_kernel_learns_what_exists(self):
        self.store.submit("gradle build", name="build")
        self.store.submit("pytest", name="tests")
        text = self.fresh_store().manifest()
        self.assertIn("build", text)
        self.assertIn("tests", text)


# ---------------------------------------------------------------------------------
# handle semantics
# ---------------------------------------------------------------------------------

class TestHandleSemantics(Base):
    def test_job_is_not_awaitable(self):
        # §4: the risk is bulk. `await asyncio.gather(*[submit(c) for c in calls])` is
        # the shape to prevent, and awaitability is what would allow it.
        job = self.store.submit("x", name="x")
        with self.assertRaises(TypeError) as ctx:
            job.__await__()
        self.assertIn("not awaitable", str(ctx.exception))
        self.assertIn("jobs.wait", str(ctx.exception))

    def test_missing_job_reads_as_missing_rather_than_raising(self):
        self.assertIsNone(self.store.get("nope"))

    def test_equality_and_hash_are_by_name(self):
        job = self.store.submit("x", name="x")
        self.assertEqual(job, J.Job("x", self.store))
        self.assertEqual(len({job, J.Job("x", self.store)}), 1)


# ---------------------------------------------------------------------------------
# manifest (§8)
# ---------------------------------------------------------------------------------

class TestManifest(Base):
    def test_empty_is_informative_not_bare(self):
        # Was assertEqual(..., "no jobs"). That bare string cost an entire adoption on
        # a real task — see TestEmptyStatesAreInformative.
        self.assertIn("no jobs yet", self.store.manifest())

    def test_shows_progress_against_the_deadline(self):
        self.store.submit("until false; do sleep 1; done", name="ready", max_runtime="600s")
        self.world.advance(240)
        line = self.store.manifest()
        self.assertIn("ready", line)
        self.assertIn("240s of 600s", line)
        self.assertIn("never fired", line)

    def test_shows_bytes_emitted(self):
        self.store.submit("tail -f log", name="w", expect="stream")
        self.write_log("w", "hello\n")
        self.assertIn("6 bytes", self.store.manifest())


# ---------------------------------------------------------------------------------
# module-level surface
# ---------------------------------------------------------------------------------

class TestModuleSurface(Base):
    def setUp(self):
        super().setUp()
        J.use_store(self.store)

    def tearDown(self):
        J._default = None
        super().tearDown()

    def test_module_functions_delegate_to_the_store(self):
        J.submit("gradle build", name="build")
        self.assertEqual(len(self.world.spawned), 1)
        self.assertEqual(J.get("build").state, "running")
        self.assertEqual(len(J.list()), 1)
        with self.assertRaises(J.WaitSignal):
            J.wait(wake_after=60)
        self.assertTrue(any(J.WAIT_SENTINEL in m for m in self.emitted))
        self.assertTrue(J.kill("build"))

    def test_surface_is_exactly_what_the_doc_promises(self):
        # Guards against the surface quietly growing. The doc says one namespace and a
        # small set of verbs; anything added here should be a deliberate decision.
        expected = {
            # the verbs an agent uses
            "submit", "wait", "get", "list", "kill", "manifest", "help",
            # operational / harness-facing
            "prune", "use_store", "parse_duration", "lint_condition", "blocking_sleep",
        }
        public = {
            n for n in dir(J)
            if not n.startswith("_") and callable(getattr(J, n)) and getattr(J, n).__module__ == J.__name__
        }
        public -= {"Job", "Tombstone", "JobStore", "JobError", "WaitSignal"}
        self.assertEqual(public, expected)


if __name__ == "__main__":
    unittest.main()


# ---------------------------------------------------------------------------------
# blocking waits inside shell scripts — the %%bash route
# ---------------------------------------------------------------------------------

class TestBlockingSleep(unittest.TestCase):
    """
    `%%bash` + `sleep 40` holds the kernel exactly as `time.sleep(40)` does, and no
    Python guard can see it. Measured: an agent with no resident guidance blocked the
    kernel twice this way and still produced the right answer.

    The distinction that matters is foreground vs background — starting work in the
    background is legitimate, waiting for it in the foreground is not.
    """

    def blocked(self, script, ceiling=30):
        return J.blocking_sleep(script, ceiling) is not None

    def test_foreground_sleep_over_the_ceiling_blocks(self):
        self.assertTrue(self.blocked("sleep 40"))
        self.assertTrue(self.blocked("sleep 40 && echo done"))
        self.assertTrue(self.blocked("sleep 10; sleep 10; sleep 20"), "sleeps accumulate")

    def test_short_sleep_is_fine(self):
        # A 2s settle after a POST is ordinary code, not waiting.
        self.assertFalse(self.blocked("sleep 5"))
        self.assertFalse(self.blocked("sleep 0.5"))

    def test_backgrounded_work_is_allowed(self):
        # Starting work in the background is the legitimate half.
        self.assertFalse(self.blocked("sleep 40 &"))
        self.assertFalse(self.blocked("nohup bash -c 'sleep 75' &"))

    def test_backgrounded_subshell_is_allowed(self):
        # The first implementation split on separators without tracking parens, so the
        # `&` attached to the closing paren and the inner sleep read as foreground —
        # rejecting the exact shape an agent uses to start a background process.
        self.assertFalse(self.blocked("(sleep 40; touch f) &"))
        self.assertTrue(self.blocked("(sleep 40; touch f)"), "same subshell, not backgrounded")

    def test_polling_loops_block_regardless_of_duration(self):
        # `until ...; do sleep 2; done` blocks for an unbounded time; each individual
        # sleep is under the ceiling, so only the loop structure reveals it.
        self.assertTrue(self.blocked("until [ -f x ]; do sleep 2; done"))
        self.assertTrue(self.blocked("while true; do sleep 1; done"))
        self.assertTrue(self.blocked("for i in 1 2 3; do echo $i; sleep 8; done"))

    def test_quoted_text_is_not_structure(self):
        # This is why shlex is used rather than a regex over the raw source.
        self.assertFalse(self.blocked('echo "sleep 40"'))
        self.assertFalse(self.blocked("echo 'until x; do sleep 2; done'"))

    def test_ordinary_commands_pass(self):
        for cmd in ("ls -la", "echo hello", "python work/fetch.py", "git status"):
            self.assertFalse(self.blocked(cmd), cmd)

    def test_unbalanced_quotes_decline_to_judge(self):
        # The shell will fail on it anyway; guessing would only add a wrong error.
        self.assertFalse(self.blocked('echo "unterminated'))

    def test_the_ceiling_itself_is_blocked_not_allowed(self):
        # Measured: with no guidance an agent wrote `%%bash ... sleep 30` against a
        # ceiling of 30 and slipped through, twice. Models reach for round numbers,
        # and the round number nearest a limit is the limit.
        self.assertTrue(self.blocked("sleep 30", ceiling=30))
        self.assertFalse(self.blocked("sleep 29", ceiling=30))

    def test_ceiling_is_honoured(self):
        self.assertFalse(self.blocked("sleep 40", ceiling=60))
        self.assertTrue(self.blocked("sleep 40", ceiling=10))

    def test_reason_names_what_was_seen(self):
        self.assertIn("polling loop", J.blocking_sleep("until false; do sleep 2; done", 30))
        self.assertIn("40s", J.blocking_sleep("sleep 40", 30))


class TestJobDirIsSessionScoped(unittest.TestCase):
    """
    The job directory is the one piece of durable state here, so it is the one thing
    that can leak between agents.

    The kernel is a separate OS process per session, so the guards and the namespace
    cannot cross. This directory could: the old default was a machine-global
    /tmp/jobs, which would have shown one agent another's jobs in list(), manifest()
    and the startup announcement, and collided on names — `submit(name="build")`
    refused because a *different* agent had a job called build.

    It cannot be keyed to the process either: surviving a kernel restart is the point.
    """

    def resolve(self, env, warn=None):
        # The function takes its environment, so this needs no reload and no mutation
        # of os.environ — reloading the module mid-suite left other tests looking at a
        # different module object, which is a fixture creating its own bugs.
        return J._default_job_dir(env, warn=warn or (lambda m: None))

    def test_explicit_setting_wins(self):
        self.assertEqual(self.resolve({"HARNESS_JOB_DIR": "/x/y"}), "/x/y")

    def test_agent_directory_scopes_it_per_run(self):
        self.assertEqual(self.resolve({"PRIME_AGENT_CODING_AGENT_DIR": "/run/a1"}), "/run/a1/jobs")

    def test_session_id_scopes_it(self):
        self.assertEqual(self.resolve({"HARNESS_SESSION_ID": "s42"}), "/tmp/jobs-s42")

    def test_two_sessions_never_share(self):
        a = self.resolve({"PRIME_AGENT_CODING_AGENT_DIR": "/run/a1"})
        b = self.resolve({"PRIME_AGENT_CODING_AGENT_DIR": "/run/b2"})
        self.assertNotEqual(a, b)

    def test_unidentified_session_gets_a_private_dir_not_a_shared_one(self):
        # Falling back to a shared path is the exact failure this prevents, and it
        # would stay invisible until two agents disagreed about a job.
        said = []
        d = self.resolve({}, warn=said.append)
        self.assertNotEqual(d, "/tmp/jobs")
        self.assertIn(str(os.getpid()), d)
        self.assertTrue(said and "does NOT survive" in said[0], "silent fallback")

    def test_the_warning_never_reaches_stdout(self):
        # jobs.py --docs writes api/jobs.md from stdout; a warning there would be
        # embedded in the generated documentation the agent later reads.
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            J._default_job_dir({})
        self.assertEqual(buf.getvalue(), "")




class TestEmptyStatesAreInformative(Base):
    """
    An empty state is the agent's likely first contact with the API, which makes it
    the worst place to say nothing.

    Measured on a real TAC task: the agent probed once with `jobs.manifest()`, got
    "no jobs" (rendered as an empty cell result), never touched the API again, and
    spent the next 87 turns polling with cells that were literally `print(38)`. One
    uninformative reply cost the whole adoption.
    """

    def test_empty_manifest_teaches_the_next_step(self):
        text = self.store.manifest()
        self.assertIn("jobs.submit", text)
        self.assertIn("jobs.wait", text)
        self.assertIn("jobs.help()", text)

    def test_empty_manifest_is_not_bare(self):
        # "no jobs" is 7 characters and IPython renders it as an almost-empty cell.
        self.assertGreater(len(self.store.manifest()), 60)

    def test_populated_manifest_still_lists_jobs_not_advice(self):
        self.store.submit("echo hi", name="one")
        text = self.store.manifest()
        self.assertIn("one", text)
        self.assertNotIn("pick-a-name", text, "advice must not crowd out the listing")
