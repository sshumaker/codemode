#!/usr/bin/env python3
"""Per-turn context growth, for every arm, from each arm's own artefacts.

    bench/terminal/context-growth.py <run-id> [<run-id> ...]

The endpoint the 3-arm long-horizon campaign turns on is not the total cost, it
is **how the resident context grows over a long run**. The transcript-bound arms
(vanilla tool-calling, claude-code) carry every tool result forward in the
message list; codemode holds state in the kernel and carries forward only what a
cell chose to print. On a task with hundreds of turns that difference compounds,
and it is invisible in a total.

Two arms, two artefacts, and neither can be read with the other's parser — the
mistake `prime_agent._accumulate` already made once, when it was written against
Claude Code's `tool_use` vocabulary and scored a healthy prime run
`toolCalls: 0`:

    prime (codemode/vanilla)   agent-logs/trajectory.jsonl   `message_end`
                               events, role=assistant, `usage`
    claude-code                sessions/agent.log            `--output-format
                               stream-json` lines, ANSI-escaped, inside the
                               asciinema-recorded pane

`ctx` for a turn is `input + cacheRead + cacheWrite` — the whole resident prompt
on the wire, not just the uncached part, because the question is how much context
the model is being handed, not what it was billed at.
"""

import json
from datetime import datetime
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / ".run" / "terminal-bench"

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def prime_turns(trial_dir: Path) -> list[dict]:
    """(ctx, cacheRead, cacheWrite, cost, t, tPrev) per assistant message.

    `tPrev` is the timestamp of the message immediately before this one — for a
    tool-using turn that is the tool result, so `t - tPrev` is the model round
    trip (prefill + generation) rather than the tool's own runtime. That is the
    only latency this artefact can attribute; the gap between *assistant*
    messages is dominated by whatever the tool did and says nothing about cache
    state.
    """
    traj = trial_dir / "agent-logs" / "trajectory.jsonl"
    if not traj.is_file():
        return []
    out, t_prev = [], None
    for line in traj.open():
        try:
            ev = json.loads(line)
        except Exception:
            continue
        if ev.get("type") != "message_end":
            continue
        msg = ev.get("message") or {}
        if msg.get("role") != "assistant":
            t_prev = ev.get("_t")
            continue
        u = msg.get("usage") or {}
        out.append({
            "ctx": (u.get("input") or 0) + (u.get("cacheRead") or 0)
                   + (u.get("cacheWrite") or 0),
            "cacheRead": u.get("cacheRead") or 0,
            "cacheWrite": u.get("cacheWrite") or 0,
            "output": u.get("output") or 0,
            "cost": float((u.get("cost") or {}).get("total") or 0),
            "t": ev.get("_t"),
            "tPrev": t_prev,
        })
        t_prev = ev.get("_t")
    return out


def cc_turns(trial_dir: Path) -> list[dict]:
    """Same, for claude-code, parsed out of the recorded pane.

    Upstream types claude-code into tmux, so its stream-json arrives interleaved
    with ANSI escapes. It is NOT hard-wrapped — `agent.log` is the byte stream,
    not the rendered pane — so a per-line JSON scan recovers it exactly. The
    pane (`panes/post-agent.txt`) IS wrapped at 160 columns and must not be used
    for this; de-wrapping it is what §2.1 of the scout doc gave up on.
    """
    log = trial_dir / "sessions" / "agent.log"
    if not log.is_file():
        return []
    raw = ANSI.sub("", log.read_bytes().decode("utf8", errors="replace"))
    out, final, seen, sources = [], None, set(), []
    t_prev = None

    def _ts(ev):
        s = ev.get("timestamp")
        if not isinstance(s, str):
            return None
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except Exception:
            return None

    for line in raw.splitlines():
        i = line.find('{"')
        if i < 0:
            continue
        try:
            ev = json.loads(line[i:].strip())
        except Exception:
            continue
        if ev.get("type") == "assistant":
            msg = ev.get("message") or {}
            # ONE EVENT PER CONTENT BLOCK, not per message. A message carrying
            # `thinking` + `tool_use` is emitted twice with byte-identical usage,
            # so a naive sum over events overcounts the resident context by ~60%
            # (537,757 vs the result event's authoritative 342,867 on
            # p1-cc-csv). Dedupe on the message id; the deduped count then equals
            # the run's own `num_turns`, which is the check that it is right.
            # Sources are collected from EVERY event, usage from the first only.
            # The two must not share the dedupe: a message split into a
            # `thinking` event and a `tool_use` event has its command on the
            # *second* one, so deduping before collecting silently dropped 8 of
            # 13 Bash calls on p1-cc-csv and reported `slp=0` for an arm nobody
            # had actually looked at.
            for part in msg.get("content") or []:
                if part.get("type") == "tool_use":
                    inp = part.get("input") or {}
                    src = inp.get("command") or inp.get("code")
                    if isinstance(src, str):
                        sources.append(src)
            mid = msg.get("id")
            if mid in seen:
                continue
            seen.add(mid)
            u = msg.get("usage") or {}
            out.append({
                "ctx": (u.get("input_tokens") or 0)
                       + (u.get("cache_read_input_tokens") or 0)
                       + (u.get("cache_creation_input_tokens") or 0),
                "cacheRead": u.get("cache_read_input_tokens") or 0,
                "cacheWrite": u.get("cache_creation_input_tokens") or 0,
                "t": _ts(ev),
                "tPrev": t_prev,
                # Per-message `output_tokens` here is a streaming partial (1, 3,
                # 16 …), NOT the message's output. Only the result event's total
                # is usable, so per-message output is deliberately not reported.
                "output": 0,
                "cost": None,          # cc prices the run as a whole, not per message
            })
            t_prev = _ts(ev)
        elif ev.get("type") == "user":
            # The tool result. This is the clock reference for the NEXT
            # assistant message's model round trip.
            t_prev = _ts(ev)
        elif ev.get("type") == "result":
            final = ev
    if final is not None and out:
        u = final.get("usage") or {}
        out[-1]["runCost"] = final.get("total_cost_usd") or final.get("costUSD")
        out[-1]["numTurns"] = final.get("num_turns")
        out[-1]["durationMs"] = final.get("duration_ms")
        out[-1]["runOutput"] = u.get("output_tokens")
    if out:
        out[0]["sources"] = sources
    return out


# Opus 5, $ per MTok. NOT remembered — solved from two runs that recorded their
# own cost, and both reproduce exactly:
#   p1-cc-csv:  27·I + 8,698·1.25I + 334,142·0.1I + 2,908·O = $0.2942685 recorded
#   prime's per-message breakdown: 5,212 cacheWrite -> $0.032575, 884 cacheRead
#   -> $0.000442, 86 output -> $0.00215
# claude-code does not price per message, so its re-warm cost has to be computed;
# deriving the table from an observed total is the only way to do that without
# quoting a number from memory into a result.
PRICE = {"input": 5.0, "output": 25.0, "cacheWrite": 6.25, "cacheRead": 0.50}

# A prompt-cache entry lives ~5 minutes. A turn whose prompt is mostly
# cache_creation rather than cache_read had to be re-prefilled at write price.
# The threshold is on the RATIO, not on a token count, so it means the same
# thing for a 6.5K codemode prompt and a 105K transcript prompt.
EXPIRY_WRITE_FRACTION = 0.5


def cache_events(turns: list[dict]) -> list[dict]:
    """Turns whose prompt was re-prefilled rather than read from cache.

    Turn 0 is excluded by construction: the first prompt is always a full write
    and counting it would hand every arm one free "expiry" whose size is just
    its ctx0 — which would make the arm with the biggest catalogue look worst
    for a reason that has nothing to do with waiting.
    """
    out = []
    for i, t in enumerate(turns):
        if i == 0:
            continue
        ctx, cw = t.get("ctx") or 0, t.get("cacheWrite") or 0
        if ctx and cw >= EXPIRY_WRITE_FRACTION * ctx:
            gap = None
            if t.get("t") is not None and turns[i - 1].get("t") is not None:
                gap = t["t"] - turns[i - 1]["t"]
            lat = None
            if t.get("t") is not None and t.get("tPrev") is not None:
                lat = t["t"] - t["tPrev"]
            out.append({
                "i": i, "ctx": ctx, "rewarm": cw, "cacheRead": t.get("cacheRead"),
                "gapBefore": gap, "modelLatency": lat,
            })
    return out


def trial_rows(run_id: str) -> list[dict]:
    run_dir = RUNS / run_id
    meta = run_dir / "run_metadata.json"
    agent = ""
    if meta.is_file():
        agent = (json.loads(meta.read_text()) or {}).get("agent_name") or ""
    rows = []
    for results in sorted(run_dir.glob("*/*/results.json")):
        trial = json.loads(results.read_text())
        d = results.parent
        turns = cc_turns(d) if agent == "claude-code" else prime_turns(d)
        log_p = d / "agent-logs" / "result.json"
        log = json.loads(log_p.read_text()) if log_p.is_file() else {}
        # Executed sources, per arm's own artefact. prime records them itself
        # (`cells`, now covering BOTH `ipython.code` and `bash.command`);
        # claude-code's are lifted out of its tool_use blocks above. The same
        # regexes are then applied to all three arms, so "arm X never blocked"
        # can never be an artefact of not having looked at arm X.
        sources = log.get("cells") or (turns[0].get("sources") if turns else []) or []
        wait = {
            "sleepCells": sum(1 for c in sources
                              if re.search(r"time\.sleep\(\s*(\d{2,}|[6-9])", c)
                              or re.search(r"(^|[;&|])\s*sleep\s+\d", c, re.M)),
            "bgCells": sum(1 for c in sources
                           if re.search(r"nohup|&\s*$", c, re.M)),
            "jobsCells": sum(1 for c in sources if re.search(r"\bjobs\.", c)),
            "nSources": len(sources),
        }
        cond_p = d / "agent-logs" / "condition.json"
        cond = json.loads(cond_p.read_text()) if cond_p.is_file() else {}
        arm = cond.get("arm") or agent
        if cond.get("jobs_runtime"):
            arm = f"{arm}/jobs={cond['jobs_runtime']}"
        cost = float(log.get("cost") or 0)
        if not cost and turns:
            cost = float(turns[-1].get("runCost") or 0)
        rows.append({
            "run": run_id, "task": trial.get("task_id"), "agent": agent,
            "arm": arm, "resolved": bool(trial.get("is_resolved")),
            "failureMode": trial.get("failure_mode"),
            "turns": log.get("turns") or (turns[-1].get("numTurns") if turns else 0)
                     or len(turns),
            "msgs": len(turns),
            "ctx0": turns[0]["ctx"] if turns else None,
            "ctxLast": turns[-1]["ctx"] if turns else None,
            "ctxMax": max((t["ctx"] for t in turns), default=None),
            "ctxSum": sum(t["ctx"] for t in turns) or None,
            "outSum": (turns[-1].get("runOutput") if turns and turns[-1].get("runOutput") else sum(t["output"] for t in turns)) or None,
            "cost": cost,
            "secs": log.get("seconds")
                    or (turns[-1].get("durationMs", 0) / 1000 if turns else None),
            "series": [t["ctx"] for t in turns],
            "expiry": cache_events(turns),
            # Median model round trip over the turns that were NOT re-prefilled,
            # as the baseline a wake turn is compared against.
            "warmLatency": _median([
                t["t"] - t["tPrev"] for i, t in enumerate(turns)
                if i and t.get("t") and t.get("tPrev")
                and (t.get("cacheWrite") or 0) < EXPIRY_WRITE_FRACTION * (t.get("ctx") or 1)
            ]),
            **wait,
        })
    return rows


def _median(xs: list[float]) -> float | None:
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    n = len(xs)
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def main(run_ids: list[str]) -> int:
    rows = [r for rid in run_ids for r in trial_rows(rid)]
    if not rows:
        print("no trials", file=sys.stderr)
        return 1
    w = max(len(r["task"] or "") for r in rows)
    a = max(len(r["arm"] or "") for r in rows)
    print(f"{'task'.ljust(w)}  {'arm'.ljust(a)}  {'res':4s} {'turns':>5} "
          f"{'msgs':>5} {'ctx0':>7} {'ctxLast':>8} {'ctxMax':>8} {'ctxSum':>10} "
          f"{'outSum':>7} {'cost':>7} {'secs':>7} {'src':>4} {'slp':>4} {'bg':>3} {'job':>4}")
    for r in rows:
        print(f"{(r['task'] or '').ljust(w)}  {(r['arm'] or '').ljust(a)}  "
              f"{'PASS' if r['resolved'] else 'fail':4s} "
              f"{r['turns']:>5} {r['msgs']:>5} "
              f"{str(r['ctx0']):>7} {str(r['ctxLast']):>8} {str(r['ctxMax']):>8} "
              f"{str(r['ctxSum']):>10} {str(r['outSum']):>7} "
              f"{r['cost']:>7.3f} {str(round(r['secs'] or 0)):>7} "
              f"{r['nSources']:>4} {r['sleepCells']:>4} {r['bgCells']:>3} "
              f"{r['jobsCells']:>4}")
    print()
    for r in rows:
        s = r["series"]
        if not s:
            continue
        # Deciles of the curve, so growth shape is visible without dumping it all.
        pts = [s[min(len(s) - 1, round(i * (len(s) - 1) / 9))] for i in range(10)]
        print(f"{r['task']} [{r['arm']}] n={len(s)}  "
              + " ".join(f"{p // 1000}k" for p in pts))

    # ---- prompt-cache expiry around long waits -------------------------------
    print()
    print(f"{'task'.ljust(w)}  {'arm'.ljust(a)}  {'exp':>3} {'rewarmTok':>10} "
          f"{'gross$':>7} {'extra$':>7} {'medGapBefore':>12} {'wakeLat':>8} "
          f"{'warmLat':>8}")
    for r in rows:
        ev = r["expiry"]
        tok = sum(e["rewarm"] for e in ev)
        gross = tok * PRICE["cacheWrite"] / 1e6
        # What the same tokens would have cost had the cache still been warm.
        # The DIFFERENCE is the price of the expiry; the gross figure alone
        # would charge the arm for context it must send either way.
        extra = tok * (PRICE["cacheWrite"] - PRICE["cacheRead"]) / 1e6
        gaps = _median([e["gapBefore"] for e in ev])
        wake = _median([e["modelLatency"] for e in ev])
        warm = r["warmLatency"]
        s_gap = f"{gaps:.0f}s" if gaps is not None else "—"
        s_wake = f"{wake:.1f}s" if wake is not None else "—"
        s_warm = f"{warm:.1f}s" if warm is not None else "—"
        print(f"{(r['task'] or '').ljust(w)}  {(r['arm'] or '').ljust(a)}  "
              f"{len(ev):>3} {tok:>10} {gross:>7.3f} {extra:>7.3f} "
              f"{s_gap:>12} {s_wake:>8} {s_warm:>8}")
    for r in rows:
        for e in r["expiry"]:
            print(f"    {r['task']} [{r['arm']}] turn {e['i']}: "
                  f"ctx {e['ctx']:,} rewarm {e['rewarm']:,} "
                  f"(cacheRead {e['cacheRead']:,}) "
                  f"gapBefore {e['gapBefore'] and round(e['gapBefore'])}s "
                  f"modelLatency {e['modelLatency'] and round(e['modelLatency'], 1)}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]) if len(sys.argv) > 1 else print(__doc__) or 2)
