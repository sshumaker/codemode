# codemode

**An agent runtime that is code-first and built to be hosted.** It comes with a
controlled experiment that measures both claims.

Codemode makes two bets, and each one makes the other cheaper:

1. **The agent writes code, not tool calls.** Codemode gives the agent a
   persistent Python kernel and compiles every tool (MCP server, OpenAPI spec, SDK)
   into a typed, importable module. The agent doesn't emit one JSON tool call per
   turn and get the whole result back in its context. It writes a program instead:
   it loops, filters, keeps state in variables and prints only what matters.
2. **The harness runs remotely, not on your laptop.** A local harness like Claude
   Code has it easy: it can hold a process open on your machine for as long as it
   likes. A hosted runtime serving many users can't pin a VM for 30 minutes while a
   build runs. It has to release compute while it waits, survive losing the
   machine, and keep agent-written code away from its credentials. Codemode is
   designed around those constraints. Long work is a durable job, a wait ends the
   turn instead of blocking, and the session is rebuilt from disk when a scheduler
   wakes it, possibly on a different machine.

On matched tasks (Opus 5, paired):

| | codemode | same harness, tool-calling | Claude Code |
|---|---|---|---|
| cost / task | **$0.21** | $0.83 (4.0×) | $1.02 (2.3×, held-out) |
| first-turn context | **~5k tok** | ~101k | ~106k |
| accumulated context | **115k** | 988k | 921k |
| wall-clock / task | **61s** | — | 88s |
| score | tie | tie | tie (44/46 vs 44/46 held-out) |

**→ [Read the technical report](https://executionatscale.org/codemode/codemode.html)**.
It covers why it works, how it's built, what it costs and what we learned. The
source is [`docs/codemode.html`](docs/codemode.html).

### On benchmarks

Let's be honest: the benchmarks we all use are kind of questionable, and you can
benchmaxx any of them by hill climbing. We hit plenty of that here:

- Reference answers that are wrong. A TheAgentCompany task expects 4 meeting rooms
  when the correct answer is 5, so both arms got it right and both scored 0.
- Bugs inside the benchmark itself. One MCP-Bench server percent-encodes the slash
  in every id it looks up ([write-up](docs/MCPBENCH-HF-ENCODING-DEFECT.md)).
- Run-to-run noise as large as the effects people report. An identical config
  scored 8/8, then 3/8 on a re-run.

So don't read the numbers above as a leaderboard claim. Score is reported as a tie
because these suites saturate. Cost and context are reported because they actually
move. The configuration was confirmed on 46 held-out tasks it was never tuned on.

What we trust more is that the approach has held up **across benchmarks**: AppWorld,
MCP-Bench, terminal-bench and TheAgentCompany. Each has different failure modes. In
fact, the core concepts, and some parts of this stack, have been applied to a
production harness at a frontier lab.

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

## Why a remote harness is harder, and how codemode handles it

Backgrounding a long task is easy. Coming back to it reliably is the hard part. On a
real 25–40 minute CompCert build, Claude Code backgrounded the build and polled it.
Then it ended its turn with "I'll continue when it lands." There was no next turn,
and the task failed. Codemode makes "come back to it" a primitive:

```python
jobs.submit("cd /tmp/CompCert && make -j$(nproc) all", name="build", max_runtime="4h")
jobs.wait(wake_after=900)   # ends the turn; the host is released

# a later turn, possibly in a fresh process on another machine
j = jobs.get("build"); print(j.done, j.ok)   # True True
```

`wake_after` is a deadline, not a sleep: the session wakes the moment the job
finishes. Each hosting problem has a matching part of the design:

- **Release compute while waiting.** `wait` ends the turn instead of blocking. A
  job is a file-backed process with a bounded lifetime, so the VM can be torn down
  while it runs. Under the scheduler, the full CompCert build ran end to end with
  six wakes and about 13 short-lived harness processes, for $0.39. Nothing was held
  open.
- **Survive losing the machine.** Between turns, the only durable state is what's
  on disk: the transcript, the jobs manifest and the artifacts. Everything else is
  rebuilt from it. In a live test, the kernel was SIGKILLed mid-task with two jobs
  running. The fresh kernel's death notice said what survived, and the agent
  collected both jobs, each run exactly once (10/10 checks, $0.07 per run). The wake
  scheduler is about 200 lines. It gets single-writer leases and exactly-once wakes
  from files rather than from coordination between processes.
- **Keep secrets away from code the model wrote.** The agent loop holds the real
  credentials and runs harness-side. Every cell runs in an OS sandbox with no
  network and an allow-listed environment. The only way out is an egress proxy that
  injects each upstream's credentials at the boundary and audits every request.
  There's deliberately no route to the model provider. `spawn()` is the only way to
  get more model calls, and it's metered and leaves a transcript.
- **Place kernels anywhere.** Kernel backends cover a local sandbox, one
  [Daytona](https://daytona.io) sandbox per conversation (with a warm pool, idle
  sweep and file restore), and placement on the user's own device.

The two bets compound. Splitting the agent loop from its execution environment
means every action pays a trip across that boundary. A tool-calling agent making
~40 calls per task pays it about 40 times. Codemode takes one action per turn and
about 9 turns per task, so it pays about 9 times. Rebuilding the loop from the
transcript on every wake is also nearly free when each turn is one code cell plus
what the code chose to print, instead of a 100k-token catalogue re-read. The
properties that make codemode cheap per task also make it cheap to host.

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
| **Remote kernel** (`scripts/patches/remote-kernel/`) | The agent loop drives a kernel inside a sandbox over one WebSocket. Frames are numbered and acknowledged, so a reconnect replays what was lost. File tools and tool calls go through the same socket, so the sandbox needs no egress. |

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
