# harness — working notes

## Never hand-roll a benchmark run

There is exactly one iteration command. Use it.

```bash
npm run iterate -- --variants v7,v10          # ~5 min, unjudged, cost/turns only
npm run iterate -- --variants v7,v10 --judge  # ~8 min, adds the MCP-Bench score
```

Do not invoke `bench/run-task.mjs` in a shell loop, do not spawn `bench/judge.mjs`
per run, and do not pick concurrency by hand. Every one of those has already cost
45 minutes of wall-clock in this project:

- a sequential bash loop over tasks (should have been `pool()`),
- `judge.mjs` spawned once per run with `--concurrency 1`, which serialized the
  entire scoring stage and took longer than the runs it was scoring,
- concurrency left at the default while the API key comfortably supports 48+.

`bench/quick.mjs` enforces the right shape and refuses obviously wrong settings.

## Opus is the model under study

`npm run iterate` defaults to `anthropic/claude-opus-5`, prompt `q8`, delta
namespace injection — the best measured configuration (0.809 overall).

Do not tune on Sonnet. The two models disagree about configuration: Opus scores
higher with *delta* injection (0.809 vs 0.799 full) because it retains a binding
after one mention, while Sonnet needs the full listing repeated (0.776 vs 0.760).
Tuning on the cheap model optimizes for the wrong one.

## The objective is the score, not the cost

MCP-Bench asks whether the task was completed with the right tools. Turns and
cost are cheap proxies worth watching, but a variant can be cheaper simply
because it gave up sooner. **Rank by `score`/`fulfil`; use cost as a tiebreak.**
Several hours went into optimizing cost before this was checked.

## Sample size: ~27% run-to-run noise

The same prompt on the same task, run twice, differed by 29% in turns and 26% in
cost. Anything under ~20 paired cells cannot rank two variants — an early 5-task
comparison ranked v3 *worse* when 24 cells later showed it significantly better.

Prefer `--repeat 4` over more tasks. Always run the paired t-test, never eyeball
the means.

## Before trusting any result

```bash
node bench/validate.mjs      # residency, rate limits, network bypass, judge noise
npm test                     # 141 tests, fairness invariants included
```

Confounds that already invalidated whole result sets, each now pinned by a test
in `bench/test/fairness.test.mjs`:

- the vanilla arm reaching APIs with `curl`, bypassing the tools under test
- the two arms receiving base system prompts differing 10x in length
- single-sample LLM judging, whose noise matched the effect being claimed
- a rate-limited server returning 429s as *successful* MCP responses
- a runId scheme change silently overwriting already-reported runs

## Both arms get real guidance

Each arm is told how to use its own tool surface — codemode via
`VARIANTS`, vanilla via `VANILLA_VARIANTS` in `bench/prompts.mjs`. Stripping one
arm's guidance to "make it fair" measures which representation survives a bad
prompt, which is not a question anyone cares about. Level up, not down.

## Record negative results

`bench/prompts.mjs` keeps every variant that lost, with its measured numbers and
why it was expected to win. v2 (rules) and v8 ("slicing costs nothing", which is
true for context and false for turns) are more informative than the winners.

## Never cache tool results transparently

Deduplicating identical MCP calls in `_client.py` looks like free efficiency —
29% of calls in a run are byte-identical repeats — and it is not safe.
**Read-only is not idempotent.** Reddit hot threads, Steam trending and market
prices change between calls, so a cache serves stale data the model then reasons
over; for any server with side effects it is simply wrong.

Deduplication is the agent's judgement call, per tool, which is what the `q6`
ledger prompt asks for. Do not move it into the transport.

## Patch snippets live in scripts/patches/*.ts

Injecting TypeScript into the vendored tree as an escaped string inside a
heredoc-inside-python mangles every backslash — `\n` became a literal newline
and `\w` became `w`, producing a file that would not compile. Write the snippet
as a real `.ts` file and have `neutralize-prime.mjs` read it.

## Do not hillclimb efficiency on the fast subset

`bench/quick.mjs` selects tasks by speed, and tasks are fast partly because they
need fewer tool calls — the same axis `parallelism_and_efficiency` scores. Prompt
work that drove duplicate calls from 29% to 0% on the fast subset left codemode
*behind* vanilla on that dimension over the full set (-0.069, t=-3.42).

Use quick to iterate on fulfilment, grounding and cost. Confirm anything
efficiency-shaped on the full grounded set before believing it.

## TheAgentCompany fails silently, in both directions

Every TAC bug found so far produced a *plausible number*, not an error. A run
that scores 0/6 looks like a weak agent and is usually a broken harness. Assume
a surprising score is your bug until you have checked these.

Grading and seeding both need `LITELLM_*`. `evaluate_with_llm` catches its own
failure and returns `False`, so without a key a correct answer scores zero and
nothing says why — 26 of 175 tasks grade this way, and 41 more seed NPC
colleagues with the same credentials. The vendored litellm is 1.23.16 and routes
unknown models to Anthropic's retired `/v1/complete`; use Anthropic's
OpenAI-compatible endpoint (`openai/<model>` + `https://api.anthropic.com/v1/`)
rather than upgrading litellm, which is part of upstream's grading code.

NPCs die unless detached. `init.sh` starts one process per NPC, and they are
killed when the `docker exec` that ran it exits — the container is left with
`<defunct>` shells and no colleagues, and the *arm* gets blamed for the silence.
Relaunch with `docker exec -d` + `setsid` and wait for them to listen. OpenHands
avoids this only because it drives the container through a persistent server.

Grade in a fresh container, never the agent's. The agent shares a Python
environment with the grader and can break it — one run `pip install`ed easyocr,
which pulled torch, upgraded numpy and killed `eval.py`'s imports — and it can
edit `/utils/evaluator.py` outright. Copy `/workspace` into a pristine container
off the same image instead.

`docker cp src dest` copies *into* `dest` when it exists. Staging `/workspace`
under a reused run directory handed the previous attempt's artefacts to the
grader: a deliberately crippled 12-second run scored 3/3 on work it never did.
`rm -rf` the staging path first.

Kill the agent on `exit`, not `close`. The codemode kernel is a `docker exec -i`
that inherits the agent's stdio; when a timeout SIGKILLs the agent, that orphan
holds the pipes open and `close` never fires. One task sat wedged twenty minutes
past its own timeout.

Prune after every task or the sweep destroys the company. Task images are ~1.5GB
and every task container spawns an anonymous volume from the image's `VOLUME`
directive. A 40-task sweep filled a 98GB docker disk by task 8 — 54GB of it
stranded volumes — at which point GitLab and ownCloud stopped answering, MongoDB
and Plane went into restart loops, and every later task recorded UNGRADED with
no indication the cause was disk. Remove containers with `-v`, drop each task
image once both arms are done, and watch free space. upstream's `run_eval.sh`
prunes for exactly this reason.

Never `docker prune` broadly while the company is up. Recovering from the disk
incident with `container prune` + `volume prune` deleted the stopped GitLab and
ownCloud containers *and* Plane's `pgdata` volume, and there is no local backup
to restore from — Plane came back only because upstream publishes volume
archives at the `PLANE_DOWNLOAD_URL` default baked into `plane-app/restore.sh`
(`the-agent-company-backup-data`, release `plane-20241031-0351`). Scope every
prune to the `tac-*` containers the harness created.

Bring the stack up with `make`, not `docker compose`. `make start-all` exports
`GITLAB_PORT=8929` and uses project `-p theagentcompany`; a bare `docker compose
up -d` silently binds GitLab to a blank port and creates a parallel project.
`make start-plane` additionally sequences start → restore volumes → restart,
which is the only way the seeded Plane data lands.

Tasks cannot run in parallel on one stack. Each `init.sh` calls `reset.sh`, which
wipes the shared services; concurrent tasks corrupt each other's world, and since
the grader inspects that world it surfaces as a *score*, not an error.
Parallelism needs one service stack per worker on its own Docker network, with a
small edge proxy aliased to `the-agent-company.com` — the canonical hostname and
ports are baked into `external_url`, `ROOT_URL` and the task prose, so they must
stay canonical. Everything else is parameterized (`SERVER_HOSTNAME`, `*_PORT`).

Not every reference answer is right. `admin-arrange-meeting-rooms` keys on 4
conference rooms; the correct answer is 5 (five meetings overlap at 12:00–12:15).
Both arms computed 5 and both scored 0/2. Check the task's `evaluator.py` in the
repo before believing a confident-looking failure.

The benchmark leaks the env-LLM API key to the agent. `run_multi_npc.py` builds
its command with the key inline, so it lands in `ps` and `/tmp/npc.log` inside
the container the agent works in. Run TAC on a throwaway key.

## Inspect a handful of runs before any expensive kickoff

Whenever a new benchmark is wired up, or the harness changes in a way that
touches how the agent acts, run **three to five tasks and read each trajectory
end to end** before launching anything that costs hours. Not the summary line —
the actual cells, the tool calls, the final artefact, and the per-checkpoint
breakdown.

This is not caution, it is the cheapest way to find the bugs that do not raise.
A 40-task kickoff spent nine hours proving the disk had filled at task 8; a
second one spent hours measuring a codemode arm that could not see images,
because the container kernel silently dropped the attachment path that prime's
own kernel uses. Both were visible in the first three trajectories. Neither was
visible in the aggregate, which is exactly the problem: a broken harness and a
weak agent produce the same-looking number.

What to actually check in those first runs:

- Did each arm use the tool surface you think it has? Read the calls, do not
  assume the flag worked.
- Does a deliberately crippled run score badly? If a 12-second run scores well,
  something is leaking state.
- Does a known-correct answer score well? If not, the grader is misconfigured
  before the agent is weak.
- Are both arms graded on the same tasks? Unequal denominators are not a result.

## Run the real harness, not a reimplementation of it

The thing under test is the harness. Every component swapped for a hand-written
equivalent stops measuring it and starts measuring the clone.

TheAgentCompany needed the agent to act inside a task container, and prime's
kernel speaks ZMQ to ipykernel on ports that do not cross the colima VM
boundary. The wrong fix — taken first — was a hand-rolled kernel driven over
`docker exec`, plus a hand-rolled `bash`/`read_file`/`write_file` extension for
the vanilla arm. Both arms were then reimplementations, and the divergences were
invisible until one of them (dropped image attachments) cost a task.

The right fix is to move the harness to where its own machinery works: install
node and prime's `dist/bundle/cli.js` inside the container and run it there, with
`PRIME_AGENT_KERNEL_PYTHON` pointing at a venv with `ipykernel`. The bundle
externalizes `zeromq` and `undici`, so install those in the container too. Claude
Code runs in the container the same way, which makes all three arms genuinely
symmetric: the real harness, on the real machine, with its real tools.

## Log the inputs, not just the verdicts

Every check in this project that recorded a *result* without its *evidence* has
produced a confident wrong answer that could not be diagnosed afterwards:

- `find_spec` certified a module that contained a syntax error, because locating
  a module does not execute it.
- A cell interrupted at 45s was reported by the model as "completed with no
  output and no errors" — the interrupt had no notice attached.
- An LLM-graded checkpoint disagreed between two arms that had posted
  byte-identical text. The judge turned out to be deterministic; the difference
  was in the *content* assembled into its prompt, which was never logged and
  which `reset.sh` destroyed minutes later. The cause is now unknowable.

So: whenever something is judged, sampled, or checked, persist what it saw.
`bench/tac/judge-trace.py` is the pattern — wrap the call, append
`{content, predicate, verdict, model}` to a JSONL, copy it out with the run.

The test for whether logging is sufficient: **could you re-derive the verdict
tomorrow, after the environment has been reset?** If the evidence is assembled
from mutable service state, the answer is no unless you captured it.

## TheAgentCompany: see docs/TAC-HANDOFF.md

Full status, the twelve harness bugs found (each of which produced a plausible
number rather than an error), the benchmark's own defects, the outstanding
logging plan, and the wait/wake design notes.
