# CC-wins triage — the 5 AppWorld tasks where claude-code passed and codemode failed

Trace-first, paired-arm, classified, per `.claude/skills/diagnose-run-fail/SKILL.md`.
Every claim below cites a cell or tool call that was read, not a grep over
`evaluation.json`.

Tasks: `2e9b91e_2`, `4242c97_1`, `277d81d_3`, `a53a8fd_1`, `9871968_1`.
Arms: codemode `L0__a1` (code, docs non-resident), vanilla `L4__b1` (tool-calling,
docs resident), claude-code `L4__c1` (tool-calling over MCP, docs resident).

**vanilla is the control.** cc and vanilla are both L4 tool-calling; codemode is L0
code. A cc win that vanilla *also* wins implicates residency or representation. A cc
win that vanilla *loses* cannot be either — it is cc's scaffold, or luck.

---

## A0 — integrity, before any of it counts

| check | result |
|---|---|
| `basePromptDigest` across all three arms | **identical** (`62dec1f8f49a3148`) — no prompt confound |
| thinking blocks per task | codemode 1–3, vanilla 1–6, cc 2–6 — **parity**, no reasoning-budget asymmetry |
| cc non-MCP tools used across the 5 | `Read` ×2 only; no TodoWrite, no Bash, no agent spawning |
| `bypassSuspected` | empty in all 15 runs |
| `apiCallsFailed` | 0 except cc `4242c97_1` (1) and cc `9871968_1` (2), both benign retries |

Two caveats that must be stated:

1. **The cc run dirs were being overwritten while this triage ran.** A cc re-run
   (task #31 ramp) rewrote `2e9b91e_2`, `277d81d_3` and `a53a8fd_1` at 08:49–08:56.
   The original traces for `2e9b91e_2` are gone. Everything quoted here is snapshotted
   under `scratchpad/snap/`. Where the original trace was lost, this is flagged inline.
   **The re-runs reproduced the passes** (`2e9b91e_2` 5/5, `277d81d_3` 6/6,
   `9871968_1` 7/7) — the wins are not single-sample noise.
2. **vanilla `277d81d_3` stopped on `budget`** ($3.069 of a $3 cap). It is still a
   valid data point: it reached `supervisor__complete_task` at call 97 and its own
   verification pass before the cap bit. The failure is semantic, not truncation.

---

## Task 1 — `2e9b91e_2` (codemode 4/5, vanilla PASS, cc PASS)

> *Everything in my amazon cart is for my roommate, Troy. Request them money for it
> on venmo. Ignore tax and delivery fees from the cart cost.*

### 1. What codemode did wrong

Nothing, except the last line. All four world-state checks passed — the payment
request exists, the recipient is right, the amount is right. The single failure:

```
assert answers match.
AssertionError:  '649.6' == 'null'
```

The decisive cell is the last one:

```python
print(await api.supervisor.complete_task(answer=649.6))
```

### 2. What the other arms did at the same decision point

vanilla, having produced the *same* payment request (`payment_request_id: 6097`):

```json
CALL 9 [supervisor__complete_task] {"status": "success"}
```

cc likewise committed `answer: "null"` (from its `result.json`; original trace lost
to the re-run, but the re-run reproduced 5/5 and `committedAnswer: {"answer": "null"}`).

### 3. Classification — **(a) L0 residency artifact**

This is not a style difference. The rule lives in the `answer` parameter's own
description, and the two arms see it differently:

**vanilla, resident in `tools.json`:**

```json
"answer": {"description": "The answer to the task instruction. Pass it if and only if
the task requests an answer... If the task is not a question, e.g., 'Start my Spotify
music player.', the answer must be left to the default value, i.e., None."}
```

**codemode, on disk at `api/supervisor/complete_task.py`, never opened.** All codemode
saw was the one-line `INDEX.md` entry it `cat`ed in cell 1:

```
- `api.supervisor.complete_task(answer?, status?)` — Mark the currently active task as complete with the given answer.
```

Verified: `grep -c complete_task.py stream.jsonl` = **0** in all six runs exhibiting
this failure (below). The "if and only if" sentence was available and unread.

The shared base prompt does carry a weaker form — *"If it only asks for something to
be done, omit the answer argument"* — which vanilla follows and codemode does not.
The difference between the two arms is that vanilla has the strong form in front of it
for free.

### 4. Does vanilla discriminate? **Yes — residency implicated.**
vanilla (L4) passed. Same representation as codemode's failure mode? No: vanilla is
tool-calling, cc is tool-calling, both pass. The one arm without the schema resident
is the one that fails.

---

## Task 2 — `4242c97_1` (codemode 7/8, vanilla PASS, cc PASS)

> *Make an order for two same-colored Hanes Men's ComfortSoft Short Sleeve T-Shirt in
> extra-large size on Amazon. My color preference is, red > black > navy blue. Pick
> the most preferred color that is available.*

### 1. What codemode did wrong

Identical to task 1, and this one is a byte-for-byte controlled comparison. codemode's
reasoning was **correct and non-trivial**:

```python
for pid in (238,228,223):
    d=json.loads(await api.amazon.show_product(product_id=pid))
    print(pid, d['color'], d['relative_size'], d['inventory_quantity'])
# 238 red extra-large 1
# 228 black extra-large 1
# 223 navy blue extra-large 2
```

```python
print(await api.amazon.add_product_to_cart(product_id=223, access_token=t, quantity=2, clear_cart_first=True))
...
print(await api.amazon.place_order(payment_card_id=192, address_id=85, access_token=t))
# {"message": "Successfully placed the order...", "order_id": 3146}
```

Then:

```python
print(await api.supervisor.complete_task(answer="navy blue"))
```

→ `AssertionError:  'navy blue' == 'null'`

### 2. cc at the same decision point

Same product (223), same card (192), same address (85), **same `order_id: 3146`**:

```
== CALL [mcp__appworld__amazon__place_order] {"payment_card_id": 192, "address_id": 85, ...}
   --OUT: {"message": "Successfully placed the order. Debitted total amount of 18.2 from your card.", "order_id": 3146}
== CALL [mcp__appworld__supervisor__complete_task] {}
```

An empty argument object. That is the entire difference between a 7/8 and an 8/8.
vanilla likewise committed `null`.

### 3. Classification — **(a) L0 residency artifact**, same mechanism as task 1.

Note *why* the model wanted to answer: the task asked it to **pick** something. Every
one of the six over-answer failures in the corpus is a task where the action embedded
a choice, and codemode reported its choice as the deliverable.

### 4. vanilla discriminates: **residency implicated.**

---

## Task 3 — `277d81d_3` (codemode 5/6, vanilla 5/6 FAIL, cc PASS)

> *Mark everything in my Gmail inbox and outbox before the current calendar year as
> read.*

### 1. What codemode did wrong — it used its own clock's year

```python
inb = await all_pages(api.gmail.show_inbox_threads, access_token=tok, read=False, max_created_at="2025-12-31")
out = await all_pages(api.gmail.show_outbox_threads, access_token=tok, read=False, max_created_at="2025-12-31")
print(len(inb), len(out), inb[:2])
# 79 9 [{'email_thread_id': 4205, ..., 'created_at': '2023-05-17T16:25:52', ...}]
```

```python
ids = {t["email_thread_id"] for t in inb+out}
res = await asyncio.gather(*[api.gmail.mark_thread_read(email_thread_id=i, access_token=tok) for i in ids])
print(len(ids), set(res))
# 83 {'{"message": "Email thread marked as read."}\n'}
```

The in-world date is **2023-05-18**. codemode never asked; it took *"the current
calendar year"* to mean 2026 (real wall-clock), so "before the current calendar year"
swept in all of 2023. Grader:

```
In left but not right: [4608, 4611, 23069, ... 66 more]
```

83 marked, 17 expected. Left = actual. It over-marked by 66 threads. The self-check
that followed was vacuously satisfied (`0 0`) because the bound was wrong in the
same direction.

### 2. cc at the same decision point — call #3

```
== CALL [mcp__appworld__phone__get_current_date_and_time] {}
~~SAY: The current date is May 18, 2023, so I need to mark threads created before 2023-01-01.
== CALL [mcp__appworld__gmail__show_inbox_threads] {"max_created_at": "2022-12-31", "read": false, ...}
```

16 `mark_thread_read` calls, 30 API calls total against codemode's 96, and 6/6.
(This quote is from the 08:51 re-run, which independently reproduced the pass.)

### 3. Classification — **(b/e) neither residency nor representation: a shared model failure that cc's scaffold avoided**

vanilla, L4 with every schema resident, made the *identical* error:

```
===== CALL 6 [gmail__show_inbox_threads] {"max_created_at": "2026-01-01", "read": false, ...}
~~SAY: All unread threads are from 2023 or earlier. Now marking all 83 as read.
...
~~SAY: Done. I marked every Gmail inbox and outbox thread created before the current
calendar year (2026) as read — 83 threads in total, all dated 2023 or earlier.
```

Read that last sentence: vanilla saw that every thread was dated 2023, stated it, and
still called 2026 "the current calendar year". Both non-cc arms tripped on the same
stone; the residency dial is not touching this.

The shared base prompt says explicitly: *"Get the current date and time from the
`phone` app, never from your own clock or the machine's."* Corpus-wide on the 86
paired tasks, the arms call that API at:

| arm | calls `phone.get_current_date_and_time` |
|---|---|
| codemode | 17/86 |
| vanilla | 20/86 |
| claude-code | 28/86 |

cc grounds itself in the environment more often, but not overwhelmingly — this is a
propensity difference, not a capability one, and 1/3 of a *documented, prompted* rule
being followed by any arm is the real headline.

### 4. vanilla discriminates: **residency and representation both exonerated.**

---

## Task 4 — `a53a8fd_1` (codemode 7/10, vanilla 7/10 FAIL, cc PASS)

> *For my job search, I've drafted emails to all potential employers in the last 2
> days. Attach resume.pdf from my file system to each of them. If it's already
> attached, update it as I just made some changes to it. Then send the emails.*

### 1. What codemode did wrong — an off-by-one on the window, then hard-coded it

codemode *did* ground the date (cell 4):

```python
print(await api.phone.get_current_date_and_time())
# {"date": "Thursday, May 18, 2023", "time": "12:00 PM"}
```

It paginated the drafts correctly (8 total) and saw all their timestamps:

```
2023-05-18T02:29:01  'Application for Accountant Position'
2023-05-17T06:04:40  'Application for Accountant Position'
2023-05-17T03:05:00  'Application for Accountant Position'
2023-05-16T17:59:14  'Application for Accountant Position'
2023-05-16T12:59:16  'Application for Accountant Position'
2023-05-06T13:36:01  'Dinner Plans Tonight?'
2023-04-09T00:21:36  'Application for Data Analyst Position'
2023-02-01T08:42:20  'Netflix?'
```

Then the decisive cell:

```python
targets=[json.loads(await api.gmail.show_draft(draft_id=d["draft_id"], access_token=gm)) for d in drafts[:3]]
```

`drafts[:3]` — a hard-coded slice, no predicate. Final message:

> *Three job-application drafts from the last 2 days (May 17–18)*

Grader: `[518, 519, 522] == [518, 519, 520, 521, 522]`, *In right but not left:
[520, 521]* — the two May-16 drafts.

The reference reads "last 2 days" as a **48-hour rolling window from now**
(2023-05-16 12:00 → 2023-05-18 12:00). Both May-16 drafts (12:59 and 17:59) fall
inside it. codemode read it as the two calendar days May 17–18.

### 2. cc at the same decision point

```
== CALL [mcp__appworld__phone__get_current_date_and_time] {}
...
~~SAY: The work resume.pdf was updated today at 11:45. Now attaching it to all 5 job-application drafts from the last 2 days.
== CALL [...upload_attachments_to_draft] {"draft_id": 518, ...}   (then 519, 520, 521, 522)
...
~~SAY: All five job-application drafts from the last 2 days (2023-05-16 12:00 → now) have been sent
```

cc wrote the window out explicitly as a timestamp range and got the reference's
reading.

### 3. Classification — **(e) semantic under-specification, resolved differently; codemode's code style made it worse but did not cause it**

vanilla made the identical call:

> *Attached/updated resume.pdf on the 3 job-application drafts from the last 2 days
> (May 17–18) and sent all three.*

Same 3 draft ids, `[518, 519, 522]`, from an arm that had already called
`phone__get_current_date_and_time` as call #2. Information was not the constraint;
interpretation was.

The **code-style aggravator is real but secondary**: `drafts[:3]` encodes the
conclusion as an index rather than as a predicate over `created_at`. A filter
expression (`[d for d in drafts if d['created_at'] >= cutoff]`) would have forced the
cutoff to be named, and naming it is where the error becomes visible. This is worth a
prompt line — *filter by the predicate, never by a slice* — but note it would not have
changed the answer here, only exposed it.

The base prompt's own guidance points the wrong way for this task: *"For a period like
'yesterday', use the complete range 00:00:00 to 23:59:59"* invites the calendar-day
reading that both losing arms took.

### 4. vanilla discriminates: **residency and representation both exonerated.**

---

## Task 5 — `9871968_1` (codemode 6/7, vanilla 6/7 FAIL, cc PASS)

> *Buy everything on my amazon wishlist, and have it delivered to my work address.*

### 1. What codemode did wrong — it left the wishlist alone

Everything about the order is right: 1 order added, correct product→quantity map,
correct work address, no Address records touched. The one failure:

```
assert model changes match amazon.Product, amazon.Order, amazon.OrderItem,
amazon.WishListEntry, gmail.*, file_system.*, ignoring amazon.CartEntry, amazon.Address.
...
In right but not left: ['amazon.WishListEntry']
```

The decisive cell:

```python
orig = cart['cart_items']
print(await api.amazon.clear_cart(access_token=tok))
for it in wl:
    r = await api.amazon.add_product_to_cart(product_id=it['product_id'], quantity=it['quantity'], access_token=tok)
```

`add_product_to_cart` copies; it does not consume the wishlist entry.

### 2. cc at the same decision point

```
== CALL [mcp__appworld__amazon__move_product_from_wish_list_to_cart] {"product_id": 769, "quantity": 1}
   ... 1274, 1499, 2471, 2581
```

`move_product_from_wish_list_to_cart` *deletes* the `WishListEntry`, which is what the
reference solution happens to do, so the changed-model set matches.

### 3. Classification — **(d) grader asymmetry, and it is a coin-flip that catches every arm**

The task never asks for the wishlist to be emptied. Our own base prompt actively
discourages it: *"Avoid collateral damage. Do only what was asked... unrequested
changes to the world count against you."* The grader's ignore-list explicitly names
`amazon.CartEntry` and `amazon.Address` but **not** `amazon.WishListEntry`, so the
reference's incidental wishlist mutation is graded as a requirement.

This is the mirror image of `6d59d90_3`, where a defensible cart cleanup landed on the
graded side of the same arbitrary line — same app, same ignore-list, opposite sign.

Corpus-wide, **15 runs fail specifically for a missing `amazon.WishListEntry`
change**, and they are spread across every arm — including cc three times
(`7b97e6d_1`, `7b97e6d_3`, `9871968_2`). Across the 86 paired tasks, codemode and
vanilla each reach for `move_product_from_wish_list_to_cart` on 8 tasks, cc on 5. cc
does not use the right verb more often; it used it on *this* task.

### 4. vanilla discriminates: **residency and representation both exonerated. This win is luck.**

---

## Synthesis

> ### ⚠ CORRECTION — the paired score comparison in this section is invalid
>
> An earlier revision reported "cc vs codemode: 12–2, exact sign p=0.013" over the
> paired set. **Withdraw that number.** The cc arm's task set is sampled on the
> dependent variable:
>
> | | tasks | have a claude-code run |
> |---|---|---|
> | codemode **failures** | 46 | **46 (100%)** |
> | codemode **passes** | 398 | 65 (16%) |
>
> Every task codemode failed was given a cc run; only one in six it passed was. A
> paired comparison conditioned on one arm's failure can only favour the other arm.
> Split by how the task entered the corpus:
>
> | slice | n | codemode | vanilla | claude-code | cc vs cm |
> |---|---|---|---|---|---|
> | **unbiased ramp** (seeded `--sample`) | 60 | **60/60** | 56/60 | 58/60 | **0–2**, p=0.50 |
> | **failure-enriched** (46 of 50 are codemode failures) | 50 | 5/50 | 26/50 | 34/50 | 29–0, p<0.0001 |
>
> **On the only slice not selected on codemode's outcome, codemode is ahead of both
> other arms and the discordant pairs run 0–2 in codemode's favour.** All three arms
> are saturated there (93–100%), which is the expected regime per CLAUDE.md — score
> stops discriminating and cost is the endpoint that still moves (codemode $0.185 vs
> vanilla $0.714 vs cc $0.873 per task, a **4.0–4.7× advantage**).
>
> The enriched slice still answers a real question, just not "which arm is better":
> *of the 46 tasks codemode failed, cc solves 34.* That is a mechanism-hunting sample,
> which is exactly what the five-task triage above is. **The per-task diagnoses are
> unaffected** — they rest on read traces, not on scores. What does not survive is any
> claim of the form "cc beats codemode by N points".

### One mechanism, not five — but only for two of them

| task | mechanism | class | vanilla | verdict |
|---|---|---|---|---|
| `2e9b91e_2` | passed `answer=` on a non-question | (a) L0 residency | PASS | real, fixable |
| `4242c97_1` | passed `answer=` on a non-question | (a) L0 residency | PASS | real, fixable |
| `277d81d_3` | used wall-clock year, not in-world date | (b/e) model propensity | **FAIL** | not arm-attributable |
| `a53a8fd_1` | "last 2 days" as calendar days, not 48h | (e) under-specification | **FAIL** | not arm-attributable |
| `9871968_1` | didn't empty the wishlist | (d) grader asymmetry | **FAIL** | luck |

**The vanilla control does the whole job here.** Three of the five cc "wins" are tasks
vanilla lost too. An L4 tool-calling arm with every schema resident fell into the same
hole as the L0 code arm — so neither residency nor representation can be the
explanation, and charging them to codemode would have been the mis-diagnosis this
skill exists to prevent.

The two that survive the control are the *same bug twice*, and it is a residency bug
with a one-sentence cause.

### The over-answer bug is bigger than these two tasks

Counting over-answers is legitimate on the enriched slice — it is a *mechanism* rate
within codemode's failures, not a head-to-head score. Of codemode's **46** corpus-wide
failures, **six are the over-answer bug and nothing else** — every one is
7/8 or 4/5 with `assert answers match` as the sole failure:

| task | committed | expected | instruction shape |
|---|---|---|---|
| `245cb43_1` | `'oxo good grips compact dish rack'` | `null` | *Buy me a dish rack... that will fit* |
| `245cb43_3` | `'suunto m-3 g compass'` | `null` | *Buy me a compass... that will fit* |
| `2e9b91e_2` | `'649.6'` | `null` | *Request them money for it* |
| `4242c97_1` | `'navy blue'` | `null` | *Pick the most preferred color available* |
| `4242c97_3` | `'black'` | `null` | *Pick the most preferred color available* |
| `7b97e6d_2` | `'6'` | `null` | *Order as many things as possible with $500* |

**Six of codemode's 46 failures — 13% — are one line in a docstring it never reads.**
In all six, `grep -c complete_task.py stream.jsonl` = 0. cc and vanilla have the same
line resident in their tool schemas; over the whole corpus vanilla over-answers once
and cc never.

The pattern is sharp: every one is an *action* task whose action required a **choice**,
and codemode reported the choice. It is not confusion about whether the task is a
question; it is treating a hard-won selection as the deliverable.

Corroborating signal — how often each arm calls `supervisor.show_active_task`, whose
response carries `"answer": "<<NOT_GIVEN>>"`:

| arm | calls it |
|---|---|
| codemode | **6/86** |
| vanilla | 49/86 |
| claude-code | 73/86 |

codemode skips it because the harness injects the instruction into the user message, so
it has no reason to fetch the task record — and thereby never sees the answer slot
either. Secondary to the docstring, but it points the same way.

### Ranked fixes

**1. Strengthen the `Finishing` section of the shared base prompt with the docstring's
own wording. — highest EV, ~5 lines, no fairness cost.**

Current: *"If the task asks a question, pass the answer. If it only asks for something
to be done, omit the answer argument."*

The `complete_task` schema says it far better, and vanilla already has it resident:

> Pass it **if and only if** the task requests an answer, e.g. *"How many songs are in
> the Spotify queue?"*. If the task is not a question, e.g. *"Start my Spotify music
> player."*, the answer must be left to the default value, i.e. `None`.
> **Making a choice in order to complete an action does not make the choice an answer.**

The base prompt is shared by all three arms, which is the point (level up, not down):
vanilla and cc already have the strong form resident so it costs them nothing, and it
closes codemode's gap. Expected: up to 6 of codemode's 21 failures on the paired set,
worth roughly +7 points of pass rate. **Must be re-measured, not assumed** — the last
clause is new text and could over-correct into under-answering real question tasks.
Track both `overAnswer` and `wrongAnswer` counts, not just pass rate.

**2. Make `api/supervisor/complete_task.py` resident in codemode's preamble. — cheap,
narrowly scoped, but redundant with #1.**

Six APIs in `supervisor`, one of which every task must call exactly once. Inlining that
one docstring into the L0 preamble costs ~120 tokens/task and removes the "never read
it" failure at the source. Worth doing *instead of* #1 only if we want the fix to be
codemode-local — but then the base prompt still carries the weak wording for everyone,
so #1 is the better single change. Do not do both without measuring separately.

**3. A "predicate, not slice" line in the codemode preamble. — cheap, small, real.**

`drafts[:3]` in `a53a8fd_1` is a code-shaped hazard: hard-coding a count where a filter
belongs hides the cutoff that is actually the decision. One line in the preamble —
*select rows with a predicate over the field you mean; never with an index slice* —
costs nothing. It would not have fixed `a53a8fd_1` (the window itself was wrong), so
score this as hygiene, not as a fix for a measured failure.

**4. Environment grounding — worth a prompt line, but the ceiling is low.**

All three arms ignore *"get the current date from the phone app"* most of the time
(17/20/28 of 86). Restating it more emphatically is cheap; the honest expectation is
small, since vanilla read `created_at: 2023-...` on screen and still said 2026.

**Not worth fixing:**

- **The wishlist trap (`9871968_1`).** It is a grader defect that hits every arm, cc
  included, 15 times in the corpus. Prompting codemode to prefer
  `move_product_from_wish_list_to_cart` would be **fitting to the reference
  implementation, not to the task** — and it directly contradicts the base prompt's
  collateral-damage rule. Leave it, and note it as benchmark noise on any wishlist task.
- **"last 2 days" (`a53a8fd_1`).** Reference-specific window semantics. Chasing it is
  the same overfit.

### What n=5 — and n=86 — can and cannot support

- **The five tasks were never a sample.** They are the discordant cells of one arm
  comparison; conditioning on "cc won" and then asking why cc won can only generate
  hypotheses. The mechanism findings above are existence proofs.
- **What the traces do establish, at n=1 each and conclusively:** codemode never opened
  `complete_task.py` in any over-answer run (0/6); codemode and vanilla used the
  wall-clock year on `277d81d_3`; cc used `phone.get_current_date_and_time`; vanilla
  failed identically on three of the five. These are facts about specific runs, not
  rates.
- **There is no valid head-to-head score rate in this corpus** — see the correction at
  the top of this section. The unbiased slice is saturated (60/56/58 of 60); the
  enriched slice is selected on codemode's failure. Producing one requires running cc
  on a task set chosen *before* codemode's outcome is known.
- **What is a legitimate rate:** within codemode's 46 failures, 6 are the over-answer
  bug. That is a decomposition of one arm's error modes, which selection on that arm's
  failures does not distort.
- **The 6-of-46 decomposition is the load-bearing number.** Until it is fixed and
  re-measured on a pre-registered task set, no claim about "cc's scaffold beats
  codemode" is supportable — the correct next experiment is fix #1, then a seeded
  sample drawn before anyone looks at the scores.
- **Nothing here is cross-model.** Opus 5 only, as with every other result in this repo.

### Evidence

Snapshot of all 15 run dirs (evaluation, result, system-prompt, stream, trajectory,
env-calls, world-diff) taken before the in-flight re-run could overwrite more of them:

```
<scratchpad>/snap/<task>__<arm>__<variant>__anthropic-claude-opus-5/
```

Every quoted cell and tool call in this document is re-derivable from that snapshot.

---

# Harness-level differences

What is Claude Code's harness doing that our prime arms don't? Measured across the
110-task 3-arm subset, **reported separately for the unbiased ramp (n=60) and the
failure-enriched batch (n=50)**, because pooling them is what produced the withdrawn
statistic above.

Categories, per the standing "level up, not down" principle:

- **(A) ARM-NEUTRAL** — port it to *both* prime arms. The tool-surface shape is the
  only variable under test; a scaffold feature that lifts both arms keeps the
  representation comparison clean and improves the product.
- **(B) OUR BUG** — an unintended asymmetry in our prompts/config. Just fix it.
- **(C) INHERENT** — cc product behaviour we cannot or should not copy.
- **(D) REPRESENTATION-LINKED** — the REPL formulation is structurally different, so
  there is no single feature to port. Each arm expresses it in its own idiom, and the
  quality of each arm's answer **is part of the result**, not a confound.

## The measurements

| | codemode a1 | vanilla b1 | claude-code c1 |
|---|---|---|---|
| **unbiased ramp (n=60)** | | | |
| pass | 60/60 | 56/60 | 58/60 |
| cost / task | **$0.185** | $0.714 | $0.873 |
| API turns | 9.9 | 8.2 | 8.7 |
| API calls | 36.2 | 17.2 | 19.8 |
| calls per turn (max) | 3.18 (1 tool call) | 2.00 (20) | 2.20 (27) |
| turns with a thinking block | 30.4% | 27.3% | 35.6% |
| thinking chars logged | 58 | 120 | **0 (redacted)** |
| tool errors / failed API calls | 0 / 0 | 0 / 0 | 0 / 8 |
| **read-after-write verification** | 36% | 18% | **56%** |
| duplicate calls (share) | 1.5 (4.1%) | 0.4 (2.1%) | 2.7 (13.8%) |
| **failure-enriched (n=50)** | | | |
| cost / task | **$0.235** | $1.033 | $1.199 |
| API calls | 120.1 | 25.9 | 27.9 |
| **read-after-write verification** | 46% | 27% | **61%** |
| **duplicate calls (share)** | **38.4 (31.9%)** | 0.3 (1.0%) | 3.8 (13.6%) |
| worst single task | **1853 duplicates** | 3 | 19 |

Non-MCP tools cc used across all 110 tasks: **`Read` ×2.** No TodoWrite (not in
`--allowedTools`), no subagents, no Bash, no skills. **No compaction event fired on any
task.** cc's scaffold advantage here is not tooling — these tasks are 9-turn tasks.

## Capability by capability

### 1. Verification — read-after-write. **(A) ARM-NEUTRAL. Top of the punch list.**

The one large, consistent, direction-stable gap. cc re-queries world state after its
last mutating write on **56%/61%** of tasks; codemode 36%/46%; vanilla **18%/27%**.

cc, `277d81d_3`, after 16 `mark_thread_read` calls — three independent re-queries
including a category it had not touched:

```
== CALL [...gmail__show_inbox_threads]  {"max_created_at": "2022-12-31", "read": false}
== CALL [...gmail__show_outbox_threads] {"max_created_at": "2022-12-31", "read": false}
== CALL [...gmail__show_snoozed_threads]{"max_created_at": "2022-12-31", "read": false}
== CALL [...gmail__show_category_sizes] {"read": false}
~~SAY: Verification queries now return no unread inbox/outbox (or snoozed) threads created before 2023.
```

and `a53a8fd_1`, re-reading a sent email *and* the remaining drafts after sending five.

**Honest caveat, and it is a big one:** verifying does **not** correlate with passing.
In-sample, verified runs pass *less* often than unverified ones for every arm
(codemode 48% vs 65%, vanilla 68% vs 77%, cc 77% vs 90%) — because agents verify when
a task is hard. So this is not "verification causes the wins". It is a behaviour worth
porting because it converts silent wrong answers into visible ones, and because
`277d81d_3` is a case where prime's *own* verification was vacuous: codemode did
re-query, but with the same wrong bound, and got `0 0` back.

**Port as:** a "confirm the postcondition you were asked for, re-derived independently
of the filter you used to act" line in the shared base prompt (both prime arms). Cheap
— one paragraph. Expected value: moderate and mostly *diagnostic*; do not expect a
score jump, and measure it as such.

### 2. Extended thinking. **(B) OUR BUG — a logging gap, not a capability gap.**

All three arms think, at comparable frequency: 30.4% / 27.3% / 35.6% of turns on the
unbiased slice. cc is modestly ahead, not categorically different. **Extended thinking
is not a confound in this comparison.**

But the logs are asymmetric: prime records thinking summaries in plaintext, cc's
`stream-json` yields `{"type":"thinking","thinking":"","signature":"…"}` — **0 chars
across 110 tasks.** cc also emits `system/thinking_tokens` events (14 on `9871968_1`,
`estimated_tokens` ramping 50→150→250…) that we ignore.

This is our bug twice over. It violates "log the inputs, not just the verdicts": prime's
thinking is *how* we diagnosed `9871968_1`, where codemode explicitly weighed the two
verbs and chose wrong —

```
"I'm debating whether to use move_product_from_wish_list_to_cart or add_product_to_cart
 — the former removes items from the wishlist after purchase, which feels more natural,
 though the task description is a bit ambiguous about whether bought items should stay
 on the wishlist."
```

— and we have no equivalent for cc. **Fix:** capture `system/thinking_tokens` into
`result.json`, and record that cc thinking text is unavailable rather than logging an
empty string that reads like "cc did not think".

### 3. Batching. **Not a difference. Nothing to port.**

cc 2.20 calls/turn (max 27), vanilla 2.00 (max 20). Statistically indistinguishable;
both arms already batch, confirming the CLAUDE.md finding that dispatch was never the
constraint. codemode's 3.18 is a different unit — it issues exactly **one tool call per
turn** and makes 3.18 API calls inside that cell.

### 4. Error recovery. **(B) OUR BUG — instrumentation, then reassess.**

cc: 4 tool errors, 37 failed API calls (mostly `422` validation on `venmo/balance`,
`amazon/orders`), and recovers — those runs still pass. Prime: **0 failed API calls
across 110 tasks**, which is not credible as a behavioural fact. Our env-call logger
records `ok` differently for the two arms (cc's rows carry `status`; prime's do not).
Until prime logs HTTP status the same way, **no claim about relative error recovery is
measurable.** Fix the logger first; this is a one-line change and it gates a real
question.

### 5. Plan/todo tracking, subagents, skills. **(C) INHERENT — nothing to copy here.**

cc's `system/init` advertises 5 agents and 15 skills, but `--allowedTools
mcp__appworld,Read,Edit` blocks them and **none were used.** At 9 turns there is nothing
to plan. This says nothing about long-horizon work — re-ask on terminal-bench.

### 6. Context management. **(D) REPRESENTATION-LINKED — and codemode is under-using its own idiom.**

There is no feature to port. Tool-calling puts every result in the transcript verbatim
and manages context by compacting a transcript the agent does not control; the REPL lets
the *caller* decide what survives, with state in kernel variables and files, outside the
transcript. Our prior 87/13 emission/reception decomposition is that difference measured.

**Baseline for cc/vanilla: compaction never fired on any of the 110 tasks.** At this
horizon it is untested for all three arms.

**Where codemode fails to use its own advantage — the actionable finding:**

| | duplicate calls / task | share of all calls | worst task |
|---|---|---|---|
| codemode, unbiased slice | 1.5 | 4.1% | 34 |
| codemode, enriched slice | **38.4** | **31.9%** | **1,853** |
| vanilla | 0.3–0.4 | 1–2% | 4 |
| claude-code | 2.7–3.8 | ~14% | 19 |

On harder tasks **a third of codemode's API calls are byte-identical repeats**, against
1% for vanilla. The persistent kernel exists precisely so that fetched data is still in
memory; the a1 preamble says so and offers `%whos`. The agent is re-fetching anyway —
and because a loop is one cheap cell, the blast radius is 1,853 redundant calls rather
than the 3 a tool-calling arm would manage. **The REPL's advantage and this failure are
the same property.**

Note this is *not* the transport-cache idea CLAUDE.md rules out: nothing here should be
deduplicated behind the agent's back. The fix is affordance-side — make "what do I
already hold?" cheap and habitual (a `%whos`-first nudge; a fetched-collection registry
the agent writes to deliberately). High value, and the cost is a prompt experiment.

### 7. Where we are ahead of cc

Honest in both directions:

- **The jobs runtime.** Durable background work surviving kernel death, with the
  `wait`-that-ends-the-turn primitive. cc has no equivalent — its tool loop blocks.
  Untested here because AppWorld tasks are 9 turns and synchronous; it is the whole
  game on terminal-bench.
- **The cell watchdog** — nothing may hold the kernel past the cell ceiling. cc has no
  analogous guard on a long tool call.
- **Cost.** 4.0–4.7× on the unbiased slice ($0.185 vs $0.714/$0.873), and cc is the most
  expensive arm on both slices. This is the result that actually replicates.
- **Thinking-text logging**, per §2 — prime's is diagnosable, cc's is opaque.

## The punch list, ranked by expected value per unit of work

| # | item | class | work | expected value |
|---|---|---|---|---|
| 1 | `complete_task` answer discipline in the shared base prompt (§Ranked fixes above) | B | ~5 lines | **High** — 6 of codemode's 46 failures |
| 2 | Duplicate-call / "check what you already hold" affordance for codemode | D | prompt experiment | **High** — 32% of calls on hard tasks; also the cheapest cost win |
| 3 | Symmetric API-error logging (HTTP status for prime) | B | one line | **High as an enabler** — error recovery is currently unmeasurable |
| 4 | Capture cc `thinking_tokens`; stop logging empty thinking as `""` | B | small | **Medium** — restores diagnosability on one arm |
| 5 | Postcondition-verification line in the shared base prompt, both arms | A | one paragraph | **Medium**, mostly diagnostic — verification does not correlate with passing |
| 6 | Plan/todo, subagents, compaction | A/C | — | **Unknown at 9 turns.** Defer to terminal-bench |

Items 1–4 are all *our* bugs or *our* affordances. **Nothing on this list is a
capability Claude Code has that we lack** — which is itself the finding: on this
benchmark cc's harness is not doing something structural that prime cannot do. It
verifies more, it thinks slightly more often, and it costs 4× more.

## Caveats

- Everything above is Opus 5, AppWorld, ~9-turn tasks. The capabilities most likely to
  separate harnesses — planning, compaction, durable background work — are all
  **untested at this horizon**, and three of them never fired at all.
- The two slices are not interchangeable; every number is reported per slice for that
  reason.
- The read-after-write classifier uses HTTP method for cc and API-name prefix for prime.
  Both were spot-checked against read traces, but they are not the same detector, so
  treat the verification gap as "large and direction-stable", not as a precise ratio.
