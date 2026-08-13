"""Guarantee stdlib `tokenize` wins over a task cwd that shadows it.

Staged into the kernel venv's site-packages next to a `.pth` file that does
`import harness_unshadow`, so this runs at INTERPRETER STARTUP — before IPython,
ipykernel, `stack_data` or `executing` import anything. That ordering is the whole
point: `executing/executing.py` does `from tokenize import detect_encoding` at
import time, and IPython imports `executing` (via `stack_data`) during shell init,
*before* the startup file (`kernel-prelude.py`) runs. So the same fix inside the
prelude is too late — by then the shadowed import has already failed and the kernel
came up without `jobs` bound. Measured on train-bpe-tokenizer, which ships
`/app/tokenize.py`; the ON arm was silently INVALID (a plausible number, not an
error — the trap this project keeps hitting).

The kernel runs with '' (the task cwd) at sys.path[0], so a task file named after a
stdlib module is imported in its place, and the first traceback dies in
`tokenize.open` (via `linecache`) with an AttributeError, or an eager
`from tokenize import detect_encoding` dies with ImportError. Force the stdlib
module into sys.modules with the cwd entries removed for the duration of the import,
then restore sys.path untouched so the agent's own local imports still work.
"""

import os
import sys


def _unshadow_stdlib():
    import importlib

    cwd = os.getcwd()
    saved = list(sys.path)
    sys.path[:] = [p for p in sys.path if p not in ("", ".", cwd)]
    try:
        sys.modules.pop("tokenize", None)
        std_tok = importlib.import_module("tokenize")
        lc = sys.modules.get("linecache")
        if lc is not None and getattr(lc, "tokenize", None) is not std_tok:
            lc.tokenize = std_tok
    except Exception:
        # A guard against a broken kernel must never break the kernel itself.
        pass
    finally:
        sys.path[:] = saved


_unshadow_stdlib()
