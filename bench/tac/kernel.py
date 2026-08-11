"""
A persistent IPython session driven over stdin/stdout, run inside a task container.

TheAgentCompany's task images carry the workspace, the seeded services and the
grader, so the agent's code has to execute *there* rather than on the host. The
host side speaks to this script through `docker exec -i`, one JSON request per
line, one JSON response per line — no ZMQ, because a Jupyter kernel's dynamic
ports do not survive the colima VM boundary.

A real `InteractiveShell` is used rather than a hand-rolled `exec` loop so the
arm keeps the semantics it had on MCP-Bench: `%%bash` cells, top-level `await`,
last-expression echo, and a namespace that persists across calls. The comparison
is only meaningful if the REPL behaves the same in both benchmarks.
"""

import ast
import base64
import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

from IPython.core.displaypub import DisplayPublisher
from IPython.core.interactiveshell import InteractiveShell

MAX_STREAM = 40_000
# Vision is the point of this channel, so the budget is generous — but a runaway
# loop calling display() per frame must not blow up the transport.
MAX_IMAGES = 4
MAX_IMAGE_BYTES = 4_000_000


class CapturingDisplayPublisher(DisplayPublisher):
    """
    Collect `image/png` payloads so the host can hand them to the model.

    The model is multimodal and the REPL is exactly where you would want to look
    at something — crop a scanned form, render a chart, inspect a page. Without
    this the arm is blind: on a survey-questionnaire task it fell back to
    printing pixel bands as ASCII art and misread the form, while the
    tool-calling arm downloaded a handwriting-OCR model and beat it. That was a
    handicap this file imposed, not a property of code execution.
    """

    def __init__(self):
        super().__init__()
        self.images = []

    def publish(self, data, metadata=None, source=None, **kwargs):
        png = data.get("image/png") if isinstance(data, dict) else None
        if png and len(self.images) < MAX_IMAGES:
            self.images.append(png)

    def clear_output(self, wait=False):
        self.images.clear()


shell = InteractiveShell.instance()
_publisher = CapturingDisplayPublisher()
shell.display_pub = _publisher
shell.autoawait = True
# Colour codes are noise in a transcript the model reads as plain text.
shell.colors = "NoColor"
# IPython's default "Context" traceback interleaves source for every frame — a
# single requests failure rendered 4KB of urllib3 internals in testing. "Plain"
# is the familiar Python traceback: same diagnosis, a fraction of the context.
shell.InteractiveTB.set_mode(mode="Plain")

# Names IPython itself puts in the namespace. They are not the agent's data, and
# listing them would drown the real bindings.
IPYTHON_INTERNALS = {
    "In", "Out", "get_ipython", "exit", "quit", "open", "_ih", "_oh", "_dh",
    "_sh", "_i", "_ii", "_iii", "_", "__", "___",
}


def clip(text: str) -> str:
    """Keep both ends: the head says what ran, the tail usually says what broke."""
    if len(text) <= MAX_STREAM:
        return text
    half = MAX_STREAM // 2
    dropped = len(text) - 2 * half
    return f"{text[:half]}\n… [{dropped} chars elided] …\n{text[-half:]}"


def user_names() -> list[str]:
    return sorted(
        k
        for k, v in shell.user_ns.items()
        if not k.startswith("_")
        and k not in IPYTHON_INTERNALS
        and not isinstance(v, type(sys))  # modules are imports, not results
    )


def collect_images(result_value) -> list[str]:
    """
    Images from `display(...)` calls, plus the cell's final value if it renders.

    Both paths matter: `display(img)` goes through the display publisher, while a
    bare `img` on the last line goes through the display *formatter*. Capturing
    only the first would silently miss the most natural thing to type.
    """
    images = list(_publisher.images)
    if result_value is not None and len(images) < MAX_IMAGES:
        try:
            data, _ = shell.display_formatter.format(result_value)
            png = data.get("image/png")
            if png and png not in images:
                images.append(png)
        except Exception:
            # Formatting arbitrary objects can raise; an unrenderable value is
            # simply not an image.
            pass
    return [i for i in images if len(i) <= MAX_IMAGE_BYTES][:MAX_IMAGES]


def run(code: str) -> dict:
    out, err = io.StringIO(), io.StringIO()
    payload = {"ok": True, "error": None}
    _publisher.images.clear()

    try:
        with redirect_stdout(out), redirect_stderr(err):
            result = shell.run_cell(code, store_history=True, silent=False)
    except Exception:
        # A failure *outside* the cell (kernel-level) must not kill the session;
        # the agent still has a namespace worth keeping.
        return {
            "ok": False,
            "stdout": clip(out.getvalue()),
            "stderr": clip(err.getvalue()),
            "error": traceback.format_exc(limit=6),
            "repr": None,
            "names": user_names(),
            "images": collect_images(None),
        }

    exc = result.error_in_exec or result.error_before_exec
    if exc is not None:
        payload["ok"] = False
        payload["error"] = "".join(
            traceback.format_exception(type(exc), exc, exc.__traceback__, limit=6)
        )

    # Echo the last expression the way a REPL would, but never let a hostile or
    # enormous __repr__ take the session down.
    rendered = None
    if result.result is not None:
        try:
            rendered = clip(repr(result.result))
        except Exception as e:  # noqa: BLE001 - repr is arbitrary user code
            rendered = f"<unrepresentable: {type(e).__name__}>"

    payload.update(
        {
            "stdout": clip(out.getvalue()),
            "stderr": clip(err.getvalue()),
            "repr": rendered,
            "names": user_names(),
            "images": collect_images(result.result),
        }
    )
    return payload


def main() -> None:
    # Signal readiness so the host does not race the first cell against IPython
    # start-up, which is the slowest part of the session by a wide margin.
    sys.stdout.write(json.dumps({"ready": True}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"ok": False, "error": f"bad request: {e}", "stdout": "", "stderr": "", "repr": None, "names": [], "images": []}
        else:
            response = run(request.get("code", ""))
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
