#!/usr/bin/env bash
# Model-check specs/Scheduler.tla with TLC — same run locally and in CI.
# The proof stack: TLA+ proves the DESIGN.md protocol; the
# sim harness proves the implementation refines it (labeled batch ≙ TLA
# action); the conformance suite pins the SQL to the atomic-action assumption.
#
# Two phases:
#   1. Vacuity probes (specs/Probe*.cfg over Probes.tla): each probe invariant
#      is EXPECTED TO FAIL — its counterexample is a witness trace proving the
#      modeled feature is reachable. A probe that PASSES means the feature is
#      unreachable in the model: vacuous verification, and this script fails.
#      (Class rule: checkers must be checked.)
#   2. Liveness (SchedulerLiveness.cfg): all temporal properties under weak
#      fairness at a reduced horizon (the liveness graph at full constants is
#      ~57M states and OOMs any reasonable heap).
#   3. Exhaustive safety (Scheduler.cfg) at the full constants.
#
# TLA_SCOPE=ci replaces phases 2+3 with SchedulerCI.cfg (safety + liveness
# at the CI-sized scope, ~500k states) — the PR gate on 4-core runners.
# Local pre-push (verify:tla) and nightly run the full scope.
set -euo pipefail

TLA_VERSION="v1.8.0"
TLA_SHA256="cc4803dce2a8ffaf0f5920a9dc39df4b5ee34ab4cb53fb58ac557277a7e516b3"
CACHE_DIR="${TLA_CACHE_DIR:-$HOME/.cache/tla}"
JAR="$CACHE_DIR/tla2tools.jar"
STATES="$(mktemp -d "${TMPDIR:-/tmp}/tla-states.XXXXXX")"
trap 'rm -rf "$STATES"' EXIT

if [[ ! -f "$JAR" ]] || ! echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet - 2>/dev/null; then
  mkdir -p "$CACHE_DIR"
  echo "downloading tla2tools.jar $TLA_VERSION..."
  curl -fsSL -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar"
  echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet -
fi

cd "$(dirname "$0")/../specs"
TLC=(java -XX:+UseParallelGC -Xmx"${TLA_HEAP:-8g}" -cp "$JAR" tlc2.TLC -workers auto -deadlock)

echo "== phase 1: vacuity probes (each MUST find its witness trace)"
probe_fail=0
for cfg in Probe*.cfg; do
  probe="${cfg%.cfg}"
  log="$STATES/$probe.log"
  if "${TLC[@]}" -metadir "$STATES/$probe" -config "$cfg" Probes.tla >"$log" 2>&1; then
    echo "VACUOUS: $probe found no witness — the feature it probes is unreachable"
    probe_fail=1
  elif grep -q "Invariant $probe is violated" "$log"; then
    echo "ok: $probe witnessed ($(grep -m1 -oE '[0-9]+ distinct states' "$log" || true))"
  else
    echo "ERROR: $probe failed for the wrong reason:"
    tail -20 "$log"
    probe_fail=1
  fi
done
[[ "$probe_fail" -eq 0 ]] || exit 1

if [[ "${TLA_SCOPE:-full}" == "ci" ]]; then
  echo "== phase 2 (ci scope): safety + liveness at the CI-sized constants"
  "${TLC[@]}" -metadir "$STATES/ci" -config SchedulerCI.cfg Scheduler.tla
else
  echo "== phase 2: liveness at the reduced horizon"
  "${TLC[@]}" -metadir "$STATES/liveness" -config SchedulerLiveness.cfg Scheduler.tla

  echo "== phase 3: exhaustive safety at the full constants"
  "${TLC[@]}" -metadir "$STATES/full" -config Scheduler.cfg Scheduler.tla
fi
