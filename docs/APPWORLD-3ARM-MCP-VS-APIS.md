# AppWorld 3-arm: MCP vs. APIs — architecture & plan

Reference writeup, captured while wiring the claude-code arm. The thesis, how the
AppWorld harness works, where the arms diverge, and what still needs building.

## 1. The thesis, stated precisely

We are comparing **one tool surface in three representations**, on long-horizon
AppWorld tasks:

| arm | representation | how it reaches the world |
|---|---|---|
| **codemode** | MCP translated into importable `api/` Python files; the agent writes code that imports and calls them | prime kernel → `env-server /call` |
| **vanilla** | the same MCP tools as **JSON tool-calling** | prime → `env-server /call` (via `bench/arms/mcp-tools-extension.ts`) |
| **claude-code** | the same tools consumed as **native MCP** by the real product | Claude Code ↔ AppWorld MCP server |

The core question is **MCP vs. APIs**: does handing an agent the tool surface as
*code it imports* (codemode) beat handing it the surface as *MCP tool-calls*
(vanilla, and the real Claude Code)? codemode is literally "MCP compiled to api
files" — so the shared source of truth for all three arms is AppWorld's MCP tool
definitions.

The long-horizon angle matters because AppWorld tasks make many API calls (the
stratified median is ~11 calls, the high stratum ~100), and cost ≈ actions × context
— which is exactly where code's "the caller decides what survives each call" beats
tool-calling's "every result enters context verbatim."

## 2. How the AppWorld harness works (ours)

- **`bench/appworld/run-task.mjs <env-file> <model> <task-id> <arm>`** runs one task
  through one arm. Arms today: `codemode | vanilla | notools`.
- **`bench/appworld/env-server.py`** holds ONE task world behind HTTP:
  - `POST /call {server, tool, args}` → `{ok, text}` — the ONE transport both prime
    arms use. Dispatches through `world.execute("print(apis.<app>.<api>(**args))")`,
    which is exactly what upstream's function-calling agent does.
  - `POST /execute {code}` → for the native-control arm.
  - `POST /evaluate` / `GET /snapshot` → the grader report / world diff.
  - **Why one transport:** on MCP-Bench, 78% of the vanilla arm's bash calls were
    `curl` straight past its own tool surface. Making one HTTP endpoint the only way
    to reach the world killed that confound and gives one log (`env-calls.jsonl`) of
    every call. **This is the fairness invariant the claude-code arm must respect.**
- **`bench/appworld/sweep.mjs <env-file> --tasks a,b --arms codemode,vanilla`** — the
  sweep entry. `--sample N --split <name>` draws a fixed-seed sample from a split;
  `--repeat N` for paired cells. Task ids are read out of AppWorld, not hardcoded.
- Grading is AppWorld's own verifier on the resulting world state (`raise_on_failure=
  False`, matching upstream). Same grader for every arm.

## 3. AppWorld HAS native MCP — this is the claude-code path

Confirmed in the vendored tree:
- `vendor/appworld/pyproject.toml` ships an `[mcp]` extra (`mcp>=1.19.0`); the
  dockerfile installs `appworld[mcp]`.
- `vendor/appworld/src/appworld/serve/_mcp.py` — the MCP server. `build_mcp_config`
  builds the connect config; supports **stdio and http** transports.
- `vendor/appworld/scripts/generate_mcp_config.py` — emits the `mcpServers` JSON to
  connect a client (Claude etc.); `scripts/call_mcp_server.py` — a probe client.
- `vendor/appworld/images/claude-mcp.png` + an `openai_agents_mcp_agent` config —
  **AppWorld officially documents connecting Claude via MCP.**

So the claude-code arm is not a hand-rolled bridge: point Claude Code at AppWorld's
MCP server (its native extension mechanism, `--mcp-config`). That is the honest "real
product" arm — Claude Code using MCP the way a user actually would.

## 4. The fairness design question (the one real decision)

codemode/vanilla reach the world through OUR `env-server` (one logged transport, one
world instance, our `env-calls.jsonl`). AppWorld's native MCP server is a DIFFERENT
process managing its OWN world. Two ways to make claude-code fair:

- **(A) Use AppWorld's native MCP server** for the claude-code arm. Lowest
  integration cost, it's the officially-supported path. Requirement to be fair: the
  arm must load the **same task instance** and be graded by the **same AppWorld
  verifier** on its resulting world — different transport, identical task + grader.
  Logging is AppWorld's `api_calls.jsonl`, not our `env-calls.jsonl` (acceptable; the
  grader reads world state, not our log).
- **(B) Wrap OUR env-server as an MCP server** so claude-code hits the exact same
  transport/world/logging as the other two arms. Maximal fairness, more work.

**Recommendation:** start with (A) — validate on ONE challenge task, read the
trajectory end to end, confirm the grader sees Claude Code's world and that Bash is
not being used to `curl` past MCP. Fall back to (B) only if (A) diverges on world
identity or grading. Either way, Bash-bypass is the thing to watch in triage (the
MCP-Bench lesson).

### 4.1 What was built: (A), plus (B)'s logging

(A) turned out to give world identity for free, because AppWorld's remote-APIs mode
is exactly the mechanism the MCP server already uses:

```
appworld serve apis            <- the task's databases, behind HTTP
   ^                     ^
   | POST /dbs           | every API call
   |                     |
env-server.py         appworld serve mcp (stdio)
--remote-apis-url          ^
binds + grades             | MCP
                      claude -p --mcp-config
```

`AppWorld(remote_apis_url=...)` POSTs `/dbs` and points the APIs server at THIS
task's databases (`requester.py:374`); the MCP server loads its `ApiCollection`
with `skip_setup=True` against the same URL (`serve/_mcp.py:314`), so it reads the
world we bound rather than rebinding it. Grading is unchanged: `save_state()` /
`evaluate()` go through `save_remote_dbs` and write the same on-disk `dbs/` every
other arm is graded from. So the arm is (A) — upstream's own MCP server — with (A)'s
world-identity concern closed rather than accepted.

The one thing (A) does lose is logging, so the runner takes it back: a recording
reverse proxy sits between the MCP server and the APIs server, and `env-calls.jsonl`
exists for this arm too, with the same fields and the full response body. World setup
and grading address the APIs server *directly*, so everything the proxy saw is by
construction an agent-initiated call. That also makes `apiCalls` comparable across
all three arms rather than "MCP tool calls the agent reported making".

## 5. Ramp methodology (do NOT run it all at once)

Per project CLAUDE.md + the scout runbook (`docs/SCOUT-terminal-bench.md` §2.3):

1. **Oracle/known-good screen first** — cheap admission that the task + grader work
   before spending on any arm.
2. **Ratchet 1 → 3 → 5 → 10 → …**, reading EVERY trajectory end to end at the small
   sizes. Triage each failure into agent / harness / grader / integration.
3. **Fix harness gaps as they surface** (this is expected — e.g. the `tokenize`
   shadowing bug the terminal-bench ramp found). Iterate; don't just tabulate.
4. **Sample on the axis under test** — long-horizon. Prefer the challenge split and
   high-call-count tasks; don't hillclimb on the fast subset.
5. **Rank by score/fulfilment; cost as tiebreak.** Report behavior + cost primary,
   score underpowered (AppWorld scores are noisy — an identical config re-run scored
   8/8 then 3/8). Always the paired t-test + sign test (`bench/stats.mjs`).
6. **A0 every run** — a broken arm is not a data point.

## 6. Status

Built, and validated on one challenge task. **Nothing beyond one task has been run.**

```bash
node bench/appworld/run-claude-code.mjs <env-file> anthropic/claude-opus-5 <task-id>
node bench/appworld/sweep.mjs <env-file> --tasks a,b --arms codemode,vanilla,claude-code
```

- `bench/appworld/run-claude-code.mjs` — the arm. Starts the APIs server, the
  recording proxy and `env-server.py --remote-apis-url`, generates the MCP config,
  runs `claude -p --mcp-config --strict-mcp-config`, grades through the same
  `/evaluate`, and writes the same `result.json` shape.
- `bench/appworld/env-server.py --remote-apis-url` — the one AppWorld-side change.
- `prompts.mjs` `CLAUDE_VARIANTS.c1` — matched to vanilla `b1` clause for clause,
  differing only in the `mcp__appworld__<app>__<api>` prefix the agent cannot guess.
- `bench/test/appworld-fairness.test.mjs` — 12 invariants for the arm, all executed.
- `sweep.mjs --arms claude-code` dispatches to the new runner, so the ramp still goes
  through one entry point.

**Validation, `5238afc_1`, Opus 5**, run twice — the second on the shipped code, after
a `distinctApis` fix (`.run/appworld/5238afc_1__claude-code__L4__c1__anthropic-claude-opus-5`,
first run archived alongside it):

| | run 1 | run 2 (shipped) |
|---|---|---|
| grade | PASS 7/7 | PASS 7/7 |
| turns / tool calls / API calls | 12 / 34 / 34 | 12 / 36 / 36 |
| distinct APIs / dupes | 12 / 2 | 13 / 3 |
| ctx0 | 105,570 | 105,570 |
| output tokens | 7,542 | 8,312 |
| cost / wall | $1.5656 / 128s | $1.5976 / 125s |

MCP connected, 469 tools advertised, built-ins `Edit,Read` only, zero non-MCP tool
calls, zero permission denials, zero tool errors, in both. The two runs solved the
task by different routes (delete-and-re-add vs a wish-list round trip) and landed
within 6% on cost, which is well inside the ~27% run-to-run noise this project
measures.

Two A0 checks passed alongside it:
- **residency is real** — ctx0 105,570 sits in vanilla L4's measured 68k–101k band,
  so all 469 schemas genuinely reached turn one. This arm is L4 by construction.
- **no state leaks** — a null control (world bound, no agent, grade) scores **1/7,
  success=False** on the same task, so the 7/7 was earned rather than inherited.
  `.run/appworld/nullcontrol__5238afc_1/evaluation.json`.

The `output` figure is the one worth watching: 7,542 tokens for 34 API calls puts
claude-code squarely in vanilla's 6,174–10,072 band and an order of magnitude above
codemode's 954–1,265, which is what the representation result predicts of any
tool-calling arm regardless of harness.

### Open

- [ ] **Ramp** 1→3→5→10 on the challenge split, all three arms, reading every
      trajectory at the small sizes.
- [ ] **Stratify by ground-truth call count** — this validation task is a ~34-call
      task, and the representation term is proportional to work done ($0.070 low vs
      $0.764 high). One mid-size task cannot speak to either stratum.
- [ ] **Measure the bypass rather than only preventing it**: one `--allow-bash` run
      per stratum, to report what the real product does when it *has* a shell.
- [ ] **Confirm the challenge split's grader trust** (cross-check
      `docs/SCOUT-appworld-challenge.md`).
- [ ] terminal-bench 3-arm stays a secondary venue; claude-code is already wired there.

### AppWorld-side defects found while wiring this

Both produced a hang or a wrong-looking agent rather than an error, which is the
pattern this project keeps meeting:

1. **`appworld[mcp]` resolves to an incompatible `mcp`.** `pyproject.toml` pins
   `mcp>=1.19.0` with no upper bound, and `mcp` 2.0.0 removed the
   `@server.list_tools()` / `@server.call_tool()` decorators `serve/_mcp.py` is built
   on. The stdio server dies on import with `AttributeError: 'Server' object has no
   attribute 'list_tools'` — and a stdio server's stderr goes nowhere, so the client
   just **hangs forever** (`MCPClient` waits on `ready_event` with no timeout). The
   vendored venv is now pinned to `mcp>=1.19,<2` (1.29.0). Anyone rebuilding that
   venv has to redo this.
2. **`build_mcp_config` takes `command` from `shutil.which("python")`**
   (`serve/_mcp.py:54`), i.e. whatever PATH the *generator* had — here
   `/opt/homebrew/bin/python`, with no appworld installed. Same hang, same absence of
   any error. The runner overrides `command` with the venv interpreter and sets an
   absolute `PYTHONPATH`; upstream's `env` is `{"PYTHONPATH": "."}`, relative to the
   client's cwd.

And one in ours, fixed: `sweep.mjs --report` referenced `prewarmResult` from inside
`report()`, which is declared below the `--report` early-exit — so every `--report`
threw a TDZ `ReferenceError` immediately after printing a correct table.

## 7. What is NOT a venue

- **tau-bench / τ³-bench: NO-GO** (`docs/SCOUT-tau-bench.md`). The codemode-vs-vanilla
  signal is ~$0.05/task against ~27% noise, diluted by a large arm-invariant
  user-simulator cost. It structurally cannot discriminate the arms. Not worth the
  spend for this thesis.
