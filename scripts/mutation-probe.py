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
       mutation-probe.py --routing-self-test
                         [--routing-self-test-fault FAULT]
       mutation-probe.py --suite-timeout-self-test-child
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parent.parent
TYPESCRIPT_ANALYZER = ROOT / "scripts" / "typescript-verdict-analyzer.cjs"
MUTATION_SUITE_WALL_TIME_SECONDS = 300.0
VERIFIER_TERM_GRACE_SECONDS = 0.25
VERIFIER_KILL_GRACE_SECONDS = 0.5


VerdictKind = Literal["behavior", "construction"]
TypecheckProject = Literal["store-libsql", "conformance"]


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
    typecheck_project: TypecheckProject | None = None


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
    behavior_verdict_title_owners: frozenset[tuple[str, str]]
    dynamic_behavior_verdict_title_markers: frozenset[str]
    expect_error_verdict_markers: tuple[tuple[str, int], ...]


@dataclass(frozen=True)
class TypeScriptMutationSyntaxAnalysis:
    file: str
    materialization_error: str | None
    diagnostics: tuple[str, ...]


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
        title_owners = entry.get("behaviorVerdictTitleOwners")
        dynamic_title_markers = entry.get("dynamicBehaviorVerdictTitleMarkers")
        expect_error_markers = entry.get("expectErrorVerdictMarkers")
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
            and isinstance(title_owners, list)
            and all(
                isinstance(item, list)
                and len(item) == 2
                and all(isinstance(part, str) for part in item)
                for item in title_owners
            )
            and isinstance(dynamic_title_markers, list)
            and all(isinstance(item, str) for item in dynamic_title_markers)
            and isinstance(expect_error_markers, list)
            and all(
                isinstance(item, list)
                and len(item) == 2
                and isinstance(item[0], str)
                and isinstance(item[1], int)
                and item[1] > 0
                for item in expect_error_markers
            )
        ):
            raise ValueError(f"{path}: TypeScript verdict analysis has an invalid shape")
        analyses[path] = TypeScriptSourceAnalysis(
            tuple(diagnostics),
            tuple(lines),
            frozenset((item[0], item[1]) for item in descriptors),
            frozenset(markers),
            frozenset((item[0], item[1]) for item in title_owners),
            frozenset(dynamic_title_markers),
            tuple((item[0], item[1]) for item in expect_error_markers),
        )
    return analyses


def analyze_typescript_mutation_syntax(
    sources: dict[str, str],
    mutations: list[Mutation],
) -> dict[str, TypeScriptMutationSyntaxAnalysis]:
    """Parse every generated TypeScript mutant without type or helper resolution."""
    request = [
        {
            "name": mutation.name,
            "file": mutation.file,
            "find": mutation.find,
            "replace": mutation.replace,
        }
        for mutation in mutations
    ]
    result = subprocess.run(
        ["node", str(TYPESCRIPT_ANALYZER)],
        cwd=ROOT,
        input=json.dumps(
            {"analysis": "mutation-syntax", "sources": sources, "mutations": request}
        ),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise ValueError(
            "TypeScript mutant syntax analyzer failed: "
            f"{(result.stdout + result.stderr).strip()[:500]}"
        )
    try:
        payload = json.loads(result.stdout)
        entries = payload["mutations"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError(
            f"TypeScript mutant syntax analyzer returned malformed JSON: {error}"
        ) from error
    if not isinstance(entries, list) or len(entries) != len(mutations):
        raise ValueError("TypeScript mutant syntax analyzer returned the wrong inventory")

    analyses: dict[str, TypeScriptMutationSyntaxAnalysis] = {}
    for mutation, entry in zip(mutations, entries, strict=True):
        if not isinstance(entry, dict):
            raise ValueError(f"{mutation.name}: TypeScript mutant syntax result is not an object")
        name = entry.get("name")
        file = entry.get("file")
        materialization_error = entry.get("materializationError")
        diagnostics = entry.get("diagnostics")
        if not (
            name == mutation.name
            and file == mutation.file
            and (materialization_error is None or isinstance(materialization_error, str))
            and isinstance(diagnostics, list)
            and all(isinstance(item, str) for item in diagnostics)
            and name not in analyses
        ):
            raise ValueError(
                f"{mutation.name}: TypeScript mutant syntax analysis has an invalid shape"
            )
        analyses[name] = TypeScriptMutationSyntaxAnalysis(
            file,
            materialization_error,
            tuple(diagnostics),
        )
    return analyses


def helper_owned_marker_diagnostic(
    mutation_name: str,
    verdict_kind: str,
    marker: str,
    descriptors: frozenset[tuple[str, str]],
) -> str | None:
    """A mutation-specific helper descriptor owns that mutation's exact marker."""
    descriptor = (verdict_kind, mutation_name)
    if descriptor not in descriptors:
        return None
    expected = f"mutation-verdict:{verdict_kind}:{mutation_name}"
    if marker == expected:
        return None
    return (
        f"{mutation_name}: helper descriptor {descriptor!r} owns {expected!r}, "
        f"not {marker!r}"
    )


def behavioral_verdict_title_diagnostic(
    mutation_name: str,
    verdict: ExpectedVerdict,
    analysis: TypeScriptSourceAnalysis,
    dynamic_reason: str | None,
) -> str | None:
    """Bind a same-file direct marker to its exact static Vitest owner."""
    marker_file = verdict.marker_file or verdict.file
    if verdict.kind != "behavior" or marker_file != verdict.file:
        if dynamic_reason is not None:
            return f"{mutation_name}: dynamic-title reason is stale for a non-direct owner"
        return None

    marker_parts = verdict.marker.split(":", 2)
    descriptor = (
        (marker_parts[1], marker_parts[2]) if len(marker_parts) == 3 else ("", "")
    )
    titles = sorted(
        title
        for marker, title in analysis.behavior_verdict_title_owners
        if marker == verdict.marker
    )
    if verdict.full_name in titles:
        if dynamic_reason is not None:
            return f"{mutation_name}: dynamic-title reason is stale for a static owner"
        return None
    if titles:
        return (
            f"{mutation_name}: ExpectedVerdict full_name {verdict.full_name!r} does not "
            f"match static direct-marker owner(s) {titles!r}"
        )
    if verdict.marker in analysis.dynamic_behavior_verdict_title_markers:
        if dynamic_reason is None or not dynamic_reason.strip():
            return (
                f"{mutation_name}: dynamic direct Vitest title requires a non-empty "
                "exact reason"
            )
        return None
    if dynamic_reason is not None:
        return f"{mutation_name}: dynamic-title reason is stale"
    if descriptor in analysis.helper_verdict_descriptors:
        return None
    if verdict.marker in analysis.direct_verdict_markers:
        return (
            f"{mutation_name}: same-file direct behavioral marker has no enclosing "
            "static or explicitly dynamic Vitest owner"
        )
    return None


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
        "    if (!isCas && (false || sql.includes(this.now))) { // MUTATION",
        "a follow-on may resolve the clock token a second time",
    ),
    (
        "clock-ban-raw-dialect-in-followon",
        "packages/core/src/fenced-batch.ts",
        "    if (!isCas && (sql.includes(NOW) || sql.includes(this.now))) {",
        "    if (!isCas && (sql.includes(NOW) || false)) { // MUTATION",
        "a follow-on may embed the dialect clock expression directly",
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
        "  return `${prefix}f.fence_stamp = ${fence}`",
        "  return `${prefix}${\n"
        "    _batchLabel === 'mutation:generated-selection-fence'\n"
        "      ? `CASE WHEN f.fence_stamp = ${fence} THEN 1 ELSE 1 END = 1`\n"
        "      : `f.fence_stamp = ${fence}`\n"
        "  }`",
        "every generated follow-on acts on rows this batch never wrote",
    ),
    (
        "generated-narrow-widens",
        "packages/core/src/fenced-batch.ts",
        "    const narrow = spec.narrow ? `\\n         AND (${spec.narrow})` : ''",
        "    const narrow = spec.narrow ? `\\n         AND ${spec.narrow}` : ''",
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
        "    const src = `${spec.where ? `(${spec.where}) AND ` : ''}${queueOwnership}`",
        "    const src = `${spec.where ? `${spec.where} AND ` : ''}${queueOwnership}`",
        "a disjunctive correlation lets unstamped rows into a generated selection",
    ),
    (
        "generated-update-provenance-assignment",
        "packages/core/src/fenced-batch.ts",
        "  const provenance = `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_at_ms = (${update.sourceInstant})`",
        "  const provenance =\n"
        "    _batchLabel === 'mutation:generated-update-provenance-assignment'\n"
        "      ? `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_stamp = fence_stamp,\n"
        "         fence_at_ms = (${update.sourceInstant})`\n"
        "      : `,\\n         fence_stamp = ${STAMP},\n"
        "         fence_at_ms = (${update.sourceInstant})`",
        "a generated UPDATE can leave stale provenance on every row it writes",
    ),
    (
        "generated-set-provenance-guard",
        "packages/core/src/fenced-batch.ts",
        "      if (isProvenanceColumn) {",
        "      if (false && isProvenanceColumn) {",
        "a generated UPDATE caller can compete with the primitive's provenance assignment",
    ),
    (
        "generated-set-column-guard",
        "packages/core/src/fenced-batch.ts",
        "      if (!isProvenanceColumn && !allowedColumns.has(column)) {",
        "      if (false && !allowedColumns.has(column)) {",
        "a generated UPDATE caller can assign a contract-forbidden column",
    ),
    (
        "generated-update-requires-target",
        "packages/core/src/fenced-batch.ts",
        "export type GeneratedUpdateTarget = RelationTarget<FenceRelation>",
        "export type GeneratedUpdateTarget = RelationTarget<FenceRelation> | null",
        "a generated UPDATE may lose its required stamped target",
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
        "event-upsert-requires-preserved-instant",
        "packages/core/src/fenced-batch.ts",
        "        !containsCompleteSet(conflictUpdate, required)",
        "        !containsCompleteSet(conflictUpdate, required) &&\n"
        "        !containsCompleteSet(conflictUpdate, FENCE_SET)",
        "the event upsert primitive accepts the current statement instant",
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
        "successor-collision-error-attribution",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "const RUN_ID_COLLISION = /UNIQUE constraint failed: runs\\.run_id/",
        "const RUN_ID_COLLISION = /.*/",
        "the successor collision oracle accepts an unrelated pre-transition failure",
    ),
    (
        "testing-helper-bind-arity-brand",
        "packages/core/src/fenced-batch.ts",
        "  weakSetAdd(bindCompilationErrors, error)\n",
        "  // MUTATION: leave the compiler error unauthenticated\n",
        "the compiler bind-count failure loses its authentic brand",
    ),
    (
        "testing-helper-bind-brand-read",
        "packages/core/src/fenced-batch.ts",
        "    weakSetHas(bindCompilationErrors, value)\n",
        "    false // MUTATION: ignore the private compiler-error brand\n",
        "the compiler-error predicate stops reading its private brand",
    ),
    (
        "testing-helper-bind-count-missing-argument",
        "packages/core/src/fenced-batch.ts",
        "    if (argIndex !== s.args.length) {",
        "    if (argIndex < s.args.length) {",
        "a statement with more placeholders than explicit args bypasses the compiler bind-count check",
    ),
    (
        "testing-helper-bind-count-unused-argument",
        "packages/core/src/fenced-batch.ts",
        "    if (argIndex !== s.args.length) {",
        "    if (argIndex > s.args.length) {",
        "a statement with fewer placeholders than explicit args bypasses the compiler bind-count check",
    ),
    (
        "testing-helper-bind-count-factory",
        "packages/core/src/fenced-batch.ts",
        "      throw bindCompilationError(\n"
        "        `FencedBatch[${this.label}] '${s.name}' binds ${argIndex} of ${s.args.length} explicit args`,\n",
        "      throw new TrustedTypeError(\n"
        "        `FencedBatch[${this.label}] '${s.name}' binds ${argIndex} of ${s.args.length} explicit args`,\n",
        "the bind-count failure bypasses the authenticated compiler-error factory",
    ),
    (
        "testing-helper-bind-undefined-brand",
        "packages/core/src/fenced-batch.ts",
        "          throw bindCompilationError(\n"
        "            `FencedBatch[${this.label}] '${s.name}' argument ${index} is undefined — bind null explicitly if that is what you mean`,\n",
        "          throw new TrustedTypeError(\n"
        "            `FencedBatch[${this.label}] '${s.name}' argument ${index} is undefined — bind null explicitly if that is what you mean`,\n",
        "the explicit-undefined bind failure bypasses the authenticated compiler-error factory",
    ),
    (
        "testing-helper-bind-error-constructor",
        "packages/core/src/fenced-batch.ts",
        "  const error = new TrustedTypeError(message)\n",
        "  const error = new TypeError(message) // MUTATION\n",
        "task-installed TypeError replaces the compiler-error constructor",
    ),
    (
        "testing-helper-bind-matcher-propagation",
        "packages/core/src/testing.ts",
        "  if (isFencedBatchBindError(error)) throw error\n",
        "  // MUTATION: let caller matchers attribute compiler failures\n",
        "caller matchers attribute an authenticated compiler bind failure",
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
        "               AND ${soleLiveRun(run)}\n"
        "               AND (${run}.wake_step IS NOT NULL OR ${wait.unambiguous})\n",
        # Make the sibling witness contradictory while preserving both
        # correlated probes. The shipped query-plan regression owns that
        # independent topology; this mutation owns only sole-live semantics.
        "               AND ${soleLiveRun(run).replace(\n"
        "                 `AND sibling.run_id <> ${run}.run_id`,\n"
        "                 `AND sibling.run_id <> ${run}.run_id AND sibling.run_id = ${run}.run_id`,\n"
        "               )}\n"
        "               AND (${run}.wake_step IS NOT NULL OR ${wait.unambiguous})\n",
        "claim advances two competing live runs for one task",
    ),
    (
        "claim-receipt-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "         AND t.state IN ${LIVE}\n"
        "         AND ${durableTaskRetryAdmissible('t')}\n"
        "         AND ${durableTaskHeadersAdmissible('t')}\n"
        "         AND ${soleLiveRun('r')}\n",
        "         AND t.state IN ${LIVE}\n"
        "         AND ${durableTaskRetryAdmissible('t')}\n"
        "         AND ${durableTaskHeadersAdmissible('t')}\n"
        "         AND 1 = 1\n",
        "a same-token receipt hands a run from a task with competing live owners back to launch",
    ),
    (
        "activate-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'runs')}\n"
        "         AND ${soleLiveRun('runs')}\n"
        "         AND EXISTS (\n",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'runs')}\n"
        "         AND 1 = 1\n"
        "         AND EXISTS (\n",
        "activation launches a claimed run after its task acquires a competing live run",
    ),
    (
        "claim-rejects-generation-overflow",
        "packages/store-libsql/src/fragments.ts",
        "export const storedIncrementableClaimGeneration = (alias?: string): string => {\n"
        "  const bounds = PERSISTED_INTEGER_BOUNDS.runs.claim_gen\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max - 1)\n"
        "}",
        "export const storedIncrementableClaimGeneration = (alias?: string): string => {\n"
        "  const bounds = PERSISTED_INTEGER_BOUNDS.runs.claim_gen\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max)\n"
        "}",
        "claim increments a stored generation past its protocol ceiling",
    ),
    (
        "activate-rejects-zero-lease",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')}\n",
        "         AND 1 = 1\n",
        "activation derives a new expiry from a non-positive stored lease",
    ),
    (
        "activate-requires-relaunch-bound",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')}\n"
        "         AND ${epochAdditionFits(NOW, 'runs.lease_ms')}\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'runs')}\n"
        "         AND ${soleLiveRun('runs')}\n",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')}\n"
        "         AND ${epochAdditionFits(NOW, 'runs.lease_ms')}\n"
        "         AND 1 = 1\n"
        "         AND ${soleLiveRun('runs')}\n",
        "activation accepts a claim whose relaunch counter is out of range",
    ),
    (
        "activate-requires-current-run-accounting",
        "packages/store-libsql/src/store.ts",
        "           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}\n"
        "             AND ${durableTaskRetryAdmissible('t')}\n"
        "             AND ${durableTaskHeadersAdmissible('t')}\n"
        "             AND ${storedCurrentRunAccounting('runs', 't')}\n"
        "             AND ${storedHighestOwnedOrdinal('runs')}\n"
        "             AND ${activationDurationAdmissible('t', NOW)}\n"
        "         )`,\n"
        "      [validClaimGen, runId, queue, claimToken, validClaimGen, validClaimGen],",
        "           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}\n"
        "             AND ${durableTaskRetryAdmissible('t')}\n"
        "             AND ${durableTaskHeadersAdmissible('t')}\n"
        "             AND 1 = 1\n"
        "             AND ${storedHighestOwnedOrdinal('runs')}\n"
        "             AND ${activationDurationAdmissible('t', NOW)}\n"
        "         )`,\n"
        "      [validClaimGen, runId, queue, claimToken, validClaimGen, validClaimGen],",
        "activation stops rechecking current-run accounting at its winning CAS",
    ),
    (
        "activate-validates-claim-generation-input",
        "packages/store-libsql/src/store.ts",
        "    const validClaimGen = requirePositiveClaimGeneration('activate.claimGen', claimGen)\n",
        "    const validClaimGen = claimGen\n",
        "an invalid activation claim generation reaches the SQL executor",
    ),
    (
        "claim-requires-activation-generation-order",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, run)}\n"
        "               AND ${run}.activated_gen <= ${run}.claim_gen\n"
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, run)}\n"
        "               AND 1 = 1\n"
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n",
        "claim advances a run whose activation generation is ahead of its claim generation",
    ),
    (
        "claim-receipt-requires-activation-generation-order",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, 'r')}\n"
        "         AND r.activated_gen <= r.claim_gen\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'r')}\n",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.activated_gen, 'r')}\n"
        "         AND 1 = 1\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'r')}\n",
        "a same-token receipt returns a run whose activation generation is ahead",
    ),
    (
        "claim-receipt-requires-user-attempt-budget",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedCurrentRunAccounting('r', 't')}\n"
        "         AND ${storedHighestOwnedOrdinal('r')}\n"
        "       ORDER BY r.run_id`",
        "         AND ${storedCurrentRunAccounting('r', 't').replace(\n"
        "           'AND t.attempts < t.max_attempts',\n"
        "           'AND t.attempts <= t.max_attempts',\n"
        "         )}\n"
        "         AND ${storedHighestOwnedOrdinal('r')}\n"
        "       ORDER BY r.run_id`",
        "a same-token receipt returns a run after its user-attempt budget is exhausted",
    ),
    (
        "claim-receipt-requires-highest-owned-ordinal",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedHighestOwnedOrdinal('r')}\n"
        "       ORDER BY r.run_id`",
        "         AND 1 = 1\n"
        "       ORDER BY r.run_id`",
        "a same-token receipt returns an obsolete run below a higher owned ordinal",
    ),
    (
        "claim-receipt-requires-relaunch-bound",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, 'r')}\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'r')}\n",
        "         AND 1 = 1\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'r')}\n",
        "a same-token receipt returns a run with an out-of-range relaunch counter",
    ),
    (
        "claim-receipt-allows-max-generation",
        "packages/store-libsql/src/fragments.ts",
        "export const storedPositiveClaimGeneration = (alias?: string): string => {\n"
        "  const bounds = POSITIVE_CLAIM_GENERATION_BOUNDS\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max)\n"
        "}",
        "export const storedPositiveClaimGeneration = (alias?: string): string => {\n"
        "  const bounds = POSITIVE_CLAIM_GENERATION_BOUNDS\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max - 1)\n"
        "}",
        "a same-token receipt wrongly refuses the maximum valid claimed generation",
    ),
    (
        "current-run-requires-user-attempt-budget",
        "packages/store-libsql/src/fragments.ts",
        "    AND ${task}.attempts < ${task}.max_attempts\n",
        "    AND ${task}.attempts <= ${task}.max_attempts\n",
        "a current live run remains eligible after its user-attempt budget is exhausted",
    ),
    (
        "current-run-requires-highest-owned-ordinal",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedCurrentRunAccounting(run, task)}\n"
        "               AND ${storedHighestOwnedOrdinal(run)}`",
        "               AND ${storedCurrentRunAccounting(run, task)}\n"
        "               AND 1 = 1`",
        "claim admits an obsolete live run beneath a higher historical ordinal",
    ),
    (
        "checkpoint-read-requires-owner-join",
        "packages/store-libsql/src/store.ts",
        "                JOIN runs owner\n",
        "                LEFT JOIN runs owner\n",
        "checkpoint reads surface a row whose declared owner tuple names no matching run",
    ),
    (
        "checkpoint-read-requires-owner-attempt-relation",
        "packages/store-libsql/src/store.ts",
        "                  ON ${checkpointOwnerMatches('c', 'owner')}",
        "                  ON ${checkpointOwnerMatches('c', 'owner').replace(\n"
        "                    'AND owner.attempt = c.owner_attempt',\n"
        "                    'AND 1 = 1',\n"
        "                  )}",
        "checkpoint reads surface a forged owner ordinal",
    ),
    (
        "checkpoint-write-rejects-fractional-owner-attempt",
        "packages/store-libsql/src/store.ts",
        "         AND state = 'running'\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n",
        "         AND state = 'running'\n"
        "         AND runs.attempt BETWEEN ${RUN_INTEGER_BOUNDS.attempt.min}\n"
        "           AND ${RUN_INTEGER_BOUNDS.attempt.max}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n",
        "the checkpoint lease CAS accepts a fractional owner attempt before the follow-on refuses it",
    ),
    (
        "checkpoint-write-rejects-owner-attempt-overflow",
        "packages/store-libsql/src/store.ts",
        "         AND state = 'running'\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n",
        "         AND state = 'running'\n"
        "         AND ${storedInteger('runs.attempt')}\n"
        "         AND runs.attempt >= ${RUN_INTEGER_BOUNDS.attempt.min}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n",
        "the checkpoint lease CAS accepts an owner attempt above the protocol maximum",
    ),
    (
        "suspend-preserves-valid-higher-lww",
        "packages/store-libsql/src/store.ts",
        "         AND ${validCheckpointConflict('runs', '?')}\n"
        "         ${wakePlan.fits}`,\n"
        "      [\n"
        "        wakePlan.argument,\n"
        "        wakePlan.argument,",
        "         AND ${validCheckpointConflict('runs', '?').replace(\n"
        "           'AND EXISTS (',\n"
        "           'AND c.owner_attempt <= runs.attempt AND EXISTS (',\n"
        "         )}\n"
        "         ${wakePlan.fits}`,\n"
        "      [\n"
        "        wakePlan.argument,\n"
        "        wakePlan.argument,",
        "suspendRun mistakes a valid higher LWW owner for corrupt ownership",
    ),
    (
        "reschedule-wake-own-discriminant",
        "packages/store-libsql/src/store.ts",
        "    const relativeWake = wakeHasOwn(wake, 'inSeconds')\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    // ONE SQL shape for both dispositions",
        "    const relativeWake = 'inSeconds' in wake // MUTATION\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    // ONE SQL shape for both dispositions",
        "reschedule mistakes an inherited relative-wake property for its durable discriminant",
    ),
    (
        "suspend-wake-own-discriminant",
        "packages/store-libsql/src/store.ts",
        "    const relativeWake = wakeHasOwn(wake, 'inSeconds')\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    const b = new FencedBatch('suspend'",
        "    const relativeWake = 'inSeconds' in wake // MUTATION\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    const b = new FencedBatch('suspend'",
        "suspendRun mistakes an inherited relative-wake property for its durable discriminant",
    ),
    (
        "checkpoint-read-validates-run-attempt-input",
        "packages/store-libsql/src/store.ts",
        "    const visibleThrough = requireRunOrdinal('getCheckpoints.attempt', attempt)\n",
        "    const visibleThrough = attempt\n",
        "an invalid checkpoint visibility ordinal reaches the SQL executor",
    ),
    (
        "run-ordinal-rejects-bigint-client-input",
        "packages/core/src/validate.ts",
        "export function requireRunOrdinal(name: string, value: unknown): number {\n"
        "  return requireClientBrandedInteger(name, value, PERSISTED_INTEGER_BOUNDS.runs.attempt)\n"
        "}",
        "export function requireRunOrdinal(name: string, value: unknown): number {\n"
        "  return requireBrandedInteger(name, value, PERSISTED_INTEGER_BOUNDS.runs.attempt)\n"
        "}",
        "the JavaScript client boundary accepts a bigint as a public run ordinal",
    ),
    (
        "stored-within-rejects-spread-descriptor",
        "packages/store-libsql/src/fragments.ts",
        "export const storedIntegerWithin = (\n"
        "  bounds: PersistedIntegerBoundsExceptClaimGeneration,\n"
        "  alias?: string,\n"
        "): string => {\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max)\n"
        "}",
        "export const storedIntegerWithin = (\n"
        "  bounds:\n"
        "    | PersistedIntegerBoundsExceptClaimGeneration\n"
        "    | (Pick<PersistedIntegerBounds, 'min' | 'max'> & { readonly field?: never }),\n"
        "  alias?: string,\n"
        "): string => {\n"
        "  const column = persistedColumn(bounds as PersistedIntegerBounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max)\n"
        "}",
        "the SQL guard API accepts a forged object-spread descriptor",
    ),
    (
        "stored-incrementable-rejects-spread-descriptor",
        "packages/store-libsql/src/fragments.ts",
        "export const storedIncrementableInteger = (\n"
        "  bounds: PersistedIntegerBoundsExceptClaimGeneration,\n"
        "  alias?: string,\n"
        "): string => {\n"
        "  const column = persistedColumn(bounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max - 1)\n"
        "}",
        "export const storedIncrementableInteger = (\n"
        "  bounds:\n"
        "    | PersistedIntegerBoundsExceptClaimGeneration\n"
        "    | (Pick<PersistedIntegerBounds, 'min' | 'max'> & { readonly field?: never }),\n"
        "  alias?: string,\n"
        "): string => {\n"
        "  const column = persistedColumn(bounds as PersistedIntegerBounds, alias)\n"
        "  return storedBoundedInteger(column, bounds.min, bounds.max - 1)\n"
        "}",
        "the increment-safe SQL guard API accepts a forged object-spread descriptor",
    ),
    (
        "persisted-row-rejects-spread-descriptor",
        "packages/store-libsql/src/store.ts",
        "export function persistedRowInteger(\n"
        "  scope: string,\n"
        "  row: SqlRow,\n"
        "  bounds: PersistedIntegerBoundsExceptClaimGeneration,\n"
        "): number {\n"
        "  return decodePersistedRowInteger(scope, row, bounds)\n"
        "}",
        "export function persistedRowInteger(\n"
        "  scope: string,\n"
        "  row: SqlRow,\n"
        "  bounds:\n"
        "    | PersistedIntegerBoundsExceptClaimGeneration\n"
        "    | (Pick<PersistedIntegerBounds, 'min' | 'max'> & { readonly field?: never }),\n"
        "): number {\n"
        "  return decodePersistedRowInteger(\n"
        "    scope,\n"
        "    row,\n"
        "    bounds as PersistedIntegerBoundsExceptClaimGeneration,\n"
        "  )\n"
        "}",
        "the persisted row decoder accepts a forged object-spread descriptor",
    ),
    (
        "derived-row-rejects-spread-descriptor",
        "packages/core/src/validate.ts",
        "export function requireDerivedInteger(\n"
        "  name: string,\n"
        "  value: unknown,\n"
        "  bounds: DerivedIntegerBounds,\n"
        "): number {\n"
        "  return requireBrandedInteger(name, value, bounds)\n"
        "}",
        "export function requireDerivedInteger(\n"
        "  name: string,\n"
        "  value: unknown,\n"
        "  bounds: DerivedIntegerBounds | (IntegerBounds & { readonly field?: never }),\n"
        "): number {\n"
        "  return requireBrandedInteger(name, value, bounds as DerivedIntegerBounds)\n"
        "}",
        "the derived row decoder accepts a forged object-spread descriptor",
    ),
    (
        "persisted-counter-field-task-attempts",
        "packages/core/src/validate.ts",
        "  'task-attempts': PersistedCounterFieldFor<'task-attempts'>\n",
        "  'task-attempts'?: PersistedCounterFieldFor<'task-attempts'>\n",
        "the keyed persisted-counter contract makes tasks.attempts optional",
    ),
    (
        "persisted-counter-field-task-max-attempts",
        "packages/core/src/validate.ts",
        "  'task-max-attempts': PersistedCounterFieldFor<'task-max-attempts'>\n",
        "  'task-max-attempts'?: PersistedCounterFieldFor<'task-max-attempts'>\n",
        "the keyed persisted-counter contract makes tasks.max_attempts optional",
    ),
    (
        "persisted-counter-field-task-infra-retries",
        "packages/core/src/validate.ts",
        "  'task-infra-retries': PersistedCounterFieldFor<'task-infra-retries'>\n",
        "  'task-infra-retries'?: PersistedCounterFieldFor<'task-infra-retries'>\n",
        "the keyed persisted-counter contract makes tasks.infra_retries optional",
    ),
    (
        "persisted-counter-field-run-attempt",
        "packages/core/src/validate.ts",
        "  'run-attempt': PersistedCounterFieldFor<'run-attempt'>\n",
        "  'run-attempt'?: PersistedCounterFieldFor<'run-attempt'>\n",
        "the keyed persisted-counter contract makes runs.attempt optional",
    ),
    (
        "persisted-counter-field-run-claim-gen",
        "packages/core/src/validate.ts",
        "  'run-claim-gen': PersistedCounterFieldFor<'run-claim-gen'>\n",
        "  'run-claim-gen'?: PersistedCounterFieldFor<'run-claim-gen'>\n",
        "the keyed persisted-counter contract makes runs.claim_gen optional",
    ),
    (
        "persisted-counter-field-run-activated-gen",
        "packages/core/src/validate.ts",
        "  'run-activated-gen': PersistedCounterFieldFor<'run-activated-gen'>\n",
        "  'run-activated-gen'?: PersistedCounterFieldFor<'run-activated-gen'>\n",
        "the keyed persisted-counter contract makes runs.activated_gen optional",
    ),
    (
        "persisted-counter-field-run-relaunch-count",
        "packages/core/src/validate.ts",
        "  'run-relaunch-count': PersistedCounterFieldFor<'run-relaunch-count'>\n",
        "  'run-relaunch-count'?: PersistedCounterFieldFor<'run-relaunch-count'>\n",
        "the keyed persisted-counter contract makes runs.relaunch_count optional",
    ),
    (
        "persisted-counter-field-checkpoint-owner-attempt",
        "packages/core/src/validate.ts",
        "  'checkpoint-owner-attempt': PersistedCounterFieldFor<'checkpoint-owner-attempt'>\n",
        "  'checkpoint-owner-attempt'?: PersistedCounterFieldFor<'checkpoint-owner-attempt'>\n",
        "the keyed persisted-counter contract makes checkpoints.owner_attempt optional",
    ),
    (
        "poison-profile-claim-pending",
        "packages/conformance/src/poison-matrix.ts",
        "  'claim-pending': PoisonTargetProfileSeed<'pending', null, 0, 0, null, null, null, 999_998>\n",
        "  'claim-pending': PoisonTargetProfileSeed<\n"
        "    'pending' | 'sleeping',\n"
        "    null,\n"
        "    0,\n"
        "    0,\n"
        "    null,\n"
        "    null,\n"
        "    null,\n"
        "    999_998\n"
        "  >\n",
        "the keyed profile contract admits a sleeping claim-pending seed",
    ),
    (
        "poison-profile-claim-sleeping",
        "packages/conformance/src/poison-matrix.ts",
        "  'claim-sleeping': PoisonTargetProfileSeed<'sleeping', null, 1, 1, null, null, null, 999_998>\n",
        "  'claim-sleeping': PoisonTargetProfileSeed<\n"
        "    'sleeping' | 'pending',\n"
        "    null,\n"
        "    1,\n"
        "    1,\n"
        "    null,\n"
        "    null,\n"
        "    null,\n"
        "    999_998\n"
        "  >\n",
        "the keyed profile contract admits a pending claim-sleeping seed",
    ),
    (
        "poison-profile-sweep-lost-launch",
        "packages/conformance/src/poison-matrix.ts",
        "  'sweep-lost-launch': PoisonTargetProfileSeed<\n"
        "    'running',\n"
        "    'poison-worker',\n"
        "    1,\n"
        "    0,\n",
        "  'sweep-lost-launch': PoisonTargetProfileSeed<\n"
        "    'running',\n"
        "    'poison-worker',\n"
        "    1,\n"
        "    0 | 1,\n",
        "the keyed profile contract admits an activated lost-launch seed",
    ),
    (
        "poison-profile-sweep-claim-timeout",
        "packages/conformance/src/poison-matrix.ts",
        "  'sweep-claim-timeout': PoisonTargetProfileSeed<\n"
        "    'running',\n"
        "    'poison-worker',\n"
        "    1,\n"
        "    1,\n",
        "  'sweep-claim-timeout': PoisonTargetProfileSeed<\n"
        "    'running',\n"
        "    'poison-worker',\n"
        "    1,\n"
        "    1 | 0,\n",
        "the keyed profile contract admits an unactivated claim-timeout seed",
    ),
    (
        "poison-targetability-vector-task-attempts-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-attempts/upper': CounterRelationVector\n",
        "  'task-attempts/upper': CounterRelationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable upper task-attempts vector",
    ),
    (
        "poison-targetability-vector-task-attempts-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-attempts/lower': TargetableVector\n",
        "  'task-attempts/lower': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable lower task-attempts vector",
    ),
    (
        "poison-targetability-vector-task-max-attempts-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-max-attempts/upper': TargetableVector\n",
        "  'task-max-attempts/upper': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable upper task-max-attempts vector",
    ),
    (
        "poison-targetability-vector-task-max-attempts-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-max-attempts/lower': CounterRelationVector\n",
        "  'task-max-attempts/lower': CounterRelationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable lower task-max-attempts vector",
    ),
    (
        "poison-targetability-vector-task-infra-retries-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-infra-retries/upper': TargetableVector\n",
        "  'task-infra-retries/upper': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable upper task-infra-retries vector",
    ),
    (
        "poison-targetability-vector-task-infra-retries-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'task-infra-retries/lower': TargetableVector\n",
        "  'task-infra-retries/lower': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable lower task-infra-retries vector",
    ),
    (
        "poison-targetability-vector-run-attempt-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-attempt/upper': CounterRelationVector\n",
        "  'run-attempt/upper': CounterRelationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable upper run-attempt vector",
    ),
    (
        "poison-targetability-vector-run-attempt-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-attempt/lower': CounterRelationVector\n",
        "  'run-attempt/lower': CounterRelationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable lower run-attempt vector",
    ),
    (
        "poison-targetability-vector-run-claim-gen-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-claim-gen/upper': TargetableTargetableGenerationVector\n",
        "  'run-claim-gen/upper':\n"
        "    | TargetableTargetableGenerationVector\n"
        "    | GenerationGenerationTargetableVector\n",
        "the keyed targetability contract admits the inverted upper claim-generation vector",
    ),
    (
        "poison-targetability-vector-run-claim-gen-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-claim-gen/lower': GenerationVector\n",
        "  'run-claim-gen/lower': GenerationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable lower claim-generation vector",
    ),
    (
        "poison-targetability-vector-run-activated-gen-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-activated-gen/upper': GenerationVector\n",
        "  'run-activated-gen/upper': GenerationVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable upper activation-generation vector",
    ),
    (
        "poison-targetability-vector-run-activated-gen-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-activated-gen/lower': TargetableTargetableGenerationVector\n",
        "  'run-activated-gen/lower':\n"
        "    | TargetableTargetableGenerationVector\n"
        "    | GenerationGenerationTargetableVector\n",
        "the keyed targetability contract admits the inverted lower activation-generation vector",
    ),
    (
        "poison-targetability-vector-run-relaunch-count-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-relaunch-count/upper': TargetableVector\n",
        "  'run-relaunch-count/upper': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable upper relaunch-count vector",
    ),
    (
        "poison-targetability-vector-run-relaunch-count-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'run-relaunch-count/lower': TargetableVector\n",
        "  'run-relaunch-count/lower': TargetableVector | CounterRelationVector\n",
        "the keyed targetability contract admits an unreachable lower relaunch-count vector",
    ),
    (
        "poison-targetability-vector-checkpoint-owner-attempt-upper",
        "packages/conformance/src/poison-matrix.ts",
        "  'checkpoint-owner-attempt/upper': UnreadVector\n",
        "  'checkpoint-owner-attempt/upper': UnreadVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable upper checkpoint-owner vector",
    ),
    (
        "poison-targetability-vector-checkpoint-owner-attempt-lower",
        "packages/conformance/src/poison-matrix.ts",
        "  'checkpoint-owner-attempt/lower': UnreadVector\n",
        "  'checkpoint-owner-attempt/lower': UnreadVector | TargetableVector\n",
        "the keyed targetability contract admits a targetable lower checkpoint-owner vector",
    ),
    (
        "poison-sweep-scan-prelimit",
        "packages/store-libsql/src/store.ts",
        "  AND ${sweepScanAdmissible('r', 't')}\n"
        "ORDER BY r.claim_expires_at_ms, r.run_id\n"
        "LIMIT ?`",
        "  AND 1 = 1\n"
        "ORDER BY r.claim_expires_at_ms, r.run_id\n"
        "LIMIT ?`",
        "a corrupt expired row consumes the sweep scan limit before target eligibility",
    ),
    (
        "sweep-lost-launch-rechecks-accounting",
        "packages/store-libsql/src/store.ts",
        "      WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE}\n"
        "        AND ${sweepLiveOwnerAdmissible('runs', 't')}\n"
        "    )`",
        "      WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE}\n"
        "        AND ${sweepLiveOwnerAdmissible('runs', 't').replace(\n"
        "          storedCurrentRunAccounting('runs', 't'),\n"
        "          '1 = 1',\n"
        "        )}\n"
        "    )`",
        "the lost-launch CAS trusts its advisory scan instead of rechecking accounting",
    ),
    (
        "sweep-claim-timeout-rechecks-accounting",
        "packages/store-libsql/src/store.ts",
        "             AND ((t.state NOT IN ${LIVE}\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible('runs', 't')}\n"
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))\n"
        "         )`,\n"
        "      [REASON_CLAIM_TIMEOUT, item.runId, queue, item.claimGen],",
        "             AND ((t.state NOT IN ${LIVE}\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible(\n"
        "                 'runs',\n"
        "                 't',\n"
        "               ).replace(storedCurrentRunAccounting('runs', 't'), '1 = 1')}\n"
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))\n"
        "         )`,\n"
        "      [REASON_CLAIM_TIMEOUT, item.runId, queue, item.claimGen],",
        "the claim-timeout CAS trusts its advisory scan instead of rechecking accounting",
    ),
    (
        "terminal-timeout-scan-admits-terminal-owner",
        "packages/store-libsql/src/store.ts",
        "const sweepTerminalOwnerAdmissible = (run: string): string =>\n"
        "  `${storedSweepGenerations(run)}\n"
        "   AND (${run}.activated_gen = ${run}.claim_gen\n",
        "const sweepTerminalOwnerAdmissible = (run: string): string =>\n"
        "  `${storedSweepGenerations(run)}\n"
        "   AND (1 = 0\n",
        "the advisory sweep scan strands an activated run beneath a terminal task",
    ),
    (
        "terminal-timeout-cas-admits-terminal-owner",
        "packages/store-libsql/src/store.ts",
        "             AND ((t.state NOT IN ${LIVE}\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible('runs', 't')}\n"
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))\n"
        "         )`,\n"
        "      [REASON_CLAIM_TIMEOUT, item.runId, queue, item.claimGen],",
        "             AND ((1 = 0\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible('runs', 't')}\n"
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))\n"
        "         )`,\n"
        "      [REASON_CLAIM_TIMEOUT, item.runId, queue, item.claimGen],",
        "the timeout CAS strands an activated run after its task became terminal",
    ),
    (
        "terminal-timeout-scan-ignores-relaunch",
        "packages/store-libsql/src/store.ts",
        "const sweepTerminalOwnerAdmissible = (run: string): string =>\n"
        "  `${storedSweepGenerations(run)}\n",
        "const sweepTerminalOwnerAdmissible = (run: string): string =>\n"
        "  `${storedSweepCounters(run)}\n",
        "an unrelated corrupt relaunch counter hides a terminal activated timeout from discovery",
    ),
    (
        "terminal-timeout-decode-ignores-relaunch",
        "packages/store-libsql/src/store.ts",
        "      const activatedGen = persistedRowInteger('sweep', row, RUN_INTEGER_BOUNDS.activated_gen)\n"
        "      const identity = {\n",
        "      const activatedGen = persistedRowInteger('sweep', row, RUN_INTEGER_BOUNDS.activated_gen)\n"
        "      persistedRowInteger('sweep', row, RUN_INTEGER_BOUNDS.relaunch_count)\n"
        "      const identity = {\n",
        "the sweep decoder reads a counter that the activated-timeout arm does not consume",
    ),
    (
        "terminal-relaunch-cap-scan-admits-terminal-owner",
        "packages/store-libsql/src/store.ts",
        "     OR (${run}.activated_gen < ${run}.claim_gen\n"
        "       AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n",
        "     OR (1 = 0 AND ${run}.activated_gen < ${run}.claim_gen\n"
        "       AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n",
        "the advisory sweep scan strands a relaunch-cap run beneath a terminal task",
    ),
    (
        "terminal-relaunch-cap-cas-admits-terminal-owner",
        "packages/store-libsql/src/store.ts",
        "       WHERE ${guard} AND relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}\n"
        "         AND (${liveOwner} OR ${terminalOwner})`,",
        "       WHERE ${guard} AND relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}\n"
        "         AND ${liveOwner}`,",
        "the relaunch-cap CAS strands a run after its task became terminal",
    ),
    (
        "sweep-terminal-cap-rechecks-generation-lower-bound",
        "packages/store-libsql/src/store.ts",
        "    const terminalOwner = `EXISTS (\n"
        "      SELECT 1 FROM tasks t\n"
        "      WHERE ${runOwnedByTask('runs', 't')} AND t.state NOT IN ${LIVE}\n"
        "        AND ${sweepTerminalOwnerAdmissible('runs')}\n"
        "    )`",
        "    const terminalOwner = `EXISTS (\n"
        "      SELECT 1 FROM tasks t\n"
        "      WHERE ${runOwnedByTask('runs', 't')} AND t.state NOT IN ${LIVE}\n"
        "        AND ${sweepTerminalOwnerAdmissible('runs').replace(\n"
        "          `runs.activated_gen BETWEEN ${RUN_INTEGER_BOUNDS.activated_gen.min} AND ${RUN_INTEGER_BOUNDS.activated_gen.max}`,\n"
        "          `runs.activated_gen <= ${RUN_INTEGER_BOUNDS.activated_gen.max}`,\n"
        "        )}\n"
        "    )`",
        "the relaunch-cap CAS trusts a generation that became negative after its advisory scan",
    ),
    (
        "fail-cas-admits-terminal-owner",
        "packages/store-libsql/src/store.ts",
        "           WHERE ${runOwnedByTask('runs', 't')}\n"
        "             AND (t.state NOT IN ${LIVE}\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${soleLiveRun('runs')}\n"
        "                 AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "           WHERE ${runOwnedByTask('runs', 't')}\n"
        "             AND (1 = 0\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${soleLiveRun('runs')}\n"
        "                 AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "worker failure cannot quiesce its run after another actor terminalized the task",
    ),
    (
        "poison-severity-lower-bound",
        "packages/conformance/src/poison-matrix.ts",
        "  if (exact < minimum) return minimum - exact\n",
        "  if (exact < minimum) return 0n\n",
        "lower-bound corruption can worsen without increasing reported severity",
    ),
    (
        "poison-severity-checkpoint",
        "packages/conformance/src/poison-matrix.ts",
        "  if (field.table === 'checkpoints') {\n",
        "  if (false && field.table === 'checkpoints') {\n",
        "checkpoint counter corruption bypasses its composite-identity severity branch",
    ),
    (
        "poison-target-closure-comparison",
        "packages/conformance/src/poison-matrix.ts",
        "  if (!same(poisonOwnedClosure(before), poisonOwnedClosure(after))) {\n",
        "  if (false && !same(poisonOwnedClosure(before), poisonOwnedClosure(after))) {\n",
        "a targeted transition may rewrite or launder the poison-owned closure",
    ),
    (
        "poison-returned-target-comparison",
        "packages/conformance/src/poison-matrix.ts",
        "  if (outcomes.some((outcome) => outcomeMentionsPoison(outcome.result))) {\n",
        "  if (false && outcomes.some((outcome) => outcomeMentionsPoison(outcome.result))) {\n",
        "a targeted transition may return the poisoned task or run",
    ),
    (
        "accounting-live-run-next-invariant",
        "packages/conformance/src/invariants.ts",
        "          if (liveAttempt !== undefined && liveAttempt !== accounted + 1n) {\n",
        "          if (false && liveAttempt !== undefined && liveAttempt !== accounted + 1n) {\n",
        "the invariant evaluator accepts a live run that is not the next accounted ordinal",
    ),
    (
        "sweep-accepts-max-ordinal-at-infra-cap",
        "packages/core/src/validate.ts",
        "    attempt: integerBounds('runs.attempt', 1, MAX_RUN_ORDINAL),\n",
        "    attempt: integerBounds('runs.attempt', 1, MAX_RUN_ORDINAL - 1),\n",
        "the terminal infrastructure-cap sweep wrongly refuses the maximum legal run ordinal",
    ),
    (
        "poison-relational-target-attempts-at-max-with-live-run",
        "packages/conformance/src/poison-matrix.ts",
        "  readonly 'attempts/at-max-with-live-run': TargetableVector\n",
        "  readonly 'attempts/at-max-with-live-run'?: TargetableVector\n",
        "the relational-target contract makes attempts-at-max-with-live-run optional",
    ),
    (
        "poison-relational-target-accounting-below-top-minus-one",
        "packages/conformance/src/poison-matrix.ts",
        "  readonly 'accounting/below-top-minus-one': TargetableVector\n",
        "  readonly 'accounting/below-top-minus-one'?: TargetableVector\n",
        "the relational-target contract makes accounting-below-top-minus-one optional",
    ),
    (
        "poison-relational-target-accounting-live-run-not-next",
        "packages/conformance/src/poison-matrix.ts",
        "  readonly 'accounting/live-run-not-next': TargetableVector\n",
        "  readonly 'accounting/live-run-not-next'?: TargetableVector\n",
        "the relational-target contract makes accounting-live-run-not-next optional",
    ),
    (
        "poison-relational-target-counter-fractional-task-max-attempts",
        "packages/conformance/src/poison-matrix.ts",
        "  readonly 'counter-fractional/task-max-attempts': TargetableVector\n",
        "  readonly 'counter-fractional/task-max-attempts'?: TargetableVector\n",
        "the relational-target contract makes fractional task max-attempts optional",
    ),
    (
        "poison-relational-target-counter-fractional-run-relaunch-count",
        "packages/conformance/src/poison-matrix.ts",
        "  readonly 'counter-fractional/run-relaunch-count': TargetableVector\n",
        "  readonly 'counter-fractional/run-relaunch-count'?: TargetableVector\n",
        "the relational-target contract makes fractional run relaunch-count optional",
    ),
    (
        "poison-claim-fractional-task-max-attempts",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedCurrentRunAccounting(run, task)}\n"
        "               AND ${storedHighestOwnedOrdinal(run)}",
        "               AND ${storedCurrentRunAccounting(run, task).replace(\n"
        "                 `typeof(${task}.max_attempts) = 'integer'`,\n"
        "                 `${task}.max_attempts IS NOT NULL`,\n"
        "               )}\n"
        "               AND ${storedHighestOwnedOrdinal(run)}",
        "claim accepts an in-range fractional REAL task max-attempts counter",
    ),
    (
        "poison-claim-fractional-run-relaunch-count",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run).replace(\n"
        "                 `typeof(${run}.relaunch_count) = 'integer'`,\n"
        "                 `${run}.relaunch_count IS NOT NULL`,\n"
        "               )}\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "claim accepts an in-range fractional REAL run relaunch-count counter",
    ),
    (
        "poison-sweep-fractional-task-max-attempts",
        "packages/store-libsql/src/store.ts",
        "   AND ${storedCurrentRunAccounting(run, task)}\n"
        "   AND ${storedHighestOwnedOrdinal(run)}\n",
        "   AND ${storedCurrentRunAccounting(run, task).replace(\n"
        "     `typeof(${task}.max_attempts) = 'integer'`,\n"
        "     `${task}.max_attempts IS NOT NULL`,\n"
        "   )}\n"
        "   AND ${storedHighestOwnedOrdinal(run)}\n",
        "sweep accepts an in-range fractional REAL task max-attempts counter",
    ),
    (
        "poison-sweep-fractional-run-relaunch-count",
        "packages/store-libsql/src/store.ts",
        "const sweepLiveOwnerAdmissible = (run: string, task: string): string =>\n"
        "  `${storedSweepCounters(run)}\n"
        "   AND ${soleLiveRun(run)}\n",
        "const sweepLiveOwnerAdmissible = (run: string, task: string): string =>\n"
        "  `${storedSweepCounters(run).replace(\n"
        "    `typeof(${run}.relaunch_count) = 'integer'`,\n"
        "    `${run}.relaunch_count IS NOT NULL`,\n"
        "  )}\n"
        "   AND ${soleLiveRun(run)}\n",
        "sweep accepts an in-range fractional REAL run relaunch-count counter",
    ),
    (
        "poison-claim-relaunch-upper",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "               AND (${storedInteger(`${run}.relaunch_count`)}\n"
        "                 AND ${run}.relaunch_count >= ${RUN_INTEGER_BOUNDS.relaunch_count.min})\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "claim accepts a relaunch counter above its protocol maximum",
    ),
    (
        "poison-claim-relaunch-lower",
        "packages/store-libsql/src/store.ts",
        "               AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.relaunch_count, run)}\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "               AND (${storedInteger(`${run}.relaunch_count`)}\n"
        "                 AND ${run}.relaunch_count <= ${RUN_INTEGER_BOUNDS.relaunch_count.max})\n"
        "               AND ${storedCurrentRunAccounting(run, task)}\n",
        "claim accepts a relaunch counter below zero",
    ),
    (
        "matrix-lost-launch-edge-progress",
        "packages/store-libsql/src/store.ts",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}`",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "                   AND run_id <> 'edge-run'`",
        "the generated fault cell fires its label while the seeded lost-launch edge never crosses",
    ),
    (
        "sweep-lost-launch-generation",
        "packages/store-libsql/src/store.ts",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}`",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "                   AND (run_id <> 'edge-run' OR claim_gen = 1)`",
        "the lost-launch edge only works at generation one",
    ),
    (
        "matrix-claim-timeout-edge-progress",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND run_id <> 'edge-run'\n",
        "the generated fault cell fires its label while the seeded claim-timeout edge never crosses",
    ),
    (
        "sweep-claim-timeout-generation",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND (run_id <> 'edge-run' OR claim_gen = 1)\n",
        "the claim-timeout edge only works at generation one",
    ),
    (
        "provenance-sweep-progress",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n",
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND run_id <> 'prov-sweep-run'\n",
        "the replay regression accepts a sweep that never performs the transition it owes",
    ),
    (
        "matrix-attempt-edge-progress",
        "packages/store-libsql/src/store.ts",
        "         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,\n"
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n",
        "         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,\n"
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND run_id <> 'edge-run'\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n",
        "the generated fault cell fires its label while the seeded attempt-cap edge never crosses",
    ),
    (
        "shared-conformance-runner-registry",
        "packages/conformance/src/store-conformance.ts",
        "  { id: 'poison-matrix', run: poisonMatrixConformance },\n",
        "",
        "a dialect silently drops an entire shared conformance surface",
    ),
    (
        "scheduler-conformance-enrollment",
        "packages/conformance/src/store-conformance.ts",
        "  { id: 'scheduler', run: schedulerConformance },\n",
        "",
        "a dialect silently drops scheduler conformance",
    ),
    (
        "fault-matrix-conformance-enrollment",
        "packages/conformance/src/store-conformance.ts",
        "  { id: 'fault-matrix', run: faultMatrixConformance },\n",
        "",
        "a dialect silently drops fault-matrix conformance",
    ),
    (
        "wake-witness-conformance-enrollment",
        "packages/conformance/src/store-conformance.ts",
        "  { id: 'wake-witness', run: wakeWitnessConformance },\n",
        "",
        "a dialect silently drops wake-witness conformance",
    ),
    (
        "scheduler-conformance-dispatch",
        "packages/conformance/src/store-conformance.ts",
        "      for (const { run } of registeredSurfaces) {\n"
        "        run(dialect, makeFixture)\n"
        "      }\n",
        "      for (const { id, run } of registeredSurfaces) {\n"
        "        if (id !== 'scheduler') run(dialect, makeFixture)\n"
        "      }\n",
        "the bound registry retains scheduler membership but skips its executable dispatch",
    ),
    (
        "fault-matrix-conformance-dispatch",
        "packages/conformance/src/store-conformance.ts",
        "      for (const { run } of registeredSurfaces) {\n"
        "        run(dialect, makeFixture)\n"
        "      }\n",
        "      for (const { id, run } of registeredSurfaces) {\n"
        "        if (id !== 'fault-matrix') run(dialect, makeFixture)\n"
        "      }\n",
        "the bound registry retains fault-matrix membership but skips its executable dispatch",
    ),
    (
        "poison-matrix-conformance-dispatch",
        "packages/conformance/src/store-conformance.ts",
        "      for (const { run } of registeredSurfaces) {\n"
        "        run(dialect, makeFixture)\n"
        "      }\n",
        "      for (const { id, run } of registeredSurfaces) {\n"
        "        if (id !== 'poison-matrix') run(dialect, makeFixture)\n"
        "      }\n",
        "the bound registry retains poison-matrix membership but skips its executable dispatch",
    ),
    (
        "timestamp-boundary-conformance-dispatch",
        "packages/conformance/src/store-conformance.ts",
        "      for (const { run } of registeredSurfaces) {\n"
        "        run(dialect, makeFixture)\n"
        "      }\n",
        "      for (const { id, run } of registeredSurfaces) {\n"
        "        if (id !== 'timestamp-boundaries') run(dialect, makeFixture)\n"
        "      }\n",
        "the bound registry retains timestamp-boundary membership but skips its executable dispatch",
    ),
    (
        "wake-witness-conformance-dispatch",
        "packages/conformance/src/store-conformance.ts",
        "      for (const { run } of registeredSurfaces) {\n"
        "        run(dialect, makeFixture)\n"
        "      }\n",
        "      for (const { id, run } of registeredSurfaces) {\n"
        "        if (id !== 'wake-witness') run(dialect, makeFixture)\n"
        "      }\n",
        "the bound registry retains wake-witness membership but skips its executable dispatch",
    ),
    (
        "provenance-fail-progress",
        "packages/store-libsql/src/store.ts",
        "         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,\n"
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n",
        "         state = 'failed', failed_at_ms = ${NOW}, failure_reason = ?,\n"
        "         claimed_by = NULL, claim_expires_at_ms = NULL, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND run_id <> 'prov-fail-run'\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n",
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
        "      if (proposed <= tokens) {\n",
        "      if (false) {\n",
        "the test token sequencer exposes a duplicate proposed serial",
    ),
    (
        "test-token-source-valid-serial",
        "packages/store-libsql/src/testing.ts",
        "      if (!Number.isSafeInteger(proposed)) {\n",
        "      if (false) {\n",
        "the test token sequencer exposes a non-integer or unsafe proposed serial",
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
        "      if (error instanceof SchemaNotInitializedError) return null",
        "      if (error instanceof SchemaNotInitializedError || String(error).includes('no such table')) return null",
        "an unrelated executor failure is interpreted as a fresh database",
    ),
    (
        "schema-version-missing-result",
        "packages/store-libsql/src/admin.ts",
        "    const result = results.length === 1 ? results[0] : undefined\n",
        "    if (results.length === 0) return 0\n"
        "    const result = results.length === 1 ? results[0] : undefined\n",
        "an absent schema-version result is interpreted as a fresh database",
    ),
    (
        "schema-version-extra-results",
        "packages/store-libsql/src/admin.ts",
        "    const result = results.length === 1 ? results[0] : undefined\n",
        "    if (results.length > 1) return 0\n"
        "    const result = results.length === 1 ? results[0] : undefined\n",
        "duplicated schema-version results are interpreted as a fresh database",
    ),
    (
        "schema-version-missing-row",
        "packages/store-libsql/src/admin.ts",
        "    const row = result?.rows.length === 1 ? result.rows[0] : undefined\n",
        "    if (result !== undefined && result.rows.length === 0) return 0\n"
        "    const row = result?.rows.length === 1 ? result.rows[0] : undefined\n",
        "an absent schema-version row is interpreted as a fresh database",
    ),
    (
        "schema-version-extra-rows",
        "packages/store-libsql/src/admin.ts",
        "    const row = result?.rows.length === 1 ? result.rows[0] : undefined\n",
        "    if (result !== undefined && result.rows.length > 1) return 0\n"
        "    const row = result?.rows.length === 1 ? result.rows[0] : undefined\n",
        "duplicated schema-version rows are interpreted as a fresh database",
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
    (
        "spawn-orphan-owner-guard",
        "packages/store-libsql/src/store.ts",
        "         AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.task_id = ?)",
        "         AND ? IS NOT NULL",
        "spawn attaches a new task to a run that already claims its minted identity",
    ),
    (
        "spawn-cancellation-single-read",
        "packages/store-libsql/src/store.ts",
        "    const cancellationInput = opts.cancellation\n"
        "    let cancellationJson: string | null = null\n",
        "    const cancellationInput = opts.cancellation\n"
        "    void opts.cancellation // MUTATION: a second ambient read\n"
        "    let cancellationJson: string | null = null\n",
        "spawn reads a hostile cancellation accessor more than once",
    ),
    (
        "spawn-retry-captured-serializer",
        "packages/store-libsql/src/store.ts",
        "    const retry = serializeTaskValue(\n"
        "      'retry strategy',\n"
        "      normalizeRetryStrategy(retryInput === undefined ? DEFAULT_RETRY : retryInput),\n"
        "    )\n",
        "    const retry = JSON.stringify(\n"
        "      normalizeRetryStrategy(retryInput === undefined ? DEFAULT_RETRY : retryInput),\n"
        "    )\n",
        "spawn serializes the owned retry strategy through an ambient JSON hook",
    ),
    (
        "spawn-cancellation-owned-snapshot",
        "packages/store-libsql/src/store.ts",
        "      const canonicalCancellation = {\n"
        "        maxDelaySeconds: maxDelayMs === null ? undefined : maxDelayMs / 1000,\n"
        "        maxDurationSeconds:\n"
        "          maxDurationSeconds === undefined\n"
        "            ? undefined\n"
        "            : durationToMs('cancellation.maxDurationSeconds', maxDurationSeconds) / 1000,\n"
        "      }\n",
        "      const canonicalCancellation: {\n"
        "        maxDelaySeconds?: number\n"
        "        maxDurationSeconds?: number\n"
        "      } = {}\n"
        "      canonicalCancellation.maxDelaySeconds =\n"
        "        maxDelayMs === null ? undefined : maxDelayMs / 1000\n"
        "      canonicalCancellation.maxDurationSeconds =\n"
        "        maxDurationSeconds === undefined\n"
        "          ? undefined\n"
        "          : durationToMs('cancellation.maxDurationSeconds', maxDurationSeconds) / 1000\n",
        "spawn constructs canonical cancellation through inherited setters",
    ),
    (
        "spawn-cancellation-captured-serializer",
        "packages/store-libsql/src/store.ts",
        "      cancellationJson = serializeTaskValue('cancellation policy', canonicalCancellation)",
        "      cancellationJson = JSON.stringify(canonicalCancellation)",
        "spawn serializes the owned cancellation policy through an ambient JSON hook",
    ),
    (
        "spawn-headers-captured-serializer",
        "packages/store-libsql/src/store.ts",
        "      headersInput === undefined ? null : serializeTaskValue('task headers', headersInput)",
        "      headersInput === undefined ? null : JSON.stringify(headersInput)",
        "spawn serializes headers through an ambient JSON hook",
    ),
    (
        "claim-retry-captured-parser",
        "packages/store-libsql/src/store.ts",
        "    retryStrategy: normalizeRetryStrategy(parseTaskValueJson(String(row.retry_strategy))),",
        "    retryStrategy: normalizeRetryStrategy(JSON.parse(String(row.retry_strategy))),",
        "claim retry decoding resolves ambient JSON.parse after the durable guard",
    ),
    (
        "claim-headers-captured-parser",
        "packages/store-libsql/src/store.ts",
        "      row.headers === null\n"
        "        ? {}\n"
        "        : (parseTaskValueJson(String(row.headers)) as Record<string, string>),",
        "      row.headers === null\n"
        "        ? {}\n"
        "        : (JSON.parse(String(row.headers)) as Record<string, string>),",
        "claim header decoding resolves ambient JSON.parse after the durable guard",
    ),
    (
        "claim-payload-validation-atomic",
        "packages/store-libsql/src/store.ts",
        "      return `${eligibleTask(task, NOW)}\n"
        "               AND ${durableTaskRetryAdmissible(task)}\n"
        "               AND ${durableTaskHeadersAdmissible(task)}\n",
        "      return `${eligibleTask(task, NOW)}\n"
        "               AND 1 = 1\n"
        "               AND ${durableTaskHeadersAdmissible(task)}\n",
        "claim changes candidate state before discovering an undecodable retry strategy",
    ),
    (
        "claim-candidate-headers-admissible",
        "packages/store-libsql/src/store.ts",
        "               AND ${durableTaskRetryAdmissible(task)}\n"
        "               AND ${durableTaskHeadersAdmissible(task)}\n"
        "               AND ${soleLiveRun(run)}\n",
        "               AND ${durableTaskRetryAdmissible(task)}\n"
        "               AND 1 = 1\n"
        "               AND ${soleLiveRun(run)}\n",
        "claim changes candidate state before discovering undecodable headers",
    ),
    (
        "claim-receipt-retry-admissible",
        "packages/store-libsql/src/store.ts",
        "         AND t.state IN ${LIVE}\n"
        "         AND ${durableTaskRetryAdmissible('t')}\n"
        "         AND ${durableTaskHeadersAdmissible('t')}\n",
        "         AND t.state IN ${LIVE}\n"
        "         AND 1 = 1\n"
        "         AND ${durableTaskHeadersAdmissible('t')}\n",
        "a same-token receipt decodes an inadmissible durable retry strategy",
    ),
    (
        "claim-receipt-headers-admissible",
        "packages/store-libsql/src/store.ts",
        "         AND ${durableTaskRetryAdmissible('t')}\n"
        "         AND ${durableTaskHeadersAdmissible('t')}\n"
        "         AND ${soleLiveRun('r')}\n",
        "         AND ${durableTaskRetryAdmissible('t')}\n"
        "         AND 1 = 1\n"
        "         AND ${soleLiveRun('r')}\n",
        "a same-token receipt exposes inadmissible durable headers",
    ),
    (
        "activate-payload-validation-atomic",
        "packages/store-libsql/src/store.ts",
        "           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}\n"
        "             AND ${durableTaskRetryAdmissible('t')}\n"
        "             AND ${durableTaskHeadersAdmissible('t')}\n",
        "           WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)}\n"
        "             AND 1 = 1\n"
        "             AND ${durableTaskHeadersAdmissible('t')}\n",
        "activation latches a generation before discovering an undecodable retry strategy",
    ),
    (
        "activate-headers-admissible",
        "packages/store-libsql/src/store.ts",
        "             AND ${durableTaskRetryAdmissible('t')}\n"
        "             AND ${durableTaskHeadersAdmissible('t')}\n"
        "             AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "             AND ${durableTaskRetryAdmissible('t')}\n"
        "             AND 1 = 1\n"
        "             AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "activation exposes inadmissible durable headers after latching its generation",
    ),
    (
        "expire-lease-requires-future-expiry",
        "packages/store-libsql/src/store.ts",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS)\n",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS).replace(\n"
        "      `AND runs.claim_expires_at_ms > ${NOW_MS}`,\n"
        "      'AND 1 = 1',\n"
        "    )\n",
        "expireLeaseNow shortens a lease that had already expired",
    ),
    (
        "expire-lease-requires-integer-expiry",
        "packages/store-libsql/src/store.ts",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS)\n",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS).replace(\n"
        "      `typeof(runs.claim_expires_at_ms) = 'integer' AND `,\n"
        "      '',\n"
        "    )\n",
        "expireLeaseNow launders a fractional stored expiry into an integer instant",
    ),
    (
        "expire-lease-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "    const owner = runOwnedByTask('runs', 't')\n",
        "    const owner = 't.task_id = runs.task_id' // MUTATION\n",
        "expireLeaseNow shortens a run after its task crosses the immutable queue boundary",
    ),
    (
        "driver-heartbeat-single-clock",
        "packages/store-libsql/src/store.ts",
        "    await this.db.batch('driver-heartbeat', [\n"
        "      {\n"
        "        sql: `INSERT INTO ${DRIVER_HEARTBEAT_INGRESS}\n"
        "                (queue, driver_id, last_beat_ms, expires_at_ms)\n"
        "              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?\n"
        "              WHERE ${epochAdditionFits(NOW_MS, '?')}`,\n"
        "        args: [queue, driverId, ttlMs, ttlMs],\n"
        "      },\n"
        "    ])",
        "    await this.db.batch('driver-heartbeat', [\n"
        "      {\n"
        "        sql: `INSERT INTO drivers (queue, driver_id, last_beat_ms, expires_at_ms)\n"
        "              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?\n"
        "              WHERE ${epochAdditionFits(NOW_MS, '?')}\n"
        "              ON CONFLICT (queue, driver_id) DO UPDATE SET\n"
        "                last_beat_ms = excluded.last_beat_ms,\n"
        "                expires_at_ms = excluded.expires_at_ms`,\n"
        "        args: [queue, driverId, ttlMs, ttlMs],\n"
        "      },\n"
        "      {\n"
        "        sql: `DELETE FROM drivers\n"
        "              WHERE expires_at_ms < (SELECT d.last_beat_ms FROM drivers d\n"
        "                                     WHERE d.queue = ? AND d.driver_id = ?)\n"
        "                AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.drivers.last_beat_ms)}\n"
        "                AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.drivers.expires_at_ms)}\n"
        "                AND ${epochAdditionFits(NOW_MS, '?')}`,\n"
        "        args: [queue, driverId, ttlMs],\n"
        "      },\n"
        "    ])",
        "driver cleanup reads a second database instant after writing the heartbeat",
    ),
    (
        "complete-terminalization-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "             AND (t.state NOT IN ${LIVE}\n"
        "               OR (t.state IN ${LIVE} AND ${soleLiveRun('runs')}))\n"
        "         )`,\n"
        "      [resultJson, runId, queue, claimToken],",
        "             AND (t.state NOT IN ${LIVE}\n"
        "               OR (t.state IN ${LIVE} AND 1 = 1))\n"
        "         )`,\n"
        "      [resultJson, runId, queue, claimToken],",
        "complete terminalizes a task while another live run still owns it",
    ),
    (
        "fail-terminalization-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${soleLiveRun('runs')}\n"
        "                 AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "               OR (t.state IN ${LIVE}\n"
        "                 AND 1 = 1\n"
        "                 AND ${storedCurrentRunAccounting('runs', 't')}\n",
        "non-retrying failure terminalizes a task while another live run still owns it",
    ),
    (
        "relaunch-cap-terminalization-requires-sole-live-run",
        "packages/store-libsql/src/store.ts",
        "  `${storedSweepCounters(run)}\n"
        "   AND ${soleLiveRun(run)}\n"
        "   AND ${storedCurrentRunAccounting(run, task)}\n",
        "  `${storedSweepCounters(run)}\n"
        "   AND (${run}.relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}\n"
        "     OR ${soleLiveRun(run)})\n"
        "   AND ${storedCurrentRunAccounting(run, task)}\n",
        "a relaunch-cap sweep terminalizes a task while another live run still owns it",
    ),
    (
        "spawn-receipt-idempotency-priority-is-queue-scoped",
        "packages/store-libsql/src/store.ts",
        "         WHERE ? IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?\n"
        "           AND t.task_id <> ?\n",
        "         WHERE ? IS NOT NULL AND ? IS NOT NULL AND t.idempotency_key = ?\n"
        "           AND t.task_id <> ?\n",
        "spawn receipt lets a foreign-queue id collision outrank the same-queue idempotency winner",
    ),
    (
        "spawn-receipt-task-id-collision-is-queue-scoped",
        "packages/store-libsql/src/store.ts",
        "         FROM tasks t WHERE t.task_id = ? AND t.queue = ?\n",
        "         FROM tasks t WHERE t.task_id = ? AND ? IS NOT NULL\n",
        "spawn receipt returns a task-id collision owned by another queue",
    ),
    (
        "claim-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "    const claimedWait = registeredWait('runs')\n"
        "    // Eligibility belongs inside each ordered leg, BEFORE its limit. Filtering\n",
        "    const claimedWait = registeredWait('runs')\n"
        "    const runOwnedByTask = (run: string, task: string): string =>\n"
        "      `${task}.task_id = ${run}.task_id`\n"
        "    // Eligibility belongs inside each ordered leg, BEFORE its limit. Filtering\n",
        "claim treats a task id match as ownership after the immutable queues diverge",
    ),
    (
        "null-event-payload-never-becomes-timeout",
        "packages/store-libsql/src/store.ts",
        "       WHERE events.fence_stamp IS NOT ${STAMP}\n"
        "         AND typeof(events.payload) = 'text'\n"
        "         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`",
        "       WHERE events.fence_stamp IS NOT ${STAMP}\n"
        "         AND 1 = 1\n"
        "         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`",
        "emit launders a stored SQL NULL payload into an emitted timeout wake",
    ),
    (
        "sdk-owned-retry-attempt",
        "packages/sdk/src/run-worker.ts",
        "    const taskControls = createTaskControlScope()\n"
        "    const ctx = new ReplayContext(\n"
        "      store,\n"
        "      queue,\n"
        "      run,\n"
        "      checkpoints,\n"
        "      leaseLostSignal,\n"
        "      taskControls.issuer,\n"
        "      userAttempt,\n"
        "    )\n"
        "\n"
        "    async function recordUserFailure(error: unknown): Promise<WorkerOutcome> {\n"
        "      const thrown = snapshotTaskThrowable(error)\n"
        "      const decision = thrown.fatal\n"
        "        ? ({ retry: false } as const)\n"
        "        : decideRetry(claimedRun.retryStrategy, userAttempt, claimedRun.maxAttempts)\n",
        "    const taskControls = createTaskControlScope()\n"
        "    const ctx = new ReplayContext(\n"
        "      store,\n"
        "      queue,\n"
        "      run,\n"
        "      checkpoints,\n"
        "      leaseLostSignal,\n"
        "      taskControls.issuer,\n"
        "      userAttempt,\n"
        "    )\n"
        "    Object.defineProperty(ctx, 'attempt', { value: userAttempt, writable: true })\n"
        "\n"
        "    async function recordUserFailure(error: unknown): Promise<WorkerOutcome> {\n"
        "      const thrown = snapshotTaskThrowable(error)\n"
        "      const decision = thrown.fatal\n"
        "        ? ({ retry: false } as const)\n"
        "        : decideRetry(claimedRun.retryStrategy, ctx.attempt, claimedRun.maxAttempts)\n",
        "the retry decision trusts a user-mutable public context field",
    ),
    (
        "sdk-malformed-checkpoint-stops-pump",
        "packages/sdk/src/run-worker.ts",
        "  try {\n"
        "    let checkpoints: Awaited<ReturnType<SchedulerStore['getCheckpoints']>>\n"
        "    try {\n"
        "      checkpoints = await store.getCheckpoints(queue, run.taskId, run.attempt)\n"
        "    } catch (error) {\n"
        "      return trustedStoreOutcome(error)\n"
        "    }\n"
        "    const taskControls = createTaskControlScope()\n"
        "    const ctx = new ReplayContext(\n"
        "      store,\n"
        "      queue,\n"
        "      run,\n"
        "      checkpoints,\n"
        "      leaseLostSignal,\n"
        "      taskControls.issuer,\n"
        "      userAttempt,\n"
        "    )\n",
        "  let checkpoints: Awaited<ReturnType<SchedulerStore['getCheckpoints']>>\n"
        "  try {\n"
        "    checkpoints = await store.getCheckpoints(queue, run.taskId, run.attempt)\n"
        "  } catch (error) {\n"
        "    return trustedStoreOutcome(error)\n"
        "  }\n"
        "  const taskControls = createTaskControlScope()\n"
        "  const ctx = new ReplayContext(\n"
        "    store,\n"
        "    queue,\n"
        "    run,\n"
        "    checkpoints,\n"
        "    leaseLostSignal,\n"
        "    taskControls.issuer,\n"
        "    userAttempt,\n"
        "  )\n"
        "  try {\n",
        "checkpoint decoding can throw before the heartbeat pump enters its cleanup scope",
    ),
    (
        "sdk-subsecond-lease-upkeep-before-expiry",
        "packages/sdk/src/run-worker.ts",
        "  const leaseMs = run.leaseSeconds * 1000\n",
        "  const leaseMs = Math.max(run.leaseSeconds * 1000, 1_000)\n",
        "a legal sub-second lease waits until after expiry for its first upkeep",
    ),
    (
        "suspend-rejects-noninteger-attempt",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "         AND ${validCheckpointConflict('runs', '?')}\n"
        "         ${wakePlan.fits}`",
        "         AND 1 = 1\n"
        "         AND ${validCheckpointConflict('runs', '?')}\n"
        "         ${wakePlan.fits}`",
        "suspend parks a run whose durable attempt is not an integer",
    ),
    (
        "sweep-rejects-noninteger-attempt",
        "packages/store-libsql/src/store.ts",
        "      `UPDATE runs SET\n"
        "         state = 'failed', failed_at_ms = ${NOW}, claimed_by = NULL,\n"
        "         failure_reason = ?, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n"
        "           WHERE ${runOwnedByTask('runs', 't')}\n"
        "             AND ((t.state NOT IN ${LIVE}\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible('runs', 't')}\n",
        "      `UPDATE runs SET\n"
        "         state = 'failed', failed_at_ms = ${NOW}, claimed_by = NULL,\n"
        "         attempt = CAST(attempt AS INTEGER),\n"
        "         failure_reason = ?, ${FENCE_SET}\n"
        "       WHERE run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND EXISTS (\n"
        "           SELECT 1 FROM tasks t\n"
        "           WHERE ${runOwnedByTask('runs', 't')}\n"
        "             AND ((t.state NOT IN ${LIVE}\n"
        "                 AND ${sweepTerminalOwnerAdmissible('runs')})\n"
        "               OR (t.state IN ${LIVE}\n"
        "                 AND ${sweepLiveOwnerAdmissible('runs', 't')\n"
        "                   .replace(storedCurrentRunAccounting('runs', 't'), '1 = 1')\n"
        "                   .replace(storedHighestOwnedOrdinal('runs'), '1 = 1')\n"
        "                   .replace(\n"
        "                     `(${storedIncrementableInteger(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "           AND runs.attempt = t.attempts + t.infra_retries + 1)`,\n"
        "                     '1 = 1',\n"
        "                   )}\n",
        "the claim-timeout CAS launders a fractional attempt after bypassing all three independent attempt proofs",
    ),
    (
        "heartbeat-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "                AND EXISTS (SELECT 1 FROM tasks t\n"
        "                            WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})\n"
        "                AND ${epochAdditionFits(NOW_MS, '?')}\n",
        "                AND EXISTS (SELECT 1 FROM tasks t\n"
        "                            WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})\n"
        "                AND ${epochAdditionFits(NOW_MS, '?')}\n",
        "heartbeat extends a run after its task crosses the immutable queue boundary",
    ),
    (
        "reschedule-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedInteger('runs.attempt')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})\n",
        "         AND ${storedInteger('runs.attempt')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)})\n",
        "reschedule parks a run after its task crosses the immutable queue boundary",
    ),
    (
        "suspend-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE ${runOwnedByTask('runs', 't')} AND ${eligibleTask('t', NOW)})\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n",
        "       WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND ${eligibleTask('t', NOW)})\n"
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n",
        "suspend parks and checkpoints a run after its task crosses the immutable queue boundary",
    ),
    (
        "set-checkpoint-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})\n"
        "         AND ${validCheckpointConflict('runs', '?')}\n",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, 'runs')}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})\n"
        "         AND ${validCheckpointConflict('runs', '?')}\n",
        "setCheckpoint extends and writes through a run whose task crossed the immutable queue boundary",
    ),
    (
        "await-event-register-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "       WHERE NOT EXISTS (SELECT 1 FROM events WHERE queue = ? AND event_name = ?)\n"
        "         AND EXISTS (SELECT 1 FROM runs r\n"
        "                     JOIN tasks t ON ${runOwnedByTask('r', 't')}\n"
        "                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?\n",
        "       WHERE NOT EXISTS (SELECT 1 FROM events WHERE queue = ? AND event_name = ?)\n"
        "         AND EXISTS (SELECT 1 FROM runs r\n"
        "                     JOIN tasks t ON t.task_id = r.task_id\n"
        "                     WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?\n",
        "awaitEvent registers and parks after its task crosses the immutable queue boundary",
    ),
    (
        "emit-event-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "         AND ${fenced('events', thisEvent, b.fence('event'))}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE ${runOwnedByTask('runs', 't')} AND t.state IN ${LIVE})`,\n",
        "         AND ${fenced('events', thisEvent, b.fence('event'))}\n"
        "         AND EXISTS (SELECT 1 FROM tasks t\n"
        "                     WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})`,\n",
        "emitEvent wakes a run after its task crosses the immutable queue boundary",
    ),
    (
        "cancel-task-requires-run-task-queue-ownership",
        "packages/store-libsql/src/store.ts",
        "       WHERE task_id = ? AND queue = ? AND state IN ${LIVE} ${deadlineGuard}\n"
        "         AND ${taskOwnsEveryRun('tasks')}`",
        "       WHERE task_id = ? AND queue = ? AND state IN ${LIVE} ${deadlineGuard}\n"
        "         AND 1 = 1`",
        "cancelTask terminalizes a task while one of its runs belongs to another queue",
    ),
    (
        "generated-relation-queue-ownership",
        "packages/core/src/fenced-batch.ts",
        "    const queueOwnership = relation.queueScoped ? `f.queue = ${target}.queue AND ` : ''\n"
        "    const src = `${spec.where ? `(${spec.where}) AND ` : ''}${queueOwnership}`\n",
        "    const queueOwnership = ''\n"
        "    const src = `${spec.where ? `(${spec.where}) AND ` : ''}${queueOwnership}`\n",
        "generated cross-table relations can cross the immutable queue boundary in every direction",
    ),
    (
        "generated-runs-to-waits-authoritative-cleanup",
        "packages/core/src/contract.ts",
        "  'runs-to-waits': Object.freeze({\n"
        "    target: 'waits',\n"
        "    key: 'run_id',\n"
        "    from: 'runs',\n"
        "    column: 'run_id',\n"
        "    // A run is authoritative for cleaning up every wait that names it. The\n"
        "    // wait's queue is a denormalized witness and may itself be the corruption\n"
        "    // the terminal transition must remove.\n"
        "    queueScoped: false,\n"
        "  }),\n",
        "  'runs-to-waits': Object.freeze({\n"
        "    target: 'waits',\n"
        "    key: 'run_id',\n"
        "    from: 'runs',\n"
        "    column: 'run_id',\n"
        "    // A run is authoritative for cleaning up every wait that names it. The\n"
        "    // wait's queue is a denormalized witness and may itself be the corruption\n"
        "    // the terminal transition must remove.\n"
        "    queueScoped: true,\n"
        "  }),\n",
        "generated runs-to-waits cleanup incorrectly trusts the denormalized wait queue",
    ),
    (
        "generated-runs-to-tasks-queue-ownership",
        "packages/core/src/contract.ts",
        "  'runs-to-tasks': Object.freeze({\n"
        "    target: 'tasks',\n"
        "    key: 'task_id',\n"
        "    from: 'runs',\n"
        "    column: 'task_id',\n"
        "    queueScoped: true,\n"
        "  }),\n",
        "  'runs-to-tasks': Object.freeze({\n"
        "    target: 'tasks',\n"
        "    key: 'task_id',\n"
        "    from: 'runs',\n"
        "    column: 'task_id',\n"
        "    queueScoped: false,\n"
        "  }),\n",
        "generated runs-to-tasks updates can cross the immutable queue boundary",
    ),
    (
        "generated-tasks-to-runs-queue-ownership",
        "packages/core/src/contract.ts",
        "  'tasks-to-runs': Object.freeze({\n"
        "    target: 'runs',\n"
        "    key: 'task_id',\n"
        "    from: 'tasks',\n"
        "    column: 'task_id',\n"
        "    queueScoped: true,\n"
        "  }),\n",
        "  'tasks-to-runs': Object.freeze({\n"
        "    target: 'runs',\n"
        "    key: 'task_id',\n"
        "    from: 'tasks',\n"
        "    column: 'task_id',\n"
        "    queueScoped: false,\n"
        "  }),\n",
        "generated tasks-to-runs updates can cross the immutable queue boundary",
    ),
    (
        "generated-waits-to-runs-queue-ownership",
        "packages/core/src/contract.ts",
        "  'waits-to-runs': Object.freeze({\n"
        "    target: 'runs',\n"
        "    key: 'run_id',\n"
        "    from: 'waits',\n"
        "    column: 'run_id',\n"
        "    queueScoped: true,\n"
        "  }),\n",
        "  'waits-to-runs': Object.freeze({\n"
        "    target: 'runs',\n"
        "    key: 'run_id',\n"
        "    from: 'waits',\n"
        "    column: 'run_id',\n"
        "    queueScoped: false,\n"
        "  }),\n",
        "generated waits-to-runs updates can cross the immutable queue boundary",
    ),
]


CHECKPOINT_CONFLICT_CONSUMERS = (
    (
        "checkpoint-write",
        "\n"
        "         AND ${epochAdditionFits(NOW, '?')}`,\n"
        "      [extendMs, runId, queue, taskId, claimToken, checkpointName, extendMs],",
    ),
    (
        "suspend",
        "\n"
        "         ${wakePlan.fits}`,\n"
        "      [\n"
        "        wakePlan.argument,\n"
        "        wakePlan.argument,",
    ),
)


def weakened_checkpoint_conflict(suffix: str) -> str:
    base = "validCheckpointConflict('runs', '?')"
    replacements = {
        "exists": (
            f"{base}.replace(\n"
            "           'AND NOT (',\n"
            "           \"AND c.owner_run_id <> 'owner-missing-owner' AND NOT (\",\n"
            "         )"
        ),
        "owner-id": (
            f"{base}.replace(\n"
            "           'AND owner.run_id = c.owner_run_id',\n"
            "           'AND 1 = 1',\n"
            "         )"
        ),
        "owner-task": (
            f"{base}.replace(\n"
            "           'AND owner.task_id = c.task_id',\n"
            "           'AND 1 = 1',\n"
            "         )"
        ),
        "owner-queue": (
            f"{base}.replace(\n"
            "           'AND owner.queue = c.queue',\n"
            "           'AND 1 = 1',\n"
            "         )"
        ),
        "owner-attempt": (
            f"{base}.replace(\n"
            "           'AND owner.attempt = c.owner_attempt',\n"
            "           'AND 1 = 1',\n"
            "         )"
        ),
        "owner-attempt-upper": (
            f"{base}.replace(\n"
            "           `c.owner_attempt BETWEEN ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.min} AND ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.max}`,\n"
            "           `c.owner_attempt >= ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.min}`,\n"
            "         )"
        ),
        "owner-attempt-lower": (
            f"{base}.replace(\n"
            "           `c.owner_attempt BETWEEN ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.min} AND ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.max}`,\n"
            "           `c.owner_attempt <= ${CHECKPOINT_INTEGER_BOUNDS.owner_attempt.max}`,\n"
            "         )"
        ),
        "owner-attempt-storage": (
            f"{base}.replace("
            "\"typeof(c.owner_attempt) = 'integer'\", "
            "'c.owner_attempt IS NOT NULL'"
            ")"
        ),
        "conflict-queue": (
            f"{base}.replace(\n"
            "           'c.queue = runs.queue',\n"
            "           '1 = 1',\n"
            "         )"
        ),
    }
    return replacements[suffix]


CHECKPOINT_CONFLICT_SUFFIXES = (
    "exists",
    "owner-id",
    "owner-task",
    "owner-queue",
    "owner-attempt",
    "owner-attempt-upper",
    "owner-attempt-lower",
    "owner-attempt-storage",
    "conflict-queue",
)

for consumer, tail_anchor in CHECKPOINT_CONFLICT_CONSUMERS:
    for suffix in CHECKPOINT_CONFLICT_SUFFIXES:
        MUTATION_SPECS.append(
            (
                f"{consumer}-validates-existing-lww-owner-{suffix}",
                "packages/store-libsql/src/store.ts",
                "         AND ${validCheckpointConflict('runs', '?')}"
                f"{tail_anchor}",
                "         AND ${"
                f"{weakened_checkpoint_conflict(suffix)}"
                "}"
                f"{tail_anchor}",
                f"{consumer} accepts an existing checkpoint with invalid {suffix} ownership",
            )
        )


TIME_BOUNDARY_SOURCE = "packages/conformance/src/time-boundaries.ts"
TIME_BOUNDARY_TEST = "packages/conformance/test/libsql.test.ts"


def weakened_epoch_addition(call: str) -> str:
    """Keep every bind while changing bounded headroom into excess headroom."""
    return f'{call}.replace(" - ", " + ")'


RELATIVE_WAKE_EXPRESSION = "${wakePlan.expression}"


def exact_epoch_ceiling_replacement(
    anchor: str, expression: str, *, relative_wake: bool
) -> str:
    """Cap only an exact legal epoch result while preserving every smaller value."""
    capped = f"MIN({expression}, ${{DERIVED_INTEGER_BOUNDS.epoch_ms.max - 1}})"
    if relative_wake:
        wake_plan = "    const wakePlan = prepareWake(wake, relativeWake)\n"
        if anchor.count(wake_plan) != 1:
            raise ValueError("relative wake exact-ceiling anchor must own one wake plan")
        return anchor.replace(
            wake_plan,
            wake_plan
            + "    if (relativeWake) {\n"
            + f"      wakePlan.expression = `{capped}`\n"
            + "    }\n",
            1,
        )
    if anchor.count(expression) != 1:
        raise ValueError("exact-ceiling anchor must own one persisted expression")
    return anchor.replace(expression, capped, 1)


TIMESTAMP_ADDITION_CASES = (
    (
        "spawn-enqueue",
        "spawn enqueue deadline",
        "         AND ${epochAdditionFits(NOW, '?')}\n"
        "         AND (? IS NULL OR ${epochAdditionFits(NOW, '?', '?')})",
        "epochAdditionFits(NOW, '?')",
        "       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ${NOW} + ?,\n",
        "${NOW} + ?",
    ),
    (
        "spawn-cancellation",
        "spawn cancellation deadline",
        "         AND ${epochAdditionFits(NOW, '?')}\n"
        "         AND (? IS NULL OR ${epochAdditionFits(NOW, '?', '?')})",
        "epochAdditionFits(NOW, '?', '?')",
        "         CASE WHEN ? IS NOT NULL THEN ${NOW} + ? + ? ELSE NULL END,\n",
        "${NOW} + ? + ?",
    ),
    (
        "claim-lease",
        "claim lease deadline",
        "       AND ${epochAdditionFits(NOW, '?')}`,\n"
        "      [\n"
        "        claimToken,",
        "epochAdditionFits(NOW, '?')",
        "         claim_expires_at_ms = ${NOW} + ?,\n"
        "         heartbeat_at_ms = ${NOW},\n"
        "         wake_step = COALESCE(wake_step, ${claimedWait.step}),",
        "${NOW} + ?",
    ),
    (
        "activation-lease",
        "activation lease deadline",
        "         AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.lease_ms, 'runs')}\n"
        "         AND ${epochAdditionFits(NOW, 'runs.lease_ms')}",
        "epochAdditionFits(NOW, 'runs.lease_ms')",
        "         claim_expires_at_ms = ${NOW} + lease_ms,\n"
        "         heartbeat_at_ms = ${NOW},",
        "${NOW} + lease_ms",
    ),
    (
        "activation-max-duration",
        "activation max-duration deadline",
        "    WHEN NOT ${epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)} THEN 0",
        "epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)",
        "            COALESCE(first_started_at_ms, ${activated}) + ${taskMaxDurationMs('tasks')}\n",
        "COALESCE(first_started_at_ms, ${activated}) + ${taskMaxDurationMs('tasks')}",
    ),
    (
        "heartbeat-lease",
        "heartbeat lease deadline",
        "                AND ${epochAdditionFits(NOW_MS, '?')}\n"
        "              RETURNING claim_expires_at_ms - heartbeat_at_ms AS remaining_ms",
        "epochAdditionFits(NOW_MS, '?')",
        "                claim_expires_at_ms = ${NOW_MS} + ?,\n"
        "                heartbeat_at_ms = ${NOW_MS}",
        "${NOW_MS} + ?",
    ),
    (
        "lost-launch-relaunch",
        "lost-launch relaunch deadline",
        "         AND ${liveOwner}\n"
        "         AND ${epochAdditionFits(NOW, relaunchDelayMs)}`",
        "epochAdditionFits(NOW, relaunchDelayMs)",
        "         available_at_ms = ${NOW} + ${relaunchDelayMs},\n",
        "${NOW} + ${relaunchDelayMs}",
    ),
    (
        "claim-timeout-successor",
        "claim-timeout successor deadline",
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))",
        "epochAdditionFits(NOW, infraDelayMs)",
        "              f.fence_at_ms + ${infraDelayMs},\n",
        "f.fence_at_ms + ${infraDelayMs}",
    ),
    (
        "driver-heartbeat",
        "driver heartbeat deadline",
        "              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?\n"
        "              WHERE ${epochAdditionFits(NOW_MS, '?')}`",
        "epochAdditionFits(NOW_MS, '?')",
        "              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?\n",
        "${NOW_MS} + ?",
    ),
    (
        "reschedule-wake",
        "reschedule wake deadline",
        "         ${wakePlan.fits}`,\n"
        "      [\n"
        "        wakePlan.argument,\n"
        "        wakePlan.argument,\n"
        "        wakeDisposition,",
        "wakePlan.fits",
        "    const relativeWake = wakeHasOwn(wake, 'inSeconds')\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    // ONE SQL shape for both dispositions",
        RELATIVE_WAKE_EXPRESSION,
    ),
    (
        "suspend-wake",
        "suspend wake deadline",
        "         ${wakePlan.fits}`,\n"
        "      [\n"
        "        wakePlan.argument,\n"
        "        wakePlan.argument,\n"
        "        runId,",
        "wakePlan.fits",
        "    const relativeWake = wakeHasOwn(wake, 'inSeconds')\n"
        "    const wakePlan = prepareWake(wake, relativeWake)\n"
        "    const b = new FencedBatch('suspend'",
        RELATIVE_WAKE_EXPRESSION,
    ),
    (
        "user-retry-successor",
        "user-retry successor deadline",
        "        : `AND ((runs.attempt - t.infra_retries) >= t.max_attempts\n"
        "          OR ${epochAdditionFits(NOW, '?')})`",
        "epochAdditionFits(NOW, '?')",
        "                f.fence_at_ms + ?,\n",
        "f.fence_at_ms + ?",
    ),
    (
        "checkpoint-lease",
        "checkpoint lease deadline",
        "         AND ${validCheckpointConflict('runs', '?')}\n"
        "         AND ${epochAdditionFits(NOW, '?')}`",
        "epochAdditionFits(NOW, '?')",
        "         claim_expires_at_ms = ${NOW} + ?, heartbeat_at_ms = ${NOW}, ${FENCE_SET}\n",
        "${NOW} + ?",
    ),
    (
        "event-timeout",
        "event timeout deadline",
        "         AND (? IS NULL OR ${epochAdditionFits(NOW, '?')})\n"
        "       ON CONFLICT (run_id, step_name) DO NOTHING",
        "epochAdditionFits(NOW, '?')",
        "         CASE WHEN ? IS NOT NULL THEN ${NOW} + ? ELSE NULL END, ${NOW}, ${FENCE_VALS}\n",
        "${NOW} + ?",
    ),
)

DRIVER_HEARTBEAT_STATEMENT = (
    "        sql: `INSERT INTO ${DRIVER_HEARTBEAT_INGRESS}\n"
    "                (queue, driver_id, last_beat_ms, expires_at_ms)\n"
    "              SELECT ?, ?, ${NOW_MS}, ${NOW_MS} + ?\n"
    "              WHERE ${epochAdditionFits(NOW_MS, '?')}`,\n"
)

DRIVER_HEARTBEAT_BATCH = (
    "    await this.db.batch('driver-heartbeat', [\n"
    "      {\n"
    + DRIVER_HEARTBEAT_STATEMENT
    + "        args: [queue, driverId, ttlMs, ttlMs],\n"
    "      },\n"
    "    ])"
)


def driver_cleanup_bound_mutation(omit: str) -> str:
    """Add a source-proven mutation-only cleanup without editing frozen DDL."""
    last_beat_guard = (
        "                AND typeof(last_beat_ms) = 'integer'\n"
        "                AND last_beat_ms BETWEEN 0 AND ${MAX_EPOCH_MS}\n"
    )
    expiry_guard = (
        "                AND typeof(expires_at_ms) = 'integer'\n"
        "                AND expires_at_ms BETWEEN 0 AND ${MAX_EPOCH_MS}`\n"
    )
    if omit == "last-beat":
        last_beat_guard = "                AND 1 = 1\n"
    elif omit == "expiry":
        expiry_guard = "                AND 1 = 1`\n"
    else:
        raise ValueError(f"unknown driver cleanup bound {omit!r}")
    return (
        "    await this.db.batch('driver-heartbeat', [\n"
        "      {\n"
        + DRIVER_HEARTBEAT_STATEMENT
        + "        args: [queue, driverId, ttlMs, ttlMs],\n"
        "      },\n"
        "      ...(ttlMs === 1\n"
        "        ? [\n"
        "            {\n"
        "              sql: `DELETE FROM drivers\n"
        "              WHERE queue = ? AND driver_id <> ?\n"
        "                AND expires_at_ms < (\n"
        "                  SELECT source.last_beat_ms FROM drivers source\n"
        "                  WHERE source.queue = ? AND source.driver_id = ?\n"
        "                    AND source.expires_at_ms = source.last_beat_ms + ?\n"
        "                )\n"
        + last_beat_guard
        + expiry_guard
        + "              args: [queue, driverId, queue, driverId, ttlMs],\n"
        "            },\n"
        "          ]\n"
        "        : []),\n"
        "    ])"
    )


def weakened_driver_heartbeat_for_source(exists: bool) -> str:
    """Admit overflow for exactly one ownership class without collateral credit."""
    existence = "EXISTS" if exists else "NOT EXISTS"
    return (
        "        sql: `INSERT INTO ${DRIVER_HEARTBEAT_INGRESS}\n"
        "                (queue, driver_id, last_beat_ms, expires_at_ms)\n"
        "              WITH heartbeat(queue, driver_id) AS (VALUES (?, ?))\n"
        "              SELECT heartbeat.queue, heartbeat.driver_id, ${NOW_MS}, ${NOW_MS} + ?\n"
        "              FROM heartbeat\n"
        "              WHERE ${epochAdditionFits(NOW_MS, '?')}\n"
        f"                 OR {existence} (\n"
        "                   SELECT 1 FROM drivers d\n"
        "                   WHERE d.queue = heartbeat.queue\n"
        "                     AND d.driver_id = heartbeat.driver_id\n"
        "                 )`,\n"
    )


for slug, title, guard_anchor, guard_call, exact_find, exact_expression in (
    TIMESTAMP_ADDITION_CASES
):
    overflow_find = guard_anchor
    overflow_replace = guard_anchor.replace(
        guard_call, weakened_epoch_addition(guard_call), 1
    )
    if slug == "driver-heartbeat":
        overflow_find = DRIVER_HEARTBEAT_STATEMENT
        overflow_replace = weakened_driver_heartbeat_for_source(False)
    exact_replace = exact_epoch_ceiling_replacement(
        exact_find,
        exact_expression,
        relative_wake=exact_expression == RELATIVE_WAKE_EXPRESSION,
    )
    MUTATION_SPECS.extend(
        (
            (
                f"timestamp-addition-{slug}-overflow",
                "packages/store-libsql/src/store.ts",
                overflow_find,
                overflow_replace,
                f"{title} persists a derived epoch above the maximum",
            ),
            (
                f"timestamp-addition-{slug}-exact",
                "packages/store-libsql/src/store.ts",
                exact_find,
                exact_replace,
                f"{title} persists an off-by-one result at the exact epoch ceiling",
            ),
        )
    )


TIMESTAMP_BEHAVIOR_MUTATIONS = (
    (
        "timestamp-terminal-relaunch-cap-at-max",
        "packages/store-libsql/src/store.ts",
        "       WHERE ${guard} AND relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}\n"
        "         AND (${liveOwner} OR ${terminalOwner})",
        "       WHERE ${guard} AND relaunch_count = ${RUN_INTEGER_BOUNDS.relaunch_count.max}\n"
        "         AND (${liveOwner} OR ${terminalOwner})\n"
        "         AND ${epochAdditionFits(NOW, relaunchDelayMs)}",
        "allows the relaunch-cap terminal arm at the epoch ceiling",
        "the terminal relaunch-cap arm is incorrectly gated by unused deadline headroom",
    ),
    (
        "timestamp-terminal-infra-cap-at-max",
        "packages/store-libsql/src/store.ts",
        "                 AND (t.infra_retries = ${TASK_INTEGER_BOUNDS.infra_retries.max}\n"
        "                   OR ${epochAdditionFits(NOW, infraDelayMs)})))",
        "                 AND (${epochAdditionFits(NOW, infraDelayMs)})))",
        "allows the infra-cap terminal arm at the epoch ceiling while preserving a below-cap successor",
        "the infrastructure-cap terminal arm loses its successor-headroom bypass",
    ),
    (
        "timestamp-terminal-user-failure-at-max",
        "packages/store-libsql/src/store.ts",
        "        : `AND ((runs.attempt - t.infra_retries) >= t.max_attempts\n"
        "          OR ${epochAdditionFits(NOW, '?')})`",
        "        : `AND ${epochAdditionFits(NOW, '?')}`",
        "allows exhausted-budget terminal user failure at the epoch ceiling and its predecessor",
        "exhausted-budget terminal user failure loses its successor-headroom bypass",
    ),
    (
        "timestamp-activation-existing-first-start-at-max",
        "packages/store-libsql/src/store.ts",
        "    WHEN NOT ${epochAdditionFits(`COALESCE(${firstStarted}, ${at})`, durationMs)} THEN 0",
        "    WHEN NOT (\n"
        "      (${firstStarted} IS NULL OR ${storedIntegerWithin(TASK_INTEGER_BOUNDS.first_started_at_ms, task)})\n"
        "      AND ${epochAdditionFits(at, durationMs)}\n"
        "    ) THEN 0",
        "uses an existing first-start instant for max-duration on reactivation",
        "reactivation validates the persisted first start but checks duration headroom from now",
    ),
    (
        "timestamp-claim-pending-lower-before-limit",
        "packages/store-libsql/src/store.ts",
        "             WHERE r.queue = ? AND r.state = 'pending'\n"
        "               AND ${runAvailableDue('r', NOW)}",
        "             WHERE r.queue = ? AND r.state = 'pending'\n"
        '               AND ${runAvailableDue(\'r\', NOW).replace(" BETWEEN 0 AND ", " <= ")}',
        "skips a negative pending availability before the claim limit",
        "a negative pending availability consumes the bounded claim shortlist",
    ),
    (
        "timestamp-claim-sleeping-timeout-lower-before-limit",
        "packages/store-libsql/src/store.ts",
        "               AND (${run}.wake_step IS NOT NULL OR ${wait.unambiguous})\n"
        "               AND ${wait.temporallySafe}\n",
        "               AND (${run}.wake_step IS NOT NULL OR ${wait.unambiguous})\n"
        "               AND 1 = 1\n",
        "skips a negative wait timeout before the sleeping claim limit",
        "a sleeping run with an invalid timed wait consumes the bounded claim shortlist",
    ),
    (
        "timestamp-claim-cancellation-upper-before-limit",
        "packages/store-libsql/src/fragments.ts",
        "export const eligibleTask = (t: string, at: string): string =>\n"
        "  `${t}.state IN ${LIVE} AND ${cancelNotDue(t, at)}`",
        "export const eligibleTask = (t: string, at: string): string =>\n"
        '  `${t}.state IN ${LIVE} AND ${cancelNotDue(t, at).replace(/ BETWEEN 0 AND [0-9]+/, " >= 0")}`',
        "skips an out-of-range cancellation deadline before the claim limit",
        "an oversized cancellation deadline remains claim-eligible",
    ),
    (
        "timestamp-sweep-lost-launch-lower-before-limit",
        "packages/store-libsql/src/store.ts",
        "  AND ${runClaimExpired('r', NOW_MS)}\n"
        "  AND ${sweepScanAdmissible('r', 't')}",
        "  AND (${runClaimExpired('r', NOW_MS)}\n"
        "    OR (r.claim_expires_at_ms < 0 AND r.activated_gen < r.claim_gen))\n"
        "  AND ${sweepScanAdmissible('r', 't')}",
        "lost-launch sweep skips a negative claim expiry before its limit",
        "a negative lost-launch expiry consumes the bounded sweep scan",
    ),
    (
        "timestamp-sweep-timeout-lower-before-limit",
        "packages/store-libsql/src/store.ts",
        "  AND ${runClaimExpired('r', NOW_MS)}\n"
        "  AND ${sweepScanAdmissible('r', 't')}",
        "  AND (${runClaimExpired('r', NOW_MS)}\n"
        "    OR (r.claim_expires_at_ms < 0 AND r.activated_gen = r.claim_gen))\n"
        "  AND ${sweepScanAdmissible('r', 't')}",
        "claim-timeout sweep skips a negative claim expiry before its limit",
        "a negative activated expiry consumes the bounded sweep scan",
    ),
    (
        "timestamp-sweep-lost-launch-rechecks-expiry-bound",
        "packages/store-libsql/src/store.ts",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        "                   AND activated_gen < claim_gen AND ${runClaimExpired('runs', NOW)}`",
        "    const guard = `run_id = ? AND queue = ? AND state = 'running' AND claim_gen = ?\n"
        '                   AND activated_gen < claim_gen AND ${runClaimExpired(\'runs\', NOW).replace(" BETWEEN 0 AND ", " <= ")}`',
        "lost-launch sweep rechecks the claim expiry bound after discovery",
        "the lost-launch CAS accepts a negative expiry after its advisory scan",
    ),
    (
        "timestamp-sweep-timeout-rechecks-expiry-bound",
        "packages/store-libsql/src/store.ts",
        "         AND activated_gen = claim_gen AND ${runClaimExpired('runs', NOW)}\n"
        "         AND EXISTS (",
        '         AND activated_gen = claim_gen AND ${runClaimExpired(\'runs\', NOW).replace(" BETWEEN 0 AND ", " <= ")}\n'
        "         AND EXISTS (",
        "claim-timeout sweep rechecks the claim expiry bound after discovery",
        "the claim-timeout CAS accepts a negative expiry after its advisory scan",
    ),
    (
        "timestamp-next-wake-pending-lower",
        "packages/store-libsql/src/store.ts",
        "    WHERE r.queue = ? AND r.state = 'pending'\n"
        "      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}",
        "    WHERE r.queue = ? AND r.state = 'pending'\n"
        '      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, \'r\').replace(" BETWEEN 0 AND ", " <= ")}',
        "nextWakeAt skips a negative pending availability",
        "nextWakeAt reports a negative pending availability",
    ),
    (
        "timestamp-next-wake-sleeping-lower",
        "packages/store-libsql/src/store.ts",
        "    WHERE r.queue = ? AND r.state = 'sleeping'\n"
        "      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, 'r')}",
        "    WHERE r.queue = ? AND r.state = 'sleeping'\n"
        '      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.available_at_ms, \'r\').replace(" BETWEEN 0 AND ", " <= ")}',
        "nextWakeAt skips a negative sleeping availability",
        "nextWakeAt reports a negative sleeping availability",
    ),
    (
        "timestamp-next-wake-expiry-lower",
        "packages/store-libsql/src/store.ts",
        "    WHERE r.queue = ? AND r.state = 'running'\n"
        "      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.claim_expires_at_ms, 'r')}",
        "    WHERE r.queue = ? AND r.state = 'running'\n"
        '      AND ${storedIntegerWithin(RUN_INTEGER_BOUNDS.claim_expires_at_ms, \'r\').replace(" BETWEEN 0 AND ", " <= ")}',
        "nextWakeAt skips a negative running claim expiry",
        "nextWakeAt reports a negative running claim expiry",
    ),
    (
        "timestamp-next-wake-cancel-lower",
        "packages/store-libsql/src/store.ts",
        "    WHERE t.queue = ? AND t.state IN ${LIVE}\n"
        "      AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.cancel_at_ms, 't')}",
        "    WHERE t.queue = ? AND t.state IN ${LIVE}\n"
        '      AND ${storedIntegerWithin(TASK_INTEGER_BOUNDS.cancel_at_ms, \'t\').replace(" BETWEEN 0 AND ", " <= ")}',
        "nextWakeAt skips a negative cancellation deadline",
        "nextWakeAt reports a negative cancellation deadline",
    ),
    (
        "timestamp-expire-lease-validates-expiry-upper",
        "packages/store-libsql/src/store.ts",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS)\n",
        "    const unexpired = runClaimUnexpired('runs', NOW_MS).replace(\n"
        '      / BETWEEN 0 AND [0-9]+/, " >= 0",\n'
        "    )\n",
        "expireLeaseNow refuses to launder an out-of-range stored expiry",
        "expireLeaseNow launders an oversized expiry into a valid instant",
    ),
    (
        "timestamp-emit-validates-timed-wait-lower",
        "packages/store-libsql/src/store.ts",
        "    const runWait = registeredWait('runs')\n",
        "    const runWait = registeredWait('runs')\n"
        '    runWait.current = runWait.current.replaceAll(" BETWEEN 0 AND ", " <= ")\n'
        '    runWait.step = runWait.step.replaceAll(" BETWEEN 0 AND ", " <= ")\n',
        "emit skips an invalid timed wait while delivering a healthy peer",
        "emit consumes a timed wait whose run and registration carry invalid epochs",
    ),
    (
        "timestamp-driver-cleanup-requires-last-beat-bound",
        "packages/store-libsql/src/store.ts",
        DRIVER_HEARTBEAT_BATCH,
        driver_cleanup_bound_mutation("last-beat"),
        "driver cleanup refuses an expired row with an invalid last beat",
        "driver cleanup deletes an expired row whose last beat is invalid",
    ),
    (
        "timestamp-driver-cleanup-requires-expiry-bound",
        "packages/store-libsql/src/store.ts",
        DRIVER_HEARTBEAT_BATCH,
        driver_cleanup_bound_mutation("expiry"),
        "driver cleanup refuses a row with an invalid expiry",
        "driver cleanup deletes a row whose expiry is invalid",
    ),
    (
        "timestamp-driver-heartbeat-overflow-preserves-cleanup-inputs",
        "packages/store-libsql/src/store.ts",
        DRIVER_HEARTBEAT_STATEMENT,
        weakened_driver_heartbeat_for_source(True),
        "driver-heartbeat overflow preserves its source and expired cleanup victim",
        "an overflowed heartbeat still cleans rows using a source beat it did not write",
    ),
    (
        "timestamp-activation-validates-stored-duration-lower",
        "packages/store-libsql/src/store.ts",
        "    WHEN (${seconds}) < 0 OR (${durationMs}) > ${MAX_DURATION_MS} THEN 0",
        "    WHEN 0 = 1 OR (${durationMs}) > ${MAX_DURATION_MS} THEN 0",
        "activation refuses a negative stored max-duration atomically",
        "activation consumes a negative persisted max-duration",
    ),
    (
        "timestamp-activation-validates-stored-duration-upper",
        "packages/store-libsql/src/store.ts",
        "    WHEN (${seconds}) < 0 OR (${durationMs}) > ${MAX_DURATION_MS} THEN 0",
        "    WHEN (${seconds}) < 0 OR 0 = 1 THEN 0",
        "activation refuses a stored max-duration above the duration bound atomically",
        "activation consumes a persisted max-duration above its protocol ceiling",
    ),
    (
        "timestamp-activation-validates-stored-duration-storage",
        "packages/store-libsql/src/store.ts",
        "    WHEN json_type(${cancellation}, ${path}) NOT IN ('integer','real') THEN 0",
        "    WHEN json_type(${cancellation}, ${path}) NOT IN ('integer','real','text') THEN 0",
        "activation refuses a coercible string max-duration atomically",
        "activation coerces a string max-duration across the JSON boundary",
    ),
    (
        "timestamp-activation-rounded-duration-max",
        "packages/store-libsql/src/store.ts",
        "    WHEN (${seconds}) < 0 OR (${durationMs}) > ${MAX_DURATION_MS} THEN 0",
        "    WHEN (${seconds}) < 0 OR (${seconds}) > ${MAX_DURATION_MS / 1000} THEN 0",
        "accepts a max-duration just above the seconds ceiling when it rounds to the ms ceiling",
        "activation checks raw seconds instead of the canonical rounded millisecond duration",
    ),
    (
        "timestamp-emit-validates-existing-emitted-lower",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`",
        '         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, \'events\').replace(" BETWEEN 0 AND ", " <= ")}`',
        "re-emission refuses to propagate a negative stored event instant",
        "re-emission propagates a negative stored event instant",
    ),
    (
        "timestamp-emit-validates-existing-emitted-upper",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`",
        '         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, \'events\').replace(/ BETWEEN 0 AND [0-9]+/, " >= 0")}`',
        "re-emission refuses to propagate an event instant above the epoch bound",
        "re-emission propagates an oversized stored event instant",
    ),
    (
        "timestamp-emit-preserves-existing-emitted-max",
        "packages/store-libsql/src/store.ts",
        "         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, 'events')}`",
        '         AND ${storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.events.emitted_at_ms, \'events\').replace(" BETWEEN 0 AND ", " BETWEEN 0 AND -1 + ")}`',
        "re-emission preserves and propagates a valid event instant at the epoch ceiling",
        "re-emission rejects the maximum valid stored event instant",
    ),
    (
        "timestamp-boundary-oracle-rejects-text",
        TIME_BOUNDARY_SOURCE,
        "  const decoded = decodeBoundedInteger(value, { min: 0, max: MAX_EPOCH_MS })",
        "  const decoded = decodeBoundedInteger(typeof value === 'string' ? Number(value) : value, {\n"
        "    min: 0,\n"
        "    max: MAX_EPOCH_MS,\n"
        "  })",
        "the boundary oracle rejects parseable timestamp text",
        "the timestamp oracle coerces parseable text",
    ),
    (
        "timestamp-boundary-oracle-rejects-fractional",
        TIME_BOUNDARY_SOURCE,
        "  const decoded = decodeBoundedInteger(value, { min: 0, max: MAX_EPOCH_MS })",
        "  const decoded = decodeBoundedInteger(\n"
        "    typeof value === 'number' ? Math.trunc(value) : value,\n"
        "    { min: 0, max: MAX_EPOCH_MS },\n"
        "  )",
        "the boundary oracle rejects a fractional timestamp number",
        "the timestamp oracle truncates a fractional number",
    ),
    (
        "timestamp-cancel-lower-before-limit",
        "packages/store-libsql/src/store.ts",
        "WHERE t.queue = ? AND ${cancelDue('t', NOW_MS)}\n"
        "  AND t.state IN ${LIVE}",
        'WHERE t.queue = ? AND ${cancelDue(\'t\', NOW_MS).replace(" BETWEEN 0 AND ", " <= ")}\n'
        "  AND t.state IN ${LIVE}",
        "deadline cancellation skips a negative deadline before its limit",
        "a negative cancellation deadline consumes the bounded sweep scan",
    ),
    (
        "timestamp-cancel-rechecks-deadline-bound",
        "packages/store-libsql/src/store.ts",
        "    const deadlineGuard = deadlineOnly ? `AND ${cancelDue('tasks', NOW)}` : ''",
        '    const deadlineGuard = deadlineOnly\n'
        '      ? `AND ${cancelDue(\'tasks\', NOW).replace(" BETWEEN 0 AND ", " <= ")}`\n'
        "      : ''",
        "deadline cancellation rechecks its bound after discovery",
        "the cancellation CAS accepts a negative deadline after its advisory scan",
    ),
)

for name, file, find, replace, full_name, breaks in TIMESTAMP_BEHAVIOR_MUTATIONS:
    MUTATION_SPECS.append((name, file, find, replace, breaks))

MUTATION_SPECS.extend(
    (
        (
            "storage-corruption-requires-statement",
            "packages/conformance/src/fixture.ts",
            "  if (attempt.statements.length === 0) {\n"
            "    throw new Error('storage corruption attempt must contain at least one SQL statement')\n"
            "  }",
            "  if (false && attempt.statements.length === 0) {\n"
            "    throw new Error('storage corruption attempt must contain at least one SQL statement')\n"
            "  }",
            "a fixture can claim structural rejection without naming a storage write",
        ),
        (
            "storage-corruption-rejection-requires-observed-attempt",
            "packages/conformance/src/fixture.ts",
            "    results = await fixture.raw.batch('fixture:storage-corrupt', attempt.statements, 'write')",
            "    return 'structurally-rejected'",
            "a fixture can claim structural rejection without calling the real raw executor",
        ),
        (
            "temporal-field-id-is-bounds-field",
            "packages/core/src/validate.ts",
            "  persistedTemporalField(\n"
            "    'tasks',\n"
            "    'enqueue_at_ms',\n"
            "    PERSISTED_INTEGER_BOUNDS.tasks.enqueue_at_ms,\n"
            "    'epoch-ms',\n"
            "    false,\n"
            "  ),",
            "  freeze({\n"
            "    id: 'enqueue_at_ms',\n"
            "    table: 'tasks',\n"
            "    column: 'enqueue_at_ms',\n"
            "    bounds: PERSISTED_INTEGER_BOUNDS.tasks.enqueue_at_ms,\n"
            "    kind: 'epoch-ms',\n"
            "    nullable: false,\n"
            "  }),",
            "the tasks.enqueue_at_ms temporal descriptor uses its unqualified column spelling instead of its nominal bounds identity",
        ),
        (
            "migrated-integer-inventory-complete",
            "packages/store-libsql/test/schema.test.ts",
            "          .filter((row) => String(row.type).toUpperCase() === 'INTEGER')",
            "          .filter(\n"
            "            (row) =>\n"
            "              String(row.type).toUpperCase() === 'INTEGER' &&\n"
            "              String(row.name).endsWith('_ms'),\n"
            "          )",
            "schema enrollment regresses to the _ms spelling proxy and omits persisted counters",
        ),
        (
            "invariant-snapshot-table-identity",
            "packages/conformance/src/invariants.ts",
            "    rowsByTable.set(table, result.rows)",
            "    rowsByTable.set(\n"
            "      (['tasks', 'runs', 'checkpoints', 'events', 'waits', 'drivers'] as const)[\n"
            "        resultIndex\n"
            "      ] || table,\n"
            "      result.rows,\n"
            "    )",
            "the invariant snapshot binder rebinds supplied projections through a second positional table list",
        ),
        (
            "timestamp-boundary-enrollment",
            "packages/conformance/src/store-conformance.ts",
            "  { id: 'timestamp-boundaries', run: timestampBoundaryConformance },\n",
            "",
            "a dialect silently drops timestamp boundary conformance",
        ),
        (
            "admin-fake-now-invalid",
            "packages/store-libsql/src/admin.ts",
            "    const validEpochMs = requireEpochMs('epochMs', epochMs)",
            "    let validEpochMs = epochMs\n"
            "    if (epochMs !== -1) {\n"
            "      validEpochMs = requireEpochMs('epochMs', epochMs)\n"
            "    }",
            "the fake engine clock accepts the immediate negative predecessor to the epoch domain",
        ),
        (
            "admin-fake-now-exact-endpoints",
            "packages/store-libsql/src/admin.ts",
            "    const validEpochMs = requireEpochMs('epochMs', epochMs)",
            "    const validEpochMs = requireEpochMs('epochMs', epochMs === 0 ? -1 : epochMs)",
            "the fake engine clock rejects an exact legal epoch endpoint",
        ),
        (
            "nightly-fuzz-plan-exact-coverage",
            "packages/conformance/test/fuzz-shard-runner.ts",
            "  for (let seed = shard + batch * shardCount; seed < totalSeeds; seed += shardCount * batchCount) {",
            "  for (\n"
            "    let seed = shard + (batch + Number(batch === 1)) * shardCount;\n"
            "    seed < totalSeeds;\n"
            "    seed += shardCount * batchCount\n"
            "  ) {",
            "batch one repeats batch two's equal-cardinality seed set and omits its own",
        ),
        (
            "nightly-fuzz-plan-dimensions",
            "packages/conformance/test/fuzz-shard-runner.ts",
            "    if (!Number.isInteger(value) || value <= 0) {",
            "    if (value < 0) {",
            "a zero or fractional fuzz-plan dimension is accepted",
        ),
        (
            "nightly-fuzz-plan-coordinate-range",
            "packages/conformance/test/fuzz-shard-runner.ts",
            "    if (!Number.isInteger(value) || value < 0 || value >= upper) {",
            "    if (!Number.isInteger(value) || value < 0 || value > upper) {",
            "a shard or batch index equal to its exclusive upper bound is accepted",
        ),
        (
            "nightly-fuzz-plan-empty-rejected",
            "packages/conformance/test/fuzz-shard-runner.ts",
            "  if (seeds.length === 0) {\n"
            "    throw new RangeError(\n"
            "      `fuzz batch ${batch}/${batchCount} of shard ${shard}/${shardCount} owns no seeds`,\n"
            "    )\n"
            "  }",
            "  if (false && seeds.length === 0) {\n"
            "    throw new RangeError(\n"
            "      `fuzz batch ${batch}/${batchCount} of shard ${shard}/${shardCount} owns no seeds`,\n"
            "    )\n"
            "  }",
            "an empty fuzz process is credited as a planned batch",
        ),
        (
            "nightly-fuzz-workflow-enrollment",
            ".github/workflows/nightly.yml",
            "        shard: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]",
            "        shard: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]",
            "the hosted nightly silently omits one logical fuzz shard",
        ),
        (
            "nightly-fuzz-workflow-batches",
            "scripts/nightly-fuzz-shard.sh",
            "readonly BATCH_COUNT=4",
            "readonly BATCH_COUNT=3",
            "the hosted nightly silently omits one batch from every logical shard",
        ),
        (
            "nightly-fuzz-workflow-confinement",
            "scripts/nightly-fuzz-shard.sh",
            "    bash scripts/confine.sh\n",
            "",
            "the hosted nightly runs growing fuzz work outside the aggregate resource scope",
        ),
        (
            "nightly-fuzz-runtime-environment",
            "scripts/nightly-fuzz-shard.sh",
            '    "FUZZ_BATCH_INDEX=$batch"\n',
            '    "FUZZ_BATCH_INDEX=$((batch + (shard == 1 && batch == 1)))"\n',
            "one hosted process repeats an equal-cardinality sibling batch and omits its reported coordinate",
        ),
        (
            "nightly-fuzz-batch-execution",
            "scripts/nightly-fuzz-shard.sh",
            '  "${command[@]}"\n',
            "  :\n",
            "the nightly credits and reports a hosted batch without launching its command",
        ),
        (
            "nightly-fuzz-workflow-invocation",
            ".github/workflows/nightly.yml",
            '        run: bash scripts/nightly-fuzz-shard.sh "$FUZZ_SHARD"',
            '        run: echo bash scripts/nightly-fuzz-shard.sh "$FUZZ_SHARD"',
            "the hosted workflow prints the canonical command instead of executing it",
        ),
        (
            "nightly-fuzz-workflow-if",
            ".github/workflows/nightly.yml",
            "  fuzz:\n",
            "  fuzz:\n    if: false\n",
            "the hosted fuzz job is structurally enrolled but unconditionally skipped",
        ),
        (
            "nightly-fuzz-workflow-continue-on-error",
            ".github/workflows/nightly.yml",
            "  fuzz:\n",
            "  fuzz:\n    continue-on-error: true\n",
            "the hosted fuzz job can fail while the nightly remains green",
        ),
        (
            "nightly-fuzz-workflow-exclude",
            ".github/workflows/nightly.yml",
            "      max-parallel: 8\n      matrix:\n",
            "      max-parallel: 8\n"
            "      matrix:\n"
            "        exclude:\n"
            "          - shard: 31\n",
            "the hosted matrix lists every shard but excludes one from execution",
        ),
        (
            "nightly-fuzz-file-enrollment",
            "packages/conformance/test/fuzz-31.test.ts",
            "runFuzzShard(31, 32)",
            "runFuzzShard(30, 32)",
            "one fuzz file duplicates another shard coordinate and leaves its own seeds unexecuted",
        ),
        (
            "retry-normalize-base-bound",
            "packages/core/src/validate.ts",
            "  if (ms > MAX_DURATION_MS) {",
            "  if (name !== 'retry strategy baseSeconds' && ms > MAX_DURATION_MS) {",
            "retry normalization accepts an unchecked base duration",
        ),
        (
            "retry-normalize-max-bound",
            "packages/core/src/validate.ts",
            "  if (ms > MAX_DURATION_MS) {",
            "  if (name !== 'retry strategy maxSeconds' && ms > MAX_DURATION_MS) {",
            "retry normalization accepts an unchecked exponential cap",
        ),
        (
            "retry-normalize-factor",
            "packages/core/src/retry.ts",
            "  if (typeof value !== 'number' || !isFiniteNumber(value) || value < 0) {",
            "  if (typeof value !== 'number' || !isFiniteNumber(value) || false) {",
            "retry normalization accepts an unchecked exponential factor",
        ),
        (
            "retry-normalize-kind",
            "packages/core/src/retry.ts",
            "  if (kind !== 'fixed' && kind !== 'exponential') {\n"
            "    throw new TrustedRangeError('retry strategy kind must be none, fixed, or exponential')\n"
            "  }",
            "  if (kind !== 'fixed' && kind !== 'exponential') {\n"
            "    return freeze({ kind: 'none' }) as NormalizedRetryStrategy // MUTATION\n"
            "  }",
            "retry normalization maps an unknown strategy kind to no retries",
        ),
        (
            "retry-normalize-rebuild",
            "packages/core/src/retry.ts",
            "function finalizeRetryStrategy(value: RetryStrategy): NormalizedRetryStrategy {\n"
            "  return freeze(value) as NormalizedRetryStrategy\n"
            "}",
            "function finalizeRetryStrategy(value: RetryStrategy): NormalizedRetryStrategy {\n"
            "  return value as NormalizedRetryStrategy // MUTATION\n"
            "}",
            "retry normalization returns mutable canonical data",
        ),
        (
            "retry-normalize-readable-fields",
            "packages/core/src/retry.ts",
            "function readRetryField(value: object, field: string): unknown {\n"
            "  try {\n"
            "    return reflectGet(value, field)\n"
            "  } catch {\n"
            "    throw new TrustedRangeError(`retry strategy ${field} is not readable`)\n"
            "  }\n"
            "}",
            "function readRetryField(value: object, field: string): unknown {\n"
            "  return reflectGet(value, field) // MUTATION\n"
            "}",
            "a hostile retry field getter escapes the normalization boundary",
        ),
        (
            "retry-normalize-positive-zero",
            "packages/core/src/retry.ts",
            "  return milliseconds === 0 ? 0 : milliseconds / 1000",
            "  if (name === 'retry strategy baseSeconds') return milliseconds / 1000 // MUTATION\n"
            "  return milliseconds === 0 ? 0 : milliseconds / 1000",
            "retry base normalization returns negative zero instead of its serialized representation",
        ),
        (
            "retry-normalize-max-positive-zero",
            "packages/core/src/retry.ts",
            "  return milliseconds === 0 ? 0 : milliseconds / 1000",
            "  if (name === 'retry strategy maxSeconds') return milliseconds / 1000 // MUTATION\n"
            "  return milliseconds === 0 ? 0 : milliseconds / 1000",
            "retry cap normalization returns negative zero instead of its serialized representation",
        ),
        (
            "retry-normalize-factor-positive-zero",
            "packages/core/src/retry.ts",
            "  return value === 0 ? 0 : value",
            "  return value",
            "retry factor normalization returns negative zero instead of its serialized representation",
        ),
        (
            "retry-decision-normalization",
            "packages/core/src/retry.ts",
            "  const normalizedDecision = normalizeRetryStrategy(strategy)",
            "  const normalizedDecision = strategy as NormalizedRetryStrategy // MUTATION",
            "the public retry decision API consumes an unchecked strategy",
        ),
        (
            "retry-delay-normalization",
            "packages/core/src/retry.ts",
            "  const normalizedDelay = normalizeRetryStrategy(strategy)",
            "  const normalizedDelay = strategy as NormalizedRetryStrategy // MUTATION",
            "the public retry delay API consumes an unchecked strategy",
        ),
        (
            "retry-zero-base-overflow",
            "packages/core/src/retry.ts",
            "      if (strategy.baseSeconds === 0) return 0",
            "      if (false && strategy.baseSeconds === 0) return 0",
            "zero-base exponential retry math becomes nonzero after exponent overflow",
        ),
        (
            "retry-spawn-normalization",
            "packages/store-libsql/src/store.ts",
            "    const retry = serializeTaskValue(\n"
            "      'retry strategy',\n"
            "      normalizeRetryStrategy(retryInput === undefined ? DEFAULT_RETRY : retryInput),\n"
            "    )",
            "    const retry = serializeTaskValue(\n"
            "      'retry strategy',\n"
            "      retryInput === null\n"
            "        ? normalizeRetryStrategy(retryInput)\n"
            "        : retryInput === undefined\n"
            "          ? DEFAULT_RETRY\n"
            "          : retryInput,\n"
            "    )",
            "spawn persists a retry policy without normalization",
        ),
        (
            "retry-spawn-null",
            "packages/store-libsql/src/store.ts",
            "retryInput === undefined ? DEFAULT_RETRY : retryInput",
            "retryInput ?? DEFAULT_RETRY",
            "spawn silently treats an explicit null retry policy as the default",
        ),
        (
            "retry-persisted-normalization",
            "packages/store-libsql/src/store.ts",
            "    retryStrategy: normalizeRetryStrategy(parseTaskValueJson(String(row.retry_strategy))),",
            "    retryStrategy: parseTaskValueJson(String(row.retry_strategy)) as ClaimedRun['retryStrategy'],",
            "claim exposes unchecked durable retry JSON",
        ),
        (
            "retry-normalized-type-is-nominal",
            "packages/core/src/types.ts",
            "export type NormalizedRetryStrategy = RetryStrategy & NormalizedRetryStrategyIdentity",
            "export type NormalizedRetryStrategy = RetryStrategy",
            "object spread can forge normalized retry data at compile time",
        ),
        (
            "task-throwable-primitive",
            "packages/core/src/errors.ts",
            "  const message = typeof value === 'string' ? value : stringifyPrimitive(value)",
            "  const message =\n"
            "    typeof value === 'string' ? 'mutated task failure' : stringifyPrimitive(value)",
            "a primitive throw crosses the snapshot boundary with a different message",
        ),
        (
            "task-throwable-prototype-data",
            "packages/core/src/errors.ts",
            "    const name = errorDataString(value, 'name')",
            "    let name = errorDataString(value, 'name')\n"
            "    if (name.kind === 'value' && name.value === 'TypeError') {\n"
            "      name = { kind: 'absent' } // MUTATION\n"
            "    }",
            "a TypeError loses its data-string prototype name",
        ),
        (
            "task-throwable-generic-payload",
            "packages/core/src/errors.ts",
            "    if (message.kind !== 'value') return GENERIC_TASK_FAILURE",
            "    if (message.kind !== 'value' && typeof value === 'function') {\n"
            "      return freeze({\n"
            "        kind: 'failure',\n"
            "        fatal: false,\n"
            "        failureJson: taskFailureJson('Error', 'mutated uninspectable task failure'),\n"
            "      })\n"
            "    }\n"
            "    if (message.kind !== 'value') return GENERIC_TASK_FAILURE",
            "a thrown function acquires a second generic wire spelling",
        ),
        (
            "task-throwable-total-fallback",
            "packages/core/src/errors.ts",
            "  } catch {\n"
            "    return GENERIC_TASK_FAILURE\n"
            "  }",
            "  } catch (error) {\n"
            "    if (error instanceof RangeError) throw error // MUTATION\n"
            "    return GENERIC_TASK_FAILURE\n"
            "  }",
            "a RangeError thrown by a hostile descriptor trap escapes the total throwable boundary",
        ),
        (
            "task-throwable-name-data-only",
            "packages/core/src/errors.ts",
            "    const name = errorDataString(value, 'name')",
            "    const name: DataString = {\n"
            "      kind: 'value',\n"
            "      value: Reflect.get(value, 'name') as string,\n"
            "    }",
            "failure normalization invokes a hostile name getter",
        ),
        (
            "task-throwable-message-data-only",
            "packages/core/src/errors.ts",
            "    const message = errorDataString(value, 'message')",
            "    let message = errorDataString(value, 'message')\n"
            "    if (message.kind === 'unsafe') {\n"
            "      message = {\n"
            "        kind: 'value',\n"
            "        value: Reflect.get(value, 'message') as string,\n"
            "      }\n"
            "    }",
            "failure normalization invokes a hostile message getter",
        ),
        (
            "task-throwable-no-object-coercion",
            "packages/core/src/errors.ts",
            "    if (message.kind !== 'value') return GENERIC_TASK_FAILURE",
            "    if (message.kind !== 'value') {\n"
            "      if (hasOwn(value, Symbol.toPrimitive)) stringifyPrimitive(value) // MUTATION\n"
            "      return GENERIC_TASK_FAILURE\n"
            "    }",
            "failure normalization invokes an uninspectable object's own Symbol.toPrimitive hook",
        ),
        (
            "task-control-suspend-auth",
            "packages/sdk/src/task-control.ts",
            "      return enroll(new SuspendSignal(reason, wake, checkpoint), {\n"
            "        kind: 'suspend',\n"
            "        reason,\n"
            "        wake: ownedWake,\n"
            "        checkpoint: ownedCheckpoint,\n"
            "      })",
            "      const signal = new SuspendSignal(reason, wake, checkpoint)\n"
            "      if (ownedCheckpoint !== undefined && ownedCheckpoint.key === 'sleep') {\n"
            "        throw signal // MUTATION\n"
            "      }\n"
            "      return enroll(signal, {\n"
            "        kind: 'suspend',\n"
            "        reason,\n"
            "        wake: ownedWake,\n"
            "        checkpoint: ownedCheckpoint,\n"
            "      })",
            "a suspension with the owned checkpoint key 'sleep' is not enrolled in its control scope",
        ),
        (
            "task-control-suspend-reason-owned",
            "packages/sdk/src/task-control.ts",
            "      return enroll(new SuspendSignal(reason, wake, checkpoint), {\n"
            "        kind: 'suspend',\n"
            "        reason,\n"
            "        wake: ownedWake,\n"
            "        checkpoint: ownedCheckpoint,\n"
            "      })",
            "      const signal = new SuspendSignal(reason, wake, checkpoint)\n"
            "      return enroll(signal, {\n"
            "        kind: 'suspend',\n"
            "        get reason(): 'sleep' | 'await-event' {\n"
            "          return signal.reason as 'sleep' | 'await-event'\n"
            "        },\n"
            "        wake: ownedWake,\n"
            "        checkpoint: ownedCheckpoint,\n"
            "      })",
            "the suspension snapshot re-reads a handler-mutated reason",
        ),
        (
            "task-control-suspend-relative-wake-owned",
            "packages/sdk/src/task-control.ts",
            "            ? freeze({ inSeconds: wake.inSeconds })",
            "            ? wake",
            "the suspension snapshot retains a handler-mutable relative wake",
        ),
        (
            "task-control-suspend-absolute-wake-owned",
            "packages/sdk/src/task-control.ts",
            "            : freeze({ atEpochMs: wake.atEpochMs })",
            "            : wake",
            "the suspension snapshot retains a handler-mutable absolute wake",
        ),
        (
            "task-control-absolute-wake-own-discriminant",
            "packages/sdk/src/task-control.ts",
            "  return taskHasOwn(wake, 'inSeconds')",
            "  return 'inSeconds' in wake // MUTATION",
            "the suspension snapshot accepts an inherited relative-wake discriminant",
        ),
        (
            "task-control-suspend-checkpoint-key-owned",
            "packages/sdk/src/task-control.ts",
            "          : freeze({ key: checkpoint.key, stateJson: checkpoint.stateJson })",
            "          : freeze({\n"
            "              get key() {\n"
            "                return checkpoint.key\n"
            "              },\n"
            "              stateJson: checkpoint.stateJson,\n"
            "            })",
            "the suspension snapshot re-reads a handler-mutated checkpoint key",
        ),
        (
            "task-control-suspend-checkpoint-state-owned",
            "packages/sdk/src/task-control.ts",
            "          : freeze({ key: checkpoint.key, stateJson: checkpoint.stateJson })",
            "          : freeze({\n"
            "              key: checkpoint.key,\n"
            "              get stateJson() {\n"
            "                return checkpoint.stateJson\n"
            "              },\n"
            "            })",
            "the suspension snapshot re-reads handler-mutated checkpoint state",
        ),
        (
            "task-control-captured-map-constructor",
            "packages/sdk/src/task-control.ts",
            "  const controls = new TaskControlMap<object, TaskControlSnapshot>()",
            "  const controls = new WeakMap<object, TaskControlSnapshot>()",
            "task initialization can replace the control registry constructor",
        ),
        (
            "task-control-captured-map-get",
            "packages/sdk/src/task-control.ts",
            "      return weakMapGet(controls, value)",
            "      return controls.get(value)",
            "task initialization can replace the control registry read",
        ),
        (
            "task-control-captured-map-set",
            "packages/sdk/src/task-control.ts",
            "    weakMapSet(controls, error, freeze(snapshot))",
            "    controls.set(error, freeze(snapshot))",
            "task initialization can replace the control registry write",
        ),
        (
            "task-control-scope-isolation",
            "packages/sdk/src/task-control.ts",
            "  const controls = new TaskControlMap<object, TaskControlSnapshot>()",
            "  const controls =\n"
            "    ((createTaskControlScope as unknown as {\n"
            "      mutationControls?: WeakMap<object, TaskControlSnapshot>\n"
            "    }).mutationControls ??= new TaskControlMap<object, TaskControlSnapshot>())",
            "one invocation accepts a control minted by another invocation",
        ),
        (
            "task-control-runtime-lease-auth",
            "packages/sdk/src/task-control.ts",
            "      return enroll(new LeaseLostError(message), LEASE_LOST)",
            "      throw new LeaseLostError(message) // MUTATION",
            "lease loss minted by the invocation runtime is not enrolled",
        ),
        (
            "task-control-store-lease-auth",
            "packages/sdk/src/task-control.ts",
            "    if (hasInstance(LeaseLostError, error)) return LEASE_LOST",
            "    if (hasInstance(LeaseLostError, error)) {\n"
            "      if (taskHasOwn(error as object, 'cause')) return undefined // MUTATION\n"
            "      return LEASE_LOST\n"
            "    }",
            "a typed lease loss carrying an own cause is not authenticated at the immediate store boundary",
        ),
        (
            "task-control-store-outage-auth",
            "packages/sdk/src/task-control.ts",
            "    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE",
            "    if (hasInstance(StoreUnavailableError, error)) {\n"
            "      if (taskHasOwn(error as object, 'cause')) return undefined // MUTATION\n"
            "      return STORE_UNAVAILABLE\n"
            "    }",
            "a typed store outage carrying an own cause is not authenticated at the immediate store boundary",
        ),
        (
            "task-control-store-typed-only",
            "packages/sdk/src/task-control.ts",
            "    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE",
            "    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE\n"
            "    if (\n"
            "      typeof error === 'object' &&\n"
            "      error !== null &&\n"
            "      taskHasOwn(error, 'cause')\n"
            "    ) {\n"
            "      return STORE_UNAVAILABLE // MUTATION\n"
            "    }",
            "an ordinary object error carrying an own cause gains store-outage authority",
        ),
        (
            "task-control-store-total-fallback",
            "packages/sdk/src/task-control.ts",
            "  } catch {\n"
            "    // A hostile proxy is not one of the store's typed infrastructure errors.\n"
            "  }\n"
            "  return undefined\n"
            "}",
            "  } catch (error) {\n"
            "    throw error // MUTATION\n"
            "  }\n"
            "  return undefined\n"
            "}",
            "a hostile proxy escapes the trusted store classifier",
        ),
        (
            "task-control-ordinary-has-instance",
            "packages/sdk/src/task-control.ts",
            "    if (hasInstance(LeaseLostError, error)) return LEASE_LOST",
            "    if (error instanceof LeaseLostError) return LEASE_LOST",
            "a handler-installed Symbol.hasInstance hook can mint lease-loss authority",
        ),
        (
            "task-control-ordinary-store-has-instance",
            "packages/sdk/src/task-control.ts",
            "    if (hasInstance(StoreUnavailableError, error)) return STORE_UNAVAILABLE",
            "    if (error instanceof StoreUnavailableError) return STORE_UNAVAILABLE",
            "a handler-installed Symbol.hasInstance hook can mint store-outage authority",
        ),
        (
            "task-throwable-public-suspend",
            "packages/core/src/errors.ts",
            "  override readonly name = 'SuspendSignal'",
            "  override readonly name = (\n"
            "    authenticateFatalFailure(this, GENERIC_TASK_FAILURE),\n"
            "    'SuspendSignal'\n"
            "  )",
            "constructing the public suspension class gains privileged failure enrollment",
        ),
        (
            "task-throwable-public-lease-lost",
            "packages/core/src/errors.ts",
            "  override readonly name = 'LeaseLostError'",
            "  override readonly name = (\n"
            "    authenticateFatalFailure(this, GENERIC_TASK_FAILURE),\n"
            "    'LeaseLostError'\n"
            "  )",
            "constructing the public lease-loss class gains privileged failure enrollment",
        ),
        (
            "task-throwable-public-store-unavailable",
            "packages/core/src/errors.ts",
            "  override readonly name = 'StoreUnavailableError'",
            "  override readonly name = (\n"
            "    authenticateFatalFailure(this, GENERIC_TASK_FAILURE),\n"
            "    'StoreUnavailableError'\n"
            "  )",
            "constructing the public store-outage class gains privileged failure enrollment",
        ),
        (
            "task-throwable-fatal-auth",
            "packages/core/src/errors.ts",
            "    authenticateFatalFailure(\n"
            "      this,\n"
            "      freeze({\n"
            "        kind: 'failure',\n"
            "        fatal: true,\n"
            "        failureJson: taskFailureJson('FatalTaskError', ownedMessage),\n"
            "      }),\n"
            "    )",
            "    void ownedMessage // MUTATION",
            "a genuine fatal failure is not snapshotted at construction",
        ),
        (
            "task-throwable-fatal-flag",
            "packages/core/src/errors.ts",
            "        fatal: true,",
            "        fatal: false,",
            "a genuine FatalTaskError spends the ordinary retry budget",
        ),
        (
            "task-throwable-forged-suspend",
            "packages/core/src/errors.ts",
            "      const authentic = getAuthenticFatalFailure(value)",
            "      let authentic = getAuthenticFatalFailure(value)\n"
            "      if (\n"
            "        authentic === undefined &&\n"
            "        value instanceof SuspendSignal &&\n"
            "        hasOwn(value, 'cause')\n"
            "      ) {\n"
            "        authentic = GENERIC_TASK_FAILURE // MUTATION\n"
            "      }",
            "a suspension prototype forgery carrying an own cause gains privileged failure enrollment",
        ),
        (
            "task-throwable-forged-lease-lost",
            "packages/core/src/errors.ts",
            "      const authentic = getAuthenticFatalFailure(value)",
            "      let authentic = getAuthenticFatalFailure(value)\n"
            "      if (\n"
            "        authentic === undefined &&\n"
            "        value instanceof LeaseLostError &&\n"
            "        hasOwn(value, 'cause')\n"
            "      ) {\n"
            "        authentic = GENERIC_TASK_FAILURE // MUTATION\n"
            "      }",
            "a lease-loss prototype forgery carrying an own cause gains privileged failure enrollment",
        ),
        (
            "task-throwable-forged-store-unavailable",
            "packages/core/src/errors.ts",
            "      const authentic = getAuthenticFatalFailure(value)",
            "      let authentic = getAuthenticFatalFailure(value)\n"
            "      if (\n"
            "        authentic === undefined &&\n"
            "        value instanceof StoreUnavailableError &&\n"
            "        hasOwn(value, 'cause')\n"
            "      ) {\n"
            "        authentic = GENERIC_TASK_FAILURE // MUTATION\n"
            "      }",
            "a store-outage prototype forgery carrying an own cause gains privileged failure enrollment",
        ),
        (
            "task-throwable-forged-fatal",
            "packages/core/src/errors.ts",
            "      const authentic = getAuthenticFatalFailure(value)",
            "      const authentic =\n"
            "        getAuthenticFatalFailure(value) ??\n"
            "        (value instanceof FatalTaskError ? GENERIC_TASK_FAILURE : undefined)",
            "the public fatal-error prototype alone grants fatal-policy enrollment",
        ),
        (
            "task-throwable-corpus-plain-string",
            "packages/sdk/test/run-worker.test.ts",
            "  'plain-string',\n",
            "",
            "the SDK throwable corpus silently omits primitive string throws",
        ),
        (
            "task-throwable-corpus-plain-object",
            "packages/sdk/test/run-worker.test.ts",
            "  'plain-object',\n",
            "",
            "the SDK throwable corpus silently omits uninspectable plain objects",
        ),
        (
            "task-throwable-corpus-type-error",
            "packages/sdk/test/run-worker.test.ts",
            "  'type-error',\n",
            "",
            "the SDK throwable corpus silently omits built-in Error subtypes",
        ),
        (
            "task-throwable-corpus-revoked-proxy",
            "packages/sdk/test/run-worker.test.ts",
            "  'revoked-proxy',\n",
            "",
            "the SDK throwable corpus silently omits revoked proxies",
        ),
        (
            "task-throwable-corpus-throwing-name-getter",
            "packages/sdk/test/run-worker.test.ts",
            "  'throwing-name-getter',\n",
            "",
            "the SDK throwable corpus silently omits hostile name getters",
        ),
        (
            "task-throwable-corpus-throwing-message-getter",
            "packages/sdk/test/run-worker.test.ts",
            "  'throwing-message-getter',\n",
            "",
            "the SDK throwable corpus silently omits hostile message getters",
        ),
        (
            "task-throwable-corpus-throwing-coercion",
            "packages/sdk/test/run-worker.test.ts",
            "  'throwing-coercion',\n",
            "",
            "the SDK throwable corpus silently omits hostile object coercion",
        ),
        (
            "task-throwable-corpus-constructed-suspend",
            "packages/sdk/test/run-worker.test.ts",
            "  'constructed-suspend',\n",
            "",
            "the SDK throwable corpus silently omits public suspension construction",
        ),
        (
            "task-throwable-corpus-constructed-lease-lost",
            "packages/sdk/test/run-worker.test.ts",
            "  'constructed-lease-lost',\n",
            "",
            "the SDK throwable corpus silently omits public lease-loss construction",
        ),
        (
            "task-throwable-corpus-constructed-store-unavailable",
            "packages/sdk/test/run-worker.test.ts",
            "  'constructed-store-unavailable',\n",
            "",
            "the SDK throwable corpus silently omits public store-outage construction",
        ),
        (
            "task-throwable-corpus-forged-suspend",
            "packages/sdk/test/run-worker.test.ts",
            "  'forged-suspend',\n",
            "",
            "the SDK throwable corpus silently omits forged suspension prototypes",
        ),
        (
            "task-throwable-corpus-forged-lease-lost",
            "packages/sdk/test/run-worker.test.ts",
            "  'forged-lease-lost',\n",
            "",
            "the SDK throwable corpus silently omits forged lease-loss prototypes",
        ),
        (
            "task-throwable-corpus-forged-store-unavailable",
            "packages/sdk/test/run-worker.test.ts",
            "  'forged-store-unavailable',\n",
            "",
            "the SDK throwable corpus silently omits forged store-outage prototypes",
        ),
        (
            "task-throwable-corpus-forged-fatal",
            "packages/sdk/test/run-worker.test.ts",
            "  'forged-fatal',\n",
            "",
            "the SDK throwable corpus silently omits forged fatal-error prototypes",
        ),
        (
            "retry-captured-reflect-get",
            "packages/core/src/retry.ts",
            "    return reflectGet(value, field)",
            "    return Reflect.get(value, field) // MUTATION",
            "retry field reads resolve the mutable ambient Reflect.get after task initialization",
        ),
        (
            "retry-captured-freeze",
            "packages/core/src/retry.ts",
            "  return freeze(value) as NormalizedRetryStrategy",
            "  return Object.freeze(value) as NormalizedRetryStrategy // MUTATION",
            "retry normalization resolves the mutable ambient Object.freeze after task initialization",
        ),
        (
            "retry-captured-is-finite",
            "packages/core/src/validate.ts",
            "  if (typeof seconds !== 'number' || !isFiniteNumber(seconds) || seconds < 0) {",
            "  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {",
            "retry duration validation resolves the mutable ambient Number.isFinite after task initialization",
        ),
        (
            "retry-captured-is-safe-integer",
            "packages/core/src/validate.ts",
            "  if (!isSafeInteger(value) || value < min || value > MAX_COUNT) {",
            "  if (!Number.isSafeInteger(value) || value < min || value > MAX_COUNT) {",
            "retry ordinal validation resolves mutable ambient Number.isSafeInteger after task initialization",
        ),
        (
            "retry-captured-round",
            "packages/core/src/validate.ts",
            "  const ms = round(seconds * 1000)",
            "  const ms = Math.round(seconds * 1000) // MUTATION",
            "retry duration rounding resolves the mutable ambient Math.round after task initialization",
        ),
        (
            "retry-captured-min",
            "packages/core/src/retry.ts",
            "      else delay = min(delay, strategy.maxSeconds)",
            "      else delay = Math.min(delay, strategy.maxSeconds) // MUTATION",
            "retry capping resolves the mutable ambient Math.min after task initialization",
        ),
        (
            "retry-captured-range-error",
            "packages/core/src/retry.ts",
            "    throw new TrustedRangeError('retry strategy must be an object')",
            "    throw new RangeError('retry strategy must be an object') // MUTATION",
            "retry validation constructs a task-installed ambient RangeError",
        ),
        (
            "task-value-captured-stringify",
            "packages/core/src/validate.ts",
            "    const serialized = stringifyJson(snapshotTaskValue(root, new TrustedWeakSet()))",
            "    const serialized = JSON.stringify(snapshotTaskValue(root, new TrustedWeakSet())) // MUTATION",
            "task-value serialization resolves mutable ambient JSON.stringify after task initialization",
        ),
        (
            "task-value-captured-parse",
            "packages/core/src/validate.ts",
            "  return parseJson(json)",
            "  return JSON.parse(json) // MUTATION",
            "task-value parsing resolves mutable ambient JSON.parse after task initialization",
        ),
        (
            "task-value-captured-is-array",
            "packages/core/src/validate.ts",
            "  if (isArray(value)) return 'an array'",
            "  if (Array.isArray(value)) return 'an array' // MUTATION",
            "task-value diagnostics resolve mutable ambient Array.isArray after task initialization",
        ),
        (
            "task-value-captured-string",
            "packages/core/src/validate.ts",
            "    throw new FatalTaskError(`${name} is not a valid task duration`)",
            "    throw new FatalTaskError(String(`${name} is not a valid task duration`)) // MUTATION",
            "task duration classification consults the mutable ambient String constructor",
        ),
        (
            "task-value-no-fatal-instanceof",
            "packages/core/src/validate.ts",
            "  } catch {\n"
            "    throw new FatalTaskError(`${what} is not valid JSON`)\n"
            "  }",
            "  } catch (error) {\n"
            "    if (error instanceof FatalTaskError) throw error // MUTATION\n"
            "    throw new FatalTaskError(`${what} is not valid JSON`)\n"
            "  }",
            "mutable FatalTaskError instanceof authority lets a parse failure escape permanent classification",
        ),
        (
            "user-name-captured-includes",
            "packages/core/src/validate.ts",
            "    if (stringIncludes(raw, '#') || stringStartsWith(raw, '$')) {",
            "    if (raw.includes('#') || stringStartsWith(raw, '$')) { // MUTATION",
            "user-name validation resolves mutable String.prototype.includes after task initialization",
        ),
        (
            "user-name-captured-starts-with",
            "packages/core/src/validate.ts",
            "    if (stringIncludes(raw, '#') || stringStartsWith(raw, '$')) {",
            "    if (stringIncludes(raw, '#') || raw.startsWith('$')) { // MUTATION",
            "user-name validation resolves mutable String.prototype.startsWith after task initialization",
        ),
        (
            "task-value-raw-function-before-to-json",
            "packages/core/src/validate.ts",
            "  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {",
            "  if (typeof value === 'symbol' || typeof value === 'bigint') { // MUTATION",
            "a function reaches prototype toJSON before raw-value rejection",
        ),
        (
            "task-value-raw-bigint-before-to-json",
            "packages/core/src/validate.ts",
            "  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {",
            "  if (typeof value === 'function' || typeof value === 'symbol') { // MUTATION",
            "a bigint reaches prototype toJSON before raw-value rejection",
        ),
        (
            "task-value-raw-cycle-before-to-json",
            "packages/core/src/validate.ts",
            "  if (weakSetHas(ancestors, value)) {\n"
            "    throw new TrustedTypeError('cyclic task value')\n"
            "  }",
            "",
            "a cycle guard disappears and the same source object is read recursively",
        ),
        (
            "task-value-raw-nested-symbol",
            "packages/core/src/validate.ts",
            "  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {",
            "  if (typeof value === 'function' || typeof value === 'bigint') { // MUTATION",
            "a nested symbol reaches JSON.stringify and is silently dropped",
        ),
        (
            "task-value-owned-object-snapshot",
            "packages/core/src/validate.ts",
            "    const owned = createObject(null) as Record<string, unknown>",
            "    const owned = {} as Record<string, unknown> // MUTATION",
            "the owned task-value snapshot inherits Object.prototype.toJSON",
        ),
        (
            "task-value-owned-date-snapshot",
            "packages/core/src/validate.ts",
            "    return isFiniteNumber(epochMs) ? dateToISOString(value) : null",
            "    return isFiniteNumber(epochMs) ? value : null // MUTATION",
            "a Date remains attacker-controlled until JSON.stringify consults its replaced toJSON",
        ),
        (
            "task-value-owned-array-snapshot",
            "packages/core/src/validate.ts",
            "      defineProperty(owned, 'toJSON', dataProperty(undefined, false))",
            "      void 0 // MUTATION",
            "an owned task-value array inherits a task-installed Array.prototype.toJSON",
        ),
        (
            "task-value-captured-date-get-time",
            "packages/core/src/validate.ts",
            "    const epochMs = dateGetTime(value)",
            "    const epochMs = (value as Date).getTime() // MUTATION",
            "Date brand checking resolves mutable Date.prototype.getTime after task initialization",
        ),
        (
            "task-value-captured-date-to-iso-string",
            "packages/core/src/validate.ts",
            "    return isFiniteNumber(epochMs) ? dateToISOString(value) : null",
            "    return isFiniteNumber(epochMs) ? (value as Date).toISOString() : null // MUTATION",
            "Date conversion resolves mutable Date.prototype.toISOString after task initialization",
        ),
        (
            "task-value-owned-descriptors",
            "packages/core/src/validate.ts",
            "  const descriptor = createObject(null) as PropertyDescriptor",
            "  const descriptor = {} as PropertyDescriptor // MUTATION",
            "owned property descriptors inherit task-installed Object.prototype descriptor fields",
        ),
        (
            "user-name-captured-regexp-exec",
            "packages/core/src/validate.ts",
            "    if (stringIncludes(raw, '\\u0000') || regexpExec(/\\p{Surrogate}/u, raw) !== null) {",
            "    if (stringIncludes(raw, '\\u0000') || /\\p{Surrogate}/u.exec(raw) !== null) { // MUTATION",
            "user-name validation resolves mutable RegExp.prototype.exec after task initialization",
        ),
        (
            "user-name-captured-regexp-test",
            "packages/core/src/validate.ts",
            "    if (stringIncludes(raw, '\\u0000') || regexpExec(/\\p{Surrogate}/u, raw) !== null) {",
            "    if (\n"
            "      stringIncludes(raw, '\\u0000') ||\n"
            "      (regexpExec(/\\p{Surrogate}/u, raw) !== null &&\n"
            "        (raw.length === 1 || /\\p{Surrogate}/u.test(raw)))\n"
            "    ) { // MUTATION",
            "a non-leading lone surrogate is rechecked through mutable RegExp.prototype.test and can be accepted",
        ),
        (
            "task-value-rejects-exotic-objects",
            "packages/core/src/validate.ts",
            "    if (prototype !== null && prototype !== objectPrototype) {",
            "    if (false && prototype !== null && prototype !== objectPrototype) { // MUTATION",
            "boxed and exotic objects are silently reinterpreted as plain JSON records",
        ),
        (
            "retry-intrinsics-captured-reflect-get",
            "packages/core/src/intrinsics.ts",
            "  ReflectGet: Reflect.get,",
            "  ReflectGet: (target: object, key: PropertyKey) => Reflect.get(target, key), // MUTATION",
            "the shared retry capability resolves ambient Reflect.get after task initialization",
        ),
        (
            "sdk-result-captured-stringify",
            "packages/sdk/src/run-worker.ts",
            "      resultJson = serializeTaskValue('task result', result)",
            "      resultJson = JSON.stringify(result) as string // MUTATION",
            "the final-result boundary bypasses the captured task-value serializer",
        ),
        (
            "sdk-complete-ordinary-rejection-identity",
            "packages/sdk/src/run-worker.ts",
            "    try {\n"
            "      await store.complete(queue, runId, claimToken, resultJson)\n"
            "    } catch (error) {\n"
            "      return trustedStoreOutcome(error)\n"
            "    }",
            "    try {\n"
            "      await store.complete(queue, runId, claimToken, resultJson)\n"
            "    } catch (error) {\n"
            "      try {\n"
            "        return trustedStoreOutcome(error)\n"
            "      } catch (ordinaryError) {\n"
            "        return await recordUserFailure(ordinaryError) // MUTATION\n"
            "      }\n"
            "    }",
            "an ordinary completion rejection is billed as a user failure",
        ),
        (
            "sdk-await-timeout-single-read",
            "packages/sdk/src/context.ts",
            "        timeoutSeconds ?? null,",
            "        opts?.timeoutSeconds ?? null, // MUTATION: re-read the task accessor",
            "awaitEvent persists a second read instead of the value it validated",
        ),
        (
            "sdk-captured-map-constructor",
            "packages/sdk/src/context.ts",
            "  private readonly seen = new TaskMap<string, unknown>()",
            "  private readonly seen = new Map<string, unknown>() // MUTATION",
            "the replay-value map constructor resolves the mutable ambient Map after task initialization",
        ),
        (
            "sdk-captured-map-has",
            "packages/sdk/src/context.ts",
            "    if (taskMapHas(this.seen, key)) {\n"
            "      return taskMapGet(this.seen, key) as T\n"
            "    }",
            "    if (this.seen.has(key)) { // MUTATION\n"
            "      return taskMapGet(this.seen, key) as T\n"
            "    }",
            "step replay membership resolves mutable Map.prototype.has after task initialization",
        ),
        (
            "sdk-captured-map-get",
            "packages/sdk/src/intrinsics.ts",
            "export const taskMapGet = Map.prototype.get.call.bind(Map.prototype.get) as <K, V>(\n"
            "  map: Map<K, V>,\n"
            "  key: K,\n"
            ") => V | undefined",
            "const capturedTaskMapGet = Map.prototype.get.call.bind(Map.prototype.get) as <K, V>(\n"
            "  map: Map<K, V>,\n"
            "  key: K,\n"
            ") => V | undefined\n"
            "export const taskMapGet = <K, V>(map: Map<K, V>, key: K): V | undefined => {\n"
            "  if (hasOwn(map, 'cause')) return map.get(key) // MUTATION\n"
            "  return capturedTaskMapGet(map, key)\n"
            "}",
            "a selected replay map carrying an own cause resolves mutable Map.prototype.get at invocation time",
        ),
        (
            "sdk-captured-map-set",
            "packages/sdk/src/intrinsics.ts",
            "export const taskMapSet = Map.prototype.set.call.bind(Map.prototype.set) as <K, V>(\n"
            "  map: Map<K, V>,\n"
            "  key: K,\n"
            "  value: V,\n"
            ") => Map<K, V>",
            "export const taskMapSet = <K, V>(map: Map<K, V>, key: K, value: V): Map<K, V> =>\n"
            "  map.set(key, value) // MUTATION",
            "replay-map writes resolve mutable Map.prototype.set at invocation time",
        ),
        (
            "sdk-context-captured-json-parse",
            "packages/sdk/src/context.ts",
            "    const result = parseTaskValueJson(stateJson) as T",
            "    const result = JSON.parse(stateJson) as T // MUTATION",
            "the executing step path resolves mutable ambient JSON.parse after task initialization",
        ),
        (
            "sdk-context-captured-json-stringify",
            "packages/sdk/src/context.ts",
            "      stateJson: serializeTaskValue('sleep marker', wake),",
            "      stateJson: JSON.stringify(wake), // MUTATION",
            "the sleep checkpoint resolves mutable ambient JSON.stringify after task initialization",
        ),
        (
            "sdk-context-captured-aborted-getter",
            "packages/sdk/src/context.ts",
            "    if (this.#leaseLost !== undefined && abortSignalAborted(this.#leaseLost)) {",
            "    if (this.#leaseLost !== undefined && this.#leaseLost.aborted) { // MUTATION",
            "context lease-loss classification resolves the mutable AbortSignal.aborted getter",
        ),
        (
            "sdk-captured-promise-race",
            "packages/sdk/src/intrinsics.ts",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    taskPromiseThen(left, resolve, reject)\n"
            "    taskPromiseThen(right, resolve, reject)\n"
            "  })\n"
            "}",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  if (hasOwn(right, 'cause')) {\n"
            "    return Promise.race([left, right]) as Promise<void> // MUTATION\n"
            "  }\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    taskPromiseThen(left, resolve, reject)\n"
            "    taskPromiseThen(right, resolve, reject)\n"
            "  })\n"
            "}",
            "a selected finalization race input carrying an own cause resolves mutable ambient Promise.race after task initialization",
        ),
        (
            "sdk-captured-promise-race-iterator",
            "packages/sdk/src/intrinsics.ts",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    taskPromiseThen(left, resolve, reject)\n"
            "    taskPromiseThen(right, resolve, reject)\n"
            "  })\n"
            "}",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    for (const promise of [left, right]) {\n"
            "      taskPromiseThen(promise, resolve, reject)\n"
            "    }\n"
            "  })\n"
            "}",
            "worker finalization dispatches through a task-installed array iterator",
        ),
        (
            "sdk-captured-promise-adoption",
            "packages/sdk/src/intrinsics.ts",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    taskPromiseThen(left, resolve, reject)\n"
            "    taskPromiseThen(right, resolve, reject)\n"
            "  })\n"
            "}",
            "export function trustedPromiseRace(left: Promise<void>, right: Promise<void>): Promise<void> {\n"
            "  return new TaskPromise<void>((resolve, reject) => {\n"
            "    TaskPromise.resolve(left).then(resolve, reject) // MUTATION\n"
            "    TaskPromise.resolve(right).then(resolve, reject)\n"
            "  })\n"
            "}",
            "worker finalization adopts inputs through mutable Promise.resolve",
        ),
        (
            "sdk-captured-abort-controller",
            "packages/sdk/src/run-worker.ts",
            "  const pumpStop = new TaskAbortController()",
            "  const pumpStop = new AbortController() // MUTATION",
            "the heartbeat stop controller resolves mutable ambient AbortController after task initialization",
        ),
        (
            "sdk-captured-abort-signal-getter",
            "packages/sdk/src/intrinsics.ts",
            "export const abortControllerSignal = controllerSignalGetter.call.bind(controllerSignalGetter) as (\n"
            "  controller: AbortController,\n"
            ") => AbortSignal",
            "export const abortControllerSignal = (controller: AbortController): AbortSignal =>\n"
            "  controller.signal // MUTATION",
            "heartbeat signal reads resolve the mutable AbortController.signal getter at invocation time",
        ),
        (
            "sdk-captured-abort-aborted-getter",
            "packages/sdk/src/intrinsics.ts",
            "export const abortSignalAborted = signalAbortedGetter.call.bind(signalAbortedGetter) as (\n"
            "  signal: AbortSignal,\n"
            ") => boolean",
            "const capturedAbortSignalAborted = signalAbortedGetter.call.bind(signalAbortedGetter) as (\n"
            "  signal: AbortSignal,\n"
            ") => boolean\n"
            "export const abortSignalAborted = (signal: AbortSignal): boolean => {\n"
            "  if (hasOwn(signal, 'cause')) return signal.aborted // MUTATION\n"
            "  return capturedAbortSignalAborted(signal)\n"
            "}",
            "a selected heartbeat cancellation signal carrying an own cause resolves the mutable AbortSignal.aborted getter",
        ),
        (
            "sdk-worker-captured-json-parse",
            "packages/sdk/src/run-worker.ts",
            "      params = parseTaskValueJson(run.paramsJson)",
            "      params = JSON.parse(run.paramsJson) // MUTATION",
            "worker parameter parsing resolves mutable ambient JSON.parse after task initialization",
        ),
        (
            "sdk-captured-abort-method",
            "packages/sdk/src/intrinsics.ts",
            "export const abortControllerAbort = AbortController.prototype.abort.call.bind(\n"
            "  AbortController.prototype.abort,\n"
            ") as (controller: AbortController, reason?: unknown) => void",
            "export const abortControllerAbort = (\n"
            "  controller: AbortController,\n"
            "  reason?: unknown,\n"
            "): void => controller.abort(reason) // MUTATION",
            "heartbeat shutdown resolves mutable AbortController.prototype.abort at invocation time",
        ),
        (
            "sdk-captured-char-code-at",
            "packages/sdk/src/intrinsics.ts",
            "export const trustedCharCodeAt = String.prototype.charCodeAt.call.bind(\n"
            "  String.prototype.charCodeAt,\n"
            ") as (value: string, index: number) => number",
            "export const trustedCharCodeAt = (value: string, index: number): number =>\n"
            "  value.charCodeAt(index) // MUTATION",
            "unknown-task jitter resolves mutable String.prototype.charCodeAt at invocation time",
        ),
        (
            "sdk-owned-event-timeout-discriminant",
            "packages/sdk/src/context.ts",
            "      await this.commitMarker(key, serializeTaskValue('event wake marker', memo))\n"
            "      if (taskHasOwn(memo, 'timedOut') && memo.timedOut === true) {",
            "      await this.commitMarker(key, serializeTaskValue('event wake marker', memo))\n"
            "      if (memo.timedOut === true) { // MUTATION",
            "an inherited timedOut property turns an emitted event into a timeout",
        ),
        (
            "sdk-owned-event-payload-discriminant",
            "packages/sdk/src/context.ts",
            "      const memo = taskHasOwn(wake, 'payloadJson')",
            "      const memo = 'payloadJson' in wake // MUTATION",
            "an inherited payloadJson property turns a timeout into a forged delivery",
        ),
        (
            "sdk-captured-registry-get",
            "packages/sdk/src/intrinsics.ts",
            "    return taskMapGet(registry as Map<K, V>, key)",
            "    if (hasOwn(registry, 'cause')) return registry.get(key) // MUTATION\n"
            "    return taskMapGet(registry as Map<K, V>, key)",
            "a selected Map registry carrying an own cause resolves its overridable get instead of its stored entry",
        ),
        (
            "sdk-registry-map-entry-authority",
            "packages/sdk/src/intrinsics.ts",
            "    return taskMapGet(registry as Map<K, V>, key)",
            "    const stored = taskMapGet(registry as Map<K, V>, key)\n"
            "    return stored ?? registry.get(key) // MUTATION",
            "a Map subclass override grants handler authority for a missing stored entry",
        ),
        (
            "system-clock-captured-date-now",
            "packages/core/src/system-clock.ts",
            "      return nowEpochMs()",
            "      return Date.now() // MUTATION",
            "SystemClock resolves mutable Date.now after module initialization",
        ),
        (
            "system-clock-captured-promise",
            "packages/core/src/system-clock.ts",
            "      return new TrustedPromise((resolve) => {",
            "      return new Promise((resolve) => { // MUTATION",
            "SystemClock sleep resolves the mutable Promise constructor",
        ),
        (
            "system-clock-captured-yield-promise",
            "packages/core/src/system-clock.ts",
            "      return new TrustedPromise((resolve) => scheduleImmediate(resolve))",
            "      return new Promise((resolve) => scheduleImmediate(resolve)) // MUTATION",
            "SystemClock yield resolves the mutable Promise constructor",
        ),
        (
            "system-clock-captured-set-immediate",
            "packages/core/src/system-clock.ts",
            "      return new TrustedPromise((resolve) => scheduleImmediate(resolve))",
            "      return new TrustedPromise((resolve) => setImmediate(resolve)) // MUTATION",
            "SystemClock yield dispatches through mutable setImmediate",
        ),
        (
            "system-clock-captured-math-max",
            "packages/core/src/system-clock.ts",
            "        const timer = scheduleTimeout(done, nonNegative(0, ms))",
            "        const timer = scheduleTimeout(done, Math.max(0, ms)) // MUTATION",
            "SystemClock sleep resolves mutable Math.max",
        ),
        (
            "system-clock-captured-set-timeout",
            "packages/core/src/system-clock.ts",
            "        const timer = scheduleTimeout(done, nonNegative(0, ms))",
            "        const timer = setTimeout(done, nonNegative(0, ms)) // MUTATION",
            "SystemClock sleep dispatches through mutable setTimeout",
        ),
        (
            "system-clock-captured-clear-timeout",
            "packages/core/src/system-clock.ts",
            "          cancelTimeout(timer)",
            "          clearTimeout(timer) // MUTATION",
            "SystemClock sleep cleanup dispatches through mutable clearTimeout",
        ),
        (
            "system-clock-captured-aborted-getter",
            "packages/core/src/system-clock.ts",
            "        if (interrupt !== undefined && signalAborted(interrupt)) {",
            "        if (interrupt !== undefined && interrupt.aborted) { // MUTATION",
            "SystemClock sleep resolves the mutable AbortSignal.aborted getter",
        ),
        (
            "system-clock-captured-add-listener",
            "packages/core/src/system-clock.ts",
            "        if (interrupt !== undefined) addAbortListener(interrupt, 'abort', done)",
            "        if (interrupt !== undefined) interrupt.addEventListener('abort', done) // MUTATION",
            "SystemClock sleep dispatches registration through mutable addEventListener",
        ),
        (
            "system-clock-captured-remove-listener",
            "packages/core/src/system-clock.ts",
            "          if (interrupt !== undefined) removeAbortListener(interrupt, 'abort', done)",
            "          if (interrupt !== undefined) interrupt.removeEventListener('abort', done) // MUTATION",
            "SystemClock sleep dispatches cleanup through mutable removeEventListener",
        ),
        (
            "sdk-task-throwable-boundary",
            "packages/sdk/src/run-worker.ts",
            "    const thrown = snapshotTaskThrowable(error)",
            "    const thrown = snapshotTaskThrowable(new Error('worker boundary replacement'))",
            "the worker snapshots a replacement instead of the raw handler throw",
        ),
    )
)


SHARED_CONFORMANCE_REGISTRY_VERDICT = ExpectedVerdict(
    "construction",
    "packages/conformance/test/enrollment.test.ts",
    "shared conformance enrollment is one indivisible door owns five surfaces and executable dispatch through one callable registry",
    "mutation-verdict:construction:shared-conformance-runner-registry",
)


VERDICTS = {
    "followon-provenance-check": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a CAS must write its own provenance rejects every follow-on write that omits complete provenance",
        "mutation-verdict:construction:followon-provenance-check",
    ),
    "positive-fence-required": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a follow-on must filter on a fence, positively, in the WHERE side rejects every non-authoritative fence spelling",
        "mutation-verdict:construction:positive-fence-required",
    ),
    "positive-fence-is-not": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a follow-on must filter on a fence, positively, in the WHERE side rejects every non-authoritative fence spelling",
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
        "only a CAS may read the clock rejects token and raw dialect clock reads in every downstream position",
        "mutation-verdict:construction:clock-ban-in-followon",
    ),
    "clock-ban-raw-dialect-in-followon": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "only a CAS may read the clock rejects token and raw dialect clock reads in every downstream position",
        "mutation-verdict:construction:clock-ban-raw-dialect-in-followon",
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
        "a generated selection restricts to rows this batch stamped never lets narrow silently drop every matching row",
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
    "generated-set-column-guard": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "fence() names a statement, and the primitive supplies the value keeps primary identity out of the public generated assignment surface",
        "mutation-verdict:construction:generated-set-column-guard",
    ),
    "generated-update-requires-target": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/fence-relation-types.test.ts",
        "requires a generated UPDATE to retain a stamped target structurally",
        "mutation-verdict:construction:generated-update-requires-target",
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
        "wake witness conformance [libsql] decides every park through one correlated wait witness",
        "mutation-verdict:behavior:emit-wake-one-witness",
        "packages/conformance/src/suite.ts",
    ),
    "event-upsert-requires-preserved-instant": ExpectedVerdict(
        "construction",
        "packages/core/test/fenced-batch.test.ts",
        "a CAS must write its own provenance rejects an event upsert that re-stamps at the current statement instant",
        "mutation-verdict:construction:event-upsert-requires-preserved-instant",
    ),
    "emit-index-driver": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/query-plans.test.ts",
        "the emit fan-out, which is a WRITE is driven by the waits index, not by a scan of runs",
        "mutation-verdict:behavior:emit-index-driver",
    ),
    "emit-wake-event-correlation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "wake witness conformance [libsql] decides every park through one correlated wait witness",
        "mutation-verdict:behavior:emit-wake-one-witness",
        "packages/conformance/src/suite.ts",
    ),
    "emit-wake-step-correlation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "wake witness conformance [libsql] decides every park through one correlated wait witness",
        "mutation-verdict:behavior:emit-wake-one-witness",
        "packages/conformance/src/suite.ts",
    ),
    "successor-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance retry failure replay preserves progress before and after the successor is claimed",
        "mutation-verdict:behavior:successor-ownership",
    ),
    "successor-attempt-identity": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "successor identity includes its task and intended attempt rejects self and historical collisions while terminalizing an at-cap failure",
        "mutation-verdict:behavior:successor-attempt-identity",
    ),
    "successor-collision-error-attribution": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/replay-after-the-world-moved.test.ts",
        "the successor collision rejection oracle propagates an unrelated pre-transition failure",
        "mutation-verdict:behavior:successor-collision-error-attribution",
    ),
    "testing-helper-bind-arity-brand": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-brand-read": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-count-missing-argument": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-count-unused-argument": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-count-factory": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-undefined-brand": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-error-constructor": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "testing-helper-bind-matcher-propagation": ExpectedVerdict(
        "construction",
        "packages/core/test/testing.test.ts",
        "mutation verdict promise helpers authenticates both compiler bind producers before every caller matcher",
        "mutation-verdict:construction:testing-helper-bind-brand-read",
    ),
    "legacy-wait-step-backfill": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/legacy-rows.test.ts",
        "rows written before a column existed a timed wake still decodes when runs.wake_step is NULL (pre-v3)",
        "mutation-verdict:behavior:legacy-wait-step-backfill",
    ),
    "legacy-wait-step-unique-scalar": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "wake witness conformance [libsql] decides every park through one correlated wait witness",
        "mutation-verdict:behavior:emit-wake-one-witness",
        "packages/conformance/src/suite.ts",
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
        "poison matrix [libsql] (ambient write label x forbidden pre-state) claim does not amplify cardinality/two-live-runs",
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
    "claim-rejects-generation-overflow": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim leaves a due run unchanged when claim generation 1000000 cannot be incremented safely",
        "mutation-verdict:behavior:claim-rejects-generation-overflow-atomically",
        "packages/conformance/src/suite.ts",
    ),
    "activate-rejects-zero-lease": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate leaves a claimed run unchanged when its stored lease is zero",
        "mutation-verdict:behavior:activate-rejects-zero-lease-atomically",
        "packages/conformance/src/suite.ts",
    ),
    "activate-requires-relaunch-bound": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate does not activate a claim whose relaunch counter became invalid",
        "mutation-verdict:behavior:activate-requires-relaunch-bound",
        "packages/conformance/src/suite.ts",
    ),
    "activate-requires-current-run-accounting": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate does not activate a claim whose live run is not the next accounted ordinal",
        "mutation-verdict:behavior:activate-requires-current-run-accounting",
        "packages/conformance/src/suite.ts",
    ),
    "activate-validates-claim-generation-input": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate rejects invalid claim-generation inputs before reaching the executor",
        "mutation-verdict:behavior:activate-validates-claim-generation-input",
        "packages/conformance/src/suite.ts",
    ),
    "claim-requires-activation-generation-order": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim applies the activation-generation relation before the claim limit",
        "mutation-verdict:behavior:claim-requires-activation-generation-order",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-requires-activation-generation-order": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim does not return an activated-ahead run from a same-token claim receipt",
        "mutation-verdict:behavior:claim-receipt-requires-activation-generation-order",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-requires-user-attempt-budget": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths",
        "mutation-verdict:behavior:current-run-requires-user-attempt-budget",
        "packages/conformance/src/store-conformance.ts",
    ),
    "claim-receipt-requires-highest-owned-ordinal": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim does not return an obsolete ordinal from a same-token claim receipt",
        "mutation-verdict:behavior:claim-receipt-requires-highest-owned-ordinal",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-requires-relaunch-bound": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim does not return an out-of-range relaunch counter from a same-token claim receipt",
        "mutation-verdict:behavior:claim-receipt-requires-relaunch-bound",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-allows-max-generation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim returns a same-token receipt at the maximum claimed generation",
        "mutation-verdict:behavior:claim-receipt-allows-max-generation",
        "packages/conformance/src/suite.ts",
    ),
    "current-run-requires-user-attempt-budget": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths",
        "mutation-verdict:behavior:current-run-requires-user-attempt-budget",
        "packages/conformance/src/store-conformance.ts",
    ),
    "current-run-requires-highest-owned-ordinal": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains accounting/below-top-minus-one across both claim profiles",
        "mutation-verdict:behavior:claim-requires-highest-owned-ordinal",
        "packages/conformance/src/store-conformance.ts",
    ),
    "checkpoint-read-requires-owner-join": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints does not surface a checkpoint whose owner ordinal is forged",
        "mutation-verdict:behavior:checkpoint-read-validates-owner-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "checkpoint-read-requires-owner-attempt-relation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints does not surface a checkpoint whose owner ordinal is forged",
        "mutation-verdict:behavior:checkpoint-read-validates-owner-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "checkpoint-write-rejects-fractional-owner-attempt": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints rejects a fractional stored owner attempt before extending the lease",
        "mutation-verdict:behavior:checkpoint-write-rejects-fractional-owner-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "checkpoint-write-rejects-owner-attempt-overflow": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints rejects an out-of-range stored owner attempt before extending the lease",
        "mutation-verdict:behavior:checkpoint-write-rejects-owner-attempt-overflow",
        "packages/conformance/src/suite.ts",
    ),
    "suspend-preserves-valid-higher-lww": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints suspends under a valid higher LWW owner without replacing its checkpoint",
        "mutation-verdict:behavior:suspend-preserves-valid-higher-lww",
        "packages/conformance/src/suite.ts",
    ),
    "reschedule-wake-own-discriminant": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) reschedule classifies an absolute wake by its own discriminant",
        "mutation-verdict:behavior:reschedule-wake-own-discriminant",
    ),
    "suspend-wake-own-discriminant": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) suspendRun keeps an absolute wake aligned with its marker",
        "mutation-verdict:behavior:suspend-wake-own-discriminant",
    ),
    "checkpoint-read-validates-run-attempt-input": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints validates checkpoint visibility through the run-ordinal input domain",
        "mutation-verdict:behavior:checkpoint-read-validates-run-attempt-input",
        "packages/conformance/src/suite.ts",
    ),
    "run-ordinal-rejects-bigint-client-input": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] checkpoints validates checkpoint visibility through the run-ordinal input domain",
        "mutation-verdict:behavior:checkpoint-read-validates-run-attempt-input",
        "packages/conformance/src/suite.ts",
    ),
    "stored-within-rejects-spread-descriptor": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "TypeScript construction rejects an object-spread descriptor at storedIntegerWithin",
        "mutation-verdict:construction:stored-within-rejects-spread-descriptor",
    ),
    "stored-incrementable-rejects-spread-descriptor": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "TypeScript construction rejects an object-spread descriptor at storedIncrementableInteger",
        "mutation-verdict:construction:stored-incrementable-rejects-spread-descriptor",
    ),
    "persisted-row-rejects-spread-descriptor": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "TypeScript construction rejects an object-spread descriptor at persistedRowInteger",
        "mutation-verdict:construction:persisted-row-rejects-spread-descriptor",
    ),
    "derived-row-rejects-spread-descriptor": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "TypeScript construction rejects an object-spread descriptor at requireDerivedInteger",
        "mutation-verdict:construction:derived-row-rejects-spread-descriptor",
    ),
    "persisted-counter-field-task-attempts": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-task-attempts",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-task-max-attempts": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-task-max-attempts",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-task-infra-retries": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-task-infra-retries",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-run-attempt": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-run-attempt",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-run-claim-gen": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-run-claim-gen",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-run-activated-gen": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-run-activated-gen",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-run-relaunch-count": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-run-relaunch-count",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "persisted-counter-field-checkpoint-owner-attempt": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/integer-domain-types.test.ts",
        "requires every keyed persisted-counter descriptor at construction",
        "mutation-verdict:construction:persisted-counter-field-checkpoint-owner-attempt",
        "packages/store-libsql/test/integer-domain-types.test.ts",
    ),
    "poison-profile-claim-pending": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact target lifecycle profile seed at construction",
        "mutation-verdict:construction:poison-profile-claim-pending",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-profile-claim-sleeping": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact target lifecycle profile seed at construction",
        "mutation-verdict:construction:poison-profile-claim-sleeping",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-profile-sweep-lost-launch": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact target lifecycle profile seed at construction",
        "mutation-verdict:construction:poison-profile-sweep-lost-launch",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-profile-sweep-claim-timeout": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact target lifecycle profile seed at construction",
        "mutation-verdict:construction:poison-profile-sweep-claim-timeout",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-attempts-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-attempts-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-attempts-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-attempts-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-max-attempts-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-max-attempts-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-max-attempts-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-max-attempts-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-infra-retries-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-infra-retries-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-task-infra-retries-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-task-infra-retries-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-attempt-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-attempt-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-attempt-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-attempt-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-claim-gen-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-claim-gen-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-claim-gen-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-claim-gen-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-activated-gen-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-activated-gen-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-activated-gen-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-activated-gen-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-relaunch-count-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-relaunch-count-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-run-relaunch-count-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-run-relaunch-count-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-checkpoint-owner-attempt-upper": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-checkpoint-owner-attempt-upper",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-targetability-vector-checkpoint-owner-attempt-lower": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every exact counter targetability vector at construction",
        "mutation-verdict:construction:poison-targetability-vector-checkpoint-owner-attempt-lower",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-sweep-scan-prelimit": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths",
        "mutation-verdict:behavior:poison-sweep-scan-prelimit",
        "packages/conformance/src/store-conformance.ts",
    ),
    "sweep-lost-launch-rechecks-accounting": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification rechecks lost-launch accounting after the advisory sweep scan",
        "mutation-verdict:behavior:sweep-lost-launch-rechecks-accounting",
        "packages/conformance/src/suite.ts",
    ),
    "sweep-claim-timeout-rechecks-accounting": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification rechecks claim-timeout accounting after the advisory sweep scan",
        "mutation-verdict:behavior:sweep-claim-timeout-rechecks-accounting",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-timeout-scan-admits-terminal-owner": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces terminal activated timeouts across normal and corrupt-relaunch discovery paths",
        "mutation-verdict:behavior:sweep-quiesces-terminal-timeout-owner",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-timeout-cas-admits-terminal-owner": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces terminal activated timeouts across normal and corrupt-relaunch discovery paths",
        "mutation-verdict:behavior:sweep-quiesces-terminal-timeout-owner",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-timeout-scan-ignores-relaunch": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces terminal activated timeouts across normal and corrupt-relaunch discovery paths",
        "mutation-verdict:behavior:sweep-terminal-timeout-ignores-unrelated-relaunch-corruption",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-timeout-decode-ignores-relaunch": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces terminal activated timeouts across normal and corrupt-relaunch discovery paths",
        "mutation-verdict:behavior:terminal-timeout-decode-ignores-relaunch",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-relaunch-cap-scan-admits-terminal-owner": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces a relaunch-cap run under a terminal owner without reviving its task",
        "mutation-verdict:behavior:sweep-quiesces-terminal-relaunch-cap-owner",
        "packages/conformance/src/suite.ts",
    ),
    "terminal-relaunch-cap-cas-admits-terminal-owner": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification quiesces a relaunch-cap run under a terminal owner without reviving its task",
        "mutation-verdict:behavior:sweep-quiesces-terminal-relaunch-cap-owner",
        "packages/conformance/src/suite.ts",
    ),
    "sweep-terminal-cap-rechecks-generation-lower-bound": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification rechecks a terminal relaunch-cap generation after the advisory scan",
        "mutation-verdict:behavior:sweep-terminal-cap-rechecks-generation-lower-bound",
        "packages/conformance/src/suite.ts",
    ),
    "fail-cas-admits-terminal-owner": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] transitions: complete / fail / reschedule quiesces a claimed run under a terminal final-attempt owner",
        "mutation-verdict:behavior:fail-quiesces-terminal-owner",
        "packages/conformance/src/suite.ts",
    ),
    "poison-severity-lower-bound": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests owns lower-bound and checkpoint severity across every persisted integer field",
        "mutation-verdict:behavior:poison-severity-lower-bound",
    ),
    "poison-severity-checkpoint": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests owns lower-bound and checkpoint severity across every persisted integer field",
        "mutation-verdict:behavior:poison-severity-checkpoint",
    ),
    "poison-target-closure-comparison": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests rejects every targeted rewrite of the poison-owned closure",
        "mutation-verdict:behavior:poison-target-closure-comparison",
    ),
    "poison-returned-target-comparison": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests rejects returning the poison target even when storage stayed unchanged",
        "mutation-verdict:behavior:poison-returned-target-comparison",
    ),
    "accounting-live-run-next-invariant": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment owns accounting/live-run-not-next across every ambient label and lifecycle profile",
        "mutation-verdict:behavior:accounting-live-run-next-invariant",
        "packages/conformance/src/store-conformance.ts",
    ),
    "sweep-accepts-max-ordinal-at-infra-cap": ExpectedVerdict(
        "behavior",
        "packages/core/test/bounded-integer.test.ts",
        "decodeBoundedInteger validates the numeric run-ordinal interval through one fixed domain",
        "mutation-verdict:behavior:sweep-accepts-max-ordinal-at-infra-cap",
        "packages/core/test/bounded-integer.test.ts",
    ),
    "poison-relational-target-attempts-at-max-with-live-run": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every relational and fractional target at construction",
        "mutation-verdict:construction:poison-relational-target-attempts-at-max-with-live-run",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-relational-target-accounting-below-top-minus-one": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every relational and fractional target at construction",
        "mutation-verdict:construction:poison-relational-target-accounting-below-top-minus-one",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-relational-target-accounting-live-run-not-next": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every relational and fractional target at construction",
        "mutation-verdict:construction:poison-relational-target-accounting-live-run-not-next",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-relational-target-counter-fractional-task-max-attempts": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every relational and fractional target at construction",
        "mutation-verdict:construction:poison-relational-target-counter-fractional-task-max-attempts",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-relational-target-counter-fractional-run-relaunch-count": ExpectedVerdict(
        "construction",
        "packages/conformance/test/poison-oracle-meta.test.ts",
        "poison/invariant mechanism self-tests requires every relational and fractional target at construction",
        "mutation-verdict:construction:poison-relational-target-counter-fractional-run-relaunch-count",
        "packages/conformance/test/poison-oracle-meta.test.ts",
    ),
    "poison-claim-fractional-task-max-attempts": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains fractional task max-attempts across both claim profiles",
        "mutation-verdict:behavior:poison-claim-fractional-task-max-attempts",
        "packages/conformance/src/store-conformance.ts",
    ),
    "poison-claim-fractional-run-relaunch-count": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains fractional run relaunch-count across both claim profiles",
        "mutation-verdict:behavior:poison-claim-fractional-run-relaunch-count",
        "packages/conformance/src/store-conformance.ts",
    ),
    "poison-sweep-fractional-task-max-attempts": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths",
        "mutation-verdict:behavior:poison-sweep-fractional-task-max-attempts",
        "packages/conformance/src/store-conformance.ts",
    ),
    "poison-sweep-fractional-run-relaunch-count": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment contains every sweep target behind pre-limit eligibility and owns exhausted-budget paths",
        "mutation-verdict:behavior:poison-sweep-fractional-run-relaunch-count",
        "packages/conformance/src/store-conformance.ts",
    ),
    "poison-claim-relaunch-upper": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment relaunch_count claim boundary containment owns the upper bound across both claim profiles",
        "mutation-verdict:behavior:poison-claim-relaunch-upper",
        "packages/conformance/src/store-conformance.ts",
    ),
    "poison-claim-relaunch-lower": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) branch-reachable counter containment relaunch_count claim boundary containment owns the lower bound across both claim profiles",
        "mutation-verdict:behavior:poison-claim-relaunch-lower",
        "packages/conformance/src/store-conformance.ts",
    ),
    "matrix-lost-launch-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) owns relaunch-cap-edge across every generated label/fault cell and seed",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "sweep-lost-launch-generation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) owns relaunch-cap-edge across every generated label/fault cell and seed",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:relaunch-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "matrix-claim-timeout-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) owns infra-cap-edge across every generated label/fault cell and seed",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "shared-conformance-runner-registry": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "scheduler-conformance-enrollment": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "fault-matrix-conformance-enrollment": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "wake-witness-conformance-enrollment": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "scheduler-conformance-dispatch": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "fault-matrix-conformance-dispatch": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "poison-matrix-conformance-dispatch": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "timestamp-boundary-conformance-dispatch": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "wake-witness-conformance-dispatch": SHARED_CONFORMANCE_REGISTRY_VERDICT,
    "sweep-claim-timeout-generation": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) owns infra-cap-edge across every generated label/fault cell and seed",
        "mutation-verdict:behavior:fault-matrix-edge-crossing:infra-cap-edge",
        "packages/conformance/src/store-conformance.ts",
    ),
    "matrix-attempt-edge-progress": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "fault matrix [libsql] (label x fault x starting state, generated) owns attempt-cap-edge across every generated label/fault cell and seed",
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
        "fence provenance retry failure replay preserves progress before and after the successor is claimed",
        "mutation-verdict:behavior:successor-ownership",
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
        "the routine test id source rejects a duplicate proposed token serial before exposing it",
        "mutation-verdict:behavior:test-token-source-monotonic",
    ),
    "test-token-source-valid-serial": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/testing.test.ts",
        "the routine test id source requires every proposed token serial to be a safe integer",
        "mutation-verdict:behavior:test-token-source-valid-serial",
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
        "migrate reports success only when the schema is current owns typed schema absence without accepting deceptive failure text",
        "mutation-verdict:behavior:schema-absence-is-typed",
    ),
    "schema-version-missing-result": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current rejects a schema-version read with no result",
        "mutation-verdict:behavior:schema-version-missing-result",
    ),
    "schema-version-extra-results": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current rejects a schema-version read with extra results",
        "mutation-verdict:behavior:schema-version-extra-results",
    ),
    "schema-version-missing-row": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current rejects a schema-version read with no row",
        "mutation-verdict:behavior:schema-version-missing-row",
    ),
    "schema-version-extra-rows": ExpectedVerdict(
        "behavior",
        "packages/store-libsql/test/schema-gate.test.ts",
        "migrate reports success only when the schema is current rejects a schema-version read with extra rows",
        "mutation-verdict:behavior:schema-version-extra-rows",
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
    "spawn-orphan-owner-guard": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance spawn refuses a newly minted task id that an orphan run already owns",
        "mutation-verdict:behavior:spawn-rejects-orphan-owner",
    ),
    "spawn-cancellation-single-read": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] spawn reads cancellation once and persists the value it validated",
        "mutation-verdict:behavior:spawn-cancellation-single-read",
        "packages/conformance/src/suite.ts",
    ),
    "spawn-retry-captured-serializer": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
        "mutation-verdict:behavior:task-boundary-aggregate",
    ),
    "spawn-cancellation-owned-snapshot": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance spawn cancellation construction owns the validated snapshot",
        "mutation-verdict:behavior:spawn-cancellation-owned-snapshot",
    ),
    "spawn-cancellation-captured-serializer": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
        "mutation-verdict:behavior:task-boundary-aggregate",
    ),
    "spawn-headers-captured-serializer": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
        "mutation-verdict:behavior:task-boundary-aggregate",
    ),
    "claim-retry-captured-parser": ExpectedVerdict(
        "construction",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun protects every task-value JSON parse boundary with one captured capability",
        "mutation-verdict:construction:task-value-captured-parse",
    ),
    "claim-headers-captured-parser": ExpectedVerdict(
        "construction",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun protects every task-value JSON parse boundary with one captured capability",
        "mutation-verdict:construction:task-value-captured-parse",
    ),
    "claim-payload-validation-atomic": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim leaves a candidate with a corrupt persisted retry strategy unclaimed",
        "mutation-verdict:behavior:claim-payload-validation-atomic",
        "packages/conformance/src/suite.ts",
    ),
    "claim-candidate-headers-admissible": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim leaves a candidate with corrupt persisted headers unclaimed",
        "mutation-verdict:behavior:claim-candidate-headers-admissible",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-retry-admissible": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim same-token receipt refuses a corrupt persisted retry strategy",
        "mutation-verdict:behavior:claim-receipt-retry-admissible",
        "packages/conformance/src/suite.ts",
    ),
    "claim-receipt-headers-admissible": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] claim same-token receipt refuses corrupt persisted headers",
        "mutation-verdict:behavior:claim-receipt-headers-admissible",
        "packages/conformance/src/suite.ts",
    ),
    "activate-payload-validation-atomic": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate leaves a claim unactivated when its persisted retry strategy becomes invalid",
        "mutation-verdict:behavior:activate-payload-validation-atomic",
        "packages/conformance/src/suite.ts",
    ),
    "activate-headers-admissible": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] activate leaves a claim unactivated when its persisted headers become invalid",
        "mutation-verdict:behavior:activate-headers-admissible",
        "packages/conformance/src/suite.ts",
    ),
    "expire-lease-requires-future-expiry": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) expireLeaseNow returns false for an already-expired lease",
        "mutation-verdict:behavior:expire-lease-requires-future-expiry",
    ),
    "expire-lease-requires-integer-expiry": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/regressions.test.ts",
        "transition-layer review regressions (second round) expireLeaseNow refuses to launder a fractional stored expiry",
        "mutation-verdict:behavior:expire-lease-requires-integer-expiry",
    ),
    "expire-lease-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance expireLeaseNow refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:expire-lease-requires-run-task-queue-ownership",
    ),
    "driver-heartbeat-single-clock": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/clock-jitter.test.ts",
        "moving the clock between statements changes neither progress nor state driver cleanup derives its decision from the heartbeat instant at the epoch ceiling",
        "mutation-verdict:behavior:driver-heartbeat-single-clock",
    ),
    "complete-terminalization-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance complete does not make a task terminal while a lower live sibling remains",
        "mutation-verdict:behavior:complete-terminalization-requires-sole-live-run",
    ),
    "fail-terminalization-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance non-retrying fail does not make a task terminal while a lower live sibling remains",
        "mutation-verdict:behavior:fail-terminalization-requires-sole-live-run",
    ),
    "relaunch-cap-terminalization-requires-sole-live-run": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance relaunch-cap sweep does not make a task terminal while a lower live sibling remains",
        "mutation-verdict:behavior:relaunch-cap-terminalization-requires-sole-live-run",
    ),
    "spawn-receipt-idempotency-priority-is-queue-scoped": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance spawn receipt prefers the same-queue idempotency winner over a same-key foreign queue id collision",
        "mutation-verdict:behavior:spawn-receipt-idempotency-priority-is-queue-scoped",
    ),
    "spawn-receipt-task-id-collision-is-queue-scoped": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance spawn rejects a task-id collision owned by a foreign queue without a same-queue idempotency winner",
        "mutation-verdict:behavior:spawn-receipt-task-id-collision-is-queue-scoped",
    ),
    "claim-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance claim refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:claim-requires-run-task-queue-ownership",
    ),
    "null-event-payload-never-becomes-timeout": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance a stored SQL NULL event payload is never delivered as a timeout",
        "mutation-verdict:behavior:null-event-payload-never-becomes-timeout",
    ),
    "sdk-owned-retry-attempt": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun retry accounting cannot be changed through the public context attempt",
        "mutation-verdict:behavior:sdk-owned-retry-attempt",
    ),
    "sdk-malformed-checkpoint-stops-pump": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun stops the heartbeat pump when checkpoint decoding fails during context construction",
        "mutation-verdict:behavior:sdk-malformed-checkpoint-stops-pump",
    ),
    "sdk-subsecond-lease-upkeep-before-expiry": ExpectedVerdict(
        "behavior",
        "packages/sdk/test/run-worker.test.ts",
        "runClaimedRun schedules upkeep before a legal sub-second lease expires",
        "mutation-verdict:behavior:sdk-subsecond-lease-upkeep-before-expiry",
    ),
    "suspend-rejects-noninteger-attempt": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] transitions: complete / fail / reschedule suspendRun rejects a non-integer stored attempt atomically",
        "mutation-verdict:behavior:suspend-rejects-noninteger-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "sweep-rejects-noninteger-attempt": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "scheduler conformance [libsql] sweep classification rechecks a corrupt stored attempt after discovery without partially sweeping the expired claim",
        "mutation-verdict:behavior:sweep-rejects-noninteger-attempt",
        "packages/conformance/src/suite.ts",
    ),
    "heartbeat-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance heartbeat refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:heartbeat-requires-run-task-queue-ownership",
    ),
    "reschedule-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance reschedule refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:reschedule-requires-run-task-queue-ownership",
    ),
    "suspend-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance suspendRun refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:suspend-requires-run-task-queue-ownership",
    ),
    "set-checkpoint-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance setCheckpoint refuses a run whose task moved to a different queue",
        "mutation-verdict:behavior:set-checkpoint-requires-run-task-queue-ownership",
    ),
    "await-event-register-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance awaitEvent does not register or park when the task moved to a different queue",
        "mutation-verdict:behavior:await-event-register-requires-run-task-queue-ownership",
    ),
    "emit-event-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance emitEvent leaves a parked run untouched when its task moved to a different queue",
        "mutation-verdict:behavior:emit-event-requires-run-task-queue-ownership",
    ),
    "cancel-task-requires-run-task-queue-ownership": ExpectedVerdict(
        "behavior",
        "packages/conformance/test/libsql.test.ts",
        "poison matrix [libsql] (ambient write label x forbidden pre-state) cancel-task does not amplify ownership/run-task-queue-mismatch",
        "mutation-verdict:behavior:cancel-task-requires-run-task-queue-ownership",
        "packages/conformance/src/store-conformance.ts",
    ),
    "generated-relation-queue-ownership": ExpectedVerdict(
        "construction",
        "packages/conformance/test/fence-provenance-regressions.test.ts",
        "fence provenance generated cross-table relations cannot cross queue ownership",
        "mutation-verdict:construction:generated-relation-queue-ownership",
    ),
    "generated-runs-to-waits-authoritative-cleanup": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/fence-relation-types.test.ts",
        "TypeScript construction pins runs-to-waits as authoritative cleanup",
        "mutation-verdict:construction:generated-runs-to-waits-authoritative-cleanup",
    ),
    "generated-runs-to-tasks-queue-ownership": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/fence-relation-types.test.ts",
        "TypeScript construction pins runs-to-tasks queue ownership",
        "mutation-verdict:construction:generated-runs-to-tasks-queue-ownership",
    ),
    "generated-tasks-to-runs-queue-ownership": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/fence-relation-types.test.ts",
        "TypeScript construction pins tasks-to-runs queue ownership",
        "mutation-verdict:construction:generated-tasks-to-runs-queue-ownership",
    ),
    "generated-waits-to-runs-queue-ownership": ExpectedVerdict(
        "construction",
        "packages/store-libsql/test/fence-relation-types.test.ts",
        "TypeScript construction pins waits-to-runs queue ownership",
        "mutation-verdict:construction:generated-waits-to-runs-queue-ownership",
    ),
}

for slug, title, _guard_anchor, _guard_call, _exact_find, _exact_expression in (
    TIMESTAMP_ADDITION_CASES
):
    for boundary in ("overflow", "exact"):
        name = f"timestamp-addition-{slug}-{boundary}"
        test_suffix = (
            "refuses overflow by one without a partial transition"
            if boundary == "overflow"
            else "preserves the epoch predecessor and accepts an exact MAX_EPOCH_MS result"
        )
        VERDICTS[name] = ExpectedVerdict(
            "behavior",
            TIME_BOUNDARY_TEST,
            f"timestamp boundaries [libsql] {title} {test_suffix}",
            f"mutation-verdict:behavior:{name}",
            TIME_BOUNDARY_SOURCE,
        )

for name, _file, _find, _replace, full_name, _breaks in TIMESTAMP_BEHAVIOR_MUTATIONS:
    VERDICTS[name] = ExpectedVerdict(
        "behavior",
        TIME_BOUNDARY_TEST,
        f"timestamp boundaries [libsql] {full_name}",
        f"mutation-verdict:behavior:{name}",
        TIME_BOUNDARY_SOURCE,
    )

VERDICTS.update(
    {
        "storage-corruption-requires-statement": ExpectedVerdict(
            "construction",
            "packages/conformance/test/poison-oracle-meta.test.ts",
            "poison/invariant mechanism self-tests rejects a zero-statement structural-rejection claim",
            "mutation-verdict:construction:storage-corruption-requires-statement",
        ),
        "storage-corruption-rejection-requires-observed-attempt": ExpectedVerdict(
            "construction",
            "packages/conformance/test/poison-oracle-meta.test.ts",
            "poison/invariant mechanism self-tests credits structural rejection only after an observed storage write attempt",
            "mutation-verdict:construction:storage-corruption-rejection-requires-observed-attempt",
        ),
        "temporal-field-id-is-bounds-field": ExpectedVerdict(
            "construction",
            "packages/core/test/bounded-integer.test.ts",
            "decodeBoundedInteger pins the complete nominal persisted-temporal inventory",
            "mutation-verdict:construction:temporal-field-id-is-bounds-field",
        ),
        "migrated-integer-inventory-complete": ExpectedVerdict(
            "construction",
            "packages/store-libsql/test/schema.test.ts",
            "migrations enrolls every migrated integer column with exact nullability",
            "mutation-verdict:construction:migrated-integer-inventory-complete",
        ),
        "invariant-snapshot-table-identity": ExpectedVerdict(
            "construction",
            "packages/conformance/test/invariant-checkers.test.ts",
            "invariant checkers fire on constructed corruption binds every snapshot result through its projection table identity",
            "mutation-verdict:construction:invariant-snapshot-table-identity",
        ),
        "timestamp-boundary-enrollment": SHARED_CONFORMANCE_REGISTRY_VERDICT,
        "admin-fake-now-invalid": ExpectedVerdict(
            "behavior",
            "packages/store-libsql/test/admin-time-boundary.test.ts",
            "fake engine-time boundary rejects a negative fake clock without changing time",
            "mutation-verdict:behavior:admin-fake-now-invalid",
        ),
        "admin-fake-now-exact-endpoints": ExpectedVerdict(
            "behavior",
            "packages/store-libsql/test/admin-time-boundary.test.ts",
            "fake engine-time boundary accepts both exact epoch endpoints",
            "mutation-verdict:behavior:admin-fake-now-exact-endpoints",
        ),
        "nightly-fuzz-plan-exact-coverage": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan partitions every nightly seed exactly once into bounded fresh-process batches",
            "mutation-verdict:construction:nightly-fuzz-plan-exact-coverage",
        ),
        "nightly-fuzz-plan-dimensions": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan rejects invalid plan dimensions",
            "mutation-verdict:construction:nightly-fuzz-plan-dimensions",
        ),
        "nightly-fuzz-plan-coordinate-range": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan rejects out-of-range shard and batch coordinates",
            "mutation-verdict:construction:nightly-fuzz-plan-coordinate-range",
        ),
        "nightly-fuzz-plan-empty-rejected": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan rejects an empty process batch",
            "mutation-verdict:construction:nightly-fuzz-plan-empty-rejected",
        ),
        "nightly-fuzz-workflow-enrollment": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan enrolls every logical shard and bounded batch in the hosted nightly",
            "mutation-verdict:construction:nightly-fuzz-workflow-enrollment",
        ),
        "nightly-fuzz-workflow-batches": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan executes one canonical confined command for every hosted batch",
            "mutation-verdict:construction:nightly-fuzz-workflow-batches",
        ),
        "nightly-fuzz-workflow-confinement": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan executes one canonical confined command for every hosted batch",
            "mutation-verdict:construction:nightly-fuzz-workflow-confinement",
        ),
        "nightly-fuzz-runtime-environment": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan executes one canonical confined command for every hosted batch",
            "mutation-verdict:construction:nightly-fuzz-runtime-environment",
        ),
        "nightly-fuzz-batch-execution": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan launches every planned batch through the real hosted path",
            "mutation-verdict:construction:nightly-fuzz-batch-execution",
        ),
        "nightly-fuzz-workflow-invocation": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan enrolls every logical shard and bounded batch in the hosted nightly",
            "mutation-verdict:construction:nightly-fuzz-workflow-invocation",
        ),
        "nightly-fuzz-workflow-if": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan enrolls every logical shard and bounded batch in the hosted nightly",
            "mutation-verdict:construction:nightly-fuzz-workflow-if",
        ),
        "nightly-fuzz-workflow-continue-on-error": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan enrolls every logical shard and bounded batch in the hosted nightly",
            "mutation-verdict:construction:nightly-fuzz-workflow-continue-on-error",
        ),
        "nightly-fuzz-workflow-exclude": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan enrolls every logical shard and bounded batch in the hosted nightly",
            "mutation-verdict:construction:nightly-fuzz-workflow-exclude",
        ),
        "nightly-fuzz-file-enrollment": ExpectedVerdict(
            "construction",
            "packages/conformance/test/nightly-fuzz-plan.test.ts",
            "fuzz shard batch plan derives every fuzz file coordinate from its filename",
            "mutation-verdict:construction:nightly-fuzz-file-enrollment",
        ),
        "retry-normalize-base-bound": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy rejects a base above the durable duration bound",
            "mutation-verdict:behavior:retry-normalize-base-bound",
        ),
        "retry-normalize-max-bound": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy rejects an exponential cap above the durable duration bound",
            "mutation-verdict:behavior:retry-normalize-max-bound",
        ),
        "retry-normalize-factor": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy rejects a negative exponential factor",
            "mutation-verdict:behavior:retry-normalize-factor",
        ),
        "retry-normalize-kind": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy rejects an unknown strategy kind",
            "mutation-verdict:behavior:retry-normalize-kind",
        ),
        "retry-normalize-rebuild": ExpectedVerdict(
            "construction",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy rebuilds exact frozen millisecond-canonical data",
            "mutation-verdict:construction:retry-normalize-rebuild",
        ),
        "retry-normalize-readable-fields": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy contains hostile getters at one field-reading boundary",
            "mutation-verdict:behavior:retry-normalize-readable-fields",
        ),
        "retry-normalize-positive-zero": ExpectedVerdict(
            "construction",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy canonicalizes negative zero before serialization",
            "mutation-verdict:construction:retry-normalize-positive-zero",
        ),
        "retry-normalize-max-positive-zero": ExpectedVerdict(
            "construction",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy canonicalizes a negative-zero exponential maxSeconds before serialization",
            "mutation-verdict:construction:retry-normalize-max-positive-zero",
        ),
        "retry-normalize-factor-positive-zero": ExpectedVerdict(
            "construction",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy canonicalizes a negative-zero exponential factor before serialization",
            "mutation-verdict:construction:retry-normalize-factor-positive-zero",
        ),
        "retry-decision-normalization": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy is the decision API boundary for invalid strategy objects",
            "mutation-verdict:behavior:retry-decision-normalization",
        ),
        "retry-delay-normalization": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "normalizeRetryStrategy is the delay API boundary for invalid strategy objects",
            "mutation-verdict:behavior:retry-delay-normalization",
        ),
        "retry-zero-base-overflow": ExpectedVerdict(
            "behavior",
            "packages/core/test/retry.test.ts",
            "retryDelaySeconds a zero base stays zero when exponentiation overflows",
            "mutation-verdict:behavior:retry-zero-base-overflow",
        ),
        "retry-spawn-normalization": ExpectedVerdict(
            "behavior",
            "packages/conformance/test/libsql.test.ts",
            "scheduler conformance [libsql] spawn rejects retry durations above the durable bound without writing",
            "mutation-verdict:behavior:retry-spawn-normalization",
            "packages/conformance/src/suite.ts",
        ),
        "retry-spawn-null": ExpectedVerdict(
            "behavior",
            "packages/conformance/test/libsql.test.ts",
            "scheduler conformance [libsql] spawn rejects an explicit null retry strategy without writing",
            "mutation-verdict:behavior:retry-spawn-null",
            "packages/conformance/src/suite.ts",
        ),
        "retry-persisted-normalization": ExpectedVerdict(
            "behavior",
            "packages/conformance/test/libsql.test.ts",
            "scheduler conformance [libsql] claim normalizes an admissible persisted retry strategy before exposing it",
            "mutation-verdict:behavior:retry-persisted-normalization",
            "packages/conformance/src/suite.ts",
        ),
        "retry-normalized-type-is-nominal": ExpectedVerdict(
            "construction",
            "packages/store-libsql/test/retry-strategy-types.test.ts",
            "TypeScript construction rejects a spread-normalized retry strategy",
            "mutation-verdict:construction:retry-normalized-type-is-nominal",
        ),
        "task-throwable-primitive": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable owns primitive and Error diagnostics in one canonical representation",
            "mutation-verdict:behavior:task-throwable-primitive",
        ),
        "task-throwable-prototype-data": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable preserves a built-in Error subtype name from prototype data",
            "mutation-verdict:behavior:task-throwable-prototype-data",
        ),
        "task-throwable-generic-payload": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable uses one generic payload for uninspectable objects",
            "mutation-verdict:behavior:task-throwable-generic-payload",
        ),
        "task-throwable-total-fallback": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable contains hostile descriptor and revoked proxy traps at the total fallback",
            "mutation-verdict:behavior:task-throwable-total-fallback",
        ),
        "task-throwable-name-data-only": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable reads names from data descriptors without invoking getters",
            "mutation-verdict:behavior:task-throwable-name-data-only",
        ),
        "task-throwable-message-data-only": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable reads messages from data descriptors without invoking getters",
            "mutation-verdict:behavior:task-throwable-message-data-only",
        ),
        "task-throwable-no-object-coercion": ExpectedVerdict(
            "behavior",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable never coerces an uninspectable object",
            "mutation-verdict:behavior:task-throwable-no-object-coercion",
        ),
        "task-control-suspend-auth": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-auth",
        ),
        "task-control-suspend-reason-owned": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-reason-owned",
        ),
        "task-control-suspend-relative-wake-owned": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-relative-wake-owned",
        ),
        "task-control-suspend-absolute-wake-owned": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-absolute-wake-owned",
        ),
        "task-control-absolute-wake-own-discriminant": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope ignores an inherited relative-wake discriminant when snapshotting an absolute wake",
            "mutation-verdict:construction:task-control-absolute-wake-own-discriminant",
        ),
        "task-control-suspend-checkpoint-key-owned": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-checkpoint-key-owned",
        ),
        "task-control-suspend-checkpoint-state-owned": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-suspend-checkpoint-state-owned",
        ),
        "task-control-captured-map-constructor": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope captures the control-map constructor before task initialization",
            "mutation-verdict:construction:task-control-captured-map-constructor",
        ),
        "task-control-captured-map-get": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope captures the control-map read before task initialization",
            "mutation-verdict:construction:task-control-captured-map-get",
        ),
        "task-control-captured-map-set": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope captures the control-map write before task initialization",
            "mutation-verdict:construction:task-control-captured-map-set",
        ),
        "task-control-scope-isolation": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope owns suspension data and grants authority only to its paired classifier",
            "mutation-verdict:construction:task-control-scope-isolation",
        ),
        "task-control-runtime-lease-auth": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope enrolls lease loss minted by the invocation runtime",
            "mutation-verdict:construction:task-control-runtime-lease-auth",
        ),
        "task-control-store-lease-auth": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope enrolls typed failures only at the immediate trusted store boundary",
            "mutation-verdict:construction:task-control-store-lease-auth",
        ),
        "task-control-store-outage-auth": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope enrolls typed failures only at the immediate trusted store boundary",
            "mutation-verdict:construction:task-control-store-outage-auth",
        ),
        "task-control-store-typed-only": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope enrolls typed failures only at the immediate trusted store boundary",
            "mutation-verdict:construction:task-control-store-typed-only",
        ),
        "task-control-store-total-fallback": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/task-control.test.ts",
            "task control scope contains hostile values at the trusted store classifier",
            "mutation-verdict:behavior:task-control-store-total-fallback",
        ),
        "task-control-ordinary-has-instance": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope uses the captured ordinary type check, not a handler-installed hook",
            "mutation-verdict:construction:task-control-ordinary-has-instance",
        ),
        "task-control-ordinary-store-has-instance": ExpectedVerdict(
            "construction",
            "packages/sdk/test/task-control.test.ts",
            "task control scope uses the captured ordinary type check, not a handler-installed hook",
            "mutation-verdict:construction:task-control-ordinary-store-has-instance",
        ),
        "task-throwable-public-suspend": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable treats public engine control constructors as ordinary task failures",
            "mutation-verdict:construction:task-throwable-public-suspend",
        ),
        "task-throwable-public-lease-lost": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable treats public engine control constructors as ordinary task failures",
            "mutation-verdict:construction:task-throwable-public-lease-lost",
        ),
        "task-throwable-public-store-unavailable": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable treats public engine control constructors as ordinary task failures",
            "mutation-verdict:construction:task-throwable-public-store-unavailable",
        ),
        "task-throwable-fatal-auth": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
        "task-throwable-fatal-flag": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
        "task-throwable-forged-suspend": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable rejects prototype forgeries as ordinary user failures",
            "mutation-verdict:construction:task-throwable-forged-suspend",
        ),
        "task-throwable-forged-lease-lost": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable rejects prototype forgeries as ordinary user failures",
            "mutation-verdict:construction:task-throwable-forged-lease-lost",
        ),
        "task-throwable-forged-store-unavailable": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable rejects prototype forgeries as ordinary user failures",
            "mutation-verdict:construction:task-throwable-forged-store-unavailable",
        ),
        "task-throwable-forged-fatal": ExpectedVerdict(
            "construction",
            "packages/core/test/errors.test.ts",
            "snapshotTaskThrowable rejects prototype forgeries as ordinary user failures",
            "mutation-verdict:construction:task-throwable-forged-fatal",
        ),
        "task-throwable-corpus-plain-string": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-plain-string",
        ),
        "task-throwable-corpus-plain-object": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-plain-object",
        ),
        "task-throwable-corpus-type-error": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-type-error",
        ),
        "task-throwable-corpus-revoked-proxy": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-revoked-proxy",
        ),
        "task-throwable-corpus-throwing-name-getter": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-throwing-name-getter",
        ),
        "task-throwable-corpus-throwing-message-getter": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-throwing-message-getter",
        ),
        "task-throwable-corpus-throwing-coercion": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-throwing-coercion",
        ),
        "task-throwable-corpus-constructed-suspend": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-constructed-suspend",
        ),
        "task-throwable-corpus-constructed-lease-lost": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-constructed-lease-lost",
        ),
        "task-throwable-corpus-constructed-store-unavailable": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-constructed-store-unavailable",
        ),
        "task-throwable-corpus-forged-suspend": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-forged-suspend",
        ),
        "task-throwable-corpus-forged-lease-lost": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-forged-lease-lost",
        ),
        "task-throwable-corpus-forged-store-unavailable": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-forged-store-unavailable",
        ),
        "task-throwable-corpus-forged-fatal": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun enumerates every task-throwable corpus case",
            "mutation-verdict:construction:task-throwable-corpus-forged-fatal",
        ),
        "retry-captured-reflect-get": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics normalizes retry fields with one module-captured Reflect.get capability",
            "mutation-verdict:construction:retry-captured-reflect-get",
        ),
        "retry-captured-freeze": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics freezes retry data with the module-captured Object.freeze",
            "mutation-verdict:construction:retry-captured-freeze",
        ),
        "retry-captured-is-finite": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics checks retry finiteness with the module-captured Number.isFinite",
            "mutation-verdict:construction:retry-captured-is-finite",
        ),
        "retry-captured-is-safe-integer": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics checks retry ordinals with the module-captured Number.isSafeInteger",
            "mutation-verdict:construction:retry-captured-is-safe-integer",
        ),
        "retry-captured-round": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rounds retry durations with the module-captured Math.round",
            "mutation-verdict:construction:retry-captured-round",
        ),
        "retry-captured-min": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics caps retry delays with the module-captured Math.min",
            "mutation-verdict:construction:retry-captured-min",
        ),
        "retry-captured-range-error": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rejects invalid retry data with the module-captured RangeError",
            "mutation-verdict:construction:retry-captured-range-error",
        ),
        "task-value-captured-stringify": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
        "task-value-captured-parse": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun protects every task-value JSON parse boundary with one captured capability",
            "mutation-verdict:construction:task-value-captured-parse",
        ),
        "task-value-captured-is-array": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics classifies invalid task JSON with the module-captured Array.isArray",
            "mutation-verdict:construction:task-value-captured-is-array",
        ),
        "task-value-captured-string": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics classifies invalid task durations with the module-captured String",
            "mutation-verdict:construction:task-value-captured-string",
        ),
        "task-value-no-fatal-instanceof": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics does not use mutable FatalTaskError instanceof classification",
            "mutation-verdict:construction:task-value-no-fatal-instanceof",
        ),
        "user-name-captured-includes": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics checks reserved name characters with the module-captured String.includes",
            "mutation-verdict:construction:user-name-captured-includes",
        ),
        "user-name-captured-starts-with": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics checks reserved name prefixes with the module-captured String.startsWith",
            "mutation-verdict:construction:user-name-captured-starts-with",
        ),
        "task-value-raw-function-before-to-json": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rejects functions at every task-value surface before prototype toJSON can disguise them",
            "mutation-verdict:behavior:task-value-raw-function-before-to-json",
        ),
        "task-value-raw-bigint-before-to-json": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rejects a bigint before a prototype toJSON can disguise it",
            "mutation-verdict:behavior:task-value-raw-bigint-before-to-json",
        ),
        "task-value-raw-cycle-before-to-json": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rejects a cycle before Object.prototype.toJSON can disguise it",
            "mutation-verdict:behavior:task-value-raw-cycle-before-to-json",
        ),
        "task-value-raw-nested-symbol": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics rejects a nested symbol before JSON can silently drop it",
            "mutation-verdict:behavior:task-value-raw-nested-symbol",
        ),
        "task-value-owned-object-snapshot": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics snapshots plain objects before Object.prototype.toJSON can forge them",
            "mutation-verdict:behavior:task-value-owned-object-snapshot",
        ),
        "task-value-owned-date-snapshot": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics isolates owned Date snapshots from the captured Date conversion",
            "mutation-verdict:behavior:task-value-owned-date-snapshot",
        ),
        "task-value-owned-array-snapshot": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics snapshots arrays before Array.prototype.toJSON can forge them",
            "mutation-verdict:behavior:task-value-owned-array-snapshot",
        ),
        "task-value-captured-date-get-time": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics uses the captured Date.getTime brand check",
            "mutation-verdict:construction:task-value-captured-date-get-time",
        ),
        "task-value-captured-date-to-iso-string": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics isolates owned Date snapshots from the captured Date conversion",
            "mutation-verdict:construction:task-value-captured-date-to-iso-string",
        ),
        "task-value-owned-descriptors": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics builds owned property descriptors without Object.prototype accessors",
            "mutation-verdict:construction:task-value-owned-descriptors",
        ),
        "user-name-captured-regexp-exec": ExpectedVerdict(
            "behavior",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics does not dispatch storage-safe name checks through mutable RegExp.exec",
            "mutation-verdict:behavior:user-name-captured-regexp-exec",
        ),
        "user-name-captured-regexp-test": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics checks storage-unsafe names with the module-captured RegExp.test",
            "mutation-verdict:construction:user-name-captured-regexp-test",
        ),
        "task-value-rejects-exotic-objects": ExpectedVerdict(
            "behavior",
            "packages/core/test/task-value.test.ts",
            "serializeTaskValue rejects objects outside the explicit JSON data model instead of changing their meaning",
            "mutation-verdict:behavior:task-value-rejects-exotic-objects",
        ),
        "retry-intrinsics-captured-reflect-get": ExpectedVerdict(
            "construction",
            "packages/core/test/intrinsic-containment.test.ts",
            "trusted task-boundary intrinsics normalizes retry fields with one module-captured Reflect.get capability",
            "mutation-verdict:construction:retry-captured-reflect-get",
        ),
        "sdk-result-captured-stringify": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
        "sdk-complete-ordinary-rejection-identity": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun propagates an ordinary completion rejection without billing it as a user failure",
            "mutation-verdict:behavior:sdk-complete-ordinary-rejection-identity",
        ),
        "sdk-await-timeout-single-read": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun reads an awaitEvent timeout accessor once and stores that validated value",
            "mutation-verdict:behavior:sdk-await-timeout-single-read",
        ),
        "sdk-captured-map-constructor": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun task initialization cannot replace replay map construction",
            "mutation-verdict:construction:sdk-captured-map-constructor",
        ),
        "sdk-captured-map-has": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun a handler cannot replace replay map membership checks",
            "mutation-verdict:construction:sdk-captured-map-has",
        ),
        "sdk-captured-map-get": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun reads replay maps with the module-captured Map.get",
            "mutation-verdict:construction:sdk-captured-map-get",
        ),
        "sdk-captured-map-set": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun writes replay maps with the module-captured Map.set",
            "mutation-verdict:construction:sdk-captured-map-set",
        ),
        "sdk-context-captured-json-parse": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun protects every task-value JSON parse boundary with one captured capability",
            "mutation-verdict:construction:task-value-captured-parse",
        ),
        "sdk-context-captured-json-stringify": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
        "sdk-context-captured-aborted-getter": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun a handler cannot replace context lease-loss signal classification",
            "mutation-verdict:behavior:sdk-context-captured-aborted-getter",
        ),
        "sdk-captured-promise-race": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun a handler cannot replace bounded worker finalization",
            "mutation-verdict:construction:sdk-captured-promise-race",
        ),
        "sdk-captured-promise-race-iterator": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun races finalization promises without ambient array iteration",
            "mutation-verdict:construction:sdk-captured-promise-race-iterator",
        ),
        "sdk-captured-promise-adoption": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun a handler cannot replace promise adoption during worker finalization",
            "mutation-verdict:behavior:sdk-captured-promise-adoption",
        ),
        "sdk-captured-abort-controller": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun task initialization cannot replace the heartbeat controller constructor",
            "mutation-verdict:construction:sdk-captured-abort-controller",
        ),
        "sdk-captured-abort-signal-getter": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun reads heartbeat signals with the module-captured controller getter",
            "mutation-verdict:construction:sdk-captured-abort-signal-getter",
        ),
        "sdk-captured-abort-aborted-getter": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun reads heartbeat cancellation with the module-captured signal getter",
            "mutation-verdict:construction:sdk-captured-abort-aborted-getter",
        ),
        "sdk-worker-captured-json-parse": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun protects every task-value JSON parse boundary with one captured capability",
            "mutation-verdict:construction:task-value-captured-parse",
        ),
        "sdk-captured-abort-method": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun a handler cannot replace heartbeat shutdown",
            "mutation-verdict:construction:sdk-captured-abort-method",
        ),
        "sdk-captured-char-code-at": ExpectedVerdict(
            "construction",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun task initialization cannot replace unknown-task jitter character reads",
            "mutation-verdict:construction:sdk-captured-char-code-at",
        ),
        "sdk-owned-event-timeout-discriminant": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/event-regressions.test.ts",
            "event regressions prototype pollution cannot turn an event delivery into a timeout",
            "mutation-verdict:behavior:sdk-owned-event-timeout-discriminant",
        ),
        "sdk-owned-event-payload-discriminant": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/event-regressions.test.ts",
            "event regressions prototype pollution cannot turn an event timeout into a payload",
            "mutation-verdict:behavior:sdk-owned-event-payload-discriminant",
        ),
        "sdk-captured-registry-get": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun uses stored Map entries under subclass and prototype pollution",
            "mutation-verdict:behavior:sdk-captured-registry-get",
        ),
        "sdk-registry-map-entry-authority": ExpectedVerdict(
            "construction",
            "packages/sdk/test/registry-authority.test.ts",
            "a Map subclass override cannot grant missing handler authority",
            "mutation-verdict:construction:sdk-registry-map-entry-authority",
        ),
        "system-clock-captured-date-now": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures Date.now",
            "mutation-verdict:construction:system-clock-captured-date-now",
        ),
        "system-clock-captured-promise": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures the Promise constructor",
            "mutation-verdict:construction:system-clock-captured-promise",
        ),
        "system-clock-captured-yield-promise": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures the Promise constructor for yieldTurn",
            "mutation-verdict:construction:system-clock-captured-yield-promise",
        ),
        "system-clock-captured-set-immediate": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures setImmediate",
            "mutation-verdict:construction:system-clock-captured-set-immediate",
        ),
        "system-clock-captured-math-max": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures Math.max",
            "mutation-verdict:construction:system-clock-captured-math-max",
        ),
        "system-clock-captured-set-timeout": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures setTimeout",
            "mutation-verdict:construction:system-clock-captured-set-timeout",
        ),
        "system-clock-captured-clear-timeout": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures clearTimeout",
            "mutation-verdict:construction:system-clock-captured-clear-timeout",
        ),
        "system-clock-captured-aborted-getter": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures AbortSignal.aborted",
            "mutation-verdict:construction:system-clock-captured-aborted-getter",
        ),
        "system-clock-captured-add-listener": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures abort listener registration",
            "mutation-verdict:construction:system-clock-captured-add-listener",
        ),
        "system-clock-captured-remove-listener": ExpectedVerdict(
            "construction",
            "packages/core/test/system-clock-intrinsics.test.ts",
            "systemClock captured intrinsics captures abort listener cleanup",
            "mutation-verdict:construction:system-clock-captured-remove-listener",
        ),
        "sdk-task-throwable-boundary": ExpectedVerdict(
            "behavior",
            "packages/sdk/test/run-worker.test.ts",
            "runClaimedRun owns task serialization and permanent-failure boundaries in one aggregate",
            "mutation-verdict:behavior:task-boundary-aggregate",
        ),
    }
)

CHECKPOINT_CONFLICT_CASE_IDS = {
    "exists": "missing-owner",
    "owner-id": "owner-id-mismatch",
    "owner-task": "owner-task-mismatch",
    "owner-queue": "owner-queue-mismatch",
    "owner-attempt": "owner-attempt-mismatch",
    "owner-attempt-upper": "owner-attempt-out-of-range",
    "owner-attempt-lower": "owner-attempt-below-range",
    "owner-attempt-storage": "owner-attempt-fractional-storage",
    "conflict-queue": "conflict-queue-mismatch",
}

for consumer, _ in CHECKPOINT_CONFLICT_CONSUMERS:
    for suffix, case_id in CHECKPOINT_CONFLICT_CASE_IDS.items():
        name = f"{consumer}-validates-existing-lww-owner-{suffix}"
        VERDICTS[name] = ExpectedVerdict(
            "behavior",
            "packages/conformance/test/libsql.test.ts",
            "scheduler conformance [libsql] checkpoints "
            f"atomically refuses {consumer}/{case_id} checkpoint ownership",
            f"mutation-verdict:behavior:{name}",
            "packages/conformance/src/suite.ts",
        )

spec_names = [spec[0] for spec in MUTATION_SPECS]
if len(spec_names) != len(set(spec_names)):
    raise RuntimeError("mutation-probe has duplicate mutation names")
if set(spec_names) != set(VERDICTS):
    missing = sorted(set(spec_names) - set(VERDICTS))
    stale = sorted(set(VERDICTS) - set(spec_names))
    raise RuntimeError(f"mutation verdict inventory mismatch: missing={missing}, stale={stale}")

STORE_LIBSQL_TYPECHECK_MUTATION_NAMES = frozenset(
    {
        "stored-within-rejects-spread-descriptor",
        "stored-incrementable-rejects-spread-descriptor",
        "persisted-row-rejects-spread-descriptor",
        "derived-row-rejects-spread-descriptor",
        "persisted-counter-field-task-attempts",
        "persisted-counter-field-task-max-attempts",
        "persisted-counter-field-task-infra-retries",
        "persisted-counter-field-run-attempt",
        "persisted-counter-field-run-claim-gen",
        "persisted-counter-field-run-activated-gen",
        "persisted-counter-field-run-relaunch-count",
        "persisted-counter-field-checkpoint-owner-attempt",
        "retry-normalized-type-is-nominal",
        "generated-runs-to-waits-authoritative-cleanup",
        "generated-runs-to-tasks-queue-ownership",
        "generated-tasks-to-runs-queue-ownership",
        "generated-waits-to-runs-queue-ownership",
        "generated-update-requires-target",
    }
)

CONFORMANCE_TYPECHECK_MUTATION_NAMES = frozenset(
    {
        "poison-profile-claim-pending",
        "poison-profile-claim-sleeping",
        "poison-profile-sweep-lost-launch",
        "poison-profile-sweep-claim-timeout",
        "poison-relational-target-attempts-at-max-with-live-run",
        "poison-relational-target-accounting-below-top-minus-one",
        "poison-relational-target-accounting-live-run-not-next",
        "poison-relational-target-counter-fractional-task-max-attempts",
        "poison-relational-target-counter-fractional-run-relaunch-count",
        "poison-targetability-vector-task-attempts-upper",
        "poison-targetability-vector-task-attempts-lower",
        "poison-targetability-vector-task-max-attempts-upper",
        "poison-targetability-vector-task-max-attempts-lower",
        "poison-targetability-vector-task-infra-retries-upper",
        "poison-targetability-vector-task-infra-retries-lower",
        "poison-targetability-vector-run-attempt-upper",
        "poison-targetability-vector-run-attempt-lower",
        "poison-targetability-vector-run-claim-gen-upper",
        "poison-targetability-vector-run-claim-gen-lower",
        "poison-targetability-vector-run-activated-gen-upper",
        "poison-targetability-vector-run-activated-gen-lower",
        "poison-targetability-vector-run-relaunch-count-upper",
        "poison-targetability-vector-run-relaunch-count-lower",
        "poison-targetability-vector-checkpoint-owner-attempt-upper",
        "poison-targetability-vector-checkpoint-owner-attempt-lower",
    }
)

if STORE_LIBSQL_TYPECHECK_MUTATION_NAMES & CONFORMANCE_TYPECHECK_MUTATION_NAMES:
    raise RuntimeError("mutation-probe typecheck project inventories overlap")

TYPECHECK_MUTATION_PROJECTS: dict[str, TypecheckProject] = {
    **{
        name: "store-libsql"
        for name in STORE_LIBSQL_TYPECHECK_MUTATION_NAMES
    },
    **{
        name: "conformance"
        for name in CONFORMANCE_TYPECHECK_MUTATION_NAMES
    },
}
TYPECHECK_MUTATION_NAMES = frozenset(TYPECHECK_MUTATION_PROJECTS)

QUESTION_TOKEN_DELTA_REASONS = {
    "raw-fence-token-check": "replacement adds a RegExp negative-lookahead token, not a SQL bind",
    "generated-selection-fence": (
        "replacement adds a TypeScript conditional around a label-scoped SQL mutation"
    ),
    "generated-update-provenance-assignment": (
        "replacement adds a TypeScript conditional around a label-scoped SQL mutation"
    ),
    "driver-heartbeat-single-clock": (
        "replacement intentionally restores the removed cleanup statement and its three explicit binds"
    ),
    "timestamp-driver-cleanup-requires-last-beat-bound": (
        "replacement adds a mutation-only statement with five balanced SQL binds and one TypeScript conditional"
    ),
    "timestamp-driver-cleanup-requires-expiry-bound": (
        "replacement adds a mutation-only statement with five balanced SQL binds and one TypeScript conditional"
    ),
    "generated-relation-queue-ownership": (
        "replacement removes the TypeScript conditional that distinguishes self and cross-table relations"
    ),
    "generated-narrow-drops-all": (
        "replacement adds TypeScript conditional tokens and compares against SQL text; "
        "it does not add a generated statement bind"
    ),
    "stored-within-rejects-spread-descriptor": (
        "replacement adds an optional TypeScript field declaration"
    ),
    "stored-incrementable-rejects-spread-descriptor": (
        "replacement adds an optional TypeScript field declaration"
    ),
    "persisted-row-rejects-spread-descriptor": (
        "replacement adds an optional TypeScript field declaration"
    ),
    "derived-row-rejects-spread-descriptor": (
        "replacement adds an optional TypeScript field declaration"
    ),
    "persisted-counter-field-task-attempts": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-task-max-attempts": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-task-infra-retries": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-run-attempt": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-run-claim-gen": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-run-activated-gen": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-run-relaunch-count": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "persisted-counter-field-checkpoint-owner-attempt": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "poison-relational-target-attempts-at-max-with-live-run": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "poison-relational-target-accounting-below-top-minus-one": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "poison-relational-target-accounting-live-run-not-next": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "poison-relational-target-counter-fractional-task-max-attempts": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "poison-relational-target-counter-fractional-run-relaunch-count": (
        "replacement adds a TypeScript optional-property token, not a SQL bind"
    ),
    "timestamp-boundary-oracle-rejects-text": (
        "replacement adds a TypeScript conditional expression"
    ),
    "timestamp-boundary-oracle-rejects-fractional": (
        "replacement adds a TypeScript conditional expression"
    ),
    "admin-fake-now-exact-endpoints": "replacement adds a TypeScript conditional expression",
    "retry-normalize-factor-positive-zero": (
        "replacement removes a TypeScript conditional expression"
    ),
    "retry-spawn-normalization": (
        "replacement adds a TypeScript conditional while preserving explicit-null validation"
    ),
    "retry-spawn-null": (
        "replacement swaps a TypeScript conditional token for nullish-coalescing syntax"
    ),
    "task-control-scope-isolation": (
        "replacement adds an optional TypeScript field and nullish assignment"
    ),
    "task-throwable-forged-fatal": (
        "replacement adds TypeScript nullish-coalescing and conditional syntax"
    ),
    "spawn-cancellation-owned-snapshot": (
        "replacement adds TypeScript optional-property declarations; it does not change SQL binds"
    ),
    "sdk-registry-map-entry-authority": (
        "replacement adds TypeScript nullish-coalescing syntax"
    ),
    "sdk-await-timeout-single-read": (
        "replacement adds a TypeScript optional-chaining token while re-reading the task accessor"
    ),
}

MUTATIONS = [
    Mutation(
        *spec,
        VERDICTS[spec[0]],
        typecheck_project=TYPECHECK_MUTATION_PROJECTS.get(spec[0]),
    )
    for spec in MUTATION_SPECS
]

# These source markers exercise or annotate mutation-verdict machinery without
# claiming a live mutation of their own. Keep the set exact and reasons local:
# every other compiler-harvested marker must resolve to an ExpectedVerdict.
VERDICT_MARKER_EXEMPTIONS = {
    "mutation-verdict:behavior:poison-target-profile-seeding": (
        "healthy runtime aggregate; compiler-owned profile-record mutations own the exact seeds"
    ),
    "mutation-verdict:behavior:poison-targetability-inventory": (
        "healthy runtime aggregate; compiler-owned targetability-record mutations own the exact vectors"
    ),
    "mutation-verdict:behavior:poison-relational-target-inventory": (
        "healthy derived enrollment projection; compiler-owned relational-target record owns exact membership"
    ),
    "mutation-verdict:behavior:fault-matrix-edge-crossing:fresh": (
        "healthy generated-matrix control; edge mutations own the non-fresh markers"
    ),
    "mutation-verdict:behavior:testing-helper": (
        "unit fixture for the canonical expected-failure helpers, not a production mutation"
    ),
}

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
TYPECHECK_CMD = [
    "pnpm",
    "exec",
    "tsc",
    "-p",
    "packages/store-libsql/tsconfig.json",
    "--noEmit",
]
CONFORMANCE_TYPECHECK_CMD = [
    "pnpm",
    "exec",
    "tsc",
    "-p",
    "packages/conformance/tsconfig.json",
    "--noEmit",
]
TYPECHECK_PROJECT_ORDER: tuple[TypecheckProject, ...] = (
    "store-libsql",
    "conformance",
)
CONFINEMENT_ENV = "DURABLERUN_MUTATION_SCOPE"
REPORT_VERSION = 2
MUTATION_CHECKPOINT_DIRECTORY = "durablerun-mutation-checkpoints"
MAX_AUTO_JOBS = 16
MIN_CORES_PER_AUTO_JOB = 8


def typecheck_command(project: TypecheckProject) -> list[str]:
    if project == "store-libsql":
        return TYPECHECK_CMD
    if project == "conformance":
        return CONFORMANCE_TYPECHECK_CMD
    raise ValueError(f"unknown mutation typecheck project {project!r}")


def mutation_typecheck_projects(
    mutations: list[Mutation],
    *,
    routing_self_test_fault: str | None = None,
) -> tuple[TypecheckProject, ...]:
    projects: set[TypecheckProject] = set()
    for mutation in mutations:
        if mutation.typecheck_project is not None:
            projects.add(mutation.typecheck_project)
    ordered = tuple(project for project in TYPECHECK_PROJECT_ORDER if project in projects)
    if len(ordered) != len(projects):
        raise ValueError(f"unknown mutation typecheck projects {sorted(projects)!r}")
    if routing_self_test_fault == "skip-store-typecheck" and ordered == (
        "store-libsql",
    ):
        return ()
    if routing_self_test_fault == "misroute-store-typecheck" and ordered == (
        "store-libsql",
    ):
        return ("conformance",)
    if routing_self_test_fault == "duplicate-store-typecheck" and ordered == (
        "store-libsql",
    ):
        return ("store-libsql", "store-libsql")
    if routing_self_test_fault == "skip-conformance-typecheck" and ordered == (
        "conformance",
    ):
        return ()
    if routing_self_test_fault == "misroute-conformance-typecheck" and ordered == (
        "conformance",
    ):
        return ("store-libsql",)
    if routing_self_test_fault == "duplicate-conformance-typecheck" and ordered == (
        "conformance",
    ):
        return ("conformance", "conformance")
    if (
        routing_self_test_fault == "reverse-typecheck-project-order"
        and len(ordered) > 1
    ):
        return tuple(reversed(ordered))
    if routing_self_test_fault == "typecheck-behavior-only" and not ordered:
        return ("store-libsql",)
    if (
        routing_self_test_fault == "typecheck-vitest-construction-baseline"
        and not ordered
        and any(
            mutation.verdict.kind == "construction"
            and mutation.typecheck_project is None
            for mutation in mutations
        )
    ):
        return ("store-libsql",)
    return ordered


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


def require_verifier_capabilities(
    *,
    scope: ConfinedScope,
    workspace: IsolatedWorkspace,
    authority: WorkerAuthority,
) -> None:
    if (
        workspace.root != ROOT.resolve()
        or authority.worker_root != ROOT.resolve()
        or scope.memory_max <= 0
        or scope.cpu_quota <= 0
    ):
        raise RuntimeError("mutation verifier lacks its runtime safety capabilities")


def run_suite_process(
    command: list[str],
    *,
    output: object,
    wall_time_seconds: float,
    audit_lock: InheritedAuditLock,
    drop_audit_lock_inheritance: bool = False,
) -> int:
    """Run one verifier suite with a deadline that owns its whole process group."""
    if not math.isfinite(wall_time_seconds) or wall_time_seconds <= 0:
        raise ValueError("suite wall-time limit must be finite and positive")
    if prove_inherited_audit_lock(audit_lock.path, audit_lock.fd) != audit_lock:
        raise ValueError("mutation verifier audit-lock capability changed")
    previous_handlers = {
        signum: signal.getsignal(signum)
        for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }

    def interrupt(signum: int, _frame: object) -> None:
        raise AuditSignal(signum)

    def terminate_verifier_group(process: subprocess.Popen[bytes]) -> None:
        # A coordinator may repeat its termination signal while the worker is
        # already reaping this independently-sessioned verifier. Defer those
        # repeats until the whole nested group is gone; otherwise the second
        # signal can abort cleanup and orphan a grandchild.
        interrupt_handlers = {signum: interrupt for signum in previous_handlers}
        with CleanupSignalShield(interrupt_handlers) as shield:
            terminate_process_groups(
                [process],
                term_grace_seconds=VERIFIER_TERM_GRACE_SECONDS,
                kill_grace_seconds=VERIFIER_KILL_GRACE_SECONDS,
            )
        if shield.deferred_signum is not None:
            raise AuditSignal(shield.deferred_signum)

    for signum in previous_handlers:
        signal.signal(signum, interrupt)
    process: subprocess.Popen[bytes] | None = None
    try:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
            pass_fds=() if drop_audit_lock_inheritance else (audit_lock.fd,),
        )
        try:
            returncode = process.wait(timeout=wall_time_seconds)
        except subprocess.TimeoutExpired as error:
            terminate_verifier_group(process)
            raise SuiteInfrastructureError(
                f"suite wall-time limit of {wall_time_seconds:g}s exceeded"
            ) from error
        if process_group_exists(process.pid):
            terminate_verifier_group(process)
            raise SuiteInfrastructureError(
                "suite process leader exited with live descendants"
            )
        return returncode
    except BaseException:
        if process is not None and process_group_exists(process.pid):
            terminate_verifier_group(process)
        raise
    finally:
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)


def run_suite(
    max_workers: int,
    *,
    scope: ConfinedScope,
    workspace: IsolatedWorkspace,
    authority: WorkerAuthority,
    return_transport_as_domain: bool = False,
    suite_wall_time_seconds: float | None = None,
) -> SuiteResult:
    require_verifier_capabilities(
        scope=scope,
        workspace=workspace,
        authority=authority,
    )
    with tempfile.TemporaryDirectory(prefix="durablerun-mutation-report-") as temporary:
        report = Path(temporary) / "vitest.json"
        log = Path(temporary) / "vitest.log"
        command = [*TEST_CMD]
        if max_workers is not None:
            command.extend(("--maxWorkers", str(max_workers)))
        command.extend(("--reporter=json", "--outputFile", str(report)))
        with log.open("wb") as output:
            returncode = run_suite_process(
                command,
                output=output,
                audit_lock=authority.audit_lock,
                wall_time_seconds=(
                    MUTATION_SUITE_WALL_TIME_SECONDS
                    if suite_wall_time_seconds is None
                    else suite_wall_time_seconds
                ),
            )
        diagnostic = diagnostic_tail(log)
        if not report.exists():
            message = "Vitest did not write its JSON report"
            return reject_suite_transport(
                message,
                SuiteResult(
                    returncode == 0,
                    False,
                    (),
                    (message,),
                    diagnostic,
                ),
                return_as_domain=return_transport_as_domain,
            )
        parsed = parse_report(
            report.read_text(),
            returncode == 0,
            diagnostic,
            return_transport_as_domain=return_transport_as_domain,
        )
        if returncode >= 0:
            return parsed
        message = f"Vitest terminated by signal {-returncode}"
        return reject_suite_transport(
            message,
            parsed,
            return_as_domain=return_transport_as_domain,
        )


SUITE_TIMEOUT_SELF_TEST_READY = (
    "mutation-probe suite-timeout self-test entered real run_suite"
)
SUITE_TIMEOUT_SELF_TEST_PASSED = (
    "mutation-probe suite-timeout self-test observed the suite wall-time limit"
)
SUITE_TIMEOUT_SELF_TEST_REJECTED = (
    "mutation-probe suite-timeout self-test rejected unauthenticated verifier"
)
SUITE_TIMEOUT_SELF_TEST_FAULTS = ("immediate-magic-error",)
SUITE_SELF_TEST_DEADLINE_SECONDS = 0.1
SUITE_SELF_TEST_DESCENDANT_PROGRAM = (
    "import json,os,pathlib,signal,sys,time; "
    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
    "stream=pathlib.Path(sys.argv[2]).open('a'); "
    "stream.write(json.dumps({'label':sys.argv[1],"
    "'leader':int(sys.argv[3]),'descendant':os.getpid()})+'\\n'); "
    "stream.flush(); os.fsync(stream.fileno()); stream.close(); "
    "time.sleep(30)"
)


def suite_self_test_command(label: str, state_path: Path, *, linger: bool = False) -> list[str]:
    parent_program = (
        "import os,pathlib,subprocess,sys,time; "
        "child=subprocess.Popen([sys.executable,'-c',sys.argv[3],"
        "sys.argv[1],sys.argv[2],str(os.getpid())]); "
        "deadline=time.monotonic()+2; path=pathlib.Path(sys.argv[2]); "
        "needle='\"label\": \"'+sys.argv[1]+'\"'; "
        "ready=False; "
        "exec(\"while time.monotonic() < deadline:\\n"
        " if path.exists() and needle in path.read_text():\\n"
        "  ready=True; break\\n"
        " time.sleep(0.01)\"); "
        "assert ready, 'descendant did not authenticate readiness'; "
        + ("pass" if linger else "time.sleep(30)")
    )
    return [
        sys.executable,
        "-c",
        parent_program,
        label,
        str(state_path),
        SUITE_SELF_TEST_DESCENDANT_PROGRAM,
    ]


def suite_self_test_records(state_path: Path) -> list[dict[str, object]]:
    if not state_path.exists():
        return []
    records: list[dict[str, object]] = []
    for line in state_path.read_text().splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def suite_self_test_record(
    state_path: Path,
    label: str,
) -> tuple[tuple[int, int] | None, str | None]:
    matches = [
        record
        for record in suite_self_test_records(state_path)
        if record.get("label") == label
    ]
    if len(matches) != 1:
        return None, f"{label} verifier wrote {len(matches)} authenticated PID records"
    leader = matches[0].get("leader")
    descendant = matches[0].get("descendant")
    if (
        not isinstance(leader, int)
        or isinstance(leader, bool)
        or leader <= 1
        or not isinstance(descendant, int)
        or isinstance(descendant, bool)
        or descendant <= 1
        or leader == descendant
    ):
        return None, f"{label} verifier wrote malformed process identities"
    return (leader, descendant), None


def cleanup_suite_self_test_records(state_path: Path) -> None:
    groups: set[int] = set()
    processes: set[int] = set()
    for record in suite_self_test_records(state_path):
        leader = record.get("leader")
        descendant = record.get("descendant")
        if not isinstance(leader, int) or isinstance(leader, bool) or leader <= 1:
            continue
        if leader == os.getpgrp():
            continue
        if isinstance(descendant, int) and not isinstance(descendant, bool):
            processes.add(descendant)
            try:
                if os.getpgid(descendant) == leader:
                    groups.add(leader)
            except ProcessLookupError:
                pass
        try:
            if os.getpgid(leader) == leader:
                groups.add(leader)
        except ProcessLookupError:
            pass
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 2
    while any(process_id_is_live(process) for process in processes) and time.monotonic() < deadline:
        time.sleep(0.02)


def suite_self_test_fixture() -> tuple[
    ConfinedScope,
    IsolatedWorkspace,
    WorkerAuthority,
    object,
]:
    audit_lock_stream = tempfile.NamedTemporaryFile(
        mode="a+",
        prefix="durablerun-suite-audit-lock-",
    )
    fcntl.flock(audit_lock_stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(audit_lock_stream.fileno(), True)
    audit_lock = prove_inherited_audit_lock(
        Path(audit_lock_stream.name),
        audit_lock_stream.fileno(),
    )
    return (
        ConfinedScope("suite-timeout-self-test", 1, 1, 1),
        IsolatedWorkspace(ROOT.resolve()),
        WorkerAuthority(
            ROOT.resolve(),
            ROOT.resolve(),
            0,
            "a" * 40,
            "suite-timeout-self-test",
            audit_lock,
        ),
        audit_lock_stream,
    )


def suite_timeout_self_test_child(
    state_path: Path,
    fault: str | None,
) -> int:
    """Exercise both real verifier paths through their production default."""
    global MUTATION_SUITE_WALL_TIME_SECONDS
    original_test_command = TEST_CMD[:]
    original_typecheck_command = TYPECHECK_CMD[:]
    suite_defaults = run_suite.__kwdefaults__
    typecheck_defaults = run_typecheck.__kwdefaults__
    original_process_runner = run_suite_process
    original_wall_time = MUTATION_SUITE_WALL_TIME_SECONDS
    problems: list[str] = []
    if (
        suite_defaults is None
        or suite_defaults.get("suite_wall_time_seconds") is not None
        or typecheck_defaults is None
        or typecheck_defaults.get("suite_wall_time_seconds") is not None
        or MUTATION_SUITE_WALL_TIME_SECONDS != 300.0
    ):
        problems.append("Vitest and typecheck do not share the production 300s default")
    MUTATION_SUITE_WALL_TIME_SECONDS = SUITE_SELF_TEST_DEADLINE_SECONDS
    if fault == "immediate-magic-error":
        def immediate_magic_error(*_args: object, **_kwargs: object) -> int:
            raise SuiteInfrastructureError("suite wall-time limit exceeded")

        globals()["run_suite_process"] = immediate_magic_error
    (
        fixture_scope,
        fixture_workspace,
        fixture_authority,
        fixture_audit_lock,
    ) = suite_self_test_fixture()
    try:
        runners = (
            (
                "vitest",
                TEST_CMD,
                lambda: run_suite(
                    1,
                    scope=fixture_scope,
                    workspace=fixture_workspace,
                    authority=fixture_authority,
                ),
            ),
            (
                "typecheck",
                TYPECHECK_CMD,
                lambda: run_typecheck(
                    None,
                    project="store-libsql",
                    scope=fixture_scope,
                    workspace=fixture_workspace,
                    authority=fixture_authority,
                ),
            ),
        )
        for label, command, run in runners:
            command[:] = suite_self_test_command(label, state_path)
            try:
                run()
            except SuiteInfrastructureError as error:
                if "suite wall-time limit" not in str(error):
                    problems.append(f"{label} raised the wrong infrastructure failure: {error}")
            except Exception as error:
                problems.append(f"{label} raised the wrong exception: {error}")
            else:
                problems.append(f"{label} sleeping verifier returned without its deadline")
            identity, identity_problem = suite_self_test_record(state_path, label)
            if identity_problem is not None:
                problems.append(identity_problem)
            elif identity is not None and any(process_id_is_live(pid) for pid in identity):
                problems.append(f"{label} deadline left its verifier process group live")
    finally:
        cleanup_suite_self_test_records(state_path)
        TEST_CMD[:] = original_test_command
        TYPECHECK_CMD[:] = original_typecheck_command
        globals()["run_suite_process"] = original_process_runner
        MUTATION_SUITE_WALL_TIME_SECONDS = original_wall_time
        fixture_audit_lock.close()
    if problems:
        print(f"{SUITE_TIMEOUT_SELF_TEST_REJECTED}: {problems[0]}", file=sys.stderr)
        return 1
    print(SUITE_TIMEOUT_SELF_TEST_PASSED)
    return 0


def suite_linger_self_test_child(state_path: Path) -> int:
    problems: list[str] = []
    command = suite_self_test_command("linger", state_path, linger=True)
    _, _, fixture_authority, fixture_audit_lock = suite_self_test_fixture()
    try:
        with tempfile.TemporaryDirectory(prefix="durablerun-suite-linger-") as temporary:
            with (Path(temporary) / "suite.log").open("wb") as output:
                try:
                    run_suite_process(
                        command,
                        output=output,
                        wall_time_seconds=1.0,
                        audit_lock=fixture_authority.audit_lock,
                    )
                except SuiteInfrastructureError:
                    pass
                except Exception as error:
                    problems.append(f"lingering verifier raised the wrong exception: {error}")
                else:
                    problems.append("exited verifier leader was accepted with a live descendant")
        identity, identity_problem = suite_self_test_record(state_path, "linger")
        if identity_problem is not None:
            problems.append(identity_problem)
        elif identity is not None and any(process_id_is_live(pid) for pid in identity):
            problems.append("exited verifier leader left its descendant live")
    finally:
        cleanup_suite_self_test_records(state_path)
        fixture_audit_lock.close()
    if problems:
        print(f"mutation-probe suite-linger self-test: {problems[0]}", file=sys.stderr)
        return 1
    print("mutation-probe suite-linger self-test reaped the exited leader's group")
    return 0


def suite_interrupt_self_test_child(state_path: Path) -> int:
    original_command = TEST_CMD[:]
    TEST_CMD[:] = suite_self_test_command("interrupt", state_path)
    (
        fixture_scope,
        fixture_workspace,
        fixture_authority,
        fixture_audit_lock,
    ) = suite_self_test_fixture()
    try:
        run_suite(
            1,
            scope=fixture_scope,
            workspace=fixture_workspace,
            authority=fixture_authority,
        )
    finally:
        TEST_CMD[:] = original_command
        fixture_audit_lock.close()
    print("mutation-probe suite-interrupt self-test returned without its external signal")
    return 1


def run_typecheck(
    expected: ExpectedVerdict | None,
    *,
    project: TypecheckProject,
    scope: ConfinedScope,
    workspace: IsolatedWorkspace,
    authority: WorkerAuthority,
    suite_wall_time_seconds: float | None = None,
) -> SuiteResult:
    """Run the compiler leg and attribute only the intended unused-error directive."""
    require_verifier_capabilities(
        scope=scope,
        workspace=workspace,
        authority=authority,
    )
    with tempfile.TemporaryDirectory(prefix="durablerun-mutation-typecheck-") as temporary:
        log = Path(temporary) / "tsc.log"
        with log.open("wb") as output:
            returncode = run_suite_process(
                typecheck_command(project),
                output=output,
                audit_lock=authority.audit_lock,
                wall_time_seconds=(
                    MUTATION_SUITE_WALL_TIME_SECONDS
                    if suite_wall_time_seconds is None
                    else suite_wall_time_seconds
                ),
            )
        compiler_output = log.read_text(errors="replace")
        diagnostic = diagnostic_tail(log)
    if returncode == 0:
        return SuiteResult(True, True, (), (), diagnostic)
    if expected is None:
        return SuiteResult(
            False,
            False,
            (),
            ("the unmutated TypeScript construction baseline failed",),
            diagnostic,
        )

    marker_file = expected.marker_file or expected.file
    verdict_source = (ROOT / marker_file).read_text()
    try:
        marker_analysis = analyze_typescript_sources({marker_file: verdict_source})[
            marker_file
        ]
    except ValueError as error:
        return SuiteResult(
            False,
            False,
            (),
            (f"{marker_file}: cannot inspect construction marker: {error}",),
            diagnostic,
        )
    if marker_analysis.diagnostics:
        return SuiteResult(
            False,
            False,
            (),
            (
                f"{marker_file}: cannot own a construction marker: "
                f"{marker_analysis.diagnostics}",
            ),
            diagnostic,
        )
    marker_lines = [
        line
        for marker, line in marker_analysis.expect_error_verdict_markers
        if marker == expected.marker
    ]
    if len(marker_lines) != 1:
        return SuiteResult(
            False,
            False,
            (),
            (
                f"{marker_file}: expected one compiler-owned @ts-expect-error marker, "
                f"found {len(marker_lines)}",
            ),
            diagnostic,
        )
    marker_line = marker_lines[0]

    compiler_errors = re.findall(
        r"(?m)^(.+?\.tsx?)\((\d+),(\d+)\): error TS(\d+):.*$",
        re.sub(r"\x1b\[[0-9;]*m", "", compiler_output),
    )
    wanted = (marker_file, str(marker_line), "2578")

    def relative_compiler_path(path: str) -> str:
        candidate = Path(path.strip())
        if not candidate.is_absolute():
            candidate = ROOT / candidate
        try:
            return candidate.resolve().relative_to(ROOT.resolve()).as_posix()
        except ValueError:
            return candidate.resolve().as_posix()

    observed = [
        (relative_compiler_path(path), line, code)
        for path, line, _column, code in compiler_errors
    ]
    if observed != [wanted]:
        return SuiteResult(
            False,
            False,
            (),
            (
                f"TypeScript construction mutation produced {observed}, "
                f"expected only {wanted}",
            ),
            diagnostic,
        )
    return SuiteResult(
        False,
        False,
        (FailedAssertion(expected.file, expected.full_name, (expected.marker,)),),
        (),
        diagnostic,
    )


VerdictOutcome = Literal["caught", "survived", "wrong-path"]


def message_has_exact_marker(marker: str, message: str) -> bool:
    """Match the emitted diagnostic, never a later stack/source excerpt."""
    first_line = message.splitlines()[0].strip() if message else ""
    return (
        first_line == marker
        or first_line == f"Error: {marker}"
        or first_line == f"AssertionError: {marker}"
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
    accept_collateral_assertion: bool = False,
    accept_collateral_message: bool = False,
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
    if not accept_collateral_assertion and len(result.assertions) != 1:
        return "wrong-path"
    if not accept_collateral_message and any(
        len(assertion.messages) != 1 for assertion in result.assertions
    ):
        return "wrong-path"
    if any(matcher(expected, assertion) for assertion in result.assertions):
        return "caught"
    return "wrong-path"


QUESTION_DELTA_LIVE_ENROLLMENT_FAULT = "bypass-question-delta-live-enrollment"
VERDICT_INVENTORY_ORPHAN_FAULT = "accept-orphan-verdict-marker"
FROZEN_MIGRATION_TARGET_FAULT = "accept-frozen-migration-mutation"
TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT = (
    "poison-typescript-mutant-syntax-live-enrollment"
)
STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT = (
    "corrupt-static-verdict-title-live-enrollment"
)

DYNAMIC_BEHAVIOR_VERDICT_TITLE_REASONS = {
    "legacy-wait-step-backfill": (
        "the Vitest title is generated from the migration-derived table, column, "
        "and version tuple"
    ),
}

FROZEN_MIGRATION_MUTATION_TARGETS = {
    "packages/store-libsql/src/schema.ts": (
        "append-only migrations are frozen by an independent hash assertion; "
        "mutate a current consumer or test seam instead"
    ),
}

SELF_TEST_FAULTS = (
    "ignore-file",
    "ignore-full-name",
    "ignore-marker",
    "match-marker-substring",
    "accept-suite-error",
    "accept-incoherent-report",
    "accept-malformed-report",
    "accept-collateral-assertion",
    "accept-collateral-message",
    VERDICT_INVENTORY_ORPHAN_FAULT,
    FROZEN_MIGRATION_TARGET_FAULT,
    QUESTION_DELTA_LIVE_ENROLLMENT_FAULT,
    TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT,
    STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT,
)


def verdict_inventory_problems(
    source_markers: set[str],
    live_markers: set[str],
    exemptions: dict[str, str],
) -> list[str]:
    """Reconcile every compiler-harvested verdict claim with live authority."""
    problems: list[str] = []
    exemption_markers = set(exemptions)
    for marker, reason in sorted(exemptions.items()):
        if not reason.strip():
            problems.append(f"verdict marker exemption {marker!r} has no non-empty reason")
        if marker not in source_markers:
            problems.append(f"verdict marker exemption {marker!r} is stale")
        if marker in live_markers:
            problems.append(
                f"live ExpectedVerdict marker {marker!r} must not also be exempt"
            )
    for marker in sorted(source_markers - live_markers - exemption_markers):
        problems.append(
            f"source verdict marker {marker!r} has no live ExpectedVerdict or exact exemption"
        )
    return problems


def mutation_question_delta_diagnostic(
    name: str,
    find: str,
    replace: str,
    reason: str | None,
) -> str | None:
    """Screen raw `?` drift cheaply; this is not a bind-correctness proof.

    Equal raw counts can still exchange a SQL placeholder for TypeScript or
    comment syntax. The self-test below preserves that explicit false negative.
    Its separate classifier case proves only that an unmatched binder failure
    is wrong-path; caller matchers are a distinct attribution boundary.
    """
    before = find.count("?")
    after = replace.count("?")
    if before == after:
        if reason is not None:
            return (
                f"{name}: stale question-delta reason: raw question-token counts "
                f"are both {before}"
            )
        return None
    if reason is None:
        return (
            f"{name}: replacement changes raw question-token count ({before} -> {after}); "
            "declare a non-empty question-delta reason for non-bind syntax"
        )
    if not reason.strip():
        return f"{name}: a question-token delta requires a non-empty question-delta reason"
    return None


def mutation_target_diagnostic(file: str) -> str | None:
    reason = FROZEN_MIGRATION_MUTATION_TARGETS.get(file)
    if reason is None:
        return None
    return f"{file}: live mutation targets frozen migration history: {reason}"


def self_test(fault: str | None = None, *, check_live_inventory: bool) -> int:
    """Generated false-positive surface for the verdict classifier itself."""
    check_live_inventory = (
        check_live_inventory
        or fault
        in (
            QUESTION_DELTA_LIVE_ENROLLMENT_FAULT,
            TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT,
            STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT,
        )
    )
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
    elif fault == "accept-collateral-assertion":
        options["accept_collateral_assertion"] = True
    elif fault == "accept-collateral-message":
        options["accept_collateral_message"] = True
    elif fault == VERDICT_INVENTORY_ORPHAN_FAULT:
        pass
    elif fault == FROZEN_MIGRATION_TARGET_FAULT:
        pass
    elif fault == QUESTION_DELTA_LIVE_ENROLLMENT_FAULT:
        pass
    elif fault == TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT:
        pass
    elif fault == STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT:
        pass
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
        (
            "exact Vitest assertion marker without matcher detail",
            failed(message=f"AssertionError: {expected.marker}"),
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
            "matching assertion alongside an unrelated failed assertion",
            SuiteResult(
                False,
                False,
                (
                    *failed().assertions,
                    FailedAssertion(
                        "packages/other/test/unrelated.test.ts",
                        "an unrelated test also fails",
                        ("AssertionError: unrelated collateral failure",),
                    ),
                ),
                (),
                "",
            ),
            expected,
            "wrong-path",
        ),
        (
            "matching marker alongside an unrelated failure message",
            SuiteResult(
                False,
                False,
                (
                    FailedAssertion(
                        expected.file,
                        expected.full_name,
                        (
                            expected.marker,
                            "AssertionError: unrelated collateral failure",
                        ),
                    ),
                ),
                (),
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

    canonical_helper_import = (
        "import { attributeExpectedFailure, attributeReplacedFailure, "
        "requireExpectedFailure } from '@durablerun/core/testing'\n"
    )
    helper_binding_cases = (
        (
            "shadowed canonical import",
            canonical_helper_import
            + "function probe(requireExpectedFailure: (...args: unknown[]) => unknown) {\n"
            "  return requireExpectedFailure("
            "{kind: 'behavior', mutation: 'shadowed-helper'}, /x/, action)\n"
            "}",
            frozenset(),
            "does not resolve to its canonical testing import",
        ),
        (
            "same-spelled local function",
            "function requireExpectedFailure(...args: unknown[]) { return args }\n"
            "requireExpectedFailure("
            "{kind: 'behavior', mutation: 'local-helper'}, /x/, action)",
            frozenset(),
            "does not resolve to its canonical testing import",
        ),
    )

    helper_marker_cases = (
        (
            "exact owned marker",
            "owned-mutation",
            "behavior",
            "mutation-verdict:behavior:owned-mutation",
            frozenset({("behavior", "owned-mutation")}),
            None,
        ),
        (
            "shared marker cannot replace owned marker",
            "owned-mutation",
            "behavior",
            "mutation-verdict:behavior:shared-assertion",
            frozenset({("behavior", "owned-mutation")}),
            "helper descriptor",
        ),
        (
            "direct-only verdict has no helper owner",
            "direct-mutation",
            "behavior",
            "mutation-verdict:behavior:shared-assertion",
            frozenset({("behavior", "other-mutation")}),
            None,
        ),
    )

    direct_marker_cases = (
        (
            "exact string literal",
            "void 'mutation-verdict:construction:probe'",
            frozenset({"mutation-verdict:construction:probe"}),
            (),
            None,
        ),
        (
            "expect-error directive comment",
            "// @ts-expect-error intentional — mutation-verdict:construction:probe\n"
            "consume(invalid)",
            frozenset({"mutation-verdict:construction:probe"}),
            (("mutation-verdict:construction:probe", 1),),
            None,
        ),
        (
            "expect-error block directive",
            "/* @ts-expect-error mutation-verdict:construction:probe */ consume(invalid)",
            frozenset({"mutation-verdict:construction:probe"}),
            (("mutation-verdict:construction:probe", 1),),
            None,
        ),
        (
            "unowned marker comment",
            "// mutation-verdict:construction:probe\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "marker before directive",
            "// mutation-verdict:construction:probe @ts-expect-error intentional\n"
            "consume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "directive string decoy",
            "const text = '@ts-expect-error mutation-verdict:construction:probe'",
            frozenset(),
            (),
            None,
        ),
        (
            "prose-prefixed directive decoy",
            "// prose @ts-expect-error mutation-verdict:construction:probe\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "decorated marker suffix",
            "// @ts-expect-error mutation-verdict:construction:probe: detail\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "decorated marker prefix",
            "// @ts-expect-error not-a-mutation-verdict:construction:probe\n"
            "consume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "uppercase prefix adjacency",
            "// @ts-expect-error Xmutation-verdict:construction:probe\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "uppercase suffix adjacency",
            "// @ts-expect-error mutation-verdict:construction:probeX\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "unicode prefix adjacency",
            "// @ts-expect-error Ωmutation-verdict:construction:probe\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "unicode suffix adjacency",
            "// @ts-expect-error mutation-verdict:construction:probeΩ\nconsume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "multiline marker ownership",
            "/* @ts-expect-error\n"
            "mutation-verdict:construction:probe */\n"
            "consume(invalid)",
            frozenset(),
            (),
            None,
        ),
        (
            "two markers on one directive",
            "// @ts-expect-error mutation-verdict:construction:probe "
            "mutation-verdict:construction:probe\n"
            "consume(invalid)",
            frozenset({"mutation-verdict:construction:probe"}),
            (
                ("mutation-verdict:construction:probe", 1),
                ("mutation-verdict:construction:probe", 1),
            ),
            "directive owns 2 verdict markers",
        ),
        (
            "one marker on two directives",
            "// @ts-expect-error mutation-verdict:construction:probe\n"
            "consume(invalid)\n"
            "// @ts-expect-error mutation-verdict:construction:probe\n"
            "consume(otherInvalid)",
            frozenset({"mutation-verdict:construction:probe"}),
            (
                ("mutation-verdict:construction:probe", 1),
                ("mutation-verdict:construction:probe", 3),
            ),
            "appears on 2 @ts-expect-error directives",
        ),
    )

    question_delta_cases = (
        (
            "same SQL bind shape",
            "same-arity",
            "AND step_name = ?",
            "AND step_name = ? AND status = 'waiting'",
            None,
            None,
        ),
        (
            "equal-count SQL/comment cancellation",
            "cancelled-bind-delta",
            "const sql = flag ? `AND id = ?` : ''",
            "const sql = flag ? `AND 1 = 1` : '' // ?",
            None,
            None,
        ),
        (
            "historical bind-arity mutation",
            "changed-arity",
            "AND w.step_name = ${run}.wake_step)",
            "AND ? IS NOT NULL)",
            None,
            "changes raw question-token count",
        ),
        (
            "declared non-SQL question syntax",
            "typescript-ternary",
            "return value",
            "return value ? left : right",
            "replacement adds a TypeScript ternary, not a SQL placeholder",
            None,
        ),
        (
            "undeclared non-SQL question syntax",
            "undeclared-ternary",
            "return value",
            "return value ? left : right",
            None,
            "changes raw question-token count",
        ),
        (
            "empty question-delta reason",
            "empty-reason",
            "return value",
            "return value ? left : right",
            "  ",
            "non-empty question-delta reason",
        ),
        (
            "stale question-delta reason",
            "stale-reason",
            "return value",
            "return other",
            "no question-token delta remains",
            "stale question-delta reason",
        ),
    )

    live_inventory_marker = "mutation-verdict:behavior:inventory-live"
    orphan_inventory_marker = "mutation-verdict:behavior:inventory-orphan"
    verdict_inventory_cases = (
        (
            "exact live ownership",
            {live_inventory_marker},
            {live_inventory_marker},
            {},
            (),
        ),
        (
            "source marker without live ownership",
            {live_inventory_marker, orphan_inventory_marker},
            {live_inventory_marker},
            {},
            (
                f"source verdict marker {orphan_inventory_marker!r} has no live "
                "ExpectedVerdict or exact exemption",
            ),
        ),
        (
            "exact explained source exemption",
            {orphan_inventory_marker},
            set(),
            {orphan_inventory_marker: "synthetic non-mutation fixture"},
            (),
        ),
        (
            "stale exemption",
            set(),
            set(),
            {orphan_inventory_marker: "synthetic non-mutation fixture"},
            (f"verdict marker exemption {orphan_inventory_marker!r} is stale",),
        ),
        (
            "live marker cannot be exempt",
            {live_inventory_marker},
            {live_inventory_marker},
            {live_inventory_marker: "invalid overlap"},
            (
                f"live ExpectedVerdict marker {live_inventory_marker!r} must not also be exempt",
            ),
        ),
        (
            "exemption reason is mandatory",
            {orphan_inventory_marker},
            set(),
            {orphan_inventory_marker: ""},
            (
                f"verdict marker exemption {orphan_inventory_marker!r} has no non-empty reason",
            ),
        ),
    )
    mutation_target_cases = (
        (
            "ordinary production source",
            "packages/store-libsql/src/store.ts",
            None,
        ),
        (
            "frozen migration source",
            "packages/store-libsql/src/schema.ts",
            "live mutation targets frozen migration history",
        ),
    )
    title_owner_marker = "mutation-verdict:behavior:title-owner-probe"
    title_owner_cases = (
        (
            "nested static owner",
            "import { describe, expect, it } from 'vitest'\n"
            "describe('outer', () => {\n"
            "  describe('inner', () => {\n"
            "    it('owner', () => expect(1, "
            f"'{title_owner_marker}').toBe(1))\n"
            "  })\n"
            "})",
            frozenset({(title_owner_marker, "outer inner owner")}),
            frozenset(),
        ),
        (
            "dynamic test owner",
            "import { describe, expect, it } from 'vitest'\n"
            "const value = 'owner'\n"
            "describe('outer', () => {\n"
            "  it(`dynamic ${value}`, () => expect(1, "
            f"'{title_owner_marker}').toBe(1))\n"
            "})",
            frozenset(),
            frozenset({title_owner_marker}),
        ),
        (
            "same-spelled local registrations",
            "function describe(_title: string, body: () => void) { body() }\n"
            "function it(_title: string, body: () => void) { body() }\n"
            "function expect(_value: unknown, _message: string) {\n"
            "  return { toBe: (_wanted: unknown) => undefined }\n"
            "}\n"
            "describe('outer', () => {\n"
            "  it('owner', () => expect(1, "
            f"'{title_owner_marker}').toBe(1))\n"
            "})",
            frozenset(),
            frozenset(),
        ),
    )
    syntax_sources = {
        "__selftest__/mutation-syntax-valid.ts": "function value() { return 1 }\n",
        "__selftest__/mutation-syntax-invalid.ts": (
            "const value = {\n  sql: `SELECT 1`,\n  args: [],\n}\n"
        ),
        "__selftest__/mutation-syntax-semantic.ts": (
            "import { missing } from 'does-not-exist'\n"
            "const value: NeverDeclared = missing\n"
        ),
    }
    syntax_mutations = [
        Mutation(
            "selftest-typescript-syntax-valid",
            "__selftest__/mutation-syntax-valid.ts",
            "return 1",
            "return 2",
            "synthetic valid syntax mutation",
            expected,
        ),
        Mutation(
            "selftest-typescript-syntax-invalid",
            "__selftest__/mutation-syntax-invalid.ts",
            "sql: `SELECT 1`,",
            "sql: `SELECT 1`",
            "synthetic missing object-property comma",
            expected,
        ),
        Mutation(
            "selftest-typescript-syntax-semantic",
            "__selftest__/mutation-syntax-semantic.ts",
            "NeverDeclared",
            "AnotherMissingType",
            "syntactic validation must ignore semantic resolution",
            expected,
        ),
    ]

    failures = []
    inventory_checker = verdict_inventory_problems
    if fault == VERDICT_INVENTORY_ORPHAN_FAULT:
        inventory_checker = lambda source, live, exemptions: [
            problem
            for problem in verdict_inventory_problems(source, live, exemptions)
            if "has no live ExpectedVerdict" not in problem
        ]
    for label, source, live, exemptions, wanted in verdict_inventory_cases:
        got = tuple(inventory_checker(source, live, exemptions))
        if got != wanted:
            failures.append(
                f"verdict-inventory {label}: expected {wanted!r}, got {got!r}"
            )
    target_checker = mutation_target_diagnostic
    if fault == FROZEN_MIGRATION_TARGET_FAULT:
        target_checker = lambda _file: None
    for label, file, wanted in mutation_target_cases:
        got = target_checker(file)
        if wanted is None:
            if got is not None:
                failures.append(
                    f"mutation-target {label}: expected no diagnostic, got {got!r}"
                )
        elif got is None or wanted not in got:
            failures.append(
                f"mutation-target {label}: expected diagnostic containing {wanted!r}, got {got!r}"
            )
    for label, name, find, replace, reason, wanted in question_delta_cases:
        got = mutation_question_delta_diagnostic(name, find, replace, reason)
        if wanted is None:
            if got is not None:
                failures.append(
                    f"question-delta {label}: expected no diagnostic, got {got!r}"
                )
        elif got is None or wanted not in got:
            failures.append(
                f"question-delta {label}: expected diagnostic containing {wanted!r}, got {got!r}"
            )
    analysis_sources = {
        **{
            f"__selftest__/promise-{index}.ts": source + "\n" + canonical_helper_import
            for index, (_, source, _) in enumerate(promise_message_cases)
        },
        **{
            f"__selftest__/descriptor-{index}.ts": source + "\n" + canonical_helper_import
            for index, (_, source, _) in enumerate(descriptor_cases)
        },
        **{
            f"__selftest__/helper-binding-{index}.ts": source
            for index, (_, source, _, _) in enumerate(helper_binding_cases)
        },
        **{
            f"__selftest__/direct-marker-{index}.ts": source
            for index, (_, source, _, _, _) in enumerate(direct_marker_cases)
        },
        **{
            f"__selftest__/title-owner-{index}.ts": source
            for index, (_, source, _, _) in enumerate(title_owner_cases)
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
    for index, (label, _, wanted, wanted_diagnostic) in enumerate(helper_binding_cases):
        key = f"__selftest__/helper-binding-{index}.ts"
        analysis = analyses.get(key)
        if analysis is None:
            continue
        if not any(wanted_diagnostic in diagnostic for diagnostic in analysis.diagnostics):
            failures.append(
                f"helper-binding {label}: expected diagnostic {wanted_diagnostic!r}, "
                f"got {analysis.diagnostics}"
            )
        if analysis.helper_verdict_descriptors != wanted:
            failures.append(
                f"helper-binding {label}: expected {wanted}, "
                f"got {analysis.helper_verdict_descriptors}"
            )
    for label, name, kind, marker, descriptors, wanted in helper_marker_cases:
        got = helper_owned_marker_diagnostic(name, kind, marker, descriptors)
        if wanted is None:
            if got is not None:
                failures.append(f"helper-marker {label}: expected no diagnostic, got {got}")
        elif got is None or wanted not in got:
            failures.append(
                f"helper-marker {label}: expected diagnostic containing {wanted!r}, got {got!r}"
            )
    for index, (
        label,
        _,
        wanted,
        wanted_expect_error,
        wanted_diagnostic,
    ) in enumerate(direct_marker_cases):
        key = f"__selftest__/direct-marker-{index}.ts"
        analysis = analyses.get(key)
        if analysis is None:
            continue
        if wanted_diagnostic is None and analysis.diagnostics:
            failures.append(
                f"direct-marker {label}: TypeScript parse diagnostics "
                f"{analysis.diagnostics}"
            )
            continue
        if wanted_diagnostic is not None and not any(
            wanted_diagnostic in diagnostic for diagnostic in analysis.diagnostics
        ):
            failures.append(
                f"direct-marker {label}: expected diagnostic {wanted_diagnostic!r}, "
                f"got {analysis.diagnostics}"
            )
        got = analysis.direct_verdict_markers
        if got != wanted:
            failures.append(f"direct-marker {label}: expected {wanted}, got {got}")
        if analysis.expect_error_verdict_markers != wanted_expect_error:
            failures.append(
                f"direct-marker {label}: expected directive ownership "
                f"{wanted_expect_error}, got {analysis.expect_error_verdict_markers}"
            )
    for index, (label, _, wanted_owners, wanted_dynamic) in enumerate(
        title_owner_cases
    ):
        key = f"__selftest__/title-owner-{index}.ts"
        analysis = analyses.get(key)
        if analysis is None:
            continue
        if analysis.diagnostics:
            failures.append(
                f"title-owner {label}: TypeScript diagnostics {analysis.diagnostics}"
            )
            continue
        if analysis.behavior_verdict_title_owners != wanted_owners:
            failures.append(
                f"title-owner {label}: expected owners {wanted_owners}, "
                f"got {analysis.behavior_verdict_title_owners}"
            )
        if analysis.dynamic_behavior_verdict_title_markers != wanted_dynamic:
            failures.append(
                f"title-owner {label}: expected dynamic markers {wanted_dynamic}, "
                f"got {analysis.dynamic_behavior_verdict_title_markers}"
            )

    live_syntax_mutations: list[Mutation] = []
    if check_live_inventory:
        injected_syntax_fault = False
        for mutation in MUTATIONS:
            if Path(mutation.file).suffix not in {".ts", ".tsx"}:
                continue
            syntax_mutation = mutation
            if (
                fault == TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT
                and not injected_syntax_fault
            ):
                syntax_mutation = Mutation(
                    mutation.name,
                    mutation.file,
                    mutation.find,
                    mutation.replace + "\n      const =\n",
                    mutation.breaks,
                    mutation.verdict,
                    mutation.typecheck_project,
                )
                injected_syntax_fault = True
            live_syntax_mutations.append(syntax_mutation)
            syntax_sources.setdefault(
                mutation.file, (ROOT / mutation.file).read_text()
            )
    all_syntax_mutations = [*syntax_mutations, *live_syntax_mutations]
    try:
        syntax_analyses = analyze_typescript_mutation_syntax(
            syntax_sources, all_syntax_mutations
        )
    except ValueError as error:
        failures.append(str(error))
        syntax_analyses = {}
    for mutation in syntax_mutations:
        analysis = syntax_analyses.get(mutation.name)
        if analysis is None:
            continue
        if analysis.materialization_error is not None:
            failures.append(
                f"mutant-syntax {mutation.name}: {analysis.materialization_error}"
            )
            continue
        invalid = mutation.name == "selftest-typescript-syntax-invalid"
        if invalid != bool(analysis.diagnostics):
            failures.append(
                f"mutant-syntax {mutation.name}: expected diagnostics={invalid}, "
                f"got {analysis.diagnostics}"
            )
    for mutation in live_syntax_mutations:
        analysis = syntax_analyses.get(mutation.name)
        if analysis is None:
            continue
        if analysis.materialization_error is not None:
            failures.append(
                f"{mutation.name}: cannot generate TypeScript mutant: "
                f"{analysis.materialization_error}"
            )
        elif analysis.diagnostics:
            failures.append(
                f"{mutation.name}: generated TypeScript mutant has parse diagnostics "
                f"{analysis.diagnostics}"
            )
    if check_live_inventory:
        if TEST_CMD[:3] != ["pnpm", "exec", "vitest"]:
            failures.append("worker suites do not execute Vitest directly")
        if TYPECHECK_CMD != [
            "pnpm",
            "exec",
            "tsc",
            "-p",
            "packages/store-libsql/tsconfig.json",
            "--noEmit",
        ]:
            failures.append(
                "store-libsql construction mutations do not execute their pinned TypeScript project"
            )
        if CONFORMANCE_TYPECHECK_CMD != [
            "pnpm",
            "exec",
            "tsc",
            "-p",
            "packages/conformance/tsconfig.json",
            "--noEmit",
        ]:
            failures.append(
                "conformance construction mutations do not execute their pinned TypeScript project"
            )
        if TYPECHECK_PROJECT_ORDER != ("store-libsql", "conformance"):
            failures.append("construction-mutation projects do not have their canonical order")
        if (
            typecheck_command("store-libsql") is not TYPECHECK_CMD
            or typecheck_command("conformance") is not CONFORMANCE_TYPECHECK_CMD
        ):
            failures.append("construction-mutation command routing has a second representation")
        selected_typecheck = {
            mutation.name: mutation.typecheck_project
            for mutation in MUTATIONS
            if mutation.typecheck_project is not None
        }
        if selected_typecheck != TYPECHECK_MUTATION_PROJECTS:
            failures.append(
                "the construction-mutation verifier inventory differs from its canonical projects"
            )
        if len(MUTATIONS) != 419:
            failures.append("the live mutation inventory cardinality changed")
        if (
            len(STORE_LIBSQL_TYPECHECK_MUTATION_NAMES) != 18
            or len(CONFORMANCE_TYPECHECK_MUTATION_NAMES) != 25
            or len(TYPECHECK_MUTATION_NAMES) != 43
        ):
            failures.append("the construction-mutation project inventory cardinality changed")
        if any(
            mutation.typecheck_project is not None
            and mutation.verdict.kind != "construction"
            for mutation in MUTATIONS
        ):
            failures.append("a typecheck mutation is attributed as a behavioral verdict")
        mutation_by_name = {mutation.name: mutation for mutation in MUTATIONS}
        store_typecheck = mutation_by_name["generated-update-requires-target"]
        conformance_typecheck = mutation_by_name["poison-profile-claim-pending"]
        routing_cases = (
            ("store-only", [store_typecheck], ("store-libsql",)),
            ("conformance-only", [conformance_typecheck], ("conformance",)),
            (
                "mixed-reversed",
                [conformance_typecheck, store_typecheck],
                ("store-libsql", "conformance"),
            ),
        )
        for label, mutations, expected_projects in routing_cases:
            if mutation_typecheck_projects(mutations) != expected_projects:
                failures.append(f"{label} construction-mutation project routing changed")
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
        mutation_names = {mutation.name for mutation in MUTATIONS}
        for stale_name in sorted(set(QUESTION_TOKEN_DELTA_REASONS) - mutation_names):
            failures.append(
                f"{stale_name}: question-delta reason names no live mutation"
            )
        for stale_name in sorted(
            set(DYNAMIC_BEHAVIOR_VERDICT_TITLE_REASONS) - mutation_names
        ):
            failures.append(
                f"{stale_name}: dynamic-title reason names no live mutation"
            )
        for mutation in MUTATIONS:
            source = (ROOT / mutation.file).read_text()
            occurrences = source.count(mutation.find)
            if occurrences != 1:
                failures.append(
                    f"{mutation.name}: mutation pattern occurs {occurrences} times; expected exactly one"
                )
            target_diagnostic = mutation_target_diagnostic(mutation.file)
            if target_diagnostic is not None:
                failures.append(f"{mutation.name}: {target_diagnostic}")
            question_delta_reason = QUESTION_TOKEN_DELTA_REASONS.get(mutation.name)
            if fault == QUESTION_DELTA_LIVE_ENROLLMENT_FAULT:
                question_delta_reason = None
            question_delta_diagnostic = mutation_question_delta_diagnostic(
                mutation.name,
                mutation.find,
                mutation.replace,
                question_delta_reason,
            )
            if question_delta_diagnostic is not None:
                failures.append(question_delta_diagnostic)
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
            ownership_diagnostic = helper_owned_marker_diagnostic(
                mutation.name,
                mutation.verdict.kind,
                mutation.verdict.marker,
                descriptors,
            )
            if ownership_diagnostic is not None:
                failures.append(ownership_diagnostic)
            if marker_analysis is not None:
                title_verdict = mutation.verdict
                if (
                    fault == STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT
                    and mutation.name == "sdk-owned-retry-attempt"
                ):
                    title_verdict = ExpectedVerdict(
                        mutation.verdict.kind,
                        mutation.verdict.file,
                        mutation.verdict.full_name + " injected-stale-title",
                        mutation.verdict.marker,
                        mutation.verdict.marker_file,
                    )
                title_diagnostic = behavioral_verdict_title_diagnostic(
                    mutation.name,
                    title_verdict,
                    marker_analysis,
                    DYNAMIC_BEHAVIOR_VERDICT_TITLE_REASONS.get(mutation.name),
                )
                if title_diagnostic is not None:
                    failures.append(title_diagnostic)
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
        source_verdict_markers: set[str] = set()
        for path in live_paths:
            relative = str(path.relative_to(ROOT))
            analysis = analyses.get(relative)
            if analysis is None:
                continue
            source_verdict_markers.update(analysis.direct_verdict_markers)
            source_verdict_markers.update(
                f"mutation-verdict:{kind}:{name}"
                for kind, name in analysis.helper_verdict_descriptors
            )
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
        failures.extend(
            inventory_checker(
                source_verdict_markers,
                {mutation.verdict.marker for mutation in MUTATIONS},
                VERDICT_MARKER_EXEMPTIONS,
            )
        )
    for label, result, verdict, wanted in cases:
        got = classify_verdict(result, verdict, matcher, **options)
        if got != wanted:
            failures.append(f"{label}: expected {wanted}, got {got}")
    live_enrollment_faults = (
        QUESTION_DELTA_LIVE_ENROLLMENT_FAULT,
        TYPESCRIPT_MUTANT_SYNTAX_LIVE_ENROLLMENT_FAULT,
        STATIC_VERDICT_TITLE_LIVE_ENROLLMENT_FAULT,
    )
    if not failures and fault is None and check_live_inventory:
        for injected_fault in live_enrollment_faults:
            result = subprocess.run(
                [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--classifier-self-test",
                    "--self-test-fault",
                    injected_fault,
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            marker = (
                "mutation-probe self-test caught injected fault "
                f"{injected_fault}"
            )
            if result.returncode != 1 or marker not in (result.stdout + result.stderr):
                failures.append(
                    f"the live enrollment fault {injected_fault} was not rejected "
                    "through its canonical CLI path"
                )
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
        f"{len(descriptor_cases)} descriptor cases, "
        f"{len(helper_binding_cases)} helper-binding cases, "
        f"{len(helper_marker_cases)} helper-marker cases, "
        f"{len(direct_marker_cases)} direct-marker cases, "
        f"{len(title_owner_cases)} title-owner cases, "
        f"{len(verdict_inventory_cases)} verdict-inventory cases, "
        f"{len(question_delta_cases)} question-delta cases, "
        f"{len(syntax_mutations)} mutant-syntax cases, "
        f"{len(live_enrollment_faults)} live-enrollment faults, "
        f"{len(MUTATIONS)} live mutations"
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
    tasks_max: int


@dataclass(frozen=True)
class IsolatedWorkspace:
    root: Path


@dataclass(frozen=True)
class InheritedAuditLock:
    path: Path
    fd: int
    device: int
    inode: int


@dataclass(frozen=True)
class WorkerAuthority:
    run_root: Path
    worker_root: Path
    worker_id: int
    head: str
    nonce: str
    audit_lock: InheritedAuditLock


@dataclass(frozen=True)
class BaselineBarrier:
    head: str
    worker_ids: tuple[int, ...]
    digest: str


ORCHESTRATION_SELF_TEST_FAULTS = (
    "drop-assignment",
    "duplicate-assignment",
    "drop-audit-lock-inheritance",
    "drop-verifier-lock-inheritance",
    "accept-wrong-head",
    "accept-wrong-nonce",
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
    "accept-unlimited-task-scope",
    "accept-oversized-task-scope",
    "classify-missing-report-as-domain",
    "leave-zombie-group",
    "classify-malformed-report-as-domain",
    "classify-structural-report-as-domain",
    "accept-wrong-registry",
    "accept-incomplete-worker",
    "use-worker-local-pnpm-store",
    "accept-failed-pnpm-store-query",
    "accept-multiline-pnpm-store",
    "accept-relative-pnpm-store",
    "accept-missing-pnpm-store",
    "allow-online-worker-install",
    "allow-unfrozen-worker-install",
    "replace-worker-install-command",
    "allow-host-sized-tokio-pools",
    "allow-worker-bytecode-artifacts",
)


ROUTING_SELF_TEST_EXPECTED_DIAGNOSTICS = {
    "skip-store-typecheck": (
        "store baseline: expected verifier trace "
        "['vitest', 'tsc:store-libsql'], observed ['vitest']"
    ),
    "misroute-store-typecheck": (
        "store baseline: expected verifier trace "
        "['vitest', 'tsc:store-libsql'], observed "
        "['vitest', 'tsc:conformance']"
    ),
    "duplicate-store-typecheck": (
        "store baseline: expected verifier trace "
        "['vitest', 'tsc:store-libsql'], observed "
        "['vitest', 'tsc:store-libsql', 'tsc:store-libsql']"
    ),
    "skip-conformance-typecheck": (
        "conformance baseline: expected verifier trace "
        "['vitest', 'tsc:conformance'], observed ['vitest']"
    ),
    "misroute-conformance-typecheck": (
        "conformance baseline: expected verifier trace "
        "['vitest', 'tsc:conformance'], observed "
        "['vitest', 'tsc:store-libsql']"
    ),
    "duplicate-conformance-typecheck": (
        "conformance baseline: expected verifier trace "
        "['vitest', 'tsc:conformance'], observed "
        "['vitest', 'tsc:conformance', 'tsc:conformance']"
    ),
    "skip-vitest": (
        "behavior baseline: expected verifier trace ['vitest'], observed []"
    ),
    "reverse-typecheck-project-order": (
        "mixed baseline: expected verifier trace "
        "['vitest', 'tsc:store-libsql', 'tsc:conformance'], observed "
        "['vitest', 'tsc:conformance', 'tsc:store-libsql']"
    ),
    "typecheck-behavior-only": (
        "behavior baseline: expected verifier trace ['vitest'], observed "
        "['vitest', 'tsc:store-libsql']"
    ),
    "typecheck-vitest-construction-baseline": (
        "Vitest construction baseline: expected verifier trace ['vitest'], "
        "observed ['vitest', 'tsc:store-libsql']"
    ),
    "continue-after-vitest-red": (
        "vitest-red baseline: expected verifier trace ['vitest:red'], observed "
        "['vitest:red', 'tsc:store-libsql', 'tsc:conformance']"
    ),
    "continue-after-store-typecheck-red": (
        "store-red baseline: expected verifier trace "
        "['vitest', 'tsc:store-libsql:red'], observed "
        "['vitest', 'tsc:store-libsql:red', 'tsc:conformance']"
    ),
    "accept-conformance-typecheck-red": (
        "conformance-red baseline: expected status 2, observed 0"
    ),
    "misroute-conformance-mutation": (
        "conformance mutation dispatch: expected verifier trace "
        "['tsc:conformance'], observed ['tsc:store-libsql']"
    ),
    "misroute-store-mutation": (
        "store mutation dispatch: expected verifier trace "
        "['tsc:store-libsql'], observed ['tsc:conformance']"
    ),
    "typecheck-behavior-mutation": (
        "behavior mutation dispatch: expected verifier trace "
        "['vitest'], observed ['tsc:store-libsql']"
    ),
    "typecheck-vitest-construction-mutation": (
        "Vitest construction mutation dispatch: expected verifier trace "
        "['vitest'], observed ['tsc:store-libsql']"
    ),
    "omit-typecheck-project-from-registry-digest": (
        "registry digest did not change when only typecheck_project changed"
    ),
}
ROUTING_SELF_TEST_FAULTS = tuple(ROUTING_SELF_TEST_EXPECTED_DIAGNOSTICS)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def expected_verdict(mutation: Mutation) -> str:
    return (
        f"{mutation.verdict.kind} {mutation.verdict.file} > "
        f"{mutation.verdict.full_name} containing {mutation.verdict.marker!r}"
    )


def mutation_registry_digest(
    *,
    omit_typecheck_project: bool = False,
) -> str:
    payload = [
        {
            "name": mutation.name,
            "file": mutation.file,
            "find": mutation.find,
            "replace": mutation.replace,
            "breaks": mutation.breaks,
            "typecheck_project": (
                None if omit_typecheck_project else mutation.typecheck_project
            ),
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
    nonce: str,
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
        "nonce": nonce,
        "worker_id": worker_id,
        "assigned": [item.name for item in assigned],
        "complete": complete,
        "results": results,
    }


def validate_mutation_report(
    payload: object,
    *,
    head: str,
    nonce: str,
    worker_id: int,
    expected: list[ExpectedMutationResult],
    process_returncode: int | None,
    allow_partial: bool = False,
    accept_wrong_head: bool = False,
    accept_wrong_nonce: bool = False,
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
        "nonce",
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
        not accept_wrong_nonce
        and (not isinstance(payload["nonce"], str) or payload["nonce"] != nonce)
    ):
        raise ValueError("worker mutation report names the wrong coordinator nonce")
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
    if not isinstance(payload["complete"], bool):
        raise ValueError("worker mutation report has a non-boolean completion state")
    if (
        payload["complete"] is not True
        and not allow_partial
        and not accept_incomplete
    ):
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
    if missing and not allow_partial and not accept_missing_result:
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
    if allow_partial:
        expected_prefix = [item.name for item in expected[: len(observed_order)]]
        if observed_order != expected_prefix:
            raise ValueError("worker mutation checkpoint is not a completed shard prefix")
        should_be_complete = len(observed_order) == len(expected)
        if payload["complete"] is not should_be_complete:
            raise ValueError(
                "worker mutation checkpoint completion disagrees with its result prefix"
            )
    expected_returncode = (
        0
        if len(seen) == len(expected) and all(row["outcome"] == "caught" for row in known_rows)
        else 1
    )
    if (
        process_returncode is not None
        and not accept_process_disagreement
        and process_returncode != expected_returncode
    ):
        raise ValueError(
            "worker process/report disagreement: "
            f"exit={process_returncode}, report expects {expected_returncode}"
        )
    return rows


def git_common_directory(root: Path) -> Path:
    common_dir = Path(git_output(root, "rev-parse", "--git-common-dir"))
    if not common_dir.is_absolute():
        common_dir = root / common_dir
    return common_dir.resolve()


def mutation_checkpoint_identity(
    head: str,
    shards: list[list[str]],
) -> dict[str, object]:
    return {
        "version": REPORT_VERSION,
        "head": head,
        "registry_digest": mutation_registry_digest(),
        "shards": shards,
    }


def mutation_checkpoint_key(
    head: str,
    shards: list[list[str]],
) -> str:
    return hashlib.sha256(
        json.dumps(
            mutation_checkpoint_identity(head, shards),
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()


def mutation_checkpoint_report_path(
    common_dir: Path,
    checkpoint_key: str,
    worker_id: int,
) -> Path:
    if re.fullmatch(r"[0-9a-f]{64}", checkpoint_key) is None or worker_id < 0:
        raise ValueError("mutation checkpoint has an invalid deterministic identity")
    return (
        common_dir.resolve()
        / MUTATION_CHECKPOINT_DIRECTORY
        / checkpoint_key
        / f"mutations-{worker_id:02}.json"
    )


def prepare_mutation_checkpoint_directory(
    common_dir: Path,
    checkpoint_key: str,
) -> Path:
    report = mutation_checkpoint_report_path(common_dir, checkpoint_key, 0)
    checkpoint_root = report.parent.parent
    checkpoint_directory = report.parent
    for path in (checkpoint_root, checkpoint_directory):
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError(f"mutation checkpoint directory is not owned storage: {path}")
        path.mkdir(mode=0o700, exist_ok=True)
        if path.resolve() != path:
            raise ValueError(f"mutation checkpoint directory escapes Git storage: {path}")
    return checkpoint_directory


def validate_mutation_checkpoint_path(
    common_dir: Path,
    checkpoint_key: str,
    worker_id: int,
    report_path: Path,
) -> None:
    expected = mutation_checkpoint_report_path(
        common_dir,
        checkpoint_key,
        worker_id,
    )
    checkpoint_root = expected.parent.parent
    checkpoint_directory = expected.parent
    if (
        checkpoint_root.is_symlink()
        or checkpoint_directory.is_symlink()
        or report_path.is_symlink()
        or checkpoint_root.resolve() != checkpoint_root
        or checkpoint_directory.resolve() != checkpoint_directory
        or report_path.resolve() != expected.resolve()
    ):
        raise ValueError("worker mutation checkpoint path is not coordinator-owned")


def discover_mutation_checkpoint_nonce(
    checkpoint_directory: Path,
    report_paths: list[Path],
    shards: list[list[ExpectedMutationResult]],
    *,
    head: str,
) -> str:
    if len(report_paths) != len(shards):
        raise ValueError("mutation checkpoint inventory differs from its shards")
    shard_names = [[item.name for item in shard] for shard in shards]
    identity = mutation_checkpoint_identity(head, shard_names)
    manifest_path = checkpoint_directory / "audit.json"
    if manifest_path.is_symlink():
        raise ValueError("mutation checkpoint manifest cannot be a symbolic link")
    if manifest_path.exists():
        manifest = read_json(manifest_path)
        required = {*identity, "kind", "nonce"}
        if (
            not isinstance(manifest, dict)
            or set(manifest) != required
            or manifest.get("kind") != "durablerun-mutation-checkpoint"
            or any(manifest.get(field) != value for field, value in identity.items())
            or not isinstance(manifest.get("nonce"), str)
            or not manifest["nonce"]
        ):
            raise ValueError("mutation checkpoint manifest has the wrong identity")
        nonce = str(manifest["nonce"])
    else:
        if any(report_path.exists() for report_path in report_paths):
            raise ValueError("mutation checkpoint results have no ownership manifest")
        nonce = secrets.token_hex(16)
        atomic_json(
            manifest_path,
            {
                **identity,
                "kind": "durablerun-mutation-checkpoint",
                "nonce": nonce,
            },
        )
    for worker_id, (report_path, shard) in enumerate(zip(report_paths, shards)):
        if not report_path.exists():
            continue
        if report_path.is_symlink():
            raise ValueError("worker mutation checkpoint cannot be a symbolic link")
        payload = read_json(report_path)
        candidate = payload.get("nonce") if isinstance(payload, dict) else None
        if not isinstance(candidate, str) or not candidate:
            raise ValueError("worker mutation checkpoint has no coordinator nonce")
        validate_mutation_report(
            payload,
            head=head,
            nonce=candidate,
            worker_id=worker_id,
            expected=shard,
            process_returncode=None,
            allow_partial=True,
        )
        if nonce != candidate:
            raise ValueError("worker mutation checkpoint has the wrong coordinator nonce")
    return nonce


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
    tasks_max: str | None = None,
    configured_tasks: str | None = None,
    host_memory: int,
    host_cpus: int,
    accept_unconfined: bool = False,
    accept_oversized_memory: bool = False,
    accept_oversized_cpu: bool = False,
    accept_unlimited_tasks: bool = False,
    accept_oversized_tasks: bool = False,
) -> tuple[int, int, int]:
    try:
        memory = int(memory_max)
        swap = int(swap_max)
        quota_text, period_text = cpu_max.split()
        quota = int(quota_text)
        period = int(period_text)
    except (ValueError, TypeError) as error:
        if accept_unconfined:
            return (1, 1, 1)
        raise ValueError("mutation audit is not inside finite cgroup limits") from error
    if memory <= 0 or swap != 0 or quota <= 0 or period <= 0:
        if accept_unconfined:
            return (max(1, memory), max(1, quota), 1)
        raise ValueError(
            "mutation audit cgroup must have finite positive memory/CPU and zero swap"
        )
    try:
        tasks = int(tasks_max or "")
        configured = int(configured_tasks or "")
    except (ValueError, TypeError) as error:
        if accept_unlimited_tasks:
            tasks = configured = 1
        else:
            raise ValueError(
                "mutation audit cgroup must have a finite task limit exported by confine.sh"
            ) from error
    if tasks <= 0 or configured <= 0:
        if accept_unlimited_tasks:
            tasks = configured = 1
        else:
            raise ValueError(
                "mutation audit cgroup must have positive live and configured task limits"
            )
    if tasks > configured and not accept_oversized_tasks:
        raise ValueError(
            "mutation audit cgroup task limit exceeds the policy exported by confine.sh"
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
    return memory, quota, tasks


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
        tasks_text = (scope / "pids.max").read_text().strip()
    except (OSError, ValueError) as error:
        raise ValueError(f"mutation audit cannot inspect cgroup {cgroup}") from error
    memory, quota, tasks = validate_scope_limits(
        memory_text,
        swap_text,
        cpu_text,
        tasks_max=tasks_text,
        configured_tasks=os.environ.get("CONFINE_TASKS"),
        host_memory=host_memory_bytes(),
        host_cpus=host_cpu_count(),
        accept_unconfined=accept_unconfined,
    )
    return ConfinedScope(cgroup, memory, quota, tasks)


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


def prove_inherited_audit_lock(
    lock_path: Path,
    audit_lock_fd: int,
) -> InheritedAuditLock:
    """Authenticate the exact inherited open-file description that owns the lock."""
    if type(audit_lock_fd) is not int or audit_lock_fd < 0:
        raise ValueError("worker audit-lock descriptor is invalid")
    resolved_path = lock_path.resolve()
    try:
        descriptor_stat = os.fstat(audit_lock_fd)
        path_stat = resolved_path.stat()
        inheritable = os.get_inheritable(audit_lock_fd)
    except OSError as error:
        raise ValueError("worker audit-lock descriptor is not open") from error
    if (
        descriptor_stat.st_dev != path_stat.st_dev
        or descriptor_stat.st_ino != path_stat.st_ino
    ):
        raise ValueError("worker audit-lock descriptor names the wrong file")
    if not inheritable:
        raise ValueError("worker audit-lock descriptor was not inherited across exec")

    contender = resolved_path.open("a+")
    try:
        try:
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            fcntl.flock(contender, fcntl.LOCK_UN)
            raise ValueError("worker audit-lock file is not held")
    finally:
        contender.close()
    try:
        # This succeeds only for the inherited locked open-file description;
        # a second descriptor for a lock held elsewhere would conflict.
        fcntl.flock(audit_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise ValueError(
            "worker audit-lock descriptor does not own the held lock"
        ) from error
    return InheritedAuditLock(
        resolved_path,
        audit_lock_fd,
        descriptor_stat.st_dev,
        descriptor_stat.st_ino,
    )


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
    audit_lock_fd: int,
    audit_lock_path: Path,
    accept_unowned: bool = False,
) -> WorkerAuthority:
    audit_lock = prove_inherited_audit_lock(
        audit_lock_path,
        audit_lock_fd,
    )
    if accept_unowned:
        return WorkerAuthority(
            run_root.resolve(),
            worker_root.resolve(),
            worker_id,
            head,
            nonce,
            audit_lock,
        )
    validate_owned_worktree_path(run_root, worker_root)
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
        or any(
            not isinstance(shard, list)
            or any(not isinstance(name, str) for name in shard)
            for shard in shards
        )
        or worker_id < 0
        or worker_id >= len(worktrees)
        or worker_id >= len(shards)
        or worktrees[worker_id] != str(worker_root)
        or shards[worker_id] != mutation_names
        or Path(str(payload["source_root"])).resolve() == worker_root.resolve()
    ):
        raise ValueError("worker ownership manifest does not authorize this process")
    if phase == "baseline":
        expected_report = run_root / f"baseline-{worker_id:02}.json"
        if report_path.resolve() != expected_report.resolve():
            raise ValueError("worker baseline result path is not coordinator-owned")
    else:
        checkpoint_key = mutation_checkpoint_key(head, shards)
        validate_mutation_checkpoint_path(
            git_common_directory(worker_root),
            checkpoint_key,
            worker_id,
            report_path,
        )
    return WorkerAuthority(
        run_root.resolve(),
        worker_root.resolve(),
        worker_id,
        head,
        nonce,
        audit_lock,
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
    allow_online: bool = False,
    allow_unfrozen: bool = False,
    replace_command: bool = False,
) -> tuple[str, ...]:
    if not store.is_absolute():
        raise ValueError("the canonical pnpm store path must be absolute")
    command = ["npm", "install"] if replace_command else ["pnpm", "install"]
    if not allow_online:
        command.append("--offline")
    if not allow_unfrozen:
        command.append("--frozen-lockfile")
    if not use_worker_default:
        command.extend(("--store-dir", str(store)))
    return tuple(command)


def pnpm_store_from_result(
    result: subprocess.CompletedProcess[str],
    *,
    accept_failed_query: bool = False,
    accept_multiline: bool = False,
    accept_relative: bool = False,
    accept_missing: bool = False,
) -> Path:
    output = result.stdout.strip()
    if result.returncode != 0 and not accept_failed_query:
        diagnostic = (result.stdout + result.stderr).strip()
        raise RuntimeError(
            f"cannot resolve the coordinator's pnpm store: {diagnostic[:500]}"
        )
    if (not output or "\n" in output) and not accept_multiline:
        raise RuntimeError(
            "cannot resolve the coordinator's pnpm store: "
            f"expected one path, observed {output!r}"
        )
    store = Path(output)
    if not store.is_absolute() and not accept_relative:
        raise RuntimeError(
            "cannot resolve the coordinator's pnpm store: "
            f"pnpm returned non-absolute path {output!r}"
        )
    resolved = store.resolve()
    if not resolved.is_dir() and not accept_missing:
        raise RuntimeError(
            f"the coordinator's pnpm store does not exist: {resolved}"
        )
    return resolved


def resolve_pnpm_store(root: Path) -> Path:
    result = subprocess.run(
        ["pnpm", "store", "path"],
        cwd=root,
        capture_output=True,
        text=True,
    )
    return pnpm_store_from_result(result)


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
        nonce="fixture-nonce",
        worker_id=2,
        assigned=assigned,
        results=good_rows,
        complete=True,
    )
    try:
        validate_mutation_report(
            good,
            head="a" * 40,
            nonce="fixture-nonce",
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
                nonce="fixture-nonce",
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
    wrong_nonce = json.loads(json.dumps(good))
    wrong_nonce["nonce"] = "wrong-nonce"
    expect_rejected(
        "wrong nonce",
        wrong_nonce,
        accept_wrong_nonce=fault == "accept-wrong-nonce",
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
        if fault in (None, "drop-audit-lock-inheritance"):
            failures.extend(
                audit_lock_inheritance_problems(
                    temporary,
                    drop_inheritance=fault == "drop-audit-lock-inheritance",
                )
            )
        if fault in (None, "drop-verifier-lock-inheritance"):
            failures.extend(
                verifier_lock_inheritance_problems(
                    temporary,
                    drop_inheritance=fault
                    == "drop-verifier-lock-inheritance",
                )
            )
        canonical_store = temporary / "canonical-pnpm-store"
        canonical_store.mkdir()
        valid_store_result = subprocess.CompletedProcess(
            ("pnpm", "store", "path"),
            0,
            f"{canonical_store}\n",
            "",
        )
        if fault is None:
            try:
                resolved_store = pnpm_store_from_result(valid_store_result)
            except RuntimeError as error:
                failures.append(f"valid pnpm store rejected: {error}")
            else:
                if resolved_store != canonical_store:
                    failures.append("valid pnpm store resolved to the wrong path")

        multiline_store = temporary / "multiline\nstore"
        multiline_store.mkdir()
        relative_store = os.path.relpath(canonical_store, Path.cwd())
        resolver_faults = (
            (
                "accept-failed-pnpm-store-query",
                subprocess.CompletedProcess(
                    ("pnpm", "store", "path"),
                    1,
                    f"{canonical_store}\n",
                    "query failed",
                ),
                {"accept_failed_query": True},
                "failed pnpm store query",
            ),
            (
                "accept-multiline-pnpm-store",
                subprocess.CompletedProcess(
                    ("pnpm", "store", "path"),
                    0,
                    f"{multiline_store}\n",
                    "",
                ),
                {"accept_multiline": True},
                "multiline pnpm store output",
            ),
            (
                "accept-relative-pnpm-store",
                subprocess.CompletedProcess(
                    ("pnpm", "store", "path"),
                    0,
                    f"{relative_store}\n",
                    "",
                ),
                {"accept_relative": True},
                "relative pnpm store path",
            ),
            (
                "accept-missing-pnpm-store",
                subprocess.CompletedProcess(
                    ("pnpm", "store", "path"),
                    0,
                    f"{temporary / 'missing-store'}\n",
                    "",
                ),
                {"accept_missing": True},
                "missing pnpm store path",
            ),
        )
        for fault_name, result, weakness, label in resolver_faults:
            if fault not in (None, fault_name):
                continue
            try:
                pnpm_store_from_result(
                    result,
                    **(weakness if fault == fault_name else {}),
                )
            except RuntimeError:
                pass
            else:
                failures.append(f"dependency store: {label} was accepted")
        if fault is None:
            try:
                pnpm_store_from_result(
                    subprocess.CompletedProcess(
                        ("pnpm", "store", "path"),
                        0,
                        "\n",
                        "",
                    )
                )
            except RuntimeError:
                pass
            else:
                failures.append("dependency store: empty pnpm store output was accepted")

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
        fixture_audit_lock = (temporary / "fixture-audit.lock").open("a+")
        fcntl.flock(fixture_audit_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.set_inheritable(fixture_audit_lock.fileno(), True)
        fixture_audit_lock_fd = fixture_audit_lock.fileno()
        install_faults = (
            "use-worker-local-pnpm-store",
            "allow-online-worker-install",
            "allow-unfrozen-worker-install",
            "replace-worker-install-command",
        )
        if fault is None or fault in install_faults:
            install_launch = worker_install_launch(
                environment_plan,
                canonical_store,
                audit_lock_fd=fixture_audit_lock_fd,
                use_worker_default=fault == "use-worker-local-pnpm-store",
                allow_online=fault == "allow-online-worker-install",
                allow_unfrozen=fault == "allow-unfrozen-worker-install",
                replace_command=fault == "replace-worker-install-command",
            )
            expected_install_command = (
                "pnpm",
                "install",
                "--offline",
                "--frozen-lockfile",
                "--store-dir",
                str(canonical_store),
            )
            if install_launch.command != expected_install_command:
                failures.append(
                    "dependency store: worker install launch does not use "
                    "the exact offline frozen canonical-store command"
                )
            if install_launch.inherited_fds != (fixture_audit_lock_fd,):
                failures.append(
                    "dependency store: install worker does not inherit audit ownership"
                )

        launch_environment_faults = (
            "allow-host-sized-tokio-pools",
            "allow-worker-bytecode-artifacts",
        )
        if fault is None or fault in launch_environment_faults:
            inherited_tokio_threads = os.environ.get("TOKIO_WORKER_THREADS")
            inherited_bytecode = os.environ.get("PYTHONDONTWRITEBYTECODE")
            os.environ["TOKIO_WORKER_THREADS"] = "1"
            os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
            try:
                environment_launch = worker_launch(
                    environment_plan,
                    audit_lock_fd=fixture_audit_lock_fd,
                    phase="baseline",
                    head="a" * 40,
                    max_workers=1,
                    run_root=run_root,
                    nonce="fixture-nonce",
                    baseline_barrier=None,
                    allow_host_sized_tokio=(
                        fault == "allow-host-sized-tokio-pools"
                    ),
                    allow_python_bytecode=(
                        fault == "allow-worker-bytecode-artifacts"
                    ),
                )
                environment = environment_launch.environment
            finally:
                if inherited_tokio_threads is None:
                    os.environ.pop("TOKIO_WORKER_THREADS", None)
                else:
                    os.environ["TOKIO_WORKER_THREADS"] = inherited_tokio_threads
                if inherited_bytecode is None:
                    os.environ.pop("PYTHONDONTWRITEBYTECODE", None)
                else:
                    os.environ["PYTHONDONTWRITEBYTECODE"] = inherited_bytecode
            if environment.get("TOKIO_WORKER_THREADS") != "1":
                failures.append(
                    "native thread budget: worker suites can create "
                    "host-sized Tokio pools"
                )
            if environment.get("PYTHONDONTWRITEBYTECODE") != "1":
                failures.append(
                    "worker cleanliness: Python imports can create bytecode "
                    "artifacts before mutation"
                )
            if environment_launch.inherited_fds != (fixture_audit_lock_fd,):
                failures.append(
                    "worker launch does not inherit repository audit ownership"
                )
            audit_lock_option = "--worker-audit-lock-fd"
            if (
                environment_launch.command.count(audit_lock_option) != 1
                or environment_launch.command[
                    environment_launch.command.index(audit_lock_option) + 1
                ]
                != str(fixture_audit_lock_fd)
            ):
                failures.append(
                    "worker launch does not assign its inherited audit-lock descriptor"
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
                audit_lock_fd=fixture_audit_lock_fd,
                audit_lock_path=Path(fixture_audit_lock.name),
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
                audit_lock_fd=fixture_audit_lock_fd,
                audit_lock_path=Path(fixture_audit_lock.name),
                accept_unowned=fault == "accept-unowned-worker",
            )
        except ValueError:
            pass
        else:
            failures.append("unowned worker: primary-style checkout was authorized")
        fixture_audit_lock.close()

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
            tasks_max="4096",
            configured_tasks="4096",
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
                tasks_max="4096",
                configured_tasks="4096",
                host_memory=1000,
                host_cpus=8,
                **weakness,
            )
        except ValueError:
            pass
        else:
            failures.append(f"confinement: {label} were accepted")

    try:
        validate_scope_limits(
            "750",
            "0",
            "600000 100000",
            tasks_max="max",
            configured_tasks="4096",
            host_memory=1000,
            host_cpus=8,
            accept_unlimited_tasks=fault == "accept-unlimited-task-scope",
        )
    except ValueError:
        pass
    else:
        failures.append("confinement: unlimited task limit was accepted")

    try:
        validate_scope_limits(
            "750",
            "0",
            "600000 100000",
            tasks_max="4097",
            configured_tasks="4096",
            host_memory=1000,
            host_cpus=8,
            accept_oversized_tasks=fault == "accept-oversized-task-scope",
        )
    except ValueError:
        pass
    else:
        failures.append("confinement: oversized task limit was accepted")

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
    (
        fixture_scope,
        fixture_workspace,
        fixture_authority,
        transport_audit_lock,
    ) = suite_self_test_fixture()
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
    transport_audit_lock.close()

    if fault is None:
        failures.extend(mutation_checkpoint_problems())

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
    routing_self_test_fault: str | None = None,
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
        if (
            mutation.typecheck_project is not None
            or routing_self_test_fault
            in (
                "typecheck-behavior-mutation",
                "typecheck-vitest-construction-mutation",
            )
        ):
            if (
                mutation.typecheck_project is None
                and routing_self_test_fault
                not in (
                    "typecheck-behavior-mutation",
                    "typecheck-vitest-construction-mutation",
                )
            ):
                raise RuntimeError(f"{mutation.name}: typecheck mutation has no project")
            project = mutation.typecheck_project or "store-libsql"
            if (
                routing_self_test_fault == "misroute-conformance-mutation"
                and project == "conformance"
            ):
                project = "store-libsql"
            elif (
                routing_self_test_fault == "misroute-store-mutation"
                and project == "store-libsql"
            ):
                project = "conformance"
            result = run_typecheck(
                mutation.verdict,
                project=project,
                scope=scope,
                workspace=workspace,
                authority=authority,
            )
        else:
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
    audit_lock_fd: int,
    report_path: Path,
    head: str,
    worker_id: int,
    mutation_names: list[str],
    max_workers: int,
    run_root: Path,
    nonce: str,
    baseline_barrier: str | None,
    routing_self_test_fault: str | None = None,
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
        audit_lock_fd=audit_lock_fd,
        audit_lock_path=(
            git_common_directory(ROOT) / "durablerun-mutation.lock"
        ),
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
        if routing_self_test_fault == "skip-vitest":
            baseline = SuiteResult(True, True, (), (), "")
        else:
            baseline = run_suite(
                max_workers,
                scope=scope,
                workspace=workspace,
                authority=authority,
            )
        if (
            baseline.green
            or routing_self_test_fault == "continue-after-vitest-red"
        ):
            assigned_mutations = [by_name[name][1] for name in mutation_names]
            for project in mutation_typecheck_projects(
                assigned_mutations,
                routing_self_test_fault=routing_self_test_fault,
            ):
                baseline = run_typecheck(
                    None,
                    project=project,
                    scope=scope,
                    workspace=workspace,
                    authority=authority,
                )
                if (
                    routing_self_test_fault == "accept-conformance-typecheck-red"
                    and project == "conformance"
                    and not baseline.green
                ):
                    baseline = SuiteResult(True, True, (), (), "")
                if (
                    not baseline.green
                    and routing_self_test_fault
                    != "continue-after-store-typecheck-red"
                ):
                    break
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

    if report_path.exists():
        rows = validate_mutation_report(
            read_json(report_path),
            head=head,
            nonce=nonce,
            worker_id=worker_id,
            expected=assigned,
            process_returncode=None,
            allow_partial=True,
        )
    else:
        rows = []
        atomic_json(
            report_path,
            mutation_report_payload(
                head=head,
                nonce=nonce,
                worker_id=worker_id,
                assigned=assigned,
                results=rows,
                complete=False,
            ),
        )
    for item in assigned[len(rows) :]:
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
                nonce=nonce,
                worker_id=worker_id,
                assigned=assigned,
                results=rows,
                complete=len(rows) == len(assigned),
            ),
        )
    return 0 if all(row["outcome"] == "caught" for row in rows) else 1


def routing_self_test(fault: str | None = None) -> int:
    """Generated fault surface for verifier routing through the real worker paths."""
    failures: list[str] = []
    head = "a" * 40

    def fixture_mutation(
        name: str,
        project: TypecheckProject | None,
        *,
        kind: VerdictKind | None = None,
    ) -> Mutation:
        file = f"{name}.ts"
        verdict_kind: VerdictKind = (
            kind
            if kind is not None
            else "construction" if project is not None else "behavior"
        )
        return Mutation(
            name,
            file,
            f"{name}-guard",
            f"{name}-removed",
            f"{name} routing break",
            ExpectedVerdict(
                verdict_kind,
                file,
                f"{name} attributable verdict",
                f"mutation-verdict:{verdict_kind}:{name}",
            ),
            typecheck_project=project,
        )

    behavior = fixture_mutation("routing-behavior", None)
    vitest_construction = fixture_mutation(
        "routing-vitest-construction",
        None,
        kind="construction",
    )
    store = fixture_mutation("routing-store", "store-libsql")
    conformance = fixture_mutation("routing-conformance", "conformance")
    fixture_mutations = [behavior, vitest_construction, store, conformance]

    green = SuiteResult(True, True, (), (), "")
    red = SuiteResult(
        False,
        False,
        (FailedAssertion("routing.test.ts", "routing red", ("routing red",)),),
        (),
        "routing red",
    )
    verifier_trace: list[str] = []
    active_case = [""]
    dispatch_file = [""]
    production_digest = mutation_registry_digest

    def fixture_git_output(_root: Path, *arguments: str) -> str:
        if arguments == ("rev-parse", "HEAD^{commit}"):
            return head
        if arguments == ("diff", "--name-only", "--"):
            return dispatch_file[0]
        if arguments == ("status", "--porcelain"):
            return ""
        return ""

    fixture_authority = WorkerAuthority(
        Path("/routing-self-test/run"),
        Path("/routing-self-test/worker"),
        0,
        head,
        "routing-self-test-nonce",
        InheritedAuditLock(Path("/routing-self-test/audit.lock"), -1, 0, 0),
    )

    def fixture_run_suite(
        _max_workers: int,
        **_arguments: object,
    ) -> SuiteResult:
        dispatch_verdict = {
            "dispatch-behavior": behavior.verdict,
            "dispatch-Vitest construction": vitest_construction.verdict,
        }.get(active_case[0])
        if dispatch_verdict is not None:
            verifier_trace.append("vitest")
            return SuiteResult(
                False,
                False,
                (
                    FailedAssertion(
                        dispatch_verdict.file,
                        dispatch_verdict.full_name,
                        (dispatch_verdict.marker,),
                    ),
                ),
                (),
                "",
            )
        if active_case[0] == "vitest-red":
            verifier_trace.append("vitest:red")
            return red
        verifier_trace.append("vitest")
        return green

    def fixture_run_typecheck(
        expected: ExpectedVerdict | None,
        *,
        project: TypecheckProject,
        **_arguments: object,
    ) -> SuiteResult:
        suffix = ""
        result = green
        if active_case[0] == "store-red" and project == "store-libsql":
            suffix = ":red"
            result = red
        elif active_case[0] == "conformance-red" and project == "conformance":
            suffix = ":red"
            result = red
        verifier_trace.append(f"tsc:{project}{suffix}")
        if expected is not None:
            return SuiteResult(
                False,
                False,
                (
                    FailedAssertion(
                        expected.file,
                        expected.full_name,
                        (expected.marker,),
                    ),
                ),
                (),
                "",
            )
        return result

    patched = {
        "ROOT": Path("/routing-self-test/unset"),
        "assert_clean": lambda _root=ROOT: None,
        "git_output": fixture_git_output,
        "prove_confined_scope": lambda: ConfinedScope("routing-self-test", 1, 1, 1),
        "prove_worker_authority": lambda **_arguments: fixture_authority,
        "prove_workspace_links": lambda root: IsolatedWorkspace(root.resolve()),
        "run_suite": fixture_run_suite,
        "run_typecheck": fixture_run_typecheck,
    }
    originals = {name: globals()[name] for name in patched}
    original_mutations = MUTATIONS[:]
    original_scope = os.environ.get(CONFINEMENT_ENV)
    try:
        with tempfile.TemporaryDirectory(
            prefix="durablerun-routing-selftest-"
        ) as temporary_text:
            temporary = Path(temporary_text)
            for mutation in fixture_mutations:
                (temporary / mutation.file).write_text(f"{mutation.find}\n")
            patched["ROOT"] = temporary
            globals().update(patched)
            MUTATIONS[:] = fixture_mutations
            os.environ[CONFINEMENT_ENV] = "1"

            baseline_cases = (
                (
                    "store",
                    [store.name],
                    ["vitest", "tsc:store-libsql"],
                    0,
                ),
                (
                    "conformance",
                    [conformance.name],
                    ["vitest", "tsc:conformance"],
                    0,
                ),
                (
                    "mixed",
                    [store.name, conformance.name],
                    ["vitest", "tsc:store-libsql", "tsc:conformance"],
                    0,
                ),
                ("behavior", [behavior.name], ["vitest"], 0),
                (
                    "Vitest construction",
                    [vitest_construction.name],
                    ["vitest"],
                    0,
                ),
                ("vitest-red", [store.name, conformance.name], ["vitest:red"], 2),
                (
                    "store-red",
                    [store.name, conformance.name],
                    ["vitest", "tsc:store-libsql:red"],
                    2,
                ),
                (
                    "conformance-red",
                    [conformance.name],
                    ["vitest", "tsc:conformance:red"],
                    2,
                ),
            )
            baseline_fault_cases = {
                "skip-store-typecheck": "store",
                "misroute-store-typecheck": "store",
                "duplicate-store-typecheck": "store",
                "skip-conformance-typecheck": "conformance",
                "misroute-conformance-typecheck": "conformance",
                "duplicate-conformance-typecheck": "conformance",
                "skip-vitest": "behavior",
                "reverse-typecheck-project-order": "mixed",
                "typecheck-behavior-only": "behavior",
                "typecheck-vitest-construction-baseline": "Vitest construction",
                "continue-after-vitest-red": "vitest-red",
                "continue-after-store-typecheck-red": "store-red",
                "accept-conformance-typecheck-red": "conformance-red",
            }
            report_path = temporary / "baseline.json"
            for label, mutation_names, expected_trace, expected_code in baseline_cases:
                active_case[0] = label
                verifier_trace.clear()
                report_path.unlink(missing_ok=True)
                code = worker_phase(
                    phase="baseline",
                    audit_lock_fd=-1,
                    report_path=report_path,
                    head=head,
                    worker_id=0,
                    mutation_names=mutation_names,
                    max_workers=1,
                    run_root=temporary,
                    nonce="routing-self-test-nonce",
                    baseline_barrier=None,
                    routing_self_test_fault=(
                        fault if baseline_fault_cases.get(fault) == label else None
                    ),
                )
                if verifier_trace != expected_trace:
                    failures.append(
                        f"{label} baseline: expected verifier trace "
                        f"{expected_trace!r}, observed {verifier_trace!r}"
                    )
                elif code != expected_code:
                    failures.append(
                        f"{label} baseline: expected status {expected_code}, observed {code}"
                    )

            dispatch_cases = (
                ("behavior", 0, behavior, ["vitest"]),
                ("Vitest construction", 1, vitest_construction, ["vitest"]),
                ("store", 2, store, ["tsc:store-libsql"]),
                ("conformance", 3, conformance, ["tsc:conformance"]),
            )
            dispatch_fault_cases = {
                "misroute-store-mutation": "store",
                "misroute-conformance-mutation": "conformance",
                "typecheck-behavior-mutation": "behavior",
                "typecheck-vitest-construction-mutation": "Vitest construction",
            }
            for label, ordinal, mutation, expected_dispatch_trace in dispatch_cases:
                active_case[0] = f"dispatch-{label}"
                verifier_trace.clear()
                dispatch_file[0] = mutation.file
                expected = expected_result(ordinal, mutation, root=temporary)
                row = execute_mutation(
                    mutation,
                    expected,
                    max_workers=1,
                    scope=ConfinedScope("routing-self-test", 1, 1, 1),
                    workspace=IsolatedWorkspace(temporary.resolve()),
                    authority=fixture_authority,
                    routing_self_test_fault=(
                        fault if dispatch_fault_cases.get(fault) == label else None
                    ),
                )
                if verifier_trace != expected_dispatch_trace:
                    failures.append(
                        f"{label} mutation dispatch: expected verifier trace "
                        f"{expected_dispatch_trace!r}, observed {verifier_trace!r}"
                    )
                elif row["outcome"] != "caught":
                    failures.append(
                        f"{label} mutation dispatch did not preserve its "
                        "attributable verdict"
                    )
                elif (temporary / mutation.file).read_text() != f"{mutation.find}\n":
                    failures.append(f"{label} mutation dispatch did not restore its source")

            def routed_digest(mutation: Mutation) -> str:
                MUTATIONS[:] = [mutation]
                return production_digest(
                    omit_typecheck_project=(
                        fault == "omit-typecheck-project-from-registry-digest"
                    )
                )

            same_mutation_other_project = Mutation(
                store.name,
                store.file,
                store.find,
                store.replace,
                store.breaks,
                store.verdict,
                typecheck_project="conformance",
            )
            store_digest = routed_digest(store)
            conformance_digest = routed_digest(same_mutation_other_project)
            if store_digest == conformance_digest:
                failures.append(
                    "registry digest did not change when only typecheck_project changed"
                )
            MUTATIONS[:] = fixture_mutations
    finally:
        MUTATIONS[:] = original_mutations
        globals().update(originals)
        if original_scope is None:
            os.environ.pop(CONFINEMENT_ENV, None)
        else:
            os.environ[CONFINEMENT_ENV] = original_scope

    if fault is not None:
        expected_diagnostic = ROUTING_SELF_TEST_EXPECTED_DIAGNOSTICS[fault]
        if failures == [expected_diagnostic]:
            print(
                "mutation-probe routing self-test caught injected fault "
                f"{fault}: {expected_diagnostic}",
                file=sys.stderr,
            )
            return 1
        if failures:
            print(
                "mutation-probe routing self-test attributed injected fault "
                f"{fault} incorrectly: expected {[expected_diagnostic]!r}, "
                f"observed {failures!r}",
                file=sys.stderr,
            )
            return 1
        print(
            "mutation-probe routing self-test MISSED injected fault "
            f"{fault}",
            file=sys.stderr,
        )
        return 0

    for injected_fault, expected_diagnostic in (
        ROUTING_SELF_TEST_EXPECTED_DIAGNOSTICS.items()
    ):
        result = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve()),
                "--routing-self-test",
                "--routing-self-test-fault",
                injected_fault,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        marker = (
            "mutation-probe routing self-test caught injected fault "
            f"{injected_fault}: {expected_diagnostic}"
        )
        if result.returncode != 1 or marker not in (result.stdout + result.stderr):
            failures.append(
                "declared routing fault "
                f"{injected_fault!r} was not caught through its CLI path"
            )

    expected_mutation_fields = {
        "name",
        "file",
        "find",
        "replace",
        "breaks",
        "verdict",
        "typecheck_project",
    }
    if set(Mutation.__dataclass_fields__) != expected_mutation_fields:
        failures.append(
            "single representation: Mutation routing has fields outside its "
            "canonical typecheck_project authority"
        )

    if failures:
        for failure in failures:
            print(f"mutation-probe routing self-test: {failure}", file=sys.stderr)
        return 1
    print(
        "mutation-probe routing self-test: "
        f"{len(ROUTING_SELF_TEST_FAULTS)} declared injected faults exercised "
        "from canonical inventory through worker baseline and mutation dispatch"
    )
    return 0


def mutation_checkpoint_problems() -> list[str]:
    """Exercise checkpoint survival across the coordinator's owned cleanup."""
    head = "a" * 40
    nonce = "checkpoint-fixture-nonce"
    barrier_digest = "b" * 64
    failures: list[str] = []
    captured_run_roots: list[Path] = []

    class UnexpectedCheckpointExecution(RuntimeError):
        pass

    with tempfile.TemporaryDirectory(
        prefix="durablerun-checkpoint-selftest-"
    ) as temporary_text:
        temporary = Path(temporary_text)
        common_dir = temporary / "git-common"
        checkpoint_root = common_dir / "durablerun-mutation-checkpoints"
        pnpm_store = temporary / "pnpm-store"
        fixture_source = temporary / "source"
        common_dir.mkdir()
        pnpm_store.mkdir()
        fixture_source.mkdir()
        worker_audit_lock_path = temporary / "worker-audit.lock"
        worker_audit_lock = worker_audit_lock_path.open("a+")
        fcntl.flock(worker_audit_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.set_inheritable(worker_audit_lock.fileno(), True)
        worker_audit_lock_fd = worker_audit_lock.fileno()
        fixture_mutations = []
        for ordinal in range(2):
            relative_source = f"mutation-{ordinal}.ts"
            guard = f"checkpoint-guard-{ordinal}"
            (fixture_source / relative_source).write_text(f"{guard}\n")
            fixture_mutations.append(
                Mutation(
                    f"checkpoint-mutation-{ordinal}",
                    relative_source,
                    guard,
                    f"removed-{ordinal}",
                    f"checkpoint break {ordinal}",
                    ExpectedVerdict(
                        "behavior",
                        relative_source,
                        f"checkpoint verdict {ordinal}",
                        f"mutation-verdict:behavior:checkpoint-mutation-{ordinal}",
                    ),
                )
            )
        mutation_names = [mutation.name for mutation in fixture_mutations]

        emitted_payload: list[object] = []
        emitted_report_paths: list[Path] = []
        executed_names: list[str] = []
        execution_mode = ["interrupt"]
        production_atomic_json = atomic_json

        def fixture_atomic_json(path: Path, payload: object) -> None:
            production_atomic_json(path, payload)
            if not isinstance(payload, dict):
                return
            results = payload.get("results")
            if (
                execution_mode[0] == "interrupt-after-last-checkpoint"
                and payload.get("phase") == "mutations"
                and isinstance(results, list)
                and len(results) == len(fixture_mutations)
            ):
                raise AuditSignal(signal.SIGTERM)

        def command_value(command: tuple[str, ...], option: str) -> str:
            return command[command.index(option) + 1]

        def command_values(command: tuple[str, ...], option: str) -> list[str]:
            return [
                command[index + 1]
                for index, value in enumerate(command[:-1])
                if value == option
            ]

        def fixture_git_output(_root: Path, *arguments: str) -> str:
            if arguments == ("rev-parse", "HEAD^{commit}"):
                return head
            if arguments == ("rev-parse", "--git-common-dir"):
                return str(common_dir)
            if arguments == ("status", "--porcelain"):
                return ""
            return ""

        def fixture_git_result(
            _root: Path, *arguments: str
        ) -> subprocess.CompletedProcess[str]:
            if arguments[:4] == ("worktree", "add", "--detach", "--quiet"):
                worker_root = Path(arguments[4])
                worker_root.mkdir(parents=True)
                (worker_root / ".git").write_text("gitdir: fixture\n")
            return subprocess.CompletedProcess(("git", *arguments), 0, "", "")

        def fixture_authority(**arguments: object) -> WorkerAuthority:
            return WorkerAuthority(
                Path(str(arguments["run_root"])).resolve(),
                Path(str(arguments["worker_root"])).resolve(),
                int(arguments["worker_id"]),
                str(arguments["head"]),
                str(arguments["nonce"]),
                prove_inherited_audit_lock(
                    worker_audit_lock_path,
                    int(arguments["audit_lock_fd"]),
                ),
            )

        def fixture_execute(
            _mutation: Mutation,
            expected: ExpectedMutationResult,
            **_arguments: object,
        ) -> dict[str, object]:
            executed_names.append(expected.name)
            if execution_mode[0] == "interrupt" and len(executed_names) == 2:
                raise AuditSignal(signal.SIGTERM)
            if execution_mode[0] == "reject":
                raise UnexpectedCheckpointExecution(expected.name)
            return mutation_result_row(expected, "caught", "attributable")

        def baseline_report(launch: ProcessLaunch) -> None:
            command = launch.command
            worker_id = int(command_value(command, "--worker-id"))
            assigned_names = command_values(command, "--worker-mutation")
            atomic_json(
                Path(command_value(command, "--worker-result")),
                {
                    "version": REPORT_VERSION,
                    "phase": "baseline",
                    "head": head,
                    "registry_digest": mutation_registry_digest(),
                    "worker_id": worker_id,
                    "assigned": assigned_names,
                    "complete": True,
                    "green": True,
                    "diagnostic": "",
                },
            )

        def fixture_run_launches(
            launches: list[ProcessLaunch],
            *,
            allowed_returncodes: frozenset[int],
            omit_exited_groups: bool = False,
        ) -> dict[str, int]:
            del allowed_returncodes, omit_exited_groups
            if all(launch.label.startswith("install ") for launch in launches):
                return {launch.label: 0 for launch in launches}
            if all(launch.label.startswith("baseline ") for launch in launches):
                for launch in launches:
                    baseline_report(launch)
                return {launch.label: 0 for launch in launches}

            codes: dict[str, int] = {}
            for launch in launches:
                command = launch.command
                report_path = Path(command_value(command, "--worker-result"))
                run_root = Path(command_value(command, "--worker-run-root"))
                emitted_report_paths.append(report_path)
                captured_run_roots.append(run_root)
                try:
                    codes[launch.label] = worker_phase(
                        phase="mutations",
                        audit_lock_fd=worker_audit_lock_fd,
                        report_path=report_path,
                        head=command_value(command, "--worker-head"),
                        worker_id=int(command_value(command, "--worker-id")),
                        mutation_names=command_values(
                            command, "--worker-mutation"
                        ),
                        max_workers=int(command_value(command, "--max-workers")),
                        run_root=run_root,
                        nonce=command_value(command, "--worker-nonce"),
                        baseline_barrier=command_value(
                            command, "--worker-baseline-barrier"
                        ),
                    )
                finally:
                    if report_path.exists():
                        emitted_payload.append(read_json(report_path))
            return codes

        patched = {
            "ROOT": fixture_source,
            "assert_clean": lambda _root: None,
            "atomic_json": fixture_atomic_json,
            "execute_mutation": fixture_execute,
            "git_output": fixture_git_output,
            "git_result": fixture_git_result,
            "prove_confined_scope": lambda: ConfinedScope("self-test", 1, 1, 1),
            "prove_worker_authority": fixture_authority,
            "prove_workspace_links": lambda root: IsolatedWorkspace(root.resolve()),
            "registered_worktrees": lambda: set(),
            "resolve_pnpm_store": lambda _root: pnpm_store,
            "run_launches": fixture_run_launches,
            "usable_cores": lambda: 1,
        }
        originals = {name: globals()[name] for name in patched}
        original_mutations = MUTATIONS[:]
        original_scope = os.environ.get(CONFINEMENT_ENV)
        original_token_hex = secrets.token_hex
        try:
            globals().update(patched)
            MUTATIONS[:] = fixture_mutations
            os.environ[CONFINEMENT_ENV] = "1"
            secrets.token_hex = lambda _size=None: nonce

            result_code = coordinate_audit("", "1")
            if result_code != 128 + signal.SIGTERM:
                failures.append(
                    "checkpoint cleanup fixture did not preserve the worker interrupt status"
                )
            if len(emitted_report_paths) != 1 or len(emitted_payload) != 1:
                failures.append(
                    "checkpoint cleanup fixture did not observe one partial worker report"
                )
                return failures

            run_root = captured_run_roots[0]
            report_path = emitted_report_paths[0]
            partial = emitted_payload[0]
            if run_root.exists():
                failures.append("owned cleanup left the interrupted run root behind")
            try:
                report_path.resolve().relative_to(checkpoint_root.resolve())
            except ValueError:
                failures.append(
                    "coordinator kept the mutation checkpoint inside its disposable run root"
                )
            if not report_path.exists():
                failures.append(
                    "completed mutation row disappeared when owned run-root cleanup finished"
                )
            if not isinstance(partial, dict):
                failures.append("interrupted worker checkpoint was not an object")
                return failures
            rows = partial.get("results")
            if (
                partial.get("complete") is not False
                or not isinstance(rows, list)
                or [row.get("name") for row in rows if isinstance(row, dict)]
                != mutation_names[:1]
            ):
                failures.append(
                    "interrupted worker did not atomically retain exactly its completed prefix"
                )
            if partial.get("nonce") != nonce:
                failures.append(
                    "durable mutation checkpoint is not bound to its coordinator nonce"
                )

            # Keep testing authentication and resume independently so one
            # persistence failure cannot hide the rest of the contract.
            authenticated = json.loads(json.dumps(partial))
            authenticated["nonce"] = nonce
            durable_report = report_path

            expected = [
                expected_result(ordinal, mutation, root=ROOT)
                for ordinal, mutation in enumerate(fixture_mutations)
            ]
            try:
                resumed_nonce = discover_mutation_checkpoint_nonce(
                    report_path.parent,
                    [report_path],
                    [expected],
                    head=head,
                )
            except ValueError as error:
                failures.append(
                    f"fresh coordinator could not discover its checkpoint: {error}"
                )
            else:
                if resumed_nonce != nonce:
                    failures.append(
                        "fresh coordinator did not reuse the checkpoint nonce"
                    )
            manifest_path = report_path.parent / "audit.json"
            manifest_payload = read_json(manifest_path)
            if isinstance(manifest_payload, dict):
                wrong_manifest = json.loads(json.dumps(manifest_payload))
                wrong_manifest["head"] = "c" * 40
                atomic_json(manifest_path, wrong_manifest)
                try:
                    discover_mutation_checkpoint_nonce(
                        report_path.parent,
                        [report_path],
                        [expected],
                        head=head,
                    )
                except ValueError:
                    pass
                else:
                    failures.append(
                        "fresh coordinator accepted a stale checkpoint manifest"
                    )
                atomic_json(manifest_path, manifest_payload)
            else:
                failures.append("durable checkpoint manifest was not an object")

            def invoke_worker() -> int:
                return worker_phase(
                    phase="mutations",
                    audit_lock_fd=worker_audit_lock_fd,
                    report_path=durable_report,
                    head=head,
                    worker_id=0,
                    mutation_names=mutation_names,
                    max_workers=1,
                    run_root=checkpoint_root,
                    nonce=nonce,
                    baseline_barrier=barrier_digest,
                )

            mismatches: list[tuple[str, dict[str, object]]] = []
            wrong_head = json.loads(json.dumps(authenticated))
            wrong_head["head"] = "c" * 40
            mismatches.append(("head", wrong_head))
            wrong_nonce = json.loads(json.dumps(authenticated))
            wrong_nonce["nonce"] = "stale-nonce"
            mismatches.append(("nonce", wrong_nonce))
            wrong_registry = json.loads(json.dumps(authenticated))
            wrong_registry["registry_digest"] = "d" * 64
            mismatches.append(("registry", wrong_registry))
            wrong_selection = json.loads(json.dumps(authenticated))
            wrong_selection["assigned"] = list(reversed(mutation_names))
            mismatches.append(("selection", wrong_selection))
            wrong_row = json.loads(json.dumps(authenticated))
            wrong_row["results"][0]["mutated_sha256"] = "e" * 64
            mismatches.append(("row metadata", wrong_row))

            execution_mode[0] = "reject"
            for label, mismatch in mismatches:
                atomic_json(durable_report, mismatch)
                executed_names.clear()
                try:
                    discover_mutation_checkpoint_nonce(
                        durable_report.parent,
                        [durable_report],
                        [expected],
                        head=head,
                    )
                except ValueError:
                    pass
                else:
                    failures.append(
                        f"fresh coordinator accepted the {label} checkpoint"
                    )
                rejected = False
                try:
                    mismatch_code = invoke_worker()
                    rejected = mismatch_code == worker_infrastructure_returncode()
                except ValueError:
                    rejected = True
                except UnexpectedCheckpointExecution:
                    pass
                except Exception as error:
                    failures.append(
                        f"{label} checkpoint raised the wrong rejection: {error}"
                    )
                if executed_names or not rejected:
                    failures.append(
                        f"{label} checkpoint reached mutation execution instead of rejection"
                    )

            atomic_json(durable_report, authenticated)
            executed_names.clear()
            execution_mode[0] = "resume"
            try:
                resume_code = invoke_worker()
            except Exception as error:
                failures.append(f"authenticated checkpoint could not resume: {error}")
            else:
                if resume_code != 0:
                    failures.append("authenticated complete resume returned nonzero")
                if executed_names != mutation_names[1:]:
                    failures.append(
                        "authenticated resume did not skip exactly the completed mutation prefix"
                    )
                final_payload = read_json(durable_report)
                if not isinstance(final_payload, dict):
                    failures.append("resumed worker final report was not an object")
                else:
                    final_rows = final_payload.get("results")
                    final_names = (
                        [
                            row.get("name")
                            for row in final_rows
                            if isinstance(row, dict)
                        ]
                        if isinstance(final_rows, list)
                        else []
                    )
                    if (
                        final_payload.get("complete") is not True
                        or final_payload.get("nonce") != nonce
                        or final_names != mutation_names
                    ):
                        failures.append(
                            "resume published success without the authenticated complete set"
                        )
                    try:
                        validate_mutation_report(
                            final_payload,
                            head=head,
                            nonce=nonce,
                            worker_id=0,
                            expected=expected,
                            process_returncode=0,
                        )
                    except ValueError as error:
                        failures.append(
                            f"authenticated complete resume report was rejected: {error}"
                        )

            atomic_json(durable_report, authenticated)
            executed_names.clear()
            execution_mode[0] = "interrupt-after-last-checkpoint"
            try:
                invoke_worker()
            except AuditSignal as error:
                if error.signum != signal.SIGTERM:
                    failures.append(
                        "last-row checkpoint seam raised the wrong interrupt"
                    )
            except Exception as error:
                failures.append(
                    f"last-row checkpoint seam raised the wrong error: {error}"
                )
            else:
                failures.append("last-row checkpoint seam did not interrupt the worker")

            final_row_checkpoint = read_json(durable_report)
            if (
                not isinstance(final_row_checkpoint, dict)
                or not isinstance(final_row_checkpoint.get("results"), list)
                or len(final_row_checkpoint["results"]) != len(expected)
            ):
                failures.append(
                    "last-row interruption did not preserve the complete result prefix"
                )
            executed_names.clear()
            execution_mode[0] = "resume"
            try:
                finalization_code = invoke_worker()
            except Exception as error:
                failures.append(
                    "last-row checkpoint could not finalize without re-execution: "
                    f"{error}"
                )
            else:
                if finalization_code != 0:
                    failures.append("last-row checkpoint finalization returned nonzero")
                if executed_names:
                    failures.append(
                        "last-row checkpoint finalization re-executed a completed mutation"
                    )
                try:
                    validate_mutation_report(
                        read_json(durable_report),
                        head=head,
                        nonce=nonce,
                        worker_id=0,
                        expected=expected,
                        process_returncode=0,
                    )
                except ValueError as error:
                    failures.append(
                        f"last-row checkpoint final report was incomplete: {error}"
                    )

            try:
                validate_mutation_report(
                    partial,
                    head=head,
                    nonce=nonce,
                    worker_id=0,
                    expected=expected,
                    process_returncode=0,
                )
            except ValueError:
                pass
            else:
                failures.append(
                    "an interrupted partial checkpoint was accepted as final success"
                )
        finally:
            worker_audit_lock.close()
            MUTATIONS[:] = original_mutations
            globals().update(originals)
            secrets.token_hex = original_token_hex
            if original_scope is None:
                os.environ.pop(CONFINEMENT_ENV, None)
            else:
                os.environ[CONFINEMENT_ENV] = original_scope
            temporary_root = Path(tempfile.gettempdir()).resolve()
            for run_root in captured_run_roots:
                resolved = run_root.resolve()
                if (
                    resolved.exists()
                    and resolved.parent == temporary_root
                    and resolved.name.startswith("durablerun-mutation-worktrees-")
                ):
                    shutil.rmtree(resolved)
    return failures


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
    inherited_fds: tuple[int, ...] = ()


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
    term_grace_seconds: float = 5.0,
    kill_grace_seconds: float = 2.0,
) -> None:
    if (
        not math.isfinite(term_grace_seconds)
        or term_grace_seconds < 0
        or not math.isfinite(kill_grace_seconds)
        or kill_grace_seconds < 0
    ):
        raise ValueError("process cleanup grace periods must be finite and nonnegative")
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

    deadline = time.monotonic() + term_grace_seconds
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
    kill_deadline = time.monotonic() + kill_grace_seconds
    while live_groups and time.monotonic() < kill_deadline:
        live_groups = live_process_groups()
        if live_groups:
            time.sleep(0.05)
    for process in processes:
        try:
            process.wait(timeout=max(kill_grace_seconds, 0.1))
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
                    pass_fds=launch.inherited_fds,
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


def audit_lock_inheritance_problems(
    temporary: Path,
    *,
    drop_inheritance: bool = False,
) -> list[str]:
    """Prove an active child keeps the audit lock after its coordinator dies."""
    failures: list[str] = []
    lock_path = temporary / "audit-lock-inheritance.lock"
    state_path = temporary / "audit-lock-inheritance-state.json"
    release_path = temporary / "audit-lock-inheritance-release"
    child_log = temporary / "audit-lock-inheritance-child.log"
    nonce = secrets.token_hex(16)
    child_code = (
        "import json,os,pathlib,sys,time; "
        "state=pathlib.Path(sys.argv[1]); "
        "release=pathlib.Path(sys.argv[2]); "
        "nonce=sys.argv[3]; "
        "state.write_text(json.dumps({"
        "'kind':'durablerun-audit-lock-child',"
        "'nonce':nonce,'pid':os.getpid(),'parent_pid':os.getppid()})); "
        "deadline=time.monotonic()+3.0; "
        "\nwhile not release.exists() and time.monotonic() < deadline: time.sleep(0.01)"
        "\nraise SystemExit(0 if release.exists() else 3)"
    )
    lock = lock_path.open("a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    launch = ProcessLaunch(
        "audit-lock-inheritance-child",
        (
            sys.executable,
            "-B",
            "-c",
            child_code,
            str(state_path),
            str(release_path),
            nonce,
        ),
        temporary,
        child_log,
        os.environ.copy(),
        () if drop_inheritance else (lock.fileno(),),
    )
    launch_errors: list[BaseException] = []

    def launch_child() -> None:
        try:
            run_launches([launch], allowed_returncodes=frozenset((0,)))
        except BaseException as error:
            launch_errors.append(error)

    child_thread = threading.Thread(
        target=launch_child,
        name="audit-lock-inheritance-selftest",
        daemon=True,
    )
    child_thread.start()
    child_pid: int | None = None
    parent_descriptor_open = True
    try:
        deadline = time.monotonic() + 2.0
        authenticated = False
        while time.monotonic() < deadline:
            if state_path.exists():
                try:
                    payload = read_json(state_path)
                except ValueError:
                    time.sleep(0.01)
                    continue
                if (
                    isinstance(payload, dict)
                    and set(payload) == {"kind", "nonce", "pid", "parent_pid"}
                    and payload.get("kind") == "durablerun-audit-lock-child"
                    and payload.get("nonce") == nonce
                    and type(payload.get("pid")) is int
                    and type(payload.get("parent_pid")) is int
                    and payload.get("parent_pid") == os.getpid()
                ):
                    child_pid = int(payload["pid"])
                    authenticated = process_id_is_live(child_pid)
                    if authenticated:
                        break
            if not child_thread.is_alive():
                break
            time.sleep(0.01)
        if not authenticated:
            failures.append(
                "audit lock inheritance: child did not publish authenticated readiness"
            )
        else:
            # Closing the coordinator's only descriptor models SIGKILL: the
            # active child must retain the same locked open-file description.
            lock.close()
            parent_descriptor_open = False
            contender = lock_path.open("a+")
            acquired = False
            try:
                try:
                    fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    acquired = True
                except BlockingIOError:
                    pass
            finally:
                contender.close()
            child_remained_active = process_id_is_live(child_pid)
            if not child_remained_active:
                failures.append(
                    "audit lock inheritance: authenticated child exited before contention"
                )
            elif acquired:
                failures.append(
                    "audit lock inheritance: a fresh coordinator acquired the lock "
                    "while an orphan child was still active"
                )
    finally:
        if parent_descriptor_open:
            lock.close()
        release_path.touch()
        child_thread.join(timeout=4.0)
        if child_thread.is_alive():
            failures.append("audit lock inheritance: child launcher did not terminate")
            if child_pid is not None and process_id_is_live(child_pid):
                try:
                    os.killpg(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            child_thread.join(timeout=1.0)
        if launch_errors:
            failures.append(
                "audit lock inheritance: child launch failed: "
                f"{launch_errors[0]}"
            )

    contender = lock_path.open("a+")
    try:
        try:
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            failures.append(
                "audit lock inheritance: lock remained held after child reap"
            )
    finally:
        contender.close()
    if child_pid is not None and process_id_is_live(child_pid):
        failures.append("audit lock inheritance: authenticated child leaked after reap")
    return failures


def verifier_lock_self_test_child(
    state_path: Path,
    release_path: Path,
    nonce: str,
    audit_lock_fd: int,
    lock_device: int,
    lock_inode: int,
    drop_inheritance: bool,
) -> int:
    """Exercise the real verifier launcher from an expendable worker process."""
    try:
        descriptor_stat = os.fstat(audit_lock_fd)
    except OSError as error:
        print(
            f"mutation-probe verifier-lock self-test lacks its inherited lock: {error}",
            file=sys.stderr,
        )
        return 2
    if (
        descriptor_stat.st_dev != lock_device
        or descriptor_stat.st_ino != lock_inode
        or not os.get_inheritable(audit_lock_fd)
    ):
        print(
            "mutation-probe verifier-lock self-test inherited the wrong descriptor",
            file=sys.stderr,
        )
        return 2
    audit_lock = prove_inherited_audit_lock(
        Path(f"/proc/self/fd/{audit_lock_fd}").resolve(),
        audit_lock_fd,
    )
    verifier_code = (
        "import json,os,pathlib,sys,time; "
        "state=pathlib.Path(sys.argv[1]); "
        "release=pathlib.Path(sys.argv[2]); "
        "nonce=sys.argv[3]; fd=int(sys.argv[4]); "
        "expected_device=int(sys.argv[5]); expected_inode=int(sys.argv[6]); "
        "lock_identity=False; inheritable=False; "
        "\ntry:"
        "\n descriptor=os.fstat(fd)"
        "\n lock_identity=(descriptor.st_dev==expected_device and "
        "descriptor.st_ino==expected_inode)"
        "\n inheritable=os.get_inheritable(fd)"
        "\nexcept OSError: pass"
        "\npayload={'kind':'durablerun-verifier-lock-child','nonce':nonce,"
        "'pid':os.getpid(),'parent_pid':os.getppid(),"
        "'lock_identity':lock_identity,'inheritable':inheritable}; "
        "temporary=state.with_name(state.name+'.tmp'); "
        "temporary.write_text(json.dumps(payload)); temporary.replace(state); "
        "deadline=time.monotonic()+8.0; "
        "\nwhile not release.exists() and time.monotonic() < deadline: time.sleep(0.01)"
        "\nraise SystemExit(0 if release.exists() else 3)"
    )
    return run_suite_process(
        [
            sys.executable,
            "-B",
            "-c",
            verifier_code,
            str(state_path),
            str(release_path),
            nonce,
            str(audit_lock_fd),
            str(lock_device),
            str(lock_inode),
        ],
        output=sys.stdout.buffer,
        wall_time_seconds=9.0,
        audit_lock=audit_lock,
        drop_audit_lock_inheritance=drop_inheritance,
    )


def verifier_lock_inheritance_problems(
    temporary: Path,
    *,
    drop_inheritance: bool = False,
) -> list[str]:
    """Prove a verifier retains audit ownership after its worker is killed."""
    failures: list[str] = []
    lock_path = temporary / "verifier-lock-inheritance.lock"
    state_path = temporary / "verifier-lock-inheritance-state.json"
    release_path = temporary / "verifier-lock-inheritance-release"
    worker_log_path = temporary / "verifier-lock-inheritance-worker.log"
    nonce = secrets.token_hex(16)
    lock = lock_path.open("a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    descriptor_stat = os.fstat(lock.fileno())
    worker: subprocess.Popen[bytes] | None = None
    verifier_pid: int | None = None
    parent_descriptor_open = True
    with worker_log_path.open("wb") as worker_log:
        try:
            worker = subprocess.Popen(
                [
                    sys.executable,
                    "-B",
                    str(Path(__file__).resolve()),
                    "--verifier-lock-self-test-child",
                    "--verifier-lock-self-test-state",
                    str(state_path),
                    "--verifier-lock-self-test-release",
                    str(release_path),
                    "--verifier-lock-self-test-nonce",
                    nonce,
                    "--verifier-lock-self-test-fd",
                    str(lock.fileno()),
                    "--verifier-lock-self-test-device",
                    str(descriptor_stat.st_dev),
                    "--verifier-lock-self-test-inode",
                    str(descriptor_stat.st_ino),
                    *(
                        ("--verifier-lock-self-test-drop-inheritance",)
                        if drop_inheritance
                        else ()
                    ),
                ],
                cwd=ROOT,
                stdout=worker_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
                pass_fds=(lock.fileno(),),
            )
            deadline = time.monotonic() + 2.0
            authenticated = False
            while time.monotonic() < deadline:
                if state_path.exists():
                    try:
                        payload = read_json(state_path)
                    except ValueError:
                        time.sleep(0.01)
                        continue
                    if (
                        isinstance(payload, dict)
                        and set(payload)
                        == {
                            "kind",
                            "nonce",
                            "pid",
                            "parent_pid",
                            "lock_identity",
                            "inheritable",
                        }
                        and payload.get("kind")
                        == "durablerun-verifier-lock-child"
                        and payload.get("nonce") == nonce
                        and type(payload.get("pid")) is int
                        and type(payload.get("parent_pid")) is int
                        and payload.get("parent_pid") == worker.pid
                        and type(payload.get("lock_identity")) is bool
                        and type(payload.get("inheritable")) is bool
                    ):
                        verifier_pid = int(payload["pid"])
                        authenticated = process_id_is_live(verifier_pid)
                        if authenticated:
                            break
                if worker.poll() is not None:
                    break
                time.sleep(0.01)
            if not authenticated:
                failures.append(
                    "verifier lock inheritance: verifier did not publish "
                    "authenticated readiness"
                )
            else:
                lock.close()
                parent_descriptor_open = False
                os.kill(worker.pid, signal.SIGKILL)
                try:
                    worker.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    failures.append(
                        "verifier lock inheritance: killed worker was not reaped"
                    )
                if not process_id_is_live(verifier_pid):
                    failures.append(
                        "verifier lock inheritance: verifier exited with its worker"
                    )
                else:
                    contender = lock_path.open("a+")
                    acquired = False
                    try:
                        try:
                            fcntl.flock(
                                contender,
                                fcntl.LOCK_EX | fcntl.LOCK_NB,
                            )
                            acquired = True
                        except BlockingIOError:
                            pass
                    finally:
                        contender.close()
                    if acquired:
                        failures.append(
                            "verifier lock inheritance: a fresh coordinator "
                            "acquired the lock while an orphan verifier was active"
                        )
        finally:
            if parent_descriptor_open:
                lock.close()
            release_path.touch()
            if worker is not None and worker.poll() is None:
                try:
                    os.kill(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    worker.wait(timeout=2.0)
                except subprocess.TimeoutExpired:
                    failures.append(
                        "verifier lock inheritance: worker cleanup timed out"
                    )
            if verifier_pid is not None:
                deadline = time.monotonic() + 2.0
                while process_id_is_live(verifier_pid) and time.monotonic() < deadline:
                    time.sleep(0.01)
                if process_id_is_live(verifier_pid):
                    failures.append(
                        "verifier lock inheritance: orphan verifier did not terminate"
                    )
                    try:
                        os.killpg(verifier_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    contender = lock_path.open("a+")
    try:
        try:
            fcntl.flock(contender, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            failures.append(
                "verifier lock inheritance: lock remained held after verifier exit"
            )
    finally:
        contender.close()
    if worker is not None and process_id_is_live(worker.pid):
        failures.append("verifier lock inheritance: worker leaked after cleanup")
    if verifier_pid is not None and process_id_is_live(verifier_pid):
        failures.append("verifier lock inheritance: verifier leaked after cleanup")
    return failures


def worker_environment(
    plan: WorkerPlan,
    *,
    allow_host_sized_tokio: bool = False,
    allow_python_bytecode: bool = False,
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
    if allow_python_bytecode:
        environment.pop("PYTHONDONTWRITEBYTECODE", None)
    else:
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
    return environment


def worker_install_launch(
    plan: WorkerPlan,
    store: Path,
    *,
    audit_lock_fd: int,
    use_worker_default: bool = False,
    allow_online: bool = False,
    allow_unfrozen: bool = False,
    replace_command: bool = False,
) -> ProcessLaunch:
    return ProcessLaunch(
        f"install worker-{plan.worker_id:02}",
        worker_install_command(
            store,
            use_worker_default=use_worker_default,
            allow_online=allow_online,
            allow_unfrozen=allow_unfrozen,
            replace_command=replace_command,
        ),
        plan.path,
        plan.install_log,
        worker_environment(plan),
        (audit_lock_fd,),
    )


def worker_launch(
    plan: WorkerPlan,
    *,
    audit_lock_fd: int,
    phase: str,
    head: str,
    max_workers: int,
    run_root: Path,
    nonce: str,
    baseline_barrier: BaselineBarrier | None,
    allow_host_sized_tokio: bool = False,
    allow_python_bytecode: bool = False,
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
        "--worker-audit-lock-fd",
        str(audit_lock_fd),
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
        worker_environment(
            plan,
            allow_host_sized_tokio=allow_host_sized_tokio,
            allow_python_bytecode=allow_python_bytecode,
        ),
        (audit_lock_fd,),
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

    common_dir = git_common_directory(ROOT)
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
        shard_names = [[item.name for item in shard] for shard in shards]
        checkpoint_key = mutation_checkpoint_key(head, shard_names)
        checkpoint_directory = prepare_mutation_checkpoint_directory(
            common_dir,
            checkpoint_key,
        )
        checkpoint_reports = [
            mutation_checkpoint_report_path(common_dir, checkpoint_key, worker_id)
            for worker_id in range(len(shards))
        ]
        nonce = discover_mutation_checkpoint_nonce(
            checkpoint_directory,
            checkpoint_reports,
            shards,
            head=head,
        )
        pnpm_store = resolve_pnpm_store(ROOT)

        run_root = Path(
            tempfile.mkdtemp(prefix="durablerun-mutation-worktrees-")
        ).resolve()
        manifest_path = run_root / "manifest.json"
        baseline_barrier: BaselineBarrier | None = None
        plans = [
            WorkerPlan(
                worker_id,
                run_root / f"worker-{worker_id:02}",
                run_root / f"tmp-{worker_id:02}",
                run_root / f"baseline-{worker_id:02}.json",
                checkpoint_reports[worker_id],
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
        print(f"mutation audit checkpoint root: {checkpoint_directory}", flush=True)

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
                worker_install_launch(
                    plan,
                    pnpm_store,
                    audit_lock_fd=lock.fileno(),
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
                    audit_lock_fd=lock.fileno(),
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
                    audit_lock_fd=lock.fileno(),
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
                        nonce=nonce,
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
    ap.add_argument(
        "--routing-self-test",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--suite-timeout-self-test-child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--suite-linger-self-test-child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--suite-interrupt-self-test-child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-state",
        type=Path,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-release",
        type=Path,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-nonce",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-fd",
        type=int,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-device",
        type=int,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-inode",
        type=int,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--verifier-lock-self-test-drop-inheritance",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--suite-self-test-state",
        type=Path,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--suite-timeout-self-test-fault",
        choices=SUITE_TIMEOUT_SELF_TEST_FAULTS,
        help=argparse.SUPPRESS,
    )
    ap.add_argument("--self-test-fault", choices=SELF_TEST_FAULTS, help=argparse.SUPPRESS)
    ap.add_argument(
        "--orchestration-self-test-fault",
        choices=ORCHESTRATION_SELF_TEST_FAULTS,
        help=argparse.SUPPRESS,
    )
    ap.add_argument(
        "--routing-self-test-fault",
        choices=ROUTING_SELF_TEST_FAULTS,
        help=argparse.SUPPRESS,
    )
    ap.add_argument("--worker-phase", choices=("baseline", "mutations"), help=argparse.SUPPRESS)
    ap.add_argument("--worker-audit-lock-fd", type=int, help=argparse.SUPPRESS)
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
        args.routing_self_test,
        args.suite_timeout_self_test_child,
        args.suite_linger_self_test_child,
        args.suite_interrupt_self_test_child,
        args.verifier_lock_self_test_child,
    )
    if sum(bool(mode) for mode in self_test_modes) > 1:
        ap.error("self-test modes are mutually exclusive")
    verifier_lock_assignment = (
        args.verifier_lock_self_test_state,
        args.verifier_lock_self_test_release,
        args.verifier_lock_self_test_nonce,
        args.verifier_lock_self_test_fd,
        args.verifier_lock_self_test_device,
        args.verifier_lock_self_test_inode,
    )
    if args.verifier_lock_self_test_child:
        if any(value is None for value in verifier_lock_assignment):
            ap.error(
                "verifier-lock self-test child requires its complete assignment"
            )
    else:
        if any(value is not None for value in verifier_lock_assignment):
            ap.error(
                "verifier-lock self-test options require "
                "--verifier-lock-self-test-child"
            )
        if args.verifier_lock_self_test_drop_inheritance:
            ap.error(
                "--verifier-lock-self-test-drop-inheritance requires "
                "--verifier-lock-self-test-child"
            )
    if any(self_test_modes):
        if args.k or args.jobs != "auto" or args.worker_phase is not None:
            ap.error("self-tests cannot be combined with audit or worker options")
        if args.verifier_lock_self_test_child:
            return verifier_lock_self_test_child(
                args.verifier_lock_self_test_state,
                args.verifier_lock_self_test_release,
                args.verifier_lock_self_test_nonce,
                args.verifier_lock_self_test_fd,
                args.verifier_lock_self_test_device,
                args.verifier_lock_self_test_inode,
                args.verifier_lock_self_test_drop_inheritance,
            )
        suite_process_self_test = (
            args.suite_timeout_self_test_child
            or args.suite_linger_self_test_child
            or args.suite_interrupt_self_test_child
        )
        if suite_process_self_test:
            if args.suite_self_test_state is None:
                ap.error("suite process self-tests require --suite-self-test-state")
            if args.self_test_fault is not None:
                ap.error("--self-test-fault requires --classifier-self-test")
            if args.orchestration_self_test_fault is not None:
                ap.error(
                    "--orchestration-self-test-fault requires --orchestration-self-test"
                )
            if args.routing_self_test_fault is not None:
                ap.error("--routing-self-test-fault requires --routing-self-test")
            if (
                args.suite_timeout_self_test_fault is not None
                and not args.suite_timeout_self_test_child
            ):
                ap.error(
                    "--suite-timeout-self-test-fault requires "
                    "--suite-timeout-self-test-child"
                )
            if args.suite_timeout_self_test_child:
                return suite_timeout_self_test_child(
                    args.suite_self_test_state,
                    args.suite_timeout_self_test_fault,
                )
            if args.suite_linger_self_test_child:
                return suite_linger_self_test_child(args.suite_self_test_state)
            return suite_interrupt_self_test_child(args.suite_self_test_state)
        if args.orchestration_self_test:
            if args.self_test_fault is not None:
                ap.error("--self-test-fault requires --classifier-self-test")
            if args.routing_self_test_fault is not None:
                ap.error("--routing-self-test-fault requires --routing-self-test")
            return orchestration_self_test(args.orchestration_self_test_fault)
        if args.orchestration_self_test_fault is not None:
            ap.error(
                "--orchestration-self-test-fault requires --orchestration-self-test"
            )
        if args.routing_self_test:
            if args.self_test_fault is not None:
                ap.error("--self-test-fault requires --classifier-self-test")
            return routing_self_test(args.routing_self_test_fault)
        if args.routing_self_test_fault is not None:
            ap.error("--routing-self-test-fault requires --routing-self-test")
        classifier_result = self_test(
            args.self_test_fault,
            check_live_inventory=args.self_test,
        )
        if args.self_test:
            orchestration_result = orchestration_self_test()
            routing_result = routing_self_test()
            return classifier_result or orchestration_result or routing_result
        return classifier_result
    if args.self_test_fault is not None:
        ap.error("--self-test-fault requires --classifier-self-test")
    if args.orchestration_self_test_fault is not None:
        ap.error("--orchestration-self-test-fault requires --orchestration-self-test")
    if args.routing_self_test_fault is not None:
        ap.error("--routing-self-test-fault requires --routing-self-test")
    if args.suite_self_test_state is not None:
        ap.error("--suite-self-test-state requires a suite process self-test")
    if args.suite_timeout_self_test_fault is not None:
        ap.error(
            "--suite-timeout-self-test-fault requires --suite-timeout-self-test-child"
        )

    if args.worker_phase is not None:
        required_worker = (
            args.worker_audit_lock_fd,
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
                audit_lock_fd=args.worker_audit_lock_fd,
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
            args.worker_audit_lock_fd,
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
