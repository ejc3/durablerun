#!/usr/bin/env bash
# Run a command inside a resource-capped cgroup scope (memory is the killer:
# a runaway run gets OOM-killed inside its scope instead of taking the box).
# The caps SCALE WITH THE MACHINE — the safety property is "dies inside its
# scope, never takes the box", which a 75%-of-RAM ceiling guarantees exactly
# as well as a small fixed number would, without starving big hardware.
# Usage: scripts/confine.sh <command...>
#   CONFINE_MEM   memory ceiling (default: 75% of MemTotal; swap disabled)
#   CONFINE_CPU   CPU quota      (default: all cores minus 4, min 4)
#   CONFINE_TASKS max tasks      (default 4096)
set -euo pipefail

if [[ -z "${CONFINE_MEM:-}" ]]; then
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  CONFINE_MEM="$((mem_kb * 3 / 4 / 1024))M"
fi
if [[ -z "${CONFINE_CPU:-}" ]]; then
  cores="$(nproc)"
  usable=$((cores > 8 ? cores - 4 : cores > 4 ? cores / 2 + 2 : cores))
  CONFINE_CPU="$((usable * 100))%"
fi
TASKS="${CONFINE_TASKS:-4096}"
export CONFINE_MEM CONFINE_CPU
export CONFINE_TASKS="$TASKS"

if ! command -v systemd-run >/dev/null 2>&1; then
  echo "confine: systemd-run is unavailable; refusing to run without an aggregate cgroup" >&2
  exit 125
fi

exec systemd-run --user --scope --quiet \
  -p "MemoryMax=$CONFINE_MEM" -p "MemorySwapMax=0" \
  -p "CPUQuota=$CONFINE_CPU" -p "TasksMax=$TASKS" \
  -- "$@"
