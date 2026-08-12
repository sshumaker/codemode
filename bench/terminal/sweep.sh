#!/usr/bin/env bash
# The ONE way to run terminal-bench in this repo.
#
# Same rule as `npm run iterate` for MCP-Bench and `sweep.mjs` for AppWorld, for
# the same reason: every setting below has already been got wrong once by hand.
#
#   DOCKER_HOST   docker here is colima, whose socket is NOT /var/run/docker.sock.
#                 Without it terminal-bench catches the connection error per trial
#                 and prints `Accuracy: 0.00%` — a plausible number, not an error.
#   PYTHONPATH    so `--agent-import-path bench.terminal.prime_agent:PrimeAgent`
#                 resolves against this repo rather than the vendored tree.
#   dataset path  the STAGED dataset (`stage-dataset.py`), whose compose files
#                 mount the agent volume. Pointing at `original-tasks` runs the
#                 agent-less variant and every prime trial fails preflight.
#   --no-upload   results are not published to upstream's leaderboard.
#
# Usage:
#   bench/terminal/sweep.sh --arm codemode --tasks hello-world,csv-to-parquet
#   bench/terminal/sweep.sh --agent oracle --tasks <ids>      # the $0 screen
#   bench/terminal/sweep.sh --agent claude-code --tasks <ids>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TB="$ROOT/vendor/terminal-bench"
DATASET="$ROOT/.run/terminal-bench/dataset"
ENV_FILE="${ENV_FILE:-$HOME/src/goals/web/.env.local}"

ARM=codemode
JOBS=off
AGENT=prime
MODEL="${PRIME_MODEL:-anthropic/claude-opus-5}"
TASKS=""
CONCURRENCY=2
RUN_ID=""
EXTRA=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arm)         ARM="$2"; shift 2 ;;
    --jobs)        JOBS="$2"; shift 2 ;;
    --agent)       AGENT="$2"; shift 2 ;;
    --model)       MODEL="$2"; shift 2 ;;
    --tasks)       TASKS="$2"; shift 2 ;;
    --concurrency) CONCURRENCY="$2"; shift 2 ;;
    --run-id)      RUN_ID="$2"; shift 2 ;;
    *)             EXTRA+=("$1"); shift ;;
  esac
done

[[ -n "$TASKS" ]] || { echo "--tasks is required" >&2; exit 2; }
RUN_ID="${RUN_ID:-$(date +%Y%m%d-%H%M%S)-$AGENT-$ARM-jobs$JOBS}"

# Stage every requested task before running. Cheap, idempotent, and it is the
# only thing standing between a typo'd task id and a trial that silently runs
# against a stale mirror.
"$TB/.venv/bin/python" "$ROOT/bench/terminal/stage-dataset.py" --tasks "$TASKS"

TASK_ARGS=()
IFS=',' read -ra IDS <<< "$TASKS"
for t in "${IDS[@]}"; do TASK_ARGS+=(-t "$t"); done

case "$AGENT" in
  prime)
    AGENT_ARGS=(--agent-import-path bench.terminal.prime_agent:PrimeAgent
                -k "arm=$ARM" -k "jobs=$JOBS" -k "model_name=$MODEL") ;;
  *)
    AGENT_ARGS=(--agent "$AGENT")
    # oracle and nop take no model; passing one is harmless but noisy.
    [[ "$AGENT" == "claude-code" ]] && AGENT_ARGS+=(--model "$MODEL") ;;
esac

# The key is sourced into this process only and forwarded by name; it is never a
# command-line argument, so it cannot land in `ps` inside the container the agent
# works in. TheAgentCompany leaks its own key exactly that way.
set -a; . "$ENV_FILE"; set +a

export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"
export PYTHONPATH="$ROOT"

echo "run-id     $RUN_ID"
echo "agent      $AGENT ${ARM}"
echo "jobs       $JOBS"
echo "model      $MODEL"
echo "tasks      $TASKS"
df_before=$(docker run --rm -v /:/host alpine df -h / 2>/dev/null | awk 'NR==2{print $4}' || echo "?")
echo "vm free    $df_before"

cd "$TB"
./.venv/bin/tb run \
  --dataset-path "$DATASET" \
  "${TASK_ARGS[@]}" \
  "${AGENT_ARGS[@]}" \
  --n-concurrent "$CONCURRENCY" \
  --no-upload-results \
  --output-path "$ROOT/.run/terminal-bench" \
  --run-id "$RUN_ID" \
  ${EXTRA[@]+"${EXTRA[@]}"}

echo
"$ROOT/bench/terminal/report.py" "$RUN_ID" || true
