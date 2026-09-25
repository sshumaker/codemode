# MCP-Bench defect: the HuggingFace server percent-encodes the slash in every id

**Status: diagnosed, fix written, NOT applied.** Applying it changes the instrument
mid-campaign and invalidates comparison with the 1,005 runs already in the corpus,
so it is Scott's call. Found 2026-08-31 while reading a failing trace that did not
fit the payload-collapse pattern.

## The bug

`vendor/mcp-bench/mcp_servers/huggingface-mcp-server/src/huggingface/server.py`
builds every object-lookup path with `quote_plus`:

```python
data = await make_hf_request(f"models/{quote_plus(model_id)}")     # line 290
data = await make_hf_request(f"datasets/{quote_plus(dataset_id)}") # line 367
data = await make_hf_request(f"spaces/{quote_plus(space_id)}")     # line 444
#                                                                   735, 737, 739, 805
```

`quote_plus` escapes `/` as `%2F`. Every HuggingFace id is `owner/name`, and the
API path must carry a literal slash:

```
quote_plus     -> dslim%2Fbert-base-NER    ->  400 Bad Request
quote safe="/" -> dslim/bert-base-NER      ->  what the HF API documents
```

So `get-model-info`, `get-dataset-info` and `get-space-info` **fail for every id
they will ever be given**. Observed verbatim in a trace:

```
Error retrieving model information: Client error '400 Bad Request' for url
  'https://huggingface.co/api/models/dslim%2Fbert-base-NER'
Error retrieving dataset information: Client error '400 Bad Request' for url
  'https://huggingface.co/api/datasets/eriktks%2Fconll2003'
Error retrieving space information: Client error '404 Not Found' for url
  'https://huggingface.co/api/spaces/course-demos%2Fbert-finetuned-ner'
```

## The fix

Eight `quote_plus` call sites. For path segments that must keep the slash:

```python
-from urllib.parse import quote_plus
+from urllib.parse import quote, quote_plus   # quote_plus stays for query strings
...
-        data = await make_hf_request(f"models/{quote_plus(model_id)}")
+        data = await make_hf_request(f"models/{quote(model_id, safe='/')}")
```

`quote_plus` is correct for *query* parameters and wrong for *path* segments; only
the path uses need changing. Each site must be checked individually rather than
sed-replaced.

## Why it is not applied

1. **It changes the instrument mid-campaign.** 1,005 runs exist under the buggy
   behaviour and 211 of them carry its marker. Fixing it splits the corpus
   into pre- and post-fix populations that cannot be pooled — the
   artifact-is-the-condition problem, at corpus scale.
2. **The file is untracked.** `vendor/mcp-bench` is not in git here, so a local
   edit would have no version trail — the same fragile state as the guard commits
   that were sitting on a detached HEAD.
3. A sweep was live when it was found.

## Scope, and the contamination estimate I am WITHDRAWING

211 of 1,005 run directories contain `%2F` (a second scan detecting only on result
text found 157; the difference is detection surface and changes nothing), spanning
at least 12 tasks and all three arms.

**The score-impact figures previously stated here — affected 5.35 vs clean 6.37 —
are withdrawn.** They are a selection artifact, and the selection is severe:

> **Being "affected" REQUIRES having called the broken tool.**

On HuggingFace tasks, runs containing `%2F` have a **median of 23 tool results**;
runs without it have a median of **ZERO** and score **1.00**, the no-tools floor.
The "clean" comparison group is largely runs that never engaged with the benchmark
at all. Restricted to tasks containing both groups, the sign **reverses**:

| | affected | clean | delta |
|---|---|---|---|
| HF tasks with both groups (7) | 4.62 | 2.28 | **+3.10 mean, affected higher in 6/7** |

`bank-scout` finds the same reversal on all six defect clusters it identified
(+2.06, +2.74, +2.51, +1.59, +0.33, +0.49). So `%2F` is a proxy for *engagement*,
and any affected-vs-clean contrast built on it measures engagement, not damage.

**The defect is provable from source. Its cost is not derivable from this corpus in
either direction.** That is the honest position, and it is weaker than the one this
document originally stated.

This is the same trap as the resilience claim below, one level up: I applied the
within-task check to the *arm* comparison and not to the affected-vs-clean
comparison that framed it.

## A second, complementary defect in the same server — the fix is TWO changes

`server.py:32` constructs the client as:

```python
http_client = httpx.AsyncClient(timeout=30.0)
```

`httpx` defaults to `follow_redirects=False`, and the HF API answers **307** for
bare canonical ids. So every id *without* a slash fails on an unfollowed redirect:
`bert-base-uncased` (41 runs), `squad` (20), `distilbert-base-uncased` (15), plus
`imdb`, `sms_spam`, `ag_news`, `tweet_eval`, `glue`, `opus_books`.

Combined with the `%2F` bug this is stronger than stated above:

> An id **with** a slash gets `%2F` → 400. An id **without** one gets an unfollowed
> 307. **The three lookup tools fail for every id of either shape.**

So the fix is two changes, not one:

```python
-http_client = httpx.AsyncClient(timeout=30.0)
+http_client = httpx.AsyncClient(timeout=30.0, follow_redirects=True)
...
-f"models/{quote_plus(model_id)}"
+f"models/{quote(model_id, safe='/')}"
```

**Shipping only the encoding fix would leave every bare id broken and look like a
fix that did not work.**

## The double-encoded `%252F` cluster is NOT ours — it is this bug teaching the agent

`bank-scout` flagged 11 runs (11/11 codemode) containing `%252F` as unattributed and
the only candidate for a defect on our side of the seam. **Resolved by reading one
trace, and it is upstream's, mediated by the agent.** All three defects appear in a
single tool result:

```
Redirect location: '/api/models/distilbert/distilbert-base-cased'      <- unfollowed 307
dslim%2Fdistilbert-NER OK                                              <- the AGENT's own label
Error retrieving model information: Client error '401 Unauthorized' for url
  'https://huggingface.co/api/models/dslim%252Fdistilbert-NER'         <- quote_plus applied twice
```

The middle line is the giveaway: the agent printed `dslim%2Fdistilbert-NER` as an
id. It had **read the percent-encoded form out of an earlier error message**,
concluded that was the identifier, and passed it back in — at which point
`quote_plus` escaped the `%` to `%25`, producing `%252F` and a 401.

So the cluster is a *second-order* effect of the same defect, and it carries a
design lesson beyond this server:

> **An error message that echoes a transformed input teaches the transformation.**

This project's doctrine is that the error channel is the only channel that reliably
corrects this model (L1, L19) — and the corollary, visible here, is that the error
channel teaches just as reliably when what it echoes is an internal representation
rather than the caller's own input. The HF server's error surfaces the *encoded*
URL, so the agent learned the encoded id. An error that quoted the id **as given**
would not have produced this cluster.

Practical consequence: fixing `quote_plus` removes this cluster too, and no fix is
needed on our side. It also means the `%252F` runs must not be counted as a separate
defect when estimating how much of the corpus is affected — they are the same bug
twice.

## Clean negative that bounds the blast radius

`quote_plus`-on-a-path is **HuggingFace-only**. A static scan of all 28 vendored
servers finds `quote_plus` in exactly one file (HF, 8 sites); two servers import
`quote`, which is correct; no other server interpolates a raw id into a URL path.
So this class of defect does not generalise across the benchmark's servers.

## Options

1. **Leave it and control for it** — exclude the 211 from arm comparisons, or
   report affected and clean populations separately. Costs nothing, keeps the
   corpus poolable, permanently caps what those 12 tasks can measure.
2. **Fix and re-run the 211.** Cleanest instrument, and the fix is eight lines.
   Costs a re-run and needs the vendored tree tracked so the patch has provenance
   (the `scripts/patches/` pattern already used for prime).
3. **Fix and do not re-run** — worst option: the corpus silently spans two
   instruments, which is how the L1-that-was-L4 mislabelling happened.

Recommendation: 1 now, 2 when the corpus is next refreshed for other reasons.
