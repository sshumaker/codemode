# harness

Does replacing a conventional tool registry with a single persistent
code-execution tool improve agent performance — and does the effect grow as the
model gets weaker?

Two arms over one codebase (`prime-agent`, itself `pi-mono` with the tool
registry swapped):

- **vanilla** — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`
- **codemode** — one persistent IPython tool, with the MCP catalogue rendered to
  disk as a greppable `api/` tree

See `docs/DESIGN.md` for the full design and `docs/sketches/subagent.py` for the
subagent API.

## Layout

```
bench/                arms, generator, residency measurement, tests
docs/                 design + sketches
scripts/              reproducible patches against the vendored upstreams
vendor/prime-agent    upstream @ a18809e, pinned
vendor/pi-mono        upstream @ e47b8e3, pinned
```

## Setup

```bash
npm install
node scripts/port-vanilla-tools.mjs        # restore the five tools prime dropped
cd vendor/prime-agent && npm install && npm run build
```

## Use

```bash
npm test                                   # 91 tests, no API key required
node bench/residency-report.mjs 250        # resident token cost per arm
```
