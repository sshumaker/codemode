"""The kernel startup hooks, loaded together, against a real IPython shell.

Run against the kernel's IPython version WITHOUT installing anything into the
kernel venv (that venv is the environment under test; a pytest install there
changed the measured condition once, 2026-09-04, and was rolled back):

    uvx --python 3.11 --with ipython==9.16.1 pytest runtime/test_startup_hooks_chain.py -q

Two things a unit test of each hook in isolation cannot see:

1. IPython's `set_custom_exc` REPLACES the registration (`self.custom_exceptions
   = exc_tuple`, 9.16.1). Three hooks that each called it directly left one
   handler installed. The test raises every hooked error type after loading all
   the hooks and requires every correction.
2. Startup files share the user namespace, so a module-level name in one hook
   shadows the same name in another (`correction_for` was defined by two).

Also covers HARNESS_API_PREBIND: `api.<module>` resolves before any import, and
survives `%reset -f`.
"""

import json
import os
import sys
import textwrap
from pathlib import Path

import pytest

RUNTIME = Path(__file__).resolve().parent
# The same manifest a port installs from (bench/startup-hooks.mjs).
_MANIFEST = json.loads((RUNTIME / "startup_hooks.json").read_text())
HOOKS = _MANIFEST["order"]
FLAGS = _MANIFEST["env"]

pytest.importorskip("IPython")


def _fake_api(root: Path) -> None:
    pkg = root / "api"
    pkg.mkdir()
    (pkg / "__init__.py").write_text(
        '"""fake catalogue"""\n'
        # W130: the wait surface a real bundle re-exports; prebind binds it bare.
        "class NotReady(RuntimeError):\n    pass\n"
        "class Handle:\n    pass\n"
        "def wait_for(*things):\n    raise SystemExit('wait')\n"
    )
    (pkg / "agent_tools.py").write_text(
        textwrap.dedent(
            '''
            async def wait_for_assets(ids, max_timeout=None, reason=None):
                """Wait for assets."""
                return '{"ok": true}'

            async def read(ref: str):
                return '{"asset_id": "x"}'
            '''
        )
    )
    (pkg / "image.py").write_text(
        "async def blend_image(prompt: str):\n    return '{}'\n"
        "async def create_image_nano_banana_pro(prompt: str):\n    return '{}'\n"
        "async def modify_image_gpt_image_2(source: str, prompt: str):\n    return '{}'\n"
    )


@pytest.fixture
def shell(tmp_path, monkeypatch, capsys):
    from IPython.core.interactiveshell import InteractiveShell

    _fake_api(tmp_path)
    monkeypatch.chdir(tmp_path)
    for k, v in FLAGS.items():
        monkeypatch.setenv(k, v)
    # a fresh instance per test: InteractiveShell is a singleton
    InteractiveShell.clear_instance()
    ip = InteractiveShell.instance()
    ip.user_ns["get_ipython"] = lambda: ip
    sys.path.insert(0, str(tmp_path))
    try:
        for name in HOOKS:
            ip.safe_execfile(str(RUNTIME / name), ip.user_ns, raise_exceptions=True)
        capsys.readouterr()
        yield ip
    finally:
        sys.path.remove(str(tmp_path))
        for mod in [m for m in sys.modules if m == "api" or m.startswith("api.")]:
            del sys.modules[mod]
        import builtins

        for n in ("api",):
            builtins.__dict__.pop(n, None)
        InteractiveShell.clear_instance()


def _run(ip, code, capsys) -> str:
    ip.run_cell(code)
    return capsys.readouterr().out


def test_every_hook_fires_after_all_are_loaded(shell, capsys):
    out = _run(shell, "raise PermissionError(1, 'Operation not permitted')", capsys)
    assert "outside the job's world" in out, out

    out = _run(shell, "open('api/agent_tools/read.py')", capsys)
    assert "CONSOLIDATED" in out, out

    out = _run(shell, "import asyncio; asyncio.run(api.agent_tools.wait_for_assets(asset_ids=['x']))", capsys)
    assert "api.agent_tools.wait_for_assets(ids, max_timeout=None, reason=None)" in out, out


def test_a_type_error_the_hook_cannot_explain_says_nothing(shell, capsys):
    out = _run(shell, "len(3)", capsys)
    assert "[harness]" not in out, out


def test_indexing_the_returned_string_names_the_variable(shell, capsys):
    out = _run(shell, "asset = '{\"asset_id\": \"x\"}'\nasset['asset_id']", capsys)
    assert "`asset` is a str, not a dict" in out and "json.loads(asset)" in out, out


def test_api_is_bound_with_its_modules_before_the_first_cell(shell, capsys):
    out = _run(shell, "print(api.agent_tools.read.__name__, api.image.blend_image.__name__)", capsys)
    assert out.strip() == "read blend_image", out


def test_api_survives_reset(shell, capsys):
    _run(shell, "%reset -f", capsys)
    out = _run(shell, "print(api.image.blend_image.__name__)", capsys)
    assert out.strip() == "blend_image", out


def test_hooks_are_inert_when_explicitly_disabled(tmp_path, monkeypatch, capsys):
    """W128: prebind and signature correction are ON by default; `=0` turns them off.
    (The layout-correction hook keeps its opt-in gate.)"""
    from IPython.core.interactiveshell import InteractiveShell

    _fake_api(tmp_path)
    monkeypatch.chdir(tmp_path)
    for k in FLAGS:
        monkeypatch.setenv(k, "0")
    InteractiveShell.clear_instance()
    ip = InteractiveShell.instance()
    ip.user_ns["get_ipython"] = lambda: ip
    sys.path.insert(0, str(tmp_path))
    try:
        for name in HOOKS:
            ip.safe_execfile(str(RUNTIME / name), ip.user_ns, raise_exceptions=True)
        capsys.readouterr()
        out = _run(ip, "print('api' in dir())", capsys)
        assert out.strip() == "False", out
        out = _run(ip, "import asyncio, api.agent_tools\nasyncio.run(api.agent_tools.wait_for_assets(asset_ids=['x']))", capsys)
        assert "[harness]" not in out, out
        # the un-gated eperm hook still installs
        out = _run(ip, "raise PermissionError(1, 'Operation not permitted')", capsys)
        assert "outside the job's world" in out, out
    finally:
        sys.path.remove(str(tmp_path))
        for mod in [m for m in sys.modules if m == "api" or m.startswith("api.")]:
            del sys.modules[mod]
        InteractiveShell.clear_instance()


def test_prebind_and_signature_are_on_with_no_flags_set(tmp_path, monkeypatch, capsys):
    """The default condition is the fixed one: nothing exported, `api` still resolves
    and a kwarg TypeError still prints the real signature."""
    from IPython.core.interactiveshell import InteractiveShell

    _fake_api(tmp_path)
    monkeypatch.chdir(tmp_path)
    for k in FLAGS:
        monkeypatch.delenv(k, raising=False)
    InteractiveShell.clear_instance()
    ip = InteractiveShell.instance()
    ip.user_ns["get_ipython"] = lambda: ip
    sys.path.insert(0, str(tmp_path))
    try:
        for name in HOOKS:
            ip.safe_execfile(str(RUNTIME / name), ip.user_ns, raise_exceptions=True)
        capsys.readouterr()
        out = _run(ip, "print(api.image.blend_image.__name__)", capsys)
        assert out.strip() == "blend_image", out
        out = _run(ip, "import asyncio\nasyncio.run(api.agent_tools.wait_for_assets(asset_ids=['x']))", capsys)
        assert "api.agent_tools.wait_for_assets(ids, max_timeout=None, reason=None)" in out, out
    finally:
        sys.path.remove(str(tmp_path))
        for mod in [m for m in sys.modules if m == "api" or m.startswith("api.")]:
            del sys.modules[mod]
        import builtins

        builtins.__dict__.pop("api", None)
        InteractiveShell.clear_instance()


def test_signature_correction_inlines_the_args_block(shell, capsys):
    """W128/h64: after the signature alone, 4 of 5 traces spent the next cell on
    print(fn.__doc__). The correction now carries the docstring's Args block."""
    import textwrap

    (RUNTIME.parent / "does-not-matter").exists()  # keep RUNTIME referenced
    src = textwrap.dedent(
        '''
        async def query_creative_tools(query: str, include_metrics: bool | None = None):
            """Search for creative tools.

            Args:
                query: Natural language or comma-separated tool ids.
                include_metrics: Add pricing/timing. Optional.

            Returns:
                QueryCreativeToolsOutput.
            """
        '''
    )
    _run(shell, "import api.agent_tools as _m\n" + src.replace("\n", "\n") + "\n_m.query_creative_tools = query_creative_tools", capsys)
    out = _run(shell, "import asyncio\nasyncio.run(api.agent_tools.query_creative_tools(creative_tool_id='x'))", capsys)
    assert "Args (from the docstring):" in out, out
    assert "query: Natural language or comma-separated tool ids." in out, out
    assert "Returns" not in out.split("Args (from the docstring):")[1], out


def test_attribute_error_on_an_api_module_names_what_is_there(shell, capsys):
    """h64 run 2: api.agent_tools.generate_image (no such function) cost three cells."""
    out = _run(shell, "import asyncio\nasyncio.run(api.agent_tools.generate_image(prompt='x'))", capsys)
    assert "`api.agent_tools` has no `generate_image`" in out, out
    assert "It has: read, wait_for_assets" in out, out


def test_unrelated_attribute_errors_say_nothing(shell, capsys):
    out = _run(shell, "x = 3\nx.foo", capsys)
    assert "[harness]" not in out, out


def test_attribute_error_points_at_the_module_that_has_the_operation(shell, capsys):
    """W129, h65 pos 24: `agent_tools.generate(...)` three times; the correction
    named only that module. The verb in the guess lives in api.image — say so."""
    out = _run(shell, "import asyncio\nasyncio.run(api.agent_tools.generate(prompt='x'))", capsys)
    assert "`api.agent_tools` has no `generate`" in out, out
    assert "api.image: create_image_nano_banana_pro" in out, out
    assert "Packages: api.image, api.agent_tools" in out, out
    assert "cat api/INDEX.md" in out


def test_prebind_binds_the_wait_surface_bare(shell, capsys):
    """W130: `wait_for(clip)` and `except NotReady:` work without an import, like `api`."""
    out = _run(shell, "print(callable(wait_for), NotReady.__name__, Handle.__name__)", capsys)
    assert "True NotReady Handle" in out, out


def test_introspecting_an_api_module_prints_its_file_once(shell, capsys):
    """h72-h74: dir()/inspect/help on api modules, one question per turn, in every run.
    The hook answers the first introspection of a module with the module's whole file."""
    out = _run(shell, "print(dir(api.image))", capsys)
    assert "##### api/image.py" in out and "no further dir()/inspect/help turns" in out, out
    out = _run(shell, "import inspect\nprint(inspect.signature(api.image.create_image_nano_banana_pro))", capsys)
    assert "##### api/image.py" not in out, out  # once per module per session
    _run(shell, "import api, pathlib\npathlib.Path(api.__file__).parent.joinpath('INDEX.md').write_text('# api index')", capsys)
    out = _run(shell, "print(dir(api))", capsys)
    assert "##### api/INDEX.md" in out and "# api index" in out, out

