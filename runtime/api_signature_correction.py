"""Correction-on-the-real-error for TypeErrors at the api/ call site, sibling
to eperm_correction.py. Loads as an IPython startup file in the kernel.

W126 roster, 5 positions x 2 arms, GLM-5.2 -- every kwarg TypeError was a
guessed parameter name for a real function:

    wait_for_assets(refs=|asset_ids=)   real: ids
    label_asset(ref=)                   real: asset_id
    judge_tool(target=)                 real: assets
    complete_job()                      real: state, summary  (x2)

plus 3x `string indices must be integers, not 'str'` -- the model indexing the
str an api call returned (`_client.call(...) -> str`, the server's text) as if
it were a dict. Each cost a cell, and the recovery cell was always the same:
`inspect.signature(tools.wait_for_assets)`. Do that for it, on the error.

Everything printed is DERIVED from the live objects -- the function found by name
among the loaded `api.*` modules, its signature from inspect, the str from the
failing frame's own locals -- never a hardcoded table, so it stays true when the
surface changes. When nothing true can be said, nothing is said.

On by default; HARNESS_API_SIGNATURE_CORRECTION=0 disables it (an A/B-able rung).
"""

import json
import os
import re

_SIG_CALL_SHAPE = re.compile(r"^(\w+)\(\) (?:got an unexpected keyword argument|missing \d+ required|takes \d+|got multiple values)")


def _find_api_functions(name: str, modules) -> list[tuple[str, object]]:
    """Every `api.<module>.<name>` that is callable, as (dotted name, fn).

    `modules` is a sys.modules-like mapping; injected for tests.
    """
    hits = []
    for modname, mod in sorted(modules.items()):
        if not modname.startswith("api.") or modname.startswith("api._") or mod is None:
            continue
        fn = getattr(mod, name, None)
        if callable(fn):
            hits.append((f"{modname}.{name}", fn))
    return hits


def signature_correction_for(message: str, modules, frame_locals: dict | None = None, signature=None) -> str:
    """The correction for a TypeError, or "" when there is nothing true to say."""
    if signature is None:
        import inspect

        signature = inspect.signature
    m = _SIG_CALL_SHAPE.match(message)
    if m:
        hits = _find_api_functions(m.group(1), modules)
        if not hits:
            return ""
        lines = ["\n[harness] The real signature" + ("s are:" if len(hits) > 1 else " is:")]
        for dotted, fn in hits:
            try:
                lines.append(f"  {dotted}{signature(fn)}")
            except (TypeError, ValueError):
                continue
        if len(lines) == 1:
            return ""
        # The Args block inline. Measured (h64, 4 of 5 traces): after the signature
        # alone the model spent its next cell on print(fn.__doc__) anyway, because
        # the signature says which names exist and not what they mean. Bounded, so a
        # long docstring does not become the error.
        args = _args_block(getattr(hits[0][1], "__doc__", None))
        if args:
            lines.append("  Args (from the docstring):")
            lines.extend("    " + l for l in args)
        else:
            lines.append(f"  print({hits[0][0]}.__doc__) has each argument's meaning and allowed values.")
        return "\n".join(lines)
    if message.startswith("string indices must be integers") and frame_locals:
        # Which str did the cell index? The one in its own locals that is JSON.
        for name, value in frame_locals.items():
            if name.startswith("_") or not isinstance(value, str) or not value.lstrip().startswith(("{", "[")):
                continue
            try:
                json.loads(value)
            except ValueError:
                continue
            return (
                f"\n[harness] `{name}` is a str, not a dict: api calls return the server's "
                f"text. `{name} = json.loads({name})` first, then index it."
            )
    return ""


def _args_block(doc: str | None, max_lines: int = 18) -> list[str]:
    """The `Args:` section of a generated wrapper's docstring, dedented, capped."""
    if not doc or "Args:" not in doc:
        return []
    out: list[str] = []
    started = False
    for raw in doc.splitlines():
        line = raw.strip()
        if not started:
            started = line == "Args:"
            continue
        if not line or line.endswith(":") and line[:-1] in ("Returns", "Raises", "Examples", "Note"):
            if out and (not line or line[:-1] in ("Returns", "Raises", "Examples", "Note")):
                break
            continue
        out.append(line)
        if len(out) >= max_lines:
            out.append("... (print(fn.__doc__) for the rest)")
            break
    return out


_ATTR_SHAPE = re.compile(r"^(?:module '([\w.]+)'|'(\w+)' object) has no attribute '(\w+)'$")


# W129, measured on h65: `api.agent_tools.generate(...)` three cells running,
# and the correction said "Did you mean: write, Literal?" — true of that module and
# useless, because the operation lives in api.image. The guess carries a verb; the
# verb, or its common synonym, is in some other module's names. Say where.
_VERB_SYNONYMS = {
    "generate": "create", "gen": "create", "make": "create", "produce": "create",
    "edit": "modify", "change": "modify", "alter": "modify", "fix": "modify",
}


def _elsewhere(attr: str, modname: str, modules) -> str:
    """Where else the guessed name's tokens occur, plus the package list."""
    toks = {t for t in attr.lower().split("_") if len(t) >= 3}
    toks |= {_VERB_SYNONYMS[t] for t in list(toks) if t in _VERB_SYNONYMS}
    generic = {"tool", "tools", "image", "video", "audio", "asset", "assets", "job", "the", "and", "with", "for"}
    keys = toks - generic
    found = []
    pkgs = []
    for name in sorted(k for k in modules if k.startswith("api.") and not k.startswith("api._")):
        mod = modules.get(name)
        if mod is None:
            continue
        pkgs.append(name)
        if name == modname:
            continue
        fns = [n for n in dir(mod) if not n.startswith("_") and callable(getattr(mod, n, None)) and n[:1].islower()]
        hits = [n for n in fns if any(k in n for k in keys)]
        if hits:
            found.append(f"    {name}: {', '.join(hits[:6])}{f', +{len(hits) - 6} more' if len(hits) > 6 else ''}")
    out = ""
    if found:
        out += "\n  Elsewhere under api/ (by the words in your guess):\n" + "\n".join(found[:3])
    if pkgs:
        out += f"\n  Packages: {', '.join(pkgs)} — `cat api/INDEX.md` says what each holds; the file's header lists its tools."
    return out


def attribute_correction_for(message: str, modules, frame_locals: dict | None = None) -> str:
    """The correction for an AttributeError at the api surface, or "".

    h64 run 2: `api.agent_tools.generate_image(...)` (no such function) cost
    three cells. It is the same shape as a wrong keyword: the model guessed a name, and the true
    names are one dir() away. Say them, with the closest match first.
    """
    m = _ATTR_SHAPE.match(message)
    if not m:
        return ""
    import difflib

    def _closest(names: list[str]) -> list[str]:
        # difflib alone misses `tool_id` -> `id` (ratio 0.44); a name that CONTAINS
        # the other is the guess the model actually made, so include those first.
        contained = [n for n in names if n in attr or attr in n]
        fuzzy = difflib.get_close_matches(attr, names, n=3, cutoff=0.4)
        out: list[str] = []
        for n in contained + fuzzy:
            if n not in out:
                out.append(n)
        return out[:3]

    modname, clsname, attr = m.group(1), m.group(2), m.group(3)
    if modname:
        if not modname.startswith("api"):
            return ""
        mod = modules.get(modname)
        names = sorted(n for n in dir(mod) if not n.startswith("_") and callable(getattr(mod, n, None))) if mod else []
        if modname == "api":
            names = sorted(n for n in dir(mod) if not n.startswith("_")) if mod else []
        if not names:
            return ""
        close = _closest(names)
        hint = f"  Did you mean: {', '.join(close)}?\n" if close else ""
        return f"\n[harness] `{modname}` has no `{attr}`.\n{hint}  It has: {', '.join(names)}" + _elsewhere(attr, modname, modules)
    return ""


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
    # ON unless explicitly disabled (HARNESS_API_SIGNATURE_CORRECTION=0). Measured in h61 (W127): every
    # kwarg-TypeError and NameError cell it removes was a harness defect, not a
    # condition worth A/B-ing per campaign — so the default is the fixed behaviour
    # and "0" is the deliberate way to reproduce the old one.
    if os.environ.get("HARNESS_API_SIGNATURE_CORRECTION", "1") == "0":
        return
    ip = get_ipython()  # noqa: F821 - defined in IPython startup context
    if ip is None:
        return
    import sys

    def _handler(shell, etype, value, tb, tb_offset=None):
        shell.showtraceback((etype, value, tb), tb_offset=tb_offset)
        try:
            # the cell's frame is the innermost one whose file is a cell
            frame_locals = None
            t = tb
            while t is not None:
                if t.tb_frame.f_code.co_filename.startswith("<ipython-input") or "ipykernel_" in t.tb_frame.f_code.co_filename:
                    frame_locals = t.tb_frame.f_locals
                t = t.tb_next
            if frame_locals is None and tb is not None:
                frame_locals = tb.tb_frame.f_locals
            if etype is AttributeError:
                note = attribute_correction_for(str(value), sys.modules, frame_locals)
            else:
                note = signature_correction_for(str(value), sys.modules, frame_locals)
            if note:
                print(note)
        except Exception:
            pass
        return []

    _chain_custom_exc(ip, (TypeError, AttributeError), _handler)


_install()
del _install, _chain_custom_exc
