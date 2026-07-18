#!/usr/bin/env bash
# Run a command inside a resource-capped cgroup scope (memory is the killer:
# a runaway run gets OOM-killed inside its scope instead of taking the box).
# Usage: scripts/confine.sh <command...>
#   CONFINE_MEM  memory ceiling   (default 16G; swap disabled)
#   CONFINE_CPU  CPU quota        (default 3200% = 32 cores)
#   CONFINE_TASKS max tasks       (default 4096)
set -euo pipefail

MEM="${CONFINE_MEM:-16G}"
CPU="${CONFINE_CPU:-3200%}"
TASKS="${CONFINE_TASKS:-4096}"

exec systemd-run --user --scope --quiet \
  -p "MemoryMax=$MEM" -p "MemorySwapMax=0" \
  -p "CPUQuota=$CPU" -p "TasksMax=$TASKS" \
  -- "$@"
