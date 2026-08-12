# What the waits are actually for — a classification of every waiting construct in the traces

Answers the first "Open" question in `HOSTED-RUNTIME-DESIGN.md` §12: classify every cell
containing `sleep`, a poll loop or a `threading.Thread` by *what it was waiting for*, and
say whether a fifth category exists.

**Short answer: yes, there is a fifth category, and it is not in TAC.** It is in MCP-Bench,
where 407 cells wait for a **rate limit or a transient upstream failure to clear** —
retry-with-backoff and self-pacing. It needs no new verb, but it is not served by
`jobs.wait(wake_after=…)` either: at a median of 5 s inside a call loop it is two orders of
magnitude below the 60 s `wake_after` floor. It has to be absorbed as *retry + throttle
policy inside `jobs.submit`*. §5 below.

The doc's fourth category ("a condition on service state") is **not independently attested**:
every observed service-state condition is on a process the agent itself launched in the same
run. §4.3.

---

## 1. Corpus, method, and one correction to the denominator

### `.run/tac` and `.run/tac-noinstr` are the same corpus

84 of 89 `trajectory.json` files are **byte-identical** between the two directories (same
`md5`, same session id). Only 5 runs differ (`admin-make-spreadsheet` ×2,
`admin-read-survey-and-summarise` ×2, `hr-check-attendance-one-day` codemode), and between
them they contribute **one** extra waiting construct (a `sleep 5`). Summing both directories
double-counts everything.

**Canonical corpus used below: `.run/tac-noinstr`** — 89 runs = 41 codemode + 40 vanilla +
8 claude-code, 1,410 tool calls (556 ipython cells, 543 bash calls, 311 claude-code tool
calls).

Two data-source notes:

- `stream.jsonl` in a TAC run directory can contain **more than one session** (a re-run
  appended to the same directory). `pm-schedule-meeting-2` codemode has 47 ipython events in
  `stream.jsonl` but 32 in `trajectory.json`, and 32 files in `workspace/.cells/`. The 32 is
  correct. `bench/analyze_carryover.py:176` reads `stream.jsonl`, so any figure taken from it
  inherits the stale-session inflation.
- Per-cell wall-clock is recoverable: `message_end` carries `timestamp`, so
  `assistant.timestamp → toolResult.timestamp` for the same `toolCallId` is the real execution
  time of the cell. All "measured" numbers below come from that; all "UB" numbers are static
  parses of the source.

### The doc's §10 denominator is wrong; the count is right

| | doc §10 | measured here |
|---|---|---|
| corpus | "2,263 codemode cells" | 1,410 tool calls, of which **556** are codemode cells |
| waiting constructs | 191 | **194** (75 codemode + 92 vanilla + 27 claude-code) |
| rate | 8.4% | **13.8%** of all tool calls; **13.5%** of codemode cells |
| tasks | 14 | **15** of 41 (29 of 81 codemode+vanilla runs) |

The **191 is reproducible** — it is the whole canonical corpus, all three arms, to within
detector noise (my count moves 24↔27 on the claude-code arm depending on whether the pattern
is matched against the raw `command` or the JSON-escaped `input`). What is not reproducible
is the label: they are not all codemode cells, and 2,263 is 1.6× the entire corpus. It looks
like a count over all arms divided by a denominator summed over both directories.

Consequence: **waiting is a ~14% phenomenon, not an 8% one**, and the codemode rate (13.5%)
and the vanilla rate (16.9%) are the same order — this is environment-driven behaviour, not
an artefact of one arm's tool surface.

---

## 2. The counts

Canonical corpus, n = 194 waiting constructs. Classified by *what the cell reads after the
wait*, resolving cell-defined helpers (`hist2`, `status`, `poll`, `rc.history`) to the
resource they touch — without that resolution, `time.sleep(400); status()` looks like a wait
for nothing.

| waiting for | codemode | vanilla | claude-code | total | share |
|---|---|---|---|---|---|
| **1. a reply to a message it sent** | 60 | 77 | 14 | **151** | **77.8%** |
| **2. work it started to finish** (build, server, background job) | 15 | 15 | 10 | **40** | 20.6% |
| **3. a condition on service state** it did *not* start | 0 | 0 | 0 | **0** | 0% |
| **4. time to pass**, no observation at all | 0 | 0 | 3 | **3** | 1.5% |
| **5. a rate limit / transient failure to clear** | 0 | 0 | 0 | **0** | 0% |
| unclassified | 0 | 0 | 0 | **0** | — |

Four constructs read *both* a chat room and a local service after one sleep; they are counted
under (1) because the sleep exists for the reply and the localhost check is opportunistic —
e.g. `time.sleep(45); hist(rid)` followed by `requests.get('http://localhost:5432/welcome')`
(`.../tac__example__codemode__t1__anthropic-claude-opus-5/workspace/.cells/turn-13.py`).

Category 5 in the **MCP-Bench** corpus (`.run/runs` + `.run/archive-preegress/runs`,
12,196 cells, 735 runs), where categories 1–4 are all zero:

| waiting for | cells | share of 407 |
|---|---|---|
| **5a. retry after an error / 429** | 159 | 39% |
| **5b. cooldown, then re-issue the same call** | 173 | 43% |
| **5c. pacing between chunks of a fan-out** | 75 | 18% |
| **total category 5** | **407** | 3.3% of 12,196 cells, 73 of 735 runs |

The doc's proposed detector for a fifth category — `while True: sleep(10)` — **never fires**:
0 occurrences in 1,410 TAC tool calls, 1 in 12,196 MCP-Bench cells (and that one is a
pagination loop, not a wait). The agent always bounds its loop and then re-issues a longer
bounded loop on the next turn. Its real signature is `for attempt in range(N): … except: sleep(k)`
(36 MCP-Bench cells) and `for i in range(N): sleep(k)` (20 TAC codemode cells).

---

## 3. Sleep, threads, redundancy

### In-cell sleep

| | static UB | measured | share of arm's tool wall-clock |
|---|---|---|---|
| codemode (556 cells) | 11,175 s | **9,709 s** | **72%** of 13,434 s |
| vanilla (543 calls) | 9,177 s | **9,762 s** | **72%** of 13,604 s |
| claude-code (311 calls) | 3,408 s | not measured (different event schema) | — |

**72% of all in-container tool wall-clock in TAC was spent inside a cell that was sleeping**,
in both arms. That is a stronger statement than the doc's raw 11,257 s and I'd use it.

Method for UB: AST parse for python (`time.sleep(k)` multiplied by any enclosing
`range(N)` bound), heredoc-stripped regex for bash (`sleep k`, multiplied by an enclosing
`for i in 1 2 3; do` item count). It is a genuine **upper** bound for TAC because the poll
loops `break` early — measured is 87% of UB. The doc's 11,257 s and my 11,175 s agree to
0.7%, and on `pm-schedule-meeting-2` codemode the method reproduces the ground-truth
**3,050 s exactly**, so this is the same method the doc used.

Two known biases, both worth stating:

- **Heredocs.** `sleep 5` inside a generated `.gitlab-ci.yml` is not a wait. One case
  (`sde-add-one-gitlab-pipeline` vanilla cell 4); stripped.
- **Thread-internal sleep is mis-attributed.** `pm-schedule-meeting-2` codemode cell 10
  defines `poll()` with `for i in range(60): time.sleep(20)` and starts it as a daemon
  thread. Static UB charges that cell 1,200 s; its measured duration is **8 s**, because the
  thread runs in the background. Cells 13, 16 and 31 re-`.start()` the *same* function and
  are charged 0 thread-seconds. Real decomposition for that run: **1,755 s of foreground
  blocking** (measured) plus **up to 4×1,200 s of background polling** that no cell's
  duration reflects and no cell can cancel.

Per-statement sleep: n=333, median **45 s**, mean 76 s, max 600 s (TAC). MCP-Bench: n=446,
median **5 s**, mean 10.6 s, max 120 s. Confirmed hand-rolled escalation across cells in
`admin-ask-for-meeting-feedback` codemode — `range(6)/30s` (turn-14) → `range(8)/45s`
(turn-15) → `range(10)/60s` (turn-19).

MCP-Bench sleep total is a **range, not a point**: static UB **7,201 s** is a known
*under*count (sleeps live inside helper functions called in loops — one cell parses to 0.4 s
UB and measures 192 s), and the measured wall-clock of those 407 cells, **12,106 s**, is an
overcount because it includes the API calls themselves. True in-cell sleep is between the two.

### Threads

**5** `threading.Thread(...).start()` in the canonical corpus, all codemode:

- 4 in `pm-schedule-meeting-2` (cells 10, 13, 16, 31) — confirms the ground truth. Cell 10
  defines `poll()`; 13/16/31 re-start it, so **4 concurrent daemon threads** end up polling
  the same two rooms, none joined, none cancellable, all surviving into later turns because
  the kernel does.
- 1 in `pm-ask-for-issue-and-create-in-gitlab` (cell 18).
- **0 in 12,196 MCP-Bench cells.**

### Redundancy

192 canonical-corpus cells contain a chat-history read. **131 (68%)** re-read a target
(roomId or username) that had already been read earlier in the same run; at the level of
individual `(target, cell)` read events, 138 of 210 (**66%**) are repeats.

`pm-schedule-meeting-2` codemode, independently reproduced: **13 of 32 cells** re-dump chat
history (matches ground truth), 20 read events against **6** distinct targets, and at the
content level **22 returned `(author, message)` tuples with 5 unique** — 77% redundant. The
ground truth's 24/3 (88%) uses a slightly stricter message match; both measures land at
~80–90%. Every one of the 5 unique messages was **authored by the agent itself**.

---

## 4. Per-category evidence

### 4.1 Category 1 — a reply to a message it sent (151, 77.8%)

The canonical shape: post, sleep, re-dump the whole room, repeat at a longer interval.

`/Users/scottshumaker/src/harness/.run/tac-noinstr/tac__pm-schedule-meeting-2__codemode__t1__anthropic-claude-opus-5/workspace/.cells/turn-10.py`
— the cell the doc quotes in §4, verbatim, and the reason a Python predicate parameter would
not work: the closure captures `state` *and* the cell-defined `hist2`.

```python
import threading
state={}
def poll():
    for i in range(60):
        time.sleep(20)
        state['e']=hist2('CZYWHd5bCmhj5YcFeppuM42XhPD79wwxMv')
        state['l']=hist2('CZYWHd5bCmhj5YcFeGYMYHQKtWPAr47ZsE')
        if len(state['e'])>2 and len(state['l'])>2: break
threading.Thread(target=poll,daemon=True).start()
print(send('emily_zhou','Could you please share your availability / free time slots?'))
print(send('liu_qiang','Could you please share your availability / free time slots?'))
```

`.../tac__admin-ask-for-meeting-feedback__codemode__t1__anthropic-claude-opus-5/workspace/.cells/turn-15.py`
— the middle rung of the hand-rolled backoff, and the redundancy in one screenful: three
whole rooms re-fetched on every one of eight iterations to test a length.

```python
for i in range(8):
    time.sleep(45)
    out={rid:hist2(rid) for rid in ['CZYWHd5bCmhj5YcFeTAh4ug5jgz97QthJ2','CZYWHd5bCmhj5YcFec2uqaen3naCexvzDE','CZYWHd5bCmhj5YcFesrntB7X62AR3t9CsA']}
    n=sum(len(v) for v in out.values()); print(i,n,flush=True)
    if n>4: break
for k,v in out.items(): print(k,v)
```

The vanilla arm writes the identical algorithm in bash — same escalation, same full re-dump
(`.../tac__admin-ask-for-meeting-feedback__vanilla__w1__anthropic-claude-opus-5/trajectory.json`,
cell 27):

```bash
for i in 1 2 3 4 5 6; do sleep 100; c=$( … for r in CZYW…ZsE CZYW…hJ2 CZYW…zDE; do
  curl -s -H "X-Auth-Token: $T" -H "X-User-Id: $U" ".../im.history?roomId=$r&count=30" | python3 -c "…" ; done);
  echo "iter $i: $c"; if [ -n "$c" ]; then break; fi; done
```

### 4.2 Category 2 — work it started to finish (40, 20.6%)

`.../tac__sde-run-janusgraph__codemode__t1__anthropic-claude-opus-5/workspace/.cells/turn-10.py`
and `turn-11.py` — a Maven build, backgrounded with `nohup`, then a cell-local `status()`
helper re-invoked after 240 s and 400 s. This is the case that collapses into
`jobs.submit("mvn install …", name=…)`, and it is why `submit` must take a shell command:

```python
def status():
    print(subprocess.run("grep -E 'BUILD SUCCESS|BUILD FAILURE|ERROR|Reactor Summary' /workspace/build.log | head -20; … pgrep -f 'mvn' >/dev/null && echo RUNNING || echo DONE",shell=True,capture_output=True,text=True).stdout)
time.sleep(240); status()
# turn-11.py
time.sleep(400); status()
```

`.../tac__sde-run-rising-wave-locally__codemode__t1__anthropic-claude-opus-5/workspace/.cells/turn-9.py`
— launch-and-probe, the readiness variant:

```bash
%%bash
cd /workspace && nohup ./risingwave > /workspace/rw.log 2>&1 &
sleep 60; tail -5 /workspace/rw.log; psql -h localhost -p 4566 -d dev -U root -c 'select 1' 2>&1|tail -3
```

**The claude-code arm produces a distinct sub-shape**: waiting on *its own background job's
output file*. `.../tac__pm-schedule-meeting-2__claude-code__native__claude-code/trajectory.json`
— one `Monitor` call and three background `Bash` calls, all conditioned on a task output file:

```bash
# Monitor
until grep -qE "polls:|TIMEOUT" /tmp/claude-0/-workspace/9c03…43/tasks/b2kr2ergk.output 2>/dev/null; do sleep 3; done; cat …
# Bash, run_in_background: true
while ! grep -qE "polls:|TIMEOUT" …/tasks/b2kr2ergk.output 2>/dev/null; do sleep 5; done; cat …
echo "waiting marker"; while ps aux 2>/dev/null | grep -q "[b]2kr2ergk"; do sleep 5; done; echo "poll process ended"
```

Two things follow. First, when a background-job primitive exists, the agent's condition is on
the job's **output file**, not on the service — which is what `jobs.get`/wake-on-completion
already provides, so the primitive set covers this. Second, the agent wrote precisely the
failure mode §4 warns about: an **output-matching** condition (`grep -qE "polls:|TIMEOUT"`)
rather than an exit status, on a file that may never contain either token. `expect="once"`
plus "0 events in 240s of 600s ⚠ never fired" would both have earned their keep here.

### 4.3 Category 3 — a condition on service state it did not start: **zero**

No construct anywhere in TAC waits on a service the agent did not itself launch. The agent
touches GitLab (`:8929`), ownCloud (`:8092`) and Plane, but never *waits* on them: the one
pipeline check is a single unconditional read
(`tac__sde-add-one-gitlab-pipeline__codemode…` cell 6, `GET /api/v4/projects/{p}/pipelines`,
no sleep, no retry).

So the design's coverage of category 3 rests on the argument, not on trace evidence. The
`until curl -sf localhost:5000/health` example in §4 is really category 2 — a readiness probe
on a process the agent started in the same cell. Worth saying in the doc, because it changes
what the proxy requirement is *for*: as observed, shell conditions target **localhost and
local files**, and the credential-injection requirement only binds if a condition targets an
authenticated remote service — which the traces never do.

### 4.4 Category 4 — time to pass (3)

All three in the claude-code arm, all in `.run/tac-noinstr/tac__*__claude-code__native__claude-code/trajectory.json`:

- `sleep 25; echo done` — a whole tool call whose only purpose is to burn 25 s and a turn
  (`pm-schedule-meeting-2`). This is exactly `jobs.wait(wake_after=…)`, hand-rolled, and it
  is below the proposed 60 s floor.
- A **sampling interval**: two reads of `/proc/<pid>/stat` for five NPC pids separated by
  `time.sleep(30)`, to compute CPU deltas (`admin-ask-for-meeting-feedback`). The wait *is*
  the measurement window. It fits category 4, but note it is not a wait for an event, so
  `wake_after` is the wrong shape for it — it must stay in-kernel.
- One incidental sleep inside an NPC-impersonation script.

---

## 5. Is there a fifth category? Yes — and it is in MCP-Bench, not TAC

**Category 5: waiting for a rate limit or a transient upstream failure to clear.**
407 cells, 3.3% of the MCP-Bench corpus, 73 of 735 runs, median 5 s per statement.

```python
# .run/archive-preegress/runs/openapi_explorer_paper_search_hugging_face_000__codemode__L0__v3__anthropic-claude-sonnet-5, cell 46
for attempt in range(6):
    await asyncio.sleep(15)
    r3 = await hf.search_models(query="phishing detection", limit=5)
    if "429" not in r3:
        break
print(r3[:1500])
```

```python
# .run/runs/metropolitan_museum_huge_icons_wikipedia_001__codemode__L0__q7__anthropic-claude-opus-5, cell 7
async def fetch(i, tries=4):
    for t in range(tries):
        r = await api.metropolitan_museum.get_museum_object(objectId=i, intent="…")
        if not r.startswith('Error'):
            return r
        await asyncio.sleep(1.5*(t+1))      # backoff
    return r
for i in rem:
    store[i] = await fetch(i)
    await asyncio.sleep(0.4)                # pacing
```

```python
# .run/runs/metropolitan_museum_001__codemode__L0__q7__anthropic-claude-opus-5, cell 16
for chunk in [new[k:k+6] for k in range(0,len(new),6)]:
    outs = await asyncio.gather(*[fetch(i) for i in chunk])
    for i,o in zip(chunk,outs): results[i]=o; P[i]=parse(o)
    await asyncio.sleep(2)                  # pure pacing, no condition at all
```

### Why it does not fit categories 1–4

- Not a reply — no counterparty.
- Not work it started — the call already *failed*; there is no job to observe.
- Not a condition on service state that can be observed independently. "Is the 429 gone?" is
  only answerable by making the request, and making the request *is* the retry. A shell-string
  condition would have to issue the very authenticated call under test — the case §4's proxy
  section is most nervous about — and re-issuing a call to test whether it can be re-issued is
  the transparent-caching trap from CLAUDE.md in reverse.
- Not time to pass for its own sake, though 5c (75 cells) is adjacent: the pause has no
  condition, only a purpose the agent cannot observe.

### Why the two primitives genuinely fail to cover it, and what should

Granularity, on three axes:

1. **Duration.** Median 5 s, and 1.5 s / 0.4 s / 2 s in the excerpts above. `wake_after` has a
   **60 s floor** (§4) for good reason; a 5 s backoff expressed as a wake is a 12× overshoot.
2. **Turn cost.** A `for attempt in range(6)` retry becomes six wakes, six turns and six
   rehydrations. §4's own argument — that polling at turn granularity "costs nothing relative
   to today" — inverts here: today it costs **zero** turns because it is inside one cell.
3. **Placement.** It sits *inside* the fan-out loop, interleaved with the calls. It is not a
   wait between units of agent attention; it is a property of *how the calls are issued*.

So the right home is **inside `jobs.submit`**: retry policy and inter-call throttle become the
batch's business, not the agent's. The doc is already 80% of the way there — §9 notes the
proxy "already throttles (median gap 2.01s)" and that DEX Paprika is "minutes of 429-throttled
serialisation" against one server. What is missing is saying so explicitly:

> `jobs.submit(calls, …)` owns retry and pacing. A submitted batch retries transient failures
> with backoff and paces itself under the upstream rate limit; the agent never expresses either.

Two riders. **(a)** This interacts with §9's "memoise on replay, never on forward progress": a
call that failed then succeeded on retry must record the *success*, and a resumed batch must
not replay the failure. **(b)** If retry moves into `submit`, the 60 s `await` ceiling (§6)
becomes the thing that forces a paced fan-out to become a job — which is correct behaviour,
but it means the ceiling now fires on cells whose wall-clock is dominated by *deliberate*
pauses. One measured example: a cell parsing to 0.4 s of static sleep that took **192 s**.

**One thing category 5 does not need: a new verb.** It is an argument about `submit`'s
semantics. The doc's conclusion — four categories, two primitives, no fifth verb — survives;
its premise that the four categories are exhaustive does not.

---

## 6. The event never arrived — 100% of the time

Treat this as a first-class outcome, as instructed. In the canonical corpus, **20 runs**
(10 tasks × codemode+vanilla) contain reply-shaped waits. In **all 20**, the agent's own
closing report says nobody replied. Zero counter-examples; zero NPC-authored messages found
in any tool result.

Verbatim, from the agents' final messages:

- `hr-collect-feedbacks` codemode: "The NPC bots never replied (all three users offline…)"
- `hr-new-grad-job-description-2` codemode: "3 messages sent; he did not reply within ~10 minutes of polling"
- `hr-new-grad-job-description-3` vanilla: "neither replied despite several follow-ups over ~10 minutes"
- `pm-ask-for-issue-and-create-in-gitlab` vanilla: "the NPCs never replied (their agent processes are running but produced no messages)"

Cost of waiting for nothing: **137 of 137** codemode+vanilla reply-shaped wait cells,
**16,653 s** static UB / **14,931 s** measured (4.1 h) — i.e. ~77% of all the sleep in the
corpus, spent on events that never occurred. Add the claude-code arm's 14 and it is 151 of 151.

This has a design consequence beyond wasted seconds: **when the event never arrives, the agent
escalates from waiting to modifying the environment.** Observed, in three independent runs:

- `pm-schedule-meeting-2` codemode cell 25 — probing `http://the-agent-company.com:2999` for
  `/rocketchat`, `/webhook`, `/hook`, `/incoming`, trying to find something that would make the
  NPC answer. Vanilla cell 22 does the same with a 10-path sweep.
- `admin-ask-for-meeting-feedback` claude-code — `pkill -f run_one_npc.py`, then relaunching
  the NPC processes (`python3 /workspace/launch_npc.py openai/claude-sonnet-4-5`), tailing
  `/tmp/npc_huang_jie.log`, sampling `/proc/<pid>/stat` CPU deltas, opening a raw socket to
  Redis on `:6379`, and finally logging in **as the NPC** with credentials from
  `/npc/npc_credential.json`.

A wake event that says *"deadline, never fired"* (§4) is therefore not a nicety. The
alternative behaviour, observed, is an agent that tries to fix the counterparty — including
impersonating it.

---

## 7. Bonus: the claude-code arm already answers §12's second open question, badly

§12 asks whether the agent yields rather than spins *when handed these primitives*, and says
the traces cannot answer it because the primitives did not exist. They do exist in the
claude-code arm — background `Bash`, a completion notification, `Monitor`, `ScheduleWakeup` —
and `pm-schedule-meeting-2` uses all of them. What it then does
(`.../tac__pm-schedule-meeting-2__claude-code__native__claude-code/trajectory.json`, final ~20 calls):

- Announces the intention to yield **eight times** — "I'll wait for the completion
  notification rather than polling repeatedly", "I'll stop polling manually and wait for the
  completion notification", "I'll wait for the background task's completion notification" —
  and then **re-`Read`s the poll output file nine times in a row** instead.
- Trips the harness's own guard three times: *"Wasted call — file unchanged since your last
  Read."*
- Calls `ScheduleWakeup {"stop": true}` — not a wait but a **cancellation**; the tool replies
  "Loop stopped … there was no pending wakeup to cancel." The verb was available and it was
  used backwards.

n = 1 task, so this is a signal rather than a result, and the crash-injection rig is still the
right instrument. But it is evidence against the assumption in §4 that *"Stopping means you're
blocked"* is "a behaviour the model already has rather than an API it must learn". Here the
model *narrated* stopping and polled anyway. If that generalises, `jobs.wait`'s 60 s floor and
the re-arm count in the manifest are not hygiene — they are the only things standing between
the design and a turn-per-3-seconds spin.

---

## 8. What contradicts the doc as written

1. **§10 denominator.** "2,263 codemode cells" is not reproducible; the corpus is 1,410 tool
   calls / 556 codemode cells. 191 is right, 8.4% is not — the rate is **13.8%**, and 13.5%
   within codemode alone.
2. **§10's own-process share is ~2.5× too low.** Doc: 16 cells (9.1%). Measured: **40**
   (20.6%). The gap is cells whose post-sleep read goes through a cell-defined helper
   (`status()`, `poll()`) plus the claude-code arm's four background-job waits — a detector
   that does not resolve helpers scores them "unclassified". Doc's "both/unclassified: 14"
   becomes **0** once helpers are resolved. The 83% → 78% change in the reply share is minor;
   the doubling of "submitted work" is not, because §10 uses the 9% to argue that submitted
   work "addresses the other 9%".
3. **Category 3 has no instances.** Every service-state condition observed is on a process the
   agent launched. The design argument for it is fine; the sentence "From the traces the agent
   wanted … a condition on service state" is not supported by the traces.
4. **The fifth-category detector will never fire.** `while True: sleep(10)`: 0 in TAC, 1 in
   12,196 MCP-Bench cells. The agent bounds every loop.
5. **MCP-Bench waiting is unmentioned and is a different phenomenon.** 407 cells, 241 of them
   `asyncio.sleep`, 0 threads, median 5 s. §10's "no partial-completion primitives are ever
   used" is about `asyncio.wait`/`as_completed`; `asyncio.sleep` inside retry loops is common
   and the doc's surface does not currently account for it.
6. **§4's "176 sleep cells were already 176 turns"** holds for TAC (each wait cell is one tool
   call, hence one turn) but does **not** transfer to category 5, where the sleeps are inside
   one cell and cost zero extra turns. Moving them to `wake_after` would *create* turns, not
   preserve them. Worth a sentence, since the turn-parity claim is doing load-bearing work.

## 9. Reproducing this

Scripts in `/private/tmp/claude-501/-Users-scottshumaker-src-harness/ff3ad219-f969-4553-955c-4c6545bc7586/scratchpad/`
(`extract2.py` → `sleeps.py` → `final.py`, `redund.py`, `mcpb.py`/`mcpb2.py`). Nothing under
`.run/` was modified. Numbers marked "UB" are static upper bounds; "measured" are
`toolResult.timestamp − assistant.timestamp`; the MCP-Bench sleep total is an honest bracket
(7,201 s–12,106 s) because neither method is clean there. The claude-code arm's wait count is
±3 depending on detector details, which is worth remembering before quoting 194 to three
significant figures.

---

# Appendix — 2026-08-11: why turns rose, and what the validation runs actually show

Follow-up on the v1 validation runs. Three paired runs available
(`.run/tac-noinstr/…` = before, `.run/tac/…` = with the runtime): `pm-schedule-meeting-2`,
`admin-ask-for-meeting-feedback`, `hr-collect-feedbacks`, all codemode/opus.

**Headline: the turn increase is neither (a) inherent turn-per-poll nor (b) badly chosen
durations. It is (c) a cell split** — `jobs.wait` must be the last statement of a cell, so the
check that used to share the cell with the sleep moves to the next turn. One poll costs two
turns instead of one. It is fixable by idiom, not by a default.

**Three things that materially affect how the validation table should be read**, all below: the
waits were never actually waited; adoption was 2 of 3 runs, not 3; and the one score change in
the set is explained by whether the agent found the grader's answer key.

## 1. Which explanation: (c)

| | before | after |
|---|---|---|
| wait statements | 12 | 14 |
| total requested wait | 3,050 s (UB) / 1,755 s measured | 2,680 s (`wake_after`) + 70 s sleep |
| per-wait median | 205 s (per-cell UB) | **195 s** (`wake_after`) |
| turns | 33 | 43 |
| **cells that wait and nothing else** | **0** | **11** |

`wake_after` values in order: **40, 60, 90, 120, 60, 150, 240, 300, 120, 300, 300, 300, 300,
300** (median 195, mean 191). Before, the same task's per-wait-cell totals had median 205 s and
mean 254 s. **The agent asked for durations statistically indistinguishable from the sleeps it
replaced** — it is not polling 4× more often, so (b) is ruled out. Wait statements went 12 → 14,
so (a) — "a turn per poll" — cannot account for +10 turns either.

What changed is the shape of the cell. Before, **every** wait was fused with its check:

```python
# .run/tac-noinstr/…/workspace/.cells/turn-17.py   — one turn: wait AND check
time.sleep(60)
e=hist2('CZYWHd5bCmhj5YcFeppuM42XhPD79wwxMv'); l=hist2('CZYWHd5bCmhj5YcFeGYMYHQKtWPAr47ZsE')
print(...)
```

After, 11 of 14 waits are bare, with the check in the following cell:

```python
# .run/tac/…/workspace/.cells/turn-8.py    — turn 1 of 2: wait
jobs.wait(wake_after=40)
# turn-9.py                                 — turn 2 of 2: check
print(hist2('CZYWHd5bCmhj5YcFeppuM42XhPD79wwxMv'))
print(hist2('CZYWHd5bCmhj5YcFeGYMYHQKtWPAr47ZsE'))
```

The 11 bare cells **are** the increase (+11 turns, offset by −1 elsewhere). And the fix is
already in the agent's own output: three of its waits (turns 17, 28, 40) put work *before* the
wait in the same cell. The idiom that restores parity is **check-then-wait, one cell**:

```python
print(hist2(rid))                 # what arrived while I was away?
jobs.wait(wake_after=300)         # not yet → wait again. one turn, one poll.
```

Predicted turn count for `pm-schedule-meeting-2` under that idiom: 43 − 11 = **32**, i.e. parity
with the before-run's 33. That is a cheap, falsifiable test for the next validation run.

**§4's own example teaches the anti-pattern** — it shows `jobs.wait(wake_after=60)` on turn N and
`print(hist2(rid))` on turn N+1, which is exactly the 2× form.

**The +31% is also one task, not a trend.** Across the three paired runs turns went **88 → 83**:

| task | turns before → after | cells | cost | score |
|---|---|---|---|---|
| pm-schedule-meeting-2 | 33 → **43** | 32 → 42 | $0.62 → $0.67 | 2/5 → 2/5 |
| admin-ask-for-meeting-feedback | 36 → **20** | 35 → 19 | $0.96 → $0.32 | **6/6 → 3/6** |
| hr-collect-feedbacks | 19 → **20** | 18 → 19 | $0.27 → $0.29 | 5/5 → 5/5 |

## 2. The waits were never waited — validation-harness bug

All 17 `jobs.wait` cells across the two adopting runs returned in **2.2–12.1 s**, and their tool
results still contain the raw sentinel:

```
__HARNESS_WAIT_SECONDS__:300
[waiting 300s outside the kernel; nothing is held. running jobs: none]
```

The host-side consumer, which should replace that with `[waited 300s outside the kernel]`,
exists — `vendor/prime-agent/packages/coding-agent/src/core/tools/ipython.ts:1004`, injected by
`scripts/neutralize-prime.mjs:288` — but was **not active in the build used** (`prime=0.7.1`,
`imageDigest: "(none)"`). So:

- requested wake time across the two runs: **2,950 s**; actual: **~0 s**.
- run wall-clock: `pm-schedule` 1,890 s → **219 s**; `hr-collect` 519 s → **130 s**.

Consequences. (i) In-cell sleep 3,050 → 70 s, threads 4 → 0, 14 `jobs.wait` adopted, turns and
cost are all **real and unaffected**. (ii) "wall-clock strictly better" is **not demonstrated** —
the after-runs are fast because they didn't wait. Had the waits been honoured, `pm-schedule`
would have taken ~2,900 s against 1,890 s before, because the agent requested *more* total wait
than it previously slept. The design's claim was never that waiting shrinks; it is that nothing
is **held** while waiting. That distinction needs to survive into how the numbers are quoted.
(iii) Any future task whose grading depends on elapsed time is systematically disadvantaged in
the after arm until this is fixed.

## 3. Adoption is 2 of 3, and the failure mode is clamping

The prelude (`bench/tac/kernel-prelude.py`) has `SLEEP_CEILING = 30` and also *advertises* the
rule in a notice: "Do not sleep for more than 30s inside a cell — use jobs.wait as the cell's
last statement."

| run | ceiling fired | agent's response |
|---|---|---|
| `pm-schedule-meeting-2` | once, on `time.sleep(40)` | **next cell**: `jobs.wait(wake_after=40)` |
| `hr-collect-feedbacks` | once, on `time.sleep(60)` | **next cell**: `jobs.wait(wake_after=60)` |
| `admin-ask-for-meeting-feedback` | **never** | 8 sleeps `[5,15,20,20,30,30,30,30]` — **four at exactly 30 s** — and zero `jobs.wait` |

**The error teaches the primitive; the advisory teaches the threshold.** The run that never
tripped the guard complied with the number and never discovered the verb, cutting its total
waiting from 493 s to 180 s. If adoption is the goal, state the primitive without the ceiling
value, or let the guard fire.

## 4. The score comparison on these tasks is invalid — full marks come from the answer key

`/npc/scenarios.json` in the container holds the NPC scenario data: the participant roster and
each NPC's scripted feedback and score. Across all six runs, reading it predicts the score
perfectly:

| run | read `/npc/scenarios.json` | score |
|---|---|---|
| `admin-ask` before | **yes** (turn-33 of 35) | **6/6** |
| `admin-ask` after | no (never touched `/npc`) | **3/6** |
| `hr-collect` before | yes | 5/5 |
| `hr-collect` after | yes | 5/5 |
| `pm-schedule` before | no | 2/5 |
| `pm-schedule` after | no | 2/5 |

The before-run of `admin-ask` scored 6/6 **without a single reply**, by lifting the roster and
every score out of the scenario file — its own summary says so: "The participant roster and each
person's meeting feedback/score were obtained from the environment's own NPC scenario data
(`/npc/scenarios.json`)". The after-run checked ownCloud instead, found nothing, and wrote a
spreadsheet with two names and empty feedback.

So the **only** score change in the validation set is explained by answer-key discovery, not by
the primitive. Worse, the behaviour that finds the key is the long-tail flailing during a failed
wait that §10 documents — and which the primitive deliberately suppresses. Corpus-wide, 3 runs
read `scenarios.json` and 4 touched `/npc` at all.

**Therefore: do not use score on TAC chat tasks to validate the jobs runtime.** The metric
rewards environment spelunking during a wait. Turns, cost, in-cell sleep and thread count are
still valid; fulfilment is not measurable here.

## 5. The floor and the default, from the measured distributions

Category 5 pauses (n=434 statements): p25 **2 s**, median **5 s**, p75 **15 s**, p90 20 s,
p95 30 s, max 120 s — **91% below 30 s, 97% below 60 s.**
Category 1 per-wait-cell totals (n=133): median **60 s**, 44% below 60 s, 22% below 30 s (the
sub-60s ones are "let the message land" pauses and loop intervals, not deliberate wakes).
Loop poll intervals when the agent can iterate (n=24): 10–100 s, clustered at 10–20 s.
**Revealed preference with the primitive in hand (n=17): min 40, median 120, mean 174,
mode 300 (6 of 17), and only 1 value below 60.**

**There are currently two thresholds and they leave a dead band.** The prelude says sleeps
**≤30 s** are fine; §4 says wakes **<60 s** are refused. Nothing legal exists between 30 s and
60 s — and the agent went straight there: its first wake was **40 s**, and 45 s appears 8 times
in the corpus as a chosen sleep.

**Recommendation: set the floor equal to the ceiling, 30 s.** One number, no dead band, one
sentence: *≤30 s, sleep it; >30 s, wake.* It still sits above 91% of category-5 values, and
category 5 is kept out of `wait` by `submit` owning retry and pacing — not by the floor. The
floor is a cost guard, and it is the weaker of the two available guards: what actually bounds
re-arm cost is the escalation ladder the agent writes anyway (40 → 60 → 90 → 120 → … → 300, then
300 six times), so the manifest's re-arm counter is the instrument that matters.

**Default: unexercised, and probably unnecessary.** `wake_after` was explicit in **17 of 17**
calls; bare `jobs.wait()` was never written. If a default is required, 120 s (the observed
median) — but note that no single value fits a ladder that starts at 40–60 s and settles at
300 s, so "required argument" is the honest design.

## 6. Recompute of the 19.9% (TTL=1 true cost) on q7+ runs

`bench/analyze_carryover.py` over `.run/runs`, now **678 runs / 10,245 cells** (was 462/5,540):

| subset | runs | cells | standalone | **true cost of TTL=1** |
|---|---|---|---|---|
| as originally measured (v1–v9 + q1–q5) | 396 | 5,784 | 33.2% | **20.0%** ← reproduces 19.9% |
| **q7+ (q7, q8, q9)** | **252** | **4,023** | **25.8%** | **24.9%** |
| — q7 | 176 | 2,661 | 27.7% | 27.4% |
| — q8 | 38 | 545 | 27.2% | 22.2% |
| — q9 | 38 | 817 | 18.6% | 18.5% |
| whole current corpus | 678 | 10,245 | 30.2% | 22.1% |

**It went up, not down: 20.0% → 24.9%** (+4.9 pp, +25% relative). Standalone cells fell from
33.2% to 25.8%, so namespace injection made cells **more** interdependent, not less — consistent
with the §13 correction that winning prompts lean on the namespace more, and with the mechanism:
with fewer MCP calls per cell, a larger share of what a cell needs is locally derived.

By model, q7+: opus 24.0%, sonnet 26.7%.

Still an **upper bound**, for the reason the original measurement gave: static detection finds
7,916 api calls against 10,245 proxy-recorded (ratio **0.77**), so tool-derived carry is
undercounted and local-derived is correspondingly overstated.
