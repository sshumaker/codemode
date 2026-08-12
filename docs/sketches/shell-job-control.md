# Sketch: shell job control as the durable-work surface

Status: **REJECTED by its own pre-registered falsifier at n=16.** Prototype and tests
remain in `runtime/shell_jobs.py` / `runtime/test_shell_jobs.py` as a recorded
negative result; the adoption path must not ship on this evidence. One finding
survives and is worth acting on — see §4.5 and §5.1.

## The problem this is reacting to

`jobs.submit(cmd, name=...)` is out of distribution. Measured, unprompted, on the two
reproduced TheAgentCompany failures, the agent reaches first for:

| idiom | where it comes from |
|---|---|
| `time.sleep(30)` | every Python corpus |
| `%%bash … sleep 30` | every shell corpus |
| `subprocess.Popen(...)` then poll | the standard "background work" recipe |
| `nohup … &` | the standard shell one |
| `threading.Thread(target=poll)` | 48 times in one real TAC run |

Five routes, none of them ours. Today each is refused and the refusal names the
replacement, which *works* — one refusal, adoption on the very next cell, every time
— but it is fighting the prior rather than using it.

## The bet

Unix already has the API for "start work, don't hold my terminal, come back to it",
and every model knows it cold:

```bash
long_pipeline &     # start it, keep my prompt
jobs                # what is running
kill %1             # stop it
```

So stop refusing `cmd &`. **Adopt it.** The model writes what it was always going to
write; the runtime makes it durable underneath.

This also clears the objection that killed adopting `subprocess.Popen`: Popen has no
durable identity, and §5 of the runtime design forbids synthesising a handle name.
Shell job control *has* a naming convention — positional `%1`, `%2`. Adopting it is
using a documented identity, not inventing a hidden one.

## What it looks like

```bash
%%bash
zcat huge.gz | grep ERROR > out.txt &     # adopted, durable, survives the kernel
```
```
[bg1] 77805
```
```python
jobs.manifest()
# [1]+  Running      zcat huge.gz | grep ERROR > out.txt &
jobs.get("%1").output
jobs.kill("%1")
```

Names resolve as the shell resolves them: `%1`, `%+`, `%-`, `%prefix`, or the name.

## The one deviation, and why it cannot be removed

`wait`. In a shell, `wait %1` **blocks**. Here it must end the turn instead.

That is not a vocabulary choice, it is forced. A wait needs wall-clock to pass, so no
amount of resumability removes it — snapshot the process and guest time stops; keep it
running and you did not need the snapshot. You either hold the kernel or you release
the agent's attention, and only the second is compatible with a single-threaded kernel
serving a turn-based agent.

So the deviation is one verb, not a whole API. (And our verb is arguably the wrong
name for it: every `wait` the model knows — `Popen.wait`, `Thread.join`,
`Future.result`, `asyncio.wait` — blocks. `pause_until` / `check_back_in` state what
actually happens. Also testable; see §5.)

## Mechanics

`rewrite_background(cell_source)` → `(rewritten source, [(name, command)])`.

Line-oriented, deliberately. A token-level rewrite would have to regenerate shell
source, and regenerating shell from tokens destroys quoting, redirection and
heredocs — the same class of damage that once turned `\n` into a literal newline in
this repo. The tokeniser decides *whether* a line backgrounds something; the original
line text is what gets wrapped.

The injected helper delegates to `jobs.py --spawn`, i.e. to `submit()` itself, so an
adopted job and a submitted one are identical by construction: same spool file, same
exit marker, same lifetime. `jobs.get()` cannot tell how a job was born.

### What the tests are weighted toward

A false positive rewrites a command the user did not background and corrupts a working
cell. A false negative leaves an untracked process — the exact failure this removes.
So the suite is mostly *near-misses*:

- `make && ./run` — `&&` is not backgrounding (the most common way to get this wrong)
- `./run > out.txt 2>&1` — a redirect containing an ampersand
- `echo "tom & jerry"` — quoted
- a heredoc body containing `sleep 30 &` — data, not code
- `zcat f.gz | grep E &` — a **pipeline is one job**, not two

plus a non-vacuity test, because a rewriter that adopts nothing passes every
false-positive test while doing no work.

### Two bugs the tests and a live run already found

- **A pipeline was split.** `|` was treated as a command terminator, so
  `zcat f.gz | grep E &` adopted only `grep E` and silently dropped the rest.
- **`setsid` does not exist on macOS.** The first helper inlined it, so every adopted
  job died instantly with `setsid: command not found` — while still writing a job
  record that looked entirely correct. Found by executing a rewritten cell, not by
  reading it. This is why the helper now delegates to `submit()`.

## §4.5 What the agent actually did — the surface should shrink

Run with adoption on, no resident prompt, the agent wrote:

```python
# cell 3
jobs.wait(wake_after=30)
# cell 4
print(open('.../inbox.txt').read())
```

**It never touched `%1`. It never touched `.output`.** It read the file — because the
output was already in a file it had named itself.

That is the answer to "is this how someone would normally use it?" In bash you do not
ask a job object for its output:

```bash
cmd > out.txt &     # the redirect IS the handle
jobs                # what is running
wait                # or: wait %1
cat out.txt         # just read it
```

`jobs.get("%1").output` competes with `cat out.txt` and loses. So most of the surface
built here is our invention competing with the filesystem:

| surface | keep? | because |
|---|---|---|
| adoption (`&` survives the kernel) | **yes**, and invisibly | no Unix idiom means "outlive my shell *and* the kernel" |
| turn-yielding `wait` | **yes** | the one forced deviation |
| `.reason` — "deadline reached, never fired" | **yes** | distinguishes a wrong condition from a slow one; no `$?` equivalent |
| `.output` | no | `cat out.txt` |
| `.state` / `.done` | no | the `jobs` listing, or the file existing |
| `.exit_code` | mostly no | `$?`, or "Done"/"Exit 3" in the listing |
| `%1` resolution | **no** | only needed by verbs the agent does not reach for |

`%1` was built to answer the naming objection. The objection **dissolves** instead: if
the agent never needs to name the job, there is nothing to name. It named the *file*.
That is the durable identity, and Unix already had it.

## §5 The measurement that decides this

The distribution claim makes a prediction, and the instrument already exists
(`attemptsBeforeAdoption`, `guardFiresBeforeAdoption` in `runtime/eval/run.mjs`).

Arms, on the two reproduced TAC failures (`reply`, `broadcast`), **no resident
prompt**, n=5:

1. today — `cmd &` refused, `jobs.submit` taught by the refusal
2. this sketch — `cmd &` adopted
3. optionally, verb renamed (`pause_until`) to separate naming from adoption

Prediction if the distribution argument is right: arm 2 adopts at 0–1 cells with no
guard fires, against arm 1's 2–3 cells with 1–2 refusals.

Falsifier worth stating in advance: if arm 2 adopts no faster, then the prior was not
the obstacle, the refusals were doing the work, and the added rewriting machinery buys
nothing. In that case keep the current design and delete this.

### Result at n=6 per arm — marginal, and honestly reported as such

| arm | pass | ever adopted | cells to adopt | guard fires | cells |
|---|---|---|---|---|---|
| 1 today (refuse) | 5/6 | 5/6 | 2.8 | 1.2 | 5.2 |
| 2 adopt + surface | 6/6 | 6/6 | 2.2 | 1.0 | 4.7 |
| 3 adopt + files-only | 6/6 | 6/6 | 2.2 | **0.8** | **4.5** |

Two readings, and only one of them is supported at this n:

- **Supported: arm 3 ≥ arm 2.** The files-only variant matches the full surface on
  every measure and beats it slightly on guard fires and total cells. The `%1` /
  `.output` / manifest-hint surface buys nothing, which is what §4.5 predicted from
  the trajectory. Parsimony decides this even without more data: two designs perform
  the same and one is smaller.
- **NOT supported: adoption beats refusal.** 2.2 vs 2.8 cells is a 0.6-cell
  difference on n=6, well inside this project's documented ~27% run-to-run noise, and
  CLAUDE.md is explicit that under ~20 paired cells cannot rank two variants. Scaled
  to n=16 per arm before drawing any conclusion.

The temptation here is to read the direction of the means and declare a win. That is
precisely the mistake that ranked v3 *worse* on 5 tasks before 24 cells showed the
opposite.

### §5.1 Result at n=16 per arm — the falsifier fired

| arm | pass | adopted | cells to adopt | guard fires | cells |
|---|---|---|---|---|---|
| 1 today (refuse) | 14/16 | 14/16 | 2.79 | 1.31 | 5.19 |
| 2 adopt + surface | 14/16 | 14/16 | 2.57 | 1.06 | 4.81 |
| 3 adopt + files-only | 14/16 | 14/16 | 2.64 | 1.06 | 4.88 |

Paired within (task, repetition):

- `A1 − A3`: n=12, mean **+0.25 cells**, and 4 worse / 2 better / **6 tied**
- `A2 − A3`: n=14, mean **−0.07 cells**, 5 worse / 4 better / 5 tied

**Adoption does not adopt faster than refusal.** Pass rate is identical (14/16
everywhere), the paired difference is a quarter of a cell, and half the pairs are
exact ties. This is precisely the condition written down in advance: *the prior was
not the obstacle, the refusals were doing the work, and the rewriting machinery buys
nothing.*

So the distribution argument — which I found persuasive, and argued for at length —
is **not supported**. It predicted arm 2 adopting at 0–1 cells with no guard fires;
it adopts at 2.57 with 1.06. The error channel was already carrying it.

What survives:

- **The surface is dead weight** (§4.5). Arm 3 matches arm 2 on every measure while
  advertising nothing, and the agent ignored `%1` and `.output` in favour of reading
  its own file. That is decided by parsimony, not by significance: two designs
  perform identically and one is smaller.
- **The design rule generalises even though this instance failed.** Ask what you
  would write naturally; check whether a proposed accessor duplicates a path or an
  exit code. It is now in `CLAUDE.md`.

Worth stating plainly: the falsifier was written before the data, and it is the
reason this is a two-hour negative result rather than a shipped feature.

## Known limits

- Heredocs are skipped wholesale rather than parsed; a heredoc delimiter that is also
  a valid command line would confuse it.
- `&` inside `$(...)` command substitution is not analysed.
- Process substitution `<(...)` is untested.
- Adoption gives positional names only; a task wanting a stable name across sessions
  still wants `submit(name=...)`.
