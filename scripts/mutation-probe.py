#!/usr/bin/env python3
"""Does the suite actually catch the removal of the guards it protects?

Every mechanism this repo institutes is believed because the tests are green.
That is the wrong direction of evidence: green proves the tests accept correct
code, and says nothing about whether they REJECT incorrect code. The only way
to find out is to break something on purpose and check that something fails.

Each MUTATION below deletes one guard that a review round paid for. A guard
whose removal nothing notices is a guard that is not being maintained -- the
next refactor can drop it and the build stays green.

Not part of `pnpm verify`: it edits sources and runs the suite once per
mutation, so it is a deliberate audit, not a gate. Run it after adding a
mechanism, and record survivors as coverage gaps.

Usage: mutation-probe.py [-k substring]
"""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (name, file, find, replace, what removing it should break)
MUTATIONS = [
    (
        "followon-provenance-check",
        "packages/core/src/fenced-batch.ts",
        "      assertWritesStamp(at, sql, head, target, false)",
        "      void 0 // MUTATION",
        "a follow-on may write a fenced table without stamping it",
    ),
    (
        "positive-fence-required",
        "packages/core/src/fenced-batch.ts",
        "function hasPositiveFence(sql: string): boolean {",
        "function hasPositiveFence(sql: string): boolean {\n  if (sql) return true // MUTATION",
        "a follow-on may run with no fence at all",
    ),
    (
        "clock-ban-in-followon",
        "packages/core/src/fenced-batch.ts",
        "    if (!isCas && (sql.includes(NOW) || sql.includes(this.now))) {",
        "    if (false && !isCas && (sql.includes(NOW) || sql.includes(this.now))) {",
        "a follow-on may read the clock a second time",
    ),
    (
        "raw-fence-token-check",
        "packages/core/src/fenced-batch.ts",
        "    for (const match of sql.matchAll(/\\$FENCE:([a-zA-Z0-9_-]+)\\$/g)) {",
        "    for (const match of [] as RegExpMatchArray[]) {",
        "a hand-written fence token naming nothing compiles to a dead filter",
    ),
    (
        "activate-task-fence",
        "packages/store-libsql/src/store.ts",
        "         AND task_id = (SELECT f.task_id FROM runs f\n"
        "                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('activate')})`,",
        "         AND task_id = (SELECT f.task_id FROM runs f WHERE ${BY_RUN})`,",
        "a losing duplicate activation clears an armed cancellation deadline",
    ),
    (
        "complete-task-fence",
        "packages/store-libsql/src/store.ts",
        "       WHERE task_id = (SELECT f.task_id FROM runs f\n"
        "                        WHERE ${BY_RUN} AND f.fence_stamp = ${b.fence('complete')})",
        "       WHERE task_id = (SELECT f.task_id FROM runs f WHERE ${BY_RUN})",
        "a losing complete still marks the task completed",
    ),
    (
        "emit-wake-event-correlation",
        "packages/store-libsql/src/store.ts",
        "         AND wake_event = ?\n",
        "         AND ? IS NOT NULL\n",
        "an emit wakes a run that is not parked on that event",
    ),
    (
        "emit-wake-step-correlation",
        "packages/store-libsql/src/store.ts",
        "                       AND (runs.wake_step IS NULL OR s.step_name = runs.wake_step))",
        "                       AND (runs.wake_step IS NULL OR ? IS NOT NULL))",
        "an emit delivers to a run parked at a DIFFERENT step of the same event",
    ),
    (
        "successor-ownership",
        "packages/store-libsql/src/store.ts",
        "           AND NOT ${successor.mine('?', 'f.task_id', '?')}`,\n"
        "        [successorId, retryDelayMs, retryDelayMs, runId, successorId, runId],",
        "           AND NOT ${fenced('runs', BY_RUN, b.fence('successor'))} AND ? IS NOT NULL`,\n"
        "        [successorId, retryDelayMs, retryDelayMs, runId, successorId, runId],",
        "a replayed failure re-inserts a successor that has since been claimed",
    ),
    (
        "schema-fault-is-permanent",
        "packages/store-libsql/src/executor.ts",
        "      if (SCHEMA_FAULT.test(String(error))) {",
        "      if (false && SCHEMA_FAULT.test(String(error))) {",
        "an un-migrated database is retried as a transient outage",
    ),
    (
        "spawn-primary-key-guard",
        "packages/store-libsql/src/store.ts",
        "       WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)",
        "       WHERE ? IS NOT NULL",
        "a task-id collision crashes spawn instead of losing",
    ),
]

# The suite, minus the legs whose cost dwarfs their value here: the fuzz shards
# and the real-process chaos tests each add minutes per mutation.
TEST_CMD = [
    "pnpm", "exec", "vitest", "run",
    "--exclude", "packages/conformance/test/fuzz-*",
    "--exclude", "packages/driver/test/chaos-process.test.ts",
]


def run_suite() -> tuple[bool, str]:
    r = subprocess.run(TEST_CMD, cwd=ROOT, capture_output=True, text=True)
    return r.returncode == 0, r.stdout


def assert_clean() -> None:
    """Refuse to start with uncommitted changes, and say why.

    This probe edits sources and restores them in a `finally`. A `finally`
    does not run when the process is KILLED — and this one was, mid-run, by
    the OOM killer while running the suite for the eleventh time. It left a
    mutated `store.ts` behind: a fence quietly removed from `complete`, in a
    working tree that looked like ordinary in-progress work.

    That is the worst possible artefact for a tool whose whole job is
    introducing plausible-looking defects, so the guard is placement rather
    than care: starting from a clean tree means anything this leaves behind
    is visible in `git status` as the only change, and `git checkout --` is
    always the right recovery.
    """
    dirty = subprocess.run(
        ["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True
    ).stdout.strip()
    if dirty:
        print(
            "mutation-probe: refusing to run with a dirty tree.\n"
            "  This tool edits sources and restores them afterwards; if it is killed\n"
            "  mid-run the restore does not happen, and a mutation left in a tree that\n"
            "  already had changes is indistinguishable from your own work.\n"
            "  Commit or stash first. If a previous run WAS killed, the leftover is\n"
            "  below and `git checkout -- <file>` is the fix:\n"
            f"{dirty}",
            file=sys.stderr,
        )
        raise SystemExit(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="", help="only mutations whose name contains this")
    args = ap.parse_args()

    assert_clean()
    green, _ = run_suite()
    if not green:
        print("baseline is RED — fix the suite before probing it", file=sys.stderr)
        return 2
    print("baseline green\n")

    survivors = []
    for name, rel, find, replace, breaks in MUTATIONS:
        if args.k and args.k not in name:
            continue
        path = ROOT / rel
        original = path.read_text()
        if find not in original:
            print(f"  ?? {name}: pattern not found in {rel} — the mutation is stale")
            survivors.append((name, "stale pattern"))
            continue
        try:
            path.write_text(original.replace(find, replace, 1))
            caught, out = run_suite()
            if caught:
                print(f"  !! {name}: SURVIVED — nothing failed. {breaks}")
                survivors.append((name, breaks))
            else:
                failed = [l for l in out.splitlines() if l.strip().startswith("FAIL")]
                first = failed[0].strip()[:90] if failed else "(suite failed)"
                print(f"  ok {name}: caught by {first}")
        finally:
            path.write_text(original)

    print()
    if survivors:
        print(f"{len(survivors)} mutation(s) survived — each is a guard nothing is maintaining:")
        for name, why in survivors:
            print(f"  - {name}: {why}")
        return 1
    print("every mutation was caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
