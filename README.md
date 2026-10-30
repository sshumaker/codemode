# codemode

**An agent runtime where the model writes code, not tool calls.** It's built as a
controlled experiment that measures whether that's actually better.

Codemode gives an agent a persistent Python kernel and compiles every tool (MCP
server, OpenAPI spec, SDK) into a typed, importable module. The agent doesn't emit
one JSON tool call per turn and get the whole result back in its context. It
writes a program instead: it loops, filters, keeps state in variables and prints
only what matters. Work that runs longer than a turn, like a 30-minute build, is a
durable job the agent can start, step away from, and collect on a later turn.

On matched tasks (Opus 5, paired):

| | codemode | same harness, tool-calling | Claude Code |
|---|---|---|---|
| cost / task | **$0.21** | $0.83 (4.0×) | $1.02 (2.3×, held-out) |
| first-turn context | **~5k tok** | ~101k | ~106k |
| accumulated context | **115k** | 988k | 921k |
| wall-clock / task | **61s** | — | 88s |
| score | tie | tie | tie (44/46 vs 44/46 held-out) |

**→ Read the technical report: [`docs/codemode.html`](docs/codemode.html)**. It
covers why it works, how it's built, what it costs and what we learned. Clone the
repo and open the file locally, or view it via GitHub Pages.

## Why code beats tool-calling

Models have practiced code from pre-training all the way through post-training.
Tool-calling JSON is a thin dialect added late. The measured savings come from three
separate places:

1. **You load less up front.** A tool-calling agent has to keep its whole catalogue
   resident in context to call any of it, which is about 100k tokens for a few
   hundred tools, paid again on every turn. Codemode reads a module's docs only
   when it's about to use it.
2. **You keep less of what comes back.** With code, the *caller* decides what part
   of a result survives. Forbid a codemode agent from filtering and its context
   more than doubles (+74% cost).
3. **You write less to act.** One compact cell per turn replaces dozens of
   tool-call blocks. Even the no-filtering arm stayed **3.8× cheaper** than
   tool-calling.

Residency is a fixed per-task tax. The representation saving scales with how much
work the task does: on high-call tasks, tool-calling costs **6.6×** as much as
code.

```python
import api.spotify                      # compiled from the MCP schema: typed, documented

liked = await all_pages(api.spotify.show_liked_songs, access_token=st)   # 92 rows, stays in the kernel
lib   = await all_pages(api.spotify.show_song_library, access_token=st)  # 41 rows, stays in the kernel
ids   = {s["song_id"] for s in lib}
print([s["title"] for s in liked if s["song_id"] in ids])                # only 14 titles reach the model
```

## What's in the runtime

| component | what it does |
|---|---|
| **MCP → API compiler** (`bench/generate.mjs`) | Turns schemas into typed async Python (unions, `Literal` enums, required-ness), with call-site validation before a request leaves. Consequential defaults are promoted to required. |
| **Jobs runtime** (`runtime/jobs.py`, `runtime/scheduler.py`) | `jobs.submit` / `jobs.wait` / `jobs.get`. Jobs are file-backed processes that survive kernel death. `wait` *ends the turn* instead of blocking, and a ~200-line scheduler wakes the session when the job finishes. Exactly-once is enforced from disk. |
| **Subagents** (`runtime/subagents.py`, `subagent_broker.py`) | `spawn()` is a job. A harness-side broker starts the child, so the kernel never forks a model loop. Each child gets its own sandboxed kernel and tool grant. |
| **Kernel guards + watchdog** (`scripts/patches/`) | `time.sleep`, `subprocess`, `threading` and long shell commands fail at the point of use, with an error that names the job primitive to use instead. The correction lives in the error, not the prompt. |
| **Read-gate** | The first call to an API is refused until its module has been read. The refusal names the exact lines to read. |
| **Sandbox + egress proxy** (`runtime/posture.mjs`, `proxy/egress/`) | Agent code runs in an OS sandbox with no network except one proxy. The proxy injects credentials at the boundary, so no secret ever exists sandbox-side. It has no route to the model provider. |
| **Kernel backends** (`runtime/kernel/`) | Local sandboxed, or one [Daytona](https://daytona.io) sandbox per conversation with a warm pool, idle sweep and file restore. See [`runtime/kernel/README.md`](runtime/kernel/README.md). |

The agent loop is [prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)
(itself a fork of [pi-mono](https://github.com/badlogic/pi-mono)), vendored and
patched reproducibly by `scripts/`.

## The experiment

Both arms run on one codebase and differ only in the tool surface. Both reach the
world through one logging proxy, so they're scored from identical trajectory
records.

| arm | model-facing tools | catalogue delivered as |
|---|---|---|
| `vanilla` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` + MCP tools | JSON tool definitions |
| `codemode` | one persistent IPython kernel | a greppable `api/` tree of Python modules |
| `claude-code` | Claude Code, run in the same container | its own tools |

Benchmarks wired up: [AppWorld](https://appworld.dev) (417-task challenge split),
[MCP-Bench](https://github.com/Accenture/mcp-bench) (27 live servers, 250 tools),
[terminal-bench](https://www.tbench.ai), and [TheAgentCompany](https://the-agent-company.com).

The methodology is the main point of the repo. It includes paired t-tests and exact
sign tests (`bench/stats.mjs`), multi-sample judging, and fairness invariants pinned
as tests (`bench/test/fairness.test.mjs`). For example, the vanilla arm can't
bypass its tools with `curl`, and both arms get base prompts of matched length.
Negative results are kept with their numbers (`bench/prompts.mjs`). The confounds
that invalidated earlier result sets are written up in
[`docs/FINDINGS.md`](docs/FINDINGS.md) and [`CLAUDE.md`](CLAUDE.md).

## Running it

```bash
npm install
node scripts/port-vanilla-tools.mjs     # restore the tools prime removed (idempotent)
node scripts/neutralize-prime.mjs       # apply the runtime patches (idempotent)
(cd vendor/prime-agent && npm install && npm run build)

npm test                                # JS + Python suites, no API key needed
npm run test:integration                # end to end against a scripted model
```

Live runs read an API key from an env file you point at. It's sourced in a subshell
and never read into the harness. Use `ANTHROPIC_API_KEY` for Claude models, or
`OPENROUTER_API_KEY` / `ZAI_API_KEY` for GLM.

```bash
scripts/setup-mcp-bench.sh && node bench/mcp-schemas.mjs   # MCP-Bench servers, installed locally
npm run iterate -- --variants v7,v10 --judge               # the one iteration command
node bench/report.mjs --paired                             # head-to-head
node bench/inspect.mjs <runId> --mcp                       # every MCP call a run made
```

Every run writes a self-contained directory under `.run/runs/<runId>/` with the raw
event stream, so any analysis can be redone without spending tokens again. See
[`docs/TESTING.md`](docs/TESTING.md) for the test tiers.

## Layout

```
runtime/          the codemode runtime: jobs, scheduler, subagents, kernel backends, sandbox posture
bench/            compiler, arms, benchmark adapters (appworld/, terminal/, tac/), stats, judge, reports
proxy/egress/     credential-injecting egress proxy (Go)
scripts/          reproducible patches against the vendored upstreams
docs/             the report (codemode.html), design, findings, per-benchmark write-ups
vendor/           prime-agent and pi-mono, pinned (MIT)
```

## License

MIT. See [LICENSE](LICENSE). Vendored code keeps its own licenses.
