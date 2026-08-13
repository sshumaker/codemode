"""Drive a generated `api/` tree against a stub proxy and check argument validation.

Run as: python3 validation_probe.py <dir-containing-api> off|on

A real file rather than a string inside the JS test, for the reason
docs_gate_probe.py is: escaping Python through a JS/heredoc layer is how this
project once produced a module that would not compile.

The stub proxy is a real HTTP server speaking the env-server's `/call` protocol,
so this exercises the same transport the arm uses — including the property that
matters most, that an argument the schema rejects never reaches it. Validation
before the wire is the whole claim: a tool-calling arm's provider-side check
lands one round trip later, in the next turn's tool result, whereas this one
lands in the error channel of the cell that made the mistake.
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
import api.strict  # noqa: E402

OK_EMAIL = "a@b.co"


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


async def rejected(**kwargs):
    """Call `strict.search`, returning the validation message, or None if it went through."""
    before = len(CALLS)
    try:
        await api.strict.search(**kwargs)
    except client.ArgumentError as exc:
        check(len(CALLS) == before, f"a rejected call reached the transport: {kwargs!r}")
        return str(exc)
    return None


async def validation_off():
    """The tree is the one every earlier run used: nothing checks, nothing raises."""
    check(not hasattr(client, "ArgumentError"), "validation-off client defines ArgumentError")
    check(not hasattr(client, "_validate"), "validation-off client defines _validate")
    # The value the schema forbids goes straight out on the wire, exactly as before.
    check(await api.strict.search(email="not-an-email", page_limit=999) == "RESULT", "the call did not reach the transport")
    check(len(CALLS) == 1, f"expected 1 transport call, got {len(CALLS)}")
    check(CALLS[0]["args"] == {"email": "not-an-email", "page_limit": 999}, f"args were altered: {CALLS[0]['args']!r}")


async def validation_on():
    check(issubclass(client.ArgumentError, client.McpError), "ArgumentError does not subclass McpError")
    # `except TypeError` is the idiom already in the model's head for a bad
    # argument; requiring a bespoke class to be learned first is the tax
    # CLAUDE.md's affordance rule says not to charge.
    check(issubclass(client.ArgumentError, TypeError), "ArgumentError is not catchable as TypeError")

    # --- a valid call is untouched -------------------------------------------
    text = await api.strict.search(
        email=OK_EMAIL,
        name="scott",
        sort_by="-price",
        page_index=0,
        page_limit=20,
        amount=0.01,
        verified=True,
        code="ABC-1234",
        tags=["a", "b"],
        filters={"seller": 7, "region": "eu"},
        answer="forty two",
    )
    check(text == "RESULT", "a fully valid call did not reach the transport")
    check(len(CALLS) == 1, f"expected 1 transport call, got {len(CALLS)}")
    sent = CALLS[0]["args"]
    check(sent["page_index"] == 0, "page_index=0 was dropped — falsiness is not absence")
    check(sent["verified"] is True, "a boolean was altered in transit")
    # Optional parameters left at their default are still dropped, not sent as
    # nulls, and still not read as null type violations.
    check(await api.strict.search(email=OK_EMAIL) == "RESULT", "a minimal valid call was rejected")
    check(CALLS[1]["args"] == {"email": OK_EMAIL}, f"unset optionals were sent: {CALLS[1]['args']!r}")
    # `answer` is anyOf[number, string]; both branches must pass.
    check(await api.strict.search(email=OK_EMAIL, answer=42) == "RESULT", "anyOf rejected a valid branch")

    baseline = len(CALLS)

    # --- each error class fires, and names the offending argument ------------
    cases = [
        # (kwargs, substrings the message must contain)
        (dict(email=OK_EMAIL, page_limit="20"), ["page_limit", "must be integer", "str"]),
        (dict(email=OK_EMAIL, page_limit=True), ["page_limit", "must be integer", "bool"]),
        (dict(email=OK_EMAIL, verified=1), ["verified", "must be boolean", "int"]),
        (dict(email=OK_EMAIL, sort_by="popularity"), ["sort_by", "'popularity'", "'+price'", "'-price'"]),
        (dict(email=OK_EMAIL, page_index=-1), ["page_index", ">= 0"]),
        (dict(email=OK_EMAIL, page_limit=50), ["page_limit", "<= 20"]),
        # `> 0`, not `> 0.0`: the bound is quoted from _schemas.json, and JSON has
        # no float/int distinction to preserve.
        (dict(email=OK_EMAIL, amount=0.0), ["amount", "must be > 0"]),
        (dict(email=OK_EMAIL, name=""), ["name", "at least 1 characters"]),
        (dict(email=OK_EMAIL, name="a much longer name"), ["name", "at most 8 characters"]),
        (dict(email=OK_EMAIL, code="abc-1234"), ["code", "pattern"]),
        (dict(email="not-an-email"), ["email", "not an email address"]),
        (dict(email=OK_EMAIL, tags=["a", "b", "c", "d"]), ["tags", "at most 3 items"]),
        (dict(email=OK_EMAIL, tags=["a", 2]), ["tags[1]", "must be string"]),
        (dict(email=OK_EMAIL, filters={"seller": "7"}), ["filters.seller", "must be integer"]),
        (dict(email=OK_EMAIL, filters={"region": "us"}), ["filters", "required key 'seller'"]),
        (dict(email=OK_EMAIL, filters={"seller": 7, "region": "apac"}), ["filters.region", "'apac'"]),
        (dict(email=OK_EMAIL, answer=[1]), ["answer", "matches none"]),
        # A required argument left unset is dropped by the None-filter and must be
        # reported as missing, not as a null type violation.
        (dict(email=None), ["missing required argument 'email'"]),
    ]
    for kwargs, wanted in cases:
        message = await rejected(**kwargs)
        check(message is not None, f"no ArgumentError for {kwargs!r}")
        for token in wanted:
            check(token in message, f"{kwargs!r} -> message missing {token!r}: {message}")
        # Always says which API, so the correction is actionable without context.
        check("api.strict.search" in message, f"the API is not named: {message}")

    # An argument the schema has never heard of. The generated wrapper's signature
    # makes this a TypeError before the transport, so it is reachable only through
    # `_client.call` — which is exactly how an agent that read `_client.py` and
    # skipped the wrappers would reach it.
    unknown = None
    try:
        await client.call("strict", "search", {"email": OK_EMAIL, "srot_by": "-price"})
    except client.ArgumentError as exc:
        unknown = str(exc)
    check(unknown is not None, "an unknown argument was accepted")
    check("unknown argument 'srot_by'" in unknown, f"the unknown argument is not named: {unknown}")
    check("sort_by" in unknown, f"the real parameter names are not offered: {unknown}")

    check(len(CALLS) == baseline, f"a rejected call reached the transport ({len(CALLS) - baseline} did)")

    # An API with no entry in the table is passed through rather than refused: a
    # missing schema must not disable a tool that vanilla would still have.
    check(await client.call("strict", "not_in_table", {"x": 1}) == "RESULT", "an unknown tool was refused")


asyncio.run({"off": validation_off, "on": validation_on}[MODE]())
print("OK")
