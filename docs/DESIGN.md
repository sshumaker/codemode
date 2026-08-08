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
coordination machinery. Blocking `spawn` is the arm-symmetric primitive.

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
