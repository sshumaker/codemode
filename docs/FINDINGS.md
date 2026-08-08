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

## Live: pilot sweep, Sonnet 5, 4 fully-paired tasks

Codemode at L0 (discovery only), vanilla at L4 (all definitions resident).
Paired-only: tasks where both arms completed without timing out.

| | codemode/L0 | vanilla/L4 |
|---|---|---|
| avg turns | 45 | **17.8** |
| avg MCP calls | **48** | 24.3 |
| avg tokens | **947,607** | 1,083,475 |
| avg cost | **$0.418** | $0.520 |
| avg wall | 295s | **151s** |
| judge overall | **4.83** | 4.17 |
| task fulfillment | **4.50** | 3.25 |
| grounding | **5.50** | 4.75 |

Mean cost ratio **1.26x** in codemode's favour; mean turn ratio 0.37x in
vanilla's. Codemode scored higher on 3 of 4 tasks.

**Read this as directional, not conclusive.** n=4 paired tasks is far below the
power needed to separate a half-point on a 10-point rubric, it is one model, and
a single outlier drives much of the gap: on `openapi_explorer_paper_search_*`
vanilla effectively gave up after 2 turns and 4 calls (score 2.33) while
codemode worked 50 turns and 27 calls (score 4.33). Remove that task and the
score difference is within noise.

What does look robust across all four: **codemode does roughly 2x the MCP work
for ~0.8x the cost, and pays for it in turns and wall-clock.**

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
