"""Import a generated `api/` tree and report its callable surface as JSON.

Run as: python3 layout_probe.py <dir-containing-api>

Exists so the two layouts can be compared by what PYTHON sees rather than by what
the generator emitted. The whole point of `--api-layout` is that it changes the
files on disk and nothing else: `import api.gmail; await api.gmail.show_drafts(...)`
must be the same call in both. A string comparison of the rendered text cannot show
that — the text is different by construction — so this imports the tree for real and
reports the functions, their signatures and their docstrings.

Both trees are named `api`, so the two layouts cannot be imported into one process.
One process per layout, JSON out, compared by the caller.
"""

import inspect
import json
import os
import pkgutil
import sys

ROOT = sys.argv[1]

# _client is imported by every generated module at import time and reads the proxy
# address then. Nothing here calls a tool, so any address will do — but it must be
# set, or a tree that happens to resolve it eagerly would fail for the wrong reason.
os.environ.setdefault("HARNESS_MCP_PROXY", "http://127.0.0.1:1")

sys.path.insert(0, ROOT)
import api  # noqa: E402

surface = {}
for info in pkgutil.iter_modules(api.__path__):
    # `_client` and friends are machinery, not app surface.
    if info.name.startswith("_"):
        continue
    module = __import__(f"api.{info.name}", fromlist=["*"])
    functions = {}
    for name, value in vars(module).items():
        if name.startswith("_") or not inspect.iscoroutinefunction(value):
            continue
        functions[name] = {
            "signature": str(inspect.signature(value)),
            # cleandoc, not the raw string: the two layouts indent their function
            # bodies identically today, and pinning the raw text would make this
            # test fail on a whitespace change that no agent could observe.
            "doc": inspect.cleandoc(value.__doc__ or ""),
        }
    surface[info.name] = functions

print(json.dumps(surface, sort_keys=True))
