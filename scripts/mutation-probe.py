#!/usr/bin/env python3
"""Does the suite actually catch the removal of the guards it protects?

Every mechanism this repo institutes is believed because the tests are green.
That is the wrong direction of evidence: green proves the tests accept correct
code, and says nothing about whether they REJECT incorrect code. The only way
to find out is to break something on purpose and check that something fails.

Each MUTATION below deletes one guard that a review round paid for. A guard
whose removal nothing notices is a guard that is not being maintained -- the
next refactor can drop it and the build stays green.

The full audit is not part of `pnpm verify`: it edits sources and runs the
suite once per mutation, so it is a deliberate audit, not a gate. Its cheap
verdict-classifier self-test is part of `pnpm verify`; it edits nothing and
does not require a clean tree.

Usage: mutation-probe.py [-k substring] [--jobs auto|N]
       mutation-probe.py --self-test
       mutation-probe.py --classifier-self-test [--self-test-fault FAULT]
       mutation-probe.py --orchestration-self-test
                         [--orchestration-self-test-fault FAULT]
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parent.parent
TYPESCRIPT_ANALYZER = ROOT / "scripts" / "typescript-verdict-analyzer.cjs"


VerdictKind = Literal["behavior", "construction"]


@dataclass(frozen=True)
class ExpectedVerdict:
    kind: VerdictKind
    file: str
    full_name: str
    marker: str
    marker_file: str | None = None


@dataclass(frozen=True)
class Mutation:
    name: str
    file: str
    find: str
    replace: str
    breaks: str
    verdict: ExpectedVerdict


@dataclass(frozen=True)
class FailedAssertion:
    file: str
    full_name: str
    messages: tuple[str, ...]


@dataclass(frozen=True)
class SuiteResult:
    process_ok: bool
    report_ok: bool
    assertions: tuple[FailedAssertion, ...]
    suite_errors: tuple[str, ...]
    diagnostic: str

    @property
    def green(self) -> bool:
        return (
            self.process_ok
            and self.report_ok
            and not self.assertions
            and not self.suite_errors
        )


class SuiteInfrastructureError(RuntimeError):
    pass


def reject_suite_transport(
    message: str,
    fallback: SuiteResult,
    *,
    return_as_domain: bool,
) -> SuiteResult:
    """The weakness is reachable only from the generated false-positive surface."""
    if return_as_domain:
        return fallback
    raise SuiteInfrastructureError(message)


@dataclass(frozen=True)
class TypeScriptSourceAnalysis:
    diagnostics: tuple[str, ...]
    promise_message_lines: tuple[int, ...]
    helper_verdict_descriptors: frozenset[tuple[str, str]]
    direct_verdict_markers: frozenset[str]


def analyze_typescript_sources(
    sources: dict[str, str],
) -> dict[str, TypeScriptSourceAnalysis]:
    """Ask the TypeScript compiler AST for promise calls and helper descriptors."""
    result = subprocess.run(
        ["node", str(TYPESCRIPT_ANALYZER)],
        cwd=ROOT,
        input=json.dumps({"sources": sources}),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ValueError(
            "TypeScript verdict analyzer failed: "
            f"{(result.stdout + result.stderr).strip()[:500]}"
        )
    try:
        payload = json.loads(result.stdout)
        files = payload["files"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(f"TypeScript verdict analyzer returned malformed JSON: {error}") from error
    if not isinstance(files, dict) or set(files) != set(sources):
        raise ValueError("TypeScript verdict analyzer returned the wrong file inventory")

    analyses: dict[str, TypeScriptSourceAnalysis] = {}
    for path, entry in files.items():
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: TypeScript verdict analysis is not an object")
        diagnostics = entry.get("diagnostics")
        lines = entry.get("promiseMessageLines")
        descriptors = entry.get("helperVerdictDescriptors")
        markers = entry.get("directVerdictMarkers")
        if not (
            isinstance(diagnostics, list)
            and all(isinstance(item, str) for item in diagnostics)
            and isinstance(lines, list)
            and all(isinstance(item, int) and item > 0 for item in lines)
            and isinstance(descriptors, list)
            and all(
                isinstance(item, list)
                and len(item) == 2
                and all(isinstance(part, str) for part in item)
                for item in descriptors
            )
            and isinstance(markers, list)
            and all(isinstance(item, str) for item in markers)
        ):
            raise ValueError(f"{path}: TypeScript verdict analysis has an invalid shape")
        analyses[path] = TypeScriptSourceAnalysis(
            tuple(diagnostics),
            tuple(lines),
            frozenset((item[0], item[1]) for item in descriptors),
            frozenset(markers),
        )
    return analyses


# (name, file, find, replace, what removing it should break)
MUTATION_SPECS = [
    (
        "followon-provenance-check",
        "packages/core/src/fenced-batch.ts",
        "      assertWritesStamp(at, bare, head, target, false)",
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
        "positive-fence-is-not",
        "packages/core/src/fenced-batch.ts",
        "    if (!matchesWord(sql, i, 'NOT')) continue",
        "    if (!matchesWord(sql, i, 'NOT') || /\\bIS\\s*$/i.test(sql.slice(0, i))) continue",
        "a fence inside the right-hand side of IS NOT is mistaken for positive authority",
    ),
    (
        "top-level-or-reach",
        "packages/core/src/fenced-batch.ts",
        "    if (!isCas && s.open === undefined && hasTopLevelOr(bare)) {",
        "    if (false && !isCas && s.open === undefined && hasTopLevelOr(bare)) {",
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
        "      new RegExp(`\\\\$FENCE:(${FENCE_STATEMENT_NAME_SOURCE})\\\\$`, 'g'),",
        "      new RegExp('(?!)', 'g'),",
        "a hand-written fence token naming nothing compiles to a dead filter",
    ),
    (
        # Replaces the two per-call-site fence mutations. Those statements no
        # longer CONTAIN a fence a caller could remove — the primitive builds
        # the selection — so the mutation moves to the generator, where one
        # entry now covers every generated follow-on instead of two
        # covering two. That the old mutations went stale rather than passing
        # is the probe reporting the refactor accurately.
        "generated-selection-fence",
        "packages/core/src/fenced-batch.ts",
        "        : `SELECT f.${column} FROM ${from} f\n"
        "                       WHERE ${src}f.fence_stamp = ${fence}`",
        "        : `SELECT f.${column} FROM ${from} f\n"
        "                       WHERE ${src}f.fence_stamp = ${fence} OR 1 = 1`",
        "every generated follow-on acts on rows this batch never wrote",
    ),
    (
        "generated-narrow-widens",
        "packages/core/src/fenced-batch.ts",
        "    const narrow = spec.narrow ? `\\n         AND (${spec.narrow})` : ''",
        "    const narrow = spec.narrow\n"
        "      ? `\\n         AND (((${spec.narrow}) IS NOT NULL) OR 1 = 1)`\n"
        "      : ''",
        "a narrowing clause that WIDENS the set instead of shrinking it",
    ),
    (
        "generated-narrow-drops-all",
        "packages/core/src/fenced-batch.ts",
        "    const narrow = spec.narrow ? `\\n         AND (${spec.narrow})` : ''",
        "    const narrow = spec.narrow\n"
        "      ? `\\n         AND (${spec.narrow})${spec.narrow === 'task_id = ?' ? ' AND 0 = 1' : ''}`\n"
        "      : ''",
        "a generated narrowing clause can silently turn every intended match into a no-op",
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
        "generated-update-provenance-assignment",
        "packages/core/src/fenced-batch.ts",
        "    const provenance = `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_at_ms = (${sourceInstant})`",
        "    const provenance = `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_stamp = fence_stamp,\n"
        "         fence_at_ms = (${sourceInstant})`",
        "a generated UPDATE can leave stale provenance on every row it writes",
    ),
    (
        "generated-set-provenance-guard",
        "packages/core/src/fenced-batch.ts",
        "      if (!allowedColumns.has(column)) {",
        "      if (false && !allowedColumns.has(column)) {",
        "a generated UPDATE caller can compete with the primitive's provenance assignment",
    ),
    (
        "generated-update-fence-source",
        "packages/core/src/fenced-batch.ts",
        "      target,\n"
        "      sql: `UPDATE ${target} SET ${setSql}${provenance}",
        "      target: null,\n"
        "      sql: `UPDATE ${target} SET ${setSql}${provenance}",
        "a generated UPDATE is no longer available as a fence source",
    ),
    (
        "derived-source-table",
        "packages/core/src/fenced-batch.ts",
        "    if (source.target !== from) {",
        "    if (false && source.target !== from) {",
        "a relation can read its fence stamp from a table the source statement never stamped",
    ),
    (
        "seal-source-key",
        "packages/core/src/fenced-batch.ts",
        "    if (relation.from !== relation.target || relation.key !== relation.column) {",
        "    if (relation.from !== relation.target) {",
        "a seal can overwrite a different logical key in its source table",
    ),
    (
        "self-source-selection-materialized",
        "packages/core/src/fenced-batch.ts",
        "    const sourceKeys =\n      target === from",
        "    const sourceKeys =\n      false && target === from",
        "a self-source UPDATE uses a MySQL-forbidden direct read of its target",
    ),
    (
        "self-source-instant-materialized",
        "packages/core/src/fenced-batch.ts",
        "    const sourceInstant =\n      target === from",
        "    const sourceInstant =\n      false && target === from",
        "a self-source UPDATE reads its provenance instant directly from its MySQL target",
    ),
    (
        "seal-intermediate-fence",
        "packages/core/src/fenced-batch.ts",
        "    if (source.fence.sealedBy !== null) {",
        "    if (false && source.fence.sealedBy !== null) {",
        "a consumer can depend on an intermediate fence after it was sealed",
    ),
    (
        "seal-lifecycle-transition",
        "packages/core/src/fenced-batch.ts",
        "    source.sealedBy = name\n    return this",
        "    void source // MUTATION\n    return this",
        "an exact replay can reuse an intermediate fence left by its first execution",
    ),
    (
        # The queue condition now lives in the one canonical wait witness
        # shared by modern matching and legacy recovery. It remains redundant
        # for one row and load-bearing across two.
        "emit-wake-one-witness",
        "packages/store-libsql/src/fragments.ts",
        "      AND w.queue = ${run}.queue\n",
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
        # Not correctness: the emit's access path. Correlating the driver is
        # logically redundant with its outer IN but makes SQLite scan the
        # largest table in the engine. Only a plan pinned to the SHIPPED
        # statement can see that regression.
        "emit-index-driver",
        "packages/store-libsql/src/store.ts",
        "                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting')",
        "                        WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting'\n"
        "                          AND w.run_id = runs.run_id)",
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
        "packages/store-libsql/src/fragments.ts",
        "                        AND w.step_name = ${run}.wake_step)",
        "                        AND 1 = 1)",
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
        "         wake_step = COALESCE(wake_step, ${claimedWait.step}),",
        "         wake_step = wake_step,",
        "a claimed pre-v3 timed wait loses the only copy of its exact step",
    ),
    (
        "legacy-wait-step-unique-scalar",
        "packages/store-libsql/src/fragments.ts",
        "            HAVING COUNT(*) = 1)",
        "            HAVING COUNT(*) >= 1)",
        "an emit invents one step when several legacy registrations match",
    ),
    (
        "legacy-wait-claim-cardinality",
        "packages/store-libsql/src/fragments.ts",
        "                              HAVING COUNT(*) > 1)",
        "                              HAVING COUNT(*) > 2)",
        "claim consumes a legacy run whose active wait cannot be identified",
    ),
    (
        "claim-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "               AND ${soleLiveRun('r')}\n",
        "               AND 1 = 1\n",
        "claim advances two competing live runs for one task",
    ),
    (
        "claim-receipt-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "         AND t.state IN ${LIVE}\n"
        "         AND ${soleLiveRun('r')}\n",
        "         AND t.state IN ${LIVE}\n"
        "         AND 1 = 1\n",
        "a same-token receipt hands a run from a task with competing live owners back to launch",
    ),
    (
        "activate-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "         AND ${soleLiveRun('runs')}\n",
        "         AND 1 = 1\n",
        "activation launches a claimed run after its task acquires a competing live run",
    ),
    (
        "matrix-lost-launch-edge-progress",
        "packages/store-libsql/src/store.ts",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW}`",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "                   AND run_id <> 'edge-run'`",
        "the generated fault cell fires its label while the seeded lost-launch edge never crosses",
    ),
    (
        "sweep-lost-launch-generation",
        "packages/store-libsql/src/store.ts",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW}`",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "                   AND (run_id <> 'edge-run' OR claim_gen = 1)`",
        "the lost-launch edge only works at generation one",
    ),
    (
        "matrix-claim-timeout-edge-progress",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND run_id <> 'edge-run'\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "the generated fault cell fires its label while the seeded claim-timeout edge never crosses",
    ),
    (
        "sweep-rejects-noninteger-attempt",
        "packages/store-libsql/src/store.ts",
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}`",
        "a corrupt attempt is coerced into a successor ordinal and resets infrastructure accounting",
    ),
    (
        "suspend-rejects-noninteger-attempt",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedInteger('runs.attempt')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)})`,\n"
        "      [wakeArg, wakeArg, runId, queue, claimToken],",
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)})`,\n"
        "      [wakeArg, wakeArg, runId, queue, claimToken],",
        "suspend parks a run while its required checkpoint marker is refused",
    ),
    (
        "shared-conformance-runner-registry",
        "packages/conformance/src/store-conformance.ts",
        "  { id: 'poison-matrix', run: poisonMatrixConformance },\n",
        "",
        "a dialect silently drops an entire shared conformance surface",
    ),
    (
        "sweep-claim-timeout-generation",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND (run_id <> 'edge-run' OR claim_gen = 1)\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "the claim-timeout edge only works at generation one",
    ),
    (
        "matrix-attempt-edge-progress",
        "packages/store-libsql/src/store.ts",
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,\n"
        "      [failureJson, runId, queue, claimToken],",
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND run_id <> 'edge-run'`,\n"
        "      [failureJson, runId, queue, claimToken],",
        "the generated fault cell fires its label while the seeded attempt-cap edge never crosses",
    ),
    (
        "provenance-sweep-progress",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND claim_expires_at_ms <= ${NOW}\n"
        "         AND run_id <> 'prov-sweep-run'\n"
        "         AND ${storedInteger('runs.attempt')}`",
        "the replay regression accepts a sweep that never performs the transition it owes",
    ),
    (
        "provenance-fail-progress",
        "packages/store-libsql/src/store.ts",
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'`,\n"
        "      [failureJson, runId, queue, claimToken],",
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND run_id <> 'prov-fail-run'`,\n"
        "      [failureJson, runId, queue, claimToken],",
        "the replay regression accepts a failure delivery that never fails its run",
    ),
    (
        "ending-claim-identity",
        "packages/core/src/launch.ts",
        "ending.runId !== run.runId || ending.claimToken !== run.claimToken",
        "ending.runId !== run.runId || false",
        "an ending from an older claim expires the current worker's lease",
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
        "      if (error instanceof LibsqlError && SCHEMA_FAULT.test(error.message)) {",
        "      if (false && error instanceof LibsqlError && SCHEMA_FAULT.test(error.message)) {",
        "an un-migrated database is retried as a transient outage",
    ),
    (
        "schema-absence-is-typed",
        "packages/store-libsql/src/admin.ts",
        "      if (error instanceof SchemaNotInitializedError) return 0",
        "      if (String(error).includes('no such table')) return 0",
        "an unrelated executor failure is interpreted as a fresh database",
    ),
    (
        "schema-version-row-required",
        "packages/store-libsql/src/admin.ts",
        "      throw new SchemaMismatchError(\n"
        "        `schema-version read must return exactly one result with one row, got ${results.length} results and ${result?.rows.length ?? 0} rows`,\n"
        "      )",
        "      return 0",
        "missing or duplicated version results are interpreted as a fresh database",
    ),
    (
        "migration-postcondition-old-version",
        "packages/store-libsql/src/admin.ts",
        "    if (version !== CURRENT_SCHEMA_VERSION) {",
        "    if (version > CURRENT_SCHEMA_VERSION) {",
        "a committed migration can leave the recorded version behind and still report success",
    ),
    (
        "spawn-primary-key-guard",
        "packages/store-libsql/src/store.ts",
        "       WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)",
        "       WHERE ? IS NOT NULL",
        "a task-id collision crashes spawn instead of losing",
    ),
]

VERDICTS = {
    "followon-provenance-check": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a CAS must write its own provenance rejects a follow-on that writes a fenced table without stamping it",
        "mutation-verdict:construction:followon-provenance-check",
    ),
    "positive-fence-required": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a follow-on must filter on a fence, positively, in the WHERE side rejects a follow-on with no fence at all",
        "mutation-verdict:construction:positive-fence-required",
    ),
    "positive-fence-is-not": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a follow-on must filter on a fence, positively, in the WHERE side rejects a fence in the negated right-hand side of IS NOT",
        "mutation-verdict:construction:positive-fence-is-not",
    ),
    "top-level-or-reach": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a follow-on must filter on a fence, positively, in the WHERE side rejects a top-level OR but accepts alternation inside a fenced conjunct",
        "mutation-verdict:construction:top-level-or-reach",
    ),
    "clock-ban-in-followon": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "only a CAS may read the clock rejects $NOW$ in a follow-on",
        "mutation-verdict:construction:clock-ban-in-followon",
    ),
    "raw-fence-token-check": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value applies the same rules to a fence token written by hand",
        "mutation-verdict:construction:raw-fence-token-check",
    ),
    "generated-selection-fence": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/generated-selection.test.ts",
        "a generated selection restricts to rows this batch stamped holds when the caller correlation is a disjunction",
        "mutation-verdict:behavior:generated-selection-scope",
    ),
    "generated-narrow-widens": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/generated-selection.test.ts",
        "a generated selection restricts to rows this batch stamped never lets narrow widen the target set",
        "mutation-verdict:behavior:generated-narrow-widens",
    ),
    "generated-narrow-drops-all": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/generated-selection.test.ts",
        "a generated selection restricts to rows this batch stamped never lets narrow widen the target set",
        "mutation-verdict:behavior:generated-narrow-progress",
    ),
    "generated-where-parens": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/generated-selection.test.ts",
        "a generated selection restricts to rows this batch stamped holds when the caller correlation is a disjunction",
        "mutation-verdict:behavior:generated-selection-scope",
    ),
    "generated-update-provenance-assignment": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/generated-selection.test.ts",
        "a generated selection restricts to rows this batch stamped still writes provenance derived from the stamped source",
        "mutation-verdict:behavior:generated-update-provenance-assignment",
    ),
    "generated-set-provenance-guard": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value does not let a generated UPDATE caller overwrite generated provenance",
        "mutation-verdict:construction:generated-set-provenance",
    ),
    "generated-update-fence-source": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value accepts a generated UPDATE as a fence source",
        "mutation-verdict:construction:generated-update-fence-source",
    ),
    "derived-source-table": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value rejects a relation that reads from a table other than the fence source",
        "mutation-verdict:construction:derived-source-table",
    ),
    "seal-source-key": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value restricts sealing to relations that preserve both source table and key",
        "mutation-verdict:construction:seal-source-key",
    ),
    "self-source-selection-materialized": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value materializes self-source reads so MySQL may update the source table",
        "mutation-verdict:construction:self-source-selection",
    ),
    "self-source-instant-materialized": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value materializes self-source reads so MySQL may update the source table",
        "mutation-verdict:construction:self-source-instant",
    ),
    "seal-intermediate-fence": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value rejects a later consumer of a sealed intermediate fence",
        "mutation-verdict:construction:sealed-source-reuse",
    ),
    "seal-lifecycle-transition": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value rejects a later consumer of a sealed intermediate fence",
        "mutation-verdict:construction:sealed-source-reuse",
    ),
    "emit-wake-one-witness": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "wake witness conformance [libsql] decides every park against every pair of corruptions",
        "mutation-verdict:behavior:emit-wake-one-witness",
        "packages/conformance/src/suite.ts",
    ),
    "emit-replay-preserves-event-instant": ExpectedVerdict(
        "construction",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "a replay after the world moved on does not reuse one emit provenance seed at a later instant",
        "mutation-verdict:construction:emit-replay-preserves-event-instant",
    ),
    "emit-index-driver": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/query-plans.test.ts",
        "the emit fan-out, which is a WRITE is driven by the waits index, not by a scan of runs",
        "mutation-verdict:behavior:emit-index-driver",
    ),
    "emit-cleanup-follows-the-wake": ExpectedVerdict(
        "construction",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "emitEvent only wakes runs that are parked on that event keeps the registration of a waiter it did not wake",
        "mutation-verdict:construction:emit-cleanup-follows-the-wake",
    ),
    "emit-wake-event-correlation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "emitEvent only wakes runs that are parked on that event does not deliver event B to a run parked on event A",
        "mutation-verdict:behavior:emit-wake-event-correlation",
    ),
    "emit-wake-step-correlation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "emitEvent only wakes runs that are parked on that event does not let one await step consume another step of the same event",
        "mutation-verdict:behavior:emit-wake-step-correlation",
    ),
    "successor-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "a replay after the world moved on does not terminalize a task whose successor has since been claimed",
        "mutation-verdict:behavior:successor-ownership",
    ),
    "successor-attempt-identity": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "a successor id that collides with a historical run of the same task rejects a worker failure instead of committing a half-transition",
        "mutation-verdict:behavior:successor-attempt-identity",
    ),
    "legacy-wait-step-backfill": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/legacy-rows.test.ts",
        "rows written before a column existed a timed wake still decodes when runs.wake_step is NULL (pre-v3)",
        "mutation-verdict:behavior:legacy-wait-step-backfill",
    ),
    "legacy-wait-step-unique-scalar": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/legacy-rows.test.ts",
        "ambiguous legacy wait registrations does not choose an event wait step when several registrations match",
        "mutation-verdict:behavior:legacy-wait-step-unique-scalar",
    ),
    "legacy-wait-claim-cardinality": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/legacy-rows.test.ts",
        "ambiguous legacy wait registrations does not choose a timed wait step when several registrations match",
        "mutation-verdict:behavior:legacy-wait-claim-cardinality",
    ),
    "claim-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (write label x forbidden pre-state, generated) claim does not amplify cardinality/two-live-runs",
        "mutation-verdict:behavior:claim-requires-sole-live-run",
        "packages/conformance/src/store-conformance.ts",
    ),
    "claim-receipt-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) a same-token claim receipt refuses a task with multiple live runs",
        "mutation-verdict:behavior:claim-receipt-requires-sole-live-run",
    ),
    "activate-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) activate refuses a claim whose task acquired another live run",
        "mutation-verdict:behavior:activate-requires-sole-live-run",
    ),
    "matrix-lost-launch-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) sweep:lost-launch survives duplicate from relaunch-cap-edge",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "sweep-lost-launch-generation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) sweep:lost-launch survives duplicate from relaunch-cap-edge",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "matrix-claim-timeout-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) sweep:claim-timeout survives duplicate from infra-cap-edge",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "sweep-rejects-noninteger-attempt": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification refuses a corrupt stored attempt without partially sweeping the expired claim",
        "mutation-verdict:behavior:sweep-rejects-noninteger-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "suspend-rejects-noninteger-attempt": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] transitions: complete / fail / reschedule suspendRun rejects a non-integer stored attempt atomically",
        "mutation-verdict:behavior:suspend-rejects-noninteger-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "shared-conformance-runner-registry": ExpectedVerdict(
        "construction",
        "packages/conformance/test/enrollment.test.ts",
        "shared conformance enrollment is one indivisible door couples the surface inventory and umbrella dispatch in one registry",
        "mutation-verdict:construction:shared-conformance-runner-registry",
    ),
    "sweep-claim-timeout-generation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) sweep:claim-timeout survives duplicate from infra-cap-edge",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "matrix-attempt-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) fail survives duplicate from attempt-cap-edge",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:attempt-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "provenance-sweep-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance a replayed claim-timeout sweep at the infra cap leaves no live run under a terminal task",
        "mutation-verdict:behavior:provenance-sweep-progress",
    ),
    "provenance-fail-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance a replayed retrying failure does not reject",
        "mutation-verdict:behavior:provenance-fail-progress",
    ),
    "ending-claim-identity": ExpectedVerdict(
        "behavior",
        "packages/driver/test/tick.test.ts",
        "tick() codex review regressions an ending for an older claim of the same run is ignored",
        "mutation-verdict:behavior:ending-claim-identity",
    ),
    "test-token-source-monotonic": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/testing.test.ts",
        "the routine test id source keeps ids ordered and tokens unique when calls are interleaved",
        "mutation-verdict:behavior:test-token-source-monotonic",
    ),
    "schema-fault-is-permanent": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "a database older than the binary classifies every SQLite schema-shape error as a permanent fault",
        "mutation-verdict:behavior:schema-fault-is-permanent",
    ),
    "schema-absence-is-typed": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current does not classify unrelated executor failures by message substring",
        "mutation-verdict:behavior:schema-absence-is-typed",
    ),
    "schema-version-row-required": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current requires exactly one schema-version result row",
        "mutation-verdict:behavior:schema-version-row-required",
    ),
    "migration-postcondition-old-version": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current fails when the recorded version did not advance",
        "mutation-verdict:behavior:migration-postcondition-old-version",
    ),
    "spawn-primary-key-guard": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) spawn loses rather than crashing when only the task id collides",
        "mutation-verdict:behavior:spawn-primary-key-guard",
    ),
}

spec_names = [spec[0] for spec in MUTATION_SPECS]
if len(spec_names) != len(set(spec_names)):
    raise RuntimeError("mutation-probe has duplicate mutation names")
if set(spec_names) != set(VERDICTS):
    missing = sorted(set(spec_names) - set(VERDICTS))
    stale = sorted(set(VERDICTS) - set(spec_names))
    raise RuntimeError(f"mutation verdict inventory mismatch: missing={missing}, stale={stale}")

MUTATIONS = [Mutation(*spec, VERDICTS[spec[0]]) for spec in MUTATION_SPECS]

# The suite, minus the legs whose cost dwarfs their value here: the fuzz shards
# and the real-process chaos tests each add minutes per mutation. The real
# audit re-execs its COORDINATOR through confine.sh once; every raw suite below
# is therefore a descendant of the same aggregate cgroup. Wrapping each suite
# separately would multiply the advertised memory ceiling by the worker count.
TEST_CMD = [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--exclude",
    "packages/conformance/test/fuzz-*",
    "--exclude",
    "packages/driver/test/chaos-process.test.ts",
]
CONFINEMENT_ENV = "DURABLERUN_MUTATION_SCOPE"
REPORT_VERSION = 1
MAX_AUTO_JOBS = 16
MIN_CORES_PER_AUTO_JOB = 8


def relative_test_file(value: object) -> str:
    path = Path(str(value))
    if not path.is_absolute():
        return path.as_posix()
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def parse_report(
    text: str,
    process_ok: bool,
    diagnostic: str,
    *,
    return_transport_as_domain: bool = False,
) -> SuiteResult:
    """Turn Vitest's JSON reporter into only the evidence attribution needs."""
    try:
        report = json.loads(text)
    except (json.JSONDecodeError, TypeError) as error:
        message = f"missing or malformed Vitest JSON report: {error}"
        return reject_suite_transport(
            message,
            SuiteResult(
                process_ok,
                False,
                (),
                (message,),
                diagnostic,
            ),
            return_as_domain=return_transport_as_domain,
        )
    if not isinstance(report, dict) or not isinstance(report.get("success"), bool):
        message = "Vitest JSON report has no boolean success verdict"
        return reject_suite_transport(
            message,
            SuiteResult(
                process_ok,
                False,
                (),
                (message,),
                diagnostic,
            ),
            return_as_domain=return_transport_as_domain,
        )

    suite_errors: list[str] = []
    report_errors: list[str] = []

    def invalid_report(message: str) -> None:
        suite_errors.append(message)
        report_errors.append(message)

    counter_names = (
        "numTotalTestSuites",
        "numPassedTestSuites",
        "numFailedTestSuites",
        "numPendingTestSuites",
        "numTotalTests",
        "numPassedTests",
        "numFailedTests",
        "numPendingTests",
        "numTodoTests",
    )
    counters: dict[str, int] = {}
    for name in counter_names:
        value = report.get(name)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            invalid_report(f"Vitest JSON report has no nonnegative integer {name}")
        else:
            counters[name] = value
    if len(counters) == len(counter_names):
        if counters["numTotalTestSuites"] != (
            counters["numPassedTestSuites"]
            + counters["numFailedTestSuites"]
            + counters["numPendingTestSuites"]
        ):
            invalid_report("Vitest JSON report has contradictory suite counters")
        if counters["numTotalTests"] != (
            counters["numPassedTests"]
            + counters["numFailedTests"]
            + counters["numPendingTests"]
            + counters["numTodoTests"]
        ):
            invalid_report("Vitest JSON report has contradictory test counters")

    assertions: list[FailedAssertion] = []
    observed_tests = {"passed": 0, "failed": 0, "pending": 0, "todo": 0}
    results = report.get("testResults")
    if not isinstance(results, list):
        message = "Vitest JSON report has no testResults array"
        return reject_suite_transport(
            message,
            SuiteResult(
                process_ok,
                bool(report["success"]),
                (),
                (*suite_errors, message),
                diagnostic,
            ),
            return_as_domain=return_transport_as_domain,
        )
    for result in results:
        if not isinstance(result, dict):
            invalid_report("Vitest JSON report contains a non-object test result")
            continue
        name = result.get("name")
        if not isinstance(name, str):
            invalid_report("Vitest JSON test result has no string name")
            name = "(unknown file)"
        file = relative_test_file(name)
        file_status = result.get("status")
        if file_status not in ("passed", "failed"):
            invalid_report(f"{file}: invalid or missing file status")
        message = result.get("message")
        if not isinstance(message, str):
            invalid_report(f"{file}: missing string message")
            message = ""
        elif message:
            suite_errors.append(f"{file}: {message}")
        rows = result.get("assertionResults")
        if not isinstance(rows, list):
            invalid_report(f"{file}: missing assertionResults")
            continue
        failed_in_file = False
        for assertion in rows:
            if not isinstance(assertion, dict):
                invalid_report(f"{file}: contains a non-object assertion result")
                continue
            status = assertion.get("status")
            if not isinstance(status, str):
                invalid_report(f"{file}: assertion has invalid or missing status")
                continue
            if status in ("skipped", "disabled"):
                observed_tests["pending"] += 1
            elif status in observed_tests:
                observed_tests[status] += 1
            else:
                invalid_report(f"{file}: assertion has invalid or missing status")
                continue
            if status != "failed":
                continue
            failed_in_file = True
            messages = assertion.get("failureMessages")
            full_name = assertion.get("fullName")
            if not isinstance(full_name, str):
                invalid_report(f"{file}: failed assertion has no string fullName")
                full_name = ""
            if messages is not None and (
                not isinstance(messages, list)
                or any(not isinstance(item, str) for item in messages)
            ):
                invalid_report(
                    f"{file}: failed assertion has invalid failureMessages"
                )
                messages = []
            assertions.append(
                FailedAssertion(
                    file,
                    full_name,
                    tuple(messages) if isinstance(messages, list) else (),
                )
            )
        if file_status == "failed":
            if not failed_in_file and not message:
                invalid_report(
                    f"{file}: failed file has no failed assertion or file error"
                )
        elif failed_in_file or message:
            invalid_report(
                f"{file}: passed file contains a failed assertion or file error"
            )

    if len(counters) == len(counter_names):
        observed_by_counter = {
            "numTotalTests": sum(observed_tests.values()),
            "numPassedTests": observed_tests["passed"],
            "numFailedTests": observed_tests["failed"],
            "numPendingTests": observed_tests["pending"],
            "numTodoTests": observed_tests["todo"],
        }
        for name, observed in observed_by_counter.items():
            if counters[name] != observed:
                invalid_report(
                    f"Vitest JSON report {name}={counters[name]} "
                    f"does not match {observed} assertion results"
                )
        expected_success = (
            counters["numFailedTestSuites"] == 0
            and counters["numFailedTests"] == 0
        )
        if results and bool(report["success"]) != expected_success:
            invalid_report(
                "Vitest JSON report success contradicts its failure counters"
            )
        elif bool(report["success"]) and not expected_success:
            invalid_report(
                "Vitest JSON report success contradicts its failure counters"
            )
    parsed = SuiteResult(
        process_ok,
        bool(report["success"]),
        tuple(assertions),
        tuple(suite_errors),
        diagnostic,
    )
    if report_errors:
        return reject_suite_transport(
            report_errors[0],
            parsed,
            return_as_domain=return_transport_as_domain,
        )
    return parsed


def diagnostic_tail(path: Path, limit: int = 16_384) -> str:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        stream.seek(max(0, size - limit))
        return stream.read().decode(errors="replace").strip()


def run_suite(
    max_workers: int,
    *,
    scope: ConfinedScope,
    workspace: IsolatedWorkspace,
    authority: WorkerAuthority,
    return_transport_as_domain: bool = False,
) -> SuiteResult:
    if (
        workspace.root != ROOT.resolve()
        or authority.worker_root != ROOT.resolve()
        or scope.memory_max <= 0
        or scope.cpu_quota <= 0
    ):
        raise RuntimeError("mutation suite lacks its runtime safety capabilities")
    with tempfile.TemporaryDirectory(prefix="durablerun-mutation-report-") as temporary:
        report = Path(temporary) / "vitest.json"
        log = Path(temporary) / "vitest.log"
        command = [*TEST_CMD]
        if max_workers is not None:
            command.extend(("--maxWorkers", str(max_workers)))
        command.extend(("--reporter=json", "--outputFile", str(report)))
        with log.open("wb") as output:
            result = subprocess.run(
                command,
                cwd=ROOT,
                stdout=output,
                stderr=subprocess.STDOUT,
            )
        diagnostic = diagnostic_tail(log)
        if not report.exists():
            message = "Vitest did not write its JSON report"
            return reject_suite_transport(
                message,
                SuiteResult(
                    result.returncode == 0,
                    False,
                    (),
                    (message,),
                    diagnostic,
                ),
                return_as_domain=return_transport_as_domain,
            )
        parsed = parse_report(
            report.read_text(),
            result.returncode == 0,
            diagnostic,
            return_transport_as_domain=return_transport_as_domain,
        )
        if result.returncode >= 0:
            return parsed
        message = f"Vitest terminated by signal {-result.returncode}"
        return reject_suite_transport(
            message,
            parsed,
            return_as_domain=return_transport_as_domain,
        )


VerdictOutcome = Literal["caught", "survived", "wrong-path"]


def message_has_exact_marker(marker: str, message: str) -> bool:
    """Match the emitted diagnostic, never a later stack/source excerpt."""
    first_line = message.splitlines()[0].strip() if message else ""
    return (
        first_line == marker
        or first_line == f"Error: {marker}"
        or first_line.startswith(f"AssertionError: {marker}:")
    )


def assertion_matches(expected: ExpectedVerdict, actual: FailedAssertion) -> bool:
    return (
        actual.file == expected.file
        and actual.full_name == expected.full_name
        and any(message_has_exact_marker(expected.marker, message) for message in actual.messages)
    )


def classify_verdict(
    result: SuiteResult,
    expected: ExpectedVerdict,
    matcher=assertion_matches,
    *,
    accept_suite_error: bool = False,
    accept_incoherent: bool = False,
    accept_malformed: bool = False,
) -> VerdictOutcome:
    if result.green:
        return "survived"
    # A real Vitest failure has both a nonzero process exit and success=false.
    # A signal, broken reporter, or contradictory result is infrastructure, not
    # evidence that the intended guard was exercised.
    if not accept_incoherent and (result.process_ok or result.report_ok):
        return "wrong-path"
    malformed = any(
        "missing or malformed" in error or "did not write" in error for error in result.suite_errors
    )
    if result.suite_errors:
        if malformed and accept_malformed:
            return "caught"
        if accept_suite_error and any(expected.marker in error for error in result.suite_errors):
            return "caught"
        return "wrong-path"
    if any(matcher(expected, assertion) for assertion in result.assertions):
        return "caught"
    return "wrong-path"


SELF_TEST_FAULTS = (
    "ignore-file",
    "ignore-full-name",
    "ignore-marker",
    "match-marker-substring",
    "accept-suite-error",
    "accept-incoherent-report",
    "accept-malformed-report",
)


def self_test(fault: str | None = None, *, check_live_inventory: bool) -> int:
    """Generated false-positive surface for the verdict classifier itself."""
    expected = ExpectedVerdict(
        "behavior",
        "packages/example/test/protocol.test.ts",
        "protocol guard rejects the forbidden transition",
        "mutation-verdict:behavior:probe",
    )
    construction = ExpectedVerdict(
        "construction",
        "packages/example/test/builder.test.ts",
        "builder rejects an unprovable follow-on",
        "mutation-verdict:construction:probe",
    )

    def failed(
        verdict: ExpectedVerdict = expected,
        *,
        file: str | None = None,
        name: str | None = None,
        message: str | None = None,
    ) -> SuiteResult:
        return SuiteResult(
            False,
            False,
            (
                FailedAssertion(
                    file or verdict.file,
                    name or verdict.full_name,
                    (message or verdict.marker,),
                ),
            ),
            (),
            "",
        )

    def reported_failure(
        *,
        assertion_status: object = "failed",
        file_status: object = "failed",
        passed_suites: int = 0,
        failed_suites: int = 1,
        passed_tests: int = 0,
        failed_tests: int = 1,
    ) -> SuiteResult:
        return parse_report(
            json.dumps(
                {
                    "success": False,
                    "numTotalTestSuites": passed_suites + failed_suites,
                    "numPassedTestSuites": passed_suites,
                    "numFailedTestSuites": failed_suites,
                    "numPendingTestSuites": 0,
                    "numTotalTests": passed_tests + failed_tests,
                    "numPassedTests": passed_tests,
                    "numFailedTests": failed_tests,
                    "numPendingTests": 0,
                    "numTodoTests": 0,
                    "testResults": [
                        {
                            "name": str(ROOT / expected.file),
                            "status": file_status,
                            "message": "",
                            "assertionResults": [
                                {
                                    "status": assertion_status,
                                    "fullName": expected.full_name,
                                    "failureMessages": [expected.marker],
                                }
                            ],
                        }
                    ],
                }
            ),
            False,
            "",
            return_transport_as_domain=True,
        )

    matcher = assertion_matches
    options: dict[str, bool] = {}
    if fault == "ignore-file":
        matcher = lambda want, got: (
            got.full_name == want.full_name
            and any(message_has_exact_marker(want.marker, message) for message in got.messages)
        )
    elif fault == "ignore-full-name":
        matcher = lambda want, got: (
            got.file == want.file
            and any(message_has_exact_marker(want.marker, message) for message in got.messages)
        )
    elif fault == "ignore-marker":
        matcher = lambda want, got: got.file == want.file and got.full_name == want.full_name
    elif fault == "match-marker-substring":
        matcher = lambda want, got: (
            got.file == want.file
            and got.full_name == want.full_name
            and any(want.marker in message for message in got.messages)
        )
    elif fault == "accept-suite-error":
        options["accept_suite_error"] = True
    elif fault == "accept-incoherent-report":
        options["accept_incoherent"] = True
    elif fault == "accept-malformed-report":
        options["accept_malformed"] = True
    elif fault is not None:
        print(f"mutation-probe self-test: unknown injected fault {fault}", file=sys.stderr)
        return 2

    cases = (
        ("matching behavioral assertion", failed(), expected, "caught"),
        (
            "matching construction assertion",
            failed(construction),
            construction,
            "caught",
        ),
        (
            "matching top-level assertion without a failed nested suite",
            reported_failure(failed_suites=0),
            expected,
            "caught",
        ),
        ("green mutant", SuiteResult(True, True, (), (), ""), expected, "survived"),
        (
            "marker from another file",
            failed(file="packages/other/test/protocol.test.ts"),
            expected,
            "wrong-path",
        ),
        (
            "marker from another assertion",
            failed(name="protocol guard failed during setup"),
            expected,
            "wrong-path",
        ),
        (
            "marker mentioned only in assertion source context",
            failed(
                message=(
                    "AssertionError: expected 1 to be 2\n"
                    f" ❯ {expected.file}:12:3\n"
                    f"  11| expect(actual, '{expected.marker}').toBe(expected)"
                )
            ),
            expected,
            "wrong-path",
        ),
        (
            "same test stopped at bind-arity compilation",
            failed(message="FencedBatch[emit-event] 'wake-runs' binds 9 of 8 explicit args"),
            expected,
            "wrong-path",
        ),
        (
            "construction marker cannot answer for behavior",
            failed(message=construction.marker),
            expected,
            "wrong-path",
        ),
        (
            "marker only in a file-level compile error",
            SuiteResult(False, False, (), (expected.marker,), ""),
            expected,
            "wrong-path",
        ),
        (
            "matching assertion alongside a suite error",
            SuiteResult(
                False,
                False,
                failed().assertions,
                ("unrelated file-level suite failure",),
                "",
            ),
            expected,
            "wrong-path",
        ),
        (
            "incoherent process and report verdicts",
            SuiteResult(True, False, failed().assertions, (), ""),
            expected,
            "wrong-path",
        ),
        (
            "malformed report",
            parse_report(
                "{",
                False,
                "",
                return_transport_as_domain=True,
            ),
            expected,
            "wrong-path",
        ),
        (
            "success verdict with no test results",
            parse_report(
                '{"success": true}',
                True,
                "",
                return_transport_as_domain=True,
            ),
            expected,
            "wrong-path",
        ),
        (
            "success verdict alongside a failed assertion",
            SuiteResult(True, True, failed().assertions, (), ""),
            expected,
            "wrong-path",
        ),
        (
            "failed assertion denied by file status and aggregate counters",
            reported_failure(
                file_status="passed",
                passed_suites=1,
                failed_suites=0,
                passed_tests=1,
                failed_tests=0,
            ),
            expected,
            "wrong-path",
        ),
        (
            "malformed assertion status",
            reported_failure(assertion_status=[]),
            expected,
            "wrong-path",
        ),
    )

    promise_message_cases = (
        (
            "rejects custom message",
            "await expect(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "resolves multiline template message",
            "await expect(\n  action(),\n  `mutation-verdict:behavior:x`,\n).resolves.toBe(1)",
            (1,),
        ),
        (
            "nested action",
            "await expect(run(() => value), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "generic expect call",
            "await expect<Result>(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "optional generic expect call",
            "await expect?.<Result>(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "parenthesized expect call",
            "await (expect)(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "nested parenthesized expect call",
            "await ((expect))(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "optional expect call",
            "await expect?.(action(), 'mutation-verdict:behavior:x').rejects.toThrow()",
            (1,),
        ),
        (
            "generic nested action without message",
            "await expect(call<A, B>()).rejects.toThrow()",
            (),
        ),
        (
            "optional generic nested action without message",
            "await expect(call?.<A, B>()).rejects.toThrow()",
            (),
        ),
        (
            "relational expression before a custom message",
            "await expect((a < b), c > (d) ? 'lost' : 'other').rejects.toThrow()",
            (1,),
        ),
        (
            "marker through a variable",
            "const verdict = 'mutation-verdict:behavior:x'\n"
            "await expect(action(), verdict).rejects.toThrow()",
            (2,),
        ),
        (
            "unmarked custom message",
            "await expect(action(), 'this message is still lossy').rejects.toThrow()",
            (1,),
        ),
        (
            "executable template interpolation",
            "const verdict = 'mutation-verdict:behavior:x'\n"
            "const rendered = `${expect(action(), verdict).rejects.toThrow()}`",
            (2,),
        ),
        (
            "regular-expression decoy",
            "const pattern = /expect(action(), 'mutation-verdict:behavior:x').rejects/",
            (),
        ),
        (
            "synchronous custom message",
            "expect(value, 'mutation-verdict:behavior:x').toBe(1)",
            (),
        ),
        (
            "explicit promise helper",
            "await requireExpectedFailure({kind: 'behavior', mutation: 'x'}, /x/, action)",
            (),
        ),
        (
            "promise matcher without verdict",
            "await expect(action()).rejects.toThrow()",
            (),
        ),
        (
            "comment and string decoys",
            "// expect(action(), 'mutation-verdict:behavior:x').rejects.toThrow()\n"
            'const text = "expect(action(), \\"mutation-verdict:behavior:x\\").resolves"',
            (),
        ),
    )

    descriptor_cases = (
        (
            "canonical behavior descriptor",
            "await attributeReplacedFailure("
            "{kind: 'behavior', mutation: 'schema-fault-is-permanent'}, /a/, /b/, action)",
            frozenset({("behavior", "schema-fault-is-permanent")}),
        ),
        (
            "field order is semantic",
            "await requireExpectedFailure("
            '{ mutation: "migration-postcondition-old-version", kind: "behavior" }, /x/, action)',
            frozenset({("behavior", "migration-postcondition-old-version")}),
        ),
        (
            "generic helper call",
            "await attributeExpectedFailure<Result>("
            "{kind: 'behavior', mutation: 'spawn-primary-key-guard'}, /x/, action)",
            frozenset({("behavior", "spawn-primary-key-guard")}),
        ),
        (
            "decorated name",
            "await requireExpectedFailure("
            "{kind: 'behavior', mutation: 'migration-postcondition-old-version: detail'}, "
            "/x/, action)",
            frozenset(),
        ),
        (
            "unrelated object",
            "consume({kind: 'behavior', mutation: 'schema-fault-is-permanent'})",
            frozenset(),
        ),
        (
            "same-named object method",
            "await fake.requireExpectedFailure("
            "{kind: 'behavior', mutation: 'schema-fault-is-permanent'}, /x/, action)",
            frozenset(),
        ),
        (
            "same-named private method",
            "class C { #requireExpectedFailure(...args: unknown[]) {} async run() { "
            "await this.#requireExpectedFailure("
            "{kind: 'behavior', mutation: 'schema-fault-is-permanent'}, /x/, action) } }",
            frozenset(),
        ),
        (
            "same-named constructor",
            "new requireExpectedFailure("
            "{kind: 'behavior', mutation: 'schema-fault-is-permanent'}, /x/, action)",
            frozenset(),
        ),
        (
            "indirect descriptor",
            "const verdict = {kind: 'behavior', mutation: 'schema-fault-is-permanent'}\n"
            "await attributeReplacedFailure(verdict, /a/, /b/, action)",
            frozenset(),
        ),
        (
            "template name",
            "await requireExpectedFailure("
            "{kind: 'behavior', mutation: `migration-${part}`}, /x/, action)",
            frozenset(),
        ),
    )

    failures = []
    analysis_sources = {
        **{
            f"__selftest__/promise-{index}.ts": source
            for index, (_, source, _) in enumerate(promise_message_cases)
        },
        **{
            f"__selftest__/descriptor-{index}.ts": source
            for index, (_, source, _) in enumerate(descriptor_cases)
        },
    }
    live_paths: list[Path] = []
    if check_live_inventory:
        live_paths = sorted((ROOT / "packages").glob("**/*.ts"))
        analysis_sources.update(
            {
                str(path.relative_to(ROOT)): path.read_text()
                for path in live_paths
            }
        )
    try:
        analyses = analyze_typescript_sources(analysis_sources)
    except ValueError as error:
        failures.append(str(error))
        analyses = {}

    for index, (label, _, wanted) in enumerate(promise_message_cases):
        key = f"__selftest__/promise-{index}.ts"
        analysis = analyses.get(key)
        if analysis is None:
            continue
        if analysis.diagnostics:
            failures.append(
                f"promise-message {label}: TypeScript parse diagnostics "
                f"{analysis.diagnostics}"
            )
            continue
        got = analysis.promise_message_lines
        if got != wanted:
            failures.append(f"promise-message {label}: expected {wanted}, got {got}")
    for index, (label, _, wanted) in enumerate(descriptor_cases):
        key = f"__selftest__/descriptor-{index}.ts"
        analysis = analyses.get(key)
        if analysis is None:
            continue
        if analysis.diagnostics:
            failures.append(
                f"verdict-descriptor {label}: TypeScript parse diagnostics "
                f"{analysis.diagnostics}"
            )
            continue
        got = analysis.helper_verdict_descriptors
        if got != wanted:
            failures.append(f"verdict-descriptor {label}: expected {wanted}, got {got}")
    if check_live_inventory:
        if TEST_CMD[:3] != ["pnpm", "exec", "vitest"]:
            failures.append("worker suites do not execute Vitest directly")
        confined = confinement_command([])
        if confined[:4] != [
            "bash",
            "scripts/confine.sh",
            "env",
            f"{CONFINEMENT_ENV}=1",
        ]:
            failures.append(
                "the full mutation coordinator is not routed once through confine.sh"
            )
        if "scripts/confine.sh" in TEST_CMD:
            failures.append("worker suites create nested confinement scopes")
        for mutation in MUTATIONS:
            source = (ROOT / mutation.file).read_text()
            occurrences = source.count(mutation.find)
            if occurrences != 1:
                failures.append(
                    f"{mutation.name}: mutation pattern occurs {occurrences} times; expected exactly one"
                )
            marker_file = mutation.verdict.marker_file or mutation.verdict.file
            verdict_source = (ROOT / marker_file).read_text()
            marker_parts = mutation.verdict.marker.split(":", 2)
            descriptor = (
                (marker_parts[1], marker_parts[2])
                if len(marker_parts) == 3
                else ("", "")
            )
            marker_analysis = analyses.get(marker_file)
            descriptors = (
                marker_analysis.helper_verdict_descriptors
                if marker_analysis is not None
                else frozenset()
            )
            if (
                (
                    marker_analysis is None
                    or mutation.verdict.marker
                    not in marker_analysis.direct_verdict_markers
                )
                and descriptor not in descriptors
            ):
                failures.append(
                    f"{mutation.name}: neither direct verdict marker "
                    f"{mutation.verdict.marker!r} nor canonical helper descriptor is present in "
                    f"{marker_file}"
                )
        for path in live_paths:
            relative = str(path.relative_to(ROOT))
            analysis = analyses.get(relative)
            if analysis is None:
                continue
            if analysis.diagnostics:
                failures.append(
                    f"{relative}: cannot inspect promise verdicts: "
                    f"{analysis.diagnostics}"
                )
                continue
            for line in analysis.promise_message_lines:
                failures.append(
                    f"{relative}:{line}: Vitest promise outcomes cannot carry "
                    "a custom message; use an explicit attribution helper"
                )
    for label, result, verdict, wanted in cases:
        got = classify_verdict(result, verdict, matcher, **options)
        if got != wanted:
            failures.append(f"{label}: expected {wanted}, got {got}")
    if failures:
        if fault is not None:
            print(
                f"mutation-probe self-test caught injected fault {fault}: {failures[0]}",
                file=sys.stderr,
            )
        else:
            for failure in failures:
                print(f"mutation-probe self-test: {failure}", file=sys.stderr)
        return 1
    if fault is not None:
        print(
            f"mutation-probe self-test MISSED injected fault {fault}",
            file=sys.stderr,
        )
        return 0
    print(
        f"mutation-probe self-test: {len(cases)} attribution cases, "
        f"{len(promise_message_cases)} promise-message cases, "
        f"{len(descriptor_cases)} descriptor cases, {len(MUTATIONS)} live mutations"
    )
    return 0


MutationRunOutcome = Literal["caught", "survived", "wrong-path", "stale"]


@dataclass(frozen=True)
class ExpectedMutationResult:
    ordinal: int
    name: str
    expected: str
    original_sha256: str
    mutated_sha256: str


@dataclass(frozen=True)
class WorkerPlan:
    worker_id: int
    path: Path
    temporary: Path
    baseline_report: Path
    mutation_report: Path
    install_log: Path
    baseline_log: Path
    mutation_log: Path
    expected: tuple[ExpectedMutationResult, ...]


@dataclass(frozen=True)
class ConfinedScope:
    cgroup: str
    memory_max: int
    cpu_quota: int


@dataclass(frozen=True)
class IsolatedWorkspace:
    root: Path


@dataclass(frozen=True)
class WorkerAuthority:
    run_root: Path
    worker_root: Path
    worker_id: int
    head: str
    nonce: str


@dataclass(frozen=True)
class BaselineBarrier:
    head: str
    worker_ids: tuple[int, ...]
    digest: str


ORCHESTRATION_SELF_TEST_FAULTS = (
    "drop-assignment",
    "duplicate-assignment",
    "accept-wrong-head",
    "accept-missing-result",
    "accept-duplicate-result",
    "accept-extra-result",
    "accept-process-report-disagreement",
    "accept-outside-cleanup",
    "accept-unconfined-scope",
    "accept-unowned-worker",
    "skip-baseline-barrier",
    "accept-external-workspace-link",
    "accept-malformed-result-types",
    "interrupt-cleanup",
    "leave-descendant-running",
    "publish-success-after-infra",
    "report-worker-crash-as-domain",
    "accept-oversized-finite-scope",
    "accept-oversized-cpu-scope",
    "classify-missing-report-as-domain",
    "leave-zombie-group",
    "classify-malformed-report-as-domain",
    "classify-structural-report-as-domain",
    "accept-wrong-registry",
    "accept-incomplete-worker",
    "use-worker-local-pnpm-store",
    "allow-host-sized-tokio-pools",
)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expected_verdict(mutation: Mutation) -> str:
    return (
        f"{mutation.verdict.kind} {mutation.verdict.file} > "
        f"{mutation.verdict.full_name} containing {mutation.verdict.marker!r}"
    )


def mutation_registry_digest() -> str:
    payload = [
        {
            "name": mutation.name,
            "file": mutation.file,
            "find": mutation.find,
            "replace": mutation.replace,
            "breaks": mutation.breaks,
            "verdict": {
                "kind": mutation.verdict.kind,
                "file": mutation.verdict.file,
                "full_name": mutation.verdict.full_name,
                "marker": mutation.verdict.marker,
                "marker_file": mutation.verdict.marker_file,
            },
        }
        for mutation in MUTATIONS
    ]
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def expected_result(
    ordinal: int, mutation: Mutation, *, root: Path
) -> ExpectedMutationResult:
    original = (root / mutation.file).read_text()
    mutated = original.replace(mutation.find, mutation.replace, 1)
    return ExpectedMutationResult(
        ordinal,
        mutation.name,
        expected_verdict(mutation),
        sha256_text(original),
        sha256_text(mutated),
    )


def partition_expected(
    expected: list[ExpectedMutationResult],
    jobs: int,
    *,
    fault: str | None = None,
) -> list[list[ExpectedMutationResult]]:
    if jobs < 1 or jobs > len(expected):
        raise ValueError(f"jobs must be between 1 and {len(expected)}")
    shards = [[] for _ in range(jobs)]
    for index, item in enumerate(expected):
        shards[index % jobs].append(item)
    if fault == "drop-assignment":
        shards[0] = shards[0][1:]
    elif fault == "duplicate-assignment":
        shards[-1].append(expected[0])
    return shards


def validate_shards(
    shards: list[list[ExpectedMutationResult]],
    expected: list[ExpectedMutationResult],
) -> None:
    if not shards or any(not shard for shard in shards):
        raise ValueError("every worker shard must be nonempty")
    for worker_id, shard in enumerate(shards):
        wanted = expected[worker_id :: len(shards)]
        if shard != wanted:
            raise ValueError(
                f"worker {worker_id} assignment is not its deterministic registry slice"
            )
    assigned = [item.name for shard in shards for item in shard]
    wanted_names = [item.name for item in expected]
    duplicate = sorted({name for name in assigned if assigned.count(name) > 1})
    missing = sorted(set(wanted_names) - set(assigned))
    extra = sorted(set(assigned) - set(wanted_names))
    if duplicate or missing or extra:
        raise ValueError(
            "shard inventory mismatch: "
            f"duplicate={duplicate}, missing={missing}, extra={extra}"
        )


def mutation_result_row(
    expected: ExpectedMutationResult,
    outcome: MutationRunOutcome,
    detail: str,
) -> dict[str, object]:
    return {
        "ordinal": expected.ordinal,
        "name": expected.name,
        "outcome": outcome,
        "detail": detail,
        "expected": expected.expected,
        "original_sha256": expected.original_sha256,
        "mutated_sha256": expected.mutated_sha256,
    }


def mutation_report_payload(
    *,
    head: str,
    worker_id: int,
    assigned: list[ExpectedMutationResult],
    results: list[dict[str, object]],
    complete: bool,
) -> dict[str, object]:
    return {
        "version": REPORT_VERSION,
        "phase": "mutations",
        "head": head,
        "registry_digest": mutation_registry_digest(),
        "worker_id": worker_id,
        "assigned": [item.name for item in assigned],
        "complete": complete,
        "results": results,
    }


def validate_mutation_report(
    payload: object,
    *,
    head: str,
    worker_id: int,
    expected: list[ExpectedMutationResult],
    process_returncode: int,
    accept_wrong_head: bool = False,
    accept_missing_result: bool = False,
    accept_duplicate_result: bool = False,
    accept_extra_result: bool = False,
    accept_process_disagreement: bool = False,
    accept_malformed_types: bool = False,
    accept_wrong_registry: bool = False,
    accept_incomplete: bool = False,
) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        raise ValueError("worker mutation report is not an object")
    required = {
        "version",
        "phase",
        "head",
        "registry_digest",
        "worker_id",
        "assigned",
        "complete",
        "results",
    }
    if set(payload) != required:
        raise ValueError("worker mutation report has an invalid field inventory")
    if (
        (
            type(payload["version"]) is not int
            or payload["version"] != REPORT_VERSION
            or not isinstance(payload["phase"], str)
            or payload["phase"] != "mutations"
        )
        and not accept_malformed_types
    ):
        raise ValueError("worker mutation report has an invalid schema or phase")
    if not accept_wrong_head and payload["head"] != head:
        raise ValueError("worker mutation report names the wrong commit")
    if (
        payload["registry_digest"] != mutation_registry_digest()
        and not accept_wrong_registry
    ):
        raise ValueError("worker mutation report names the wrong mutation registry")
    if (
        (type(payload["worker_id"]) is not int or payload["worker_id"] != worker_id)
        and not accept_malformed_types
    ):
        raise ValueError("worker mutation report names the wrong worker")
    if payload["assigned"] != [item.name for item in expected]:
        raise ValueError("worker mutation report names the wrong shard")
    if payload["complete"] is not True and not accept_incomplete:
        raise ValueError("worker mutation report is incomplete")
    rows = payload["results"]
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("worker mutation results are not an object array")

    expected_by_name = {item.name: item for item in expected}
    names = [row.get("name") for row in rows]
    duplicates = sorted(
        {
            name
            for name in names
            if isinstance(name, str) and names.count(name) > 1
        }
    )
    missing = sorted(set(expected_by_name) - {name for name in names if isinstance(name, str)})
    extra = sorted(
        {
            name if isinstance(name, str) else repr(name)
            for name in names
            if not isinstance(name, str) or name not in expected_by_name
        }
    )
    if duplicates and not accept_duplicate_result:
        raise ValueError(f"worker mutation report duplicates results: {duplicates}")
    if missing and not accept_missing_result:
        raise ValueError(f"worker mutation report omits results: {missing}")
    if extra and not accept_extra_result:
        raise ValueError(f"worker mutation report adds results: {extra}")

    row_fields = {
        "ordinal",
        "name",
        "outcome",
        "detail",
        "expected",
        "original_sha256",
        "mutated_sha256",
    }
    seen: set[str] = set()
    for row in rows:
        if set(row) != row_fields:
            raise ValueError("worker mutation result has an invalid field inventory")
        name = row["name"]
        if not isinstance(name, str):
            if accept_extra_result:
                continue
            raise ValueError("worker mutation result has a non-string name")
        item = expected_by_name.get(name)
        if item is None:
            if accept_extra_result:
                continue
            raise ValueError(f"worker mutation result is unknown: {name}")
        if name in seen:
            if accept_duplicate_result:
                continue
            raise ValueError(f"worker mutation result is duplicated: {name}")
        seen.add(name)
        if (
            (
                type(row["ordinal"]) is not int
                or row["ordinal"] != item.ordinal
            )
            and not accept_malformed_types
        ) or (
            (
                row["expected"] != item.expected
                or row["original_sha256"] != item.original_sha256
                or row["mutated_sha256"] != item.mutated_sha256
            )
        ):
            raise ValueError(f"worker mutation result metadata differs for {name}")
        if (
            not isinstance(row["expected"], str)
            or not isinstance(row["original_sha256"], str)
            or not isinstance(row["mutated_sha256"], str)
        ):
            raise ValueError(f"worker mutation result metadata has invalid types for {name}")
        if row["outcome"] not in ("caught", "survived", "wrong-path", "stale"):
            raise ValueError(f"worker mutation result has an invalid outcome for {name}")
        if not isinstance(row["detail"], str):
            raise ValueError(f"worker mutation result has a non-string detail for {name}")

    known_rows = [
        row for row in rows if isinstance(row.get("name"), str) and row["name"] in expected_by_name
    ]
    wanted_order = [item.name for item in expected if item.name in seen]
    observed_order = []
    for row in known_rows:
        name = str(row["name"])
        if name not in observed_order:
            observed_order.append(name)
    if observed_order != wanted_order:
        raise ValueError("worker mutation results are not in shard order")
    expected_returncode = (
        0
        if len(seen) == len(expected) and all(row["outcome"] == "caught" for row in known_rows)
        else 1
    )
    if not accept_process_disagreement and process_returncode != expected_returncode:
        raise ValueError(
            "worker process/report disagreement: "
            f"exit={process_returncode}, report expects {expected_returncode}"
        )
    return rows


def validate_baseline_report(
    payload: object,
    *,
    head: str,
    worker_id: int,
    assigned: list[ExpectedMutationResult],
    process_returncode: int,
    accept_malformed_types: bool = False,
) -> None:
    if not isinstance(payload, dict):
        raise ValueError("worker baseline report is not an object")
    required = {
        "version",
        "phase",
        "head",
        "registry_digest",
        "worker_id",
        "assigned",
        "complete",
        "green",
        "diagnostic",
    }
    if set(payload) != required:
        raise ValueError("worker baseline report has an invalid field inventory")
    malformed_identity = (
        type(payload["version"]) is not int
        or type(payload["worker_id"]) is not int
    )
    if (
        (malformed_identity and not accept_malformed_types)
        or payload["version"] != REPORT_VERSION
        or payload["phase"] != "baseline"
        or payload["head"] != head
        or payload["registry_digest"] != mutation_registry_digest()
        or payload["worker_id"] != worker_id
        or payload["assigned"] != [item.name for item in assigned]
        or payload["complete"] is not True
        or not isinstance(payload["green"], bool)
        or not isinstance(payload["diagnostic"], str)
    ):
        raise ValueError("worker baseline report does not match its assignment")
    expected_returncode = 0 if payload["green"] else 2
    if process_returncode != expected_returncode:
        raise ValueError(
            "worker baseline process/report disagreement: "
            f"exit={process_returncode}, report expects {expected_returncode}"
        )
    if not payload["green"]:
        raise ValueError(f"worker baseline is red: {payload['diagnostic'][:500]}")


def validate_owned_worktree_path(
    run_root: Path,
    path: Path,
    *,
    allow_outside: bool = False,
) -> None:
    resolved_root = run_root.resolve()
    resolved_path = path.resolve()
    owned = (
        resolved_path.parent == resolved_root
        and re.fullmatch(r"worker-\d{2}", resolved_path.name) is not None
    )
    if not owned and not allow_outside:
        raise ValueError(f"refusing cleanup outside owned run root: {path}")


def protected_cpu_cores(total_cores: int) -> int:
    if total_cores < 1:
        raise ValueError("mutation audit cannot identify a positive host CPU count")
    if total_cores > 8:
        return total_cores - 4
    if total_cores > 4:
        return total_cores // 2 + 2
    return total_cores


def host_cpu_count() -> int:
    try:
        return len(os.sched_getaffinity(0))
    except AttributeError:
        return os.cpu_count() or 1


def host_memory_bytes() -> int:
    for line in Path("/proc/meminfo").read_text().splitlines():
        match = re.fullmatch(r"MemTotal:\s+(\d+)\s+kB", line)
        if match:
            return int(match.group(1)) * 1024
    raise ValueError("mutation audit cannot identify host memory capacity")


def validate_scope_limits(
    memory_max: str,
    swap_max: str,
    cpu_max: str,
    *,
    host_memory: int,
    host_cpus: int,
    accept_unconfined: bool = False,
    accept_oversized_memory: bool = False,
    accept_oversized_cpu: bool = False,
) -> tuple[int, int]:
    try:
        memory = int(memory_max)
        swap = int(swap_max)
        quota_text, period_text = cpu_max.split()
        quota = int(quota_text)
        period = int(period_text)
    except (ValueError, TypeError) as error:
        if accept_unconfined:
            return (1, 1)
        raise ValueError("mutation audit is not inside finite cgroup limits") from error
    if memory <= 0 or swap != 0 or quota <= 0 or period <= 0:
        if accept_unconfined:
            return (max(1, memory), max(1, quota))
        raise ValueError(
            "mutation audit cgroup must have finite positive memory/CPU and zero swap"
        )
    if host_memory < 1:
        raise ValueError("mutation audit cannot identify positive host memory")
    memory_ceiling = host_memory * 3 // 4
    if memory > memory_ceiling and not accept_oversized_memory:
        raise ValueError(
            "mutation audit cgroup memory limit exceeds 75% of host memory"
        )
    cpu_ceiling = protected_cpu_cores(host_cpus) * period
    if quota > cpu_ceiling and not accept_oversized_cpu:
        raise ValueError(
            "mutation audit cgroup CPU limit does not preserve the host reserve"
        )
    return memory, quota


def prove_confined_scope(*, accept_unconfined: bool = False) -> ConfinedScope:
    cgroup = next(
        (
            line.removeprefix("0::")
            for line in Path("/proc/self/cgroup").read_text().splitlines()
            if line.startswith("0::")
        ),
        "",
    )
    if not cgroup.startswith("/"):
        raise ValueError("mutation audit cannot identify its cgroup-v2 scope")
    cgroup_root = Path("/sys/fs/cgroup")
    scope = (cgroup_root / cgroup.lstrip("/")).resolve()
    try:
        scope.relative_to(cgroup_root)
        memory_text = (scope / "memory.max").read_text().strip()
        swap_text = (scope / "memory.swap.max").read_text().strip()
        cpu_text = (scope / "cpu.max").read_text().strip()
    except (OSError, ValueError) as error:
        raise ValueError(f"mutation audit cannot inspect cgroup {cgroup}") from error
    memory, quota = validate_scope_limits(
        memory_text,
        swap_text,
        cpu_text,
        host_memory=host_memory_bytes(),
        host_cpus=host_cpu_count(),
        accept_unconfined=accept_unconfined,
    )
    return ConfinedScope(cgroup, memory, quota)


def prove_workspace_links(
    root: Path,
    *,
    accept_external: bool = False,
) -> IsolatedWorkspace:
    candidates = sorted(root.glob("packages/*/node_modules/@durablerun/*"))
    if not candidates:
        raise ValueError(f"{root}: isolated install created no workspace links")
    resolved_root = root.resolve()
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            resolved.relative_to(resolved_root)
        except (FileNotFoundError, ValueError) as error:
            if accept_external:
                continue
            raise ValueError(
                f"{candidate}: workspace dependency escapes or is broken ({error})"
            ) from error
    return IsolatedWorkspace(resolved_root)


def prove_worker_authority(
    *,
    worker_root: Path,
    run_root: Path,
    report_path: Path,
    head: str,
    worker_id: int,
    nonce: str,
    phase: str,
    baseline_barrier: str | None,
    mutation_names: list[str],
    accept_unowned: bool = False,
) -> WorkerAuthority:
    if accept_unowned:
        return WorkerAuthority(
            run_root.resolve(),
            worker_root.resolve(),
            worker_id,
            head,
            nonce,
        )
    validate_owned_worktree_path(run_root, worker_root)
    expected_report = run_root / f"{phase}-{worker_id:02}.json"
    if report_path.resolve() != expected_report.resolve():
        raise ValueError("worker result path is not coordinator-owned")
    if not (worker_root / ".git").is_file():
        raise ValueError("worker root is not a linked Git worktree")
    manifest_path = run_root / "manifest.json"
    payload = read_json(manifest_path)
    if not isinstance(payload, dict):
        raise ValueError("worker ownership manifest is not an object")
    required = {
        "version",
        "kind",
        "pid",
        "source_root",
        "head",
        "nonce",
        "state",
        "baseline_barrier",
        "worktrees",
        "shards",
    }
    if set(payload) != required:
        raise ValueError("worker ownership manifest has an invalid field inventory")
    worktrees = payload["worktrees"]
    shards = payload["shards"]
    if (
        type(payload["version"]) is not int
        or payload["version"] != REPORT_VERSION
        or payload["kind"] != "durablerun-mutation-worktrees"
        or type(payload["pid"]) is not int
        or payload["head"] != head
        or payload["nonce"] != nonce
        or payload["state"] != phase
        or payload["baseline_barrier"] != baseline_barrier
        or not isinstance(worktrees, list)
        or not isinstance(shards, list)
        or worker_id < 0
        or worker_id >= len(worktrees)
        or worker_id >= len(shards)
        or worktrees[worker_id] != str(worker_root)
        or shards[worker_id] != mutation_names
        or Path(str(payload["source_root"])).resolve() == worker_root.resolve()
    ):
        raise ValueError("worker ownership manifest does not authorize this process")
    return WorkerAuthority(
        run_root.resolve(),
        worker_root.resolve(),
        worker_id,
        head,
        nonce,
    )


def validate_baseline_barrier(
    barrier: BaselineBarrier | None,
    *,
    head: str,
    worker_ids: tuple[int, ...],
    accept_missing: bool = False,
) -> None:
    valid = (
        isinstance(barrier, BaselineBarrier)
        and barrier.head == head
        and barrier.worker_ids == worker_ids
        and re.fullmatch(r"[0-9a-f]{64}", barrier.digest) is not None
    )
    if not valid and not accept_missing:
        raise ValueError("mutation phase has no complete exact-head baseline barrier")


def worker_install_command(
    store: Path,
    *,
    use_worker_default: bool = False,
) -> tuple[str, ...]:
    if not store.is_absolute():
        raise ValueError("the canonical pnpm store path must be absolute")
    command = ["pnpm", "install", "--offline", "--frozen-lockfile"]
    if not use_worker_default:
        command.extend(("--store-dir", str(store)))
    return tuple(command)


def resolve_pnpm_store(root: Path) -> Path:
    result = subprocess.run(
        ["pnpm", "store", "path"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    output = result.stdout.strip()
    if result.returncode != 0:
        diagnostic = (result.stdout + result.stderr).strip()
        raise RuntimeError(
            f"cannot resolve the coordinator's pnpm store: {diagnostic[:500]}"
        )
    if not output or "\n" in output:
        raise RuntimeError(
            "cannot resolve the coordinator's pnpm store: "
            f"expected one path, observed {output!r}"
        )
    store = Path(output)
    if not store.is_absolute():
        raise RuntimeError(
            "cannot resolve the coordinator's pnpm store: "
            f"pnpm returned non-absolute path {output!r}"
        )
    resolved = store.resolve()
    if not resolved.is_dir():
        raise RuntimeError(
            f"the coordinator's pnpm store does not exist: {resolved}"
        )
    return resolved


def orchestration_self_test(fault: str | None = None) -> int:
    """Generated false-positive surface for the parallel coordinator."""
    expected = [
        ExpectedMutationResult(
            ordinal,
            f"mutation-{ordinal}",
            f"expected-{ordinal}",
            f"{ordinal:064x}",
            f"{ordinal + 1:064x}",
        )
        for ordinal in range(7)
    ]
    failures: list[str] = []
    try:
        shards = partition_expected(
            expected,
            3,
            fault=fault if fault in ("drop-assignment", "duplicate-assignment") else None,
        )
        validate_shards(shards, expected)
    except ValueError as error:
        failures.append(f"shard coverage: {error}")

    assigned = expected[:3]
    good_rows = [mutation_result_row(item, "caught", "attributable") for item in assigned]
    good = mutation_report_payload(
        head="a" * 40,
        worker_id=2,
        assigned=assigned,
        results=good_rows,
        complete=True,
    )
    try:
        validate_mutation_report(
            good,
            head="a" * 40,
            worker_id=2,
            expected=assigned,
            process_returncode=0,
        )
    except ValueError as error:
        failures.append(f"valid report rejected: {error}")

    def expect_rejected(
        label: str,
        payload: dict[str, object],
        *,
        returncode: int = 0,
        **weakness: bool,
    ) -> None:
        try:
            validate_mutation_report(
                payload,
                head="a" * 40,
                worker_id=2,
                expected=assigned,
                process_returncode=returncode,
                **weakness,
            )
        except ValueError:
            return
        failures.append(f"{label}: invalid report was accepted")

    wrong_head = json.loads(json.dumps(good))
    wrong_head["head"] = "b" * 40
    expect_rejected(
        "wrong head",
        wrong_head,
        accept_wrong_head=fault == "accept-wrong-head",
    )
    wrong_registry = json.loads(json.dumps(good))
    wrong_registry["registry_digest"] = "f" * 64
    expect_rejected(
        "wrong registry",
        wrong_registry,
        accept_wrong_registry=fault == "accept-wrong-registry",
    )
    incomplete = json.loads(json.dumps(good))
    incomplete["complete"] = False
    expect_rejected(
        "incomplete worker",
        incomplete,
        accept_incomplete=fault == "accept-incomplete-worker",
    )
    missing = json.loads(json.dumps(good))
    missing["results"] = missing["results"][:-1]
    expect_rejected(
        "missing result",
        missing,
        returncode=1,
        accept_missing_result=fault == "accept-missing-result",
    )
    duplicate = json.loads(json.dumps(good))
    duplicate["results"].append(dict(duplicate["results"][0]))
    expect_rejected(
        "duplicate result",
        duplicate,
        accept_duplicate_result=fault == "accept-duplicate-result",
    )
    extra = json.loads(json.dumps(good))
    extra["results"].append(
        {
            "ordinal": 99,
            "name": "foreign",
            "outcome": "caught",
            "detail": "foreign",
            "expected": "foreign",
            "original_sha256": "c" * 64,
            "mutated_sha256": "d" * 64,
        }
    )
    expect_rejected(
        "extra result",
        extra,
        accept_extra_result=fault == "accept-extra-result",
    )
    expect_rejected(
        "process/report disagreement",
        good,
        returncode=1,
        accept_process_disagreement=fault
        == "accept-process-report-disagreement",
    )
    malformed_types = json.loads(json.dumps(good))
    malformed_types["version"] = True
    malformed_types["worker_id"] = 2.0
    malformed_types["results"][0]["ordinal"] = False
    expect_rejected(
        "malformed identity types",
        malformed_types,
        accept_malformed_types=fault == "accept-malformed-result-types",
    )
    malformed_baseline = {
        "version": True,
        "phase": "baseline",
        "head": "a" * 40,
        "registry_digest": mutation_registry_digest(),
        "worker_id": 2.0,
        "assigned": [item.name for item in assigned],
        "complete": True,
        "green": True,
        "diagnostic": "",
    }
    try:
        validate_baseline_report(
            malformed_baseline,
            head="a" * 40,
            worker_id=2,
            assigned=assigned,
            process_returncode=0,
            accept_malformed_types=fault == "accept-malformed-result-types",
        )
    except ValueError:
        pass
    else:
        failures.append("malformed baseline identity types were accepted")

    with tempfile.TemporaryDirectory(prefix="durablerun-orchestration-selftest-") as tmp:
        temporary = Path(tmp)
        if fault in (None, "use-worker-local-pnpm-store"):
            canonical_store = temporary / "canonical-pnpm-store"
            command = worker_install_command(
                canonical_store,
                use_worker_default=fault == "use-worker-local-pnpm-store",
            )
            if command[-2:] != ("--store-dir", str(canonical_store)):
                failures.append(
                    "dependency store: worker install did not use the "
                    "coordinator's canonical pnpm store"
                )
        run_root = temporary / "run"
        run_root.mkdir()
        outside = run_root.parent / "not-owned" / "worker-00"
        try:
            validate_owned_worktree_path(
                run_root,
                outside,
                allow_outside=fault == "accept-outside-cleanup",
            )
        except ValueError:
            pass
        else:
            failures.append("outside cleanup: non-owned worktree was accepted")

        worker_root = run_root / "worker-00"
        worker_root.mkdir()
        (worker_root / ".git").write_text("gitdir: fixture\n")
        if fault in (None, "allow-host-sized-tokio-pools"):
            environment_plan = WorkerPlan(
                0,
                worker_root,
                temporary / "worker-tmp",
                temporary / "baseline.json",
                temporary / "mutations.json",
                temporary / "install.log",
                temporary / "baseline.log",
                temporary / "mutations.log",
                (),
            )
            inherited_tokio_threads = os.environ.get("TOKIO_WORKER_THREADS")
            os.environ["TOKIO_WORKER_THREADS"] = "1"
            try:
                environment = worker_environment(
                    environment_plan,
                    allow_host_sized_tokio=(
                        fault == "allow-host-sized-tokio-pools"
                    ),
                )
            finally:
                if inherited_tokio_threads is None:
                    os.environ.pop("TOKIO_WORKER_THREADS", None)
                else:
                    os.environ["TOKIO_WORKER_THREADS"] = inherited_tokio_threads
            if environment.get("TOKIO_WORKER_THREADS") != "1":
                failures.append(
                    "native thread budget: worker suites can create "
                    "host-sized Tokio pools"
                )
        source_root = temporary / "source"
        source_root.mkdir()
        (source_root / ".git").mkdir()
        authority_manifest = {
            "version": REPORT_VERSION,
            "kind": "durablerun-mutation-worktrees",
            "pid": os.getpid(),
            "source_root": str(source_root),
            "head": "a" * 40,
            "nonce": "fixture-nonce",
            "state": "baseline",
            "baseline_barrier": None,
            "worktrees": [str(worker_root)],
            "shards": [["mutation-0"]],
        }
        atomic_json(run_root / "manifest.json", authority_manifest)
        try:
            prove_worker_authority(
                worker_root=worker_root,
                run_root=run_root,
                report_path=run_root / "baseline-00.json",
                head="a" * 40,
                worker_id=0,
                nonce="fixture-nonce",
                phase="baseline",
                baseline_barrier=None,
                mutation_names=["mutation-0"],
            )
        except ValueError as error:
            failures.append(f"valid worker authority rejected: {error}")
        try:
            prove_worker_authority(
                worker_root=source_root,
                run_root=run_root,
                report_path=temporary / "arbitrary.json",
                head="a" * 40,
                worker_id=0,
                nonce="forged",
                phase="baseline",
                baseline_barrier=None,
                mutation_names=["mutation-0"],
                accept_unowned=fault == "accept-unowned-worker",
            )
        except ValueError:
            pass
        else:
            failures.append("unowned worker: primary-style checkout was authorized")

        workspace = temporary / "workspace"
        inside_target = workspace / "packages" / "core"
        inside_target.mkdir(parents=True)
        link_parent = (
            workspace
            / "packages"
            / "example"
            / "node_modules"
            / "@durablerun"
        )
        link_parent.mkdir(parents=True)
        (link_parent / "core").symlink_to(inside_target, target_is_directory=True)
        try:
            prove_workspace_links(workspace)
        except ValueError as error:
            failures.append(f"valid isolated workspace rejected: {error}")
        external_target = temporary / "external-package"
        external_target.mkdir()
        (link_parent / "external").symlink_to(
            external_target,
            target_is_directory=True,
        )
        try:
            prove_workspace_links(
                workspace,
                accept_external=fault == "accept-external-workspace-link",
            )
        except ValueError:
            pass
        else:
            failures.append("workspace isolation: external package link was accepted")

        barrier = BaselineBarrier("a" * 40, (0, 1), "b" * 64)
        try:
            validate_baseline_barrier(
                barrier,
                head="a" * 40,
                worker_ids=(0, 1),
            )
        except ValueError as error:
            failures.append(f"valid baseline barrier rejected: {error}")
        try:
            validate_baseline_barrier(
                None,
                head="a" * 40,
                worker_ids=(0, 1),
                accept_missing=fault == "skip-baseline-barrier",
            )
        except ValueError:
            pass
        else:
            failures.append("baseline barrier: mutation phase accepted no barrier")

        if fault in (None, "leave-descendant-running"):
            descendant_log = temporary / "descendant.log"
            child_code = (
                "import subprocess,sys; "
                "child=subprocess.Popen([sys.executable,'-c',"
                "'import time; time.sleep(30)']); "
                "print(child.pid, flush=True); raise SystemExit(2)"
            )
            launch = ProcessLaunch(
                "descendant-self-test",
                (sys.executable, "-c", child_code),
                temporary,
                descendant_log,
                os.environ.copy(),
            )
            try:
                run_launches(
                    [launch],
                    allowed_returncodes=frozenset((0,)),
                    omit_exited_groups=fault == "leave-descendant-running",
                )
            except RuntimeError:
                pass
            child_pid = int(descendant_log.read_text().splitlines()[0])
            deadline = time.monotonic() + 2
            while process_id_is_live(child_pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            if process_id_is_live(child_pid):
                failures.append("process cleanup: exited leader left a live descendant")
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

        if fault in (None, "leave-zombie-group"):
            zombie = subprocess.Popen(
                (sys.executable, "-c", "raise SystemExit(0)"),
                cwd=temporary,
                start_new_session=True,
            )
            deadline = time.monotonic() + 2
            state = ""
            while time.monotonic() < deadline:
                try:
                    state = Path(f"/proc/{zombie.pid}/stat").read_text().split()[2]
                except OSError:
                    state = ""
                if state == "Z":
                    break
                time.sleep(0.01)
            if state != "Z":
                failures.append("process cleanup: could not construct a zombie leader")
            else:
                cleanup_started = time.monotonic()
                try:
                    terminate_process_groups(
                        [zombie],
                        reap_exited_leaders=fault != "leave-zombie-group",
                    )
                except RuntimeError:
                    failures.append(
                        "process cleanup: a zombie leader impersonated a live group"
                    )
                if time.monotonic() - cleanup_started > 1:
                    failures.append(
                        "process cleanup: a zombie leader delayed group cleanup"
                    )
            zombie.wait()

    try:
        validate_scope_limits(
            "750",
            "0",
            "600000 100000",
            host_memory=1000,
            host_cpus=8,
        )
    except ValueError as error:
        failures.append(f"confinement: valid protective limits rejected: {error}")

    invalid_scopes = (
        (
            "unlimited cgroup values",
            ("max", "max", "max 100000"),
            {
                "accept_unconfined": fault == "accept-unconfined-scope",
            },
        ),
        (
            "oversized finite memory limit",
            ("751", "0", "600000 100000"),
            {
                "accept_oversized_memory": fault
                == "accept-oversized-finite-scope",
            },
        ),
        (
            "oversized finite CPU limit",
            ("750", "0", "600001 100000"),
            {
                "accept_oversized_cpu": fault == "accept-oversized-cpu-scope",
            },
        ),
    )
    for label, values, weakness in invalid_scopes:
        try:
            validate_scope_limits(
                *values,
                host_memory=1000,
                host_cpus=8,
                **weakness,
            )
        except ValueError:
            pass
        else:
            failures.append(f"confinement: {label} were accepted")

    previous = {signal.SIGTERM: signal.getsignal(signal.SIGTERM)}
    shield = CleanupSignalShield(
        previous,
        raise_instead=fault == "interrupt-cleanup",
    )
    try:
        with shield:
            shield.defer(signal.SIGTERM, None)
    except AuditSignal:
        failures.append("cleanup signal: a repeat signal interrupted cleanup")
    if fault != "interrupt-cleanup" and shield.deferred_signum != signal.SIGTERM:
        failures.append("cleanup signal: signal was not deferred")

    caught_row = [mutation_result_row(assigned[0], "caught", "attributable")]
    if may_publish_success(
        2,
        caught_row,
        publish_after_infrastructure=fault == "publish-success-after-infra",
    ):
        failures.append("final verdict: infrastructure failure published success")
    if not may_publish_success(0, caught_row):
        failures.append("final verdict: complete success was rejected")
    transport_failures = (
        (
            "worker signal",
            (
                "import json,os,pathlib,signal,sys; "
                "path=sys.argv[sys.argv.index('--outputFile')+1]; "
                "pathlib.Path(path).write_text(json.dumps({"
                "'success':True,"
                "'numTotalTestSuites':0,'numPassedTestSuites':0,"
                "'numFailedTestSuites':0,'numPendingTestSuites':0,"
                "'numTotalTests':0,'numPassedTests':0,'numFailedTests':0,"
                "'numPendingTests':0,'numTodoTests':0,'testResults':[]})); "
                "os.kill(os.getpid(), signal.SIGKILL)"
            ),
            "report-worker-crash-as-domain",
        ),
        (
            "missing report",
            "raise SystemExit(1)",
            "classify-missing-report-as-domain",
        ),
        (
            "malformed report",
            (
                "import pathlib,sys; "
                "path=sys.argv[sys.argv.index('--outputFile')+1]; "
                "pathlib.Path(path).write_text('{'); "
                "raise SystemExit(1)"
            ),
            "classify-malformed-report-as-domain",
        ),
        (
            "structurally incoherent report",
            (
                "import json,pathlib,sys; "
                "path=sys.argv[sys.argv.index('--outputFile')+1]; "
                "pathlib.Path(path).write_text(json.dumps({"
                "'success':False,"
                "'numTotalTestSuites':0,'numPassedTestSuites':0,"
                "'numFailedTestSuites':0,'numPendingTestSuites':0,"
                "'numTotalTests':1,'numPassedTests':0,'numFailedTests':0,"
                "'numPendingTests':0,'numTodoTests':0,'testResults':[]})); "
                "raise SystemExit(1)"
            ),
            "classify-structural-report-as-domain",
        ),
    )
    fixture_scope = ConfinedScope("self-test", 1, 1)
    fixture_workspace = IsolatedWorkspace(ROOT.resolve())
    fixture_authority = WorkerAuthority(
        ROOT.resolve(),
        ROOT.resolve(),
        0,
        "a" * 40,
        "self-test",
    )
    for label, program, fault_name in transport_failures:
        original_command = TEST_CMD[:]
        TEST_CMD[:] = [sys.executable, "-c", program]
        try:
            weakness = (
                {"return_transport_as_domain": True}
                if fault == fault_name
                else {}
            )
            try:
                run_suite(
                    1,
                    scope=fixture_scope,
                    workspace=fixture_workspace,
                    authority=fixture_authority,
                    **weakness,
                )
            except SuiteInfrastructureError:
                continue
            except Exception as error:
                failures.append(
                    f"worker failure: {label} raised the wrong exception: {error}"
                )
            else:
                failures.append(
                    f"worker failure: {label} became a domain verdict"
                )
        finally:
            TEST_CMD[:] = original_command

    if failures:
        if fault is not None:
            print(
                "mutation-probe orchestration self-test caught injected fault "
                f"{fault}: {failures[0]}",
                file=sys.stderr,
            )
        else:
            for failure in failures:
                print(
                    f"mutation-probe orchestration self-test: {failure}",
                    file=sys.stderr,
                )
        return 1
    if fault is not None:
        print(
            "mutation-probe orchestration self-test MISSED injected fault "
            f"{fault}",
            file=sys.stderr,
        )
        return 0
    for injected_fault in ORCHESTRATION_SELF_TEST_FAULTS:
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--orchestration-self-test",
                "--orchestration-self-test-fault",
                injected_fault,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        marker = (
            "mutation-probe orchestration self-test caught injected fault "
            f"{injected_fault}"
        )
        if result.returncode != 1 or marker not in (result.stdout + result.stderr):
            print(
                "mutation-probe orchestration self-test: declared fault "
                f"{injected_fault!r} was not caught through its CLI path",
                file=sys.stderr,
            )
            return 1
    print(
        "mutation-probe orchestration self-test: "
        f"{len(ORCHESTRATION_SELF_TEST_FAULTS)} declared injected faults exercised "
        "from canonical inventory; deterministic shards; exact head, result "
        "inventory, process verdict, and cleanup ownership"
    )
    return 0


def git_result(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    return subprocess.run(
        ["git", *args],
        cwd=root,
        capture_output=True,
        text=True,
        env=environment,
    )


def git_output(root: Path, *args: str) -> str:
    result = git_result(root, *args)
    if result.returncode != 0:
        diagnostic = (result.stdout + result.stderr).strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {diagnostic[:500]}")
    return result.stdout.strip()


def assert_clean(root: Path = ROOT) -> None:
    """Refuse to start with uncommitted changes, and say why.

    The coordinator never mutates this tree: it captures the commit and gives
    each shard its own detached worktree. Clean input is still required so the
    exact commit completely describes the code whose evidence is published.
    """
    result = git_result(root, "status", "--porcelain")
    if result.returncode != 0:
        diagnostic = (result.stdout + result.stderr).strip()
        print(
            f"mutation-probe: cannot prove the tree is clean: {diagnostic[:500]}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    dirty = result.stdout.strip()
    if dirty:
        print(
            "mutation-probe: refusing to run with a dirty tree.\n"
            "  The committed HEAD must completely describe the code under audit.\n"
            "  Commit or stash first; the coordinator will mutate detached temporary\n"
            "  worktrees only. Current changes:\n"
            f"{dirty}",
            file=sys.stderr,
        )
        raise SystemExit(2)


def atomic_json(path: Path, payload: object) -> None:
    temporary = path.with_name(f"{path.name}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    temporary.replace(path)


def read_json(path: Path) -> object:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"cannot read structured worker result {path}: {error}") from error


def suite_failure_detail(result: SuiteResult) -> str:
    observed = [
        f"{failure.file} > {failure.full_name}: "
        f"{next(iter(failure.messages), '(no failure message)')[:180]}"
        for failure in result.assertions[:3]
    ]
    observed.extend(error[:180] for error in result.suite_errors[:3])
    if not observed and result.diagnostic:
        observed.append(result.diagnostic[:180])
    return "; ".join(observed) if observed else "(no structured failure)"


def execute_mutation(
    mutation: Mutation,
    expected: ExpectedMutationResult,
    *,
    max_workers: int,
    scope: ConfinedScope,
    workspace: IsolatedWorkspace,
    authority: WorkerAuthority,
) -> dict[str, object]:
    path = ROOT / mutation.file
    original = path.read_text()
    if sha256_text(original) != expected.original_sha256:
        raise RuntimeError(f"{mutation.name}: worker source differs from its captured hash")
    occurrences = original.count(mutation.find)
    if occurrences != 1:
        return mutation_result_row(
            expected,
            "stale",
            f"pattern occurs {occurrences} times in {mutation.file}; expected exactly one",
        )
    mutated = original.replace(mutation.find, mutation.replace, 1)
    if sha256_text(mutated) != expected.mutated_sha256:
        raise RuntimeError(f"{mutation.name}: worker mutation differs from its captured hash")

    wrote_mutation = False
    try:
        path.write_text(mutated)
        wrote_mutation = True
        changed = git_output(ROOT, "diff", "--name-only", "--").splitlines()
        if changed != [mutation.file]:
            raise RuntimeError(
                f"{mutation.name}: worker diff is {changed}, expected only {mutation.file}"
            )
        result = run_suite(
            max_workers,
            scope=scope,
            workspace=workspace,
            authority=authority,
        )
        outcome = classify_verdict(result, mutation.verdict)
        if outcome == "caught":
            detail = (
                f"{mutation.verdict.kind} verdict {mutation.verdict.full_name}"
            )
        elif outcome == "survived":
            detail = mutation.breaks
        else:
            detail = suite_failure_detail(result)
        return mutation_result_row(expected, outcome, detail)
    finally:
        if wrote_mutation:
            current = path.read_text()
            if current != mutated:
                raise RuntimeError(
                    f"{mutation.name}: isolated worker source changed concurrently"
                )
            path.write_text(original)
            assert_clean(ROOT)


def worker_phase(
    *,
    phase: str,
    report_path: Path,
    head: str,
    worker_id: int,
    mutation_names: list[str],
    max_workers: int,
    run_root: Path,
    nonce: str,
    baseline_barrier: str | None,
) -> int:
    if os.environ.get(CONFINEMENT_ENV) != "1":
        print("mutation-probe worker refuses to run outside its coordinator scope", file=sys.stderr)
        return 2
    scope = prove_confined_scope()
    authority = prove_worker_authority(
        worker_root=ROOT,
        run_root=run_root,
        report_path=report_path,
        head=head,
        worker_id=worker_id,
        nonce=nonce,
        phase=phase,
        baseline_barrier=baseline_barrier,
        mutation_names=mutation_names,
    )
    actual_head = git_output(ROOT, "rev-parse", "HEAD^{commit}")
    if actual_head != head:
        print(
            f"mutation-probe worker {worker_id}: expected {head}, found {actual_head}",
            file=sys.stderr,
        )
        return 2
    assert_clean(ROOT)
    workspace = prove_workspace_links(ROOT)
    by_name = {mutation.name: (ordinal, mutation) for ordinal, mutation in enumerate(MUTATIONS)}
    if (
        len(mutation_names) != len(set(mutation_names))
        or any(name not in by_name for name in mutation_names)
        or mutation_names
        != sorted(mutation_names, key=lambda name: by_name[name][0])
    ):
        print(
            f"mutation-probe worker {worker_id}: invalid mutation assignment",
            file=sys.stderr,
        )
        return 2
    assigned = [
        expected_result(by_name[name][0], by_name[name][1], root=ROOT)
        for name in mutation_names
    ]
    if phase == "baseline":
        baseline = run_suite(
            max_workers,
            scope=scope,
            workspace=workspace,
            authority=authority,
        )
        payload = {
            "version": REPORT_VERSION,
            "phase": "baseline",
            "head": head,
            "registry_digest": mutation_registry_digest(),
            "worker_id": worker_id,
            "assigned": mutation_names,
            "complete": True,
            "green": baseline.green,
            "diagnostic": suite_failure_detail(baseline) if not baseline.green else "",
        }
        atomic_json(report_path, payload)
        return 0 if baseline.green else 2
    if phase != "mutations":
        print(f"mutation-probe worker {worker_id}: unknown phase {phase}", file=sys.stderr)
        return 2

    rows: list[dict[str, object]] = []
    atomic_json(
        report_path,
        mutation_report_payload(
            head=head,
            worker_id=worker_id,
            assigned=assigned,
            results=rows,
            complete=False,
        ),
    )
    for item in assigned:
        mutation = by_name[item.name][1]
        row = execute_mutation(
            mutation,
            item,
            max_workers=max_workers,
            scope=scope,
            workspace=workspace,
            authority=authority,
        )
        rows.append(row)
        atomic_json(
            report_path,
            mutation_report_payload(
                head=head,
                worker_id=worker_id,
                assigned=assigned,
                results=rows,
                complete=False,
            ),
        )
    atomic_json(
        report_path,
        mutation_report_payload(
            head=head,
            worker_id=worker_id,
            assigned=assigned,
            results=rows,
            complete=True,
        ),
    )
    return 0 if all(row["outcome"] == "caught" for row in rows) else 1


def usable_cores() -> int:
    quota = os.environ.get("CONFINE_CPU", "")
    match = re.fullmatch(r"(\d+)%", quota)
    if match:
        return max(1, int(match.group(1)) // 100)
    return protected_cpu_cores(host_cpu_count())


def choose_jobs(value: str, selected: int) -> int:
    available = usable_cores()
    if value == "auto":
        return min(
            selected,
            MAX_AUTO_JOBS,
            max(1, available // MIN_CORES_PER_AUTO_JOB),
        )
    try:
        jobs = int(value)
    except ValueError as error:
        raise ValueError("--jobs must be 'auto' or a positive integer") from error
    if jobs < 1:
        raise ValueError("--jobs must be 'auto' or a positive integer")
    if jobs > available:
        raise ValueError(
            f"--jobs {jobs} exceeds the aggregate CPU budget of {available} cores"
        )
    return min(jobs, selected)


def worker_infrastructure_returncode() -> int:
    return 2


def may_publish_success(
    result_code: int,
    rows: list[dict[str, object]],
    *,
    publish_after_infrastructure: bool = False,
) -> bool:
    return (
        (result_code == 0 or publish_after_infrastructure)
        and bool(rows)
        and all(row.get("outcome") == "caught" for row in rows)
    )


def confinement_command(arguments: list[str]) -> list[str]:
    return [
        "bash",
        "scripts/confine.sh",
        "env",
        f"{CONFINEMENT_ENV}=1",
        sys.executable,
        "scripts/mutation-probe.py",
        *arguments,
    ]


def reexec_confined() -> None:
    if os.environ.get(CONFINEMENT_ENV) == "1":
        return
    environment = os.environ.copy()
    environment[CONFINEMENT_ENV] = "1"
    command = confinement_command(sys.argv[1:])
    os.chdir(ROOT)
    os.execvpe(command[0], command, environment)


@dataclass(frozen=True)
class ProcessLaunch:
    label: str
    command: tuple[str, ...]
    cwd: Path
    log: Path
    environment: dict[str, str]


def process_id_is_live(process_id: int) -> bool:
    try:
        fields = Path(f"/proc/{process_id}/stat").read_text().split()
    except OSError:
        return False
    return len(fields) > 2 and fields[2] != "Z"


def process_group_exists(process_group: int) -> bool:
    try:
        os.killpg(process_group, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def terminate_process_groups(
    processes: list[subprocess.Popen[bytes]],
    *,
    omit_exited_groups: bool = False,
    reap_exited_leaders: bool = True,
) -> None:
    groups = [
        process.pid
        for process in processes
        if not omit_exited_groups or process.poll() is None
    ]
    for process_group in groups:
        try:
            os.killpg(process_group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    def live_process_groups() -> list[int]:
        if reap_exited_leaders:
            for process in processes:
                process.poll()
        return [group for group in groups if process_group_exists(group)]

    deadline = time.monotonic() + 5
    live_groups = live_process_groups()
    while live_groups and time.monotonic() < deadline:
        live_groups = live_process_groups()
        if live_groups:
            time.sleep(0.1)
    for process_group in live_groups:
        try:
            os.killpg(process_group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    kill_deadline = time.monotonic() + 2
    while live_groups and time.monotonic() < kill_deadline:
        live_groups = live_process_groups()
        if live_groups:
            time.sleep(0.05)
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    live_groups = live_process_groups()
    if live_groups:
        raise RuntimeError(
            f"cannot reap descendant process groups after SIGKILL: {live_groups}"
        )


def run_launches(
    launches: list[ProcessLaunch],
    *,
    allowed_returncodes: frozenset[int],
    omit_exited_groups: bool = False,
) -> dict[str, int]:
    processes: dict[str, subprocess.Popen[bytes]] = {}
    handles: dict[str, object] = {}
    completed: dict[str, int] = {}
    try:
        for launch in launches:
            launch.log.parent.mkdir(parents=True, exist_ok=True)
            handle = launch.log.open("wb")
            handles[launch.label] = handle
            try:
                process = subprocess.Popen(
                    launch.command,
                    cwd=launch.cwd,
                    stdout=handle,
                    stderr=subprocess.STDOUT,
                    env=launch.environment,
                    start_new_session=True,
                )
            except BaseException:
                handle.close()
                raise
            processes[launch.label] = process
            print(f"  start {launch.label}", flush=True)

        pending = dict(processes)
        while pending:
            for label, process in list(pending.items()):
                returncode = process.poll()
                if returncode is None:
                    continue
                completed[label] = returncode
                del pending[label]
                print(f"  done  {label} (exit {returncode})", flush=True)
                if returncode not in allowed_returncodes:
                    terminate_process_groups(
                        list(processes.values()),
                        omit_exited_groups=omit_exited_groups,
                    )
                    launch = next(item for item in launches if item.label == label)
                    detail = diagnostic_tail(launch.log)
                    raise RuntimeError(
                        f"{label} failed with exit {returncode}: {detail[:500]}"
                    )
            if pending:
                time.sleep(0.1)
        live_groups = [
            process.pid
            for process in processes.values()
            if process_group_exists(process.pid)
        ]
        if live_groups:
            terminate_process_groups(list(processes.values()))
            raise RuntimeError(
                f"launchers exited with live descendant groups: {live_groups}"
            )
        return completed
    except BaseException:
        terminate_process_groups(
            list(processes.values()),
            omit_exited_groups=omit_exited_groups,
        )
        raise
    finally:
        for handle in handles.values():
            handle.close()


def worker_environment(
    plan: WorkerPlan,
    *,
    allow_host_sized_tokio: bool = False,
) -> dict[str, str]:
    plan.temporary.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        environment.pop(name, None)
    environment["TMPDIR"] = str(plan.temporary)
    environment["CI"] = "1"
    if allow_host_sized_tokio:
        environment.pop("TOKIO_WORKER_THREADS", None)
    else:
        environment["TOKIO_WORKER_THREADS"] = "1"
    return environment


def worker_launch(
    plan: WorkerPlan,
    *,
    phase: str,
    head: str,
    max_workers: int,
    run_root: Path,
    nonce: str,
    baseline_barrier: BaselineBarrier | None,
) -> ProcessLaunch:
    if phase == "mutations":
        if (
            not isinstance(baseline_barrier, BaselineBarrier)
            or baseline_barrier.head != head
            or plan.worker_id not in baseline_barrier.worker_ids
        ):
            raise ValueError("mutation worker launch lacks its baseline barrier")
    barrier_digest = (
        baseline_barrier.digest if baseline_barrier is not None else None
    )
    report = plan.baseline_report if phase == "baseline" else plan.mutation_report
    log = plan.baseline_log if phase == "baseline" else plan.mutation_log
    command = [
        sys.executable,
        "-u",
        str(plan.path / "scripts" / "mutation-probe.py"),
        "--worker-phase",
        phase,
        "--worker-result",
        str(report),
        "--worker-head",
        head,
        "--worker-id",
        str(plan.worker_id),
        "--max-workers",
        str(max_workers),
        "--worker-run-root",
        str(run_root),
        "--worker-nonce",
        nonce,
    ]
    if barrier_digest is not None:
        command.extend(("--worker-baseline-barrier", barrier_digest))
    for item in plan.expected:
        command.extend(("--worker-mutation", item.name))
    return ProcessLaunch(
        f"{phase} worker-{plan.worker_id:02}",
        tuple(command),
        plan.path,
        log,
        worker_environment(plan),
    )


def write_run_manifest(
    path: Path,
    *,
    source_root: Path,
    head: str,
    plans: list[WorkerPlan],
    state: str,
    nonce: str,
    baseline_barrier: BaselineBarrier | None,
) -> None:
    atomic_json(
        path,
        {
            "version": REPORT_VERSION,
            "kind": "durablerun-mutation-worktrees",
            "pid": os.getpid(),
            "source_root": str(source_root.resolve()),
            "head": head,
            "nonce": nonce,
            "state": state,
            "baseline_barrier": (
                baseline_barrier.digest if baseline_barrier is not None else None
            ),
            "worktrees": [str(plan.path) for plan in plans],
            "shards": [
                [item.name for item in plan.expected]
                for plan in plans
            ],
        },
    )


def establish_baseline_barrier(
    plans: list[WorkerPlan],
    process_codes: dict[str, int],
    *,
    head: str,
) -> BaselineBarrier:
    reports: list[object] = []
    for plan in plans:
        payload = read_json(plan.baseline_report)
        validate_baseline_report(
            payload,
            head=head,
            worker_id=plan.worker_id,
            assigned=list(plan.expected),
            process_returncode=process_codes[
                f"baseline worker-{plan.worker_id:02}"
            ],
        )
        reports.append(payload)
    digest = hashlib.sha256(
        json.dumps(reports, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    barrier = BaselineBarrier(
        head,
        tuple(plan.worker_id for plan in plans),
        digest,
    )
    validate_baseline_barrier(
        barrier,
        head=head,
        worker_ids=tuple(plan.worker_id for plan in plans),
    )
    return barrier


def registered_worktrees() -> set[Path]:
    paths: set[Path] = set()
    for line in git_output(ROOT, "worktree", "list", "--porcelain").splitlines():
        if line.startswith("worktree "):
            paths.add(Path(line.removeprefix("worktree ")).resolve())
    return paths


def cleanup_worktrees(
    run_root: Path,
    manifest_path: Path,
    plans: list[WorkerPlan],
) -> bool:
    failures: list[str] = []
    try:
        manifest = read_json(manifest_path)
    except ValueError as error:
        print(f"mutation-probe cleanup: {error}", file=sys.stderr)
        return False
    expected_paths = [str(plan.path) for plan in plans]
    if (
        not isinstance(manifest, dict)
        or manifest.get("kind") != "durablerun-mutation-worktrees"
        or manifest.get("state") != "cleanup"
        or manifest.get("source_root") != str(ROOT.resolve())
        or manifest.get("worktrees") != expected_paths
    ):
        print(
            "mutation-probe cleanup: ownership manifest does not match the "
            "recorded source root and worktrees",
            file=sys.stderr,
        )
        return False
    registered = registered_worktrees()
    for plan in reversed(plans):
        try:
            validate_owned_worktree_path(run_root, plan.path)
        except ValueError as error:
            failures.append(str(error))
            continue
        if plan.path.resolve() not in registered and not plan.path.exists():
            continue
        result = git_result(ROOT, "worktree", "remove", "--force", str(plan.path))
        if result.returncode != 0:
            diagnostic = (result.stdout + result.stderr).strip()
            failures.append(
                f"cannot remove {plan.path}: {diagnostic[:500]}; recover with "
                f"`git worktree remove --force {plan.path}`"
            )
    if failures:
        for failure in failures:
            print(f"mutation-probe cleanup: {failure}", file=sys.stderr)
        print(
            f"mutation-probe cleanup left its ownership manifest at {manifest_path}",
            file=sys.stderr,
        )
        return False
    temporary_root = Path(tempfile.gettempdir()).resolve()
    resolved = run_root.resolve()
    if (
        resolved.parent != temporary_root
        or not resolved.name.startswith("durablerun-mutation-worktrees-")
        or not manifest_path.exists()
    ):
        print(
            f"mutation-probe cleanup refuses unexpected run root {run_root}",
            file=sys.stderr,
        )
        return False
    shutil.rmtree(resolved)
    return True


class AuditSignal(Exception):
    def __init__(self, signum: int):
        self.signum = signum
        super().__init__(f"received signal {signum}")


class CleanupSignalShield:
    def __init__(
        self,
        previous: dict[int, object],
        *,
        raise_instead: bool = False,
    ):
        self.previous = previous
        self.raise_instead = raise_instead
        self.deferred_signum: int | None = None

    def defer(self, signum: int, _frame: object) -> None:
        if self.raise_instead:
            raise AuditSignal(signum)
        if self.deferred_signum is None:
            self.deferred_signum = signum

    def __enter__(self) -> CleanupSignalShield:
        for signum in self.previous:
            signal.signal(signum, self.defer)
        return self

    def __exit__(self, *_exc: object) -> None:
        for signum, previous in self.previous.items():
            signal.signal(signum, previous)


def coordinate_audit(filter_text: str, jobs_value: str) -> int:
    prove_confined_scope()
    assert_clean(ROOT)
    head = git_output(ROOT, "rev-parse", "HEAD^{commit}")
    selected_mutations = [
        (ordinal, mutation)
        for ordinal, mutation in enumerate(MUTATIONS)
        if filter_text in mutation.name
    ]
    if not selected_mutations:
        print(
            f"mutation-probe: -k {filter_text!r} selected no mutations",
            file=sys.stderr,
        )
        return 2
    try:
        jobs = choose_jobs(jobs_value, len(selected_mutations))
    except ValueError as error:
        print(f"mutation-probe: {error}", file=sys.stderr)
        return 2
    expected = [
        expected_result(ordinal, mutation, root=ROOT)
        for ordinal, mutation in selected_mutations
    ]
    shards = partition_expected(expected, jobs)
    validate_shards(shards, expected)
    max_workers = max(1, usable_cores() // jobs)

    common_dir_text = git_output(ROOT, "rev-parse", "--git-common-dir")
    common_dir = Path(common_dir_text)
    if not common_dir.is_absolute():
        common_dir = (ROOT / common_dir).resolve()
    lock_path = common_dir / "durablerun-mutation.lock"
    lock = lock_path.open("a+")
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(
                f"mutation-probe: another audit owns {lock_path}",
                file=sys.stderr,
            )
            return 2
        lock.seek(0)
        lock.truncate()
        lock.write(f"pid={os.getpid()} head={head}\n")
        lock.flush()
        assert_clean(ROOT)
        if git_output(ROOT, "rev-parse", "HEAD^{commit}") != head:
            print("mutation-probe: HEAD moved while acquiring the audit lock", file=sys.stderr)
            return 2
        pnpm_store = resolve_pnpm_store(ROOT)

        run_root = Path(
            tempfile.mkdtemp(prefix="durablerun-mutation-worktrees-")
        ).resolve()
        manifest_path = run_root / "manifest.json"
        nonce = secrets.token_hex(16)
        baseline_barrier: BaselineBarrier | None = None
        plans = [
            WorkerPlan(
                worker_id,
                run_root / f"worker-{worker_id:02}",
                run_root / f"tmp-{worker_id:02}",
                run_root / f"baseline-{worker_id:02}.json",
                run_root / f"mutations-{worker_id:02}.json",
                run_root / f"install-{worker_id:02}.log",
                run_root / f"baseline-{worker_id:02}.log",
                run_root / f"mutations-{worker_id:02}.log",
                tuple(shard),
            )
            for worker_id, shard in enumerate(shards)
        ]
        write_run_manifest(
            manifest_path,
            source_root=ROOT,
            head=head,
            plans=plans,
            state="setup",
            nonce=nonce,
            baseline_barrier=None,
        )
        print(
            f"mutation audit: head={head} mutations={len(expected)} jobs={jobs} "
            f"vitest-workers/job={max_workers} pnpm-store={pnpm_store}",
            flush=True,
        )
        print(f"mutation audit run root: {run_root}", flush=True)

        result_code = 2
        rows: list[dict[str, object]] = []
        interrupted: AuditSignal | None = None
        previous_handlers = {
            signum: signal.getsignal(signum)
            for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
        }

        def handle_signal(signum: int, _frame: object) -> None:
            raise AuditSignal(signum)

        for signum in previous_handlers:
            signal.signal(signum, handle_signal)
        cleanup_ok = False
        try:
            for plan in plans:
                result = git_result(
                    ROOT,
                    "worktree",
                    "add",
                    "--detach",
                    "--quiet",
                    str(plan.path),
                    head,
                )
                if result.returncode != 0:
                    diagnostic = (result.stdout + result.stderr).strip()
                    raise RuntimeError(
                        f"cannot create {plan.path}: {diagnostic[:500]}"
                    )
                if git_output(plan.path, "rev-parse", "HEAD^{commit}") != head:
                    raise RuntimeError(f"{plan.path}: detached worktree has the wrong head")
                assert_clean(plan.path)

            write_run_manifest(
                manifest_path,
                source_root=ROOT,
                head=head,
                plans=plans,
                state="install",
                nonce=nonce,
                baseline_barrier=None,
            )
            install_launches = [
                ProcessLaunch(
                    f"install worker-{plan.worker_id:02}",
                    worker_install_command(pnpm_store),
                    plan.path,
                    plan.install_log,
                    worker_environment(plan),
                )
                for plan in plans
            ]
            run_launches(
                install_launches,
                allowed_returncodes=frozenset((0,)),
            )
            for plan in plans:
                prove_workspace_links(plan.path)
                assert_clean(plan.path)

            write_run_manifest(
                manifest_path,
                source_root=ROOT,
                head=head,
                plans=plans,
                state="baseline",
                nonce=nonce,
                baseline_barrier=None,
            )
            baseline_launches = [
                worker_launch(
                    plan,
                    phase="baseline",
                    head=head,
                    max_workers=max_workers,
                    run_root=run_root,
                    nonce=nonce,
                    baseline_barrier=None,
                )
                for plan in plans
            ]
            baseline_codes = run_launches(
                baseline_launches,
                allowed_returncodes=frozenset((0,)),
            )
            baseline_barrier = establish_baseline_barrier(
                plans,
                baseline_codes,
                head=head,
            )
            print("all worker baselines green", flush=True)

            validate_baseline_barrier(
                baseline_barrier,
                head=head,
                worker_ids=tuple(plan.worker_id for plan in plans),
            )
            write_run_manifest(
                manifest_path,
                source_root=ROOT,
                head=head,
                plans=plans,
                state="mutations",
                nonce=nonce,
                baseline_barrier=baseline_barrier,
            )
            mutation_launches = [
                worker_launch(
                    plan,
                    phase="mutations",
                    head=head,
                    max_workers=max_workers,
                    run_root=run_root,
                    nonce=nonce,
                    baseline_barrier=baseline_barrier,
                )
                for plan in plans
            ]
            mutation_codes = run_launches(
                mutation_launches,
                allowed_returncodes=frozenset((0, 1)),
            )
            for plan in plans:
                rows.extend(
                    validate_mutation_report(
                        read_json(plan.mutation_report),
                        head=head,
                        worker_id=plan.worker_id,
                        expected=list(plan.expected),
                        process_returncode=mutation_codes[
                            f"mutations worker-{plan.worker_id:02}"
                        ],
                    )
                )
            by_ordinal = {int(row["ordinal"]): row for row in rows}
            if set(by_ordinal) != {item.ordinal for item in expected}:
                raise RuntimeError("aggregate result ordinals do not match the selection")
            rows = [by_ordinal[item.ordinal] for item in expected]
            result_code = (
                0 if all(row["outcome"] == "caught" for row in rows) else 1
            )
        except AuditSignal as error:
            interrupted = error
            result_code = 128 + error.signum
            print(f"mutation-probe: interrupted by signal {error.signum}", file=sys.stderr)
        except (OSError, RuntimeError, ValueError) as error:
            result_code = 2
            print(f"mutation-probe infrastructure failure: {error}", file=sys.stderr)
        finally:
            shield = CleanupSignalShield(previous_handlers)
            with shield:
                try:
                    write_run_manifest(
                        manifest_path,
                        source_root=ROOT,
                        head=head,
                        plans=plans,
                        state="cleanup",
                        nonce=nonce,
                        baseline_barrier=baseline_barrier,
                    )
                except OSError as error:
                    print(
                        f"mutation-probe cleanup cannot update {manifest_path}: {error}",
                        file=sys.stderr,
                    )
                try:
                    cleanup_ok = cleanup_worktrees(run_root, manifest_path, plans)
                except (OSError, RuntimeError, ValueError) as error:
                    cleanup_ok = False
                    print(
                        f"mutation-probe cleanup infrastructure failure: {error}",
                        file=sys.stderr,
                    )
            if shield.deferred_signum is not None and interrupted is None:
                interrupted = AuditSignal(shield.deferred_signum)
                result_code = 128 + shield.deferred_signum
                print(
                    f"mutation-probe: deferred signal {shield.deferred_signum} "
                    "until cleanup completed",
                    file=sys.stderr,
                )

        if not cleanup_ok:
            return 2
        current_head = git_output(ROOT, "rev-parse", "HEAD^{commit}")
        current_status = git_output(ROOT, "status", "--porcelain")
        if current_head != head or current_status:
            print(
                "mutation-probe: source checkout changed during the audit; "
                f"results remain evidence for {head}, but cannot attest the current tree",
                file=sys.stderr,
            )
            return 2
        if interrupted is not None:
            return result_code
        if result_code == 2:
            return 2
        for row in rows:
            if row["outcome"] == "caught":
                print(f"  ok {row['name']}: {row['detail']}")
            else:
                print(
                    f"  !! {row['name']}: {str(row['outcome']).upper()} — "
                    f"{row['detail']}"
                )
        print()
        failures = [row for row in rows if row["outcome"] != "caught"]
        if failures:
            print(
                f"{len(failures)} mutation(s) were not caught by their attributable verdict:"
            )
            for row in failures:
                print(f"  - {row['name']}: {row['detail']}")
            return 1
        if not may_publish_success(result_code, rows):
            print(
                "mutation-probe: refusing a success verdict without complete "
                "caught results and a zero audit status",
                file=sys.stderr,
            )
            return 2
        print(
            f"every mutation was caught by its attributable verdict at {head}"
        )
        return result_code
    finally:
        lock.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("-k", default="", help="only mutations whose name contains this")
    ap.add_argument(
        "--jobs",
        default="auto",
        metavar="auto|N",
        help="isolated worktree workers (default: auto)",
    )
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="test verdict attribution, orchestration, and every live mutation marker",
    )
    ap.add_argument(
        "--classifier-self-test",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--orchestration-self-test",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument("--self-test-fault", choices=SELF_TEST_FAULTS, help=argparse.SUPPRESS)
    ap.add_argument(
        "--orchestration-self-test-fault",
        choices=ORCHESTRATION_SELF_TEST_FAULTS,
        help=argparse.SUPPRESS,
    )
    ap.add_argument("--worker-phase", choices=("baseline", "mutations"), help=argparse.SUPPRESS)
    ap.add_argument("--worker-result", type=Path, help=argparse.SUPPRESS)
    ap.add_argument("--worker-head", help=argparse.SUPPRESS)
    ap.add_argument("--worker-id", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--worker-mutation", action="append", default=[], help=argparse.SUPPRESS)
    ap.add_argument("--max-workers", type=int, help=argparse.SUPPRESS)
    ap.add_argument("--worker-run-root", type=Path, help=argparse.SUPPRESS)
    ap.add_argument("--worker-nonce", help=argparse.SUPPRESS)
    ap.add_argument("--worker-baseline-barrier", help=argparse.SUPPRESS)
    args = ap.parse_args()

    self_test_modes = (
        args.self_test,
        args.classifier_self_test,
        args.orchestration_self_test,
    )
    if sum(bool(mode) for mode in self_test_modes) > 1:
        ap.error("self-test modes are mutually exclusive")
    if any(self_test_modes):
        if args.k or args.jobs != "auto" or args.worker_phase is not None:
            ap.error("self-tests cannot be combined with audit or worker options")
        if args.orchestration_self_test:
            if args.self_test_fault is not None:
                ap.error("--self-test-fault requires --classifier-self-test")
            return orchestration_self_test(args.orchestration_self_test_fault)
        if args.orchestration_self_test_fault is not None:
            ap.error(
                "--orchestration-self-test-fault requires --orchestration-self-test"
            )
        classifier_result = self_test(
            args.self_test_fault,
            check_live_inventory=args.self_test,
        )
        if args.self_test:
            orchestration_result = orchestration_self_test()
            return classifier_result or orchestration_result
        return classifier_result
    if args.self_test_fault is not None:
        ap.error("--self-test-fault requires --classifier-self-test")
    if args.orchestration_self_test_fault is not None:
        ap.error("--orchestration-self-test-fault requires --orchestration-self-test")

    if args.worker_phase is not None:
        required_worker = (
            args.worker_result,
            args.worker_head,
            args.worker_id,
            args.max_workers,
            args.worker_run_root,
            args.worker_nonce,
        )
        if any(value is None for value in required_worker):
            ap.error("worker mode requires its complete coordinator assignment")
        if args.max_workers < 1 or args.worker_id < 0:
            ap.error("worker mode requires positive worker limits and identity")
        if (args.worker_phase == "mutations") != (
            args.worker_baseline_barrier is not None
        ):
            ap.error("only mutation workers require a baseline barrier")
        if args.k or args.jobs != "auto":
            ap.error("worker mode cannot be combined with audit selection options")
        try:
            return worker_phase(
                phase=args.worker_phase,
                report_path=args.worker_result,
                head=args.worker_head,
                worker_id=args.worker_id,
                mutation_names=args.worker_mutation,
                max_workers=args.max_workers,
                run_root=args.worker_run_root,
                nonce=args.worker_nonce,
                baseline_barrier=args.worker_baseline_barrier,
            )
        except SystemExit as error:
            return int(error.code) if isinstance(error.code, int) else 2
        except Exception as error:
            print(f"mutation-probe worker infrastructure failure: {error}", file=sys.stderr)
            return worker_infrastructure_returncode()
    if any(
        value is not None
        for value in (
            args.worker_result,
            args.worker_head,
            args.worker_id,
            args.max_workers,
            args.worker_run_root,
            args.worker_nonce,
            args.worker_baseline_barrier,
        )
    ) or args.worker_mutation:
        ap.error("worker options require --worker-phase")

    reexec_confined()
    try:
        return coordinate_audit(args.k, args.jobs)
    except SystemExit as error:
        return int(error.code) if isinstance(error.code, int) else 2
    except Exception as error:
        print(f"mutation-probe infrastructure failure: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
