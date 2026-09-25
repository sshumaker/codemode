"""Kernel startup hook: answer api introspection with the module's file, once.

h72–h74 (W130), every preamble variant: GLM explores the api one question per turn
— `dir(api)`, `dir(api.image)`, `inspect.signature(api.image.x)` for four
functions, `api.image.x.__doc__` for three more — 5 to 16 cells before the first
line of work, and "never explore the api with dir(); read the file" in the
system prompt did not move it (h74). Each cell is a model turn that re-reads the
transcript; the file it is reconstructing is 16k cached tokens.

So the correction goes where the model already looks: when a cell introspects an
api module, its output also carries that module's whole file, once per module per
session (`dir(api)` gets api/INDEX.md). The idiom is kept; the turns are not.
HARNESS_API_DOC_EXPANSION=0 disables.
"""
import os as _os
import re as _re
import sys as _sys
from pathlib import Path as _Path

# Everything the callbacks need is bound as a default argument: startup files run in
# the user namespace, and `%reset -f` wipes module-level names (the callback stayed
# registered and raised NameError on every cell — measured in the hook test).
_PAT = _re.compile(
    r"(?:\bdir|\bhelp|inspect\.(?:signature|getdoc|getsource|getmembers))\(\s*api(?:\.(\w+))?"
    r"|\bapi\.(\w+)\.\w+\.__doc__"
    r"|\bapi\.(\w+)\.__doc__"
)


def api_doc_expansion_for(source, _shown=set(), _pat=_PAT, _sys=_sys, _Path=_Path):
    """The text to append to a cell's output, or "" — pure apart from the once-per-module set."""
    mods = set()
    for m in _pat.finditer(source or ""):
        mods.add(m.group(1) or m.group(2) or m.group(3) or "__index__")
    if not mods:
        return ""
    mod = _sys.modules.get("api")
    f = getattr(mod, "__file__", None) if mod else None
    root = _Path(f).parent if f else _Path.cwd() / "api"
    out = []
    for name in sorted(mods):
        if name in _shown:
            continue
        path = root / "INDEX.md" if name == "__index__" else root / f"{name}.py"
        if not path.is_file():
            continue
        _shown.add(name)
        label = "api/INDEX.md" if name == "__index__" else f"api/{name}.py"
        out.append(
            f"\n[harness] You are exploring `{'api' if name == '__index__' else 'api.' + name}` a question per turn. "
            f"The whole documentation is the file; here it is once, so no further dir()/inspect/help turns are needed.\n"
            f"##### {label}\n{path.read_text(encoding='utf-8', errors='replace')}"
        )
    return "\n".join(out)


def _post_run_cell(result, _os=_os, _expand=api_doc_expansion_for):
    if _os.environ.get("HARNESS_API_DOC_EXPANSION", "1") != "1":
        return
    try:
        src = getattr(getattr(result, "info", None), "raw_cell", "") or ""
        text = _expand(src)
        if text:
            print(text)
    except Exception:
        pass  # a correction must never break a cell


get_ipython().events.register("post_run_cell", _post_run_cell)  # noqa: F821 - IPython startup context
