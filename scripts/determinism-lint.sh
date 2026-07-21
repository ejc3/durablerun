#!/usr/bin/env bash
# Determinism lint (FDB adoption): engine code must not touch ambient time,
# randomness, or timers — those enter only through the injection boundaries
# (IdSource, DB-side NOW_MS, the harness). Flow makes this structural for
# FoundationDB; this script makes it structural for us.
#
# Scope: src/ of engine packages. The allowlist names the injection
# boundaries themselves; tests and the harness own their nondeterminism.
set -euo pipefail
cd "$(dirname "$0")/.."

ENGINE_SRC_DIRS=(
  packages/core/src
  packages/store-libsql/src
  packages/conformance/src
  packages/driver/src
  # sdk/ joins this list when it exists; store-postgres and store-mysql
  # join on arrival — dialect stores are engine code too.
)
ALLOWLIST=(
  packages/core/src/ids.ts # systemIdSource IS the id/entropy boundary
)

PATTERN='Date\.now|new Date\(|Math\.random|setTimeout|setInterval|setImmediate|performance\.now|process\.hrtime|crypto\.randomUUID'

violations=0
for dir in "${ENGINE_SRC_DIRS[@]}"; do
  [[ -d "$dir" ]] || continue
  while IFS= read -r hit; do
    file="${hit%%:*}"
    allowed=false
    for ok in "${ALLOWLIST[@]}"; do
      [[ "$file" == "$ok" ]] && allowed=true
    done
    if [[ "$allowed" == false ]]; then
      echo "determinism violation: $hit"
      violations=$((violations + 1))
    fi
  done < <(grep -rnE "$PATTERN" "$dir" || true)
done

if [[ "$violations" -gt 0 ]]; then
  echo
  echo "$violations violation(s): ambient time/randomness/timers are banned in"
  echo "engine code — inject via IdSource, DB-side NOW_MS, or a port instead."
  exit 1
fi
echo "determinism lint: clean"
