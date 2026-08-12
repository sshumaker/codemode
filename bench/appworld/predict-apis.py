#!/usr/bin/env python3
"""
Mirror AppWorld's own APIPredictor: narrow 469 APIs to <=N before the agent starts.

    predict-apis.py --task-id 3d9a636_1 --out /path/prediction.json \
                    [--model claude-opus-5] [--max-apis 20] [--no-demos]

This is upstream's reference baseline for the tool-calling arm, and the reason it
exists is the whole point of the experiment: 469 function definitions do not fit
alongside a task, so `function_calling_agent.py:117-121` passes only the predicted
subset as `tools=`. Their *code* agent does the same
(`full_code_agent.py:119-123`), because it interpolates the documentation into the
prompt too.

Fidelity, deliberately
----------------------
Upstream's `APIPredictor` class is imported and used directly — `build_messages`
for the prompt and `predicted_output_to_apis` for the parse — rather than
reimplemented. Their prompt (`experiments/prompts/api_predictor.txt`), their YAML
app-wise description block, their "prioritize high recall" instruction, their
forced insertion of `supervisor.complete_task`, their dedupe, and their cap are all
theirs. A reimplementation would have been a weaker predictor wearing upstream's
name, which is precisely the strawman this arm exists to avoid.

Two deviations, both recorded because they matter:

  * The model is ours (Opus 5 by default), not the gpt-4.1-mini their CI config
    uses. Using a weaker predictor than the arm it feeds would handicap the arm.
  * Their few-shot demos are `["82e2fac_1", "29caf6f_1", "d0b1f43_1"]`, whose
    ground-truth `required_apis` go into the prompt. **So a predictor run must
    never evaluate on those three task ids** — `82e2fac_1` is in our sample and is
    excluded for the predictor arm. `--no-demos` runs zero-shot if you need those
    tasks; expect lower recall and say so.

Everything about the call is logged — the assembled messages, the raw completion,
the parsed list, token usage — because the prediction determines which tools the
arm ever sees, and a verdict without it is unreproducible.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--task-id", required=True)
parser.add_argument("--out", required=True)
parser.add_argument("--model", default="claude-opus-5")
parser.add_argument("--max-apis", type=int, default=20)
parser.add_argument("--no-demos", action="store_true", help="zero-shot; needed if evaluating on a demo task")
parser.add_argument("--appworld-root", default=None)
args = parser.parse_args()

if args.appworld_root:
    os.chdir(args.appworld_root)

import warnings  # noqa: E402

warnings.filterwarnings("ignore")

from appworld.task import Task  # noqa: E402

# Upstream's demo tasks, from experiments/configs/ci/function_calling_agent.jsonnet.
# Their ground-truth required_apis are interpolated into the predictor prompt.
DEMO_TASK_IDS = ["82e2fac_1", "29caf6f_1", "d0b1f43_1"]
if not args.no_demos and args.task_id in DEMO_TASK_IDS:
    sys.exit(
        f"refusing to predict for {args.task_id}: it is one of upstream's predictor "
        f"demo tasks ({', '.join(DEMO_TASK_IDS)}), so its ground-truth API list would "
        "be in the prompt. Pass --no-demos to run zero-shot, or evaluate another task."
    )


def load_upstream_predictor():
    """Import upstream's APIPredictor from the experiments tree by path.

    Loaded by file rather than installed: the `appworld-agents` package pulls in
    litellm, openai and jsonnet, none of which this needs — the common predictor
    imports only from `appworld` itself.
    """
    path = os.path.join(os.getcwd(), "experiments", "code", "common", "api_predictor.py")
    if not os.path.exists(path):
        raise SystemExit(f"upstream predictor not found at {path}")
    spec = importlib.util.spec_from_file_location("_upstream_api_predictor", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.APIPredictor


APIPredictor = load_upstream_predictor()
predictor = APIPredictor(
    prompt_file_path=os.path.join(os.getcwd(), "experiments", "prompts", "api_predictor.txt"),
    demo_task_ids=[] if args.no_demos else DEMO_TASK_IDS,
    max_predicted_apis=args.max_apis,
    app_api_separator=".",
    mode="predicted",
)

task = Task.load(task_id=args.task_id)
messages = predictor.build_messages(task, include_cache_control=False)


def to_anthropic(chat_messages: list[dict]) -> tuple[str, list[dict]]:
    """OpenAI-style chat messages -> (system, messages) for the Anthropic API.

    Consecutive same-role turns are merged: `load_prompt_to_chat_messages` can emit
    two user turns in a row for the demo block, and the Messages API rejects that.
    """
    system_parts: list[str] = []
    out: list[dict] = []
    for message in chat_messages:
        role = message.get("role")
        content = message.get("content") or ""
        if role == "system":
            system_parts.append(content)
            continue
        role = "assistant" if role == "assistant" else "user"
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + content
        else:
            out.append({"role": role, "content": content})
    # The API also requires the first turn to be from the user.
    while out and out[0]["role"] != "user":
        out.pop(0)
    return "\n\n".join(system_parts), out


system, anthropic_messages = to_anthropic(messages)

api_key = os.environ.get("ANTHROPIC_API_KEY")
if not api_key:
    sys.exit("ANTHROPIC_API_KEY is not set (source the env file in a subshell)")

payload = {
    "model": args.model,
    "max_tokens": 2048,
    # Upstream runs the predictor at temperature 0 with a fixed seed, and
    # determinism matters more here than diversity — a different prediction is a
    # different tool surface, i.e. a different experiment. `temperature` is
    # rejected outright by Opus 5 ("`temperature` is deprecated for this model"),
    # so the prediction is NOT reproducible run to run and the recorded
    # `rawOutput` is the only record of what this arm was actually given.
    "system": system,
    "messages": anthropic_messages,
}
request = urllib.request.Request(
    "https://api.anthropic.com/v1/messages",
    data=json.dumps(payload).encode(),
    headers={
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    },
    method="POST",
)
started = time.time()
try:
    with urllib.request.urlopen(request, timeout=300) as response:
        body = json.loads(response.read())
except urllib.error.HTTPError as exc:
    sys.exit(f"predictor call failed: {exc.code} {exc.read()[:800]!r}")
seconds = time.time() - started

raw_output = "".join(block.get("text", "") for block in body.get("content", []) if block.get("type") == "text")
predicted = predictor.predicted_output_to_apis(task, raw_output)

record = {
    "taskId": args.task_id,
    "model": args.model,
    "maxApis": args.max_apis,
    "demoTaskIds": [] if args.no_demos else DEMO_TASK_IDS,
    "predictedApis": predicted,
    "predictedCount": len(predicted),
    # The exact input, so the prediction is re-derivable and so the prompt size the
    # arm paid for is on the record rather than estimated.
    "systemPrompt": system,
    "messages": anthropic_messages,
    "promptChars": len(system) + sum(len(m["content"]) for m in anthropic_messages),
    "rawOutput": raw_output,
    "usage": body.get("usage"),
    "seconds": round(seconds, 2),
}
# Analysis only, and only where upstream ships it. Never shown to the arm.
try:
    gt = Task.load(task_id=args.task_id, load_ground_truth=True, ground_truth_mode="full").ground_truth
    required = list(gt.required_apis)
    record["groundTruthRequiredApis"] = required
    hit = [a for a in required if a in predicted]
    record["recall"] = round(len(hit) / len(required), 3) if required else None
    record["missed"] = [a for a in required if a not in predicted]
except Exception as exc:  # noqa: BLE001 — absent for the test splits by licence
    record["groundTruthError"] = f"{type(exc).__name__}: {exc}"

with open(args.out, "w") as fh:
    json.dump(record, fh, indent=1)

print(f"PREDICTED {len(predicted)} apis for {args.task_id} in {seconds:.1f}s -> {args.out}")
print(",".join(predicted))
if record.get("recall") is not None:
    print(f"recall against ground truth: {record['recall']}  missed: {record.get('missed')}")
