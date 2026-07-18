#!/usr/bin/env bash
# Batch-label ledger (prevention, per the standing rule): every labeled batch
# in the store must appear in specs/Scheduler.tla — either mapped to a
# modeled action or on the explicit exclusion list with a reason. This is
# what catches "implemented but silently unmodeled" drift (the cancellation
# gap the review found).
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC=specs/Scheduler.tla
SRC=packages/store-libsql/src

labels=$(grep -rhoE "(batch\(|FencedBatch\()\s*'[a-z:-]+'" "$SRC" |
  grep -oE "'[a-z:-]+'" | tr -d "'" | sort -u)

missing=0
for label in $labels; do
  if ! grep -qF "$label" "$SPEC"; then
    echo "spec-ledger: batch label '$label' is not in $SPEC (map it to an action or add it to the exclusion ledger with a reason)"
    missing=$((missing + 1))
  fi
done

if [[ "$missing" -gt 0 ]]; then
  exit 1
fi
echo "spec-ledger: all $(echo "$labels" | wc -w | tr -d ' ') batch labels accounted for"
