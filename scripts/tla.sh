#!/usr/bin/env bash
# Model-check specs/Scheduler.tla with TLC — same run locally and in CI.
# The proof stack: TLA+ proves the DESIGN.md protocol; the
# sim harness proves the implementation refines it (labeled batch ≙ TLA
# action); the conformance suite pins the SQL to the atomic-action assumption.
#
# Layout is maximum-concurrency: phase 1 runs every Probe*.cfg vacuity probe
# at once; phase 2 runs the exhaustive-safety scope AND the five liveness
# property groups (SchedulerLiveness1-5.cfg, listed explicitly in the loops
# below, so a new group must be added there) as concurrent TLC processes with
# explicit worker and heap budgets. Liveness is split into groups because the
# temporal check's final pass is sequential per process: groups 1-2 carry the
# cheap properties three at a time, and each heavy fairness property (groups
# 3-5) gets its own process and core. Every group uses `-lncheck final` (skip the periodic mid-run passes;
# a green gate re-checks everything at the end anyway; on a failure, rerun a
# single group without it to localize).
#
# Once safety finishes, the two retryTask revival scopes (SchedulerRetry.cfg and
# SchedulerRetryInfra.cfg) split safety's share while the liveness groups continue.
#
# TLA_SCOPE=ci replaces phase 2 with SchedulerCI.cfg (safety + liveness at the
# CI-sized scope, ~570k states) followed by both revival scopes — the PR gate on
# small runners.
set -euo pipefail

TLA_SHA256="eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAR="$REPO_ROOT/tools/tla/tla2tools.jar"
STATES="$(mktemp -d "${TMPDIR:-/tmp}/tla-states.XXXXXX")"
trap 'rm -rf "$STATES"' EXIT

if [[ ! -f "$JAR" ]]; then
  echo "tla.sh: INFRA ERROR: vendored TLA checker is missing: $JAR" >&2
  exit 1
fi
actual="$(sha256sum "$JAR" 2>/dev/null | awk 'NR == 1 {print $1}' || true)"
if [[ "$actual" != "$TLA_SHA256" ]]; then
  echo "tla.sh: INFRA ERROR: vendored TLA checker failed integrity (expected $TLA_SHA256, got ${actual:-unreadable})" >&2
  exit 1
fi

cd "$REPO_ROOT/specs"

# Heap sizes to the environment instead of an artificial fixed number: a
# tight heap makes TLC spill its fingerprint set to disk, which costs more
# wall clock than any core count can win back. 70% of the enclosing cgroup
# limit (or of available RAM when unconfined), floor 2g, divided among the
# concurrent processes below.
if [[ -z "${TLA_HEAP_MB:-}" ]]; then
  cg="/sys/fs/cgroup$(awk -F: '$1=="0" {print $3}' /proc/self/cgroup)/memory.max"
  if [[ -r "$cg" && "$(cat "$cg")" != "max" ]]; then
    limit_bytes="$(cat "$cg")"
  else
    limit_bytes="$(($(awk '/MemAvailable/ {print $2}' /proc/meminfo) * 1024))"
  fi
  TLA_HEAP_MB=$((limit_bytes * 7 / 10 / 1024 / 1024))
  [[ "$TLA_HEAP_MB" -lt 2048 ]] && TLA_HEAP_MB=2048
fi
CORES="$(nproc)"

# Newest JVM available (falls back to PATH java): newer collectors and JIT
# are free wall clock for a state-space grinder.
JAVA_BIN="${TLA_JAVA:-}"
if [[ -z "$JAVA_BIN" ]]; then
  for candidate in /usr/lib/jvm/java-25-openjdk-*/bin/java /usr/lib/jvm/java-2*-openjdk-*/bin/java; do
    [[ -x "$candidate" ]] && JAVA_BIN="$candidate" && break
  done
  [[ -n "$JAVA_BIN" ]] || JAVA_BIN="$(command -v java)"
fi
echo "tla.sh: heap budget ${TLA_HEAP_MB}m, $CORES cores, $("$JAVA_BIN" -version 2>&1 | head -1)"

tlc() { # tlc <mem_mb> <workers> <extra...>
  # TLC's documented high-throughput layout: the fingerprint set lives in
  # OFF-HEAP direct memory (no GC pressure, no heap spill), the heap keeps
  # the state queue and liveness graph. Budget: half direct, half heap.
  local mem="$1" workers="$2"
  shift 2
  "$JAVA_BIN" -XX:+UseParallelGC -Xmx"$((mem / 2))m" \
    -XX:MaxDirectMemorySize="$((mem / 2))m" \
    -Dtlc2.tool.fp.FPSet.impl=tlc2.tool.fp.OffHeapDiskFPSet \
    -cp "$JAR" tlc2.TLC -workers "$workers" -deadlock "$@"
}

report() { # report <name> <tlc-exit-code> <log> — 0 iff the model is clean
  local name="$1" code="$2" log="$3"
  if [[ "$code" -eq 0 ]]; then
    echo "$name: $(grep -m1 'Model checking completed' "$log" || echo done)"
    return 0
  fi
  # TLC's verdict exits are 10 (assumption), 11 (deadlock), 12 (safety),
  # 13 (liveness). Anything else is the CHECKER failing — OOM, disk full,
  # parse — not the model. The two must be labeled distinctly: a nightly
  # run of six concurrent TLC processes on a 7 GB runner once starved out,
  # printed three lasso-less trace fragments, and read as a phantom spec
  # violation until a well-resourced rerun came back clean.
  if [[ "$code" -ge 10 && "$code" -le 13 ]]; then
    echo "$name: MODEL VIOLATION (TLC exit $code) — a real counterexample follows:"
  else
    echo "$name: INFRA ERROR (TLC exit $code) — the checker failed, NOT the model; rerun with more resources:"
  fi
  grep -n -m5 -E 'Error|Exception|OutOfMemory|No space' "$log" || true
  tail -40 "$log"
  return 1
}

run_one() { # run_one <name> <cfg> <mem_mb> <workers> <extra...>
  local name="$1" cfg="$2" mem="$3" workers="$4"
  shift 4
  local code=0
  tlc "$mem" "$workers" "$@" -metadir "$STATES/$name" -config "$cfg" \
    Scheduler.tla >"$STATES/$name.log" 2>&1 || code=$?
  report "$name" "$code" "$STATES/$name.log"
}

# The small hosted-delivery model supplies the fair tick invocations assumed
# by Scheduler. Keep it on every existing scope without changing those scopes.
wake_heap=$((TLA_HEAP_MB < 1024 ? TLA_HEAP_MB : 1024))
wake_code=0
tlc "$wake_heap" 2 -metadir "$STATES/wake-delivery" -config WakeDelivery.cfg \
  WakeDelivery.tla >"$STATES/wake-delivery.log" 2>&1 || wake_code=$?
report "hosted wake delivery" "$wake_code" "$STATES/wake-delivery.log" || exit 1

# The child-task completion event (specs/ChildTasks.tla), also small and on
# every scope. Three configurations cover both answers to the same-queue rule
# and a child in another queue. Its vacuity probes run with the others in
# phase 1, which a TLA_ONLY liveness job skips.
for cfg in ChildTasks ChildTasksRefuse ChildTasksCrossQueue; do
  child_code=0
  tlc "$wake_heap" 2 -metadir "$STATES/$cfg" -config "$cfg.cfg" \
    ChildTasks.tla >"$STATES/$cfg.log" 2>&1 || child_code=$?
  report "child tasks ($cfg)" "$child_code" "$STATES/$cfg.log" || exit 1
done

# TLA_ONLY=<safety|liveness1..liveness5> runs exactly one target with the
# FULL budget — for CI matrix jobs where each runner hosts one TLC process.
# Concurrent groups on a 7 GB runner starve each other: the shared disk
# filling under three liveness graphs once failed all three heavy groups
# in the same minute. Probes ride only the safety job (one vacuity check
# per matrix run is enough).
if [[ -n "${TLA_ONLY:-}" && "${TLA_ONLY}" != "safety" ]]; then
  case "$TLA_ONLY" in
    liveness[1-5]) ;;
    *) echo "TLA_ONLY must be safety or liveness1..liveness5, got: $TLA_ONLY" >&2; exit 2 ;;
  esac
  g="${TLA_ONLY#liveness}"
  run_one "$TLA_ONLY" "SchedulerLiveness$g.cfg" "$TLA_HEAP_MB" "$CORES" -lncheck final
  exit $?
fi

echo "== phase 1: vacuity probes, concurrent (each MUST find its witness trace)"
# Mutants of the child-task model. Each entry of ChildTasks.mutants.json bends
# or deletes one guard of the protocol, and some pass configuration must then
# FAIL. A probe shows an invariant can fail. Only a mutant shows that a guard is
# held by anything: a model can stay green with a guard deleted when no
# invariant speaks for it. A mutant whose text is not found exactly once, or
# whose run ends in anything but a verdict, is an error and not a catch.
echo "== phase 1: child-task model mutants (each MUST be caught)"
mutant_fail=0
python3 - "$JAVA_BIN" "$JAR" "$STATES/mutants" <<'PY' || mutant_fail=1
import json, os, shutil, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

java, jar, out = sys.argv[1:4]
spec = open("ChildTasks.tla").read()
mutants = json.load(open("ChildTasks.mutants.json"))
configs = ("ChildTasks.cfg", "ChildTasksRefuse.cfg")


def check(mutant):
    name, find = mutant["name"], mutant["find"]
    if spec.count(find) != 1:
        return name, "ERROR", f"its text occurs {spec.count(find)} times in ChildTasks.tla, not once"
    scratch = os.path.join(out, name)
    os.makedirs(scratch)
    with open(os.path.join(scratch, "ChildTasks.tla"), "w") as handle:
        handle.write(spec.replace(find, mutant["replace"]))
    for config in configs:
        shutil.copy(config, scratch)
        run = subprocess.run(
            [java, "-Xmx512m", "-cp", jar, "tlc2.TLC", "-workers", "1", "-deadlock",
             "-metadir", os.path.join(scratch, "meta-" + config), "-config", config, "ChildTasks.tla"],
            cwd=scratch, capture_output=True, text=True,
        )
        if run.returncode in (12, 13):
            line = next((l.strip() for l in run.stdout.splitlines() if "violated" in l), "a violation")
            return name, "caught", f"{config}: {line}"
        if run.returncode != 0:
            return name, "ERROR", f"TLC exit {run.returncode} under {config}: the checker failed, not the model"
    return name, "SURVIVED", f"every configuration still passes, so nothing holds: {mutant['guard']}"


names = [mutant["name"] for mutant in mutants]
if not names or len(set(names)) != len(names):
    sys.exit("ChildTasks.mutants.json must list mutants under distinct names")
with ThreadPoolExecutor(4) as pool:
    verdicts = list(pool.map(check, mutants))
for name, verdict, detail in verdicts:
    print(f"{verdict}: {name} ({detail})")
caught = sum(verdict == "caught" for _, verdict, _ in verdicts)
print(f"child-task mutants: {caught} of {len(verdicts)} caught")
sys.exit(0 if caught == len(verdicts) else 1)
PY

probe_pids=()
probe_names=()
probe_heap=$((TLA_HEAP_MB / 8)); [[ "$probe_heap" -lt 512 ]] && probe_heap=512
for cfg in Probe*.cfg; do
  probe="${cfg%.cfg}"
  tlc "$probe_heap" 4 -metadir "$STATES/$probe" -config "$cfg" Probes.tla \
    >"$STATES/$probe.log" 2>&1 &
  probe_pids+=($!)
  probe_names+=("$probe")
done
probe_fail=0
for i in "${!probe_pids[@]}"; do
  probe="${probe_names[$i]}"
  log="$STATES/$probe.log"
  if wait "${probe_pids[$i]}"; then
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
# The child-task model's probes. Each names the invariant it must violate: two
# show an invariant is not vacuous, three that a behaviour is reachable.
for pair in NonAtomicEmit:TerminalImpliesDone ForgedEmit:DoneIsFirstOutcome \
  WokenParent:ProbeNoWokenParent SecondOutcome:ProbeNoSecondOutcome \
  RefusedAwait:ProbeNoRefusedAwait; do
  probe="ChildTasksProbe${pair%%:*}"
  invariant="${pair##*:}"
  log="$STATES/$probe.log"
  if tlc "$probe_heap" 2 -metadir "$STATES/$probe" -config "$probe.cfg" \
    ChildTasks.tla >"$log" 2>&1; then
    echo "VACUOUS: $probe found no witness against $invariant"
    probe_fail=1
  elif grep -q "Invariant $invariant is violated" "$log"; then
    echo "ok: $probe witnessed ($(grep -m1 -oE '[0-9]+ distinct states' "$log" || true))"
  else
    echo "ERROR: $probe failed for the wrong reason:"
    tail -20 "$log"
    probe_fail=1
  fi
done
[[ "$probe_fail" -eq 0 && "$mutant_fail" -eq 0 ]] || exit 1
# Probes fail BY DESIGN; TLC drops counterexample trace files next to the
# spec when they do — throwaway artifacts, removed here.
rm -f ./*_TTrace_*.tla ./*_TTrace_*.bin

if [[ "${TLA_ONLY:-}" == "safety" ]]; then
  echo "== safety only (TLA_ONLY), full budget"
  run_one safety Scheduler.cfg "$TLA_HEAP_MB" "$CORES"
  exit $?
elif [[ "${TLA_SCOPE:-full}" == "ci" ]]; then
  echo "== phase 2 (ci scope): safety + liveness at the CI-sized constants"
  tlc "$TLA_HEAP_MB" "$CORES" -metadir "$STATES/ci" -config SchedulerCI.cfg Scheduler.tla
  echo "== phase 2 (ci scope): retryTask revival at its own small constants"
  tlc "$TLA_HEAP_MB" "$CORES" -metadir "$STATES/retry" -config SchedulerRetry.cfg Scheduler.tla
  echo "== phase 2 (ci scope): retryTask revival after infrastructure retries, safety only"
  tlc "$TLA_HEAP_MB" "$CORES" -metadir "$STATES/retry-infra" -config SchedulerRetryInfra.cfg Scheduler.tla
else
  echo "== phase 2: exhaustive safety + 5 liveness groups, all concurrent"
  # Budget shares are shaped by measurement, not symmetry. The temporal
  # check's final pass is sequential per process and HEAP-bound (a starved
  # slice ran it 3-4x slower), so each of the three heavy fairness
  # properties (groups 3-5) gets its OWN process, a fat heap slice, and
  # therefore its own core for the final pass — the wall clock is the
  # slowest single property, not their sum. Groups 1-2 (cheap trios) and
  # safety finish in about a minute regardless.
  safety_heap=$((TLA_HEAP_MB / 4))
  heavy_heap=$((TLA_HEAP_MB / 5))
  small_heap=$((TLA_HEAP_MB / 16))
  safety_workers=$((CORES / 3)); [[ "$safety_workers" -lt 2 ]] && safety_workers=2
  heavy_workers=$((CORES / 6)); [[ "$heavy_workers" -lt 2 ]] && heavy_workers=2
  small_workers=$((CORES / 12)); [[ "$small_workers" -lt 2 ]] && small_workers=2

  tlc "$safety_heap" "$safety_workers" -metadir "$STATES/full" \
    -config Scheduler.cfg Scheduler.tla >"$STATES/safety.log" 2>&1 &
  safety_pid=$!
  group_pids=()
  for g in 1 2 3 4 5; do
    if [[ "$g" -ge 3 ]]; then heap="$heavy_heap"; workers="$heavy_workers"
    else heap="$small_heap"; workers="$small_workers"; fi
    tlc "$heap" "$workers" -lncheck final -metadir "$STATES/liveness$g" \
      -config "SchedulerLiveness$g.cfg" Scheduler.tla >"$STATES/liveness$g.log" 2>&1 &
    group_pids+=($!)
  done

  fail=0
  code=0
  wait "$safety_pid" || code=$?
  if report safety "$code" "$STATES/safety.log"; then
    grep -E "states generated|distinct states" "$STATES/safety.log" | tail -1
  else
    fail=1
  fi
  # The retryTask revival scopes run at their own small constants on halves of
  # safety's freed share, so the shares still add up to the budget and the
  # other scopes keep MaxRetries 0.
  retry_heap=$((safety_heap / 2))
  retry_workers=$((safety_workers / 2)); [[ "$retry_workers" -lt 2 ]] && retry_workers=2
  tlc "$retry_heap" "$retry_workers" -metadir "$STATES/retry" \
    -config SchedulerRetry.cfg Scheduler.tla >"$STATES/retry.log" 2>&1 &
  retry_pid=$!
  tlc "$retry_heap" "$retry_workers" -metadir "$STATES/retry-infra" \
    -config SchedulerRetryInfra.cfg Scheduler.tla >"$STATES/retry-infra.log" 2>&1 &
  retry_infra_pid=$!
  for g in 1 2 3 4 5; do
    code=0
    wait "${group_pids[$((g - 1))]}" || code=$?
    report "liveness group $g" "$code" "$STATES/liveness$g.log" || fail=1
  done
  code=0
  wait "$retry_pid" || code=$?
  report "retryTask revival" "$code" "$STATES/retry.log" || fail=1
  code=0
  wait "$retry_infra_pid" || code=$?
  report "retryTask revival after infrastructure retries" "$code" "$STATES/retry-infra.log" || fail=1
  exit "$fail"
fi
