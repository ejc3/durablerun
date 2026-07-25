# Single representation: one definition, one read path

Scope: `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts`, `scripts/*.py`, `scripts/*.sh`,
`.github/workflows/*.yml`. This rule is about *a value, statement, list, or constant that exists
twice* — one authoritative, the other a copy that can drift. It does NOT cover: a batch computing an
instant or an eligibility decision twice (DESIGN.md §3.4 rules 1, 3 and 8 — the batch-fencing rule
owns that); which validator a user input passes through (§3.4 rule 7, the user-boundary rule — this
rule only cares about *which of that validator's outputs* is used downstream); and `specs/*.tla`,
a sanctioned second representation of the protocol reconciled by `scripts/spec-ledger.py`.

The invariant is CLAUDE.md's second SDK-residual law: *a value that crosses a boundary is produced
in canonical form at the SOURCE — two read paths for one value is where divergence lives.* The
incident that proves it is finding 42 of `postmortems/pr3.6-fence-provenance.md`. The query-plan
suite pinned `emitEvent`'s fan-out by `EXPLAIN`-ing a statement typed into the test and introduced
in a comment as "structurally the same" as the one the engine sends. Three review rounds added
conditions to the real statement; none reached the copy. Measured consequence: deleting the entire
index driver from the shipped statement left the plan suite green while every emit fell back to
`SCAN runs` — a full scan of the largest table in the engine, on every event, with nothing failing.
The pin is now recovered by running the real operation through a recording `SqlExecutor`
(`packages/store-libsql/test/query-plans.test.ts:147-168`, `shippedWakeStatement`).

Two smaller instances give the class its range. Finding 32: the SDK sent the raw event name on
`await` and `UserName.parse`'s output on `emit` — identical strings today, a silently lost wakeup
the day `parse` normalizes anything. Finding 22: the retry cap tested `attempts + 1 < max_attempts`
at one site while the counter derived `attempt - infra_retries` at another — two spellings of one
quantity that agree on the healthy path and disagree exactly where a bug already put the counter,
failing a task permanently one attempt early. Both were fixed by deleting one spelling, not by
making the two agree.

Report a failure when the changed code introduces or materially expands any of these:

- **A query plan pinned against SQL written in the test file.** A string handed to `EXPLAIN` /
  `EXPLAIN QUERY PLAN` that is a literal in the test rather than the shipped text — an imported
  constant (`NEXT_WAKE_SQL`, `SWEEP_SCAN_CANCELS_SQL`, `SWEEP_SCAN_EXPIRED_SQL` from
  `packages/store-libsql/src/index.ts`) or a statement recorded off a real call, as
  `shippedWakeStatement` does. Purely syntactic and decidable: look at what the EXPLAIN argument
  is. This is finding 42 verbatim.
- **A copy justified by a comment instead of a check.** "structurally the same", "mirrors",
  "equivalent to", "kept in sync with", "same shape as the shipped X" — used *about the changed
  code's own relationship to another text in the tree*, with nothing in the diff that fails when
  they diverge. The phrase is the whole finding: it asserts a relationship only a machine can hold.
  `packages/store-libsql/src/store.ts:88-92` records what happens without one — `reschedule` and
  `suspendRun` were *documented* as one transition and their eligibility guards had already
  drifted, which is why `taskMirrorsRun` exists.
- **A contract value or derived quantity respelled where a single definition is importable.**
  `RELAUNCH_CAP`, `INFRA_RETRY_CAP`, `INFRA_BACKOFF_SECONDS`, `RELAUNCH_BACKOFF_*`, `REASON_*`,
  `FENCED_TABLES` (`packages/core/src/contract.ts`); `LIVE`, `QUEUED`, `eligibleTask`, `cancelDue`,
  `successor`, `fenced`/`fencedAt`/`fenceFrom` (`packages/store-libsql/src/fragments.ts`);
  `USER_ATTEMPTS_FROM`, `INFRA_RETRIES_FROM`, `CHECKPOINT_LWW`, `CLAIMED_RUN_COLUMNS`
  (`store.ts:64-134`); the user-visible attempt ordinal, whose one TS definition is
  `ReplayContext.attempt = run.attempt - run.infraRetries` (`packages/sdk/src/context.ts:95`, read
  once at `packages/sdk/src/run-worker.ts:186`); `CLAIM_LIMIT`
  (`packages/conformance/src/fault-matrix.ts:15`). An *arithmetically equivalent but differently
  spelled* derivation of one of these quantities counts — that is finding 22, and it type-checks.
- **A hand-maintained inventory with no reconciliation.** A new literal array, set or dict
  enumerating batch labels, checkers, migration columns, template placeholders or verify steps,
  when the authoritative artifact is readable at run time and nothing in the diff fails if the two
  disagree. Finding 8: the attestation gate listed 2 of ~12 `TEMPLATE.md` placeholders beside the
  template, so a verbatim copy of the template attested as a filled-in postmortem. The finding is
  the missing reconciliation, not the list.
- **One value handed to two sinks in two forms.** Two calls that must agree receive different
  expressions of the same value — the raw input to one and the validated/parsed value to the other
  (finding 32: `name` vs `parsed.value`, now settled at `context.ts:253-260`); the in-memory object
  on the executing pass and the serialize-then-parse value on replay (`ctx.step` returns
  `JSON.parse(stateJson)` on *both*, `context.ts:168-173` — a change that returns `raw` instead is
  this finding).
- **Two interpretations of one column set.** Two branches or two call sites that apply *different
  conditions* to the same columns — one requiring a field, another defaulting or falling back when
  it is absent. PR #11 finding C was exactly this: one path required `wake_step` alongside
  `wake_event`, a second fell back to the bare event name
  (`postmortems/pr11-codex-final-review.md:96-108`).

Allowed cases (do NOT flag these):

- **A labelled negative control asserting the DEGRADED plan.**
  `packages/store-libsql/test/query-plans.test.ts:178-190` hand-writes the shape that shipped
  briefly and asserts `toContain('SCAN runs')` — the opposite of the pin above it — so the positive
  assertion is known to discriminate rather than be vacuous. Decidable: the assertion is the bad
  plan, not the good one.
- **Deliberately independent oracles.** `packages/conformance/test/wake-witness-surface.test.ts:22-27`
  says it outright — its oracle is shaped one row at a time precisely because the SQL is not.
  `packages/conformance/src/invariants.ts:18,38,45,88,97,106` restates the live and terminal state
  lists for the same reason: importing the engine's own predicate would make the checker agree with
  the engine by construction.
- **A copy that reports its own staleness.** `scripts/mutation-probe.py:26` stores verbatim source
  snippets in `MUTATIONS` — the copy *is* the address of the guard being deleted — and one that
  stops matching prints "pattern not found in … the mutation is stale" and is recorded as a
  survivor (`:261`), so a rewritten guard cannot quietly stop being probed.
- **A classification list whose harvest is total, or that a machine reconciles.** `MATRIX_WRITE_LABELS`
  / `MATRIX_READ_LABELS` / `MATRIX_EXEMPT_LABELS` (`fault-matrix.ts:29-63`) duplicate the store's
  labels on purpose — they classify them — and `packages/conformance/test/label-inventory.test.ts`
  asserts equality against the same harvester the spec ledger uses. Likewise `READS`,
  `SINGLE_WRITES`, `TOKEN_FENCED`, `MULTI_CLOCK`, `DYNAMIC` in `scripts/batch-lint.py:37-73`
  (an unclassified label fails the lint), `NOT_IN_GATE` in `scripts/gate-lint.py` (deliberately in
  the script, not the tree, and checked in both directions), `EXEMPT` in
  `scripts/lint-selftest.py:370`, and key lists the type system reconciles (`FuzzStats` totals in
  `packages/conformance/test/fuzz-shard-runner.ts:26-39`). Adding an entry to one of these is how
  they are meant to grow.
- **Per-dialect SQL and DDL written out again.** Every `store-*` package writes its own statements;
  that is the pluggability law. `packages/store-libsql/src/schema.ts:38,57,65` repeats the state
  lists in `CHECK` constraints and a partial index — definitional DDL, exempt from `fragment-lint.py`
  by name. A store-pg migration repeating a table definition is correct; a store-pg copy of
  `INFRA_RETRY_CAP` is not.
- **Raw fixture SQL in tests that reads or builds engine state.** ~26 test files execute
  `SELECT`/`INSERT`/`UPDATE` against `runs`, `tasks`, `waits`, `events`, `checkpoints` to assert
  state or manufacture a pre-state the API cannot reach — `packages/conformance/test/regressions.test.ts:151-157`
  corrupts a task to `cancelled`, `packages/conformance/test/legacy-rows.test.ts` NULLs a column to
  make a pre-migration row, `packages/core/test/fenced-batch.test.ts` inserts rows directly.
  CLAUDE.md names raw fixture SQL as one of the seams that make bug classes red-testable. None of it
  claims to be what production runs. `legacy-rows.test.ts:32-44` even *derives* its column list from
  `MIGRATIONS`, which is the shape to praise; and `generated-selection.test.ts:10-16` explains why
  asserting on generated SQL *text* would be the wrong direction.
- **A contract value written literally in an assertion about observable output.**
  `packages/conformance/src/suite.ts:302` asserts `failure_reason: '{"name":"$ClaimTimeout"}'`
  rather than importing `REASON_CLAIM_TIMEOUT` — the conformance suite is the language-neutral
  contract, so importing the TS constant would make it agree by construction and a Rust peer could
  not run it. Contrast `fault-matrix.ts:140-143`, which imports `INFRA_RETRY_CAP`/`RELAUNCH_CAP`
  because it *constructs* a boundary pre-state rather than asserting the cap's value. Assert the
  literal; construct from the constant.
- **Diagnostics echoing the raw user input.** `context.ts:154,233,244` put the caller's `name` into
  error messages while `parsed.value` is what goes downstream (`:260`). An error that quotes what
  the user typed is not a second read path.
- **Per-query row decoders.** `store.ts` decodes several different row shapes
  (`:319-323`, `:617-635`, `:1234-1238`, `:1316-1318`, `decodeClaimedRun` at `:1650-1679`). Two
  `Number(row.attempt)` calls in different result types are not two interpretations — only differing
  *conditions* on the same column set are.

When reporting, do not stop at "this is duplicated". Name (1) the value that now has two
representations and the file:line of each, (2) which one is authoritative, and (3) the mechanism
that should have made the copy impossible or drift-loud, with its rung: **rung 1 — delete the copy**
(import the constant, export the statement, return the canonical value at the source); **rung 2 —
derive it** (`gate-lint.py` reads `package.json`; `legacy-rows.test.ts` reads `MIGRATIONS`;
`label-inventory.test.ts` shells the spec-ledger harvester; `shippedWakeStatement` records the real
executor); **rung 3 — reconcile it** (a test that fails when the two disagree, plus a staleness
report when the copy stops matching, as the mutation probe does). If the second representation is
genuinely required — an oracle, a per-dialect implementation, a negative control — then the finding
is the *missing reconciliation*, not the duplication, and must be reported that way. A finding that
ends without naming a mechanism has patched the net instead of the hole.
