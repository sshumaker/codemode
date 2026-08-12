"""
Tests for how the model is told these primitives exist.

Three channels, and each has a property worth pinning:

  PROMPT     resident, so it is re-billed on every turn of every task. It must stay
             short, and it must not state a threshold.
  help()     free until called, so it carries the detail.
  errors     free and perfectly timed; asserted in test_prelude.py.

The drift tests matter most. Guidance that names a function which no longer exists is
worse than no guidance: the agent follows it, gets an AttributeError, and has no way
to tell whether it misread the docs or the docs are wrong.
"""

import re
import unittest

import jobs as J


def flat(text):
    """
    Collapse whitespace before matching.

    These are hard-wrapped prose blocks, so a literal substring assertion breaks the
    moment a phrase straddles a line end — which says nothing about the content and
    everything about the column width. Normalising is the fix; loosening the phrase
    until it passes would hollow out the test.
    """
    return " ".join(text.split())


class TestPromptIsCheap(unittest.TestCase):
    def test_prompt_is_bounded_but_not_starved(self):
        # The budget was first set at 200 tokens on the theory that resident text is
        # expensive. Priced properly it is not: the system prompt is cache-read after
        # the first turn (weight 0.1), so a 400-token block over 15 turns is ~1,060
        # weighted tokens — $0.005, about 1.4% of a task. One cell blocked because the
        # agent never learned `submit` costs an interrupt, the cell's work and a turn,
        # which is worth far more. So the ceiling is a guard against essays, not an
        # argument for terseness.
        approx_tokens = len(J.PROMPT) / 4
        self.assertLess(approx_tokens, 600, f"PROMPT is ~{approx_tokens:.0f} tokens; that is an essay")
        self.assertGreater(approx_tokens, 150, "PROMPT is too thin to convey the idioms")

    def test_prompt_names_the_three_verbs_a_task_actually_needs(self):
        for verb in ("jobs.submit", "jobs.wait", "jobs.get"):
            self.assertIn(verb, J.PROMPT)

    def test_prompt_points_at_the_detailed_help(self):
        # The whole design: the pointer is resident, the detail is not.
        self.assertIn("jobs.help()", J.PROMPT)
        self.assertIn("api/jobs.md", J.PROMPT)

    def test_prompt_carries_the_facts_inline_rather_than_pointing_at_help(self):
        # help() was called ZERO times across 135 recorded runs, despite an earlier
        # prompt that named its contents and gave an explicit trigger ("before your
        # first submit"). Adding a table of contents did not fix that, so the few
        # accessors the agent actually reaches for moved inline instead.
        #
        # Measured usage across those runs: wait 109, submit 93, get 86,
        # max_runtime 59, expect 58, .ok 41, .done 40, .output 26 — against
        # list/kill/help/.reason at zero.
        flatp = flat(J.PROMPT)
        for used in (".done", ".ok", ".output"):
            self.assertIn(used, flatp, f"{used} is used in real runs and must be inline")

    def test_prompt_does_not_sell_help_as_a_step_to_take(self):
        # It is still mentioned, for humans and for the api/ listing — but it is one
        # trailing clause, not an instruction with a trigger.
        flatp = flat(J.PROMPT)
        self.assertIn("jobs.help()", flatp)
        self.assertNotIn("before your first submit", flatp)

    def test_help_still_documents_everything_for_a_human_reader(self):
        # Demoted in the prompt, not deleted: it is what api/jobs.md is generated from.
        h = flat(J.help())
        for topic in ("jobs.list()", "jobs.kill(", ".exit_code", ".reason", "manifest"):
            self.assertIn(topic.rstrip("("), h, f"help() should still cover {topic}")

    def test_prompt_states_no_threshold(self):
        # An earlier prelude advertised "do not sleep more than 30s". A run then
        # clamped every sleep to exactly 30s, never tripped the guard, never
        # discovered jobs.wait, and dropped 6/6 -> 3/6. The error teaches the
        # primitive; an advisory teaches the number. So: no bare seconds figure
        # describing a limit.
        limits = re.findall(r"\b(\d+)\s*(?:s\b|sec|second)", J.PROMPT)
        self.assertEqual(limits, [], f"PROMPT states a threshold ({limits}); it must not")

    def test_prompt_says_why_the_in_process_forms_do_not_work(self):
        # submit's only other error channel is the cell-timeout interrupt, so the
        # prompt has to carry the reason rather than assume the agent finds out.
        self.assertIn("hold the kernel", flat(J.PROMPT))
        self.assertIn("neither survives it", flat(J.PROMPT))
        # The shell route was the last uncovered one, and an agent found it.
        self.assertIn("%%bash", flat(J.PROMPT))

    def test_prompt_carries_the_idioms_most_likely_to_be_got_wrong(self):
        # Each of these costs real turns when missed, which is what buys their place
        # in resident text: polling in two cells doubles the turns; a condition that
        # can never fire burns its whole max_runtime; and the obvious wrong guess
        # after a restart is that variables come back.
        self.assertIn("ONE cell", flat(J.PROMPT))
        self.assertIn("expect=", flat(J.PROMPT))
        self.assertIn("nothing to restore", flat(J.PROMPT))

    def test_prompt_marks_wait_as_the_last_statement(self):
        # wait() returns immediately; anything after it in the cell runs before the
        # host sleeps, which silently defeats the point.
        self.assertRegex(flat(J.PROMPT), r"(?i)last statement of the cell")


class TestHelpCarriesTheDetail(unittest.TestCase):
    def setUp(self):
        self.text = J.help()

    def test_help_returns_what_it_prints(self):
        # So it can be asserted on, and so an agent can capture it.
        self.assertIsInstance(self.text, str)
        self.assertGreater(len(self.text), len(J.PROMPT))

    def test_documents_the_whole_surface(self):
        for name in ("submit", "wait", "get", "list", "manifest", "kill"):
            self.assertIn(name, self.text)

    def test_shows_the_polling_idiom_as_one_cell(self):
        # Check first, then wait, in ONE cell. Getting this wrong doubles the turns.
        self.assertIn("check first, then wait", flat(self.text).lower())

    def test_explains_expect_and_prefers_exit_status(self):
        self.assertIn('expect="once"', self.text)
        self.assertIn('expect="stream"', self.text)
        self.assertIn("exit status", flat(self.text))

    def test_covers_recovery_after_a_kernel_restart(self):
        self.assertIn("kernel restart", flat(self.text).lower())
        self.assertIn("jobs.get", self.text)
        # And is explicit that there is nothing to restore, since the obvious wrong
        # guess is that variables come back.
        self.assertIn("nothing to restore", flat(self.text).lower())

    def test_states_the_deliberate_refusals(self):
        self.assertIn("never a function", flat(self.text))
        self.assertIn("not awaitable", flat(self.text))

    def test_explains_the_never_fired_reason(self):
        # The distinction between a wrong condition and a slow one is the single most
        # useful thing the runtime can tell an agent, so it must be documented.
        self.assertIn("never fired", self.text)


class TestGuidanceDoesNotDrift(unittest.TestCase):
    """
    Guidance naming a function that does not exist is worse than none: the agent
    follows it, fails, and cannot tell whether it misread the docs or the docs lied.
    """

    def named_calls(self, text):
        return set(re.findall(r"jobs\.([a-z_]+)\(", text))

    def test_every_function_the_prompt_names_exists(self):
        for name in self.named_calls(J.PROMPT):
            self.assertTrue(hasattr(J, name), f"PROMPT names jobs.{name}() which does not exist")

    def test_every_function_help_names_exists(self):
        for name in self.named_calls(J.help()):
            self.assertTrue(hasattr(J, name), f"help() names jobs.{name}() which does not exist")

    def test_the_removed_rehydration_api_is_not_advertised_anywhere(self):
        # It was built, documented, then deleted. This is the specific regression the
        # drift tests exist to catch.
        for blob, label in ((J.PROMPT, "PROMPT"), (J.help(), "help()"), (J.__doc__, "module docstring")):
            self.assertNotIn("rehydrate", blob, f"{label} still advertises the removed rehydrate()")

    @staticmethod
    def examples(text, pattern):
        """
        Real examples only.

        A reference like `-> jobs.submit(...)` in the guard table is prose naming the
        replacement, not code to paste; scanning it as an example failed both checks
        below the moment the table was added. An ellipsis is the marker that
        distinguishes the two.
        """
        return [c for c in re.findall(pattern, text) if "..." not in c]

    def test_prompt_examples_use_the_required_name_argument(self):
        # name= is mandatory. An example omitting it would teach a call that raises.
        for call in self.examples(J.PROMPT + J.help(), r"jobs\.submit\([^)]*\)"):
            self.assertIn("name=", call, f"example omits the required name=: {call}")

    def test_help_examples_are_syntactically_valid_python(self):
        # Cheap protection against an example that cannot be pasted into a cell.
        for call in self.examples(J.help(), r"jobs\.(?:submit|wait|get|kill)\([^)]*\)"):
            compile(call, "<help>", "eval")

    def test_the_example_filter_is_not_vacuous(self):
        # If `examples` ever filtered everything out, the two checks above would pass
        # while testing nothing.
        found = self.examples(J.help(), r"jobs\.(?:submit|wait|get|kill)\([^)]*\)")
        self.assertGreater(len(found), 3, "no real examples survived the filter")


class TestEmittedArtifacts(unittest.TestCase):
    """
    The CLI harnesses use to generate the prompt block and the api/ listing.

    Generated from the module rather than copied into a harness, so the guidance
    cannot drift from the implementation it describes.
    """

    def run_cli(self, *args):
        import subprocess, sys, os
        return subprocess.run(
            [sys.executable, os.path.join(os.path.dirname(__file__), "jobs.py"), *args],
            capture_output=True, text=True,
        )

    def test_prompt_flag_emits_exactly_the_prompt(self):
        r = self.run_cli("--prompt")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.strip(), J.PROMPT.strip())

    def test_docs_flag_emits_the_help_text_once(self):
        # help() prints as a side effect AND returns; an earlier version interpolated
        # its return value, so --docs emitted the whole thing twice.
        r = self.run_cli("--docs")
        self.assertEqual(r.returncode, 0)
        self.assertEqual(r.stdout.count("submit(command"), 1, "docs emitted twice")
        self.assertTrue(r.stdout.startswith("# jobs"))

    def test_help_prints_and_returns_the_same_text(self):
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            returned = J.help()
        self.assertEqual(buf.getvalue().strip(), returned.strip())

    def test_no_args_is_an_error_not_a_silent_empty_file(self):
        # A harness that mistypes the flag must not write an empty api/ doc and carry
        # on; that is the silent-failure shape this project keeps hitting.
        r = self.run_cli()
        self.assertNotEqual(r.returncode, 0)


class TestPromptIsUsableByTheHarness(unittest.TestCase):
    def test_prompt_is_a_plain_string_with_no_trailing_whitespace(self):
        # It gets concatenated into a system prompt; stray whitespace shows up there.
        self.assertIsInstance(J.PROMPT, str)
        self.assertEqual(J.PROMPT, J.PROMPT.rstrip())
        for line in J.PROMPT.splitlines():
            self.assertEqual(line, line.rstrip(), f"trailing whitespace: {line!r}")

    def test_prompt_has_a_heading_so_it_composes_with_other_sections(self):
        self.assertTrue(J.PROMPT.lstrip().startswith("#"))


if __name__ == "__main__":
    unittest.main()
