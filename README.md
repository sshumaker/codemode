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

Tests have three tiers — unit/chaos, integration (real scheduler, prime and kernels
against a scripted model) and live — bootstrapped by `scripts/dev-env.sh`. See
[docs/TESTING.md](docs/TESTING.md).

```bash
scripts/dev-env.sh                          # build/refresh the local test environment (--check: report only)
npm run test:integration                    # end to end, scripted model, no API key
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

## Kernel backends

`runtime/kernel/` decides where a conversation's Python kernel runs, for a host that
runs prime per conversation (a gateway, a hosted service). The host never talks to the
kernel: prime does. A backend tells prime how to reach or launch its kernel, tells the
kernel how to reach the tool proxy, and moves files across whatever boundary separates
the kernel's filesystem from the host's. ES modules with `.d.mts` types, like
`runtime/daytona/`:

```js
import { createKernelBackend, PlacedKernelBackend, startIdleSweep } from "<HARNESS_ROOT>/runtime/kernel/index.mjs";
```

### The contract (`backend.d.mts`)

`KernelBackend.open(ctx: KernelContext)` returns a `KernelSession`:

| part | meaning |
| --- | --- |
| `primeEnv`, `primeCwd` | merged into prime's environment (always includes `HARNESS_MCP_PROXY` and `HARNESS_EGRESS_TOKEN`) and its `--cwd`. Known at `open()`, so prime starts in parallel with the kernel side. |
| `ready` | settles when the kernel side is reachable; rejects with the reason if it never will be. Every file method waits on it. |
| `putInput`, `listOutputs`, `readOutput`, `files` | attachments in, `outputs/` out, and workspace files for tools that take or return one (`WorkspaceFiles`). |
| `workDirAliases` | other absolute spellings of the work dir the kernel may use (a sandbox's own). |
| `restored` | how many workspace files were put back because the sandbox was recreated. |
| `scheduler`, `schedulerPollMs` | `runtime/scheduler.py`, run where this kernel's jobs are. |
| `release()` | prime exited: release sandbox resources (never a stop that could race the next open). |

Optional backend verbs: `start` (once at host startup, e.g. warm a pool), `destroy`
(the conversation was deleted), `sweepIdle`, `drain` (shutdown began), `shutdown`.
`KernelContext` carries the conversation's ids, its host dirs (`convDir`, `workDir`,
`tmpDir`), the shared api tree and skill roots, the egress token, the proxy path and
loopback base URL, an optional `timeZone`, `placement` and `restoreFiles()`.

### The backends

| name | kernel | files |
| --- | --- | --- |
| `local` (`LocalKernelBackend`) | prime's own ipykernel under srt with `posture.mjs`: reads only this conversation's dirs, writes only its work dir and scratch, loopback only, env from the allow-list. macOS only. | the host's own disk; nothing moves. |
| `local-unsafe` | the same with `HARNESS_KERNEL_SANDBOX=off` said explicitly. Throwaway smoke tests only. | the host's own disk. |
| `daytona` (`DaytonaKernelBackend`) | one sandbox per conversation through `runtime/daytona/provider.mjs`; prime speaks one WebSocket to it via a connect file (`pending` until the sandbox is up, then the URL/token, or the error). The egress token never enters the sandbox. | uploaded and read through the sandbox's file API. |

`createKernelBackend({ name, kernelPython, ... })` picks one and refuses what this
machine cannot run safely (`local` off macOS, `daytona` without `DAYTONA_API_KEY`)
instead of degrading to no boundary. Every backend installs harness's startup hooks and
the prelude (`prelude.mjs`); an app adds its own IPython startup files with
`extraStartupFiles: { "07-name.py": source }`. Logging goes to an injected
`log: { info, warn }`.

**Warm pool** (`daytona-pool.mjs`, `poolSize > 0`). Sandboxes created ahead of time
with every upload done, labelled `pool=warm` under this host's `poolOwner`. A new
conversation's first open claims one: a relabel (the pool's keys overwritten, since
Daytona merges labels) and a health check in parallel, then the provider is bound to
the sandbox id because label search lags a relabel. A claim waits for a sandbox that
is already warming; a failed or hung warm sends it cold. Leftovers from a previous
process are adopted on start; `drain`/`shutdown` delete what is left.

**Idle sweep and restore.** `sweepIdle` deletes this host's conversation sandboxes
(owner label only, never `pool-*`, never an open conversation) once both the
conversation and Daytona say they have been idle longer than `olderThanMs`; a sandbox
whose conversation is gone goes after a one-hour grace (a subagent's sandbox predates
its record). `startIdleSweep(backend, opts)` runs it a minute after start and every 6 h.
`autoDeleteMinutes` is Daytona's own backstop for a host that is gone. When a
conversation that had a sandbox (a `daytona-sandbox` marker in `convDir`) gets a fresh
one, `ctx.restoreFiles()` (its inputs and latest outputs, from the host's copies) is
uploaded before the kernel is handed over.

**Placement** (`placed.mjs`). `PlacedKernelBackend` routes each conversation to
`cloud` (any `KernelBackend`) or `device` (a `DeviceBackend`: `open`, `destroyFor(userId,
id)`, `shutdown`), by the caller's `ctx.placement`, else the stored one (`lookup`), else
cloud, fixed for the conversation's life. Pool, sweep and drain go to the cloud backend
alone.

### What stays in an app

The harness ships the contract, the placement router, and the cloud backends. An app
keeps what is about its own product: the device backend itself (e.g. a relay over the
app's link to the user's computer), the OS sandbox on that device, its HTTP routes, its
auth and how it mints egress tokens, the tool proxy, where conversations and their
placement are stored (`lookup`, `lastActive`, `isOpen`, `restoreFiles`), and any
startup files that reach app tools (e.g. a `/computer` filesystem shim).

`npm run test:kernel` runs the backend tests against fakes (no Daytona credentials).
