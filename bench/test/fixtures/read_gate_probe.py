"""Drive a generated read-gated `api/` tree against a stub proxy and a real ledger.

Run as: python3 read_gate_probe.py <dir-containing-api>

A real file rather than a string inside the JS test, for the reason in
docs_gate_probe.py: escaping Python through a JS/heredoc layer is how this project
once produced a module that would not compile.

The property under test is the one the docs gate does NOT have: there is no path
through. The probe therefore drives the gate the way a run does — call, get
refused, append the ledger entry bench/arms/read-ledger-extension.ts would have
appended, call again — and checks that skipping the middle step refuses forever.
"""

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = sys.argv[1]
LEDGER = os.path.join(ROOT, "api", ".read-ledger.jsonl")

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
# _client reads both of these at import time, so they have to be set first.
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"
os.environ["HARNESS_READ_LEDGER"] = LEDGER

sys.path.insert(0, ROOT)
import api._client as client  # noqa: E402
import api.linear  # noqa: E402
import api.notion  # noqa: E402
import api.wide  # noqa: E402

LINEMAP = json.load(open(os.path.join(ROOT, "api", "_linemap.json")))
# What the extension records for a read with no limit that was not truncated.
WHOLE_FILE = 9007199254740991


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


def log_read(pkg, start=1, end=WHOLE_FILE, tool="read", is_error=False):
    """Append exactly what bench/arms/read-ledger-extension.ts would append."""
    entry = {"ts": "2026-08-13T00:00:00.000Z", "tool": tool, "pkg": pkg, "isError": is_error}
    if tool == "read":
        entry.update({"start": start, "end": end})
    with open(LEDGER, "a") as handle:
        handle.write(json.dumps(entry) + "\n")


async def refused(fn, **kwargs):
    """Call `fn`, returning the ReadFirst message, or None if it went through."""
    try:
        await fn(**kwargs)
        return None
    except client.ReadFirst as exc:
        return str(exc)


async def main():
    check(issubclass(client.ReadFirst, client.McpError), "ReadFirst does not subclass McpError")

    # 1. The refusal, in read-tool language, citing this API's own span.
    text = await refused(api.linear.list_issues, team="ENG")
    check(text is not None, "the first call was not refused")
    check(CALLS == [], "a refused call reached the transport")
    span = LINEMAP["linear"]["list_issues"]
    check("api.linear.list_issues has not been read" in text, f"the API is not named: {text!r}")
    check("Read api/linear.py" in text, f"the file to read is not named: {text!r}")
    check(f"lines {span[0]}-{span[1]}" in text, f"the line span is missing or wrong: {text!r}")
    check("read tool" in text, f"the read TOOL is not named: {text!r}")
    check("re-issue the call" in text, f"no instruction to re-issue: {text!r}")
    check("cat, help() and open()" in text, f"the read tool is not distinguished from cat: {text!r}")

    # 2. NO PATH THROUGH. The docs gate this replaces marks the pair delivered
    #    BEFORE raising, so a retry always proceeds; that is the difference, and it
    #    is the whole point. Measured consequence of the old behaviour: 0 of 12
    #    configurations ever read reply_to_email's contract.
    for attempt in range(3):
        again = await refused(api.linear.list_issues, team="ENG")
        check(again is not None, f"retry {attempt} proceeded without a read — the gate is skippable")
    check(CALLS == [], "a retried call reached the transport")

    # 3. A read that stops short of the span is not a read of this API.
    log_read("linear", 1, span[0] - 1)
    check(
        await refused(api.linear.list_issues, team="ENG") is not None,
        "a read stopping one line short of the span satisfied the gate",
    )

    # 4. A covering read satisfies it, and the call reaches the transport.
    log_read("linear", span[0], span[1])
    check(await api.linear.list_issues(team="ENG") == "RESULT", "a covering read did not satisfy the gate")
    check(len(CALLS) == 1, f"expected 1 transport call, got {len(CALLS)}")

    # 5. Coverage is per API, not per file: a sibling in the same module whose span
    #    those reads never reached is still refused.
    other = LINEMAP["linear"]["create_issue"]
    check(other[0] > span[1], "fixture assumption broken: create_issue is not after list_issues")
    check(
        await refused(api.linear.create_issue, team="ENG", title="t") is not None,
        "an unread sibling was let through by another API's read",
    )

    # 6. Two adjacent partial reads union to cover a span neither covers alone —
    #    which is what paging a >50KB module through the read tool produces, and the
    #    read tool's own truncation notice tells the agent to page.
    log_read("linear", other[0], other[0])
    log_read("linear", other[0] + 1, other[1])
    check(
        await api.linear.create_issue(team="ENG", title="t") == "RESULT",
        "two reads covering a span between them were refused",
    )

    # 7. One whole-file read bulk-satisfies every API in that app. This is what
    #    keeps the tax at about one read per app instead of one per API.
    check(await refused(api.wide.show_song_details, song_id="1") is not None, "wide was satisfied before it was read")
    log_read("wide")
    results = await asyncio.gather(
        api.wide.show_song_details(song_id="1"),
        api.wide.play_song(song_id="1"),
        api.wide.add_payment_card(song_id="1"),
    )
    check(results == ["RESULT"] * 3, f"a whole-file read did not bulk-satisfy: {results!r}")

    # 8. grep is evidence, never satisfaction. A hit is a line; the sentence that
    #    redirects a default is two lines below the match.
    check(await refused(api.notion.search, query="q") is not None, "notion was satisfied before it was read")
    log_read("notion", tool="grep")
    check(await refused(api.notion.search, query="q") is not None, "a grep satisfied the gate")

    # 9. A read the tool ERRORED on is not a read.
    log_read("notion", is_error=True)
    check(await refused(api.notion.search, query="q") is not None, "a failed read satisfied the gate")

    # 10. And after all of that, the only calls that ever reached the transport are
    #     the ones whose contract had been read.
    check(len(CALLS) == 5, f"expected 5 transport calls, got {len(CALLS)}")

    print("OK")


asyncio.run(main())
