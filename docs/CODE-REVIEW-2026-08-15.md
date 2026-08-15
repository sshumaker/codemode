# Code review — harness layers over base prime, 2026-08-15

Four parallel review agents over the four layers, each instructed to verify
empirically (generate, execute, reproduce) rather than read; every HIGH finding
below was either reproduced by the reviewer or re-verified by hand against the
raw files before inclusion. Baseline at review time: **471/471 JS, 275/275 Py
green** (one provenance failure was the dist-staleness guard catching a
checkout-refreshed mtime; rebuilt).

Layers reviewed:

| layer | reviewer method |
|---|---|
| `runtime/*.py` + `runtime/eval` | executed the prelude/guards/jobs against live processes |
| `vendor/prime-agent` diff (16 files, ~3k lines) + patch scripts | replayed both patchers on pristine `6142859`, diffed against HEAD |
| `bench/generate.mjs` + enrichment/required-defaults | generated both layouts (503 + 14 files, all compile), then adversarial catalogues |
| base harness inventory | traced the real print-mode process tree, measured the run corpus |

## Verdict in one paragraph

The runtime's *design* is sound and the reviewers found the individual
mechanisms (bash-guard delegation, atomic manifest writes, tombstones,
off-by-default variants, trace re-derivability) genuinely well built. What the
fine tooth comb caught is concentrated in four classes: (1) two bugs that
touched **reported numbers**, (2) a family of **wrong-on-next-use traps** —
patches and compilers that are correct on today's inputs by luck and fail
silently on the next upstream bump or the first non-AppWorld MCP server, (3)
**hosting-correctness holes** in exactly the eviction/recovery paths the cloud
story depends on, and (4) ordinary duplication (five copies of the JSON-stream
collector, twin enrichment programs, three sleep-classifiers with three
thresholds). Separately, the base-harness audit's headline is a reframe: prime
already ships the daemon/session-lease/cron/subagent machinery the cloud
harness needs — the dead weight is elsewhere (interactive UI, upstream tests,
call-home).

---

## P0 — touched reported numbers or spend

**P0.1 `bench/schema-score.mjs:45-46` re-implements `pyIdent` wrong.** Missing
the leading-digit prefix and keyword suffix that `generate.mjs:43-49` applies,
so a tool emitted as `from_` / `t_2fa_verify` misses `byPyName` and scores as
an *invalid tool name* against codemode — depressing `valid_tool_name_rate`,
which feeds MCP-Bench Overall Score. Import the real one. **Action: re-check
any quoted MCP-Bench score after fixing.**

**P0.2 Auto-refine still fires in print mode; neutralize-prime only removes
the prompt injection.** `autoRefine.enabled` defaults true, interval 25 turns,
(`settings-manager.ts:883-898`); print mode force-enables serialized refine
(`main.ts:674`). Verified in our corpus: 78 `harness_state.json` files under
`.run/appworld/` containing learned memories — each written by an unbudgeted
`reviewAutoRefine` model call in runs ≥25 turns (~5% of runs). Small cost/
latency confound on long tasks; state written that nothing reads. Fix:
`autoRefine.enabled=false` in the scratch settings.json (one line), then decide
whether to excise `core/refinement/` (1,018 LOC).

**P0.3 terminal-bench turn counts are a different unit.**
`bench/terminal/prime_agent.py:726-728` counts `turn_end` with no responseId
dedup; `runtime/subagent_run.py:93` increments before its dedup (verified —
the cap its own comment says is "enforced off this number" reads the
double-counted value at `:249`). Five independent JSON-stream collectors exist
(`subagent_run.py`, `bench/run-task.mjs`, `bench/appworld/run-task.mjs`,
`bench/tac/run-task.mjs`, `bench/terminal/prime_agent.py`) with three ctx0
formulas; TAC's has no budget enforcement at all. Cross-benchmark turn/cost
comparisons inherit this skew.

**P0.4 `jobs-manifest.txt` has been empty on every terminal-bench run.**
`prime_agent.py:666-668` globs `jobs/*/meta.json`; `jobs.py:714-715` writes
flat `<name>.json`. The artifact every TB run "logged" was vacuous.

## P1 — wrong on next use (silent, plausible-number class)

**P1.1 Marker collision silently drops the namespace patch on any upstream
bump** (verified by replaying both patchers on pristine `6142859`: the tree
diverges). `neutralize-prime.mjs:447-456` guards namespace-inject on
`"HARNESS_SHOW_NAMESPACE"` — already present in `container-kernel.ts:170`,
injected 20 lines earlier. The script prints `present … :: append live
namespace` — a false success — and the rebuilt harness loses the measured-best
delta-namespace config. The script documents this exact trap for the previous
patch (`:441-444`) and then falls into it.

**P1.2 The container-kernel image fix is dead-lettered.**
`scripts/patches/container-kernel.ts` carries `images?: string[]` + base64
passthrough + `restarted` notice; the vendored tree does not (verified:
`ContainerCellResult` differs). The patch's own marker means re-running can
never propagate it. Root cause of the "codemode arm that could not see images"
incident class.

**P1.3 The whole container-kernel path is dead code** — ~220 lines in
`ipython.ts:759-966`; nothing sets `HARNESS_EXEC_CONTAINER`; the real fix
(`PRIME_AGENT_KERNEL_PYTHON` in-container) replaced it. It also carries real
bugs (no request queue despite claiming one, abort-listener leak, hangs after
kernel exit). **Deleting the patch file + its two `sub()` calls closes P1.1,
P1.2 and P1.3 at once.**

**P1.4 No pristine-replay coherence test.** The dual mechanism (committed tree
+ patcher scripts) has already diverged four ways: P1.1; `neutralize-prime:300`
reverts to a path that doesn't exist (`bench/tac/jobs_runtime.py`); a rationale
comment reverted; `models.generated.ts` (642+/466−, a legit regen — verified —
but tracked by no script, so a bump silently drops `claude-opus-5` from the
catalogue). The missing control: `git archive 6142859` → run both scripts →
`diff -r` against the tree, in `bench/test/provenance.test.mjs`.

**P1.5 The compiler is safe on AppWorld's dialect by luck** (all reproduced on
adversarial catalogues; 471/471 tests still pass because none of this is in a
fixture):
- `"""` in any tool/param description → SyntaxError, whole app module lost
  (`generate.mjs:740-757,789,840`). The sanitizer exists (`requiredDefaultNote`
  `:157`) and is used exactly once. Trailing `\` same class.
- Name collisions undetected: two tools normalizing to one `pyIdent` →
  consolidated: silent wrong-tool shadowing; per-method: one tool vanishes.
  Two *params* colliding → SyntaxError. Fix at `normalizeTool:106-112`.
- Non-string enums: `Literal[true, false, null]` via `JSON.stringify`
  (`pyType:64-70`) — parses (so the `ast.parse` test gate passes), NameError at
  import. Needs `pyLiteral()`; the import-not-parse gate belongs in the test.
- Package-collision dedupe reaches the directory name only; TOC/names/INDEX
  recompute `pyPackage(server)` un-deduped (`:257,:718,:882,:280`) → docs point
  at modules that don't exist. Fix: dedupe at normalize, make `pkg` required.
- Schema `default`s (363 AppWorld params) visible to vanilla, invisible to
  codemode (dropped from signature, docstring, and L4 docs) — an arm asymmetry
  against the fairness invariant.

**P1.6 Guard teaching text is a lambda repr for 13 of 19 guards** (verified —
`_escape` returns a lambda; `_always(lambda: _escape(...))` lacks the `()` the
`_hold` entries have, `kernel-prelude.py:294-298,343-368`). The agent receives
`RuntimeError: <function _escape.<locals>.<lambda> at 0x…>` where the
correction should be — on the escape class (`os.fork`, `os.popen`,
`pty.spawn`…) that nothing else teaches. The message-content test is the fix's
other half: existing tests assert only `assertRaises` + template text.

**P1.7 Background-adoption names collide across cells** (`shell_jobs.py:172`):
every cell restarts at `bg1`; second adoption hits `JobError: already running`,
the shell wrapper ignores `$?`, the banner prints success *before* the cell
runs — the command silently never executes and `jobs.get('bg1')` returns the
previous job. A wrong answer wearing a success message.

**P1.8 Subagents are staged into no container** (`stageJobsRuntime` copies 2
files, `_stage_jobs` 4 — neither includes `subagents.py`/`subagent_run.py`),
while host-side prompt gating (`jobs.py:1453-1460`) evaluates importability on
the *host* — so the prompt can advertise `spawn` the container doesn't have.
Independently confirmed by the TB campaign: every `prelude-status.txt` says
`SUBAGENTS off`. Also: TAC never installs the `harness_unshadow` .pth.

## P2 — cloud-hosting correctness

**P2.1 Eviction hole: a job whose process dies without writing its exit marker
is `running` forever** (`jobs.py:789-853`; reproduced with SIGKILL of the job's
group). No liveness fallback; `max_runtime` optional and absent from the
prompt's own example. Eviction is precisely this event. Two-tier fix: marker,
else pid-liveness when the pid is no longer our child.

**P2.2 PID reuse: `killpg(getpgid(pid))` with no re-validation**
(`jobs.py:710-712`) from kill/prune/deadline. Stale records (P2.1) make
arbitrarily-old pids reachable → SIGKILL of an unrelated process *group*.
`runtime/eval/run.mjs:380-389` re-validates before signalling; the shipped
module doesn't. Fix: record process start-time, compare before signalling.

**P2.3 Unabortable sentinel sleep, armable by any stdout**
(`ipython.ts:1037-1044`): `__HARNESS_WAIT_SECONDS__:(\d+)` matched against raw
output — `cat` a log containing the sentinel and the tool call sleeps up to
3600s, ignoring both abort signals. Needs a provenance token + abortable timer.

**P2.4 One-session-per-process assumptions in the vendored diff:**
module-level mutable namespace state (`ipython.ts:672-677,889`), `.cells/`
written into the user's cwd (`:684`). Fine for the bench, wrong hosted.

**P2.5 Shared daemon socket:** print mode is a three-process daemon system
(verified against live sockets); `$TMPDIR/prime-agent-<uid>/daemon.sock` is
keyed by uid only — every concurrent worker shares one supervisor and one
lockfile, and `--extension` is re-loaded by path in the worker. Own the
decision: force in-process or per-run `--daemon-socket`.

**P2.6 Call-home a cloud host must close:** product analytics default-ON every
print session (`telemetry.ts:13,414`; our envs cover it); **full-transcript
upload (`agent-traces.ts:776-816`) is installed unconditionally and no env var
gates it** — never fired here only because no credential exists; remove or
hard-disable. `uv` curl-pipe-sh not `PI_OFFLINE`-gated; codex discovery
ungated; `resolve-config-value.ts:29-33` executes credential values beginning
with `!` as shell. `runMigrations` (`main.ts:1139`) rewrites agent-dir *and
cwd* state on every `-p` — gate it.

**P2.7 Runtime hosting hygiene (from the runtime review):** unbounded
`Job.output` reads (verbose build → kernel OOM) + zero retention of records/
spools/transcripts; `_write` atomic but not fsync-durable; config frozen at
import (`jobs.py:104-109,685-696` — no re-target after resume); machine-global
`/tmp/harness/prelude-status.txt` default; `/agent/harness` ×3,
`/agent/prime`, `PRIME_AGENT_CODING_AGENT_DIR` as session key — one injected
config object before any product port. `uninstall_guards()` restores neither
`asyncio.sleep` nor the magics nor `ip.system` (cross-test leakage). Watchdog's
RuntimeError is swallowable and never rearms (`kernel-prelude.py:859-878`) —
should be BaseException-derived like `WaitSignal`. Kill-then-resubmit defeats
the double-run refusal (`jobs.py:862-866` vs `:914-931`).

## P3 — duplication / dead code / extraction

- **Five JSON-stream collectors** (P0.3) → extract one; give `WAIT_SENTINEL` a
  generated header the TS side imports (today: a symbol in jobs.py + a string
  literal in five files).
- **Four blocking-sleep classifiers, three thresholds** (jobs.py canonical;
  tac ×2, terminal ≥6s, eval) — A1 numbers not comparable across benchmarks.
  Guard-fire counting greps prose owned by two files that already diverged.
- **`enrich-catalogue.mjs` / `required-defaults.mjs` are the same ~120-line
  program twice**, already drifted (one refuses enriched input, the other
  doesn't). `flag()` defined in 17 files; catalogue load+filter copy-pasted in
  6 (`loadCatalogue()` collapses them); `bench/run-task.mjs` re-runs
  `generate()` five times per run.
- **`pathExists` sync-under-async** (`path-utils.ts:129-136`, port artifact —
  pi-mono's original is properly async) → stat storms on the event loop from
  find/ls walks. One-line fix. (Otherwise the five ported tools are
  byte-identical to pi-mono — no fork drift.)
- **`--active-tools` chain: nine patches supporting a flag that never works
  end-to-end** (CLAUDE.md already records why). Finish the argv rebuild or
  revert the nine `sub()` calls.
- Dead: `_library_dirs()`/`_LIB_DIRS` (load-bearing-sounding comment, never
  read); `_LOOP_OPENERS`; empty `_METHOD_GUARDS`; `shell_format`/`resolve`
  (test-only); `list_subagents()`; `subagents --docs` (no consumer — eval
  writes only `api/jobs.md`); `renderAppModule`; `renderNames` wire branch;
  `bench/build-api.mjs` generating only the no-gate tree; duplicated
  `SLEEP_CEILING=30` (3 copies); `bash-tool-extension` `capped` map leak;
  `jobs.py list()` builtin shadow; `events` field holding a byte count;
  `finished_at` = observation time; trace-truncation `--replay t --trace t`
  destroys input.
- Stale/self-contradicting comments: `shell_jobs.py:2` "SKETCH — not wired"
  (it is wired); `mcp-tools-extension.ts:150` vs `:216` (validation claim);
  orphaned interrupt comment `ipython.ts:1123`; `neutralize-prime:300` dead
  path; `done.` printed before the last patch section.

## Base-harness audit (what to keep / drop)

Numbers: 455 MB on disk but only ~75 MB tracked (node_modules/dist are
gitignored — the "committed node_modules" suspicion is false). **More tracked
files are upstream tests/docs/examples (683) than source (426).** The product
is ~119k LOC serving a 172-line print mode, but the framing "mostly extra
stuff" is wrong in an interesting way:

**Keep and study — the cloud features already exist:** `modes/daemon/`
(17,958 LOC: per-session workers, versioned protocol with replay cursors,
crash-recovery journals), `core/session-lease.ts` (cross-process single-writer),
`core/cron-jobs.ts` (once/cron/interval schedules, steer vs follow_up
delivery), `core/rlm-runtime.ts` + host handlers (depth-limited subagent
registry — **task #34's vanilla `task()` tool is partly already built here**),
`core/compaction/`.

**Remove, ranked by payoff÷risk:** agents-view (4,052 LOC, lowest risk) →
package-manager/self-update (4,116) → ACP (864) → refinement (1,018, after the
settings kill-switch) → telemetry+traces (1,765) → migrations gate (423) →
interactive (24,266 — biggest win; blocked on `initTheme`/highlighter on the
print path, 1.9 MB of bundle) → prune `models.generated.ts` (21,465) + unused
providers. Ceiling ≈ 36k LOC (~30%) without touching loop/kernel/tools/daemon.

**Slim re-vendor:** drop upstream `test/` (157,937 LOC / 9.5 MB), `examples/`,
`docs/`, root `scripts/`; **pi-mono shrinks to the six ported source files +
pinned-SHA note** (~20 MB → tens of KB; nothing else references it — verified).

**Also true:** two different extension-loading paths across benchmarks
(unbundled `dist/cli.js` locally vs `dist/bundle/cli.js` on TAC — jiti alias vs
virtualModules); no undici timeout on any outbound request (our dead-proxy
egress block depends on this).

## Proposed fix order

Mechanical, high value, no decisions needed (PR 1):
1. P1.6 guard `()` fix + parameterized message test (closes the teaching
   channel today).
2. Delete `scripts/patches/container-kernel.ts` + its `sub()` calls + injected
   block (closes P1.1/P1.2/P1.3); fix the namespace marker anyway.
3. Pristine-replay test in provenance.test.mjs (P1.4) + model-resolves
   assertion.
4. P0.1 schema-score imports the real `pyIdent`.
5. `autoRefine.enabled=false` in scratch settings (P0.2).
6. `pathExists` → `fs/promises` (P3).
7. Fix the manifest glob (P0.4); H5 turn-dedup order; sentinel provenance +
   abortable sleep (P2.3).

Compiler hardening (PR 2): `pyDocstring()` everywhere, collision registry at
normalize time, `pyLiteral()`, deduped `pkg` as required arg, default-value
docstring line, `hostile` fixture + import-not-parse gate.

Hosting correctness (PR 3): P2.1 liveness fallback + P2.2 start-time check (+
tests T2/T3); adoption name uniqueness (P1.7); retention + bounded reads;
config injection object (P2.7).

Decisions needed from Scott before the corresponding work:
- **D1 — subagent architecture:** harden our `jobs`-based `spawn` and stage it
  into containers (P1.8), or adopt prime's existing rlm-runtime subagents?
  Affects task #34 directly.
- **D2 — cloud substrate:** build hosting on our jobs runtime + print mode, or
  on prime's daemon/session-lease/cron machinery? The audit says the latter is
  substantially built; nobody has evaluated its quality under load.
- **D3 — `--active-tools`:** finish or revert the nine patches.
- **D4 — slim re-vendor scope** (drop upstream tests/docs/examples, shrink
  pi-mono, prune models/providers) — mechanical but large; do it now or after
  the cloud-substrate decision?

## Validation gate (before/after each PR)

`npm test` (471) + `cd runtime && python3 -m unittest discover` (275), plus the
task-#49 subset with the shipped flag stack: `ce73d68_{1,2,3}` (required-
defaults canary), `692c77d_3`/`57c3486_1`/`6104387_2` (high-call stratum),
`82e2fac_1`, `92fe421_3`; terminal-bench `sqlite-with-gcov` + `cartpole`
(jobs + guarded bash). Read trajectories for mechanism (read-gate fired, jobs
adopted, validation on), not score (27% noise).
