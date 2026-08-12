#!/usr/bin/env python3
"""Mirror terminal-bench task directories with one change: the `client` service
mounts the `tb-agent` volume read-only at /agent.

Why this exists
---------------
prime-agent has to run *inside* the task container — that is the "run the real
harness, not a reimplementation" rule, and the alternative (driving a hand-rolled
kernel over `docker exec` from the host) is the exact mistake that cost this
project a benchmark. The agent payload is ~1 GB, so `docker cp`-ing it per trial
is not viable; it has to be a mount, and terminal-bench composes each task from
the task's own `docker-compose.yaml` with no hook for extra files or volumes.

So the dataset is mirrored and exactly one key is added. Everything else —
Dockerfile, task.yaml, tests/, run-tests.sh, solution.sh — is copied byte for
byte, and the manifest records a sha256 of every file so "byte for byte" is a
checkable claim rather than an assurance.

The mutation is not free of consequences and they are stated rather than assumed:
the container gains a read-only /agent tree it would not otherwise have. Re-run
the oracle screen against the staged dataset, not just the original one — a task
whose tests enumerate mounts or walk `/` would notice.

Usage:
    python3 bench/terminal/stage-dataset.py --tasks hello-world,csv-to-parquet
    python3 bench/terminal/stage-dataset.py --all
"""

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "vendor" / "terminal-bench" / "original-tasks"
OUT = ROOT / ".run" / "terminal-bench" / "dataset"
VOLUME = "tb-agent"
MOUNT = f"{VOLUME}:/agent:ro"


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def patch_compose(text: str) -> tuple[str, dict]:
    """Add the /agent mount to the `client` service and declare the volume."""
    doc = yaml.safe_load(text)
    services = doc.get("services") or {}
    if "client" not in services:
        raise ValueError(f"no `client` service; services={list(services)}")
    client = services["client"]
    vols = list(client.get("volumes") or [])
    if MOUNT not in vols:
        vols.append(MOUNT)
    client["volumes"] = vols
    top = dict(doc.get("volumes") or {})
    top[VOLUME] = {"external": True}
    doc["volumes"] = top
    return yaml.safe_dump(doc, sort_keys=False), doc


def stage(task_id: str) -> dict:
    src = SRC / task_id
    if not src.is_dir():
        raise SystemExit(f"no such task: {task_id}")
    dst = OUT / task_id
    # `docker cp`-style trap in reverse: a stale mirror silently hands the next
    # run the previous attempt's files. Remove, never merge.
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True)

    compose = dst / "docker-compose.yaml"
    patched, _ = patch_compose(compose.read_text())
    compose.write_text(patched)

    unchanged, changed = {}, {}
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(src).as_posix()
        mirrored = dst / rel
        if not mirrored.is_file():
            changed[rel] = "MISSING"
        elif sha(f) == sha(mirrored):
            unchanged[rel] = sha(f)
        else:
            changed[rel] = f"{sha(f)[:12]} -> {sha(mirrored)[:12]}"

    if set(changed) != {"docker-compose.yaml"}:
        raise SystemExit(
            f"{task_id}: expected exactly docker-compose.yaml to differ, got {changed}"
        )
    return {"task_id": task_id, "identical": len(unchanged), "patched": list(changed)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", help="comma-separated task ids")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    if args.all:
        ids = sorted(d.name for d in SRC.iterdir() if (d / "task.yaml").is_file())
    elif args.tasks:
        ids = [t.strip() for t in args.tasks.split(",") if t.strip()]
    else:
        ap.error("pass --tasks or --all")

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    failed = []
    for t in ids:
        try:
            manifest.append(stage(t))
        except Exception as e:  # a task whose compose we cannot patch is excluded,
            failed.append({"task_id": t, "error": str(e)})  # loudly, not silently
    (OUT / "stage-manifest.json").write_text(
        json.dumps({"staged": manifest, "failed": failed}, indent=2) + "\n"
    )
    print(f"staged {len(manifest)} task(s) into {OUT}")
    for f in failed:
        print(f"  FAILED {f['task_id']}: {f['error']}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
