"""Can an NPC colleague actually answer?

Liveness is not capability. `ps ax | grep run_one_npc` counts processes, and every
one of them can be alive, connected to RocketChat, reading the agent's message, and
still incapable of producing a single reply — which is exactly what happened when
sotopia's hard-coded `temperature=0.7` met a model that rejects the parameter. The
bot logs "No message received, waiting..." forever, the agent waits for a colleague
who will never speak, and the *arm* is blamed for the silence.

So this makes the same call sotopia makes, with the parameter that broke it, against
the model the NPCs will use, and reports what came back. Run before the agent starts;
its output belongs in the run directory, because the container is destroyed
afterwards and this verdict cannot be re-derived from anything else.
"""

import json
import os

import requests

base = os.environ.get("LITELLM_BASE_URL", "https://api.anthropic.com/v1/").rstrip("/")
model = os.environ.get("LITELLM_MODEL", "")
# sotopia strips an "openai/" prefix before handing the name to its custom backend.
if model.startswith("openai/"):
    model = model[7:]

out = {"model": model, "base": base, "ok": False}
try:
    r = requests.post(
        base + "/chat/completions",
        headers={
            "Authorization": "Bearer " + os.environ["LITELLM_API_KEY"],
            "Content-Type": "application/json",
        },
        # temperature is the whole point of this probe: it is what sotopia sends and
        # what a rejecting model 400s on. Dropping it here would certify a path the
        # NPCs do not take.
        json={
            "model": model,
            "messages": [{"role": "user", "content": "Reply with the single word: ready"}],
            "max_tokens": 16,
            "temperature": 0.7,
        },
        timeout=60,
    )
    out["status"] = r.status_code
    out["ok"] = r.status_code == 200
    if r.status_code != 200:
        out["body"] = r.text[:300]
except Exception as e:  # noqa: BLE001 - the reason matters more than the type
    out["error"] = f"{type(e).__name__}: {e}"[:300]

print("NPCLLM " + json.dumps(out))
