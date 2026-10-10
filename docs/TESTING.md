# Testing

Three tiers. The first two are free, deterministic and need no credentials; the third
costs money and runs only when you point it at an env file.

| tier         | command                                                         | what runs                                                                                                                                                                                                                        | needs                                 |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| unit + chaos | `npm test`, `npm run test:kernel`, `npm run test:remote-kernel` | mocked clocks and fakes, plus small real-process checks (jobs, the scheduler under SIGKILL, a real kernel for some tool tests)                                                                                                   | `scripts/dev-env.sh`                  |
| integration  | `npm run test:integration`                                      | real processes end to end: `runtime/scheduler.py`, prime's built CLI (`prime -c -p`, the argv the scheduler runs), a real IPython kernel, real jobs and invocation store, a real Temporal dev server — with a **scripted model** | `scripts/dev-env.sh`                  |
| live         | `npm run test:live -- --env-file PATH`                          | the same worlds with a real model, and the Daytona backend against a real account                                                                                                                                                | an env file you own, outside the repo |

## Bootstrap

```bash
scripts/dev-env.sh            # idempotent; does only what is missing or stale
scripts/dev-env.sh --check    # reports ready / missing / stale, changes nothing
```

It explains each step as it goes and stops with the fix when something is wrong:

1. **Tools** — node, npm, python3, uv, git (and the `temporal` CLI, which only the
   Temporal scenario needs). Checked, never installed.
2. **npm dependencies** — the root, and `vendor/prime-agent` with `--ignore-scripts`
   (prime's `prepare` runs husky, which would rewrite this repo's git hooks config).
3. **prime patches** — `port-vanilla-tools.mjs` and `neutralize-prime.mjs` are replayed on
   a scratch copy and compared with `vendor/prime-agent`; the scripts run on the real
   tree only if they differ. (The tree is committed patched; re-running them blindly
   rewrites files and forces a rebuild.)
4. **prime build** — tui → ai → agent → coding-agent, each with `tsgo -p
tsconfig.build.json`, never `npm run build`: the ai package's build regenerates the
   model catalogue over the network, rewrites `packages/ai/src/models.generated.ts` and
   fails offline. A package whose `dist` is older than any file in its `src` is rebuilt,
   along with everything after it (a stale dist once failed seven remote-kernel tests).
5. **Kernel venv** — the one prime uses: `PRIME_AGENT_KERNEL_PYTHON`, else
   `$PRIME_AGENT_KERNEL_VENV/bin/python`, else `~/.prime/agent/kernel-venv/bin/python`. If
   it does not exist, prime's own `ensureKernelPython` creates it. Then
   `scripts/requirements/kernel.txt` (matplotlib, Pillow) is installed into it. This is
   the only thing outside the checkout the script changes.
6. **`vendor/mcp-bench`** — in a worktree, a symlink to the primary checkout's copy;
   otherwise `scripts/setup-mcp-bench.sh --clone-only`.
7. **`.venv-itest`** — a project-local, gitignored uv venv with
   `scripts/requirements/itest.txt` (temporalio), for the Temporal scenario.
8. **Reported only** — the remote-kernel test venv under `~/.cache`, which
   `test:remote-kernel` builds itself on first run.

## The scripted model

`runtime/integration/scripted-model.mjs` is an OpenAI-compatible `/v1/chat/completions`
endpoint (streaming) that replays a script of assistant turns. prime reaches it as a
custom provider (`scripted/scripted-1`) through the agent home's `models.json` — the same
mechanism as any self-hosted model — so a turn goes through prime's real provider code,
agent loop, tools and session persistence. Nothing in prime is patched for it.

A script (`runtime/integration/scripts/*.json`) is one entry per model request, served in
order across every prime process of the scenario (a session's turns survive the process
exiting at a wait and the scheduler starting `prime -c`):

```json
{
  "turns": [
    {
      "expect": "start the job",
      "ipython": "jobs.submit('sleep 2', name='bg')"
    },
    { "expect": "\\[woken: job 'bg': succeeded", "text": "done" },
    {
      "expect": "ALPHA",
      "hold": "first",
      "text": "held until the test releases it"
    }
  ]
}
```

- `text` and/or `ipython` (or `tools: [{name, args}]`) make the response;
- `expect` is a regex the request's last message must match — a mismatch is recorded in
  `model.errors` and answered with text, never a tool call, so a wrong turn cannot
  wander off and do something;
- `hold` withholds the response until the test calls `model.release(label)`, which is
  how a scenario kills a process _exactly_ mid-turn instead of after a sleep;
- `{{NAME}}` is substituted from the scenario's vars.

Every request is recorded with the full message list (`model.requests`, and
`requests.jsonl` in the scenario dir), so scenarios assert on what the agent was shown in
its next turn, not only on the files left on disk.

## The integration suite

`npm run test:integration` runs `runtime/integration/*.test.mjs` one file at a time
under a per-run base directory, then fails if any process the suite started is still
alive. `npm run test:integration -- --repeat 3` is the flake check (stops at the first
failure); any other arguments go to `node --test` (e.g. `--test-name-pattern barrier`).

| file        | scenario                                                                                                                                         | asserts                                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakes`     | a job started and never waited on                                                                                                                | the session is woken once when it finishes; the invocation is delivered (the woken turn carried exactly it); the outcome opened exactly one turn                                                                       |
| `wakes`     | barrier: `jobs.wait` on three jobs, one failing                                                                                                  | one wake carrying all three outcomes, after the slowest finished; the wait is consumed                                                                                                                                 |
| `crashes`   | SIGKILL of prime mid-turn (its model call held), a second message sent before the crash                                                          | one re-wake saying the turn was interrupted; the message the crashed turn received is not re-injected, the one sent before the crash is shown once; never two prime clients                                            |
| `crashes`   | SIGKILL of the scheduler mid-turn                                                                                                                | a second scheduler sees the orphan and starts nothing; the orphan finishes; recovery settles it once (`settled_by: recovery`)                                                                                          |
| `kernel`    | the kernel SIGKILLed after a cell made three proxy calls (`HARNESS_KERNEL_AUTORESTART=1`)                                                        | the cell is not re-run (the proxy saw each call once); the model is shown completed / completed / UNKNOWN; the store folds the same journal                                                                            |
| `kernel`    | an `at_most_once` call claimed, then the kernel dies before the request leaves                                                                   | the model is shown UNKNOWN; the proxy never receives it; no wake retries or re-delivers it                                                                                                                             |
| `lifecycle` | a session deadline passes while the agent waits on long jobs                                                                                     | one wrap-up wake; `end.json` + `reap.json`; every process in the jobs' process groups, the kernel and the harness gone (pid + start time); a message after the end wakes nothing                                       |
| `temporal`  | the Temporal backend against a real `temporal server start-dev` (ephemeral port and db); the worker is a separate process SIGKILLed mid-activity | the idempotent call is resent once on the new worker under the same key and succeeds; the `at_most_once` call ends UNKNOWN and is never resent; both outcomes land in the session's store and wake it, each shown once |
| `backend`   | `runtime/kernel/local.mjs` opens a real srt-sandboxed kernel                                                                                     | the runtime (incl. `invocations.py`) is staged and imported from there; a read outside the conversation is denied; loopback reaches the tool proxy; a job and the proxy call project into the staged invocation store  |

The Temporal backend is not wired into any host or into the scheduler. The scenario
tests the boundary it does have: a host submits into the session's invocation store
(`temporal/submit.py`), the workflow's report activity writes the outcome there, and the
real scheduler wakes the real session with it. No opt-in seam was added.

Each scenario runs in a `World` (`runtime/integration/lib.mjs`): its own agent home,
IPython dir, work dir, session, a private prime daemon socket and a short TMPDIR (prime
puts each session worker's unix socket under TMPDIR, and macOS caps a socket path at
104 bytes — a deeper TMPDIR makes every turn time out after 30 s). `cleanup()` stops the
schedulers, prime clients, the daemon, job processes and anything else whose command
line, cwd or unix socket is under the world's directories, even when an assertion
failed. A failed scenario keeps its directory (printed) with `requests.jsonl`,
`scheduler.log`, the session dir and prime's logs; `HARNESS_ITEST_KEEP=1` keeps every
one.

Hosts that run prime under the scheduler should set `HARNESS_OWNED_WORKER_GRACE_MS=0`
for prime (the World does): prime's daemon otherwise keeps a killed client's turn
running for 30 s, unsupervised, and every `prime -c` on that session in that window
fails with "Session is already active".

### Adding a scenario

1. Write the model's side as `runtime/integration/scripts/<name>.json` — one turn per
   model request, each with an `expect`, and a `hold` wherever the test needs to act
   mid-turn.
2. Add an `it(...)` to the matching `*.test.mjs` (or a new file) that calls
   `scenario(label, { script, vars, env, session, delivery }, async (w) => { ... })`.
   Drive it the way a host does (`w.post(text)`, `w.startScheduler()`), wait on real
   conditions with `until(...)` (never a bare sleep for correctness), then let the
   scheduler scan a few more times before asserting "exactly once".
3. Assert both sides: durable state (`w.turn()`, `w.lastTurn()`, `w.invocations()`,
   `w.inbox()`, files under `w.session`) and what the model saw
   (`w.model.requests[i].last`, `World.occurrences(request, text)`), plus
   `w.model.errors` is empty.
4. Anything the scenario starts outside the World (a server, a worker) goes in
   `w.cleanups`. Run the file three times before committing.

## The live tier

```bash
npm run test:live -- --env-file ~/.config/harness/live.env [--max-cost 1.00]
```

The env file lives outside the repository (the runner refuses one inside it) and is
sourced by a bash subshell that execs the test processes; the runner never reads it.
Without it, the tier prints how to create one and exits 0. (`--` matters: Node 25
treats an `--env-file` after the script as its own flag and would load the file into the
runner itself; `package.json` already passes it.)

| variable                                                           | for                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `ANTHROPIC_API_KEY` (or `OPENROUTER_API_KEY` / `ZAI_API_KEY`)      | the real-model scenarios                              |
| `HARNESS_LIVE_MODEL`                                               | the model (default `anthropic/claude-haiku-4-5`)      |
| `DAYTONA_API_KEY` (+ optional `DAYTONA_API_URL`, `DAYTONA_TARGET`) | the Daytona scenarios; skipped without it             |
| `HARNESS_LIVE_MAX_COST`                                            | the cap, if not given as `--max-cost` (default $1.00) |

- `live/model.live.test.mjs` — the unwaited-job and barrier scenarios with a real model:
  the model ends its turn without waiting, is woken by the scheduler, and uses the
  outcome. Each scenario's cost (prime's own usage accounting) goes into a per-run
  ledger; once the cap is reached the remaining scenarios skip.
- `live/daytona.live.test.mjs` — `DaytonaKernelBackend`: create (a real prime turn with
  the scripted model against the sandbox's kernel, files both ways, destroy), warm pool
  (a new conversation claims the warm sandbox), sweep and restore (an idle sandbox is
  swept; reopening restores the workspace from the host's copy). Every sandbox carries a
  per-run `pool_owner` label and Daytona's auto-delete backstop; the suite's `after`
  deletes every sandbox with that label and fails if any remain.

The live tier has not been run yet; expect to fix small things the first time.

## What is not covered

- The scripted model proves the machinery, not that a model understands it — that is
  the live tier's job, and `runtime/eval/` for trajectory reading.
- Linux: the local (srt) backend scenario is macOS-only and skips elsewhere; the rest
  should run but has only been run on macOS.
- Subagents and the subagent broker end to end, the remote kernel under the scheduler,
  and RPC-mode hosts are covered by unit/chaos tests and `test:remote-kernel`, not here.
