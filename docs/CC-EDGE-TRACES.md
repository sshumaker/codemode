# CC-edge traces — the 7 hard-46 tasks where claude-code passed and codemode-L4 failed

Trace-first, paired-arm, classified, per `.claude/skills/diagnose-run-fail/SKILL.md`.
Every claim cites a cell or a logged call, not a grep over `evaluation.json`.

Tasks: `277d81d_3`, `92fe421_3`, `ce73d68_1`, `ce73d68_2`, `ce73d68_3`, `f3a6713_1`,
`f6f2e67_2`.

**Residency is equalised.** The primary contrast is codemode `L4__a1` (code, docs
resident, `preambleChars` 197,441) vs claude-code `L4__c1` (MCP tool-calling, docs
resident). vanilla `L4__b1` is the representation control. In addition, **12 codemode
configurations** exist per task (`L0__a1`, two verbatim repeats of it, eight
prompt/layout/gating/validation variants, and `L4__a1`), which turns each task into a small repeated-measures experiment and lets
us separate *mechanism* from *flake* without re-running anything.

---

## A0 — integrity, before any of it counts

All 100 runs across the 7 tasks (14 configurations each, 16 for `277d81d_3`): `stopReason: "completed"` (no budget stop, no timeout),
`apiCallsFailed: 0` everywhere except cc `f6f2e67_2` (1, a benign retry),
`toolErrors: 0`, `committedAnswer: {"answer": "null", "status": "success"}` in **every
single run** — so the over-answer bug from the previous triage fires on none of these
seven, and answer discipline is not in play here.

Two logging caveats, neither affecting the diagnoses (all of which rest on
`env-calls.jsonl`, the transport-level log):

1. `vanilla` `trajectory.jsonl` records streaming *partials* — the same assistant text
   appears ~20 times, growing by a few tokens each line. Cosmetic; `env-calls.jsonl` is
   unaffected.
2. **`277d81d_3` vanilla now passes.** `docs/CC-WINS-TRIAGE.md` recorded vanilla
   `277d81d_3` as a 5/6 FAIL that used the 2026 wall-clock year. The run currently on
   disk (`vanilla__L4__b1`, and `__bp-v2`) passes 6/6 with a `2022-12-31` cutoff. The
   run was replaced. The earlier document's conclusion for that task ("shared model
   failure, not arm-attributable") **no longer holds on the current data** — see §3.

---

## Scoreboard — outcome by task across all 14 configurations

`P` = pass, `.` = fail. codemode columns in order: `L0 r1 r2 bp-v2 gate-in gate-red
layout nav nav+lay+bp val val+cat L4`.

| task | codemode (12 configs) | vanilla L4 | cc L4 | verdict |
|---|---|---|---|---|
| `ce73d68_1` | `............` **0/12** | `.` | `P` | mechanism |
| `ce73d68_2` | `............` **0/12** | `.` | `P` | mechanism |
| `ce73d68_3` | `......P.....` **1/12** | `P` | `P` | mechanism |
| `92fe421_3` | `..........P.` **1/12** | `.` | `P` | mechanism |
| `277d81d_3` | `...PPP..PPP.` **6/12** | `P` | `P` | real, but already closed |
| `f3a6713_1` | `...PPP.PPP..` **6/12** | `P` | `P` | flake |
| `f6f2e67_2` | `..PP.P.P.P..` **5/12** | `P` | `P` | grader asymmetry + flake |

The three-way split is visible before reading a single cell: **the `ce73d68` family and
`92fe421_3` are deterministic codemode failures (2/48 configuration-runs pass); the
other three are coin-flips codemode wins about half the time.**

---

# Part 1 — The `ce73d68` family (priority)

> `_1` *"Reply "A gentle reminder." to everyone who has not replied in more than 48
> hours of sending the email. I have already done it for a few emails, so skip them."*
> `_2` — same, 72 hours, *"A polite reminder."*   `_3` — same, 96 hours.

### 1. The exact failed check — identical in all three variants

```
assert none of the updated gmail.UserEmailThread have been updated in any field
using models.changed_field_names (ignore=email_ids, updated_at).
----------
AssertionError:  {'recipient_email_addresses', 'recipient_names', 'incoming'} == set()
In left but not right: ['recipient_email_addresses', 'recipient_names', 'incoming']
```

```
assert that recipient_ids of the first and second email of all
of user_email_threads is the same.
----------
AssertionError:  False == True
```

Left is actual. Both checks say the same thing: **the reply that was added to the
thread went to a different party than the original email did**, and it flipped the
thread's `incoming` flag.

### 2. codemode's decisive cell — `ce73d68_1__codemode__L4__a1`, cell 6

```python
r1 = await api.gmail.reply_to_email(body="A gentle reminder.", email_thread_id=47826, email_id=20870, access_token=gt)
r2 = await api.gmail.reply_to_email(body="A gentle reminder.", email_thread_id=47822, email_id=20868, access_token=gt)
print(r1, r2)
print(await api.supervisor.complete_task(status="success"))
```

```
{"message": "Reply email sent.", "sent_email_id": 20887}
{"message": "Reply email sent.", "sent_email_id": 20888}
{"message": "Marked the active task complete."}
```

### 3. cc at the same decision point — `ce73d68_1__claude-code__L4__c1`

```
POST /gmail/email_threads/47822/emails/20868/reply
     {"body": "A gentle reminder.", "email_addresses": ["cheweber@gmail.com"]}
POST /gmail/email_threads/47826/emails/20870/reply
     {"body": "A gentle reminder.", "email_addresses": ["brandon-webe@gmail.com"]}
```

**Same two threads. Same two email ids. One extra argument.**

### The trap, in the API's own docstring

`ce73d68_1__codemode__L4__a1/api/gmail/reply_to_email.py`:

```python
async def reply_to_email(body: str, email_thread_id: int, email_id: int, access_token: str,
                         email_addresses: list[str] | None = None, ...) -> Any:
    """Reply to an existing email in a thread.
    ...
        email_addresses: List of recipient email addresses. If passed, it'll reply to all
        recipients in the list, otherwise, to the sender. Optional.
```

Every thread here is an **outbox** thread. The sender of the email being replied to is
the user. So "otherwise, to the sender" means *reply to yourself* — the thread gains an
email addressed to Andrew Brown, `incoming` flips true, and both graded checks fire.

The inference needed is two steps: *default → sender*, and *sender of my own sent
email → me*. No codemode run in 36 performed it.

### 4. The natural experiment — 42 runs, 42/42 concordance

For each of the 3 variants × 14 runs, whether `email_addresses` was supplied predicts
the outcome **perfectly**:

| | supplied `email_addresses` | outcome |
|---|---|---|
| cc, all 3 variants | **3/3** | 3/3 PASS |
| vanilla, all 3 variants | **1/3** (`_3` only) | 1/3 PASS (`_3`) |
| codemode, 12 configs × 3 variants | **1/36** (`_3` layout-consolidated) | 1/36 PASS (`_3` layout-consolidated) |

**42 runs, zero exceptions in either direction.** Every run that supplied the argument
passed; every run that omitted it failed. Nothing else about these runs mattered — not
residency (codemode L4 has the docstring resident and fails identically to L0), not
prompt version, not layout, not runtime argument validation (`val` fails: the argument
is *optional*, so omitting it is valid).

The hard part of the task — the 48/72/96-hour window, "skip those who replied", "skip
those already reminded" — was solved **identically by every arm**. All three arms picked
`(47826, 47822)` on `_1`, `(47822, 47828)` on `_2`, `(47822, 47820)` on `_3`.

### The positive control: the one codemode run that passed

`ce73d68_3__codemode__L0__a1__layout-consolidated`, final cell:

```python
for tid,eid in [(47822,20868),(47820,20867)]:
    t=[x for x in threads if x["email_thread_id"]==tid][0]
    rec=[r["email"] for r in t["emails"][0]["recipients"]]
    print(rec, json.loads(await api.gmail.reply_to_email(body="A gentle reminder.", email_thread_id=tid, email_id=eid, access_token=gt, email_addresses=rec)))
```

It reached back into the live `threads` objects for `recipients`, **printed the
recipient list next to the call**, and passed it explicitly.

Contrast with the 35 failing mutation cells. A representative sample (full sweep in
"Evidence" below):

```python
# _1 L0__a1, gate-inline, nav, val+cat, L4 …
for tid, eid in [(47826,20870),(47822,20868)]:
    print(await api.gmail.reply_to_email(body="A gentle reminder.", email_thread_id=tid, email_id=eid, access_token=gt))

# _2 r1 — this one DOES look the id up from live data, and still omits the recipient
for tid in [47822, 47828]:
    d = [x for x in details if x['email_thread_id']==tid][0]
    eid = d['emails'][0]['email_id']
    r = await api.gmail.reply_to_email(body="A polite reminder.", email_thread_id=tid, email_id=eid, access_token=gt)
```

That last one is important and it narrows the mechanism. "codemode hard-codes literals
copied from a printout" is *partly* true — 27 of 36 mutation cells paste literal ids —
but three runs did index back into the live objects and still omitted `email_addresses`.
So the mechanism is not "lost the data". It is narrower:

> **The addressee was never modelled as a decision.** The agent's representation of the
> action was `reply(thread, email)`; *who receives it* was assumed to follow from the
> thread. `recipients` was on screen in every run — codemode L4 printed a full thread
> dump in cell 3 showing `"recipients": [{"name": "Jamie Solomon", ...}]` — and was
> simply not treated as a parameter of the act.

### 5. Mechanism class and fixability

**AGENT — default-argument redirection at a mutation site.** Not residency (L4 fails
identically), not representation (vanilla omits it 2/3, and the one codemode config that
supplies it passes), not grader (both checks are correct: a reply to your own sent email
really did go to the wrong person), not flake (0/12, 0/12, 1/12).

Is it cc-specific behaviour or luck? Honestly: **n=3 for cc.** Three supplies out of
three is consistent with a strong propensity and also with a 70%-propensity arm getting
lucky. What is *not* luck is the codemode side: **1/36 is a stable, near-deterministic
weakness**, and it is the thing worth fixing regardless of how cc's 3/3 is explained.

**Fixable in codemode — yes, three ways, in increasing order of generality:**

1. **Affordance (narrow, certain).** `reply_to_email`'s default is a footgun for outbox
   threads specifically. Either drop the default in the generated wrapper (make
   `email_addresses` required) or add a one-line warning to the docstring. This fits the
   reference perfectly and costs nothing — but it is *fitting to one API*, and there are
   469 tools.
2. **Prompt (general, uncertain).** A "name the target" line in the base preamble: *when
   a call mutates the world, every argument that determines **who or what** is affected
   must be supplied explicitly and printed, never left to a default.* This is the same
   family as the `drafts[:3]` finding in `CC-WINS-TRIAGE.md` §Task 4 — commit on named
   values, not on defaults or indices — and generalises to both.
3. **Verification (general, diagnostic).** codemode made **zero** post-write reads on
   all three `ce73d68` variants. cc re-read both threads after replying
   (`GET /gmail/email_threads/47822`, `47826`). That re-read is exactly the check that
   would have exposed this bug: `incoming` had flipped and the new email was addressed
   to the user. See §Part 3.

---

# Part 2 — the other four, one by one

## `92fe421_3` — the second deterministic failure (codemode 1/12)

> *"My roommates and I share amazon prime, which I just paid for yesterday. Request the
> money for it from them on venmo assuming equal share among all, with a description
> note, "Amazon Prime Subscription". Skip the one/s who have already paid me for it."*

### 1. Failed check

```
assert amount from added_payment_requests match private_data.individual_share (tolerance=0.51)
----------
AssertionError:  35.0 ± 0.51 == 46.67 ± 0.51
```

Left = actual. codemode requested $35.00; expected $46.67. Prime cost $140.00.
$140/4 = $35 (user + 3 roommates); $140/3 = $46.67 (the 3 roommates).

### 2. codemode's decisive cells (`L4__a1`)

Cell 3 — it fetched the disconfirming evidence itself and printed it in full:

```python
for e in ['chris.mcco@gmail.com','joseharr@gmail.com','lindseysimpson@gmail.com']:
    print(e, await api.venmo.show_transactions(access_token=vn, user_email=e, direction="received", page_limit=20))
```

```
chris.mcco@gmail.com [{ "transaction_id": 8216,
  "amount": 46.67,
  "description": "Amazon Prime Subscription",
  "created_at": "2023-05-17T13:11:41",
  "sender": {"name": "Chris Mccoy", ...}, "receiver": {"name": "Paul Miller", ...} }]
```

Cell 5, two cells later:

```python
amt=round(140/4,2)
for e in ['joseharr@gmail.com','lindseysimpson@gmail.com']:
    print(await api.venmo.create_payment_request(user_email=e, amount=amt, access_token=vn, description="Amazon Prime Subscription"))
print(await api.supervisor.complete_task(status="success"))
```

It used Chris's transaction **only to decide whom to skip**, and never as information
about the amount — despite the transaction carrying the exact description string the
task asks it to reproduce.

### 3. cc at the same decision point

cc's *first* hypothesis was identical to codemode's:

> **SAY:** "Prime paid yesterday: $140.00, split 4 ways (me + 3 roommates) = $35 each.
> Now checking who already paid."

Then two extra grounding moves —

> **SAY:** "Let me search specifically for prime-related payments from each roommate."
> **SAY:** "Let me check for additional context about the split."

— and the revision:

> **SAY:** "Chris Mccoy already sent **$46.67** yesterday with the description "Amazon
> Prime Subscription" — exactly $140/3, confirming the per-person share in this
> household. So I'll request $46.67 from the two roommates who haven't paid."

```
POST /venmo/payment_requests {"user_email": "joseharr@gmail.com", "amount": 46.67, "description": "Amazon Prime Subscription"}
POST /venmo/payment_requests {"user_email": "lindseysimpson@gmail.com", "amount": 46.67, "description": "Amazon Prime Subscription"}
```

### 4. Class — **AGENT: a fetched datum used for one purpose and not the other**

Not residency, not representation. **All 14 runs fetched the $46.67 record**
(`saw_46.67_evidence=True` in every one); 12 of 14 committed $35 anyway:

| arm | requested 46.67 | passed |
|---|---|---|
| cc | 1/1 | 1/1 |
| vanilla L4 | 0/1 | 0/1 |
| codemode, 12 configs | **1/12** (`val__cat`) | 1/12 |

The codemode run that passed made the quantity visible before spending it:

```python
amt=round(140/3,2); print(amt)
```

The interesting thing here is that **cc's prior was wrong and it recovered.** This is
not "cc reasons better about shares". It is: cc kept looking after forming an answer,
and treated an observed precedent as a constraint on a value it had already computed.
codemode formed the same prior, held the disconfirming datum in the same context window,
and committed.

**Fixable in codemode:** partially, and only via prompt. A line of the form *"before
committing a computed quantity, check whether the world already contains an instance of
it"* is cheap and testable, but it is a heuristic, not a mechanism-closer. Expected
value: real but modest, and it **must** be measured — the prior triage's fix #1 is a
better-founded change than this one.

---

## `277d81d_3` — grounding; real, but closed by the newer configs (codemode 6/12)

> *"Mark everything in my Gmail inbox and outbox before the current calendar year as read."*

### 1. Failed check

```
assert set of updated threads' ids match the set of private_data.to_mark_thread_ids.
AssertionError: {…83 ids…} == {…17 ids…}
In left but not right: [66 ids]
```

### 2. codemode's decisive cells (`L4__a1`) — including a **vacuous** verification

```python
inb  = await all_pages(api.gmail.show_inbox_threads,  access_token=tok, max_created_at="2025-12-31", read=False)
outb = await all_pages(api.gmail.show_outbox_threads, access_token=tok, max_created_at="2025-12-31", read=False)
print(len(inb), len(outb))    # 79 9
```

```python
ids = {t["email_thread_id"] for t in inb+outb}
r = await asyncio.gather(*[api.gmail.mark_thread_read(email_thread_id=i, access_token=tok) for i in ids])
print(len(ids), r[:2])        # 83
chk  = await all_pages(api.gmail.show_inbox_threads,  access_token=tok, max_created_at="2025-12-31", read=False)
chk2 = await all_pages(api.gmail.show_outbox_threads, access_token=tok, max_created_at="2025-12-31", read=False)
print(len(chk), len(chk2))    # 0 0
```

The in-world date is 2023-05-18; the first row it printed reads
`'created_at': '2023-05-17T16:25:52'`. It **did** verify — and the verification
re-used the same wrong bound, so it returned `0 0` and confirmed nothing. This is the
canonical CLAUDE.md failure ("prime's own verification was vacuous").

### 3. cc at the same decision point

```
GET /phone/date_time  → {"date":"Friday, May 19, 2023", ...}
GET /gmail/email_threads/category/inbox?max_created_at=2022-12-31&read=false
```

cc calls the phone clock on both of its runs here; **no codemode configuration calls it
on this task at all** (0/12), including the six that pass — those get to `2022-12-31`
by reading `created_at: 2023-…` off the listing and inferring.

### 4. Class — **AGENT: environment grounding. Already addressed by the shipped changes.**

6 of 12 codemode configs pass, and the split is not random: the six passers are exactly
the six *newer* configurations (`bp-v2`, `gate-inline`, `gate-redirect`,
`nav+layout+bp-v2`, `val`, `val+cat`); the six failures are the plain-`a1` lineage
(`L0__a1`, its two repeats, `layout-consolidated`, `nav`, and `L4__a1`). vanilla now
passes too.

Note that `val` and `val+cat` pass while still fetching with a 2025 bound — they filter
afterwards, in memory, against the right year:

```python
inb = await all_pages(api.gmail.show_inbox_threads, access_token=tok, read=False, max_created_at="2025-12-31 23:59:59")
...
ids = {t["email_thread_id"] for t in inb+out if t["created_at"] < "2023-01-01"}
```

So the discriminator is not the query bound but whether the year was ever written down.
Same shape as M1 and `drafts[:3]`: the passing runs name the value.

This task is **not evidence of a live cc edge** — it is evidence that prompt v2 worked.
Note the correction to `CC-WINS-TRIAGE.md` §Task 3 in A0 above: that document classified
this as a shared model failure that exonerated both dials, on the strength of a vanilla
run that has since been replaced by a passing one.

---

## `f3a6713_1` — flake, with a real underspecification underneath (codemode 6/12)

> *"…I had sent out a checklist of things needed for the trip… See who has committed to
> bring what, and place an order on Amazon for the remaining items. Given the available
> choices pick the highest rated ones."*

### 1. Failed checks (three, all the same cause)

```
{'backpack', 'sleeping pad', 'board game'} == {'backpack', 'sleeping pad'}
In left but not right: ['board game']
```

### 2. codemode's decisive move — and it is *invisible*

The checklist, read in cell 5:

```
- 1 quantity of snorkel mask   - 1 hammock   - 2 quantity of board game
- 1 camping chair              - 1 hiking boots  - 1 beach chair
- 2 quantity of sleeping pad   - 1 backpack

Nancy Ritter  | I can bring snorkel mask, hammock.
Gina Burch    | I will bring board game, camping chair.
Sandra Martinez | I will bring hiking boots, beach chair.
```

Cell 6 goes straight to shopping:

```python
for q in ["board game","sleeping pad","backpack"]:
    r=json.loads(await api.amazon.search_product_types(query=q,page_limit=20))
```

**There is no cell that computes the remainder.** The subtraction "2 board games needed
− Gina brings 1 = 1 outstanding" happened in the model's head, was never printed, and
was therefore never checkable. It then ordered `product_id=2318` (Codenames, 4.4).

### 3. cc and vanilla at the same point

Both read a commitment as covering the whole line item, not one unit:

> **cc SAY:** "**Remaining items (nobody committed) — ordered on Amazon (order #3146,
> $394.90):** 2× Therm-a-Rest ProLite Plus Sleeping Pad … 1× REI Co-op Ruckpack 40 Pack"

> **vanilla SAY:** "Remaining items: 2 sleeping pads and 1 backpack."

### 4. Class — **(e) semantic underspecification; predominantly FLAKE**

The reference agrees with cc and vanilla, but the quantity reading is genuinely
ambiguous and codemode gets it right most of the time:

| codemode config | ordered a board game? |
|---|---|
| `L0__a1`, `val+cat`, `L4__a1` | **yes** (3/12) |
| the other 9 | no |

codemode passes this task 6/12 overall; the three board-game runs plus three unrelated
failures (`r1`, `r2`, `layout-consolidated` fail for other reasons). **A 50% coin, and
cc won its single toss.** Not a mechanism. n=1 for cc.

The one *structural* observation worth keeping: the decisive arithmetic never appeared
in a cell. That is the same shape as `drafts[:3]` — a decision the code embodies without
naming — and it is the strongest recurring code-side hygiene finding in the corpus.

---

## `f6f2e67_2` — grader asymmetry (codemode 5/12)

> *"…Add all photos to it from "~/photographs/childhood_pics/"… and send a new email to
> both my parents with the subject "Childhood Memories"…"*

### 1. Failed check — 16/17, one failure

```
assert all added files (except the compressed file ending in .public_data.attachment_extension)
have content that is present in private_data.expected_file_name_to_content's values.
----------
AssertionError: The left modifier is 'all' with allow_left_empty=False, but left operand is empty.
```

The left operand is empty because **codemode added no files other than the tar.** The
check does not test correctness of what was added; it fails on the *absence* of leftover
artifacts.

### 2. codemode's decisive cell (`L4__a1`, cell 9)

Everything before it is right — it downloaded the tar, decompressed it, copied all six
photos in, and emailed both parents. Then:

```python
print(await api.file_system.compress_directory(directory_path="/home/erica/downloads/childhood_pics", access_token=fs, compressed_file_path="/home/erica/downloads/childhood_pics.tar", delete_directory=True, overwrite=True))
```

`delete_directory=True` — it tidied up the staging directory it had created.

### 3. cc at the same decision point

```
POST /file_system/compressed_files  (no delete_directory)
```

cc simply left the extracted directory on disk.

### 4. Class — **GRADER asymmetry, 14/14 concordance**

| behaviour | runs | outcome |
|---|---|---|
| deleted the extraction dir (via `delete_directory=True` or an explicit delete) | 6 codemode | **6/6 FAIL** |
| left it | 6 codemode, vanilla, cc | **8/8 PASS** |

Perfect concordance across 14 runs, and the discriminating behaviour is *cleaning up
after yourself*. The reference solution decompresses, copies, re-compresses and leaves
the extraction behind; `allow_left_empty=False` promotes that byproduct to a
requirement. This is the mirror of the `9871968_1` wishlist trap and of `6d59d90_3`'s
cart cleanup — same class, third instance.

**Do not fix.** Teaching codemode to leave litter is fitting the reference
implementation, not the task, and it contradicts the base prompt's collateral-damage
rule. cc's win here is that it happens not to tidy up. Log it as benchmark noise.

---

# Part 3 — cc-side behaviours, counted across all 7

| behaviour | codemode L4 | vanilla L4 | claude-code L4 |
|---|---|---|---|
| calls `phone.get_current_date_and_time` | 4/7 | 7/7 | 5/7 |
| any read of world state after the last mutating write | **1/7** | **1/7** | **4/7** |
| non-supervisor reads issued after the last write | 2 | 2 | 8 |
| supplies the recipient argument on `reply_to_email` | 0/3 | 1/3 | 3/3 |
| uses observed precedent to revise a computed amount | 0/1 | 0/1 | 1/1 |
| API calls / task (mean) | 42.7 | 21.0 | 24.6 |

Two of these are worth stating carefully.

**Read-after-write is the one large, direction-stable gap, and on this sample it is
load-bearing rather than merely diagnostic.** The previous triage found (correctly) that
verifying does not *correlate* with passing, because agents verify when tasks are hard.
But on `ce73d68` the connection is mechanical, not correlational: cc's post-write
re-read was `GET /gmail/email_threads/47822` and `/47826` — a query whose response
contains `incoming` and the new email's `recipients`, i.e. **precisely the two fields
the grader checks**. codemode issued no post-write read on any of the three variants. It
would not have needed a better prior to catch this; it needed to look.

**Environment grounding does not separate the arms here.** cc calls the phone clock
5/7, vanilla 7/7, codemode 4/7. On `277d81d_3` — the one task where the clock is
decisive — cc calls it and codemode never does, but six codemode configs pass anyway by
reading dates off the listing. Do not over-read the corpus-wide 17/20/28 propensity gap;
it is not what is separating the arms on this sample.

**Not observed at all:** cc issued **38 tool calls across the 7 tasks and every one was
`mcp__appworld__*`** — no `Read`, no `Bash`, no TodoWrite, no subagents, no skills — and
no compaction fired. Mean cost/task over the 7: **cc $0.98, vanilla L4 $0.81, codemode
L4 $0.81, codemode L0 $0.23.** cc is the most expensive arm on this sample, as on every
other.

---

# Synthesis

### (a) codemode-side mechanisms — 4 of 7 tasks, and it is **two** mechanisms

| # | mechanism | tasks | codemode rate | class |
|---|---|---|---|---|
| M1 | **Left an optional argument that redirects the effect of a mutating call to its default** | `ce73d68_1/_2/_3` | **1/36** | AGENT, fixable |
| M2 | **Committed a computed quantity without checking it against a matching observation already fetched** | `92fe421_3` | **1/12** | AGENT, partly fixable |
| M3 | Used the wall-clock year instead of the in-world date | `277d81d_3` | 6/12 | AGENT — **already closed**: all 6 newer configs pass |

M1 is the finding. It is a *family*, it is near-deterministic (1/36), and it is
invariant to every dial we have turned: residency, prompt version, API layout, docs
gating, catalogue enrichment, and runtime argument validation all leave it untouched.
Three of the seven discordant tasks are one bug with a one-argument cause.

M1 and M3 share a shape worth naming, because it also covers `drafts[:3]` from the
previous triage: **the decisive quantity is never written down.** The passing runs in
each case are the ones that made it visible — `print(rec, …)`, `amt=round(140/3,2);
print(amt)`, an explicit `2022-12-31` — and the failing runs are the ones where the
value stayed implicit in a default, a slice, or an unstated assumption. Code makes it
easy to act without ever naming what you are acting on.

### (b) cc-side positive behaviours, named with counts

1. **Re-reads world state after its last write — 4/7 vs 1/7 for both prime arms.** On
   `ce73d68` (3 tasks) the re-read targets the exact fields the grader checks. This is
   the single most portable behaviour on the list.
2. **Supplies the addressee explicitly on a reply — 3/3** where codemode is 1/36 and
   vanilla 1/3.
3. **Keeps investigating after forming an answer, and revises — 1/1** (`92fe421_3`:
   stated $35, ran two more searches, revised to $46.67). It is one instance, but it is
   a *documented* instance, in cc's own words, of a prior being overturned by evidence
   both other arms held and ignored.
4. **Writes the predicate in prose before acting** — "cutoff for >48h: sent before
   2023-05-17 14:51", "cutoff = sent before 2023-05-15 12:05 PM", "current time
   2023-05-19 16:55, cutoff 2023-05-16 16:55" — on all 3 `ce73d68` variants plus
   `277d81d_3`. Note this did *not* discriminate: codemode also got every window right.

Honest limit on all four: **n=7 tasks, one cc run each.** These are existence proofs of
behaviours, not rates. The codemode-side rates (1/36, 1/12) are the well-powered
numbers, because 12 configurations per task supply the repetition.

### (c) luck and grader defects — 3 of 7

| task | why cc won |
|---|---|
| `f6f2e67_2` | cc did not clean up its staging directory; the grader requires the litter. 14/14 concordance on that behaviour alone. GRADER. |
| `f3a6713_1` | a ~50% coin on whether "I'll bring board game" covers 2 units. codemode wins it 9/12 on the item and 6/12 overall. FLAKE. |
| `277d81d_3` | real mechanism, but **already closed** — all six newer codemode configs pass, as does vanilla. STALE. |

### The honest decomposition of the 7

**2 mechanisms worth acting on (4 tasks: the ce73d68 family + 92fe421_3), 1 mechanism
already fixed (277d81d_3), 1 grader defect (f6f2e67_2), 1 flake (f3a6713_1).**

So the headline "cc 65.2% vs codemode-L4 52.2%" is, on the discordant cells,
**dominated by a single optional keyword argument.** Fixing M1 alone moves 3 of the 7.

---

## Top 2 fixes, ranked by expected value

**1. Make "who/what does this act on?" an explicit, printed decision at every mutating
call. — highest EV by a wide margin.**

Three of seven discordant tasks, 35 of 36 runs, invariant to every dial already tried.
Two implementations, and they should be measured separately:

- *(a) Affordance, narrow and near-certain.* Make `email_addresses` non-defaulting in
  the generated `reply_to_email` wrapper, or attach a warning to the docstring for
  optional arguments whose default silently redirects an effect. Certain to fix
  `ce73d68`; fixes nothing else, and there are 469 tools.
- *(b) Prompt, general and uncertain.* One line in the shared base preamble (both prime
  arms — level up, not down): *"Before a call that changes the world, write down the
  target of the change and pass it explicitly. Never let a default decide who or what is
  affected, and never select rows by index where a predicate is meant."* This subsumes
  the `drafts[:3]` hygiene item from the previous triage.

Prefer (b), measured, with (a) held in reserve — (a) is reference-fitting dressed as an
affordance, and the 469-tool surface makes it unscalable. Track a new counter
(`mutating calls with all identity-bearing arguments supplied`) so the fix is verified
on the *observable behaviour*, not on the score. **A documented check is not an executed
check.**

**2. Postcondition re-read that is independent of the filter used to act. — second, and
this sample upgrades it from "diagnostic" to "load-bearing".**

`CC-WINS-TRIAGE.md` ranked this #5 and mostly diagnostic, on the correct observation
that verification anti-correlates with passing. This sample sharpens it: codemode did
**zero** post-write reads on all three `ce73d68` variants, and the read cc did make
returns the exact two fields the grader checks. Meanwhile `277d81d_3` shows the failure
mode to guard against — codemode *did* re-query and got `0 0` because it reused the same
wrong bound.

So the prompt line must specify **independence**, not just presence:

> After your last write, re-read the affected objects and check the postcondition using
> a query you did not use to select them. If your verification query is your selection
> query, it cannot fail.

Expected value: moderate on score, high on diagnosability. Measure `postWriteReads` and
`postWriteReadsIndependent` separately.

**Explicitly not recommended:** anything that would make codemode leave staging
directories behind (`f6f2e67_2`), or any nudge on board-game quantity semantics
(`f3a6713_1`). Both are reference-fitting.

---

## n-statement

- **7 tasks, chosen because cc passed and codemode-L4 failed.** Conditioning on that and
  then asking why cc won can only generate hypotheses. Nothing here is a head-to-head
  rate, and the sampling correction in `CC-WINS-TRIAGE.md` §Synthesis still stands.
- **What is well-powered is the codemode side.** 12 configurations per task is a genuine
  repeated measure: 1/36 on M1 and 1/12 on M2 are rates within one arm, undistorted by
  the selection (which was on codemode's *outcome*, and these are configurations of
  codemode that all shared that outcome — see caveat below).
- **Caveat on that claim.** The 12 configurations are not independent samples: same
  model, same task, same seed world, and the tasks were selected into the hard-46
  because `L0__a1` failed. What they *do* establish is invariance to the design dials —
  M1 survives every prompt, layout, gating, validation and residency setting we have —
  which is the property the fix ranking rests on.
- **cc's side is n=1 per task.** "cc supplies `email_addresses` 3/3" is an existence
  proof of a propensity, not a measured rate. Do not quote it as one.
- **42/42 and 14/14 concordance are facts about these runs**, not population estimates.
  They are strong because they are two-sided (no run supplied the argument and failed,
  and none omitted it and passed), which rules out the behaviour being incidental.
- **The only pre-registered next experiment that would settle M1** is: apply fix 1(b) to
  the shared base prompt, then re-run the `ce73d68` family plus a *seeded sample drawn
  before anyone looks at scores*, tracking the argument-supply counter and the score
  separately.
- **Opus 5 only, AppWorld only, 7–15 turn tasks.** As with everything else in this repo.

---

## Evidence

All quotes are re-derivable from `.run/appworld/<task>__<arm>__<variant>__anthropic-claude-opus-5/`:

- codemode cells: `stream.jsonl` → `tool_execution_start.args.code`, outputs in
  `tool_execution_end.result.details.stdout`
- cc / vanilla calls: `env-calls.jsonl` (full args + responses), assistant text in
  `trajectory.jsonl`
- failed checks: `evaluation.json` → `report.failures[].trace`
- API docstrings as codemode saw them: `<rundir>/api/gmail/reply_to_email.py`

The two concordance sweeps, reproducible in one command each:

```bash
# ce73d68 family: email_addresses supplied vs outcome, 42 runs
python3 - <<'PY'
import json,glob
for t in ["ce73d68_1","ce73d68_2","ce73d68_3"]:
    for d in sorted(glob.glob(f".run/appworld/{t}__*")):
        s=json.load(open(f"{d}/result.json"))['summary']
        sup=[('email_addresses' in (json.loads(l).get('args') or {}) and (json.loads(l).get('args') or {}).get('email_addresses'))
             for l in open(f"{d}/env-calls.jsonl") if 'reply' in l]
        print(d.split('/')[-1], 'PASS' if s['success'] else 'FAIL', all(sup) if sup else None)
PY

# f6f2e67_2: cleanup vs outcome, 14 runs — grep delete_directory in env-calls.jsonl
```
