"""
Record every LLM-judge call the grader makes, with its inputs.

Imported ahead of /utils/eval.py by bench/tac/run-task.mjs. It wraps
`common.evaluate_with_llm` so each call appends one JSON line to /tmp/judge.jsonl:
the content, the predicate, the raw model reply, and the verdict.

Without this, an LLM-graded checkpoint is unreproducible the moment the sweep
moves on. The grader's stdout records the predicate and the True/False, but the
*content* comes from the live services — chat history, issue lists — and every
subsequent task calls reset.sh and destroys it. So a disputed verdict cannot be
re-judged even a minute later, and "was this noise or a real difference?" becomes
unanswerable.

That question came up for real: two arms posted a byte-identical message to
RocketChat and one checkpoint passed while the other failed. Replaying the judge
on the message alone gave False 10/10 for both, which ruled out nondeterminism
and pointed at the surrounding channel history — which was already gone. With
this trace the whole input is on disk and k-sample re-judging is a replay.
"""

import json
import os
import time

import common

_LOG = os.environ.get("HARNESS_JUDGE_TRACE", "/tmp/judge.jsonl")
_original = common.evaluate_with_llm


def _traced(content, predicate, additional_prompt="", image_path=None, *args, **kwargs):
    started = time.time()
    verdict = _original(content, predicate, additional_prompt, image_path, *args, **kwargs)
    try:
        with open(_LOG, "a") as fh:
            fh.write(
                json.dumps(
                    {
                        "predicate": predicate,
                        # The exact string the judge saw. This is the irreplaceable
                        # part: it is assembled from service state that reset.sh
                        # wipes before the next task.
                        "content": content if isinstance(content, str) else repr(content),
                        "additional_prompt": additional_prompt,
                        "image_path": image_path,
                        "verdict": bool(verdict),
                        "seconds": round(time.time() - started, 2),
                        "model": os.environ.get("LITELLM_MODEL"),
                    }
                )
                + "\n"
            )
    except Exception:
        # Tracing must never change a grade.
        pass
    return verdict


common.evaluate_with_llm = _traced

# Evaluators do `from common import evaluate_with_llm`, binding the name at import
# time — so patching the module attribute alone would miss them. eval.py imports
# the evaluator *after* this module runs, so the patched attribute is what they
# pick up.
