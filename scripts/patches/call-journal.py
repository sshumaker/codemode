
# harness: the call journal (scripts/patches/call-journal.py, via neutralize-prime.mjs).
# A cell's requests to HARNESS_MCP_PROXY go straight from this kernel to the proxy, so
# the host never sees them. Each one is appended to HARNESS_CALL_JOURNAL before it
# leaves and again when its answer is in, so a kernel that dies mid-cell leaves the
# host a record of what it had already sent. Inert unless the host set the variable.
# Spliced into a TypeScript template literal: no backslashes, backticks or dollar-brace.
def _harness_install_call_journal():
    import http.client as _http_client
    import io as _io
    import itertools as _itertools
    import json as _json
    import time as _time
    import urllib.error as _urllib_error
    import urllib.request as _urllib_request

    path = _prime_agent_os.environ.get("HARNESS_CALL_JOURNAL")
    if not path or getattr(_urllib_request.OpenerDirector, "_harness_call_journal", False):
        return
    try:
        fd = _prime_agent_os.open(path, _prime_agent_os.O_WRONLY | _prime_agent_os.O_APPEND | _prime_agent_os.O_CREAT, 0o600)
    except OSError:
        return
    numbers = _itertools.count(1)
    # Each line is an inline invocation's event (docs/TOOL-INVOCATIONS.md): its id is
    # (execution, seq within that execution), and a claim for anything but a
    # read_only tool is fsynced before the request leaves, so a kernel killed after
    # sending leaves a claim the store reads as UNKNOWN rather than as nothing.
    per_cell = {}
    try:
        with _io.open(_prime_agent_os.environ.get("HARNESS_TOOL_DELIVERY") or "") as fh:
            table = _json.load(fh)
        if not isinstance(table, dict):
            table = {}
    except Exception:
        table = {}

    def delivery_of(name):
        if name in table:
            return table[name]
        return table.get(name.split(".", 1)[0] + ".*", "at_most_once")

    def write(record, durable=False):
        try:
            _prime_agent_os.write(fd, (_json.dumps(record, default=str) + chr(10)).encode())
            if durable:
                _prime_agent_os.fsync(fd)
        except Exception:
            pass

    def cell():
        try:
            return get_ipython().kernel.get_parent()["header"]["msg_id"]
        except Exception:
            return None

    def name_of(request, data, route):
        body = data if data is not None else getattr(request, "data", None)
        try:
            payload = _json.loads(body)
            if isinstance(payload, dict) and payload.get("server") and payload.get("tool"):
                return str(payload["server"]) + "." + str(payload["tool"])
        except Exception:
            pass
        method = request.get_method() if hasattr(request, "get_method") else ("POST" if body else "GET")
        return method + " " + route

    def outcome_of(body):
        try:
            answer = _json.loads(body)
        except Exception:
            return "completed", body[:200].decode("utf-8", "replace")
        if isinstance(answer, dict) and "ok" in answer:
            if answer.get("ok"):
                return "completed", str(answer.get("text", ""))[:200]
            return "failed", str(answer.get("error", "error"))[:200]
        return "completed", _json.dumps(answer)[:200]

    original = _urllib_request.OpenerDirector.open

    def open(self, fullurl, data=None, *args, **kwargs):
        proxy = _prime_agent_os.environ.get("HARNESS_MCP_PROXY", "")
        url = fullurl if isinstance(fullurl, str) else getattr(fullurl, "full_url", "")
        if not proxy or not url.startswith(proxy):
            return original(self, fullurl, data, *args, **kwargs)
        n = next(numbers)
        name = name_of(fullurl, data, url[len(proxy):] or "/")
        msg = cell()
        seq = per_cell[msg] = per_cell.get(msg, 0) + 1
        delivery = delivery_of(name)
        write({"k": "call", "n": n, "msg": msg, "at": _time.time() * 1000, "name": name,
               "id": "call:" + str(msg) + ":" + str(seq), "delivery": delivery},
              durable=delivery != "read_only")
        try:
            response = original(self, fullurl, data, *args, **kwargs)
        except _urllib_error.HTTPError as exc:
            write({"k": "end", "n": n, "outcome": "failed", "summary": "HTTP " + str(exc.code)})
            raise
        except BaseException as exc:
            reason = getattr(exc, "reason", exc)
            refused = isinstance(reason, ConnectionRefusedError)
            write({"k": "end", "n": n, "outcome": "failed" if refused else "unknown", "not_sent": refused, "summary": type(reason).__name__ + ": " + str(reason)})
            raise
        if not isinstance(response, _http_client.HTTPResponse):
            write({"k": "end", "n": n, "outcome": "completed", "summary": "HTTP " + str(getattr(response, "status", "?"))})
            return response
        try:
            body = response.read()
        except BaseException as exc:
            write({"k": "end", "n": n, "outcome": "unknown", "summary": "answer not read: " + type(exc).__name__})
            raise
        outcome, summary = outcome_of(body)
        write({"k": "end", "n": n, "outcome": outcome, "summary": summary})
        # Hand the caller the body it would have read.
        response.fp = _io.BytesIO(body)
        response.length = len(body)
        response.chunked = False
        return response

    # The kernel picking a cell up, written before any of its code runs: iopub's
    # execute_input can be lost when the process dies at once, and then a cell that
    # already acted looks like one that never started and is sent again.
    def started(*_args):
        write({"k": "start", "msg": cell()})

    get_ipython().events.register("pre_run_cell", started)
    _urllib_request.OpenerDirector.open = open
    _urllib_request.OpenerDirector._harness_call_journal = True
    write({"k": "open", "pid": _prime_agent_os.getpid()})


try:
    _harness_install_call_journal()
except Exception:
    pass
del _harness_install_call_journal
