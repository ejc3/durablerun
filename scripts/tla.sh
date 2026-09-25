#!/usr/bin/env bash
# Model-check specs/Scheduler.tla with TLC — same run locally and in CI.
# The proof stack: TLA+ proves the DESIGN.md protocol; the
# sim harness proves the implementation refines it (labeled batch ≙ TLA
# action); the conformance suite pins the SQL to the atomic-action assumption.
#
# Phase 1 serves the side models and the vacuity probes. Each side model's pass
# configurations must pass, each of its mutants must be caught, and every probe,
# the Probe*.cfg family against Probes.tla and each <Model>Probe*.cfg family
# against <Model>Probes.tla, must find its witness. The probes run in waves the
# heap budget can hold. Phase 2 runs the exhaustive-safety scope AND the five liveness
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
side_heap=$((TLA_HEAP_MB < 1024 ? TLA_HEAP_MB : 1024))
run_small() { # run_small <name> <cfg> <module>: a side model, on every scope
  local code=0
  tlc "$side_heap" 2 -metadir "$STATES/$2" -config "$2" "$3" >"$STATES/$2.log" 2>&1 || code=$?
  report "$1" "$code" "$STATES/$2.log"
}
run_small "hosted wake delivery" WakeDelivery.cfg WakeDelivery.tla || exit 1

# The side models: the child-task completion event (specs/ChildTasks.tla),
# sagas (specs/Sagas.tla), and the purge of terminal task units
# (specs/Retention.tla). A side model is a <Model>.tla enrolled by the mutant
# list beside it, <Model>.mutants.json. What belongs to a model is decided here,
# once, from file names: a cfg belongs to the enrolled model with the longest
# name that begins it, a <Model>Probe*.cfg of it is a vacuity probe, and every
# other cfg of it is a pass configuration.
shopt -s nullglob
side_models=()
for list in *.mutants.json; do side_models+=("${list%.mutants.json}"); done
owner_of() { # owner_of <cfg>: the enrolled model it belongs to, or nothing
  local cfg="$1" model best=''
  for model in "${side_models[@]}"; do
    [[ "$cfg" == "$model"* && "${#model}" -gt "${#best}" ]] && best="$model"
  done
  printf '%s' "$best"
}
pass_cfgs_of() { # pass_cfgs_of <model>: its pass configurations, one a line
  local model="$1" cfg
  for cfg in "$model"*.cfg; do
    [[ "$cfg" == "$model"Probe* || "$(owner_of "$cfg")" != "$model" ]] && continue
    printf '%s\n' "$cfg"
  done
}
checked_part() { sed -n '/^SPECIFICATION/,$p' "$1"; } # what a cfg checks, less its constants

# Nothing beside the specs may go unchecked, and no model may check less under
# one of its configurations than under another. These cost no TLC run, so every
# scope runs them. A list lost in a merge would otherwise take its model's
# configurations, probes, and mutants out of the gate with the gate still green.
structure_ok=1
complain() {
  echo "tla.sh: $*" >&2
  structure_ok=0
}
[[ "${#side_models[@]}" -gt 0 ]] || complain "no <Model>.mutants.json beside the specs"
for module in *.tla; do
  case "$module" in Scheduler.tla | Probes.tla | WakeDelivery.tla) continue ;; esac
  model="${module%.tla}"
  model="${model%Probes}"
  [[ " ${side_models[*]} " == *" $model "* ]] ||
    complain "$module is checked by nothing: no $model.mutants.json enrols it"
done
for cfg in *.cfg; do
  case "$cfg" in Scheduler*.cfg | Probe*.cfg | WakeDelivery.cfg) continue ;; esac
  [[ -n "$(owner_of "$cfg")" ]] || complain "$cfg belongs to no enrolled model"
done
for model in "${side_models[@]}"; do
  [[ -f "$model.tla" && -f "$model.cfg" && -f "${model}Probes.tla" ]] ||
    complain "$model needs $model.tla, $model.cfg, and ${model}Probes.tla"
  probes=("$model"Probe*.cfg)
  [[ "${#probes[@]}" -gt 0 ]] || complain "$model has no vacuity probe"
  [[ -f "$model.cfg" ]] || continue
  while IFS= read -r cfg; do
    diff <(checked_part "$model.cfg") <(checked_part "$cfg") >/dev/null ||
      complain "$cfg does not check what $model.cfg checks: they may differ in constants only"
  done < <(pass_cfgs_of "$model")
done
probe_cfgs=(*Probe*.cfg)
shopt -u nullglob
[[ "$structure_ok" -eq 1 ]] || exit 1

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

# Every pass configuration of every side model, small, on every scope but a
# TLA_ONLY liveness job, which runs its own target and nothing that could fail
# ahead of it.
mutant_jobs=()
for model in "${side_models[@]}"; do
  mapfile -t cfgs < <(pass_cfgs_of "$model")
  for cfg in "${cfgs[@]}"; do
    run_small "$model ($cfg)" "$cfg" "$model.tla" || exit 1
  done
  mutant_jobs+=("$model:$(IFS=,; printf '%s' "${cfgs[*]}")")
done

# Mutants of the side models.
# Each entry of <Model>.mutants.json bends or deletes one guard of <Model>.tla,
# and some pass configuration of that model must then FAIL. A probe shows an
# invariant can fail. Only a mutant shows that a guard is held by anything: a
# model can stay green with a guard deleted when no invariant speaks for it. A
# mutant runs under each pass configuration REDUCED to the one property its
# entry names, and is caught only when that property is violated. Checked among
# the others, TLC reports whichever violation it meets first, so the name in an
# entry would follow the order of a list and not what holds the guard. A mutant
# whose text is not found exactly once, or whose run ends in anything but a
# verdict, is an error and not a catch. And every property a model checks must
# be named by some mutant: one that none names can be deleted from every
# configuration with the gate still green.
echo "== phase 1: side-model mutants (each MUST be caught)"
command -v python3 >/dev/null || {
  echo "tla.sh: INFRA ERROR: the mutant check needs python3" >&2
  exit 1
}
mutant_code=0
python3 - "$JAVA_BIN" "$JAR" "$STATES/mutants" "${mutant_jobs[@]}" <<'PY' || mutant_code=$?
import json, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor

java, jar, out = sys.argv[1:4]
# Each further argument is <Model>:<cfg>,<cfg>..., the model's pass configurations as
# the shell above decided them. There is no second definition of them here.
models = [(model, configs.split(",")) for model, _, configs in (job.partition(":") for job in sys.argv[4:])]


SECTION = re.compile(r"^(INVARIANTS?|PROPERTY|PROPERTIES)\b(.*)$")


def checked(text):
    # A cfg's lines less its INVARIANT and PROPERTY sections, and what those sections name.
    kept, kinds, kind = [], {}, None
    for line in text.splitlines():
        header = SECTION.match(line)
        if header:
            kind = "INVARIANT" if header.group(1).startswith("INV") else "PROPERTY"
            kinds.update((name, kind) for name in header.group(2).split())
        elif kind and re.fullmatch(r"\s+\w+\s*", line):
            kinds[line.strip()] = kind
        else:
            kind = None
            kept.append(line)
    return kept, kinds


def check(job):
    model, spec, configs, mutant = job
    name, find, expect = mutant["name"], mutant["find"], mutant["caughtBy"]
    if spec.count(find) != 1:
        return name, "ERROR", f"its text occurs {spec.count(find)} times in {model}.tla, not once"
    scratch = os.path.join(out, model, name)
    os.makedirs(scratch)
    with open(os.path.join(scratch, model + ".tla"), "w") as handle:
        handle.write(spec.replace(find, mutant["replace"]))
    others = []
    for config in configs:
        kept, kinds = checked(open(config).read())
        if expect not in kinds:
            others.append(f"{config}: does not check {expect}")
            continue
        with open(os.path.join(scratch, config), "w") as handle:
            handle.write("\n".join(kept) + f"\n{kinds[expect]}\n  {expect}\n")
        run = subprocess.run(
            [java, "-Xmx512m", "-cp", jar, "tlc2.TLC", "-workers", "1", "-deadlock", "-noGenerateSpecTE",
             "-metadir", os.path.join(scratch, "meta-" + config), "-config", config, model + ".tla"],
            cwd=scratch, capture_output=True, text=True,
        )
        if run.returncode == 0:
            continue
        # TLC's verdict exits are 10 to 13, as report() has them. Anything else
        # is the checker failing.
        if not 10 <= run.returncode <= 13:
            return name, "ERROR", f"TLC exit {run.returncode} under {config}: the checker failed, not the model"
        violated = [line.strip() for line in run.stdout.splitlines() if "violated" in line]
        if any(f" {expect} is violated" in line or f" {expect} was violated" in line for line in violated):
            return name, "caught", f"{config}: {expect}"
        others.append(f"{config}: {violated[0] if violated else f'TLC exit {run.returncode}'}")
    if others:
        return name, "WRONG-PROPERTY", f"expected {expect} and saw only {'; '.join(others)}"
    return name, "SURVIVED", f"{expect} still holds under every configuration, so it does not hold: {mutant['guard']}"


failed = False
for model, configs in models:
    path = model + ".mutants.json"
    spec = open(model + ".tla").read()
    mutants = json.load(open(path))
    names = [mutant["name"] for mutant in mutants]
    if configs == [""] or not names or len(set(names)) != len(names):
        sys.exit(f"{path} needs a pass configuration and mutants under distinct names")
    with ThreadPoolExecutor(4) as pool:
        verdicts = list(pool.map(check, [(model, spec, configs, mutant) for mutant in mutants]))
    for name, verdict, detail in verdicts:
        print(f"{verdict}: {model}/{name} ({detail})")
    caught = sum(verdict == "caught" for _, verdict, _ in verdicts)
    print(f"{model} mutants: {caught} of {len(verdicts)} caught")
    failed = failed or caught != len(verdicts)
    named = {mutant["caughtBy"] for mutant in mutants}
    for unnamed in sorted(set(checked(open(configs[0]).read())[1]) - named):
        print(f"UNNAMED: {model}/{unnamed} is checked and no mutant names it, so nothing shows it can fail")
        failed = True
sys.exit(3 if failed else 0)
PY
# Exit 3 is the check's verdict. Any other failure is the check itself failing,
# which says nothing about the model.
mutant_fail=0
if [[ "$mutant_code" -eq 3 ]]; then
  mutant_fail=1
elif [[ "$mutant_code" -ne 0 ]]; then
  echo "tla.sh: INFRA ERROR: the mutant check itself failed (exit $mutant_code)" >&2
  exit 1
fi

echo "== phase 1: vacuity probes, in waves (each MUST find its witness trace)"
# A probe is a cfg named after the one invariant or property it must violate,
# defined in its family's module: Probe*.cfg in Probes.tla, <Model>Probe*.cfg in
# <Model>Probes.tla. A new cfg is enrolled by existing. A probe fails by design,
# so it writes no counterexample trace beside the specs, and a real violation's
# trace is never cleaned away with the probes'.
#
# TLC takes its off-heap share up front, so the probes run in waves the heap
# budget can hold. All at once, they were killed inside the confined scope for
# memory. A Scheduler probe holds an eighth of the budget. A side-model probe
# explores a few thousand states and holds a small fixed share, as a mutant run does.
scheduler_probe_heap=$((TLA_HEAP_MB / 8)); [[ "$scheduler_probe_heap" -lt 512 ]] && scheduler_probe_heap=512
side_probe_heap=512
probe_fail=0
wave_cfgs=()
wave_pids=()
wave_heap=0
finish_wave() {
  local i probe log
  for ((i = 0; i < ${#wave_pids[@]}; i++)); do
    probe="${wave_cfgs[$i]%.cfg}"
    log="$STATES/$probe.log"
    if wait "${wave_pids[$i]}"; then
      echo "VACUOUS: $probe found no witness — the feature it probes is unreachable"
      probe_fail=1
    elif grep -qE "(Invariant $probe is|Action property $probe is|Temporal property $probe was) violated" "$log"; then
      echo "ok: $probe witnessed ($(grep -m1 -oE '[0-9]+ distinct states' "$log" || true))"
    else
      echo "ERROR: $probe failed for the wrong reason:"
      tail -20 "$log"
      probe_fail=1
    fi
  done
  wave_cfgs=()
  wave_pids=()
  wave_heap=0
}
for cfg in "${probe_cfgs[@]}"; do
  family="${cfg%%Probe*}"
  if [[ -z "$family" ]]; then heap="$scheduler_probe_heap"; workers=4; else heap="$side_probe_heap"; workers=2; fi
  if [[ "${#wave_pids[@]}" -gt 0 && $((wave_heap + heap)) -gt "$TLA_HEAP_MB" ]]; then finish_wave; fi
  tlc "$heap" "$workers" -noGenerateSpecTE -metadir "$STATES/${cfg%.cfg}" \
    -config "$cfg" "${family}Probes.tla" >"$STATES/${cfg%.cfg}.log" 2>&1 &
  wave_cfgs+=("$cfg")
  wave_pids+=($!)
  wave_heap=$((wave_heap + heap))
done
finish_wave
[[ "$probe_fail" -eq 0 && "$mutant_fail" -eq 0 ]] || exit 1

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
