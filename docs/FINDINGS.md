# Findings

Running log. Numbers are from live runs unless marked as static analysis.

## Static: resident context cost, real 250-tool catalogue

`node bench/residency-report.mjs` — built-in costs measured from the registry,
MCP costs from the real MCP-Bench catalogue (27 servers, 250 tools).

| config | resident tok | vs naive |
|---|---|---|
| vanilla L4 (naive baseline) | **48,041** | 1.0x |
| vanilla L1 (deferred — what Claude Code ships) | **1,839** | 26x |
| codemode L0 (pure discovery) | **156** | 308x |
| codemode L1 | 1,982 | 24x |
| codemode L2 (TOC) | 6,757 | 7x |

Real tool schemas average **188 tokens each** — nearly 3x the synthetic fixture
estimate of 66. Median description is 250 characters, longest 5,360.

**The 308x headline is against a strawman.** Against the deferred baseline a
modern harness actually ships, codemode L2 is 3.7x *more* expensive and codemode
L1 is at parity. Only L0 wins. Confirmed live: the vanilla arm's first turn on an
11-server task billed **35,264 cacheWrite tokens** of tool definitions.

## Live: first grounded comparison

`call_for_papers_000`, Sonnet 5, 11 servers exposed, codemode at L0.

| arm | turns | tool calls | MCP calls | cost | wall |
|---|---|---|---|---|---|
| vanilla/L4 | 7 | 22 | 22 | $0.2489 | 66s |
| codemode/L0 | 24 | 23 | **64** | $0.1964 | 171s |

Codemode: **3.4x the turns, 2.6x the wall time, 21% cheaper, ~3x the MCP work.**

The turn cost is real but it is not discovery — discovery took 2 of 24 turns
(8%): `cat api/INDEX.md`, then `cat api/call_for_papers/INDEX.md`. The remaining
turns were genuine multi-query research: 30+ keyword combinations, dedup by
event link, date parsing, cross-checking locations against European countries —
with results held in variables and only slices printed.

That is the composition advantage behaving as predicted, and it also shows why
turn count and token count move in opposite directions here: codemode spends
turns to save context.

## The mechanism, caught on a real task

`openapi_explorer_paper_search_hugging_face_000` is the clearest single
demonstration in the pilot of what the thesis actually claims.

Both arms needed the same two OpenAPI overviews. `getApiOverview("github")`
returns **182,433 characters**; `getApiOverview("openai")` returns 50,183.

**vanilla** called both as native tools. The results went straight into the
transcript — 89,257 cacheWrite tokens in a single turn, $0.2332 for that one
turn. It then produced an answer and stopped, scoring **2.33**.

**codemode** wrote:

```python
openai_overview = await oe.getApiOverview("openai")
github_overview = await oe.getApiOverview("github")
print(openai_overview[:3000])
```

Both payloads bound to variables; 3,000 characters printed. Peak single-turn
ingestion **3,552 tokens**. It went on to work the task over 50 turns, scoring
**4.33**.

| | vanilla/L4 | codemode/L0 |
|---|---|---|
| turns | 2 | 50 |
| peak single-turn ingestion | **89,257 tok** | **3,552 tok** |
| total cacheWrite | 119,653 | **43,128** |
| total cacheRead | **30,396** | 1,138,851 |
| total cost | **$0.3109** | $0.4667 |
| judge score | 2.33 | **4.33** |

**The context discipline is real and large — 25x lower peak ingestion, 2.8x
lower total write.** But it is partly repaid: codemode's 50 turns each re-read
the accumulated conversation, so `cacheRead` reaches 1.1M and total cost ends up
*higher* than vanilla's on this task, despite writing far less into context.

This is the displaced-bytes exchange rate made concrete. Codemode moves large
payloads out of the transcript into the kernel, then spends turns — and
cache-read tokens — reasoning over them incrementally. Whether that trades well
depends on how much of the payload actually needed to be read, which is exactly
what the residency dial is for.

It also shows why cost alone is the wrong single metric here: vanilla was
cheaper on this task *and* failed it.

## Validity control: the tasks genuinely require tools

A third arm, `notools`, gives the model nothing and asks the same question. Any
task it answers well cannot discriminate the arms, because success there does
not depend on tool use.

Across 9 sampled tasks, every `notools` run scored **exactly 1.0** — the floor
on all six dimensions. Each terminated in a single turn, ~$0.01, with the model
declining rather than fabricating:

> I don't have access to live tools in this session (no web browsing, no API
> calls, no real-time data feeds) ... To be direct: I can't fabricate specific
> rank numbers.

This confirms the `SUBSTITUTABLE_SERVERS` exclusion did its job. Before it, the
Scientific Computing + Math MCP task was solvable by both arms with numpy and
no tools at all; after it, no sampled task is answerable without tools.

It also gives every comparison a calibrated floor: an arm scoring near 1.0 on a
task did not merely do badly, it effectively did not use the tools.

## Result: Sonnet 5, 11 paired tasks

Codemode at L0 (nothing resident but a pointer to `api/`), vanilla at L4 (all
tool definitions resident). Paired-only: both arms completed without timing out
or hitting the budget. `notools` is the validity floor.

| | codemode/L0 | vanilla/L4 | notools |
|---|---|---|---|
| avg turns | 32.4 | **12.8** | 1 |
| avg MCP calls | **49.7** | 22.7 | 0 |
| avg tokens | **649,916** | 900,280 | 2,572 |
| avg cost | **$0.330** | $0.484 | $0.020 |
| avg wall | 323s | **147s** | 24s |
| **judge overall** | **5.18** | 4.65 | 1.00 |
| task fulfillment | **4.60** | 3.60 | 1.00 |
| grounding | **6.60** | 5.60 | 1.00 |

### Paired statistics (n=11)

| measure | mean delta | paired t | sign test | codemode better |
|---|---|---|---|---|
| judge score | **+0.50** | +2.52 | p=0.18 | 7/11 (2 tied) |
| cost saved | **+$0.144** | +2.36 | p=0.23 | 8/11 |
| log cost ratio | **1.40x** (geo. mean) | +2.43 | p=0.23 | 8/11 |
| tokens saved | +243,698 | +1.08 | p=0.55 | 7/11 |

**Read carefully.** The paired t-tests on score and cost clear p<0.05 (|t|>2.23
at df=10), but the sign test — which assumes far less — does not. At n=11 that
is exactly what an underpowered real effect looks like, and it is equally what
noise looks like. Token savings are not significant at all (t=1.08); the
variance is enormous because turn counts differ so much between arms.

### What is solid

- **Codemode is cheaper**: 1.40x geometric mean, better on 8 of 11 tasks.
- **Codemode does more work**: 2.2x the MCP calls for 0.65x the cost.
- **Codemode scores higher on grounding** (6.6 vs 5.6) and **task fulfillment**
  (4.6 vs 3.6) — the two dimensions that measure whether the task was actually
  done, rather than how tidily.
- **Codemode pays in turns and latency**: 2.5x the turns, 2.2x the wall-clock.
- **The tasks discriminate**: every `notools` control scored exactly 1.0.

### What is not established

- Statistical significance by a conservative test. n=11 is too small.
- Anything about other models. This is Sonnet 5 only, so the central prediction
  — that the gap *widens* as the model gets weaker — is entirely untested.
- Whether codemode still wins against a **deferred** vanilla baseline (L1). The
  static analysis says vanilla L1 is 26x cheaper than vanilla L4 on resident
  tokens, so most of codemode's cost advantage here may simply evaporate.
  This is the single most important next run.

## Methodological problems found before spending real budget

### 1. `--tools` is an allowlist, and it silently hid the vanilla arm's tools

`agent-session.ts:8473` filters every tool not named in `--tools`, including
ones registered by an extension. The vanilla arm was therefore running with
**zero MCP tools** while appearing to work — it fell back to `bash` and numpy.

Any run made before this fix is invalid. Fixed by naming all 250 wire names
explicitly in `--tools`.

### 2. Computational tasks let both arms bypass MCP entirely

On `scientific_computing_math_mcp_000` (matrix determinant, eigenvalues,
condition number), **neither arm called a single MCP tool.** Both computed the
answer with numpy.

This is worse than the "answers from parametric knowledge" problem: codemode has
a general-purpose interpreter, so for any task reducible to computation it does
not need tools at all. That measures something real, but not this hypothesis.

Excluded as *required* servers (still fine as distractors, since their
definitions are the bloat under test): Math MCP, Scientific Computing, Unit
Converter, Medical Calculator, Bibliomantic, Car Price Evaluator, Movie
Recommender.

### 3. MCP transport success is not task success

National Parks answers `403` with a well-formed MCP response. The proxy records
`ok: true` because the call succeeded; the payload is an error. Servers needing
credentials we lack — Google Maps, National Parks, NASA Data, BioMCP — are
excluded as required servers, and the sweep report counts content-level errors
separately from transport errors.

### 4. Task pool after filtering

104 total -> 94 runnable (Google Maps won't start) -> **56 grounded**
(34 single, 14 two-server, 8 three-server).

### 5. Wall-clock and turn caps are both biased controls

Codemode uses 2-3x the turns for the same work — vanilla batches parallel tool
calls into a single turn, codemode issues one cell per turn but can make many
API calls inside it. So turns are not comparable units, and a turn cap penalizes
codemode's style. A wall-clock cap does the same: in the pilot, codemode hit the
400s limit on a task vanilla finished in 104s, with 67 turns against vanilla's 9.

The control now is a **dollar budget** (`--max-cost`), applied identically to
both arms. It asks the question the experiment actually cares about — given the
same spend, which arm gets further — and it does not encode an assumption about
which unit of work is the right one.

### 6. Self-inflicted: a `pkill -f run-task.mjs` killed an in-flight sweep run

Verifying a patch, a `pkill` matched the sweep's child process and destroyed one
codemode run. The sweep is resumable (it skips any task/arm with an existing
`result.json`), so re-running filled the gap without re-spending on the other 11.
Recorded because the resumability is what made it cheap to recover, and because
process-name matching is broad enough to catch unrelated work.

### 7. The deferred vanilla baseline (L1) is built but does not work yet

The most important open question is whether codemode still wins against a
*deferred* vanilla arm rather than the naive L4 one. That arm is implemented —
`search_tools` + `load_tool`, where loading a tool activates it and makes it
directly callable, mirroring how Claude Code's ToolSearch behaves — but it does
not currently defer.

Three attempts:

1. **Meta-tools only** (`search_tools`/`describe_tool`/`call_tool`, names hidden).
   Genuinely deferred — first-turn prompt fell to 2,862 tokens — but this is L0,
   not L1, and the model never searched: it went straight to `curl` in bash.
2. **Names in the prompt, calls routed through `call_tool`.** The model
   repeatedly tried to invoke the listed names directly and burned 16 turns on
   errors before timing out. Listing names that are not callable is its own trap.
3. **Names in the prompt + `load_tool` activating the real tool.** Correct
   design, but `pi.setActiveTools()` at `session_start` fires too late to affect
   the first request, and the `--active-tools` CLI flag added by
   `scripts/neutralize-prime.mjs` does not reach the print-mode path. First-turn
   prompt stayed at 21,563 tokens — identical to L4.

**A run labelled L1 that is silently L4 would corrupt every comparison it
appears in**, so `run-task.mjs` now records `firstTurnPromptTokens` and marks a
`residencyViolation` when it exceeds the level's budget; `report.mjs` excludes
violating runs from pairing. The broken L1 run is correctly rejected:

```
violation: L1 first turn carried 21563 prompt tokens (budget 8000)
           — the catalogue was resident, so this is not a L1 run
```

Fixing this means finding where print mode builds its session options and
threading `initialActiveToolNames` through — the SDK already supports it
(`sdk.ts:254`), it is only the CLI path that drops it.

## Setup problems worth recording

MCP-Bench's `mcp_servers/requirements.txt` pins `mcp[cli]>=1.9.0` with no upper
bound. A fresh resolve picks **mcp 2.0.0**, which dropped `mcp.server.fastmcp`
and renamed `McpError` -> `MCPError`: that alone breaks 14 of 28 servers.
`pydantic>=2.12` rejecting `default` alongside `default_factory` breaks 4 more.
`metmuseum-mcp` has no build script and needs a `tsc` its own installer expects
to be global.

Unpinned: **11/28 servers start.** Pinned (`mcp<2`, `pydantic<2.12`, local tsc):
**27/28**, exactly 250 tools. Only Google Maps remains — it speaks HTTP rather
than stdio and needs a billing-enabled key.

## Generator bugs caught by real data

- **Server names contain spaces.** `OpenAPI Explorer` produced a package
  directory that is not importable Python. Adversarial fixtures caught
  reserved-word *parameters* but never imagined spaces in *server* names.
- **Anthropic tool names must match `^[a-zA-Z0-9_-]{1,64}$`**, so qualified
  names need sanitizing and length-capping. All 250 now fit in 46 characters
  with no collisions.
- **Seven real tools ship an empty description.** They render, but would be
  near-invisible in an L2 TOC.
