"""Pre-bind `api` — with every module in it already imported — in the kernel.
Loads as an IPython startup file, sibling to eperm_correction.py.

W126 finding, measured on 6 of 10 h59 traces and confirmed cell-by-cell in
_nUm028j (fix arm, low-angle):

    cell 1:  import api.agent_tools as tools; print(dir(tools))
    cell 2:  await api.agent_tools.read(ref="image:CZaUC3KT")
             -> NameError: name 'api' is not defined

`import a.b as c` binds `c` and nothing else -- `api` is never a name in the
namespace, and the preamble's own idiom (`import api.<module>` then
`await api.<module>.<tool>(...)`) is exactly the one the model half-follows.
The chase that follows (dir(), ls, an fs-guard refusal that finally points at
./api) cost 15-16 turns per campaign in BOTH arms, and rewriting the preamble
(fix 1, h59) moved it by one turn. The prompt is the wrong place; the name is.

So adopt the idiom instead of correcting it: bind `api` before cell 1, with
`api.<module>` resolvable for every module the tree actually holds. Derived from
the tree on disk (pkgutil), never a hardcoded module list, so it stays true when
the bundle's layout changes. Bound into builtins as well as user_ns for the same
reason `jobs` is (kernel-prelude.py): `%reset -f` clears user_ns mid-session.

The tool surface itself is untouched -- nothing here changes what a call does,
only whether the name the model already uses resolves. Off unless
HARNESS_API_PREBIND=1, so it is an A/B-able rung and not a silent change to
the measured condition.
"""

import os


def prebind(import_module, iter_modules, log=None) -> tuple[object | None, list[str], list[str]]:
    """Import `api` and every public submodule; return (api, bound, failed).

    `import_module` / `iter_modules` are injected so this is testable against a
    fake tree without a bundle on disk. A submodule that fails to import is
    reported, not fatal: one broken module must not take the whole name away.
    """
    try:
        api = import_module("api")
    except Exception as exc:  # no tree in cwd: nothing true to bind
        if log:
            log(f"[harness] api pre-bind skipped: {exc!r}")
        return None, [], []
    bound, failed = [], []
    for info in iter_modules(getattr(api, "__path__", [])):
        name = info.name
        if name.startswith("_"):
            continue
        try:
            import_module(f"api.{name}")
            bound.append(name)
        except Exception as exc:
            failed.append(f"{name}: {exc!r}")
    return api, bound, failed


def _install():
    # ON unless explicitly disabled (HARNESS_API_PREBIND=0). Measured in h61 (W127): every
    # kwarg-TypeError and NameError cell it removes was a harness defect, not a
    # condition worth A/B-ing per campaign — so the default is the fixed behaviour
    # and "0" is the deliberate way to reproduce the old one.
    if os.environ.get("HARNESS_API_PREBIND", "1") == "0":
        return
    import builtins
    import importlib
    import pkgutil
    import sys

    # sys.__stderr__, not sys.stderr: by the time startup files run, ipykernel
    # has replaced sys.stderr with its ZMQ OutStream, and a stream message with
    # no parent cell is dropped. fd 2 is what prime captures into
    # <round>/kernel-stderr.log (HARNESS_KERNEL_STDERR_LOG).
    err = sys.__stderr__ or sys.stderr
    api, bound, failed = prebind(importlib.import_module, pkgutil.iter_modules, log=lambda m: print(m, file=err))
    if api is None:
        return
    builtins.api = api
    # W130: the wait surface rides along — `wait_for(clip)` and `except NotReady:` work
    # bare, the way `api` does. Only what the bundle actually exports; an older tree
    # without them binds nothing extra.
    extras = {n: getattr(api, n) for n in ("wait_for", "NotReady", "Handle") if hasattr(api, n)}
    for n, v in extras.items():
        setattr(builtins, n, v)
    ip = get_ipython()  # noqa: F821 - defined in IPython startup context
    if ip is not None:
        try:
            ip.user_ns.setdefault("api", api)
            for n, v in extras.items():
                ip.user_ns.setdefault(n, v)
        except Exception:
            pass  # builtins is enough
    # fd 2, never stdout: startup output is not the agent's, and a line the
    # agent cannot act on is noise in its first cell.
    print(f"[harness] api pre-bound: api.{{{','.join(bound)}}}" + (f"; failed: {failed}" if failed else ""), file=err, flush=True)


_install()
del _install
