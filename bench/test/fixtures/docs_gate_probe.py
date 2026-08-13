"""Drive a generated `api/` tree against a stub proxy and check the docs gate.

Run as: python3 docs_gate_probe.py <dir-containing-api> off|redirect|inline

A real file rather than a string inside the JS test on purpose: escaping Python
through a JS/heredoc layer is how this project once produced a module that would
not compile (`\\n` became a newline, `\\w` became `w`).

The stub proxy is a real HTTP server speaking the env-server's `/call` protocol,
so this exercises the same transport the arm uses — including the property that
matters most, that a *gated* call never reaches it.
"""

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT, MODE = sys.argv[1], sys.argv[2]

CALLS = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        CALLS.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
        out = json.dumps({"ok": True, "text": "RESULT"}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
# _client reads the proxy address at import time, so it has to be set first.
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"

sys.path.insert(0, ROOT)
import api._client as client  # noqa: E402
import api.linear  # noqa: E402
import api.notion  # noqa: E402
import api.wide  # noqa: E402


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


async def gated(fn, **kwargs):
    """Call `fn`, returning the gate message it raised, or None if it went through."""
    try:
        await fn(**kwargs)
        return None
    except client.DocsFirst as exc:
        return str(exc)


async def gate_off():
    check(not hasattr(client, "DocsFirst"), "gate-off client defines DocsFirst")
    check(await api.linear.list_issues(team="ENG") == "RESULT", "first call did not reach the transport")
    check(len(CALLS) == 1, f"expected 1 transport call, got {len(CALLS)}")


async def common():
    """Everything both live modes must do, whatever the message says."""
    check(issubclass(client.DocsFirst, client.McpError), "DocsFirst does not subclass McpError")

    text = await gated(api.linear.list_issues, team="ENG")
    check(text is not None, "the first call was not gated")
    check(CALLS == [], "a gated call reached the transport")

    # Re-issuing proceeds, and never gates again. Nothing checks that the docs
    # were actually read — a gate that cannot be cleared is a deadlock.
    check(await api.linear.list_issues(team="ENG") == "RESULT", "the re-issued call did not proceed")
    check(await api.linear.list_issues(team="ENG") == "RESULT", "a later call was gated a second time")
    check(len(CALLS) == 2, f"expected 2 transport calls, got {len(CALLS)}")

    # Mark-before-raise, in the shape that motivated it: one cell, several
    # first-use APIs. Every one gates once, and ONE retry clears all of them. If
    # the pair were marked after the raise, this loop would never terminate.
    first = await asyncio.gather(
        api.linear.create_issue(team="ENG", title="t"),
        api.notion.search(query="q"),
        return_exceptions=True,
    )
    check(all(isinstance(r, client.DocsFirst) for r in first), f"a first use was not gated: {first!r}")
    check(len(CALLS) == 2, "a gated call inside gather reached the transport")

    second = await asyncio.gather(
        api.linear.create_issue(team="ENG", title="t"),
        api.notion.search(query="q"),
    )
    check(second == ["RESULT", "RESULT"], f"the retry did not proceed: {second!r}")
    check(len(CALLS) == 4, f"expected 4 transport calls, got {len(CALLS)}")
    return text


async def gate_redirect():
    text = await common()
    # The whole point of this mode: a pointer, not a payload.
    check("api/linear/DOCS.md" in text, f"the DOCS.md pointer is missing: {text!r}")
    check("re-issue your call" in text.lower(), f"no instruction to re-issue: {text!r}")
    check("Team key, e.g. ENG." not in text, f"redirect inlined the docstring: {text!r}")
    check("Args:" not in text, f"redirect inlined the docstring: {text!r}")
    check(len(text) < 400, f"redirect message is not a pointer, it is {len(text)} chars")


async def gate_inline():
    text = await common()
    check("List issues in a team." in text, f"summary line missing: {text!r}")
    check("capped at 50" in text, f"body of the docstring missing: {text!r}")
    check("Team key, e.g. ENG." in text, f"per-parameter documentation missing: {text!r}")
    check("api.linear.list_issues" in text, f"the API is not named: {text!r}")
    check("Neighbors in api.linear:" in text, f"no neighbour section: {text!r}")
    check("api.linear.create_issue" in text, f"the sibling is not listed: {text!r}")
    check("Create an issue in a team." in text, f"the sibling's summary is missing: {text!r}")
    check("Re-issue the call" in text, f"no instruction to re-issue: {text!r}")
    check("api/linear/DOCS.md" in text, f"no pointer to DOCS.md: {text!r}")

    # Bounded. `wide` has 25 tools, so only the nearest are named and the rest
    # become a pointer — a 25-line sibling dump costs more than it teaches.
    wide = await gated(api.wide.show_song_details, song_id="1")
    check(wide is not None, "the wide app's first use was not gated")
    listed = [line for line in wide.split("\n") if line.strip().startswith("api.wide.")]
    check(len(listed) == 12, f"expected 12 neighbours, got {len(listed)}")
    check("and 12 more — see api/wide/DOCS.md" in wide, f"no truncation pointer: {wide!r}")
    # Nearest by shared name-tokens, so the sibling most likely to be the right
    # call is the one named.
    check(any(line.strip().startswith("api.wide.show_song_library(") for line in listed), f"a name-token match was not ranked in: {listed!r}")
    check(
        not any(line.strip().startswith("api.wide.show_song_details(") for line in listed),
        "the called API listed itself as its own neighbour",
    )


asyncio.run({"off": gate_off, "redirect": gate_redirect, "inline": gate_inline}[MODE]())
print("OK")
