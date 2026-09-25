"""Correction-on-the-real-error for api/ path guesses, sibling to
eperm_correction.py. Loads as an IPython startup file in the kernel.

W45 finding C, measured in round Wluf6XNC: the agent wanted the contract for a
tool and reached for the layout it knows — one file per method —

    open('api/agent_tools/read.py')               -> FileNotFoundError
    open('api/agent_tools/query_creative_tools.py') -> FileNotFoundError
    open('api/agent_tools/search_for_assets.py')  -> FileNotFoundError
    open('api/agent_tools/list_creative_tools.py')  -> FileNotFoundError

Four cells, ~15% of that round's budget, on layout archaeology. The consolidated
tree (H17) groups methods into `api/<pkg>.py`, and nothing tells the agent that
at the moment it guesses wrong. A bare FileNotFoundError on a path you believe
in reads as a broken tree, and the measured response is to keep guessing.

The correction is DERIVED, never asserted: it inspects what actually exists next
to the miss, so it stays true if the layout changes again (per-method, grouped,
or something later) instead of hardcoding today's answer and lying tomorrow.

Off unless HARNESS_API_LAYOUT_CORRECTION=1, so it is an A/B-able rung rather
than a silent change to the measured condition.
"""

import os


def correction_for(path: str, exists=os.path.exists, isdir=os.path.isdir) -> str:
    """The correction for a missed api/ path, or "" when there is nothing true to say.

    `exists`/`isdir` are injected so this is testable without a bundle on disk.
    """
    norm = str(path).replace("\\", "/").lstrip("./")
    parts = [p for p in norm.split("/") if p]
    if len(parts) < 3 or parts[0] != "api":
        return ""
    pkg = parts[1]
    if pkg.endswith(".py"):
        return ""
    stem = parts[-1][:-3] if parts[-1].endswith(".py") else parts[-1]

    module = f"api/{pkg}.py"
    if exists(module):
        return (
            f"\n[harness] There is no {norm}. This api/ tree is CONSOLIDATED: every "
            f"method of `{pkg}` lives in {module}, one module per server, and each "
            f"function carries its own contract as a docstring. Read {module}, or "
            f"just call it — `from api import {pkg}` then `{pkg}.{stem}(...)`. "
            f"api/INDEX.md lists what each module holds."
        )
    if isdir(f"api/{pkg}"):
        return (
            f"\n[harness] There is no {norm}, but api/{pkg}/ exists — the method file "
            f"is probably named differently. List api/{pkg}/ and read the one you "
            f"want, or `from api import {pkg}` and call it directly."
        )
    return (
        f"\n[harness] There is no {norm}. Read api/INDEX.md for what this tree "
        f"actually contains; the package names there are the importable ones."
    )


def _chain_custom_exc(ip, exc_types, handler):
    """Register `handler` for `exc_types` WITHOUT unregistering earlier hooks.

    IPython's set_custom_exc REPLACES: `self.custom_exceptions = exc_tuple`
    (verified in 9.16.1). Startup hooks that each called it directly left only
    the last one installed -- eperm_correction was silently gone whenever a
    later hook loaded. Dispatch on type, falling through to whatever was there.
    """
    prev_types = tuple(ip.custom_exceptions or ())
    prev = ip.CustomTB

    def _dispatch(shell, etype, value, tb, tb_offset=None):
        if issubclass(etype, exc_types):
            return handler(shell, etype, value, tb, tb_offset=tb_offset)
        if prev is not None and issubclass(etype, prev_types):
            return prev(etype, value, tb, tb_offset=tb_offset)
        shell.showtraceback((etype, value, tb), tb_offset=tb_offset)
        return []

    ip.set_custom_exc(prev_types + tuple(exc_types), _dispatch)


def _install():
    if os.environ.get("HARNESS_API_LAYOUT_CORRECTION") != "1":
        return
    ip = get_ipython()  # noqa: F821 - defined in IPython startup context
    if ip is None:
        return

    def _handler(shell, etype, value, tb, tb_offset=None):
        shell.showtraceback((etype, value, tb), tb_offset=tb_offset)
        try:
            note = correction_for(getattr(value, "filename", "") or "")
            if note:
                print(note)
        except Exception:
            pass
        return []

    _chain_custom_exc(ip, (FileNotFoundError,), _handler)


_install()
del _install, _chain_custom_exc
