"""Replay the argument shapes GLM 5.2 actually wrote, against a real generated tree.

Run as: python3 pythonic_args_probe.py <dir-containing-api>

A real file rather than a string inside the JS test, for the reason
validation_probe.py is one: escaping Python through a JS layer is how this project
once produced a module that would not compile.

The stub proxy is a real HTTP server speaking the env-server's `/call` protocol, so
what is asserted is not "a function returned a dict" but what the SERVER RECEIVED —
which is the only thing that decides whether the coercion was correct. The two
cases are the two measured failures:

  judge_tool(assets=['a1', 'a2'])       12 of 83 cells died on nested literals; this
                                        is one of them, and it must now arrive at
                                        the transport in the strict [{label, id}]
                                        shape.
  complete_job(final_outputs=[...])     3 of 5 jobs passed a bare list for a
                                        dict[str, list[str]]. Bucketing ids by
                                        asset type needs types only the server
                                        knows, so this must still FAIL — and the
                                        message must carry the shape it wanted.
"""

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = sys.argv[1]

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
import api.agent_tools as lat  # noqa: E402


def check(condition, message):
    if not condition:
        raise SystemExit(f"FAIL: {message}")


async def sent(coro):
    """Await a call and return the args the stub proxy received."""
    before = len(CALLS)
    await coro
    check(len(CALLS) == before + 1, "the call did not reach the transport")
    return CALLS[-1]["args"]


async def refused(coro):
    """Await a call expected to raise, and prove nothing left the process."""
    before = len(CALLS)
    try:
        await coro
    except client.ArgumentError as exc:
        check(len(CALLS) == before, "a rejected call reached the transport")
        return str(exc)
    raise SystemExit("FAIL: an invalid argument was accepted")


async def main():
    # --- T1: the shape from the traces, coerced ------------------------------
    args = await sent(lat.judge_tool(query="which is sharper?", assets=["a1", "a2"]))
    check(
        args["assets"] == [
            {"label": "asset_1", "asset_id": "a1"},
            {"label": "asset_2", "asset_id": "a2"},
        ],
        f"a bare id list was not coerced: {args['assets']!r}",
    )

    # A {label: id} dict, labels preserved and order kept.
    args = await sent(lat.judge_tool(query="q", assets={"hero": "a1", "alt": "a2"}))
    check(
        args["assets"] == [
            {"label": "hero", "asset_id": "a1"},
            {"label": "alt", "asset_id": "a2"},
        ],
        f"a label->id dict was not coerced: {args['assets']!r}",
    )

    # The strict form is untouched — byte for byte what the caller passed.
    strict = [{"label": "hero", "asset_id": "a1"}]
    args = await sent(lat.judge_tool(query="q", assets=strict))
    check(args["assets"] == strict, f"the strict form was rewritten: {args['assets']!r}")

    # A partly-labeled list: the strict entries survive, the bare ids get labels.
    args = await sent(lat.judge_tool(query="q", assets=[{"label": "hero", "asset_id": "a1"}, "a2"]))
    check(
        args["assets"] == [{"label": "hero", "asset_id": "a1"}, {"label": "asset_2", "asset_id": "a2"}],
        f"a mixed list was not coerced per element: {args['assets']!r}",
    )

    # A single string is NOT a list of ids. Coercion must not invent a list out of
    # a value the caller may have meant as something else — the validator says so.
    message = await refused(lat.judge_tool(query="q", assets="a1"))
    check("assets must be array" in message, f"a bare string was not reported: {message}")

    # Only strings are treated as bare ids. An integer is not an id this schema
    # would accept, so wrapping it would move the error one level deeper for no
    # gain: it reaches the validator as itself, and the message names the shape.
    message = await refused(lat.judge_tool(query="q", assets=[1, 2]))
    check("assets[0] must be object, got int" in message, f"a non-string id was not reported: {message}")
    check("example: assets=[{'label'" in message, f"the example is missing: {message}")

    # --- the map, which cannot be adapted and must therefore teach -----------
    message = await refused(
        lat.complete_job(state="completed", summary="done", final_outputs=["abc123", "def456"])
    )
    check("final_outputs must be object, got list" in message, f"wrong diagnosis: {message}")
    # The author's own example, from the parameter description, in the error.
    check(
        "example: final_outputs={'image': ['uuid1', 'uuid2'], 'video': ['uuid3']}" in message,
        f"the example is missing from the error: {message}",
    )
    # And the example comes BEFORE the schema dump.
    check(
        message.index("example:") < message.index("schema for"),
        f"the actionable line is below the JSON blob: {message}",
    )

    # The shape the example teaches is one the validator accepts.
    args = await sent(
        lat.complete_job(state="completed", summary="done", final_outputs={"image": ["uuid1", "uuid2"]})
    )
    check(args["final_outputs"] == {"image": ["uuid1", "uuid2"]}, f"altered in transit: {args!r}")

    # --- T2: the lone scalar where a one-item list was declared ---------------
    # The measured shape, twice: extract_color_palette(image=...) and 8wLm-Itk's
    # `image`. Here on wait_for_assets.ids, which is array<string>, minItems 1.
    args = await sent(lat.wait_for_assets(ids="LmuewMxf"))
    check(args["ids"] == ["LmuewMxf"], f"a lone id was not wrapped: {args['ids']!r}")

    # Already a list: untouched, not double-wrapped.
    args = await sent(lat.wait_for_assets(ids=["a", "b"]))
    check(args["ids"] == ["a", "b"], f"a list was altered: {args['ids']!r}")

    # A type mismatch is NOT wrapped — it reaches the validator as itself, so the
    # message names the type error rather than burying it one level down.
    message = await refused(lat.wait_for_assets(ids=5))
    check("ids must be array, got int" in message, f"a mismatched scalar was wrapped: {message}")

    # `todos` declines by design: its objects need three fields, so wrapping a
    # scalar would emit an object the validator rejects — a worse error than this.
    message = await refused(lat.todo_write(merge=False, todos="write the brief"))
    check("todos must be array, got str" in message, f"an object array was wrapped: {message}")
    check("example: todos=[{'id'" in message, f"the example is missing: {message}")

    # --- a missing nested argument is told what it should have looked like ---
    # Through `_client.call`, because the generated wrapper's own signature turns an
    # omitted required argument into a TypeError before the validator is reached —
    # which is also the only path an agent that read `_client.py` could take.
    message = await refused(client.call("agent_tools", "judge_tool", {"query": "q"}))
    check("missing required argument 'assets'" in message, f"wrong diagnosis: {message}")
    check("example: assets=" in message, f"the example is missing: {message}")


asyncio.run(main())
print("OK")
