#!/usr/bin/env bash
# Execute one logical nightly fuzz shard as fresh, resource-confined processes.
# `--plan` traverses the same loop and command array without launching Vitest,
# so the build can prove the hosted topology without scanning shell text.
set -euo pipefail

readonly TOTAL_SEEDS=20000
readonly STEPS=150
readonly SHARD_COUNT=32
readonly BATCH_COUNT=4

plan_only=0
if [[ "${1:-}" == "--plan" ]]; then
  plan_only=1
  shift
fi
if [[ "$#" -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: scripts/nightly-fuzz-shard.sh [--plan] <shard>" >&2
  exit 2
fi
readonly shard="$1"
if ((shard >= SHARD_COUNT)); then
  echo "nightly fuzz shard must be in [0, $SHARD_COUNT), got $shard" >&2
  exit 2
fi
printf -v shard_file '%02d' "$shard"

walks=0
for ((batch = 0; batch < BATCH_COUNT; batch++)); do
  start=$((shard + batch * SHARD_COUNT))
  count=$(((TOTAL_SEEDS - 1 - start) / (SHARD_COUNT * BATCH_COUNT) + 1))
  command=(
    env
    "FUZZ_SEEDS=$TOTAL_SEEDS"
    "FUZZ_STEPS=$STEPS"
    "FUZZ_BATCHES=$BATCH_COUNT"
    "FUZZ_BATCH_INDEX=$batch"
    bash scripts/confine.sh
    pnpm exec vitest run "packages/conformance/test/fuzz-${shard_file}.test.ts"
    --maxWorkers=1
  )
  if ((plan_only)); then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$shard" "$SHARD_COUNT" "$batch" "$BATCH_COUNT" \
      "$count" "$TOTAL_SEEDS" "$STEPS" "${command[*]}"
    continue
  fi
  "${command[@]}"
  walks=$((walks + count))
done

if ((plan_only)); then
  exit 0
fi
printf 'nightly-fuzz-shard: shard=%s/%s batches=%s walks=%s steps=%s complete\n' \
  "$shard" "$SHARD_COUNT" "$BATCH_COUNT" "$walks" "$STEPS"
