#!/usr/bin/env bash
# Model-check specs/Scheduler.tla with TLC — same run locally and in CI.
# The proof stack (BUILD.md PR1.7): TLA+ proves the DESIGN.md protocol; the
# sim harness proves the implementation refines it (labeled batch ≙ TLA
# action); the conformance suite pins the SQL to the atomic-action assumption.
set -euo pipefail

TLA_VERSION="v1.8.0"
TLA_SHA256="cc4803dce2a8ffaf0f5920a9dc39df4b5ee34ab4cb53fb58ac557277a7e516b3"
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
