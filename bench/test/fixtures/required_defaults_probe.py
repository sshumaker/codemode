"""Drive a generated `api/` tree whose promoted parameter has no default.

Run as: python3 required_defaults_probe.py <dir-containing-api> required|optional

A real file rather than a string inside the JS test, for the reason in
read_gate_probe.py: escaping Python through a JS/heredoc layer is how this project
once produced a module that would not compile.

String assertions certify that a signature *says* `recipients: list[str]`. They
cannot certify that Python refuses the call — `find_spec` once certified a module
containing a syntax error, because locating a module does not execute it. So the
transform is driven both ways against the same stub transport: with it on, the
omission must raise TypeError and nothing may reach the wire; with it off, the
identical call must go through, which is what makes the first result a property of
the transform rather than of the fixture.
"""

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = sys.argv[1]
MODE = sys.argv[2]

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
# _client reads this at import time, so it has to be set first.
os.environ["HARNESS_MCP_PROXY"] = f"http://127.0.0.1:{server.server_port}"

sys.path.insert(0, ROOT)
import api.mail  # noqa: E402


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


async def main():
    omitted = None
    try:
        await api.mail.reply_to_message(body="A gentle reminder.", thread_id=47822)
    except TypeError as exc:  # what Python raises for a missing positional argument
        omitted = str(exc)

    if MODE == "required":
        check(omitted is not None, "the promoted parameter was omitted and the call went through")
        # The correction has to name the argument, because the error channel is the
        # only place the agent is told: CLAUDE.md, "put the correction in the error,
        # not in the prompt".
        check("recipients" in omitted, f"the TypeError does not name the argument: {omitted!r}")
        check(CALLS == [], "a call missing the promoted argument reached the transport")
    else:
        check(omitted is None, f"the untransformed tree also refused the omission: {omitted!r}")
        check(len(CALLS) == 1, "the untransformed call did not reach the transport")
        # And the world sees the redirect the promotion exists to prevent: no
        # recipient at all, so the server picks one.
        check("recipients" not in CALLS[0]["args"], "the untransformed call carried a recipient")
        CALLS.clear()

    # Supplying it works identically in both trees, and reaches the wire unchanged:
    # the transform is a signature change, never a transport change.
    text = await api.mail.reply_to_message(
        body="A gentle reminder.", thread_id=47822, recipients=["cheweber@gmail.com"]
    )
    check(text == "RESULT", f"a fully-specified call did not go through: {text!r}")
    check(len(CALLS) == 1, f"expected 1 transport call, got {len(CALLS)}")
    check(
        CALLS[0]["args"] == {"body": "A gentle reminder.", "thread_id": 47822, "recipients": ["cheweber@gmail.com"]},
        f"the arguments on the wire changed: {CALLS[0]['args']!r}",
    )

    # A parameter that was NOT listed keeps its default in both trees — the
    # transform promotes exactly what the classifier vouched for.
    check(await api.mail.reply_to_message(body="b", thread_id=1, recipients=["a@b.co"]) == "RESULT", "quiet became mandatory")

    # And a read-only sibling is untouched, whatever its documentation says about
    # defaults: the mutation half of the rule is what keeps this call legal.
    check(await api.mail.show_threads() == "RESULT", "a read-only API gained a required argument")

    print("OK")


asyncio.run(main())
