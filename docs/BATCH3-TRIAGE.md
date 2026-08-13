# AppWorld batch-3 failure triage (seed 44, Opus 5)

Method: `/diagnose-run-fail`. For every task below I read the paired arm's full
trajectory (`stream.jsonl` message stream, cells **and** cell outputs), then the
grader's `report.failures[].trace`. Cell numbers refer to the message index
printed by the dump script; run dirs are
`.run/appworld/<task>__{codemode__L0__a1,vanilla__L4__b1}__anthropic-claude-opus-5`.

## A0 — integrity

All 14 runs: `exitCode 0`, `toolErrors 0`, `stopReason completed` — with one
exception: **`277d81d_3` vanilla hit the cost ceiling** (`stopReason: budget`,
$3.069 against `maxCost 3`) after 97 tool calls, 83 of them one-thread-at-a-time
`gmail__mark_thread_read`. It had already finished the marking before the ceiling,
so the failing check is not budget-caused, but the arm was truncated and this run
should not be quoted for cost.

Config is symmetric within each pair (`variants` matches across arms on
`277d81d_3` and `e0fe09c_1`, both `{docsGate: false, navTools: false}`; `None` on
the rest). No harness-level defect found in this batch.

---

## 1. `92fe421_2` — SHARED — **TASK-AMBIGUITY** (evidence present and rejected by both arms)

> "My roommates and I share spotify premium, which I just paid for yesterday.
> Request the money for it from them on venmo assuming equal share among all…
> Skip the one/s who have already paid me for it."

Both arms: 4/5. Identical failing check, identical value:

```
assert amount from added_payment_requests match private_data.individual_share (tolerance=0.51)
AssertionError:  3.33 ± 0.51 == 5.0 ± 0.51
```

Both arms saw exactly the same world: subscription `paid_amount: 10.0` started
2023-05-17; two contacts with `relationships: ["roommate"]` (Jason Simpson, Tammy
Weaver); and a received Venmo transaction `{amount: 5.0, description: "For Spotify
Premium", sender: Tammy Weaver}`. Both computed `10.0 / 3 = 3.33` (supervisor +
2 roommates) and requested $3.33 from Jason. The reference is `10.0 / 2 = 5.0`.

The decisive detail is that **both arms noticed the contradiction and reasoned it
away**. Vanilla, cell [14] thinking:

> "Tammy already paid $5, so I need to figure out what Jason owes—but that $5
> payment doesn't quite fit the equal split, which makes me wonder if the split is
> actually just between 2 people instead."

and again at cell [17], immediately before acting:

> "Tammy's payment of exactly $5 suggests she might have been splitting it as just
> 2 people initially, but the problem states 'equal share among all,' which should
> include everyone involved."

Codemode reached the same fork ("Tammy paid $5, and the Spotify Premium
subscription is $10 total, which should divide equally among the three people…")
and also went with 3.33 (`amt=round(10.0/3,2)`).

Class: **TASK-AMBIGUITY**. "Equal share among all" is genuinely readable as
including the payer; the benchmark means among the roommates. It is not a pure
reference bug — the world contains a disambiguator (the prior $5 payment is
exactly `individual_share`) that a maximally careful agent would have taken as
ground truth over its own reading. Arm-neutral: no representation effect.

## 2. `277d81d_3` — SHARED — **AGENT (both arms): host-clock / world-clock confusion**

> "Mark everything in my Gmail inbox and outbox before the current calendar year
> as read."

Both arms: 5/6, same check:

```
assert set of updated threads' ids match the set of private_data.to_mark_thread_ids
{…83 ids…} == {…17 ids…}          # left = actual, right = expected
In left but not right: [66 ids]
```

Over-marking, not under-marking. Mechanism: **both arms took "the current calendar
year" to mean the model's own present (2026) instead of the simulated world's
(2023-05-18).** The AppWorld world clock is 2023; the host clock is 2026-08.

Codemode, cell [10] — the filter, and its own final answer:

```python
inb = await all_pages(api.gmail.show_inbox_threads, access_token=tok, read=False, max_created_at="2025-12-31")
out = await all_pages(api.gmail.show_outbox_threads, access_token=tok, read=False, max_created_at="2025-12-31")
```
> "Done — 83 unread inbox/outbox threads dated before **2026** are now marked as read."

Vanilla did the same (`max_created_at: "2025-12-31"`, then "corrected" to
`"2026-01-01"`), and its own thinking at cell [10] shows it looked straight at the
evidence and did not update:

> "…using 2025-12-31 as the cutoff might exclude entries from that day depending on
> timestamp precision, so I should use 2026-01-01 instead… **though looking at the
> actual data, everything here is from 2023 or earlier anyway**"

> Final: "I marked every Gmail inbox and outbox thread created before the current
> calendar year (**2026**) as read — 83 threads in total, all dated 2023 or earlier."

Neither arm called `phone.get_current_date_and_time`. That call exists, is one hop
away, and returns the answer verbatim — measured in `92fe421_2`, where both arms
did call it: `{"date": "Thursday, May 18, 2023", "time": "12:00 PM"}`.

Class: **AGENT, both arms**, mechanism *world-clock assumption*: a relative time
expression ("current year", "yesterday", "today") resolved against the model's
prior rather than against the environment, with the contradicting data already in
context. Arm-neutral. See §6 — the same mechanism cost vanilla a different task.

## 3. `2e9b91e_2` — CODEMODE-ONLY — **AGENT (codemode): answer-discipline, unread docstring at L0**

> "Everything in my amazon cart is for my roommate, Troy. Request them money for it
> on venmo. Ignore tax and delivery fees from the cart cost."

Codemode 4/5, vanilla 5/5 (pass). **All four world-state checks passed for
codemode** — the payment request, the recipient, and the amount ($649.60) are all
correct. The single failure is the answer:

```
assert answers match.
AssertionError:  '649.6' == 'null'
```

Codemode, cell [12] — the whole failure:

```python
print(await api.supervisor.complete_task(answer=649.6))
```

Vanilla at the same decision point, cell [14]:

```json
{"name": "supervisor__complete_task", "arguments": {"status": "success"}}
```

Mechanism, and it is a clean residency asymmetry. The guard text lives in the
`answer` parameter description:

> "Pass it **if and only if** the task requests an answer… If the task is not a
> question, e.g., 'Start my Spotify music player.', the answer must be left to the
> default value, i.e., None."

- **Vanilla L4** has that sentence resident in `tools.json`
  (`supervisor__complete_task.input_schema.properties.answer.description`) on every
  turn.
- **Codemode L0** saw only `api/supervisor/INDEX.md`, which it `cat`'d in cell [2]:
  `api.supervisor.complete_task(answer?, status?)` — "Mark the currently active
  task as complete **with the given answer**." That one-liner *invites* the wrong
  behaviour. The full text is in `api/supervisor/complete_task.py`, which codemode
  never opened.

Not a new taxonomy entry — this is the second instance of the batch-1
`4242c97_1` class (codemode committed `"navy blue"` on a null-answer task). **n=2,
same arm, same tool, same unread file.** But §4 and §5 show the class is *not*
codemode-exclusive, so the fix is not "make codemode read more docs".

## 4. `ac62177_2` — VANILLA-ONLY — **AGENT (vanilla): answer-discipline, with the docstring resident**

> "Check my gmail to see if any of my friends' email thread has been marked as
> spam. If so, unspam it and make it unread. Then, delete all spam threads."

Codemode 7/7 (pass), vanilla 6/7. Both arms did identical, correct world work
(2 friend threads unspammed + marked unread, 20 spam threads deleted, spam empty).
The only difference:

```json
vanilla  cell [42]:  {"name": "supervisor__complete_task", "arguments": {"answer": "yes"}}
codemode cell [14]:  await api.supervisor.complete_task(status="success")
```
```
assert answers match.
AssertionError:  'yes' == 'null'
```

This is the **mirror image of §3, and it is the more informative one**: vanilla had
the "if and only if" text resident in its schema on that very turn and still
answered, because the instruction *opens* interrogatively ("Check … to see if any
… has been marked as spam"). Residency did not protect it.

So the taxonomy entry is **answer-discipline (arm-neutral)**, triggered by
instruction surface form, not by doc residency. Residency changes *which* tasks
trip it, not whether the failure mode exists. Current split: codemode trips on
action tasks where the one-line INDEX invites an answer; vanilla trips on action
tasks phrased as questions.

## 5. `ec437da_3` — VANILLA-ONLY — **AGENT (vanilla): protocol omission, never called `complete_task`**

> "Buy one Philips Norelco OneBlade Pro on Amazon… get it gift wrapped … Do
> whatever is cheaper."

Codemode 9/9 (pass), vanilla 8/9. Vanilla got the *comparison* right — same
conclusion as codemode ($98.00 via Amazon gift wrap vs $96.30 self-wrap), same
order placed (`order_id 3146`, $96.30). Then:

```
committedAnswer: {"answer": "\"<<NOT_GIVEN>>\"", "status": null}
taskCompleted:   false
assert answers match.  AssertionError:  '<<not_given>>' == 'null'
```

`supervisor__complete_task` is absent from vanilla's entire 19-call tool list
(last call is `amazon__place_order`). It wrote a long prose summary to the user
instead of closing the task. `<<NOT_GIVEN>>` is the sentinel for "never
committed", and the grader treats it as a wrong answer.

Class: **AGENT (vanilla)**, mechanism *protocol omission* — the agent conflated
"tell the user I'm done" with "mark the task done". Second instance in the corpus:
`34d9492_2` vanilla shows the same `'<<not_given>>' == 'null'` signature. **n=2,
vanilla only, zero instances in codemode.** Plausible mechanism for the asymmetry:
codemode's habit is to end a cell with `print(await api.supervisor.complete_task())`
appended to a verification read (it did exactly that in `1b2bae9_1` cell [24] and
`277d81d_3` cell [14]), so completion rides along with the check; vanilla has to
spend a separate tool call on it after it has already written its closing prose.

Aside worth recording, not graded: vanilla `clear_cart`'d three pre-existing
unrelated items ($890 worth) to isolate its purchase and disclosed it in prose.
Compare `1b2bae9_1` below, where codemode saved and restored them — and batch-2
`6d59d90_3`, where codemode's *cleanup* is what failed it. Cart hygiene is
ungraded here and graded there; the ignore-list asymmetry is arbitrary.

## 6. `1b2bae9_1` — VANILLA-ONLY — **AGENT (vanilla): host-clock filename + unverified API default**

> "Order one IKEA LERHAMN Dining Table on Amazon for home delivery. Save the
> receipt in the '~/bills/' folder… make sure the file location and name are as per
> the existing organization."

Codemode 12/12 (pass), vanilla 10/12. Two failures, one cause:

```
assert the added file name mentions the order_id, year, month, day.
AssertionError:  '2023' in '2026-08-12_order_id_3146'

assert this added file's path is as per private_data.file_name_format.
'~/bills/amazon/2026-08-12_order_id_3146.txt'
in ['~/bills/amazon/2023-05-18_order_id_3146.txt', '~/bills/amazon/2023-5-18_order_id_3146.txt']
```

Vanilla, cell [18] — it omitted `download_to_file_path` entirely and let the API
name the file from the **host clock**:

```json
{"name": "amazon__download_order_receipt",
 "arguments": {"order_id": 3146, "access_token": "…", "file_system_access_token": "…"}}
→ {"file_path": "~/bills/amazon/2026-08-12_order_id_3146.txt"}
```

and then asserted conformance it had not checked:

> "receipt saved to `~/bills/amazon/2026-08-12_order_id_3146.txt`, matching the
> `YYYY-MM-DD_order_id_N.txt` pattern used by the 15 existing receipts in that
> folder."

It *had* listed those 15 receipts seven cells earlier (cell [11]: `2022-05-27_…`,
`2022-07-30_…`, `2022-08-18_…`, …). A 2026 date against fifteen 2022–2023 dates is
visible at a glance; it matched the *shape* of the convention and never checked
the value.

Codemode's contrast is a three-step discipline:

1. cell [20] — fetch the authoritative date: `show_order(3146)` → `'created_at': '2023-05-18T12:00:00'`
2. cell [22] — pass it explicitly, do not take the default:
   `download_order_receipt(..., download_to_file_path="~/bills/amazon/2023-05-18_order_id_3146.txt")`
3. cell [24] — read the file back and confirm (`Order Date: 2023-05-18`)

Class: **AGENT (vanilla)**, mechanism = *host-clock leak through an unspecified API
default*, compounded by *claiming verification not performed*. Same root as §2 —
world time vs host time — but here it reached the world through a defaulted
parameter rather than through the agent's arithmetic, which makes it harder to
notice. Codemode also restored the three pre-existing cart items it had displaced.

## 7. `e0fe09c_1` — VANILLA-ONLY — **AGENT (vanilla): canonical-name substitution vs derived string**

> "Label all email threads in my Gmail inbox from notifications@<app>.com with the
> label of the respective app. Ignore spam and archived ones."

Codemode 9/9 (pass), vanilla 7/9. Both arms found the same 13 threads and got
amazon/spotify/venmo right. The whole delta is one token:

```
In left but not right:  ['simple_note' × 5]
In right but not left:  ['simplenote'  × 5]
```

(The second failing check runs with `normalize_text=True` and still fails —
normalisation does not collapse the underscore.)

**Codemode derived the label from the address** (cell [8]):

```python
m = re.fullmatch(r"notifications@(\w+)\.com", p["email"])
if m: targets.append((t["email_thread_id"], m.group(1), t["label"]))
# → [(47847,'simplenote',None), (47845,'simplenote',None), …]
```
then labelled with exactly that captured group (cell [12]:
`label_thread(label=app, …)`). Its thinking at cell [12] shows it hit the fork
deliberately — *"I'm debating how to label these apps—whether to use the app name
directly or derive…"* — and stayed with the derived string.

**Vanilla read the same threads as prose and substituted the app's canonical
name**, `simple_note` (cell [21], five `label_thread` calls). That string is what
it had seen in `supervisor__show_account_passwords`
(`"account_name": "simple_note"`) and in the sender display name `"Simple Note
Notifications"`. It had the domain in hand — it queried
`from_email: "notifications@simplenote.com"` two cells earlier — and still
normalised.

Class: **AGENT (vanilla)**, mechanism = *canonical-name substitution*: reading a
value as prose invites replacing it with the entity's "real" name; extracting it
with a regex mechanically preserves the literal. This is a **new taxonomy entry**
and the first one that is *structurally* favourable to codemode rather than
incidental — a string that passes through `re.fullmatch(...).group(1)` cannot be
paraphrased on the way to the API, whereas a string that passes through the
model's prose plan can. Expect it wherever the graded value is an exact literal
lifted from data.

---

## Taxonomy tally

### Trace-verified diagnoses

| task | batch | class | mechanism | arm charged |
|---|---|---|---|---|
| `4242c97_1` | 1 | AGENT | answer-discipline (committed `"navy blue"` on null-answer task) | codemode |
| `6d59d90_3` | 2 | AGENT | ignore-list asymmetry — cart→wishlist cleanup lands on graded side (`amazon.WishListEntry` in left-not-right) | codemode |
| `9871968_1` | 2 | shared | (batch-2 triage; both arms identical) | neither |
| `a53a8fd_1` | 2 | shared | (batch-2 triage; both arms identical) | neither |
| `92fe421_2` | 3 | TASK-AMBIGUITY | "equal share among all" — /3 vs /2; disambiguator present, rejected by both | neither |
| `277d81d_3` | 3 | AGENT | world-clock assumption ("current year" = 2026, world is 2023) | both |
| `2e9b91e_2` | 3 | AGENT | answer-discipline — unread `complete_task.py` docstring at L0 | codemode |
| `ac62177_2` | 3 | AGENT | answer-discipline — docstring **resident**, instruction phrased as a question | vanilla |
| `ec437da_3` | 3 | AGENT | protocol omission — never called `complete_task` (`<<NOT_GIVEN>>`) | vanilla |
| `1b2bae9_1` | 3 | AGENT | host-clock leak via unspecified `download_to_file_path` default + unverified claim | vanilla |
| `e0fe09c_1` | 3 | AGENT | canonical-name substitution (`simple_note` for the derived `simplenote`) | vanilla |

### By mechanism

| mechanism | codemode | vanilla | shared | total |
|---|---|---|---|---|
| answer-discipline (`complete_task(answer=…)` on a null-answer task) | 2 | 1 | — | **3** |
| protocol omission (never called `complete_task`) | 0 | 2 † | — | **2** |
| world/host clock confusion | 0 | 1 | 1 | **2** |
| ignore-list asymmetry (cleanup on the graded side) | 1 | 0 | — | **1** |
| canonical-name substitution | 0 | 1 | — | **1** |
| task ambiguity / reference | — | — | 1 | **1** |
| shared, batch-2 (not re-derived here) | — | — | 2 | **2** |

† second instance is `34d9492_2` vanilla, identified from its `evaluation.json`
signature (`'<<not_given>>' == 'null'`, `status: null`) — **eval-level only, trace
not read**; treat as corroboration, not as an independent verified diagnosis.

### Pair-level counts over the full run directory

102 task ids currently have **both** `codemode__L0__a1` and `vanilla__L4__b1`
present (not 76 — the run dir has grown past the batch-3 kickoff). On those pairs:

| | codemode | vanilla |
|---|---|---|
| pass | 92 | 91 |
| fail | 10 | 11 |

Failure ledger over all 102 pairs: 6 shared, 4 codemode-only, 5 vanilla-only.
**Four are still untriaged** and are not counted in the mechanism table above:

- `0de03ad_1` — SHARED, 6/7 both, starred-thread check (`True == False`)
- `32616b5_3` — SHARED, 5/10 both, splitwise expenses: **both arms created expenses
  in 7 groups where the reference has 5** (extra groups 279, 280 in both) — looks
  task-scoped, worth a real trace read
- `4fab96f_2` — **CODEMODE-ONLY, 3/8**, the largest unexplained codemode gap in the
  corpus: reminders sent to 6 Venmo users where the reference expects 5 (extra
  `user_id 105`, 4 extra payment requests). Should be triaged next.
- `34d9492_2` — VANILLA-ONLY, 3/5, `stopReason: budget`; `<<NOT_GIVEN>>` as above

### What this batch changes

1. **Answer-discipline is arm-neutral, not a codemode weakness.** Batch 1 and
   `2e9b91e_2` made it look like an L0-residency artefact. `ac62177_2` is the
   control: vanilla, with the "if and only if" text resident in its schema on the
   deciding turn, still answered `"yes"` — because the instruction *opened* as a
   question. Residency selects which tasks trip it; it does not prevent it.
2. **Relative-time expressions are the largest un-instrumented hazard.** Three of
   the eleven verified failures (`277d81d_3` ×2 arms, `1b2bae9_1`) come from
   resolving "current year"/"today" against 2026 instead of the world's
   2023-05-18. `phone.get_current_date_and_time` returns it exactly, and was
   called in only 3 of the 14 runs in this batch.
3. **Vanilla's failure modes are not milder than codemode's** — 5 vanilla-only vs
   4 codemode-only across 102 pairs, and vanilla owns both `complete_task`
   omissions outright. The arms are at parity (92 vs 91) and the mechanisms
   differ rather than one arm being sloppier.
4. **One genuinely structural codemode advantage appeared** (`e0fe09c_1`): a
   literal extracted by regex reaches the API unmodified, while the same literal
   read as prose gets replaced by the entity's canonical name. That is a
   representation effect, not luck.

### n discipline

Every mechanism above is n=1 or n=2. None of these is a rate. The two with n=2
(answer-discipline as a class, `complete_task` omission in vanilla) are the only
candidates for a ratchet test; everything else is an existence proof pending
recurrence.
