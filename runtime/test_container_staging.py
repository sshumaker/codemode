"""Every runtime module the staged code imports is staged with it.

bench/terminal/prime_agent.py copies a fixed list of runtime/ modules into the
task container. A module missing from that list fails only inside the container,
where nothing on the host sees it: scheduler.py's `from agent_mailbox import
Mailbox` sank every exit-mode wake, and the prelude's `import agents` (bound next
to `import subagents`) reported SUBAGENTS unavailable while the reachability check
(`import subagents` alone) passed. These derive the requirement from the imports
themselves, so a new import in any staged module fails here instead.

prime_agent.py is read, not imported: importing it needs terminal_bench, which the
runtime suite does not have.

    python3 -m unittest runtime/test_container_staging.py
"""

import ast
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RUNTIME = REPO / "runtime"
RUNNER = REPO / "bench" / "terminal" / "prime_agent.py"
LOCAL = {p.stem for p in RUNTIME.glob("*.py")}


def _runner_constant(name):
    for node in ast.parse(RUNNER.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"{RUNNER.name} no longer defines {name}")


def _local_imports(tree, *, guarded):
    """Runtime-module imports in `tree`; `guarded` also counts those under a try."""
    parents = {child: node for node in ast.walk(tree) for child in ast.iter_child_nodes(node)}
    found = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [a.name.split(".")[0] for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names = [node.module.split(".")[0]]
        else:
            continue
        up, under_try = parents.get(node), False
        while up is not None:
            under_try = under_try or isinstance(up, ast.Try)
            up = parents.get(up)
        if guarded or not under_try:
            found.update(n for n in names if n in LOCAL)
    return found


def _closure(staged_files):
    """(modules the staged files import unguarded, transitively; the staged modules)."""
    staged = {Path(n).stem for n in staged_files}
    todo, need = list(staged), set()
    while todo:
        path = RUNTIME / f"{todo.pop()}.py"
        if not path.exists():
            continue
        for dep in _local_imports(ast.parse(path.read_text()), guarded=False):
            if dep not in need:
                need.add(dep)
                todo.append(dep)
    return need, staged


class ContainerStagingTest(unittest.TestCase):
    def test_every_unguarded_import_of_the_jobs_runtime_is_staged(self):
        need, staged = _closure(_runner_constant("JOBS_RUNTIME"))
        self.assertLessEqual(need, staged, f"imported but not staged: {sorted(need - staged)}")

    def test_the_subagent_runtime_stages_what_the_prelude_binds(self):
        files = _runner_constant("JOBS_RUNTIME") + _runner_constant("SUBAGENT_RUNTIME")
        need, staged = _closure(files)
        self.assertLessEqual(need, staged, f"imported but not staged: {sorted(need - staged)}")
        # The prelude binds subagents inside a try; everything that try imports is
        # the capability, so all of it is staged when the flag advertises it.
        prelude = ast.parse((RUNTIME / "kernel-prelude.py").read_text())
        bodies = [ast.Module(body=t.body, type_ignores=[]) for t in ast.walk(prelude) if isinstance(t, ast.Try)]
        bound = [_local_imports(b, guarded=True) for b in bodies]
        bound = set().union(*(b for b in bound if "subagents" in b))
        self.assertTrue(bound, "the prelude no longer binds subagents in a try: update this test")
        self.assertLessEqual(bound, staged, f"the prelude binds but the runner does not stage: {sorted(bound - staged)}")


class ExitModeEnvTest(unittest.TestCase):
    def test_exit_mode_lets_the_scheduler_own_the_turn(self):
        # Exit mode runs turns under runtime/scheduler.py's supervisor: the first
        # run's env and session.json's env (which the scheduler's resume runs use,
        # and which wins over the process env) both have to stop prime's daemon
        # outliving a killed client's turn, or the recovery run finds the session
        # "already active" (see neutralize-prime.mjs, owned-worker grace).
        found = 0
        for node in ast.walk(ast.parse(RUNNER.read_text())):
            if not isinstance(node, ast.Dict):
                continue
            keys = {k.value: v for k, v in zip(node.keys, node.values) if isinstance(k, ast.Constant)}
            mode = keys.get("HARNESS_WAIT_MODE")
            if mode is None or getattr(mode, "value", None) != "exit":
                continue
            found += 1
            grace = keys.get("HARNESS_OWNED_WORKER_GRACE_MS")
            self.assertIsNotNone(grace, f"an exit-mode env (line {node.lineno}) does not set HARNESS_OWNED_WORKER_GRACE_MS")
            self.assertEqual(ast.literal_eval(grace), "0")
        self.assertEqual(found, 2, f"expected the first-run and session.json exit-mode envs in {RUNNER.name}")

if __name__ == "__main__":
    unittest.main()
