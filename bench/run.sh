#!/usr/bin/env bash
# Run a prompt through one arm.
#
#   bench/run.sh <env-file> <arm> <model> <prompt>
#
# The env file is sourced into this process and inherited by the harness. Its
# contents are never read, echoed, or logged — `set -a` exports assignments
# directly, so no key value passes through a variable we print or a file we
# write. Verify with: bash -x is deliberately NOT used here.
set -euo pipefail

if [ $# -lt 4 ]; then
	echo "usage: $0 <env-file> <arm:vanilla|codemode> <model> <prompt>" >&2
	exit 2
fi

ENV_FILE="$1"; ARM="$2"; MODEL="$3"; PROMPT="$4"

[ -f "$ENV_FILE" ] || { echo "no such env file: $ENV_FILE" >&2; exit 2; }

case "$ARM" in
	vanilla)  TOOLS="read,bash,edit,write,grep,find,ls" ;;
	codemode) TOOLS="ipython" ;;
	*) echo "unknown arm: $ARM (want vanilla or codemode)" >&2; exit 2 ;;
esac

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

# Report only whether a key is present, never any part of its value.
for v in ANTHROPIC_API_KEY OPENROUTER_API_KEY ZAI_API_KEY; do
	eval "val=\${$v:-}"
	[ -n "$val" ] && echo "$v: present" >&2
done
unset val

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/vendor/prime-agent/packages/coding-agent/dist/cli.js"

# Reproducibility: no telemetry, no persisted harness state, no ambient config
# leaking into the prompt. See scripts/neutralize-prime.mjs.
export DO_NOT_TRACK=1 PRIME_AGENT_TELEMETRY=0
export PRIME_AGENT_CODING_AGENT_DIR="${PRIME_AGENT_CODING_AGENT_DIR:-$ROOT/.run/agent-home}"
mkdir -p "$PRIME_AGENT_CODING_AGENT_DIR"

echo "arm=$ARM tools=$TOOLS model=$MODEL" >&2
exec node "$CLI" -p --mode json \
	--model "$MODEL" \
	--tools "$TOOLS" \
	--no-skills --no-extensions --no-context-files --no-prompt-templates \
	"$PROMPT"
