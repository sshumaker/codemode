#!/usr/bin/env python3
"""Import every module the kernel is supposed to have, and say which failed.

Run as a build step so a broken venv fails `docker build` rather than surfacing
later as "the kernel did not respond" and getting blamed on the arm.

importlib.import_module, never find_spec: locating a module does not execute it,
and find_spec once certified a jupyter_client that contained a syntax error.
"""
import importlib
import sys

MODULES = [
    # kernel transport — without these prime cannot run a cell at all
    "ipykernel", "jupyter_client", "zmq", "tornado", "IPython",
    # prime's kernel-side shim and the skills that ship python
    "rlm", "attach_image", "edit",
    # the scientific set the host kernel venv carries
    "numpy", "pandas", "scipy", "bs4", "lxml", "pydantic", "tyro",
    "requests", "httpx", "yaml", "tomli", "dotenv", "PIL", "pypdf",
    "psutil", "dill", "nest_asyncio",
]

broken = []
for name in MODULES:
    try:
        importlib.import_module(name)
    except Exception as exc:  # noqa: BLE001 — the exception text is the report
        broken.append(f"{name} ({type(exc).__name__}: {exc})")

if broken:
    print(f"KERNEL BROKEN — {len(broken)} of {len(MODULES)} modules:")
    for line in broken:
        print("   ", line)
    sys.exit(1)

print(f"kernel ok — {len(MODULES)} modules imported on {sys.version.split()[0]}")
