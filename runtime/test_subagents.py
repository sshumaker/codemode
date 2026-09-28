"""
Tests for runtime/subagents.py and runtime/subagent_run.py.

Two halves, for the reason test_jobs.py and test_integration.py are two files:

*   **Mocked** — no process, no clock, no model. The store's spawner is injected, so
    what `spawn()` composed is asserted by reading the spec file it wrote. This is
    where the guards, the argv and the definition semantics are pinned.
*   **Real** — a genuine `spawn()` -> job -> launcher -> result loop, with
    `fixtures/fake_agent.py` standing in for the model process. It costs about four
    seconds and no dollars, and it is the half that would have caught a spec the
    launcher cannot read, or a result file nobody writes.

The second half exists because of this project's recurring failure: a check that a
module *locates* is not a check that it *runs*. `spawn` composing a plausible argv
proves nothing about whether a child is collectable.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import jobs as J
import subagents as S

FIXTURE_AGENT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "fixtures", "fake_agent.py")


def wait_until(predicate, timeout=20.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


class FakeWorld:
    """The spawner from test_jobs.py: records instead of forking."""

    def __init__(self, start=1000.0):
        self.t = start
        self.spawned = []
        self.killed = []

    def now(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds

    def probe(self, pid):
        return ("alive", f"start-{pid}")

    def spawn(self, wrapped, log_path, cwd):
        self.spawned.append({"cmd": wrapped, "log": log_path, "cwd": cwd})
        open(log_path, "a").close()
        return 4000 + len(self.spawned)

    def kill(self, pid):
        self.killed.append(pid)


class Base(unittest.TestCase):
    """A store with an injected world, and a spawner with an injected environment."""

    ENV = {
        "HARNESS_SUBAGENT_MODEL": "anthropic/claude-sonnet-5",
        "HARNESS_SUBAGENT_CLI": "",  # filled in setUp with a file that exists
    }

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="subagent-test-")
        self.cli = os.path.join(self.dir, "cli.js")
        open(self.cli, "w").close()
        self.world = FakeWorld()
        self.emitted = []
        self.store = J.JobStore(
            self.dir,
            now=self.world.now,
            spawn=self.world.spawn,
            kill=self.world.kill,
            probe=self.world.probe,
            cwd="/workspace",
            emit=self.emitted.append,
        )
        self.env = dict(self.ENV, HARNESS_SUBAGENT_CLI=self.cli)
        self.spawner = S.Subagents(
            self.store, env=self.env, node="/usr/bin/node", python="/usr/bin/python3",
        )

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def spec(self, name):
        with open(os.path.join(self.dir, f"{name}.d", "spec.json")) as fh:
            return json.load(fh)

    def finish(self, name, code=0):
        with open(os.path.join(self.dir, f"{name}.exit"), "w") as fh:
            fh.write(str(code))


# ---------------------------------------------------------------------------------
# the surface: submit semantics
# ---------------------------------------------------------------------------------

class TestSpawnIsAJob(Base):
    def test_returns_a_handle_immediately_and_records_a_running_job(self):
        job = self.spawner.spawn("summarise docs/DESIGN.md", name="scout")
        self.assertIsInstance(job, J.Job)
        # The whole point: nothing was awaited, and the job is live the moment spawn
        # returns. A blocking implementation could not produce this state.
        self.assertEqual(job.state, "running")
        self.assertEqual(len(self.world.spawned), 1)

    def test_the_job_is_a_subagent_handle_with_the_childs_identity(self):
        self.spawner.spawn("find the auth tests", name="scout", tools=["read", "grep"])
        handle = self.store.get("scout")
        self.assertIsInstance(handle, J.Subagent)
        self.assertEqual(handle.tools, "read,grep")
        self.assertEqual(handle.model, "anthropic/claude-sonnet-5")
        self.assertEqual(handle.prompt, "find the auth tests")

    def test_a_fresh_kernel_recovers_a_subagent_handle_not_a_plain_job(self):
        self.spawner.spawn("go", name="scout")
        fresh = J.JobStore(self.dir, now=self.world.now, spawn=self.world.spawn,
                           probe=self.world.probe, kill=self.world.kill, emit=self.emitted.append)
        self.assertIsInstance(fresh.get("scout"), J.Subagent)

    def test_the_submitted_command_runs_the_launcher_on_a_spec_file(self):
        self.spawner.spawn("go", name="scout")
        cmd = self.world.spawned[0]["cmd"]
        self.assertIn("subagent_run.py", cmd)
        self.assertIn(os.path.join(self.dir, "scout.d", "spec.json"), cmd)
        self.assertIn("/usr/bin/python3", cmd)

    def test_manifest_names_the_child_and_its_task(self):
        self.spawner.spawn("explore the repo and report the 5 relevant files",
                           name="scout")
        line = self.store.manifest()
        self.assertIn("scout", line)
        self.assertIn("subagent: explore the repo", line)

    def test_kill_works_on_a_child_like_any_other_job(self):
        self.spawner.spawn("go", name="scout")
        self.assertEqual(self.spawner.live_children(), ["scout"])
        self.assertTrue(self.store.kill("scout"))
        self.assertEqual(self.store.get("scout").state, "killed")
        self.assertEqual(self.spawner.live_children(), [])


# ---------------------------------------------------------------------------------
# argv composition — what the child is actually run as
# ---------------------------------------------------------------------------------

class TestArgv(Base):
    def test_the_shape_of_a_real_prime_invocation(self):
        self.spawner.spawn("do the thing", name="scout")
        argv = self.spec("scout")["argv"]
        self.assertEqual(argv[0], "/usr/bin/node")
        self.assertEqual(argv[1], self.cli)
        self.assertIn("-p", argv)
        self.assertEqual(argv[argv.index("--mode") + 1], "json")
        self.assertIn("--no-context-files", argv)
        self.assertIn("--no-prompt-templates", argv)
        self.assertIn("--no-extensions", argv)
        # The prompt is the trailing positional, never a flag value, and never
        # anything a shell has parsed.
        self.assertEqual(argv[-1], "do the thing")

    def test_a_multiline_prompt_survives_intact(self):
        prompt = "line one\nline two \\n not a newline\n'quoted' \"both\""
        self.spawner.spawn(prompt, name="scout")
        self.assertEqual(self.spec("scout")["argv"][-1], prompt)

    def test_tools_accept_a_list_or_a_string_and_default_to_ipython(self):
        self.spawner.spawn("a", name="one", tools=["read", "grep", "ls"])
        self.assertEqual(self.spec("one")["tools"], "read,grep,ls")
        self.spawner.spawn("b", name="two", tools="read, write")
        self.assertEqual(self.spec("two")["tools"], "read,write")
        self.spawner.spawn("c", name="three")
        self.assertEqual(self.spec("three")["tools"], "ipython")

    def test_empty_tools_is_refused_rather_than_producing_a_helpless_child(self):
        with self.assertRaises(ValueError):
            self.spawner.spawn("a", name="one", tools=[])

    def test_caps_travel_in_the_spec_not_as_cli_flags(self):
        # --autonomous-max-turns only applies under --autonomous, and there is no
        # --max-cost at all, so both are the launcher's job. A version that passed
        # them as flags would be silently ignored by the CLI.
        self.spawner.spawn("a", name="one", max_turns=7, max_cost=0.25, timeout="10m")
        spec = self.spec("one")
        self.assertEqual(spec["max_turns"], 7)
        self.assertEqual(spec["max_cost"], 0.25)
        self.assertEqual(spec["timeout"], 600)
        self.assertNotIn("--autonomous-max-turns", spec["argv"])
        self.assertNotIn("--max-cost", spec["argv"])

    def test_the_jobs_max_runtime_matches_the_child_timeout(self):
        self.spawner.spawn("a", name="one", timeout="5m")
        self.assertEqual(self.store._read("one")["max_runtime"], 300)

    def test_system_prompt_is_appended_not_replaced(self):
        self.spawner.spawn("a", name="one", system_prompt="Answer in one line.")
        argv = self.spec("one")["argv"]
        self.assertIn("--append-system-prompt", argv)
        self.assertEqual(argv[argv.index("--append-system-prompt") + 1],
                         "Answer in one line.")
        self.assertNotIn("--system-prompt", argv)

    def test_cwd_defaults_to_the_parents_and_can_be_overridden(self):
        self.spawner.spawn("a", name="one")
        self.assertEqual(self.spec("one")["cwd"], "/workspace")
        self.spawner.spawn("b", name="two", cwd="/tmp/elsewhere")
        self.assertEqual(self.spec("two")["cwd"], "/tmp/elsewhere")


# ---------------------------------------------------------------------------------
# the child's environment
# ---------------------------------------------------------------------------------

class TestChildEnvironment(Base):
    def test_the_child_gets_its_own_job_directory(self):
        # Otherwise the child's jobs.submit(name="build") collides with the parent's
        # — the cross-talk _default_job_dir exists to prevent, one level down.
        self.spawner.spawn("a", name="scout")
        env = self.spec("scout")["env"]
        self.assertTrue(env["HARNESS_JOB_DIR"].startswith(
            os.path.join(self.dir, "scout.d")))
        self.assertNotEqual(env["HARNESS_JOB_DIR"], self.store.job_dir)

    def test_the_child_gets_its_own_agent_home(self):
        self.spawner.spawn("a", name="scout")
        env = self.spec("scout")["env"]
        self.assertIn("scout.d", env["PRIME_AGENT_CODING_AGENT_DIR"])

    def test_the_child_is_told_its_depth(self):
        self.spawner.spawn("a", name="scout")
        self.assertEqual(self.spec("scout")["env"][S.DEPTH_VAR], "1")

    def test_a_kernel_with_the_prelude_staged_passes_the_jobs_guidance_down(self):
        ipy = os.path.join(self.dir, "ipython")
        os.makedirs(os.path.join(ipy, "profile_default", "startup"))
        open(os.path.join(ipy, "profile_default", "startup", "00-jobs.py"), "w").close()
        spawner = S.Subagents(self.store, env=dict(self.env, IPYTHONDIR=ipy),
                              node="node", python="python3")
        spawner.spawn("a", name="scout")
        argv = self.spec("scout")["argv"]
        appended = argv[argv.index("--append-system-prompt") + 1]
        self.assertIn("jobs.submit", appended)
        # The child cannot spawn, so it is not told it can.
        self.assertNotIn("spawn(prompt", appended)

    def test_the_boundary_travels_with_the_child(self):
        # Under the broker the child inherits the BROKER's environment, so the
        # sandbox settings and the env scrub that confine the parent's kernel have
        # to travel in the spec or the child's kernel comes up less confined than
        # its parent's — running model-authored code with a boundary nobody chose.
        # Brokered, which is the configuration the boundary vars exist for: the
        # child is started out here by a process whose environment is the loop's,
        # so the confinement has to arrive in the spec or it does not arrive.
        spawner = S.Subagents(
            self.store,
            env=dict(self.env,
                     HARNESS_SUBAGENT_BROKER="1",
                     HARNESS_KERNEL_ENV_ALLOW="PATH,HOME,HARNESS_*",
                     HARNESS_KERNEL_ENV_SCRUB="ANTHROPIC_API_KEY",
                     HARNESS_KERNEL_SANDBOX_SETTINGS="/run/srt.json",
                     HARNESS_KERNEL_SANDBOX_BIN="/run/srt",
                     HARNESS_KERNEL_SANDBOX="off",
                     ANTHROPIC_API_KEY="present-here"),
            node="node", python="python3",
        )
        spawner.spawn("a", name="scout")
        env = self.spec("scout")["env"]
        # The allow-list above all: a child whose kernel inherits the broker's
        # environment unfiltered is a sandbox with the loop's credentials in it.
        self.assertEqual(env["HARNESS_KERNEL_ENV_ALLOW"], "PATH,HOME,HARNESS_*")
        self.assertEqual(env["HARNESS_KERNEL_ENV_SCRUB"], "ANTHROPIC_API_KEY")
        self.assertEqual(env["HARNESS_KERNEL_SANDBOX_SETTINGS"], "/run/srt.json")
        self.assertEqual(env["HARNESS_KERNEL_SANDBOX_BIN"], "/run/srt")
        # The explicit bare-marker travels too: the kernel fails closed, so a
        # parent that said "off" must say it for its children or they refuse.
        self.assertEqual(env["HARNESS_KERNEL_SANDBOX"], "off")
        # And nothing secret rides along: the spec is a file in the job directory,
        # which is inside the sandbox.
        self.assertNotIn("ANTHROPIC_API_KEY", env)
        self.assertNotIn("present-here", json.dumps(self.spec("scout")))

    def test_a_child_without_a_kernel_gets_no_jobs_guidance(self):
        ipy = os.path.join(self.dir, "ipython")
        os.makedirs(os.path.join(ipy, "profile_default", "startup"))
        open(os.path.join(ipy, "profile_default", "startup", "00-jobs.py"), "w").close()
        spawner = S.Subagents(self.store, env=dict(self.env, IPYTHONDIR=ipy),
                              node="node", python="python3")
        spawner.spawn("a", name="scout", tools=["read", "grep"])
        self.assertNotIn("--append-system-prompt", self.spec("scout")["argv"])


# ---------------------------------------------------------------------------------
# guards
# ---------------------------------------------------------------------------------

class TestGuards(Base):
    def test_name_is_required(self):
        with self.assertRaises(TypeError) as ctx:
            self.spawner.spawn("do the thing")
        self.assertIn("name=", str(ctx.exception))

    def test_an_empty_prompt_is_refused(self):
        for bad in ("", "   "):
            with self.assertRaises(TypeError):
                self.spawner.spawn(bad, name="scout")

    def test_a_callable_is_refused_with_the_reason(self):
        # The handoff is serializable in both directions; a closure cannot cross a
        # process boundary, and the error has to say so rather than fail later.
        with self.assertRaises(TypeError) as ctx:
            self.spawner.spawn(lambda: 1, name="scout")
        self.assertIn("separate process", str(ctx.exception))

    def test_a_subagent_cannot_spawn_a_subagent(self):
        child = S.Subagents(self.store, env=dict(self.env, **{S.DEPTH_VAR: "1"}),
                            node="node", python="python3", cli=self.cli)
        with self.assertRaises(J.JobError) as ctx:
            child.spawn("go deeper", name="grandchild")
        self.assertIn("cannot spawn", str(ctx.exception))
        self.assertEqual(self.world.spawned, [])

    def test_the_concurrency_cap_refuses_and_names_the_manifest(self):
        spawner = S.Subagents(self.store, env=self.env, node="node",
                              python="python3", cli=self.cli, max_concurrent=2)
        spawner.spawn("a", name="one")
        spawner.spawn("b", name="two")
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("c", name="three")
        msg = str(ctx.exception)
        self.assertIn("manifest", msg)
        self.assertIn("one", msg)
        self.assertIn("two", msg)

    def test_a_finished_child_frees_a_slot(self):
        spawner = S.Subagents(self.store, env=self.env, node="node",
                              python="python3", cli=self.cli, max_concurrent=1)
        spawner.spawn("a", name="one")
        self.finish("one", 0)
        spawner.spawn("b", name="two")  # must not raise
        self.assertEqual(len(self.world.spawned), 2)

    def test_ordinary_jobs_do_not_count_against_the_subagent_cap(self):
        spawner = S.Subagents(self.store, env=self.env, node="node",
                              python="python3", cli=self.cli, max_concurrent=1)
        self.store.submit("sleep 1", name="build")
        spawner.spawn("a", name="one")  # must not raise
        self.assertEqual(len(spawner.live_children()), 1)

    def test_a_missing_cli_is_a_loud_error_not_a_job_that_exits_127(self):
        spawner = S.Subagents(self.store, env={"HARNESS_SUBAGENT_MODEL": "m",
                                               "HARNESS_SUBAGENT_CLI": "/nope/cli.js"},
                              node="node", python="python3")
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("a", name="one")
        self.assertIn("/nope/cli.js", str(ctx.exception))
        self.assertEqual(self.world.spawned, [])

    def test_an_unset_model_is_refused_rather_than_guessed(self):
        # A silent default would confound every parent/child cost comparison the
        # moment the parent ran on a different model.
        spawner = S.Subagents(self.store, env={"HARNESS_SUBAGENT_CLI": self.cli},
                              node="node", python="python3")
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("a", name="one")
        self.assertIn("HARNESS_SUBAGENT_MODEL", str(ctx.exception))

    def test_model_resolution_order(self):
        env = {"HARNESS_SUBAGENT_CLI": self.cli, "PRIME_MODEL": "p/prime",
               "HARNESS_SUBAGENT_MODEL": "p/subagent"}
        spawner = S.Subagents(self.store, env=env, node="node", python="python3")
        spawner.spawn("a", name="one")
        self.assertEqual(self.spec("one")["model"], "p/subagent")
        spawner.spawn("b", name="two", model="p/explicit")
        self.assertEqual(self.spec("two")["model"], "p/explicit")

        env.pop("HARNESS_SUBAGENT_MODEL")
        spawner.spawn("c", name="three")
        self.assertEqual(self.spec("three")["model"], "p/prime")

    def test_a_duplicate_name_is_refused_by_the_job_layer(self):
        self.spawner.spawn("a", name="scout")
        with self.assertRaises(J.JobError):
            self.spawner.spawn("b", name="scout")


# ---------------------------------------------------------------------------------
# brokered spawn — the child is started harness-side, not from the kernel
# ---------------------------------------------------------------------------------

class TestBrokeredSpawn(Base):
    """
    With `HARNESS_SUBAGENT_BROKER=1` the kernel records a REQUEST and forks
    nothing. The agent-facing surface is unchanged by construction — same handle,
    same name, same collection — so what these pin is the one thing that moved:
    no process is created here, and enough is on disk for somebody else to create
    it (docs/CLOUD-HARNESS-DESIGN.md §3.3).
    """

    def setUp(self):
        super().setUp()
        self.spawner = S.Subagents(
            self.store, env=dict(self.env, HARNESS_SUBAGENT_BROKER="1"),
            node="/usr/bin/node", python="/usr/bin/python3",
        )

    def request(self, name):
        with open(os.path.join(self.dir, "requests", f"{name}.json")) as fh:
            return json.load(fh)

    def test_nothing_is_forked_from_the_kernel(self):
        job = self.spawner.spawn("find the auth tests", name="scout")
        self.assertEqual(self.world.spawned, [], "the kernel started the child itself")
        self.assertEqual(job.state, "requested")
        self.assertFalse(job.done, "a requested job is live, not finished")

    def test_the_request_carries_everything_needed_to_start_it(self):
        self.spawner.spawn("go", name="scout")
        req = self.request("scout")
        # The WRAPPED command, not the bare one: the pid file and the exit marker
        # are what make a job observable from disk, and a broker that launched the
        # raw command would produce a job nothing could refresh.
        self.assertIn("subagent_run.py", req["wrapped"])
        self.assertIn(req["pid_file"], req["wrapped"])
        self.assertIn(req["exit_marker"], req["wrapped"])
        self.assertEqual(req["cwd"], "/workspace")
        self.assertEqual(req["kind"], "subagent")
        self.assertEqual(req["log"], self.store._log_path("scout"))

    def test_a_requested_child_counts_against_the_cap_and_shows_in_the_manifest(self):
        # It has not started, but it is going to, and a cap that only counted
        # started children would let a loop request a hundred of them.
        self.spawner.spawn("a", name="one")
        self.assertEqual(self.spawner.live_children(), ["one"])
        self.assertIn("requested", self.store.manifest())
        self.assertIn("subagent: a", self.store.manifest())

    def test_the_name_is_claimed_the_moment_it_is_requested(self):
        self.spawner.spawn("a", name="scout")
        with self.assertRaises(J.JobError) as ctx:
            self.spawner.spawn("b", name="scout")
        self.assertIn("already requested", str(ctx.exception))

    def test_killing_an_unclaimed_request_cancels_it_and_says_so(self):
        self.spawner.spawn("a", name="scout")
        self.assertTrue(self.store.kill("scout"))
        rec = self.store._read("scout")
        self.assertEqual(rec["state"], "killed")
        self.assertIn("nothing was started", rec["reason"])
        # And the request is gone, so a broker that scans later starts nothing.
        self.assertFalse(os.path.exists(os.path.join(self.dir, "requests", "scout.json")))
        self.assertNotIn("unconfirmed", rec)

    def test_an_unclaimed_request_fails_with_the_missing_component_named(self):
        # The failure this converts: with no broker running, the job sits
        # `requested` for its whole 30-minute timeout and then reports an ordinary
        # deadline — a plausible number rather than an error.
        store = J.JobStore(self.dir, now=self.world.now, spawn=self.world.spawn,
                           kill=self.world.kill, probe=self.world.probe,
                           cwd="/workspace", emit=self.emitted.append, claim_timeout=60)
        spawner = S.Subagents(store, env=dict(self.env, HARNESS_SUBAGENT_BROKER="1"),
                              node="node", python="python3")
        spawner.spawn("a", name="scout")
        self.world.advance(61)
        job = store.get("scout")
        self.assertTrue(job.done)
        self.assertIn("no broker claimed this request", job.reason)
        self.assertIn("subagent_broker.py", job.reason)


class TestCredentialsGuard(Base):
    """
    A kernel whose credentials were taken away cannot start a brain.

    Without this the child is spawned, reaches the provider with no key and dies
    inside its own loop — a weak subagent rather than a harness fault, with every
    check on the parent's side still green.
    """

    SCRUBBED = {"HARNESS_KERNEL_ENV_SCRUB": "ANTHROPIC_API_KEY"}

    def test_a_scrubbed_kernel_refuses_to_spawn_directly(self):
        spawner = S.Subagents(self.store, env=dict(self.env, **self.SCRUBBED),
                              node="node", python="python3")
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("a", name="scout")
        msg = str(ctx.exception)
        self.assertIn("ANTHROPIC_API_KEY", msg)
        self.assertIn("HARNESS_SUBAGENT_BROKER", msg)
        self.assertEqual(self.world.spawned, [], "it spawned anyway")

    def test_the_same_kernel_may_request_one_through_the_broker(self):
        spawner = S.Subagents(
            self.store, env=dict(self.env, HARNESS_SUBAGENT_BROKER="1", **self.SCRUBBED),
            node="node", python="python3")
        self.assertEqual(spawner.spawn("a", name="scout").state, "requested")

    def test_an_unscrubbed_kernel_is_untouched(self):
        # The in-container runners put the whole brain inside the sandbox on
        # purpose and have no harness side to broker from; nothing here may
        # change for them.
        self.spawner.spawn("a", name="scout")
        self.assertEqual(len(self.world.spawned), 1)

    ALLOWED = {"HARNESS_KERNEL_ENV_ALLOW": "PATH,HOME,HARNESS_*"}

    def test_an_allow_list_kernel_refuses_to_spawn_directly(self):
        # The allow-list posture has no list of removed names to check — the
        # environment was built from the allowed ones — so the refusal keys on
        # the posture itself. A kernel constructed this way holds no credential
        # by design, whatever the provider's variable happens to be called.
        spawner = S.Subagents(self.store, env=dict(self.env, **self.ALLOWED),
                              node="node", python="python3")
        with self.assertRaises(J.JobError) as ctx:
            spawner.spawn("a", name="scout")
        msg = str(ctx.exception)
        self.assertIn("allow-list", msg)
        self.assertIn("HARNESS_SUBAGENT_BROKER", msg)
        self.assertEqual(self.world.spawned, [], "it spawned anyway")

    def test_an_allow_list_kernel_may_request_one_through_the_broker(self):
        spawner = S.Subagents(
            self.store, env=dict(self.env, HARNESS_SUBAGENT_BROKER="1", **self.ALLOWED),
            node="node", python="python3")
        self.assertEqual(spawner.spawn("a", name="scout").state, "requested")


# ---------------------------------------------------------------------------------
# definitions
# ---------------------------------------------------------------------------------

class TestAgentDefinition(Base):
    def test_a_definition_is_reusable_across_children(self):
        scout = S.Agent(tools=["read", "grep", "ls"], max_turns=20, max_cost=0.25)
        self.spawner.spawn("find auth", name="a", agent=scout)
        self.spawner.spawn("find billing", name="b", agent=scout)
        for name in ("a", "b"):
            spec = self.spec(name)
            self.assertEqual(spec["tools"], "read,grep,ls")
            self.assertEqual(spec["max_turns"], 20)
            self.assertEqual(spec["max_cost"], 0.25)

    def test_inline_keywords_override_the_definition(self):
        scout = S.Agent(tools=["read"], max_turns=20)
        self.spawner.spawn("x", name="a", agent=scout, max_turns=40)
        self.assertEqual(self.spec("a")["max_turns"], 40)
        self.assertEqual(self.spec("a")["tools"], "read")  # untouched

    def test_a_plain_dict_works_because_that_is_what_gets_typed_first(self):
        self.spawner.spawn("x", name="a", agent={"tools": ["read"], "max_cost": 0.5})
        self.assertEqual(self.spec("a")["tools"], "read")
        self.assertEqual(self.spec("a")["max_cost"], 0.5)

    def test_a_misspelled_field_is_named_rather_than_ignored(self):
        with self.assertRaises(TypeError) as ctx:
            self.spawner.spawn("x", name="a", agent={"tool": ["read"]})
        self.assertIn("tool", str(ctx.exception))

    def test_merge_does_not_mutate_the_definition(self):
        scout = S.Agent(tools=["read"], max_turns=20)
        merged = scout.merge(max_turns=99)
        self.assertEqual(scout.max_turns, 20)
        self.assertEqual(merged.max_turns, 99)


# ---------------------------------------------------------------------------------
# collection — the parent's side of the handoff
# ---------------------------------------------------------------------------------

class TestCollection(Base):
    """A child that has written its files, without any child having run."""

    def write_child_output(self, name, text="the answer", turns=3, cost=0.042):
        with open(os.path.join(self.dir, f"{name}.result.txt"), "w") as fh:
            fh.write(text)
        with open(os.path.join(self.dir, f"{name}.d", "meta.json"), "w") as fh:
            json.dump({"turns": turns, "cost": cost, "toolCalls": 5,
                       "exitCode": 0, "stopped": None}, fh)

    def test_result_and_usage_are_readable_through_the_handle(self):
        self.spawner.spawn("a", name="scout")
        self.write_child_output("scout")
        self.finish("scout", 0)
        s = self.store.get("scout")
        self.assertTrue(s.done)
        self.assertTrue(s.ok)
        self.assertEqual(s.result, "the answer")
        self.assertEqual(s.turns, 3)
        self.assertEqual(s.cost, 0.042)
        self.assertEqual(s.tool_calls, 5)
        self.assertTrue(s.transcript.endswith(os.path.join("scout.d", "stream.jsonl")))

    def test_a_childs_own_files_are_not_mistaken_for_jobs(self):
        # `<name>.meta.json` in the job directory was read back as a job called
        # "<name>.meta" and took the whole manifest down with a KeyError.
        self.spawner.spawn("a", name="scout")
        self.write_child_output("scout")
        self.assertEqual([r["name"] for r in self.store.list()], ["scout"])
        self.assertIn("subagent:", self.store.manifest())

    def test_a_child_that_has_not_answered_yet_reads_as_empty_not_an_error(self):
        self.spawner.spawn("a", name="scout")
        s = self.store.get("scout")
        self.assertEqual(s.result, "")
        self.assertIsNone(s.turns)

    def test_a_capped_child_still_hands_back_what_it_had(self):
        self.spawner.spawn("a", name="scout", max_turns=2)
        self.write_child_output("scout", text="partial finding")
        self.finish("scout", 3)  # subagent_run.EXIT_CAPPED
        s = self.store.get("scout")
        self.assertFalse(s.ok)
        self.assertEqual(s.result, "partial finding")

    def test_collection_works_from_a_fresh_kernel(self):
        self.spawner.spawn("a", name="scout")
        self.write_child_output("scout", text="durable")
        self.finish("scout", 0)
        fresh = J.JobStore(self.dir, now=self.world.now, spawn=self.world.spawn,
                           probe=self.world.probe, kill=self.world.kill, emit=self.emitted.append)
        self.assertEqual(fresh.get("scout").result, "durable")


# ---------------------------------------------------------------------------------
# the launcher's stream parsing, without a process
# ---------------------------------------------------------------------------------

class TestCollector(unittest.TestCase):
    """
    Pins the event shapes. `bench/terminal/test_prime_agent.py` exists because a
    parser written against the wrong vocabulary counted 0 tool calls on a healthy
    run and the validity gate then reported INVALID. Same hazard, same fix.
    """

    def setUp(self):
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import subagent_run

        self.mod = subagent_run
        self.c = subagent_run.Collector()

    def assistant(self, rid, text, cost=0.01):
        return {"type": "message_end", "message": {
            "role": "assistant", "responseId": rid,
            "usage": {"input": 100, "output": 10, "cost": {"total": cost}},
            "content": [{"type": "text", "text": text}]}}

    def test_turns_tools_and_cost_accumulate(self):
        self.assertFalse(self.c.feed({"type": "tool_execution_start",
                                      "toolName": "ipython"}))
        self.assertTrue(self.c.feed(self.assistant("r1", "hello")))
        self.assertTrue(self.c.feed(self.assistant("r2", "the answer")))
        self.assertEqual(self.c.turns, 2)
        self.assertEqual(self.c.tool_calls, 1)
        self.assertAlmostEqual(self.c.cost, 0.02)
        self.assertEqual(self.c.final_text, "the answer")

    def test_a_repeated_response_id_is_not_billed_twice(self):
        self.c.feed(self.assistant("r1", "hello"))
        self.c.feed(self.assistant("r1", "hello"))
        self.assertAlmostEqual(self.c.cost, 0.01)
        # `turns` sits under the SAME dedup guard as cost: it once incremented
        # before the responseId check, so a retried message double-counted the
        # number the max_turns cap enforces off, ending children early
        # (2026-08-15 review, H5). Fed the same message three times, turns is 1.
        self.c.feed(self.assistant("r1", "hello"))
        self.assertEqual(self.c.turns, 1)

    def test_user_and_tool_messages_are_not_turns(self):
        self.assertFalse(self.c.feed({"type": "message_end",
                                      "message": {"role": "user", "content": []}}))
        self.assertFalse(self.c.feed({"type": "message_end",
                                      "message": {"role": "toolResult"}}))
        self.assertEqual(self.c.turns, 0)

    def test_tool_errors_are_counted(self):
        self.c.feed({"type": "tool_execution_end", "isError": True})
        self.assertEqual(self.c.tool_errors, 1)


# ---------------------------------------------------------------------------------
# the real loop: spawn -> job -> launcher -> result
# ---------------------------------------------------------------------------------

class TestRealChild(unittest.TestCase):
    """
    A real subprocess, a real job, a real launcher — with fixtures/fake_agent.py in
    place of the model process. Everything above this line would pass against a
    launcher that never runs.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="subagent-real-")
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        self.spawner = S.Subagents(
            self.store,
            env={"HARNESS_SUBAGENT_MODEL": "fake/model",
                 "HARNESS_SUBAGENT_CLI": FIXTURE_AGENT},
            node=sys.executable,
            python=sys.executable,
        )
        self._saved = {k: os.environ.get(k) for k in
                       ("FAKE_TURNS", "FAKE_HANG", "FAKE_EXIT", "FAKE_DELAY", "FAKE_WRITE")}

    def tearDown(self):
        for rec in self.store._all():
            if rec.get("state") in J.LIVE_STATES:
                try:
                    self.store.kill(rec["name"])
                except Exception:
                    pass
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_the_whole_loop(self):
        os.environ["FAKE_TURNS"] = "2"
        os.environ["FAKE_WRITE"] = os.path.join(self.dir, "received.txt")
        job = self.spawner.spawn("what is in this directory?", name="scout")

        self.assertTrue(wait_until(lambda: job.done), f"child never finished: {job!r}")
        s = self.store.get("scout")
        self.assertTrue(s.ok, f"exit {s.exit_code}: {s.output[-500:]}")

        # 1. the child received the prompt as one argv element, in the right cwd
        with open(os.environ["FAKE_WRITE"]) as fh:
            received = fh.read()
        self.assertIn("what is in this directory?", received)
        self.assertIn(f"cwd={os.path.realpath(self.dir)}", received)

        # 2. the final text is collectable cheaply
        self.assertIn("turn 2", s.result)

        # 3. usage was parsed off the real stream
        self.assertEqual(s.turns, 2)
        self.assertEqual(s.tool_calls, 2)
        self.assertAlmostEqual(s.cost, 0.02, places=4)

        # 4. the evidence is on disk, and it is the full stream
        with open(s.transcript) as fh:
            lines = [l for l in fh if l.strip().startswith("{")]
        self.assertGreaterEqual(len(lines), 6)

        # 5. .output is the readable account: header, per-turn lines, final text
        self.assertIn("[subagent scout]", s.output)
        self.assertIn("[scout turn 1]", s.output)
        self.assertIn("final response", s.output)

    def test_spawn_returns_before_the_child_finishes(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_DELAY"] = "2"
        t0 = time.monotonic()
        job = self.spawner.spawn("slow one", name="slow")
        elapsed = time.monotonic() - t0
        self.assertLess(elapsed, 1.0, "spawn blocked on the child")
        self.assertFalse(job.done)
        self.assertTrue(wait_until(lambda: job.done, timeout=30))

    def test_max_turns_stops_the_child_and_keeps_its_partial_answer(self):
        os.environ["FAKE_TURNS"] = "10"
        os.environ["FAKE_DELAY"] = "0.3"
        os.environ["FAKE_HANG"] = "60"
        job = self.spawner.spawn("go forever", name="capped", max_turns=2)
        self.assertTrue(wait_until(lambda: job.done, timeout=30),
                        "the cap never fired; the child is still running")
        s = self.store.get("capped")
        self.assertFalse(s.ok)
        self.assertEqual(s.turns, 2)
        self.assertIn("turn 2", s.result)
        self.assertIn("max_turns", s.output)

    def test_a_child_that_fails_reports_its_exit_code(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_EXIT"] = "2"
        job = self.spawner.spawn("fail please", name="bad")
        self.assertTrue(wait_until(lambda: job.done))
        self.assertFalse(job.ok)
        self.assertEqual(job.exit_code, 2)
        self.assertIn("turn 1", self.store.get("bad").result)

    def test_killing_a_child_from_the_parent_stops_it(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_HANG"] = "60"
        self.spawner.spawn("hang", name="hung")
        self.assertTrue(wait_until(lambda: self.store.get("hung").output != ""))
        self.assertTrue(self.store.kill("hung"))
        self.assertEqual(self.store.get("hung").state, "killed")


class TestRealBrokeredChild(unittest.TestCase):
    """
    The brokered loop for real: request -> broker -> launcher -> result.

    Same assertions the direct loop makes, because the parent's side is supposed
    to be indistinguishable. The one new claim — that the child runs in the
    BROKER's world rather than the kernel's — is provable offline: a variable that
    exists only in the broker's environment appears in the child's if and only if
    the broker started it.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="subagent-brokered-")
        self.store = J.JobStore(self.dir, cwd=self.dir, emit=lambda m: None)
        self.spawner = S.Subagents(
            self.store,
            env={"HARNESS_SUBAGENT_MODEL": "fake/model",
                 "HARNESS_SUBAGENT_CLI": FIXTURE_AGENT,
                 "HARNESS_SUBAGENT_BROKER": "1"},
            node=sys.executable,
            python=sys.executable,
        )
        self._saved = {k: os.environ.get(k) for k in
                       ("FAKE_TURNS", "FAKE_WRITE", "FAKE_REPORT_ENV", "BROKER_ONLY_SECRET")}
        os.environ.pop("BROKER_ONLY_SECRET", None)

    def tearDown(self):
        for rec in self.store._all():
            if rec.get("state") in J.LIVE_STATES:
                try:
                    self.store.kill(rec["name"])
                except Exception:
                    pass
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.dir, ignore_errors=True)

    def broker(self):
        import subagent_broker

        return subagent_broker.Broker(self.dir, log=lambda m: None)

    def test_the_whole_loop_through_a_broker(self):
        os.environ["FAKE_TURNS"] = "2"
        job = self.spawner.spawn("what is in this directory?", name="scout")
        self.assertEqual(job.state, "requested")

        started = self.broker().scan_once()
        self.assertEqual(started, ["scout"])

        self.assertTrue(wait_until(lambda: job.done), f"child never finished: {job!r}")
        s = self.store.get("scout")
        self.assertTrue(s.ok, f"exit {s.exit_code}: {s.output[-500:]}")
        # Collection is byte-for-byte the direct path's: the parent cannot tell.
        self.assertIn("turn 2", s.result)
        self.assertEqual(s.turns, 2)
        self.assertEqual(s.tool_calls, 2)
        self.assertIn("[subagent scout]", s.output)

    def test_the_record_picks_up_the_pid_the_broker_started(self):
        os.environ["FAKE_TURNS"] = "1"
        os.environ["FAKE_DELAY"] = "1"
        try:
            self.spawner.spawn("slow", name="slow")
            self.broker().scan_once()
            # `requested` -> `running` happens by reading the pid file the job
            # wrote about itself — the same route a job recovered from an
            # interrupted submit takes, so a brokered job is killable and
            # refreshable with no special case anywhere.
            self.assertTrue(wait_until(lambda: self.store.get("slow").state == "running"))
            rec = self.store._read("slow")
            self.assertIsNotNone(rec["pid"])
            self.assertIn("broker", rec["reason"])
        finally:
            os.environ.pop("FAKE_DELAY", None)

    def test_the_child_inherits_the_brokers_environment_not_the_kernels(self):
        # The architectural claim, as an assertion. The broker runs as a REAL
        # separate process holding a variable this process does not have; if the
        # child reports it, the child was started out there.
        received = os.path.join(self.dir, "received.txt")
        self.spawner.spawn("who started me?", name="scout")
        env = {
            "PATH": os.environ.get("PATH", ""),
            "FAKE_TURNS": "1",
            "FAKE_WRITE": received,
            "FAKE_REPORT_ENV": "BROKER_ONLY_SECRET",
            "BROKER_ONLY_SECRET": "from-the-broker",
        }
        module = os.path.join(os.path.dirname(os.path.abspath(__file__)), "subagent_broker.py")
        out = subprocess.run([sys.executable, module, self.dir, "--once"],
                             capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("started scout", out.stdout)

        self.assertTrue(wait_until(lambda: self.store.get("scout").done))
        with open(received) as fh:
            body = fh.read()
        self.assertIn("env:BROKER_ONLY_SECRET=from-the-broker", body)
        self.assertNotIn("BROKER_ONLY_SECRET", os.environ,
                         "the test process had the variable, so this proves nothing")


class TestCli(unittest.TestCase):
    """
    The seam the vanilla arm's `task` tool uses.

    DESIGN §Subagents requires both arms to share ONE implementation so that only
    the invocation surface differs. That is why the tool shells out to these verbs
    instead of composing its own argv — two argv builders would make the two arms
    run different children under one name, which is the thing the fairness rule
    (§"one source, two renderings") exists to prevent.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="subagent-cli-")
        self.cli_js = os.path.join(self.dir, "cli.js")
        open(self.cli_js, "w").close()
        self.env = {
            "HARNESS_JOB_DIR": self.dir,
            "HARNESS_SUBAGENT_MODEL": "fake/model",
            "HARNESS_SUBAGENT_CLI": FIXTURE_AGENT,
            "HARNESS_SUBAGENT_NODE": sys.executable,
            "PATH": os.environ.get("PATH", ""),
            "FAKE_TURNS": "1",
        }

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def run_cli(self, *args, env=None):
        import subprocess

        module = os.path.join(os.path.dirname(os.path.abspath(__file__)), "subagents.py")
        r = subprocess.run([sys.executable, module, *args], capture_output=True,
                           text=True, env=dict(env or self.env))
        return r

    def test_spawn_and_collect_round_trip(self):
        prompt_file = os.path.join(self.dir, "prompt.txt")
        with open(prompt_file, "w") as fh:
            fh.write("find the thing\nover two lines")
        r = self.run_cli("--spawn", "--name", "scout", "--tools", "read,grep",
                         "--prompt-file", prompt_file)
        self.assertEqual(r.returncode, 0, r.stderr)
        started = json.loads(r.stdout)
        self.assertTrue(started["ok"])
        self.assertEqual(started["name"], "scout")

        def collected():
            out = json.loads(self.run_cli("--collect", "--name", "scout").stdout)
            return out if out.get("done") else None

        self.assertTrue(wait_until(lambda: collected() is not None),
                        "the child never completed")
        out = collected()
        self.assertTrue(out["ok"])
        self.assertEqual(out["exitCode"], 0)
        self.assertEqual(out["turns"], 1)
        self.assertIn("find the thing", out["result"])

    def test_a_refusal_comes_back_as_json_not_a_traceback(self):
        # The caller is a tool wrapper that must hand the reason to its model; a
        # traceback on stderr arrives as an opaque non-zero exit.
        r = self.run_cli("--spawn", "--name", "scout", "--prompt-text", "")
        self.assertEqual(r.returncode, 1)
        payload = json.loads(r.stdout)
        self.assertFalse(payload["ok"])
        self.assertIn("prompt", payload["error"])

    def test_collecting_an_unknown_name_is_an_answer_not_a_crash(self):
        r = self.run_cli("--collect", "--name", "nobody")
        self.assertEqual(r.returncode, 1)
        self.assertFalse(json.loads(r.stdout)["ok"])

    def test_the_prompt_flag_still_emits_the_resident_block(self):
        r = self.run_cli("--prompt")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), S.PROMPT.strip())



class TestWaitGuidance(unittest.TestCase):
    """The wake is the taught wait; the blocking gather is for children that finish fast."""

    def test_every_surface_teaches_the_wake_before_the_gather(self):
        for label, text in [("PROMPT", S.PROMPT), ("HELP", S.HELP), ("spawn", S.spawn.__doc__)]:
            wake = text.find("jobs.wait(wake_after=")
            self.assertGreaterEqual(wake, 0, f"{label} does not teach jobs.wait")
            gather = text.find("gather_children(")
            if gather >= 0:
                self.assertLess(wake, gather, f"{label} teaches gather_children first")

    def test_the_gather_is_scoped_to_short_waits(self):
        for label, text in [("HELP", S.HELP), ("spawn", S.spawn.__doc__), ("gather", S.gather_children.__doc__)]:
            self.assertIn("within about a minute", text, label)
            self.assertNotIn("timeout=300)", text, f"{label} still shows a five-minute gather")


if __name__ == "__main__":
    unittest.main()
