"""
Shell job control as the durable-work surface. SKETCH — not wired into the prelude.

The bet
-------
`jobs.submit(cmd, name=...)` is out of distribution: it appears in zero pretraining
tokens, and measured unprompted an agent reaches instead for `time.sleep`, `%%bash …
sleep`, `subprocess.Popen`, `nohup … &` and `threading.Thread` — four different
escape routes, none of them ours. Today we *refuse* those and teach the replacement,
which works (one refusal, adoption on the next cell) but is fighting the prior.

Unix already has the API for "start work, don't hold my terminal, come back later",
and every model knows it cold:

    long_pipeline &     # start it, keep my prompt
    jobs                # what is running
    kill %1             # stop it

So: stop refusing `cmd &`. **Adopt it.** The shell backgrounds it and hands us `$!`;
we make it durable — spool file, exit marker, survives the kernel — and list it in
shell format. The model writes what it was always going to write.

This also answers the objection that sank adopting `subprocess.Popen`: Popen has no
durable name and §5 forbids synthesising one. Shell job control *has* a naming
convention — positional `%1`, `%2`. We are not inventing a hidden identity; we are
using the documented one.

What still deviates, and why it must
------------------------------------
`wait`. In a shell, `wait %1` blocks. Here it must end the turn instead, because a
wait genuinely needs wall-clock to pass and no amount of resumability removes that —
you either hold the kernel or you release the agent's attention. That is one
deviation to teach instead of a whole vocabulary.

Scope of this sketch
--------------------
The hard part is recognising backgrounding in a bash cell without a bash parser, so
that is what is implemented and tested here: `rewrite_background()` is a pure
function from cell source to (rewritten source, adopted commands). The registry side
reuses `jobs.JobStore` unchanged — an adopted job is an ordinary job.
"""

from __future__ import annotations

import re
import shlex
from typing import List, Optional, Tuple

# The shell function injected ahead of a rewritten cell.
#
# It delegates to `jobs.py --spawn`, i.e. to submit() itself, rather than
# reimplementing detachment in shell. That is not just tidiness: the first version
# inlined `setsid`, which does not exist on macOS, so every adopted job died
# instantly with "setsid: command not found" — while still writing a job record that
# looked correct. Found by running it, not by reading it.
#
# Delegating also makes an adopted job and a submitted one identical by construction:
# same spool file, same exit marker, same lifetime. `jobs.get()` cannot tell how a
# job was born, which is the property the whole sketch depends on.
BG_SHELL_FUNCTION = """
__jobs_bg() {
  python3 "${HARNESS_RUNTIME_DIR:-/agent/harness}/jobs.py" --spawn "$2" "$1" \
    || echo "[adoption FAILED for job $2 — the command did NOT run]" >&2
}
""".strip()

# Tokens that terminate a command. `&&` must never be mistaken for backgrounding —
# it is the single most common way to get this wrong.
#
# `|` is deliberately absent: the shell backgrounds a *pipeline* as one job, so
# `zcat f.gz | grep E &` is one unit of work, not two. Treating `|` as a terminator
# returned only the last stage, which would have adopted `grep E` and silently
# dropped the rest of the pipeline.
_SEPARATORS = (";", "&&", "||", "\n")


def _tokens(script: str) -> Optional[List[str]]:
    """Tokenise with shlex so quoted text is not read as structure."""
    lexer = shlex.shlex(script, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    try:
        return list(lexer)
    except ValueError:
        return None


def find_background_commands(script: str) -> List[str]:
    """
    Return the commands this script backgrounds with a top-level `&`.

    Uses the tokeniser only to *decide*, never to reconstruct: rewriting a shell
    script from tokens loses quoting, redirections and heredocs. The original text is
    what gets wrapped.
    """
    tokens = _tokens(script)
    if tokens is None:
        return []
    if "&" not in tokens:
        return []

    commands: List[str] = []
    current: List[str] = []
    depth = 0
    for tok in tokens:
        if tok == "(":
            depth += 1
        elif tok == ")":
            depth = max(0, depth - 1)
        if tok == "&" and depth == 0:
            if current:
                commands.append(" ".join(current))
            current = []
        elif tok in _SEPARATORS and depth == 0:
            current = []
        else:
            current.append(tok)
    return commands


_TRAILING_AMP = re.compile(r"(?<![&>])&\s*$")


def rewrite_background(script: str, prefix: str = "bg", taken: Optional[set] = None) -> Tuple[str, List[Tuple[str, str]]]:
    """
    Rewrite `cmd &` lines so the backgrounded work becomes a durable job.

    Returns (rewritten script, [(job name, command)]).

    Line-oriented on purpose. A token-level rewrite would have to regenerate shell
    source, and regenerating shell source from tokens silently destroys quoting,
    redirections and heredocs — the same class of damage that mangled an earlier
    patch in this project, where `\\n` became a literal newline. Here the original
    line text is preserved verbatim and only wrapped.

    Names are positional (`bg1`, `bg2`), which is shell job control's own convention
    (`%1`, `%2`) rather than an identity we invented. That is the difference between
    this and adopting `subprocess.Popen`, which has no naming convention at all.

    `taken` is every job name that already exists: numbering continues PAST it.
    Without it every cell restarted at bg1, the second cell's spawn was refused as
    a duplicate, the shell swallowed the error, and the banner still said
    "adopted" — a wrong answer wearing a success message (2026-08-15 review, H6).
    """
    # Already rewritten. The injected helper itself ends a line with `2>&1 &`, so a
    # second pass adopted the helper's own internals and nested jobs inside jobs.
    if "__jobs_bg()" in script:
        return script, []

    out: List[str] = []
    adopted: List[Tuple[str, str]] = []
    in_heredoc: Optional[str] = None

    for raw in script.split("\n"):
        # Heredoc bodies are data, not code. Rewriting inside one would corrupt the
        # payload while looking like it worked.
        if in_heredoc is not None:
            out.append(raw)
            if raw.strip() == in_heredoc:
                in_heredoc = None
            continue
        heredoc = re.search(r"<<-?\s*['\"]?(\w+)['\"]?", raw)
        if heredoc:
            in_heredoc = heredoc.group(1)
            out.append(raw)
            continue

        stripped = raw.strip()
        # `cmd && other` is not backgrounding; nor is a bare `&` inside quotes, which
        # the tokeniser check below rules out.
        if not _TRAILING_AMP.search(stripped) or not find_background_commands(stripped):
            out.append(raw)
            continue

        command = _TRAILING_AMP.sub("", stripped).strip()
        if not command:
            out.append(raw)
            continue
        n = len(adopted) + 1
        while taken and f"{prefix}{n}" in taken:
            n += 1
        name = f"{prefix}{n}"
        if taken is not None:
            taken.add(name)
        indent = raw[: len(raw) - len(raw.lstrip())]
        out.append(f"{indent}__jobs_bg {shlex.quote(command)} {shlex.quote(name)}")
        adopted.append((name, command))

    if not adopted:
        return script, []
    return f"{BG_SHELL_FUNCTION}\n" + "\n".join(out), adopted


def shell_format(records: List[dict]) -> str:
    """
    Render jobs the way `jobs` does, because that is the output the model expects.

        [1]+  Running    zcat huge.gz | grep ERROR &
        [2]-  Done       ./build.sh &
    """
    if not records:
        return ""
    lines = []
    for i, rec in enumerate(records, start=1):
        mark = "+" if i == len(records) else ("-" if i == len(records) - 1 else " ")
        state = {
            "running": "Running",
            "done": "Done" if rec.get("exit_code") == 0 else f"Exit {rec.get('exit_code')}",
            "killed": "Terminated",
            "deadline": "Terminated",
        }.get(rec.get("state", ""), rec.get("state", "?"))
        lines.append(f"[{i}]{mark}  {state:<12} {rec.get('cmd', '')} &")
    return "\n".join(lines)


def resolve(spec: str, records: List[dict]) -> Optional[dict]:
    """
    Accept shell job specs as well as names: `%1`, `%+`, `%-`, or a job name.

    Supporting `%1` is most of the point — it is the identifier the model already
    reaches for, and requiring a name here would reintroduce the vocabulary this
    design exists to avoid.
    """
    if not spec:
        return None
    if not spec.startswith("%"):
        return next((r for r in records if r.get("name") == spec), None)
    token = spec[1:]
    if not records:
        return None
    if token in ("+", ""):
        return records[-1]
    if token == "-":
        return records[-2] if len(records) > 1 else None
    if token.isdigit():
        idx = int(token)
        return records[idx - 1] if 1 <= idx <= len(records) else None
    # `%prefix` matches by command prefix, as bash does.
    return next((r for r in records if str(r.get("cmd", "")).startswith(token)), None)
