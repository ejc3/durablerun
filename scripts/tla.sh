#!/usr/bin/env bash
# Model-check specs/Scheduler.tla with TLC — same run locally and in CI.
# The proof stack (BUILD.md PR1.7): TLA+ proves the DESIGN.md protocol; the
# sim harness proves the implementation refines it (labeled batch ≙ TLA
# action); the conformance suite pins the SQL to the atomic-action assumption.
set -euo pipefail

TLA_VERSION="v1.8.0"
TLA_SHA256="936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88"
CACHE_DIR="${TLA_CACHE_DIR:-$HOME/.cache/tla}"
JAR="$CACHE_DIR/tla2tools.jar"

if [[ ! -f "$JAR" ]] || ! echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet - 2>/dev/null; then
  mkdir -p "$CACHE_DIR"
  echo "downloading tla2tools.jar $TLA_VERSION..."
  curl -fsSL -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/$TLA_VERSION/tla2tools.jar"
  echo "$TLA_SHA256  $JAR" | sha256sum -c --quiet -
fi

cd "$(dirname "$0")/../specs"
exec java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
  -workers auto -deadlock -config Scheduler.cfg Scheduler.tla
