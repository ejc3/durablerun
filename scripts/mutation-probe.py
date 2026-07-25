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
        "top-level-or-reach",
        "packages/core/src/fenced-batch.ts",
        "    if (!isCas && s.open === undefined && hasTopLevelOr(sql)) {",
        "    if (false && !isCas && s.open === undefined && hasTopLevelOr(sql)) {",
        "a top-level OR lets a follow-on write rows that did not satisfy its fence",
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
        # Replaces the two per-call-site fence mutations. Those statements no
        # longer CONTAIN a fence a caller could remove — the primitive builds
        # the selection — so the mutation moves to the generator, where one
        # entry now covers all twenty-two generated follow-ons instead of two
        # covering two. That the old mutations went stale rather than passing
        # is the probe reporting the refactor accurately.
        "generated-selection-fence",
        "packages/core/src/fenced-batch.ts",
        "    const selection = `${spec.key} IN (SELECT f.${spec.column} FROM ${spec.from} f\n"
        "                       WHERE ${src}f.fence_stamp = ${fence})`",
        "    const selection = `${spec.key} IN (SELECT f.${spec.column} FROM ${spec.from} f\n"
        "                       WHERE ${src}1 = 1)`",
        "every generated follow-on acts on rows this batch never wrote",
    ),
    (
        "generated-narrow-widens",
        "packages/core/src/fenced-batch.ts",
        "    const narrow = spec.narrow ? `\\n         AND (${spec.narrow})` : ''",
        "    const narrow = spec.narrow ? `\\n         OR (${spec.narrow})` : ''",
        "a narrowing clause that WIDENS the set instead of shrinking it",
    ),
    (
        # The generator interpolates the caller's correlation into a boolean
        # position. Unbracketed, `a OR b` binds as `a OR (b AND fence)` and
        # every row matching `a` enters the selection unstamped -- the class
        # the generator exists to prevent, inside the generator.
        "generated-where-parens",
        "packages/core/src/fenced-batch.ts",
        "    const src = spec.where ? `(${spec.where}) AND ` : ''",
        "    const src = spec.where ? `${spec.where} AND ` : ''",
        "a disjunctive correlation lets unstamped rows into a generated selection",
    ),
    (
        "generated-update-provenance",
        "packages/core/src/fenced-batch.ts",
        "    const provenance = `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_at_ms = (SELECT MIN(f.fence_at_ms) FROM ${spec.from} f\n"
        "                        WHERE ${src}f.fence_stamp = ${fence})`\n"
        "    return this.add({\n"
        "      name,\n"
        "      kind: 'followOn',\n"
        "      target: spec.target,",
        "    const provenance = `,\\n         fence_stamp = fence_stamp,\n"
        "         fence_at_ms = (SELECT MIN(f.fence_at_ms) FROM ${spec.from} f\n"
        "                        WHERE ${src}f.fence_stamp = ${fence})`\n"
        "    return this.add({\n"
        "      name,\n"
        "      kind: 'followOn',\n"
        "      target: null,",
        "a generated UPDATE can leave stale provenance on every row it writes",
    ),
    (
        "seal-intermediate-fence",
        "packages/core/src/fenced-batch.ts",
        "    return this.derived(name, {\n      ...spec,",
        "    if (name) return this\n    return this.derived(name, {\n      ...spec,",
        "an exact replay can reuse an intermediate fence left by its first execution",
    ),
    (
        # The one condition holding the wake predicate's two subqueries to the
        # same row. Redundant for any single row, load-bearing across two.
        "emit-wake-one-witness",
        "packages/store-libsql/src/store.ts",
        "                       AND s.queue = runs.queue\n",
        "",
        "two wait rows, each disqualifying, combine into a wake",
    ),
    (
        "emit-replay-preserves-event-instant",
        "packages/store-libsql/src/store.ts",
        "       ON CONFLICT (queue, event_name) DO UPDATE SET ${fenceSetAt('events')}\n"
        "       WHERE events.fence_stamp IS NOT ${STAMP}`",
        "       ON CONFLICT (queue, event_name) DO UPDATE SET ${FENCE_SET}\n"
        "       WHERE events.fence_stamp IS NOT ${STAMP}`",
        "an older emit replayed after a fresh emit moves its seed to a second instant",
    ),
    (
        # Not correctness: the emit's access path. Removing the driver leaves
        # the same rows written by a full scan of the largest table in the
        # engine, which only a plan pinned to the SHIPPED statement can see.
        "emit-index-driver",
        "packages/store-libsql/src/store.ts",
        "         AND run_id IN (SELECT w.run_id FROM waits w\n"
        "                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting')",
        "         AND ? IS NOT NULL AND ? IS NOT NULL",
        "every emit scans the runs table instead of seeking the waits index",
    ),
    (
        # The cleanup must follow the WAKE, not the event. Fencing it on the
        # event instead selects runs the event stamp never touched, so it
        # deletes nothing and every woken run keeps a spent registration --
        # the mirror of the bug that had it deleting registrations of runs it
        # never woke.
        "emit-cleanup-follows-the-wake",
        "packages/store-libsql/src/store.ts",
        "      fence: 'wake-runs',\n      // Same reason as wake-tasks",
        "      fence: 'event',\n      // Same reason as wake-tasks",
        "the cleanup stops tracking which runs were actually woken",
    ),
    (
        "emit-wake-event-correlation",
        "packages/store-libsql/src/store.ts",
        "         AND wake_event = ?\n",
        "         AND ? IS NOT NULL\n",
        "an emit wakes a run that is not parked on that event",
    ),
    (
        # Weakened to a tautology rather than to `? IS NOT NULL`, which was
        # the old spelling: that adds a bind the statement does not have, so
        # the batch died on the argument-count check and the mutation was
        # "caught" by the compiler without any test of the guard ever running.
        # A mutation must change behaviour, not arity.
        "emit-wake-step-correlation",
        "packages/store-libsql/src/store.ts",
        "                       AND (runs.wake_step IS NULL OR s.step_name = runs.wake_step)",
        "                       AND (runs.wake_step IS NULL OR 1 = 1)",
        "an emit delivers to a run parked at a DIFFERENT step of the same event",
    ),
    (
        "successor-ownership",
        "packages/store-libsql/src/store.ts",
        "           AND NOT ${successorOwned('?', 'f.task_id', 'f.attempt + 1')}`,\n"
        "        [successorId, retryDelayMs, retryDelayMs, runId, successorId],",
        "           AND ? IS NOT NULL`,\n"
        "        [successorId, retryDelayMs, retryDelayMs, runId, successorId],",
        "a replayed failure re-inserts a successor that has since been claimed",
    ),
    (
        "successor-attempt-identity",
        "packages/store-libsql/src/fragments.ts",
        " AND s.task_id = ${task}\n             AND s.attempt = ${attempt})`",
        " AND s.task_id = ${task}\n             AND ${attempt} IS NOT NULL)`",
        "a historical run of the same task answers for the intended successor",
    ),
    (
        "legacy-wait-step-backfill",
        "packages/store-libsql/src/store.ts",
        "         wake_step = COALESCE(wake_step, ${registeredWaitStep('runs')}),",
        "         wake_step = wake_step,",
        "a claimed pre-v3 timed wait loses the only copy of its exact step",
    ),
    (
        "test-token-source-monotonic",
        "packages/store-libsql/src/testing.ts",
        "    token: () => `${namespace}-token-${serial(++tokens)}`,",
        "    token: () => `${namespace}-token-${serial(tokens || ++tokens)}`,",
        "routine fixtures reuse their first provenance seed on every later batch",
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


def restore(path: Path, mutated: str, original: str) -> None:
    """Put the file back, but only over the text this probe actually wrote.

    The dirty-tree guard covers starting on top of someone's work. It does
    nothing about work that arrives DURING a run, and a run is minutes long:
    an edit landing mid-mutation is silently reverted when the `finally` puts
    the pre-run copy back. That happened -- an uncommitted change to
    `store.ts` disappeared under a restore holding a snapshot taken before it
    existed, and it looked like the edit had never been applied.

    Which is this repo's own rule, arriving from the other side: a writer may
    only overwrite state it wrote, and it establishes that by comparing what
    is there against what it left. So compare, and if the file has moved on,
    keep that version beside it and say so rather than deciding the probe's
    snapshot wins.
    """
    if path.read_text() == mutated:
        path.write_text(original)
        return
    kept = path.with_suffix(f"{path.suffix}.probe-conflict")
    kept.write_text(path.read_text())
    path.write_text(original)
    print(
        f"\n  !! {path.name} changed while the probe held it.\n"
        f"     That version is saved at {kept.relative_to(ROOT)}; the file itself is back\n"
        f"     to the pre-run state. Editing sources while this runs cannot work — the\n"
        f"     probe rewrites them between every mutation.",
        file=sys.stderr,
    )


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
        mutated = original.replace(find, replace, 1)
        try:
            path.write_text(mutated)
            caught, out = run_suite()
            if caught:
                print(f"  !! {name}: SURVIVED — nothing failed. {breaks}")
                survivors.append((name, breaks))
            else:
                failed = [l for l in out.splitlines() if l.strip().startswith("FAIL")]
                first = failed[0].strip()[:90] if failed else "(suite failed)"
                print(f"  ok {name}: caught by {first}")
        finally:
            restore(path, mutated, original)

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
