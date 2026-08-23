# Dialect portability: the engine layer must be spellable in three dialects

<!-- review-bot-scope:start -->
packages/core/src/**
packages/sdk/src/**
packages/driver/src/**
packages/harness/src/**
packages/conformance/src/**
packages/conformance/test/**
packages/store-*/src/**
scripts/**
DESIGN.md
specs/*.tla
<!-- review-bot-scope:end -->

Scope: `packages/core/src/**`, `packages/sdk/src/**`, `packages/driver/src/**`,
`packages/harness/src/**`, `packages/conformance/src/**`,
`packages/conformance/test/**`, `packages/store-*/src/**`, `scripts/**`,
`DESIGN.md`, `specs/*.tla`. This rule asks one question of a diff: can this be
executed, unchanged in meaning, by SQLite/libSQL, MySQL 8 and Postgres — and is
the contract that says so written where a non-TypeScript port can read it. It
does NOT cover fence and provenance correctness (§3.4 rules 1 and 8 — the
fence-provenance rule owns those), whether a new protocol was TLC-modelled
before its SQL (the spec-first rule), postmortem and attestation process, or
duplication and altitude (the simplify rule). SQLite-only correctness traps
*inside* `packages/store-libsql` — partial-index usability, `LIMIT -1` meaning
unlimited, compound-SELECT `ORDER BY` — belong to the store-SQL rule.

The invariant is CLAUDE.md's standing law in three parts. Engine logic never
contains dialect-specific SQL or dialect-specific behaviour; everything a
backend spells its own way lives in a `store-*` package behind the ports. A
dialect is DONE when its `StoreFixtureFactory` passes the identical
`@durablerun/conformance` suite — no dialect-specific test forks, ever. And the
authoritative contract is language-neutral — the shared schema, each labelled
batch's SQL semantics, the wire formats, the TLA+ spec, the conformance
scenarios — never TypeScript types alone.

The incident is in the spec itself, which is why this rule reaches DESIGN.md.
§3.4 rule 3 shipped naming `clock_timestamp()` as Postgres's clock expression.
`clock_timestamp()` re-reads the wall clock per call, so one statement using it
twice writes two different instants — which makes rule 8 unsatisfiable on
Postgres, because rule 8 requires each statement to record the ONE instant it
read into `fence_at_ms` and every follow-on to derive from that. The whole
write-provenance scheme, not implementable on a dialect the design promises. No
mechanism caught it; a human measuring all three dialects' clock expressions
while planning PR3.6 did (`postmortems/pr3.6-batch-fence-plan.md`: *"`DESIGN.md`
currently names `clock_timestamp()`, which is per-call. That is a live spec
bug"*). Its sibling shipped as code the same round: `clock-lint`, the mechanism
that confines database time to one expression, was case-sensitive with
per-alternative casing, so "`UNIXEPOCH()` and `now()` both passed; `now()` is
the canonical Postgres spelling" (`postmortems/pr3.6-fence-provenance.md`,
finding 10, whose "layer that should have caught it" column reads *Nothing*).
Both defects have one shape — a rule about three dialects written in one
dialect's spelling — and nothing in this repo executes the other two, so the
error stays invisible until Phase 4, when the fix is a rewrite of a primitive
rather than a patch to a store.

<!-- review-bot-synopsis:start -->
Flag dialect-only SQL or backend-behaviour assumptions added above the store layer (packages/{core,sdk,driver,harness,conformance}/src — `||` concat, instr, typeof, `x IS NOT y`, clock calls, upsert/RETURNING/FOR UPDATE, NULL-orderable sorts, rowsAffected-decided winners), cross-dialect constants defined inside a store-* package instead of core/contract.ts, checkers that match SQL case-sensitively or with one dialect's vocabulary or glob packages/store-libsql instead of packages/store-*, a per-dialect spelling entering DESIGN.md §3.4 or specs/*.tla without the required property stated and checked for all three dialects, conformance code that branches/skips on a dialect or puts a shared-schema §3.4 scenario in a single-dialect test file instead of conformance/src/suite.ts, and new protocol facts recorded only in TypeScript. Pass for store-* eligibility fragments and DDL state lists (fragments.ts, schema.ts — mandated by §3.4 and fragment-lint), case-sensitive matching against repo-generated tokens ($NOW$, $STAMP$, FENCE_SET, fence_stamp), sorts already guarded IS NOT NULL or built from a non-nullable CASE, portable SQL skeletons and shared-schema raw SQL in core and the conformance suite (FencedBatch.derived, suite.ts, fault-matrix.ts), dialect SQL inside packages/store-*, a dialect named in prose as rationale for a stricter portable check, port contracts that name and normalize divergence, bin/ composition roots and test/ per-dialect fixtures and store-internal tests, pre-existing debt in a touched file (report once, not per line), and facts already deferred under BUILD.md's PR4.1.
<!-- review-bot-synopsis:end -->

Report a failure when the changed code introduces, or extends into a new
construct class, any of these:

- **Dialect-only SQL in a neutral package.** SQL text — a template literal, an
  exported constant, or a pattern matched against SQL — in
  `packages/{core,sdk,driver,harness,conformance}/src` using a construct at
  least one target dialect spells differently or *reads* differently. Say what
  it does there, not that it is "unsupported":
  `||` as concatenation (MySQL's default `sql_mode` omits `PIPES_AS_CONCAT`, so
  it is logical OR and the expression evaluates to 0/1, silently);
  `instr(x, y)` (no such function on Postgres — the statement raises and the
  check never runs);
  `typeof(x)` (SQLite only; `pg_typeof` reports a declared type, not a per-value
  storage class, and MySQL has no equivalent);
  `x IS NOT y` where `y` is not NULL/TRUE/FALSE/UNKNOWN (SQLite's null-safe
  inequality — a syntax error on Postgres and MySQL, which spell it
  `IS DISTINCT FROM` and `NOT (x <=> y)`);
  clock calls (`unixepoch`, `strftime`, `julianday`, `datetime('now')`, `NOW(`,
  `SYSDATE`, `CURDATE`, `CURTIME`, `CURRENT_TIMESTAMP`, `clock_timestamp`,
  `statement_timestamp`);
  `PRAGMA`; `WITHOUT ROWID`; `AUTOINCREMENT`; a `WHERE` on `CREATE INDEX`;
  upsert syntax (`ON CONFLICT`, `DO UPDATE`, `ON DUPLICATE KEY UPDATE`,
  `INSERT OR IGNORE`/`OR REPLACE`); `RETURNING`; `FOR UPDATE` / `SKIP LOCKED`;
  `LIMIT` on `UPDATE`/`DELETE`; backtick or double-quote identifier quoting;
  `IFNULL`; and `MIN`/`MAX` called with more than one argument (Postgres and
  MySQL have only `LEAST`/`GREATEST`). The correct shape is in tree:
  `FencedBatch` never names a clock function, it splices the `$NOW$` token from
  `opts.now`, which each store supplies (`packages/store-libsql/src/time.ts`).

- **A backend behaviour assumed above the store.** Only the members a reviewer
  can settle from the diff: a sort whose key can be NULL at the point of the
  sort, with no `NULLS FIRST`/`NULLS LAST`, no `IS NOT NULL` guard, and no
  expression that cannot return NULL (SQLite and MySQL sort NULLs first
  ascending, Postgres last); `rowsAffected` deciding a winner for a CAS whose
  SET clause can be value-identical to the row's current state (SQLite reports
  1, MySQL reports 0 changed rows — measured, `pr3.6-batch-fence-plan.md`);
  `RETURNING` or a targeted `ON CONFLICT (cols)` used to learn which constraint
  a write hit; or a diff whose written correctness argument cites SQLite's
  single writer serializing a batch with no Postgres/MySQL realization named
  (§3.4 rule 2 requires an explicit row-lock prelude there). A new `FencedBatch`
  statement kind, win rule, or construction check only SQLite can satisfy is
  this same finding at the primitive, where it is most expensive.

- **A cross-dialect constant or wire value defined inside a store package.**
  Anything every dialect must agree on — a cap, a backoff, an engine-written
  `failure_reason` JSON, a derived-key format, the fenced-table list, an error
  classification the SDK branches on — introduced in `packages/store-*/src`
  instead of `packages/core/src/contract.ts`, whose header gives the reason:
  *"a constant defined inside one backend is a constant the other backends can
  drift from silently."* `FENCED_TABLES` is the shape that is right: the list
  lives in core, `packages/store-libsql/src/schema.ts` generates migration v4's
  DDL from it, and `FencedBatch` accepts nothing else as a CAS target, so a
  compare-and-set against a table with nowhere to record provenance does not
  compile in any dialect.

- **A checker that spells an all-dialect rule in one dialect.** A new or edited
  pattern in `scripts/`, or a construction check inside `FencedBatch`, that
  (a) matches SQL keywords or builtins case-sensitively, or with
  per-alternative casing — SQL is case-insensitive, so the check grades only
  the spelling its author typed; (b) draws its alternatives from one dialect's
  vocabulary; or (c) globs `packages/store-libsql` where the rule is about
  every store. All three archetypes are in tree: finding 10 above is (a);
  `assertWritesStamp`'s upsert re-stamp requirement keys on `/\bDO\s+UPDATE\b/i`
  (`packages/core/src/fenced-batch.ts`), so a MySQL `ON DUPLICATE KEY UPDATE`
  branch that leaves the conflicting row's provenance alone passes construction
  — (b); and `scripts/spec-ledger.py` harvests `packages/store-libsql/src`
  alone while `batch-lint.py`, `clock-lint.py` and `fragment-lint.py`
  all glob `packages/store-*/src`, so a second store's batch labels would enter
  no ledger line, get no duplicate-semantics tag, and be enrolled in no
  fault-matrix cell while `label-inventory.test.ts` still passes — (c).

- **A per-dialect spelling entering the contract without its property, stated
  for all three.** In `DESIGN.md` §3.4 or `specs/*.tla`: a rule that names a
  construct for one dialect — a clock expression, a lock spelling, an upsert
  form, an ordering, an isolation level — must name it for all three, state the
  property the construct has to have, and say whether each named construct HAS
  it. This is the incident above, and the corrected text is the template: rule
  3 now reads *"The clock expression must be at least statement-stable … Measured:
  SQLite `unixepoch('subsec')` is (4000/4000 identical); MySQL `NOW(6)` is …
  and `SYSDATE()` is NOT; Postgres `statement_timestamp()` and `now()` are, and
  `clock_timestamp()` is NOT"*. Two of the three checks are syntactic — are all
  three dialects named, is the required property written down — and the third,
  does each named construct satisfy it, is the finding's substance.

- **The conformance suite learning which dialect it is running against.** In
  `packages/conformance/src/**`: importing a `store-*` package, branching on the
  `dialect` string parameter of `schedulerConformance` (today it reaches only
  the `describe` label), `it.skipIf` / `runIf` / `.skip`, gating a scenario on
  an env var, or asserting a driver-specific error message or class instead of
  the core error type (`LeaseLostError`, `SchemaMismatchError`,
  `StoreUnavailableError`).

- **A §3.4 behaviour placed in a single-dialect test file.** A new file or case
  under `packages/conformance/test/` that drives only public `SchedulerStore` /
  `StoreAdmin` methods plus raw SQL over the SHARED schema — importing no
  `MIGRATIONS`, no DDL, no `EXPLAIN`, nothing from a store class beyond what
  `StoreFixture`'s `store`, `admin`, `raw` and `storeOver` already offer —
  belongs in `packages/conformance/src/suite.ts`. Such a test runs against
  libSQL forever and against store-postgres never, which is the "no
  dialect-specific test forks" law failing quietly instead of loudly.

- **A new protocol fact recorded only in TypeScript.** A fenced table, a
  provenance or derived-key format, a wire value, or a protocol-visible outcome
  added with no language-neutral counterpart in the same diff: the shared
  schema, `specs/Scheduler.tla` (ledger line with its duplicate-semantics tag),
  §3.4's text or dialect table, or a conformance scenario. Mechanical from the
  diff's file list. A future Rust peer implementing the same labelled batches
  must be able to work from those artifacts alone.

Allowed cases (do NOT flag these):

- **Eligibility fragments and DDL state lists inside a store package.**
  `packages/store-libsql/src/fragments.ts` defines `LIVE =
  ('pending','running','sleeping')`, `QUEUED`, `cancelDue`, `cancelNotDue` and
  `eligibleTask`; `schema.ts` writes `CHECK (state IN ('pending','running',
  'sleeping','completed','failed','cancelled'))`. These read as "a protocol
  state list and predicate defined in a store package", but DESIGN.md §3.4's
  structural-enforcement list REQUIRES them there — *"what 'live', 'cancellation
  due', and 'eligible to proceed' mean is spelled once per dialect"* — and
  `scripts/fragment-lint.py` fails the build if a state list appears anywhere
  else in store source (`EXEMPT = {'fragments.ts', 'schema.ts'}`). Core owns the
  values a dialect cannot respell (caps, reason JSON, `FENCED_TABLES`); a store
  owns how its dialect spells a predicate over them.

- **Case-sensitive matching against tokens this repo itself generates.**
  `head.includes(FENCE_SET)`, `sql.includes(NOW)`, and
  `/fence_stamp\s*=\s*\$FENCE:[a-zA-Z0-9_-]+\$/g` in
  `packages/core/src/fenced-batch.ts` carry no `i` flag. The failure shape above
  is about SQL keywords and builtins an author types by hand; these match
  `$NOW$`, `$STAMP$`, `$FENCE:x$` and the `fence_stamp` / `fence_at_ms` column
  names, which only the primitive and the exported `FENCE_SET` ever produce, in
  exactly one casing. The same file's real keyword checks already are
  case-insensitive (`matchesWord` uppercases before comparing `WHERE` and `OR`).

- **Sorts already guarded against NULL.** The claim's `ORDER BY
  r.available_at_ms, r.run_id` is preceded by `AND r.available_at_ms IS NOT
  NULL`; spawn's receipt sorts on `CASE WHEN ? IS NOT NULL AND t.idempotency_key
  = ? THEN 0 ELSE 1 END, t.task_id` with the comment *"deterministic on every
  dialect; an `ORDER BY (t.task_id = ?) DESC` would not be, since Postgres sorts
  NULLs first"* (`packages/store-libsql/src/store.ts`). Those are the fix, not
  the shape. `ORDER BY attempt` on a NOT NULL column is likewise fine.

- **Portable SQL skeletons in `core`.** `FencedBatch.derived()` composes
  `UPDATE <target> SET … WHERE <key> IN (SELECT f.<column> FROM <from> f WHERE …
  AND f.fence_stamp = …)` and `DELETE FROM <target> WHERE …`. That is SQL inside
  `packages/core/src` and it is the mechanism, not a leak: the shape is identical
  in all three dialects, and everything dialect-specific it touches arrives as a
  token (`$NOW$`, `$STAMP$`, `$FENCE:x$`) or a store-supplied string.

- **Shared-schema SQL in the conformance suite.**
  `packages/conformance/src/suite.ts` asserts with statements like `SELECT state,
  attempt, available_at_ms FROM runs WHERE task_id = ?` and `SELECT COUNT(*) AS n
  FROM tasks`, and `packages/conformance/src/fault-matrix.ts` seeds edge states
  with plain `INSERT INTO tasks (…) VALUES (?, …)`. The schema is part of the
  contract (§3.4) and the suite's header says so. `Number(count?.rows[0]?.n)`,
  normalizing a driver's bigint-vs-number return, is portability work, not a fork.

- **Dialect SQL inside a `store-*` package.** `unixepoch('subsec')` in `time.ts`;
  `WITHOUT ROWID` and partial indexes in `schema.ts`; `PRAGMA journal_mode=WAL`
  and the `SCHEMA_FAULT` regex over SQLite's error wording in `executor.ts`;
  `CHECKPOINT_LWW`'s `ON CONFLICT (task_id, checkpoint_name) DO UPDATE` in
  `store.ts`. That is precisely what the package boundary is for.

- **A dialect named in `core` prose as the reason for a stricter portable
  check.** `UserName.parse` rejects NUL because "A NUL truncates a SQLite TEXT
  value at the first byte"; `MAX_COUNT` is justified by "an ordinal SQLite stores
  happily and JavaScript cannot represent". Each check is a superset that behaves
  identically on every backend; the dialect appears only in the rationale.

- **Port contracts that name a divergence and normalize it.**
  `SqlResult.rowsAffected`'s *"Normalized contract (backends diverge natively)"*;
  `SqlBatchMode`'s `'read' | 'write'`; the executor normalizing `ArrayBuffer` to
  `Uint8Array`. Writing a backend difference down at the port and erasing it
  there is the mechanism this rule asks for.

- **Composition roots, per-dialect runners, and store-internal tests.**
  `packages/driver/bin/driver-host.ts` and `worker-host.ts` construct
  `LibsqlExecutor`; `packages/conformance/test/fixture-libsql.ts` builds the
  fixture and `libsql.test.ts` is the single line `schedulerConformance('libsql',
  makeLibsqlFixture)`. `packages/store-libsql/test/query-plans.test.ts` (EXPLAIN
  QUERY PLAN pins), `schema.test.ts` (frozen migration hashes) and
  `executor.test.ts` (rowsAffected, blob normalization) are per-dialect facts by
  definition. So are the conformance tests that need store internals:
  `legacy-rows.test.ts` (imports `MIGRATIONS`) and `label-inventory.test.ts`
  (shells out to the harvester).

- **Pre-existing dialect debt in a file the diff merely touches.**
  `packages/conformance/src/invariants.ts` already uses `||`, `instr`, `typeof`
  and `IS NOT` throughout; `clock-jitter.test.ts`,
  `fence-provenance-regressions.test.ts`, `replay-after-the-world-moved.test.ts`
  and `wake-witness-surface.test.ts` construct `LibsqlSchedulerStore` directly.
  Report each such file ONCE, as one finding with one mechanism. A later diff
  adding a checker in the file's established idiom is not a new finding; a
  construct class the file does not already contain is.

- **Deferrals already recorded under a live PR entry in BUILD.md.** The Postgres
  double-claim, rule 2's lock prelude, and MySQL's matched-not-changed winner sit
  under Phase 4's PR4.1, marked decidable only with a second dialect in hand. Do
  not re-report them. DO report a change that WIDENS one — new engine-neutral
  code newly depending on `rowsAffected` to decide a winner is a finding even
  though the deferral exists.

Name three things or the finding is not actionable. First, the dialect and the
exact construct, and what it DOES there — "`instr` does not exist on Postgres,
so this statement raises and the invariant never runs" and "`||` is logical OR
under MySQL's default sql_mode, so this label evaluates to 0" are findings; "may
not be portable" is not. Second, the layer that should have caught it and why it
could not: `batch-lint`, `clock-lint` and `fragment-lint` all glob
`packages/store-*/src` and therefore never read `packages/core/src`,
`packages/sdk/src` or `packages/conformance/src`, and `spec-ledger.py` harvests
`packages/store-libsql/src` alone — so the neutral layer, the layer this rule is
about, is unscanned by every mechanism that scans SQL. Third, the mechanism at
the highest rung the class allows: move the value into `core/src/contract.ts`
and generate each dialect's DDL or SQL from it (the `FENCED_TABLES` shape, rung
1); widen a checker's glob to `packages/store-*` and add both a
`scripts/lint-selftest.py` fixture it must REJECT and the nearest one it must
still ACCEPT (rung 2); move the scenario into `conformance/src/suite.ts` so every
fixture runs it (rung 2); or write the measured fact into §3.4's dialect table so
it is contract rather than folklore. If the property genuinely cannot be decided
until a second store exists, the finding is a BUILD.md deferral under the PR that
will do it — `scripts/deferral-lint.py` enforces the placement — never a note to
review more carefully at Phase 4. A reviewer catching this class is the last net,
not the mechanism.
