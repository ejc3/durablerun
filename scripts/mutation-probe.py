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

Usage: mutation-probe.py [-k substring]
       mutation-probe.py --self-test
       mutation-probe.py --classifier-self-test [--self-test-fault FAULT]
"""
import argparse
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

# This runner requires a clean tree and imports repository-local helpers. Do
# not let Python create an untracked cache before the clean-tree check runs.
sys.dont_write_bytecode = True

from source_lex import (
    matching_delimiter,
    split_top_level,
    split_typescript_call_arguments,
    typescript_call_open,
    typescript_structure,
)

ROOT = Path(__file__).resolve().parent.parent


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


def raw_promise_message_lines(source: str) -> tuple[int, ...]:
    """Find custom messages entrusted to Vitest promise matchers."""
    structure = typescript_structure(source)
    lines: list[int] = []
    for match in re.finditer(r"\bexpect\b", structure):
        opened = typescript_call_open(
            source,
            match.start(),
            match.end(),
            structure,
        )
        if opened is None:
            continue
        closed = matching_delimiter(source, opened, structure)
        if closed is None:
            raise ValueError("cannot establish expect() call boundary")
        suffix = re.match(r"\s*\.\s*(?:rejects|resolves)\b", structure[closed + 1 :])
        if suffix is None:
            continue
        arguments = split_typescript_call_arguments(
            source,
            structure,
            opened + 1,
            closed,
        )
        if arguments is None:
            raise ValueError("cannot establish expect() argument boundaries")
        if len(arguments) > 1:
            lines.append(source.count("\n", 0, match.start()) + 1)
    return tuple(lines)


VERDICT_HELPERS = (
    "attributeExpectedFailure",
    "attributeReplacedFailure",
    "requireExpectedFailure",
)
MUTATION_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def helper_verdict_descriptors(source: str) -> frozenset[tuple[str, str]]:
    """Extract canonical kind/name descriptors passed directly to verdict helpers."""
    structure = typescript_structure(source)
    helpers = "|".join(VERDICT_HELPERS)
    descriptors: set[tuple[str, str]] = set()
    for match in re.finditer(rf"\b(?:{helpers})\b", structure):
        opened = typescript_call_open(
            source,
            match.start(),
            match.end(),
            structure,
        )
        if opened is None:
            continue
        closed = matching_delimiter(source, opened, structure)
        if closed is None:
            raise ValueError("cannot establish verdict-helper call boundary")
        arguments = split_top_level(source, structure, opened + 1, closed)
        if not arguments:
            continue
        start, end = arguments[0]
        while start < end and structure[start].isspace():
            start += 1
        while end > start and structure[end - 1].isspace():
            end -= 1
        if start == end or structure[start] != "{":
            continue
        object_end = matching_delimiter(source, start, structure)
        if object_end is None or object_end != end - 1:
            continue
        fields = split_top_level(source, structure, start + 1, object_end)
        if fields is None:
            raise ValueError("cannot establish verdict-descriptor fields")
        values: dict[str, str] = {}
        for field_start, field_end in fields:
            field = source[field_start:field_end]
            parsed = re.fullmatch(
                r"""\s*(kind|mutation)\s*:\s*(['"])([^'"]*)\2\s*""",
                field,
            )
            if parsed is None:
                values = {}
                break
            values[parsed.group(1)] = parsed.group(3)
        kind = values.get("kind")
        mutation = values.get("mutation")
        if (
            len(values) == 2
            and kind in {"behavior", "construction"}
            and mutation is not None
            and MUTATION_NAME.fullmatch(mutation)
        ):
            descriptors.add((kind, mutation))
    return frozenset(descriptors)


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
# and the real-process chaos tests each add minutes per mutation.
TEST_CMD = [
    "bash",
    "scripts/confine.sh",
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--exclude",
    "packages/conformance/test/fuzz-*",
    "--exclude",
    "packages/driver/test/chaos-process.test.ts",
]


def relative_test_file(value: object) -> str:
    path = Path(str(value))
    if not path.is_absolute():
        return path.as_posix()
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def parse_report(text: str, process_ok: bool, diagnostic: str) -> SuiteResult:
    """Turn Vitest's JSON reporter into only the evidence attribution needs."""
    try:
        report = json.loads(text)
    except (json.JSONDecodeError, TypeError) as error:
        return SuiteResult(
            process_ok,
            False,
            (),
            (f"missing or malformed Vitest JSON report: {error}",),
            diagnostic,
        )
    if not isinstance(report, dict) or not isinstance(report.get("success"), bool):
        return SuiteResult(
            process_ok,
            False,
            (),
            ("Vitest JSON report has no boolean success verdict",),
            diagnostic,
        )

    suite_errors: list[str] = []
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
            suite_errors.append(
                f"Vitest JSON report has no nonnegative integer {name}"
            )
        else:
            counters[name] = value
    if len(counters) == len(counter_names):
        if counters["numTotalTestSuites"] != (
            counters["numPassedTestSuites"]
            + counters["numFailedTestSuites"]
            + counters["numPendingTestSuites"]
        ):
            suite_errors.append("Vitest JSON report has contradictory suite counters")
        if counters["numTotalTests"] != (
            counters["numPassedTests"]
            + counters["numFailedTests"]
            + counters["numPendingTests"]
            + counters["numTodoTests"]
        ):
            suite_errors.append("Vitest JSON report has contradictory test counters")

    assertions: list[FailedAssertion] = []
    observed_tests = {"passed": 0, "failed": 0, "pending": 0, "todo": 0}
    results = report.get("testResults")
    if not isinstance(results, list):
        return SuiteResult(
            process_ok,
            bool(report["success"]),
            (),
            ("Vitest JSON report has no testResults array",),
            diagnostic,
        )
    for result in results:
        if not isinstance(result, dict):
            suite_errors.append("Vitest JSON report contains a non-object test result")
            continue
        name = result.get("name")
        if not isinstance(name, str):
            suite_errors.append("Vitest JSON test result has no string name")
            name = "(unknown file)"
        file = relative_test_file(name)
        file_status = result.get("status")
        if file_status not in ("passed", "failed"):
            suite_errors.append(f"{file}: invalid or missing file status")
        message = result.get("message")
        if not isinstance(message, str):
            suite_errors.append(f"{file}: missing string message")
            message = ""
        elif message:
            suite_errors.append(f"{file}: {message}")
        rows = result.get("assertionResults")
        if not isinstance(rows, list):
            suite_errors.append(f"{file}: missing assertionResults")
            continue
        failed_in_file = False
        for assertion in rows:
            if not isinstance(assertion, dict):
                suite_errors.append(f"{file}: contains a non-object assertion result")
                continue
            status = assertion.get("status")
            if not isinstance(status, str):
                suite_errors.append(f"{file}: assertion has invalid or missing status")
                continue
            if status in ("skipped", "disabled"):
                observed_tests["pending"] += 1
            elif status in observed_tests:
                observed_tests[status] += 1
            else:
                suite_errors.append(f"{file}: assertion has invalid or missing status")
                continue
            if status != "failed":
                continue
            failed_in_file = True
            messages = assertion.get("failureMessages")
            full_name = assertion.get("fullName")
            if not isinstance(full_name, str):
                suite_errors.append(f"{file}: failed assertion has no string fullName")
                full_name = ""
            if messages is not None and (
                not isinstance(messages, list)
                or any(not isinstance(item, str) for item in messages)
            ):
                suite_errors.append(
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
                suite_errors.append(
                    f"{file}: failed file has no failed assertion or file error"
                )
        elif failed_in_file or message:
            suite_errors.append(
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
                suite_errors.append(
                    f"Vitest JSON report {name}={counters[name]} "
                    f"does not match {observed} assertion results"
                )
        expected_success = (
            counters["numFailedTestSuites"] == 0
            and counters["numFailedTests"] == 0
        )
        if results and bool(report["success"]) != expected_success:
            suite_errors.append(
                "Vitest JSON report success contradicts its failure counters"
            )
        elif bool(report["success"]) and not expected_success:
            suite_errors.append(
                "Vitest JSON report success contradicts its failure counters"
            )
    return SuiteResult(
        process_ok,
        bool(report["success"]),
        tuple(assertions),
        tuple(suite_errors),
        diagnostic,
    )


def run_suite() -> SuiteResult:
    with tempfile.TemporaryDirectory(prefix="durablerun-mutation-report-") as temporary:
        report = Path(temporary) / "vitest.json"
        result = subprocess.run(
            [*TEST_CMD, "--reporter=json", "--outputFile", str(report)],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        diagnostic = (result.stdout + result.stderr).strip()
        if not report.exists():
            return SuiteResult(
                result.returncode == 0,
                False,
                (),
                ("Vitest did not write its JSON report",),
                diagnostic,
            )
        return parse_report(report.read_text(), result.returncode == 0, diagnostic)


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
            parse_report("{", False, ""),
            expected,
            "wrong-path",
        ),
        (
            "success verdict with no test results",
            parse_report('{"success": true}', True, ""),
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
            "await expect(a < b, c > (d) ? 'lost' : 'other').rejects.toThrow()",
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
            "await this.#requireExpectedFailure("
            "{kind: 'behavior', mutation: 'schema-fault-is-permanent'}, /x/, action)",
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
    for label, source, wanted in promise_message_cases:
        got = raw_promise_message_lines(source)
        if got != wanted:
            failures.append(f"promise-message {label}: expected {wanted}, got {got}")
    for label, source, wanted in descriptor_cases:
        got = helper_verdict_descriptors(source)
        if got != wanted:
            failures.append(f"verdict-descriptor {label}: expected {wanted}, got {got}")
    if check_live_inventory:
        if TEST_CMD[:2] != ["bash", "scripts/confine.sh"]:
            failures.append("full mutation suites are not routed through scripts/confine.sh")
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
            descriptors = helper_verdict_descriptors(verdict_source)
            if (
                mutation.verdict.marker not in verdict_source
                and descriptor not in descriptors
            ):
                failures.append(
                    f"{mutation.name}: neither direct verdict marker "
                    f"{mutation.verdict.marker!r} nor canonical helper descriptor is present in "
                    f"{marker_file}"
                )
        for path in sorted((ROOT / "packages").glob("**/*.ts")):
            try:
                lines = raw_promise_message_lines(path.read_text())
            except ValueError as error:
                failures.append(
                    f"{path.relative_to(ROOT)}: cannot inspect promise verdicts: {error}"
                )
                continue
            for line in lines:
                failures.append(
                    f"{path.relative_to(ROOT)}:{line}: Vitest promise outcomes cannot carry "
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
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="test verdict attribution and audit every live mutation pattern and marker",
    )
    ap.add_argument(
        "--classifier-self-test",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument("--self-test-fault", choices=SELF_TEST_FAULTS, help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.self_test and args.classifier_self_test:
        ap.error("--self-test and --classifier-self-test are mutually exclusive")
    if args.self_test or args.classifier_self_test:
        if args.k:
            ap.error("self-tests cannot be combined with -k")
        return self_test(
            args.self_test_fault,
            check_live_inventory=args.self_test,
        )
    if args.self_test_fault is not None:
        ap.error("--self-test-fault requires --classifier-self-test")

    assert_clean()
    baseline = run_suite()
    if not baseline.green:
        detail = [*baseline.suite_errors, baseline.diagnostic]
        shown = next((item for item in detail if item), "(no diagnostic)")
        print(
            f"baseline is RED or its report is invalid — fix the suite before probing it\n  {shown[:500]}",
            file=sys.stderr,
        )
        return 2
    print("baseline green\n")

    failures = []
    selected = [mutation for mutation in MUTATIONS if args.k in mutation.name]
    if not selected:
        print(f"mutation-probe: -k {args.k!r} selected no mutations", file=sys.stderr)
        return 2
    for mutation in selected:
        if args.k and args.k not in mutation.name:
            continue
        path = ROOT / mutation.file
        original = path.read_text()
        if mutation.find not in original:
            print(
                f"  ?? {mutation.name}: pattern not found in {mutation.file} — the mutation is stale"
            )
            failures.append((mutation.name, "stale pattern"))
            continue
        mutated = original.replace(mutation.find, mutation.replace, 1)
        try:
            path.write_text(mutated)
            result = run_suite()
            outcome = classify_verdict(result, mutation.verdict)
            if outcome == "survived":
                print(
                    f"  !! {mutation.name}: SURVIVED — nothing failed. {mutation.breaks}"
                )
                failures.append((mutation.name, mutation.breaks))
            elif outcome == "caught":
                print(
                    f"  ok {mutation.name}: {mutation.verdict.kind} verdict "
                    f"{mutation.verdict.full_name}"
                )
            else:
                observed = [
                    f"{failure.file} > {failure.full_name}: "
                    f"{next(iter(failure.messages), '(no failure message)')[:180]}"
                    for failure in result.assertions[:3]
                ]
                observed.extend(error[:180] for error in result.suite_errors[:3])
                if not observed and result.diagnostic:
                    observed.append(result.diagnostic[:180])
                detail = "; ".join(observed) if observed else "(no structured failure)"
                expected = (
                    f"{mutation.verdict.kind} {mutation.verdict.file} > "
                    f"{mutation.verdict.full_name} containing {mutation.verdict.marker!r}"
                )
                print(
                    f"  !! {mutation.name}: WRONG-PATH failure\n"
                    f"     expected: {expected}\n"
                    f"     observed: {detail}"
                )
                failures.append((mutation.name, "failed for the wrong reason"))
        finally:
            restore(path, mutated, original)

    print()
    if failures:
        print(
            f"{len(failures)} mutation(s) were not caught by their attributable verdict:"
        )
        for name, why in failures:
            print(f"  - {name}: {why}")
        return 1
    print("every mutation was caught by its attributable verdict")
    return 0


if __name__ == "__main__":
    sys.exit(main())
