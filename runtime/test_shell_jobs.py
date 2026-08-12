"""
Tests for the shell-job-control sketch.

The claim under test is narrow and mechanical: can we recognise backgrounding in a
bash cell, reliably enough to adopt it, without a bash parser?

Getting this wrong is worse than not doing it. A false positive rewrites a command
the user did not background — corrupting a working cell. A false negative silently
leaves an untracked process, which is the exact failure the design exists to remove.
So the tests are weighted toward the ways shell text can look like backgrounding and
is not: `&&`, a quoted ampersand, a redirect `2>&1`, a heredoc body.
"""

import unittest

import shell_jobs as S


class TestFindBackground(unittest.TestCase):
    def test_simple_background(self):
        self.assertEqual(S.find_background_commands("sleep 30 &"), ["sleep 30"])

    def test_and_and_is_not_backgrounding(self):
        # The single most common way to get this wrong.
        self.assertEqual(S.find_background_commands("make && ./run"), [])

    def test_redirect_is_not_backgrounding(self):
        # `2>&1` contains an ampersand and backgrounds nothing.
        self.assertEqual(S.find_background_commands("./run > out.txt 2>&1"), [])

    def test_quoted_ampersand_is_not_backgrounding(self):
        self.assertEqual(S.find_background_commands('echo "a & b"'), [])

    def test_two_background_commands(self):
        found = S.find_background_commands("alpha & beta &")
        self.assertEqual(len(found), 2)

    def test_pipeline_is_backgrounded_as_a_unit(self):
        # A pipeline is one job, exactly as the shell treats it.
        self.assertEqual(S.find_background_commands("zcat f.gz | grep E &"), ["zcat f.gz | grep E"])

    def test_unparseable_declines_rather_than_guesses(self):
        self.assertEqual(S.find_background_commands('echo "unterminated'), [])


class TestRewrite(unittest.TestCase):
    def rewrite(self, src):
        return S.rewrite_background(src)

    def test_background_line_is_wrapped_and_named(self):
        out, adopted = self.rewrite("sleep 30 &")
        self.assertEqual(adopted, [("bg1", "sleep 30")])
        self.assertIn("__jobs_bg 'sleep 30' bg1", out)
        self.assertIn("__jobs_bg()", out, "the helper must be defined in the same cell")

    def test_untouched_when_nothing_is_backgrounded(self):
        src = "make && ./run\necho done"
        out, adopted = self.rewrite(src)
        self.assertEqual(adopted, [])
        self.assertEqual(out, src, "a cell with no backgrounding must be byte-identical")

    def test_positional_names_follow_shell_convention(self):
        _, adopted = self.rewrite("alpha &\nbeta &")
        self.assertEqual([n for n, _ in adopted], ["bg1", "bg2"])

    def test_other_lines_are_preserved_verbatim(self):
        # The rewrite is line-oriented precisely so quoting and redirection survive.
        src = 'echo "keep  this   spacing" > out.txt 2>&1\nsleep 5 &\ncat <<X\nliteral\nX'
        out, _ = self.rewrite(src)
        self.assertIn('echo "keep  this   spacing" > out.txt 2>&1', out)

    def test_heredoc_bodies_are_not_rewritten(self):
        # A heredoc body is data. Rewriting inside one corrupts the payload while
        # looking like it worked — the worst failure shape available here.
        src = "cat <<EOF\nsleep 30 &\nEOF"
        out, adopted = self.rewrite(src)
        self.assertEqual(adopted, [], "heredoc content must not be adopted")
        self.assertIn("sleep 30 &", out, "the payload must survive unchanged")

    def test_quoted_heredoc_delimiter(self):
        src = "cat <<'EOF'\nsleep 30 &\nEOF"
        _, adopted = self.rewrite(src)
        self.assertEqual(adopted, [])

    def test_indentation_is_preserved(self):
        out, _ = self.rewrite("if true; then\n    sleep 5 &\nfi")
        self.assertIn("    __jobs_bg", out)

    def test_command_with_quotes_is_requoted_safely(self):
        out, adopted = self.rewrite("""bash -c 'echo "hi there"' &""")
        self.assertEqual(len(adopted), 1)
        # The whole original command must be recoverable as one shell word.
        self.assertIn("__jobs_bg", out)
        import shlex
        # the CALL, not the helper's definition line (`__jobs_bg() {`)
        wrapped = [l for l in out.split("\n") if l.startswith("__jobs_bg ")][0]
        parts = shlex.split(wrapped)
        self.assertEqual(parts[1], """bash -c 'echo "hi there"'""")

    def test_rewrite_is_idempotent_in_effect(self):
        # Running the rewriter over its own output must not adopt the helper's own
        # internal `&`, which would nest jobs inside jobs.
        once, adopted1 = self.rewrite("sleep 30 &")
        _, adopted2 = S.rewrite_background(once)
        self.assertEqual(len(adopted1), 1)
        self.assertEqual(adopted2, [], "the injected helper must not be re-adopted")


class TestShellFormat(unittest.TestCase):
    def test_matches_the_shape_of_bash_jobs(self):
        out = S.shell_format([
            {"name": "bg1", "cmd": "zcat f.gz | grep E", "state": "running"},
            {"name": "bg2", "cmd": "./build.sh", "state": "done", "exit_code": 0},
        ])
        lines = out.split("\n")
        self.assertTrue(lines[0].startswith("[1]"))
        self.assertIn("Running", lines[0])
        self.assertIn("zcat f.gz | grep E &", lines[0])
        self.assertIn("Done", lines[1])

    def test_nonzero_exit_is_visible(self):
        out = S.shell_format([{"name": "bg1", "cmd": "x", "state": "done", "exit_code": 3}])
        self.assertIn("Exit 3", out)

    def test_empty(self):
        self.assertEqual(S.shell_format([]), "")


class TestResolve(unittest.TestCase):
    def setUp(self):
        self.records = [
            {"name": "bg1", "cmd": "alpha"},
            {"name": "bg2", "cmd": "beta"},
            {"name": "bg3", "cmd": "gamma"},
        ]

    def test_percent_number(self):
        self.assertEqual(S.resolve("%2", self.records)["name"], "bg2")

    def test_percent_plus_is_the_most_recent(self):
        self.assertEqual(S.resolve("%+", self.records)["name"], "bg3")

    def test_percent_minus_is_the_previous(self):
        self.assertEqual(S.resolve("%-", self.records)["name"], "bg2")

    def test_by_name_still_works(self):
        self.assertEqual(S.resolve("bg1", self.records)["name"], "bg1")

    def test_by_command_prefix(self):
        self.assertEqual(S.resolve("%gam", self.records)["name"], "bg3")

    def test_out_of_range_is_none_not_a_wrong_job(self):
        # Returning the wrong job would let `kill %9` stop something the agent never
        # named — a silent wrong action, which is worse than an error.
        self.assertIsNone(S.resolve("%9", self.records))
        self.assertIsNone(S.resolve("%1", []))


class TestAdoptionIsNotVacuous(unittest.TestCase):
    """
    Guards against the rewriter degenerating into "adopt nothing", which would pass
    every false-positive test above while doing no work at all.
    """

    def test_the_realistic_cases_are_actually_adopted(self):
        for src in (
            "nohup ./long_job.sh &",
            "zcat huge.gz | grep ERROR > out.txt &",
            "(sleep 40; touch ready.flag) &",
            "python worker.py --slow &",
        ):
            _, adopted = S.rewrite_background(src)
            self.assertEqual(len(adopted), 1, f"failed to adopt: {src}")

    def test_the_realistic_non_cases_are_left_alone(self):
        for src in (
            "make && ./run",
            "./run > out.txt 2>&1",
            'echo "tom & jerry"',
            "grep -r 'a && b' .",
        ):
            _, adopted = S.rewrite_background(src)
            self.assertEqual(adopted, [], f"wrongly adopted: {src}")


if __name__ == "__main__":
    unittest.main()
