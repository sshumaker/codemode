# Code is all you need — experiment design

## Hypothesis

Replacing a conventional tool registry with a single persistent code-execution
tool improves agent task performance, and the effect grows as the model gets
weaker.

Two mechanisms, deliberately *not* separated in this experiment (see "Cut scope"):

1. **Context/discovery** — tool definitions don't occupy context; intermediate
   results stay in the kernel namespace rather than the transcript.
2. **Action representation** — code is massively represented in pretraining,
   whereas tool-call JSON is a thin post-training veneer. (CodeAct, ICML 2024:
   up to +20pp, effect strongest on weaker models.)

## Arms

Exactly two. One codebase, one switch.

| Arm | Tool registry |
|---|---|
| `vanilla` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `codemode` | `ipython` |

Base: `PrimeIntellect-ai/prime-agent` @ `a18809e`, which is `badlogic/pi-mono`
@ `e47b8e3` with the tool registry swapped.

**Direction matters.** We restore pi's seven tools *onto prime*, rather than
adding ipython to pi. The fork drifted beyond the registry (`agent-loop.ts`,
`agent.ts`, `types.ts`, `proxy.ts` all differ; prime added `agent/src/harness/`,
dropped `node.ts` and `stream-fn.ts`). Building both arms on prime holds the
loop, provider layer, and session handling constant by construction.

Prime already ships `bash.ts` and `edit.ts` in `core/tools/` **unregistered** —
`allToolNames` is `Set(["ipython"])`. Arm `vanilla` re-registers those two and
ports `read`/`write`/`grep`/`find`/`ls` from pi (same author, same `ToolDef`
interface).

`sdk.ts:254` already parameterizes the active set via `options.tools` /
`allowedToolNames`, so the arm switch does not require forking the registry —
only supplying the missing five implementations.

## Models

`opus-5`, `sonnet-5`, `glm-5.2` — a capability gradient. The sharp prediction is
that the arm gap *widens* as capability drops. Models are a second factor, not
additional arms: 2 arms x 3 models = 6 runs per benchmark.

Routing: Anthropic direct for Opus/Sonnet (predictable prompt caching, which
matters a lot when arm `vanilla` re-sends seven tool defs every turn and arm
`codemode` re-sends one). OpenRouter for GLM-5.2, provider **pinned**
(`allow_fallbacks: false`) and resolved backend logged per request — unpinned
routing spans ~95 backends at varying quantization.

## Cut scope

- **No 2x2 ablation.** Mechanisms 1 and 2 stay fused. Two arms only.
- **No permission/sandbox handling.** Test rig, trusted inputs.
- **RLM off in both arms** (see `docs/prime-teardown.md`).

## Subagents

Required in both arms, sharing one implementation, so only the invocation
surface differs:

- `vanilla`: a `task(prompt)` tool returning text into the transcript.
- `codemode`: `result = await spawn(prompt)` in the kernel, returning a value.

Same child model, step cap, token budget, and system prompt. **Fresh kernel per
subagent, serializable handoff only** — sharing the parent namespace destroys
token attribution, races on concurrent children, and lets a child crash corrupt
the parent.

Replaces prime's `rlm.run()`, which is detached (returns a handle "once its task
is admitted") and therefore needs the `rlm-heartbeat` / `agent-message`
coordination machinery.

### Names

`name=` is required, not optional (cf. `threading.Thread(name=...)`,
`asyncio.create_task(name=...)`). It is what appears in `ps`, in
`list_subagents()`, and in completion notifications; unnamed subagents make all
three unreadable. `vanilla`'s `task()` tool carries the same required
`description` field.

### Completion notifications

Hard constraint: **the model only exists at turn boundaries.** A done-callback
fires in the kernel event loop while no model is running, so it can mutate state
but cannot inform anyone. Signals are worse. Completion must land somewhere the
model reads.

Push a line, pull the detail — progressive disclosure applied to notifications:

- On child exit the harness injects one line into the parent's next turn:
  `subagent "test-fixer" exited 0 after 45s -> <session_dir>`. ~15 tokens.
- Full transcript and output stay on disk, read only if the parent cares.
- Events also append to `events.jsonl` in the run dir, so a parent that missed
  one (kernel restart) can grep its own event log — same recovery story as the
  conversation log.

Identical in both arms, or the comparison breaks.

**Prior art: Claude Code already does this.** Background `Bash`, background
`Agent` spawns, and a completion notification injected into the parent's next
turn. Push-notification is a validated pattern, not a speculative one.

The claim is therefore *not* that async steerable subagents are novel —
`SendMessage` addresses a running agent by name, which is stdin injection under
another spelling. The narrower and true claim is about representation cost:
Claude Code spends nine tool definitions (`Agent`, `SendMessage`, `TaskCreate`,
`TaskGet`, `TaskList`, `TaskOutput`, `TaskStop`, `TaskUpdate`, `Monitor`) on
what `codemode` expresses as one module — and gets `asyncio.gather`,
conditionals, retries, and pipes for free rather than by design.

### The vanilla baseline must not be a strawman

Claude Code's Task tools are **deferred**: names resident, schemas fetched on
demand via `ToolSearch`. That is progressive disclosure, converged on
independently — `ToolSearch("select:TaskStop")` is `grep api/` with a bespoke
API instead of a filesystem. It sits at roughly L1 on the residency dial.

So the mainstream tool-calling harness has already moved off L4, and pinning
`vanilla` there would be a strawman. **Run `vanilla` at both L4 and
L1-deferred.** This is the same dial, not a new arm. If `codemode` beats naive
L4 but only ties deferred L1, that is the finding.

## Documentation is the tool schema

The two arms carry identical information in different containers:

| | `vanilla` | `codemode` |
|---|---|---|
| container | JSON Schema tool definition | `api/` file: docstring + type hints |
| delivery | injected every turn, unconditionally | pulled on demand |
| discovery | none needed — always resident | `grep` / `ls` / `cat` over `api/` |

### The `api/` tree

The MCP catalog is rendered to disk as real Python modules. Files *are* the
modules, so `grep`, `import`, and `help()` all read the same text and cannot
drift:

```
api/
  INDEX.md                 one line per server
  linear/
    INDEX.md               one line per tool
    __init__.py            re-exports -> `import api.linear as linear`
    list_issues.py         full docstring + type hints
    create_issue.py
```

Three disclosure levels with a measurable cost gradient: `ls api/` ->
`cat api/linear/INDEX.md` -> `cat api/linear/list_issues.py`. Instrument which
files are read, at what token cost, before which call — this measures discovery
cost directly rather than inferring it from totals.

Introspection (`help()`, `dir()`) still works and is worth mentioning in the
preamble, but `grep` is the primary entry point: `dir()` requires already
knowing the module name, which is the chicken-and-egg problem at 250 tools.

**The `api/` tree is not arm-neutral.** In `vanilla`, MCP tools must be native
tool definitions resident in context — that is the bloat condition being
baselined. Same catalog, two renderings.

### Residency is a dial, not a switch

How much of the catalog sits resident in the system prompt is a continuous axis,
and `vanilla` is simply its endpoint:

| level | resident in prompt | est. tokens |
|---|---|---|
| L0 | nothing; `ls api/` to discover | 0 |
| L1 | server index only (28 lines) | ~300 |
| L2 | full TOC: every tool, one line, signature + summary | ~4k |
| L3 | top-K inlined fully + TOC for the rest | ~4k + K*100 |
| L4 | every tool as a full JSON schema (= `vanilla`) | ~15k |

The ~15k anchor is Anthropic's reported tool-definition cost per call.

**Selection leaks.** Preloading the tools the benchmark happens to need gives
`codemode` an oracle. Any top-K must be derived from a disjoint task set. The
default is therefore **L2, generated mechanically from the `api/` tree — every
tool, no selection** — which is free, since the generator already walks the tree.
L3 is a follow-up, not a default.

**Deflationary hypothesis worth testing.** A TOC line is ~15 tokens; a JSON tool
definition is 60-150. L2 is a 4-7x reduction against L4 while removing nearly
all discovery latency. If that accounts for most of the token win, the savings
come from schema->TOC compression rather than lazy loading — obtainable without
a REPL, by writing terser tool descriptions. Claim 2 would then have to carry
the entire quality delta.

This recovers the mechanism split lost when the 2x2 was cut, cheaply: L0-L4
differ **only by a preamble string**. No new implementations, no new arms.

**Calibration pass.** Run L0/L1/L2/L4 on one model (Sonnet 5, mid-gradient) over
the pilot subset, pick the level, lock it for the 2-arm x 3-model matrix. Costs
one model's runs and pre-empts both symmetric objections: that `codemode` was
handicapped by cold-start discovery, or that its preamble was hand-tuned.

### Measured residency, before any model call

`node bench/residency-report.mjs 250` — built-in costs measured from the real
registry, MCP costs from a synthetic 250-tool catalogue:

| config | builtin | mcp | resident | vs naive |
|---|---|---|---|---|
| vanilla L4 (naive baseline) | 1041 | 16503 | **17544** | 1.0x |
| vanilla L1 (deferred — Claude Code) | 13 | 1249 | **1262** | 13.9x |
| codemode L0 (pure discovery) | 156 | 0 | **156** | 112.5x |
| codemode L1 (names resident) | 156 | 1249 | **1405** | 12.5x |
| codemode L2 (TOC resident) | 156 | 5500 | **5656** | 3.1x |

**Pre-registered finding: the 112x headline is against a strawman.** Measured
against the deferred baseline a modern harness actually ships, codemode L2 is
**4.5x more expensive**, and codemode L1 is roughly at parity (1405 vs 1262).
Only codemode L0 wins on tokens, at 8x.

Three consequences for the run plan:

1. **Codemode must run at L0 to win the token argument at all.** L2's TOC, at
   ~22 tokens per tool over 250 tools, costs more than simply listing names and
   fetching schemas on demand.
2. **L0 buys those tokens with turns.** Cold-start discovery on every task is
   latency and turn count, which is precisely the cost the success-rate and
   turn-count metrics must capture. The token column alone will mislead.
3. **The quality claim has to carry the result.** If tokens are roughly a wash
   against a deferred baseline, then Claim 2 — code as a better action
   representation than JSON — is what the experiment is actually testing. Size
   the pilot for statistical power on success rate, not on token deltas.

### Fairness: one source, two renderings

The generator is the fairness mechanism. MCP schema -> one description ->
rendered into both a JSON tool definition (`vanilla`) and an `api/` file
(`codemode`). Single source, two containers, diffable when either changes.
Otherwise the experiment measures whose prose is better, not which architecture
is better.

Only harness-native capabilities (subagents, file ops) need the matched pair
applied by hand.

Two consequences:

**1. Docstring quality is not cosmetic — it is the arm's tool documentation.**
Every function reachable from the kernel namespace needs a complete docstring:
purpose, args, returns, raises, and a worked example. A thin docstring
handicaps `codemode` in a way that has nothing to do with the hypothesis.

**2. Fairness rule: the two containers must be semantically matched.** The
docstring for `spawn` and the JSON description for `task` must say the same
things. Otherwise the experiment measures whose prose is better, not which
architecture is better. Concretely: write the description once per capability,
then render it into both containers, and diff them when either changes.

For MCP tools this is automatic — `mcp_base.py` generates modules from the
server's own `description` field and JSON Schema, so both arms inherit the same
upstream text. Only harness-native capabilities (subagents, file ops) need the
matched-pair discipline applied by hand.

**3. This yields the cleanest measurement of the progressive-disclosure claim:**
documentation tokens *actually consumed* (codemode) versus documentation tokens
*always resident* (vanilla). Log both. If codemode's agents rarely call `help()`
and still succeed, the always-resident definitions were largely dead weight,
which is the claim stated precisely.

The `codemode` system prompt therefore needs a small fixed preamble pointing at
the discovery entry points (`dir()`, `help()`, the module list). That preamble
is a real, permanent context cost and must be counted against codemode's
savings rather than treated as free.

## Central metric: displaced bytes

The thesis is not "code mode uses fewer tokens" — it is that code mode
*relocates* context from the transcript into a kernel namespace. The open
question is the exchange rate.

Instrument per turn:

- message-history tokens (both arms)
- kernel namespace size via `%whos` (codemode only)
- turns, wall-clock, cost, task success

If `codemode` wins on transcript tokens while the namespace balloons, context
wasn't eliminated — it moved somewhere the model has strictly worse access to,
and the win is fragile. A win with a *small* namespace is the real result.

### Known failure modes to watch

1. **No self-introspection.** The model's only record of what's bound is the
   transcript of code it wrote. Forgetting a variable means silently re-fetching
   and paying twice while the token counter still looks good.
2. **Compaction desync.** Compacting the transcript does not compact the
   namespace. Partially mitigated upstream — see `prime-teardown.md` on the
   conversation-log path and `<ipython_kernel_reset>`.
3. **Non-monotone cost.** Re-reading a variable is free, but *rediscovering* it
   costs a turn. Turn count and token count can move in opposite directions.

## Sandboxing

Not on the critical path for this experiment, and the wrong reasons for picking
one would invalidate it.

**Sandboxing by changing the action language destroys the measurement.** The
hypothesis is that code beats JSON *because of pretraining volume*. Swapping
Python for TypeScript-in-a-VM moves the independent variable, so a null result
becomes uninterpretable.

Ordered by distribution shift rather than isolation strength:

| option | isolation | shift | bash | notes |
|---|---|---|---|---|
| microVM (Firecracker/gVisor) | strong | none | yes | real Linux + CPython; ~100-500ms boot, poolable |
| container + seccomp | medium | tiny | yes | cheapest option that changes nothing |
| Pyodide (CPython -> WASM) | strong | medium | **no** | real Python, MEMFS, JupyterLite gives a true IPython kernel |
| JS/WASI + virtual FS | strong | large | **no** | changes the experiment |

**Observed constraint:** in both smoke tests Sonnet 5 opened its cell with
`%%bash` and ran a shell command rather than writing Python. A sandbox without
bash does not merely remove a feature — it changes what the agent does. That
disqualifies Pyodide here despite being otherwise the most elegant fit.

**Decisive practical constraint:** MCP-Bench's 28 servers are local processes
making outbound calls (Wikipedia, NASA, HuggingFace, arXiv). A no-network
sandbox breaks the benchmark outright, so isolation can only cover the host
filesystem and process table. Container-with-host-network is the fit; the threat
model is "the model does something careless," not a determined attacker.

Decision: container now, microVM if this ever runs genuinely untrusted code,
Pyodide only if browser/serverless distribution is needed.

### A TypeScript arm is a good probe, not a good sandbox

If the mechanism is pretraining coverage, it predicts a three-point ordering:
**Python > TypeScript > JSON tool calls** — Python has far more notebook and
script data than TypeScript has agentic-script data, and both dwarf tool-call
JSON.

The two-arm design cannot test that. A TS-REPL arm could, and if TS landed
*below* JSON the pretraining story would be wrong and something else would have
to explain CodeAct's results. Same infrastructure, different action language;
sandboxability becomes a side benefit rather than the motivation.

File as a third arm after the Python-vs-JSON number exists, not before.

## Benchmark

MCP-Bench first (250 tools / 28 domains — where tool-definition bloat bites
hardest). Pilot on a fixed ~40-task stratified subset for harness shakeout and
an effect-size estimate before committing Opus budget to the full set.

## Repo layout

```
vendor/prime-agent   upstream @ a18809e, pinned
vendor/pi-mono       upstream @ e47b8e3, pinned (source for the 5 missing tools)
bench/               benchmark adapters + runner
docs/                design, teardown notes
```
