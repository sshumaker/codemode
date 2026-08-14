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

Status: **Phase 0 (oracle screen) in progress.**

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
| `hf-train-lora-adapter` | 1800s | screening |
| `magsac-install` | 1500s | screening |
| `password-recovery` | 900s | screening |
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
| `magsac-install` | screening | | |
| `password-recovery` | screening | | |

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

