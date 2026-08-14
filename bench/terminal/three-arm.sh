#!/usr/bin/env bash
# One task, three arms, strictly one container in flight.
#
#   bench/terminal/three-arm.sh <task-id> <run-prefix>
#
# The long-horizon tasks build Coq/OpenCV/torch from source, so two of them in
# flight is a disk incident (CLAUDE.md's TAC §"Prune after every task": a 40-task
# sweep filled 98 GB by task 8 and every later task recorded UNGRADED with no
# indication the cause was disk). Sequential, with a free-space check between
# arms, and the task image dropped once all three are done.
#
# Order is deliberate: codemode first, so a harness fault shows up on the arm
# whose artefacts are richest, before two more arms have been paid for.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TASK="${1:?task id}"
PREFIX="${2:?run prefix}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.colima/default/docker.sock}"

free_gb() {
  docker run --rm -v /var/lib/docker:/dd alpine df -BG /dd 2>/dev/null \
    | awk 'NR==2{gsub("G","",$4); print $4}'
}

run_arm() {
  local label="$1"; shift
  local free; free=$(free_gb)
  echo "=== $TASK / $label  (vm free ${free}G, $(date +%H:%M:%S))"
  if [[ -n "$free" && "$free" -lt 12 ]]; then
    echo "!! free ${free}G < 12G — pruning tb-* images before continuing"
    docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^tb__' \
      | xargs -r docker rmi 2>/dev/null | tail -1
    echo "   free now $(free_gb)G"
  fi
  bash "$ROOT/bench/terminal/sweep.sh" --tasks "$TASK" --concurrency 1 \
    --run-id "$PREFIX-$label" "$@" 2>&1 | sed "s/^/[$label] /"
}

run_arm codemode --arm codemode --jobs on
run_arm vanilla  --arm vanilla
run_arm cc       --agent claude-code

# Task images are ~1-10 GB each and every trial spawns an anonymous volume from
# the image's VOLUME directive. Drop this task's image now that all three arms
# are done, scoped to tb-* so nothing else in the VM is touched.
docker rmi "tb__${TASK}__client:latest" 2>/dev/null | tail -1
docker ps -a --filter "name=${TASK}" -q | xargs -r docker rm -f -v >/dev/null 2>&1
echo "=== $TASK done, vm free $(free_gb)G"
