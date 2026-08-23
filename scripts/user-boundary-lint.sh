#!/usr/bin/env bash
# User-boundary lint: task-facing inputs (names, durations, epochs a task
# passes to its context) cross into the engine ONLY through the classified
# validators in core/validate.ts (UserName.parse, userDurationToMs,
# userEpochMs) — the validator IS the classifier, so a deterministic bad
# input is a permanent task failure, never a retry loop. Importing the raw
# RangeError forms in the SDK re-opens the per-method-validation hole that
# shipped the same bug class twice (sleepFor one round, awaitEvent the
# next).
set -euo pipefail
cd "$(dirname "$0")/.."

violations=$(grep -rnE 'durationToMs|requireEpochMs' packages/sdk/src \
  | grep -vE 'userDurationToMs' || true)
if [[ -n "$violations" ]]; then
  echo "$violations"
  echo
  echo "user-boundary violation: packages/sdk/src must use the user* validators"
  echo "from core/validate.ts (they classify as FatalTaskError); the raw"
  echo "RangeError forms are the PORT boundary, not the task boundary."
  exit 1
fi
echo "user-boundary lint: clean"
