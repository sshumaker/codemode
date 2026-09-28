"""
A subagent's mailbox: the files a parent and its child talk through.

Used by the file transport (a child forked from this kernel, or started by
`runtime/subagent_broker.py`), where parent, child and launcher share a
filesystem. The host transport keeps the same conversation in the broker instead
(the assistant gateway), so nothing here is on that path.

    <child_dir>/
      inbox.jsonl      parent -> child: {"seq", "mode", "text", "at"}
      inbox.delivered  the last inbox seq the launcher handed to the child's loop
      outbox.jsonl     child -> parent: {"seq", "kind": report|ask|ask_closed, "text", "id", "at"}
      answers.jsonl    parent -> a child's open question: {"id", "text", "at"}
      outbox.read      the last outbox seq the parent has read
      inbox.closed     written by the launcher when the child's run is over: no more sends

Every file has one kind of writer and is appended under an exclusive lock, so a
line is never interleaved with another; readers tolerate a partial last line.

Delivery follows prime's agent-message model: `steer` interrupts the child's
current turn, `follow_up` is queued after it. A message goes to an open question
first: while the child is blocked in `agents.ask_parent`, the parent's next
`send` is its answer and is not also delivered as a turn.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import time
import uuid
from typing import Any, Dict, Iterator, List, Optional

INBOX = "inbox.jsonl"
DELIVERED = "inbox.delivered"
OUTBOX = "outbox.jsonl"
ANSWERS = "answers.jsonl"
READ = "outbox.read"
CLOSED = "inbox.closed"
LOCK = "mailbox.lock"

# prime's own limits for agent messages (core/agent-messages.ts).
MAX_CHARS = 16_384
MAX_PENDING = 20

MODES = ("follow_up", "steer")


class MailboxError(RuntimeError):
    """A message that cannot be sent: too long, too many pending, a finished child."""


def check_text(text: Any, what: str = "message") -> str:
    if not isinstance(text, str) or not text.strip():
        raise MailboxError(f"the {what} must be non-empty text.")
    if len(text) > MAX_CHARS:
        raise MailboxError(
            f"the {what} is {len(text)} characters; the limit is {MAX_CHARS}. "
            "Send the gist, or write the detail to a file and name its path."
        )
    return text


def check_mode(mode: Any) -> str:
    if mode not in MODES:
        raise MailboxError(f"mode must be 'follow_up' or 'steer', got {mode!r}.")
    return mode


class Mailbox:
    """One child's mailbox directory. Cheap to construct; every read goes to disk."""

    def __init__(self, child_dir: str):
        self.dir = child_dir

    def _path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    # -- low level -------------------------------------------------------------

    @contextlib.contextmanager
    def _locked(self) -> Iterator[None]:
        """One lock for decisions that read one file and write another (send vs a closing question)."""
        os.makedirs(self.dir, exist_ok=True)
        with open(self._path(LOCK), "a") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)

    def _append(self, name: str, record: Dict[str, Any], seq: bool = True) -> Dict[str, Any]:
        os.makedirs(self.dir, exist_ok=True)
        with open(self._path(name), "a+") as fh:
            fcntl.flock(fh, fcntl.LOCK_EX)
            try:
                if seq:
                    fh.seek(0)
                    record = {"seq": sum(1 for line in fh if line.strip()) + 1, **record}
                fh.seek(0, os.SEEK_END)
                fh.write(json.dumps(record) + "\n")
                fh.flush()
            finally:
                fcntl.flock(fh, fcntl.LOCK_UN)
        return record

    def _lines(self, name: str) -> List[Dict[str, Any]]:
        try:
            with open(self._path(name)) as fh:
                raw = fh.read()
        except OSError:
            return []
        out = []
        for line in raw.split("\n"):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # a line being written
        return out

    def _int(self, name: str) -> int:
        try:
            with open(self._path(name)) as fh:
                return int(fh.read().strip() or "0")
        except (OSError, ValueError):
            return 0

    def _set_int(self, name: str, value: int) -> None:
        os.makedirs(self.dir, exist_ok=True)
        tmp = f"{self._path(name)}.tmp-{os.getpid()}"
        with open(tmp, "w") as fh:
            fh.write(str(value))
        os.replace(tmp, self._path(name))

    # -- parent -> child -------------------------------------------------------

    def pending(self) -> List[Dict[str, Any]]:
        """Inbox messages the launcher has not yet handed to the child's loop."""
        delivered = self._int(DELIVERED)
        return [m for m in self._lines(INBOX) if m.get("seq", 0) > delivered]

    def mark_delivered(self, seq: int) -> None:
        if seq > self._int(DELIVERED):
            self._set_int(DELIVERED, seq)

    def send(self, text: str, mode: str = "follow_up", sender: str = "parent") -> Dict[str, Any]:
        """
        Deliver `text` to the child: as the answer to its open question if it has
        one, otherwise into its inbox for the launcher to hand over.
        """
        check_text(text)
        check_mode(mode)
        with self._locked():
            if os.path.exists(self._path(CLOSED)):
                raise MailboxError("this agent has finished, so nothing can reach it. "
                                   "Start a new agent if there is more to do.")
            question = self.open_question()
            if question is not None and sender == "parent":
                rec = self._append(ANSWERS, {"id": question["id"], "text": text, "at": time.time()}, seq=False)
                return {**rec, "kind": "answer"}
            if len(self.pending()) >= MAX_PENDING:
                raise MailboxError(
                    f"{MAX_PENDING} messages to this agent are still waiting to be delivered. "
                    "Wait for it to catch up before sending more."
                )
            rec = self._append(INBOX, {"mode": mode, "text": text, "from": sender, "at": time.time()})
            return {**rec, "kind": mode}

    def mark_closed(self) -> None:
        """close_inbox without the lock, for a signal handler that must not block."""
        try:
            with open(self._path(CLOSED), "w") as fh:
                fh.write(str(time.time()))
        except OSError:
            pass

    def close_inbox(self) -> List[Dict[str, Any]]:
        """The run is over: refuse later sends. Returns what arrived but was never delivered."""
        with self._locked():
            with open(self._path(CLOSED), "w") as fh:
                fh.write(str(time.time()))
            return self.pending()

    # -- child -> parent -------------------------------------------------------

    def report(self, text: str) -> Dict[str, Any]:
        check_text(text, "report")
        return self._append(OUTBOX, {"kind": "report", "text": text, "at": time.time()})

    def ask(self, question: str) -> str:
        check_text(question, "question")
        qid = uuid.uuid4().hex[:12]
        self._append(OUTBOX, {"kind": "ask", "id": qid, "text": question, "at": time.time()})
        return qid

    def answer_for(self, qid: str) -> Optional[str]:
        for rec in self._lines(ANSWERS):
            if rec.get("id") == qid:
                return str(rec.get("text") or "")
        return None

    def close_question(self, qid: str) -> Optional[str]:
        """
        Give up on a question. Returns an answer that landed just before the close,
        so a race with the parent's send never loses the answer.
        """
        with self._locked():
            answer = self.answer_for(qid)
            if answer is None:
                self._append(OUTBOX, {"kind": "ask_closed", "id": qid, "text": "", "at": time.time()})
            return answer

    def open_question(self) -> Optional[Dict[str, Any]]:
        """The child's newest question that is neither answered nor given up on."""
        answered = {r.get("id") for r in self._lines(ANSWERS)}
        closed = set()
        latest = None
        for rec in self._lines(OUTBOX):
            if rec.get("kind") == "ask_closed":
                closed.add(rec.get("id"))
            elif rec.get("kind") == "ask":
                latest = rec
        if latest and latest.get("id") not in answered and latest.get("id") not in closed:
            return latest
        return None

    # -- the parent's view -----------------------------------------------------

    def messages(self) -> List[Dict[str, Any]]:
        """Both directions, oldest first: what the child reported or asked, and what it was sent."""
        out = []
        for rec in self._lines(OUTBOX):
            if rec.get("kind") in ("report", "ask"):
                out.append(
                    {
                        "direction": "from_child",
                        "kind": rec["kind"],
                        "text": rec.get("text", ""),
                        "at": rec.get("at", 0),
                        "seq": rec.get("seq"),
                    }
                )
        for rec in self._lines(INBOX):
            out.append(
                {
                    "direction": "to_child",
                    "kind": rec.get("mode", "follow_up"),
                    "text": rec.get("text", ""),
                    "at": rec.get("at", 0),
                }
            )
        for rec in self._lines(ANSWERS):
            out.append({"direction": "to_child", "kind": "answer", "text": rec.get("text", ""), "at": rec.get("at", 0)})
        return sorted(out, key=lambda m: m["at"])

    def unread(self) -> int:
        seen = self._int(READ)
        return sum(1 for r in self._lines(OUTBOX) if r.get("kind") in ("report", "ask") and r.get("seq", 0) > seen)

    def mark_read(self) -> None:
        seqs = [r.get("seq", 0) for r in self._lines(OUTBOX)]
        if seqs:
            self._set_int(READ, max(seqs))

    def unread_messages(self) -> List[Dict[str, Any]]:
        seen = self._int(READ)
        return [r for r in self._lines(OUTBOX)
                if r.get("kind") in ("report", "ask") and r.get("seq", 0) > seen]

    def spoke_since(self, at: Optional[float]) -> List[Dict[str, Any]]:
        return [
            r
            for r in self._lines(OUTBOX)
            if r.get("kind") in ("report", "ask") and (at is None or r.get("at", 0) >= at)
        ]
