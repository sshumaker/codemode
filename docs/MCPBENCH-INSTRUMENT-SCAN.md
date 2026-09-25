# MCP-Bench instrument scan: broken tools across the 1,005-run corpus

**Status: read-only survey. Nothing under `vendor/` was modified.** Companion to
`MCPBENCH-HF-ENCODING-DEFECT.md`, which diagnosed the `%2F` bug from one trace.
This is the bulk scan asked for after it.

## Headline

Six defect clusters found, **two of them new and one of them a second, independent
HuggingFace bug**. But the most important result is methodological:

> **The affected-versus-clean score comparison has the wrong sign, on every cluster.**
> Naively, `%2F`-affected runs score 5.60 against 6.26 clean (−0.66). Restricted to
> tasks that contain both, the delta is **+2.06, with affected scoring higher in
> 12 of 12 tasks.** The same reversal holds for all six clusters.

The mechanism is selection, not resilience: **being "affected" requires having
called the broken tool.** On HuggingFace tasks, runs that hit the bug produced a
median of **39** tool-result blobs; runs that did not hit it produced **4**. The
unaffected group is mostly runs that barely engaged — they score 2.61 against the
affected group's 4.80 *within the same tasks*.

So the defects are real and provable from source, but **"contamination cost N points"
is not derivable from this corpus in either direction.** The `5.35 vs 6.37` figure in
`MCPBENCH-HF-ENCODING-DEFECT.md` has this same flaw and should be withdrawn.

## Method, including a scanner bug worth recording

Scanned every `~/src/harness/.run/runs/*/stream.jsonl` (1,004 present of 1,005 dirs,
1.24 GB), joined to scores in `~/.lab/runs/mcp-bench/*.json` (838 joinable).

**The first scanner was wrong and produced a plausible number rather than an error.**
It understood only the claude-code stream shape (`tool_use` / `tool_result`) — which
is **12 of 1,004 runs**. The corpus is 771 codemode and 194 vanilla runs, both of
which use `tool_execution_end` with `result.content[].text` and
`result.details.stdout|stderr`. The broken scan reported 538 tool results total and
5 runs with `%2F`; the corrected one reports 26,446 and 157. A 5 would have read as
"the defect is rarer than thought" and been entirely an artifact of my parser.

Attribution is keyed on **the URL inside the error text**, not on tool name, because
tool naming differs per arm: `mcp__harness__<Server>__<tool>` (claude-code),
`<Server>__<tool>` (vanilla L4), `call_tool` (vanilla L1), `ipython` (codemode, with
the real call inside the cell).

## Cluster table

`runs` = runs where the signature appears. `naive Δ` = affected mean minus clean
mean. `within Δ` = mean over tasks containing both groups. **Only `within Δ` is
meaningful, and it says the comparison is confounded, not that the arm is fine.**

| cluster | runs | tasks | ours/upstream | naive Δ | within Δ | aff. lower |
|---|---|---|---|---|---|---|
| HF over-encoded `%2F` → 400/404 | **157** | 13 | **upstream** | −0.66 | **+2.06** | 0/12 |
| HF unfollowed **307 redirect** (new) | **60** | 7 | **upstream** | −1.56 | **+2.74** | 0/6 |
| Met Museum 403 | 34 | 7 | upstream/external | −0.74 | +2.51 | 0/6 |
| nixos 404 stale ES index (new) | 23 | 4 | **upstream** | −0.26 | +1.59 | 1/3 |
| HF 401 unauthorized | 14 | 5 | upstream/config | −1.74 | +0.33 | 2/5 |
| double-encoded `%252F` (new) | 11 | 4 | **needs a trace read** | −1.76 | +0.49 | 2/4 |

Failing-call volume by endpoint: `models/{id}` 638 calls across 70 runs,
`datasets/{id}` 164 / 47, `spaces/{id}` 142 / 33, `307 models/{id}` 83 / 33,
`nixos backend/{id}/_search` 75 / 23, `401 models/{id}` 34 / 11.

## The new defects

### 1. The HuggingFace client does not follow redirects — and this is the complement of the `%2F` bug

`huggingface-mcp-server/src/huggingface/server.py:32`:

```python
http_client = httpx.AsyncClient(timeout=30.0)
```

`httpx` defaults `follow_redirects=False`. HuggingFace answers `307` for bare
canonical ids, so every lookup of a slash-free id fails unfollowed. Observed on
`bert-base-uncased` (41 runs), `squad` (20), `distilbert-base-uncased` (15),
`sms_spam`, `imdb`, `ag_news`, `tweet_eval`, `glue`, `opus_books`.

**Taken together the two HF bugs close the space.** An id *with* a slash is
`quote_plus`-mangled to `%2F` → 400. An id *without* a slash gets a `307` that is
never followed. `get-model-info`, `get-dataset-info` and `get-space-info` therefore
fail for **every id of either shape** — a stronger statement than the `%2F`
writeup made, and it means the fix is two lines, not one: `quote(id, safe='/')`
*and* `follow_redirects=True`.

### 2. nixos ships hardcoded, versioned Elasticsearch index names

`mcp-nixos/mcp_nixos/server.py:206` posts to `{NIXOS_API}/{index}/_search`, where
`index` comes from a `BASE_CHANNELS` dict of literals like `latest-43-nixos-25.05`
(line 35). Those names are release-versioned upstream, so they expire; a 404 here
means the pinned index no longer exists. 23 runs, 4 tasks. Not fixable by us in any
durable way — it needs channel discovery rather than a literal.

### 3. Double-encoded `%252F` — the one I cannot attribute

11 runs, all codemode. `%252F` is `%2F` that has been encoded a second time, which
means *something encoded an already-encoded id*. That could be our compiled `api/`
bridge passing an escaped id into a server that escapes again, or the agent
pasting a URL-encoded id out of a prior error message and the server encoding it.
**This is the only cluster where I cannot separate ours from upstream from the
aggregate**, and it is the one worth a single trace read — it is the sole candidate
for a defect on our side of the seam.

## What is confined, and what is not a cluster

**The `quote_plus`-on-a-path bug is HuggingFace-only.** Static scan of all 28
vendored servers: `quote_plus` appears in exactly one file (the HF server, 8 call
sites). Two other servers import `quote`, which is correct. No other server
interpolates a raw id into a URL path — the f-string path matches elsewhere are all
`medcalc` explanation strings, not URLs. That is a clean negative and bounds the
blast radius of this bug class.

**The 434-run `error_no_status` bucket is not a defect cluster.** 1,625 blobs whose
first 800 characters contain an error word but no HTTP status and no URL. It mixes
codemode Python tracebacks, MCP schema-validation refusals and genuine server
errors. It is the residue my heuristic could not classify and **must not be quoted
as contamination.** Splitting it needs per-arm parsing of traceback shapes, which is
a separate job.

## Arm composition, recorded but explicitly not an arm claim

| cluster | codemode | vanilla | claude-code |
|---|---|---|---|
| `%2F` | 108 | 44 | 5 |
| 307 | 38 | 20 | 2 |
| Met 403 | 26 | 8 | 0 |
| nixos | 13 | 9 | 1 |
| 401 | 13 | 1 | 0 |
| `%252F` | 11 | 0 | 0 |

These track corpus composition (771 codemode / 194 vanilla / 12 claude-code) and the
engagement selection above. **No arm difference should be read from them.** The one
exception worth noting as a hypothesis only: `%252F` is 11/11 codemode, which is
consistent with the double-encoding originating on our side.

## What to do

1. **Withdraw the score-impact numbers**, here and in `MCPBENCH-HF-ENCODING-DEFECT.md`. The defects are provable from source; their cost is not measurable this way.
2. **Fix the HF server with both changes together** if it is fixed at all — `quote(id, safe='/')` plus `follow_redirects=True`. Fixing only the first leaves every bare id broken and would look like a partial fix that did not work.
3. **Read one `%252F` trace.** It is the only cluster that might be ours, and one trace settles it.
4. **The instrument-change decision is unchanged**: applying any of this splits the corpus into pre- and post-fix populations that cannot be pooled. Still Scott's call.
