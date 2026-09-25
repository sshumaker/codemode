# harness

**Code is all you need** — does replacing a conventional tool registry with a
single persistent code-execution tool improve agent performance, and does the
effect grow as the model gets weaker?

Two arms over one codebase, differing only in the tool registry:

| arm | model-facing tools | MCP catalogue delivered as |
|---|---|---|
| `vanilla` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | JSON tool definitions, resident every turn |
| `codemode` | one persistent IPython REPL | a greppable `api/` tree of Python modules |

Benchmarked against [MCP-Bench](https://github.com/Accenture/mcp-bench) — 27
live MCP servers, 250 real tools, tasks that mount ~11 servers each so tool
definitions genuinely crowd the context.

See `docs/DESIGN.md` for the experiment design and `docs/FINDINGS.md` for
results and the problems found along the way.

## Setup

```bash
npm install

# Restore the five tools prime-agent deleted, and disable its run-to-run
# prompt mutation. Both are idempotent and survive an upstream bump.
node scripts/port-vanilla-tools.mjs
node scripts/neutralize-prime.mjs
(cd vendor/prime-agent && npm install && npm run build)

# 27 of MCP-Bench's 28 servers, installed strictly locally — no global npm
# packages, no sudo, unlike mcp-bench's own install.sh.
scripts/setup-mcp-bench.sh
node bench/mcp-schemas.mjs          # -> bench/data/mcp-schemas.json (250 tools)
```

An API key is read from an env file you point at; it is sourced in a subshell
and never read into the harness. `ANTHROPIC_API_KEY` covers Opus 5 and Sonnet 5;
GLM 5.2 needs `OPENROUTER_API_KEY` or `ZAI_API_KEY`.

In a `git worktree`, link the task set before running the suite. `vendor/mcp-bench`
is gitignored, so a worktree has none — and without it fifteen task-driven tests
either refuse to run or have nothing to iterate:

```bash
ln -s <primary-checkout>/vendor/mcp-bench vendor/mcp-bench
# or, to fetch it again: scripts/setup-mcp-bench.sh --clone-only
```

## Running

```bash
npm test                                    # 665 JS + 344 Python tests, no API key needed
node bench/residency-report.mjs             # resident token cost per arm

node bench/mcp-proxy.mjs &                  # shared MCP server pool + call log

# one task, one arm
node bench/run-task.mjs <env> anthropic/claude-sonnet-5 <task-id> codemode --residency L0

# a sample across both arms (resumable — skips completed runs)
node bench/sweep.mjs <env> anthropic/claude-sonnet-5 --tasks 4 --max-cost 2.0

node bench/judge.mjs <env> --model claude-opus-4-5    # MCP-Bench's 6-dim rubric
node bench/report.mjs --paired                        # head-to-head
```

## Inspection

Complete visibility into any run — the summary numbers hide too much. A run that
"worked" but never touched an MCP server looks identical in the totals.

```bash
node bench/inspect.mjs --list               # all runs
node bench/inspect.mjs <runId>              # full transcript, per-turn usage
node bench/inspect.mjs <runId> --mcp        # every MCP call it made
node bench/inspect.mjs <runId> --prompt     # the exact system prompt
node bench/inspect.mjs --compare <taskId>   # every arm that ran this task
```

Each run writes a self-contained directory under `.run/runs/<runId>/` holding
the raw event stream, so any analysis can be redone without re-spending tokens.

## Layout

```
bench/
  arms.mjs              arm construction, residency levels, token accounting
  generate.mjs          MCP schema -> tool defs | TOC | names | api/ tree
  mcp-client.mjs        MCP stdio client with a lazily-started server pool
  mcp-proxy.mjs         shared HTTP proxy — both arms call through it, all logged
  mcp-schemas.mjs       dump real tool schemas from the 27 servers
  tasks.mjs             MCP-Bench task loading, filtering, deterministic sampling
  run-task.mjs          one task x one arm, full capture
  sweep.mjs             sample x arms, resumable
  judge.mjs             MCP-Bench's 6-dimension rubric
  report.mjs            paired head-to-head
  inspect.mjs           transcripts and MCP call logs
docs/                   design, findings, sketches
scripts/                reproducible patches against the vendored upstreams
vendor/prime-agent      upstream @ a18809e, pinned
vendor/pi-mono          upstream @ e47b8e3, pinned
vendor/mcp-bench        upstream @ 7a8eaea (gitignored — 53MB)
```

## Why both arms call MCP through one proxy

The vanilla arm's registered tools and the codemode arm's generated `api/`
modules both POST to `bench/mcp-proxy.mjs`. That holds the transport constant so
the arms differ only in how the model is *shown* the tools, and it puts every
tool call in the experiment through a single point that logs it — which is how
the judge scores both arms from identical trajectory records rather than from
arm-specific formatting.
