# terminal-bench, three arms, long horizon

Written as the work happens. **The question is not "which arm scores higher" —
terminal-bench resolution is all-or-nothing and n=1 per cell, so score is
underpowered by construction.** The question is what each arm *does* when the
work takes minutes rather than seconds, and what that costs in dollars and in
resident context.

Arms, all Opus 5, all in the real task container:

| arm | surface | runtime |
|---|---|---|
| **codemode** | `ipython,edit` | jobs runtime ON, 120s wedge-suspect watchdog, subagents OFF |
| **vanilla** | `bash,read,edit,write,grep,find,ls` | — |
| **claude-code** | upstream's installed `claude-code` agent, typed into tmux | — |

Status: **STOPPED DELIBERATELY after six tasks.** Phase 0 complete (screen 4/4
PASS); Phase 1a complete (3 tasks x 3 arms); Phase 1b partially complete (3 of 6
tasks x 3 arms) and **halted mid-sweep by the lead** to free disk and pivot to
CyberGym. Phase 2 (subagents ON/OFF) **not run** — and would not have measured
anything as wired; see §9.

> **Headline so far, stated before the caveats rather than after them:**
> on `compile-compcert`, **vanilla tool-calling beat codemode on every quantity
> measured** — passed, 20 turns vs 28, $0.340 vs $0.726, 1537s vs 2201s, and
> **2.75× less accumulated context**. claude-code failed, but not for a
> representation reason: it **voluntarily ended its session 225s into a 2400s
> budget** with the build still running.

---

## 0. Preconditions checked before anything was run

**Disk.** The colima VM's docker filesystem, not the container overlay:
`/dev/vdb1 97.9G, 23.3G free` at start. Note `sweep.sh`'s own banner reports
`df -h /` from inside a throwaway alpine, which is the *container's* root
(18.3G / 17.1G free) — a different filesystem from the one that fills. The check
that matters is `docker run --rm -v /var/lib/docker:/dd alpine df -h /dd`.
`three-arm.sh` uses that one and prunes `tb__*` images below 12G.

**Co-tenancy.** The TAC stack is live in the same VM (18 containers, GitLab /
ownCloud / Plane / RocketChat). §5 of the scout doc says a terminal-bench sweep
and the TAC stack should not share a VM; they do here, so free space is checked
between every arm and nothing is ever pruned broadly (`CLAUDE.md`: a broad prune
destroyed Plane's `pgdata` last time).

One stale artefact was removed: a `train-bpe-tokenizer` task container up 39
hours from the §8.4 work, plus its 914 MB image. Scoped to `tb__*`.

**The vanilla arm had never been run on this benchmark.** Every prior
terminal-bench run in `.run/terminal-bench/` is `arm=codemode`, `oracle`, `nop`,
or the single `p1-cc-csv` claude-code trial. So it was smoke-tested before being
trusted (`smoke-vanilla-hello`):

```
hello-world  PASS  turns 2  toolCalls 1  toolNames ['write']  ctx0 4,629  $0.034  6.8s
tools: bash, read, edit, write, grep, find, ls    arm: vanilla    valid: true
```

It reached the transport with its own tool set. Worth noting for the context
measurement: **vanilla's `ctx0` is 4,629 against codemode's 6,098 on the same
task** — seven shell/file tool schemas are *cheaper* to advertise than
`ipython` + `edit`, whose descriptions are long. Any context claim for codemode
here has to be a claim about *growth*, not about the starting point, because it
starts behind.

## 1. Task selection and the $0 admission screen

Candidates, from the lead's long-horizon list, with the two dropped a priori:

| task | budget | status |
|---|---|---|
| `compile-compcert` | 2400s | oracle PASS (scout §8.2), genuine >600s Coq-from-source build |
| `cartpole-rl-training` | 900s | oracle PASS (scout §8.2) |
| `sqlite-with-gcov` | 900s | oracle PASS (scout §8.4) |
| `gcc-compiler-optimization` | 900s | oracle PASS (scout §8.4) |
| `train-bpe-tokenizer` | 1200s | oracle PASS (scout §8.4); the stdlib-shadow regression check |
| `train-fasttext` | 3600s | **oracle PASS (this campaign)** |
| `hf-train-lora-adapter` | 1800s | **oracle PASS (this campaign)** |
| `magsac-install` | 1500s | **oracle PASS (this campaign)** |
| `password-recovery` | 900s | **oracle PASS (this campaign)** |
| `build-initramfs-qemu` | 900s | **dropped a priori — see below** |
| `chem-rf` | 86400s | **deferred — see below** |

**`build-initramfs-qemu` is dropped without spending the screen**, because it is
failure #2 (`build-tcc-qemu`) with a different name and the evidence is in the
task files rather than in a run. Its `Dockerfile` does `make defconfig && make
-j$(nproc)` on the Linux 6.9 tree with no `--platform` pin, so on this arm64 host
it builds an **arm64** kernel; its `tests/test_outputs.py:14` then does

```
spawn qemu-system-x86_64 -kernel /app/linux-6.9/arch/x86/boot/bzImage ...
```

and its `solution.sh:43` downloads `busybox-x86_64`. There is no
`arch/x86/boot/bzImage` on this host, so the oracle cannot pass and neither can a
perfect agent. Screening it would cost a full kernel build (tens of minutes, ~10
GB of a 23 GB budget) to confirm something already legible in three lines of the
task. Recorded as a prediction, not a measurement — if it is ever wanted, the
screen is still the way to settle it.

**`chem-rf` is deferred, not screened.** Its budget is 86,400s agent / 28,800s
test and its `solution.sh` downloads a 1M-row parquet from S3 and fits a
RandomForest over RDKit Morgan fingerprints. The oracle screen alone is plausibly
multiple hours of CPU on an 8-core box that is also hosting the TAC stack, and
the screen is only the *precondition* for three paid arms on top. It is the right
task for this axis and the wrong task for this budget; flagged for a dedicated
run rather than folded into phase 1.

### 1.1 Screen results (`oracle-lh`, concurrency 1, $0)

Concurrency 1 rather than the doc's earlier 2, because §1.4's lesson is to screen
at the concurrency the sweep will use and phase 1 runs one container at a time.

| task | oracle | reference wall-clock | note |
|---|---|---|---|
| `train-fasttext` | **PASS** 2/2 | — | |
| `hf-train-lora-adapter` | **PASS** 5/5 | solution 271.6s | see the threshold note below |
| `magsac-install` | **PASS** 3/3 | OpenCV 4.3.0 + pymagsac from source, ~14 min | genuine long build |
| `password-recovery` | **PASS** 2/2 | — | forensic, short |

**Screen verdict: 4/4 PASS, nothing excluded.** The admissible long-horizon set is
therefore nine tasks: `compile-compcert`, `cartpole-rl-training`,
`sqlite-with-gcov`, `gcc-compiler-optimization`, `train-bpe-tokenizer`,
`train-fasttext`, `hf-train-lora-adapter`, `magsac-install`, `password-recovery`.
Total screen cost **$0**.

**A false-positive candidate for the 120s watchdog, found in the screen.** The
`hf-train-lora-adapter` reference trains GPT-2 with a LoRA adapter and logs
`train_runtime: 208.6s` — a single foreground compute block **1.7× longer than
the 72.4s maximum §8.4 measured when it set `HARNESS_WEDGE_SUSPECT_SECONDS=120`.**
If the codemode arm runs that training foreground, the watchdog will interrupt
legitimate compute at 120s. §8.4's threshold was calibrated on a corpus that
contained no real training run; this task is one. Whether it actually fires is an
observation to make, not a reason to move the threshold pre-emptively — but it is
the first thing to read in that trajectory.

## 2. Instrumentation added before phase 1

Two gaps were closed first, both of the shape this repo keeps paying for: a
metric that **can only ever report zero** for one arm, which reads as a finding.

**(a) The vanilla arm's commands were never recorded.** `prime_agent._accumulate`
retained `args["code"]` — the argument name of codemode's `ipython` tool. The
vanilla arm's `bash` tool takes `command`
(`packages/coding-agent/src/core/tools/bash.ts:25`), so every vanilla run had an
empty `cells` list and therefore `blockingSleepCells = 0`, `daemonCells = 0`,
`threadCells = 0` — structurally, on every task, forever. Reported as a table it
would have read *"vanilla never blocks"*. It now reads both names; pinned by
`test_vanilla_bash_command_is_retained_too` in `bench/terminal/test_prime_agent.py`
(23 tests pass).

**(b) There was no per-turn context extractor, and claude-code's numbers were
being thrown away.** `bench/terminal/context-growth.py` reads each arm from its
own artefact — prime from `trajectory.jsonl`, claude-code from the stream-json
inside `sessions/agent.log` — and reports `ctx0`, `ctxLast`, `ctxMax`, `ctxSum`
plus the same wait-behaviour regexes applied to all three arms.

Two parsing traps in claude-code's stream, both found by cross-checking against a
number recorded independently:

- **One event per content block, not per message.** A message with `thinking` +
  `tool_use` is emitted twice with byte-identical usage. Summing events gave
  537,757 resident tokens against the run's own `result` event total of 342,867 —
  a 57% overcount. Deduping on message id brings the count to 14, which equals
  the run's own `num_turns`. That equality is the check.
- **…but the dedupe must not eat the sources.** The command lives on the
  *second* event of such a pair, so deduping before collecting dropped 8 of
  claude-code's 13 Bash calls and printed `sleeps=0` for an arm nobody had looked
  at. Sources are now collected from every event, usage from the first only; the
  recovered count (13) matches the scout doc's independently-read 13.

Also: per-message `output_tokens` in claude-code's stream are streaming partials
(1, 3, 16 …), not message totals. Only the `result` event's total is usable.

**(c) Prompt-cache expiry around long waits** (endpoint added by the lead
mid-campaign). A cache entry lives ~5 minutes; a genuine build wait outlives it,
and the wake turn is re-prefilled at **write** price rather than read price. The
re-warm bill is proportional to the resident context, so this is a *multiplier on
the context difference*, not a separate effect.

Detection, in `cache_events()`: a turn `i > 0` whose `cacheWrite ≥ 0.5 × ctx` was
re-prefilled rather than read. The threshold is a **ratio**, so it means the same
thing for a 6.5K codemode prompt and a 105K transcript prompt; turn 0 is excluded
because the first prompt is always a full write and counting it would hand the
arm with the biggest catalogue a free "expiry" that has nothing to do with
waiting.

Pricing is **solved, not remembered**. claude-code prices per run rather than per
message, so its re-warm cost has to be computed — and quoting a price from memory
into a result is exactly the move this repo distrusts. Two runs that recorded
their own cost pin the table exactly:

```
p1-cc-csv:  27·I + 8,698·1.25I + 334,142·0.1I + 2,908·O  ->  $0.2942685   (recorded: $0.2942685)
prime:      5,212 cacheWrite -> $0.032575   884 cacheRead -> $0.000442   86 output -> $0.00215
=> Opus 5, $/MTok: input 5.00, output 25.00, cacheWrite 6.25, cacheRead 0.50
```

Reported both gross (`rewarmTok × 6.25`) and **extra** (`× 5.75`) — the extra is
the price *of the expiry*, since those tokens must be sent either way; the gross
figure alone would charge an arm for context it was always going to pay for.

### 2.1 Preview of the cache endpoint on the two existing compcert runs

Not campaign data — these are the §8.2 ON/OFF pair, re-scored with the new
detector — but they establish that the mechanism is real and measurable here:

| run | ctx at wake | expiry events | re-warm tok | extra $ | gap before | wake latency | warm latency |
|---|---|---|---|---|---|---|---|
| `p82-compcert-off` | 14.0K / 14.9K | **2** | 27,942 | **$0.161** | 603s, 403s | 3.4s, 2.5s | 3.7s |
| `p82-compcert-on` | 13.2K / 14.3K | **2** | 27,509 | **$0.158** | 602s, 602s | 2.0s, 2.1s | 2.9s |

Two things follow, and the second one qualifies the hypothesis:

1. **The expiry is real and the gaps are exactly the long waits** — 403–603s, i.e.
   the `sleep 600` polls and the `jobs.wait` spans. `cacheRead` on those turns is
   **0**: the whole prompt was re-written. At codemode's 14K that is $0.16 on a
   $0.56 run — **29% of the run's cost**, from waiting.
2. **The latency half of the hypothesis does not show at this context size.**
   Wake-turn model round trips (2.0–3.4s) are *at or below* the warm median
   (2.9–3.7s). Re-prefilling 14K costs no measurable time. Whether it costs
   measurable time at 105K is the open question, and it is precisely what the
   vanilla and claude-code arms on compcert will answer. Stated now so that a
   null there is not retro-fitted into a win.

The token/cost half should scale ~linearly with resident context, so the
prediction to falsify is: **same number of expiry events per arm (the waits are a
property of the task), re-warm tokens proportional to ctx.** If claude-code holds
~105K across two expiries that is ~210K re-warm tokens ≈ **$1.21 extra** against
codemode's $0.16 — a 7.5× gap arising purely from having waited.


---

## 3. Phase 1a — `compile-compcert`, three arms

Oracle-verified (§8.2 of the scout doc; arch-clean, the reference branches
`aarch64|arm64`). Budget 2400s. A0 on the codemode run before the model was
called: `jobs_staging.bound = true`, every preflight check true, `build_ok`
including `__HARNESS_WAIT_SECONDS__`, cell ceiling 600s, deadline 2370s.
Post-run `prelude-status.txt`: `COMPLETED jobs bound in builtins`,
`SUBAGENTS off`. `kernelRestarts 0`, `valid true`.

| endpoint | codemode (jobs=on) | vanilla | claude-code |
|---|---|---|---|
| **resolved** | **PASS** 3/3 | **PASS** 3/3 | **fail** 0/3 |
| turns | 28 | **20** | 33 |
| tool calls | 27 | **19** | 31 |
| cost | $0.726 | **$0.340** | $0.902 |
| wall-clock | 2201s | 1537s | **225s** (quit early) |
| `ctx0` | 6,766 | **4,717** | 22,984 |
| ctx last turn | 24,063 | **11,118** | 47,844 |
| **ctx accumulated** | 437,152 | **158,792** | 795,522 |
| output tokens | 6,249 | **3,986** | 13,200 |
| procs created | 43,779 | 32,345 | — |
| $ / proc created | 1.66e-05 | **1.05e-05** | — |
| blocking sleeps | **0** | 5 | 1 |
| backgrounded (`nohup`/`&`) | 0 | 2 | 0 |
| `jobs.` cells | 11 | — | — |
| wedged cells | **0** | 0 | 0 |

Context growth, deciles:

```
codemode     6k  8k 10k 12k 15k 16k 18k 20k 22k 24k
vanilla      4k  5k  6k  7k  7k  8k  9k  9k 10k 11k
claude-code 22k 24k 29k 31k 32k 38k 40k 44k 46k 47k
```

### 3.1 Why claude-code failed — it ended its own turn mid-build

Not a grader, harness, or reference fault. The grader's frame is unambiguous:

```
FAILED test_compcert_exists_and_executable  - AssertionError: /tmp/CompCert/ccomp does not exist
FAILED test_compcert_valid_and_functional   - FileNotFoundError: '/tmp/CompCert/ccomp'
FAILED test_compcert_rejects_unsupported_feature - FileNotFoundError: '/tmp/CompCert/ccomp'
3 failed in 0.11s
```

`ccomp` was never built, because the agent stopped. Its own `result` event:

```json
{"subtype": "success", "is_error": false, "stop_reason": "end_turn",
 "terminal_reason": "completed", "num_turns": 33, "duration_ms": 229072,
 "result": "OCaml 4.14.2 is still compiling. I'll continue when it lands."}
```

**It reported success.** Wall-clock cross-checked three ways — first-to-last event
timestamp 225.1s, its own `duration_ms` 229.1s, and terminal-bench's
`Blocking command completed in 235.50s` — so this is **9.4% of a 2400s budget**.
Its largest single gap between events was **28.3s**: it never waited at all.

What makes this the interesting failure rather than a dumb one is *how close it
got to the right design*. Reading its calls, claude-code has and used its own
background machinery:

```
[20] Bash timeout=1500000  cd /tmp && export OPAMROOT=/root/.opam && opam init --bare … &&
                            opam switch create compcert ocaml-base-compiler.4.14.2 -y -j 8 …
[24] Bash  tail -5 /tmp/claude-0/-app/df346d8b-…/tasks/biqppm4gm.output
[25] ToolSearch  {"query": "select:Monitor"}
[26] Bash timeout=600000   until grep -qE "SWITCH OK|SWITCH FAIL|INIT OK" /tmp/claude-0/…/biqppm4gm.output;
                            do sleep 10; done
[28] Bash timeout=1500000  until grep -qE "SWITCH OK|=== SWITCH" …; do … kill -0 $(pgrep -f "opam switch create") …
```

It backgrounded the build to its **own** task-output file, went looking for a
`Monitor` tool, and wrote `until … sleep 10; done` poll loops — a hand-rolled
`jobs.submit` + `jobs.wait`, exactly the shape `CLAUDE.md` predicts ("the agent
already reached for `cmd > log &` + `cat log`"). Then it hit the limit of that
design: **its wake model is "hand back to the session and be re-prompted."**
Under `claude … -p '<instruction>'` — upstream terminal-bench's own invocation,
not a choice made here — nothing re-prompts it. The promise "I'll continue when
it lands" has no addressee.

Classification: **AGENT**, mechanism named. It had correct information (the build
was running, 2,175s of budget remained) and chose to yield. But the honest
comparison note is that **the arms differ in wake support, and that is the
treatment**: prime's `jobs.wait(wake_after=N)` ends the turn *and the harness
resumes it* (`__HARNESS_WAIT_SECONDS__` is asserted present in the bundle at
preflight). Claude Code in `-p` mode has no such seam. So this is evidence for
"a wait primitive with a resume is load-bearing on long-horizon work" and **not**
evidence that claude-code is a weaker agent. n=1.

### 3.2 Why vanilla beat codemode — the caller chose to keep more, not less

This is a negative result for the representation claim on this task and it is
recorded as one. The mechanism is legible in the sources, and it is **not** the
tool surface.

Codemode's second cell defined its own shell helper and then used it 16 times:

```python
def sh(c):
    r=subprocess.run(['bash','-lc',c],capture_output=True,text=True)
    print(r.stdout[-4000:]); print("ERR:", r.stderr[-2000:]); return r
```

**Up to 6,000 characters per call, unconditionally.** Its job polls did the same:
`print(j.output[-1500:])`, `[-1200:]`, `[-800:]`, `[-700:]`. Vanilla piped
everything through a filter instead — `tail -3`, `tail -5`, `head -15`,
`| tail -25` — on essentially every one of its 19 calls.

`CLAUDE.md` §"the representation term is *code can discard*" says the advantage
of code is that **the caller decides what survives, per call, at run time**. That
is exactly what happened here — and the caller decided to keep 4,000 characters.
The affordance was used against itself. Vanilla's `bash` tool returns whatever
the command printed, so its filtering discipline was forced into the command line
where the agent applied it every time.

**A second, larger confound: the two arms did not do the same work.** Codemode
installed the wrong Coq first and had to redo it:

```
[ 6] jobs.submit("opam … opam install -y coq.8.17.1 menhir.20230608 …", name="opam", max_runtime="90m")
[16] jobs.submit("eval $(opam env --switch=cc) && opam install -y coq.8.16.1 && coqc --version",
                 name="coq16", max_runtime="90m")   # ← second Coq build, ~15 min
```

Vanilla went straight to the pinned version in its first attempt
(`opam install coq.8.16.1 menhir.20220210`). So codemode built Coq **twice**,
which shows up in the work counter (43,779 procs vs 32,345, +35%) and accounts
for much of the turn, cost and wall-clock gap. Per the work-parity rule the
defensible statement is the **rate**: $1.66e-05 vs $1.05e-05 per process created
— vanilla is still ~1.6× cheaper per unit of work, so the wrong-version detour
does not explain all of it, but it is not a clean paired comparison either.

Stated plainly: **on this task, n=1, codemode lost on every endpoint, about half
of it attributable to a task-level wrong turn and about half to a filtering habit
the code arm chose and the shell arm was forced into.** Nothing here is a claim
about representation in general; it is a claim that on one long build the
mechanism did not deliver, and the reason is visible.

### 3.3 The wait behaviour — the one place the runtime did what it says

| arm | what it did at the long wait | kernel/turn held? |
|---|---|---|
| codemode | `jobs.submit(… make -j$(nproc) all, name="build", max_runtime="4h")` then `jobs.wait(wake_after=900)` | **no** — 0 blocking sleeps, 0 wedged cells, 11 `jobs.` cells |
| vanilla | `nohup timeout 7200 make -j$(nproc) > /tmp/build.log 2>&1 & sleep 300` then `sleep 600; tail -3` then `sleep 420; …` | **yes** — 5 blocking sleeps totalling ~1,410s |
| claude-code | backgrounded, then `until grep -q …; do sleep 10; done`, then **quit** | n/a — never waited >28s |

Worth recording because it is an asymmetry in the arms as shipped, not a
fairness bug that can be fixed by prompting: **the 600s cell ceiling and the 120s
wedge-suspect watchdog are kernel-prelude features, so they exist only for
codemode.** Vanilla's `bash` tool takes an optional `timeout` and defaults to
none, so its `sleep 600` ran unbounded and nothing would have interrupted it had
the build hung. Vanilla got away with blocking here; the runtime's protection
against *not* getting away with it is real but was not needed on this task.

The §8.4 watchdog **did not fire on either arm** (0 wedged cells), so the 120s
threshold false-positived nothing on a genuine 2200s build — the regression check
that mattered most going in.

### 3.4 Prompt-cache expiry around the long waits

| arm | expiries | re-warm tok | gross $ | **extra $** | median gap before | wake latency | warm latency |
|---|---|---|---|---|---|---|---|
| codemode | 2 | 37,526 | $0.235 | **$0.216** | 753s | 2.7s | 4.4s |
| vanilla | 2 | 17,129 | $0.107 | **$0.098** | 514s | 3.7s | 3.7s |
| claude-code | **0** | 0 | — | — | — | — | 4.2s |

Per event:

```
codemode turn 17: ctx 17,910  rewarm 17,908  (cacheRead 0)  gapBefore 603s  modelLatency 2.7s
codemode turn 20: ctx 19,620  rewarm 19,618  (cacheRead 0)  gapBefore 903s  modelLatency 2.6s
vanilla  turn 10: ctx  8,051  rewarm  8,049  (cacheRead 0)  gapBefore 604s  modelLatency 3.9s
vanilla  turn 13: ctx  9,082  rewarm  9,080  (cacheRead 0)  gapBefore 424s  modelLatency 3.6s
```

Three findings, one of which kills a hypothesis:

1. **The mechanism is confirmed and it is clean.** Every expiry has `cacheRead 0`
   — the entire prompt re-prefilled — and every gap is a real wait (424–903s).
   The count is 2 for both arms, i.e. **a property of the task's waits**, as
   predicted.
2. **The cost is proportional to resident context, as predicted — which on this
   task penalises codemode.** $0.216 vs $0.098, a 2.2× ratio tracking the 2.2×
   context ratio. This is the predicted mechanism producing the opposite sign
   from the one hoped for, because the arm with more context was codemode.
3. **The latency half is dead, and should stop being quoted.** Wake-turn model
   round trips (2.6–3.9s) are at or below each arm's own warm median (3.7–4.4s)
   at 8–20K. Combined with the §2.1 preview at 14K, that is four independent
   expiry events showing **no measurable re-prefill latency penalty**. The 105K
   test claude-code was supposed to provide **did not happen** — it never waited
   long enough to expire a cache — so the "cc/vanilla re-prefill 105k at full
   price *and latency*" prediction is **unmeasured on latency and unmeasurable
   from this run**. Recorded as such rather than quietly dropped.

The honest form of the cache result: **waiting costs real money, ~$0.10–0.22 per
task here, 13–29% of run cost, and it scales with resident context.** It is a
multiplier on whatever the context difference is, not an independent effect —
so it amplifies whichever arm is fatter, and on compcert that was codemode.

## 4. Phase 1a — `cartpole-rl-training`, three arms

The control case. §8.2 measured this task's wait as a ~90s foreground train,
"real but too short to bite", and predicted a null on the wait axis. It is
included precisely so that a task with *no* long wait sits beside one that has
several. A0 clean again: `jobs_staging.bound = true`, all preflight true,
`kernelRestarts 0`, `SUBAGENTS off`.

| endpoint | codemode (jobs=on) | vanilla | claude-code |
|---|---|---|---|
| **resolved** | **PASS** | **PASS** | **PASS** |
| turns | 7 | 7 | 10 |
| cost | $0.179 | **$0.162** | $0.346 |
| wall-clock | 239s | **188s** | 344s |
| `ctx0` | 7,144 | **5,089** | 23,361 |
| ctx last turn | 12,563 | **10,686** | 30,123 |
| **ctx accumulated** | 67,047 | **50,486** | 262,886 |
| output tokens | 2,913 | 3,019 | 5,699 |
| **cache expiries** | **0** | **0** | **0** |
| `jobs.` cells | 2 | — | — |

```
codemode     7k  7k  7k  8k 10k 10k 10k 10k 10k 12k
vanilla      5k  5k  5k  5k  6k  6k  8k  8k  8k 10k
claude-code 23k 23k 23k 24k 24k 25k 28k 29k 29k 30k
```

**The wait-axis null replicates exactly as predicted: zero cache expiries in all
three arms.** Nothing here waits 5 minutes, so nothing expires. That is the
control the compcert cache table needed — it rules out "expiries are an artefact
of our detector firing on ordinary turns", since the same detector on the same
arms returns 0/0/0 when the task has no long wait and 2/2/0 when it does.

Codemode used `jobs` twice even though the train finishes in ~90s, and it cost
it nothing (7 turns either way).

**Against claude-code the residency story does hold, and this is the cleanest
place to see it**: `ctx0` 23,361 vs 5,089–7,144, and accumulated context 262,886
vs 50,486–67,047 — a **3.9–5.2×** difference on a task all three arms solved in
7–10 turns. cc is 2.1× more expensive than vanilla and 1.9× more than codemode.
That is the same shape as the AppWorld result and it is not in dispute here.

What *is* in dispute after compcert is the codemode-vs-vanilla half: **2 for 2 so
far, vanilla is cheaper, holds less context, and finishes faster.** On cartpole
the margin is small (cost within 10%, i.e. inside noise); on compcert it was not.

## 5. Phase 1a — `sqlite-with-gcov`, three arms

§8.4 measured this task's build as a **50.2s foreground `make -j`** — a real build,
under every ceiling. A0 clean (`bound true`, all preflight true, `kernelRestarts 0`).

| endpoint | codemode (jobs=on) | vanilla | claude-code |
|---|---|---|---|
| **resolved** | **PASS** | **PASS** | **PASS** |
| turns | **13** | 15 | 34 |
| cost | **$0.190** | $0.204 | $0.987 |
| wall-clock | 466s | **180s** | 245s |
| `ctx0` | 6,746 | **4,692** | 22,964 |
| **ctx accumulated** | **122,274** | 124,728 | 916,686 |
| output tokens | **2,210** | 2,591 | 14,005 |
| **cache expiries** | **0** | **0** | **0** |
| `jobs.` cells | 4 | — | — |

```
codemode     6k  7k  7k  8k  8k  9k  9k 10k 12k 12k
vanilla      4k  5k  5k  6k  6k  7k  8k 11k 12k 13k
claude-code 22k 24k 27k 31k 33k 34k 39k 42k 46k 48k
```

**First cell where codemode edges vanilla** — fewer turns (13 vs 15), marginally
cheaper ($0.190 vs $0.204), fewer output tokens, essentially identical
accumulated context (122K vs 125K). All of it inside noise; the honest reading is
*parity*, not a win.

Against claude-code the gap is the widest yet: **5.2× the cost and 7.5× the
accumulated context of codemode**, for the same three passing assertions.

## 6. Phase 1a verdict

Nine runs, three tasks, three arms. Every trial classified; taxonomy is
**PASS or AGENT only — no HARNESS, GRADER, INTEGRATION or REFERENCE** cause
anywhere, so the tier is CLEAN and may ratchet.

| | codemode | vanilla | claude-code |
|---|---|---|---|
| resolved | **3/3** | **3/3** | 2/3 |
| total cost | $1.095 | **$0.706** | $2.235 |
| cheaper on | 1/3 tasks | **2/3 tasks** | 0/3 |
| total accumulated ctx | 626,473 | **334,006** | 1,975,094 |
| cache expiries | 2 | 2 | 0 |
| blocking sleeps | **0** | 5 | 1 |
| wedged cells | 0 | 0 | n/a |

**What is established.**

1. **Against claude-code, the context and cost result is large and consistent** —
   3.9–7.5× accumulated context, 1.9–5.2× cost, on all three tasks including the
   two everyone passed. `ctx0` is 23K for cc against 4.7–7.1K for both prime arms
   on every task. This replicates the AppWorld shape.
2. **claude-code has no usable long-wait behaviour under `-p`.** It quit 225s into
   a 2400s build having *correctly* backgrounded it, polled it, and even gone
   looking for a `Monitor` tool. Its failure is a missing resume seam, not missing
   judgement. This is the single strongest piece of evidence the campaign has
   produced for the wait half of the thesis, and it is n=1.
3. **The jobs runtime does what §8.2 says it does** — 0 blocking sleeps, 0 wedged
   cells, 11 `jobs.` cells on compcert against vanilla's 5 blocking sleeps
   totalling ~1,410s. The 120s watchdog **false-positived nothing** across a 2200s
   build, a 466s build and a 239s train.
4. **Cache expiry is real, is caused by waits, and scales with context** —
   2/2/0 expiries on the task with waits, 0/0/0 on both tasks without, every
   expiry showing `cacheRead 0` after a 424–903s gap.

**What is not established, and points the wrong way.**

5. **codemode does not beat vanilla on these three tasks.** Vanilla is cheaper on
   2/3 and 2.1× cheaper in total; codemode's only edge is a within-noise parity on
   sqlite. On compcert the loss was large (2.1× cost, 2.75× context) with two
   identified causes: a wrong-Coq-version detour that made codemode do ~35% more
   work, and a `print(stdout[-4000:])` helper the agent wrote itself. **Neither is
   about the tool surface.** n=3 paired tasks — far under the ~20 `CLAUDE.md`
   requires to rank two arms — so this is a flag, not a ranking.
6. **The latency half of the cache hypothesis is unsupported.** Six expiry events
   now (four here, two in the §2.1 preview) all show wake-turn latency at or below
   the arm's own warm median. The 105K test claude-code was meant to supply never
   happened because it never waited. Not measured, not claimed.

Cumulative spend after phase 1a: **$4.07** of ~$60 (codemode $1.095, vanilla
$0.706, claude-code $2.235, vanilla smoke $0.034; all oracle screening $0).

---

## 7. Phase 1b (partial) — three more tasks, three arms

Halted mid-sweep by the lead after `train-fasttext`. `train-bpe-tokenizer`,
`gcc-compiler-optimization` and `password-recovery` were **not run**; the
stdlib-shadowing regression check therefore did **not** get its 3-arm confirmation
here (it remains confirmed only by §8.4's own E2E check).

### 7.1 `magsac-install` — the widest claude-code gap in the campaign

OpenCV 4.3.0 + pymagsac from source. All three arms **PASS**.

| endpoint | codemode | vanilla | claude-code |
|---|---|---|---|
| resolved | PASS | PASS | PASS |
| turns | 28 | 32 | 69 |
| cost | $1.056 | **$0.935** | $4.122 |
| wall-clock | 1473s | **699s** | 886s |
| `ctx0` | 7,501 | **5,455** | 23,721 |
| ctx last turn | 41,223 | 41,041 | **118,132** |
| **ctx accumulated** | 748,547 | 739,755 | **4,354,865** |
| output tokens | **8,968** | 13,165 | 54,599 |
| cache expiries | 1 ($0.222 extra) | 0 | 0 |

```
codemode     7k  9k 12k 15k 22k 34k 35k 36k 38k 41k
vanilla      5k  7k 11k 16k 21k 25k 29k 32k 38k 41k
claude-code 23k 37k 54k 68k 79k 87k 97k 106k 112k 118k
```

**claude-code reached 118K resident context and 4.35M accumulated — 5.8× codemode
— for the same three passing assertions, at 4.4× the cost.** This is the
context-rot curve the campaign was looking for, and it is claude-code's, not
vanilla's: the two prime arms track each other almost exactly (748K vs 740K,
41.2K vs 41.0K final) while cc diverges from turn one and never converges.

### 7.2 `hf-train-lora-adapter` — all three arms fail, task-level

| arm | assertions | secs | hitDeadline |
|---|---|---|---|
| codemode | 1/5 (`test_training_script` only) | 1772.8 | **True** |
| vanilla | **4/5** (all but `test_model_improvement`) | 1772.0 | **True** |
| claude-code | 1/5 | 1639 | — |

Per skill §3 this is **task-level, not arm-level**: the oracle passes it in 271.6s
because it knows the exact `pip install` line, and all three agents spent the
1800s budget discovering it. **All three ran to the wall.** vanilla got closest —
it produced the adapter and results file and failed only the quality assertion.
Classification **AGENT** (acted, then exhausted the task's own budget), carrying
no arm signal.

**The Phase 0 watchdog prediction was tested here and is FALSIFIED.** §1.1
predicted the 208.6s foreground training would trip the 120s wedge-suspect
watchdog. Scanning both codemode streams for `held the kernel for` /
`INTERRUPTED after`: **NONE on `hf-train-lora-adapter`, NONE on `magsac-install`.**
The agent submitted the training to `jobs` (7 cells) instead of running it
foreground, so the watchdog never armed against real compute. The threshold
survives a corpus that now includes a genuine multi-minute train — which is the
evidence §8.4 lacked. Recorded as a negative result for a prediction this document
made in advance.

**claude-code's cache expiries — the only 40K+ re-warm measured.**

```
cc turn 15: ctx 39,312  rewarm 21,612  (cacheRead 17,698)  gapBefore 609s  modelLatency 8.1s
cc turn 24: ctx 47,287  rewarm 29,587  (cacheRead 17,698)  gapBefore 603s  modelLatency 2.3s
```

Note `cacheRead 17,698` on both: cc retains a long-lived prefix (its system
prompt) and re-warms only the transcript above it — a real mitigation the prime
arms did not show, where `cacheRead` was 0 on every expiry. Its two events cost
**$0.294 extra**. The first shows an 8.1s wake against a 4.8s warm median (1.7×);
the second shows 2.3s (below it). **Two events, opposite signs — still no latency
result.**

### 7.3 `train-fasttext` — vanilla passes, both other arms fail

| arm | assertions | turns | cost | secs |
|---|---|---|---|---|
| codemode | `test_model_size` pass, **`test_accuracy` fail** | 12 | $0.192 | 365 |
| vanilla | **2/2 PASS** | 31 | $0.693 | 1068 |
| claude-code | 0/2 | 23 | $0.842 | 394 |

**codemode: AGENT, train/serve preprocessing skew.** Its final message claims
success —

> "Held-out test accuracy: **0.6357** (≥0.62 target). Model saved at
> **/app/model.bin**, size **99 MB**"

— and `test_model_size` did pass. But it trained with "light punctuation/lowercase
normalization", while the grader (`tests/test_outputs.py:21-30`) reads
`/app/data/test.txt` and predicts on the **raw** line text against
`ACCURACY_THRESHOLD = 0.62`. The 0.6357 was measured on its own *normalized*
held-out split — a correct number for a distribution the grader never presents.
Vanilla applied no normalization and passed.

The shape worth noting: **codemode quit confident at 365s of a 3600s budget;
vanilla ground on for 1068s and passed.** Same failure family as claude-code on
compcert — early, confident termination — arrived at by a different route
(believing a self-measured metric rather than yielding to a session).

## 8. Campaign totals — six tasks, three arms, eighteen runs

| arm | trials | resolved | total cost | total ctx accumulated | expiries | re-warm tok | extra $ |
|---|---|---|---|---|---|---|---|
| **codemode** (jobs=on) | 6 | 4/6 | $2.662 | 1,633,976 | 4 | 89,756 | $0.516 |
| **vanilla** | 6 | **5/6** | **$2.538** | 1,657,329 | 2 | 17,129 | $0.098 |
| **claude-code** | 6 | 3/6 | $8.609 | **8,226,788** | 2 | 51,199 | $0.294 |

| task | codemode | vanilla | claude-code |
|---|---|---|---|
| `cartpole-rl-training` | PASS $0.179 | PASS $0.162 | PASS $0.346 |
| `compile-compcert` | PASS $0.726 | PASS $0.340 | **fail** $0.902 |
| `sqlite-with-gcov` | PASS $0.190 | PASS $0.204 | PASS $0.987 |
| `magsac-install` | PASS $1.056 | PASS $0.935 | PASS $4.122 |
| `hf-train-lora-adapter` | **fail** $0.319 | **fail** $0.204 | **fail** $1.410 |
| `train-fasttext` | **fail** $0.192 | PASS $0.693 | **fail** $0.842 |

Total spend **$13.81** of ~$60 (+$0.034 vanilla smoke). All oracle screening $0.

## 9. Verdict

**1. Against claude-code, the context and cost result is large, consistent, and
replicates AppWorld.** 5.0× the accumulated context of either prime arm
(8.23M vs 1.63M/1.66M) and 3.2–3.4× the cost, across six tasks including the four
it and they both passed. `ctx0` is ~23K for cc on every single task against
4.7–7.6K for both prime arms. It peaked at **118K resident** on `magsac-install`.
This is the campaign's most robust finding.

**2. claude-code has no usable long-wait behaviour under `-p`, and this is the
strongest wait-half evidence the project has.** On `compile-compcert` it
backgrounded the build correctly, polled its own task-output file, went looking
for a `Monitor` tool via `ToolSearch`, wrote `until grep -q …; do sleep 10; done`
— and then ended its turn at 225s of a 2400s budget with
`"OCaml 4.14.2 is still compiling. I'll continue when it lands."`, reporting
`subtype: success`. It had built nearly the right thing and lacked only a **resume
seam**. prime's `jobs.wait(wake_after=N)` ends the turn *and the harness restarts
it*; `claude … -p` has no addressee. n=1, mechanism named, class AGENT — but the
arms genuinely differ in wake support and that difference is the treatment.

**3. The jobs runtime is clean and its watchdog is safe.** Across six tasks:
0 blocking sleeps, 0 wedged cells, 0 kernel restarts, `jobs_staging.bound = true`
and full preflight on every codemode run, `jobs.` adopted on 5 of 6 tasks (2–13
cells). The 120s wedge-suspect trip **false-positived nothing** — including on a
2200s Coq build, a 1473s OpenCV build and a genuine GPT-2 LoRA training run, which
is exactly the corpus §8.4 admitted it lacked.

**4. Cache expiry is real, caused by waits, and scales with resident context —
but only the cost half.** 8 expiry events across the campaign, every one with a
424–903s gap before it, and **0/0/0 on all three arms of both tasks with no long
wait** (cartpole, sqlite) — a control that rules out the detector firing on
ordinary turns. Cost $0.098–$0.516 per arm over the campaign, 13–29% of run cost
on the tasks where it bites. **The latency half is unsupported and should stop
being quoted**: across 8 events, wake-turn latency is at or below the arm's own
warm median in 7 of them; the single exception (cc, 8.1s vs 4.8s warm, on a 21.6K
re-warm) is contradicted by its own second event at 2.3s.

**5. The honest negative: codemode did not beat vanilla.** 4/6 vs **5/6**
resolved, $2.662 vs **$2.538**, and accumulated context a statistical tie
(1.634M vs 1.657M — 1.4% apart). Vanilla was cheaper on 4 of 6 tasks. Three
distinct causes were identified from traces, and **none of them is the tool
surface**:

- a `def sh(c): print(r.stdout[-4000:])` helper codemode wrote itself and used 16
  times on compcert, against vanilla's habitual `tail -3` (§3.2) — the
  "caller decides what survives" affordance used to keep *more*;
- a wrong-Coq-version detour that made codemode do 35% more work on the same task
  (43,779 vs 32,345 procs);
- train/serve preprocessing skew on `train-fasttext` (§7.3).

n=6 paired tasks, far under the ~20 `CLAUDE.md` requires to rank two arms, so this
is **not** a ranking. It is a flag that the representation advantage measured on
AppWorld does not reproduce on shell-shaped terminal work, where the code arm pays
a `%%bash`/`subprocess` framing tax to reach the same shell the other arm has
natively.

**6. Not run, deliberately.** Phase 1b's last three tasks
(`train-bpe-tokenizer`, `gcc-compiler-optimization`, `password-recovery`) and
**Phase 2 (subagents ON/OFF) were never run.** Phase 2 would additionally have
measured nothing as wired: `prime_agent._stage_jobs` copies `jobs.py`,
`kernel-prelude.py` and `harness_unshadow.py` but **not** `subagents.py` /
`subagent_run.py`, and `_bind_subagents()` is deliberately failure-tolerant — so
`HARNESS_SUBAGENTS=1` would have recorded
`SUBAGENTS not available: ModuleNotFoundError` and come up anyway, and the run
would have looked like "the agent chose not to delegate". Confirmed in every
`prelude-status.txt` this campaign produced: `SUBAGENTS off`. **That staging must
be added and A0'd before any subagent number is believed.**
