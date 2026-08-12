"""
Record every HTTP request AND response AppWorld makes, at the transport itself.

`install(record, clock)` wraps `Requester._get/_post/_put/_patch/_delete` — the five
methods every app call funnels through (requester.py:566 onward, each of which
already calls `request_tracker.add_request`). Same technique as
bench/tac/judge-trace.py wrapping `common.evaluate_with_llm`: wrap the real object
in-process rather than proxying it, so the actual arguments and the actual response
are captured, not a re-encoding of them.

Why this exists when env-calls.jsonl already logs /call
-------------------------------------------------------
`env-calls.jsonl` records what the *agent* asked for and the text its cell printed.
That is the right granularity for comparing arms, and it is not the world's answer:

  - It cannot see fan-out. One `apis.<app>.<api>(...)` is usually one request, but
    the native-arm `/execute` path runs arbitrary code — a single cell can make
    fifty requests and print one line, and only this layer sees the other forty-nine.
  - It records the *printed* representation. If the agent prints a summary, or
    prints nothing, the response is gone. AppWorld's own `api_calls.jsonl` has the
    mirror-image gap: it records `{method, url, data}` and no response at all
    (requester.py:82-92).
  - It cannot see the HTTP status. "Invalid credentials" as a 401 and as a 200 with
    a message body are different facts about the world, and only one of them is a
    bug in the agent.

So the two logs answer different questions and both are kept: `env-calls.jsonl` is
the arm's action log, this is the world's ledger. The rule from CLAUDE.md is that
the evidence has to survive the environment, and this world is an in-memory SQLite
database that stops existing when the process exits.

Never changes a response, and never raises into the run: a tracing failure is
counted by the caller's `record` and otherwise ignored.
"""

from __future__ import annotations

from typing import Any, Callable

VERBS = ("get", "post", "put", "patch", "delete")

_installed = False


def _summarize(response: Any) -> dict[str, Any]:
    """Status and body from whatever the requester returned.

    Covers httpx/requests responses and AppWorld's own `CustomResponse`, which has
    `status_code` and `text` but no `.json()`.
    """
    out: dict[str, Any] = {}
    out["status"] = getattr(response, "status_code", None)
    text = getattr(response, "text", None)
    if not isinstance(text, str):
        try:
            text = repr(response)
        except Exception:  # noqa: BLE001
            text = "<unrepresentable response>"
    # Kept whole. A 92-song library listing is the grounding evidence for whatever
    # the agent says next, and the entire point of logging the response side is that
    # it cannot be recovered later.
    out["response"] = text
    out["response_len"] = len(text)
    return out


def install(record: Callable[[dict], None], clock: Callable[[], float]) -> None:
    """Wrap the five request methods. Idempotent.

    Args:
        record: called with one flat dict per request; must not raise.
        clock:  wall-clock seconds. AppWorld freezes `time.time`, so the caller
                passes a clock that freezegun does not patch.
    """
    global _installed
    if _installed:
        return

    from appworld.requester import Requester

    def wrap(verb: str):
        original = getattr(Requester, f"_{verb}")

        def traced(self, url: str, data: dict | None = None, *args: Any, **kwargs: Any):
            started = clock()
            entry: dict[str, Any] = {
                "t": started,
                "kind": "http",
                "method": verb,
                "url": url,
                # A copy: the requester mutates `data` in `prepare()` (it injects
                # headers and rewrites the token), so holding the reference would log
                # what the call became rather than what was asked.
                "request": dict(data) if isinstance(data, dict) else data,
                # `track=False` marks AppWorld's own internal plumbing — seeding,
                # state dumps — rather than an agent-initiated call. Recorded so the
                # two can be told apart instead of inflating the agent's call count.
                "tracked": bool(kwargs.get("track", True)),
            }
            try:
                response = original(self, url, data, *args, **kwargs)
            except BaseException as exc:
                entry["error"] = f"{type(exc).__name__}: {exc}"
                entry["seconds"] = round(clock() - started, 4)
                _safe(record, entry)
                raise
            try:
                entry.update(_summarize(response))
            except Exception as exc:  # noqa: BLE001
                entry["traceError"] = f"{type(exc).__name__}: {exc}"
            entry["seconds"] = round(clock() - started, 4)
            entry["t_end"] = clock()
            _safe(record, entry)
            return response

        traced.__name__ = original.__name__
        traced.__qualname__ = original.__qualname__
        setattr(Requester, f"_{verb}", traced)

    for verb in VERBS:
        wrap(verb)
    _installed = True


def _safe(record: Callable[[dict], None], entry: dict) -> None:
    try:
        record(entry)
    except Exception:  # noqa: BLE001
        # The caller's record() already counts its own failures; tracing must never
        # change the run it observes.
        pass
