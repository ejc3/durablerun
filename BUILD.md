# Build plan: phases → PR stack of tractable diffs

Companion to DESIGN.md (the spec). Rules for every PR: lands green (lint,
format, unit + conformance) before the next branches off it; adds the
conformance cases for what it builds; updates DESIGN.md in the same diff if
behavior diverges; target ≤ ~800 diff lines including tests. Stack coherence
per the global workflow rules: each PR branches from the previous PR's branch.

Workspace shape (pnpm):

```
packages/
  core/          engine types, port interfaces, retry math — zero I/O deps
  conformance/   the dialect-agnostic suite; takes a SchedulerStore factory
  store-libsql/  SQLite dialect via libsql (file:/:memory: now; Turso Cloud
                 URLs are the same dialect — cloud wiring lands in Phase C)
  store-postgres/ Absurd-SQL transliteration    (Phase 4)
  store-mysql/   token-claim dialect            (Phase 4)
  driver/        tick() + resident loop (+ serverless handlers in Phase C)
  sdk/           ctx API (step / sleepFor / awaitEvent / spawn)
apps/
  web/           (Phase C) Vercel app: /api/tasks|events|tick|worker|inspect
```

**LOCAL-FIRST ORDERING (decided 2026-07-18): everything through Phase 5 runs
entirely on this machine** — SQLite via `file:`/`:memory:` libsql, Postgres and
MySQL in containers (podman), the driver and workers as local Node processes
over localhost HTTP. No cloud account is touched until Phase C. "CI" until a
remote exists = `pnpm verify` (lint + format + typecheck + test) run locally
before every commit.

## Phase 0 — rails (local)

- **PR0.1 scaffold**: `git init`; pnpm workspace + TS strict (`.js` specifiers,
  ts-api lessons); lint/format; `pnpm verify` gate; repo CLAUDE.md (commands +
  invariants pointer). *Gate: verify green on empty suite.*
- **PR0.2 externally owned review configuration** — NOT STARTED. CodeRabbit
  and Greptile both select review configuration from the pull request's source
  branch, so no file in this repository can stop that same branch from
  weakening its review rules. Move the required rules into an organization-
  or service-managed policy that a pull request cannot edit, then make that
  policy a required check. Until an administrator does that, both hosted
  reviews are advisory and source-branch-owned; `base-gate` independently
  grades code but does not change their configuration provenance.

## Phase 1 — scheduler plane on SQLite (inline placement)

Primitives-first rule for this whole phase: the engine is built on exactly
three controllable primitives — `SqlExecutor` (`batch(label, stmts) → rows`,
the ONLY I/O), `IdSource` (all ids/tokens injected), and DB-side time with the
`fake_now` override. Actors (tick, worker) may only `await` port calls, so the
harness owns every suspension point. Correctness falls out of controlling
these three things; nothing else in the system does I/O, time, or randomness.

- **PR1.1 core types + ports + primitives**: SchedulerStore/Launcher/
  WakeSignals interfaces; `SqlExecutor` + `IdSource`; Task/Run/Lease types;
  retry-policy math (pure, unit-tested); error taxonomy (Suspend,
  LeaseLost≙AB002, RunSuperseded≙AB001). No I/O.
- **PR1.2 schema + store skeleton**: DDL (tasks/runs/checkpoints/events/waits +
  shard-meta with fake_now + schema_version); idempotent migration runner
  (memoized batch DDL); store-libsql over `SqlExecutor` (`file:`/`:memory:`).
  Turso Cloud specifics (remote URLs, auth, readiness gate) → Phase C.
- **PR1.3 simulation harness v1 (before the claim machinery, deliberately)**:
  seeded deterministic scheduler serializing actor port-calls; crash injection
  before/after any labeled batch; batch duplication (at-least-once channels);
  fake-now time control; failure replay by seed. Jepsen-style checkers over
  the store: no double-execution, no lost run, monotonic fences.
- **PR1.4 spawn / claim / activate / heartbeat**: the fenced claim batch with
  `claim_gen`, per-claim activation CAS, heartbeat CAS — each landing with its
  scripted sims + fuzz coverage. Conformance: idempotent spawn; N concurrent
  ticks never double-claim; duplicate delivery dies on the CAS; zombie
  heartbeat returns lease-lost.
- **PR1.5 sweep + cancellation**: activation-state classification — lost-launch
  reopen (relaunch counter, backoff, terminal cap) vs `$ClaimTimeout` successor
  (`infra_retries`, carried fields); cancellation policies. Sims: no attempt
  burn on lost launch; crash-mid-sweep idempotent; cap → terminal failure.
- **PR1.6 transitions + checkpoints**: complete/fail/reschedule as post-state
  fenced batches (§3.4 rule 1); retry-run insert; checkpoint upsert with lease
  fence; nextWakeAt. (Repeat counters — `name`, `name#2` — are SDK-side
  naming, deliberately deferred to PR2.3: the store stores whatever
  checkpoint name the SDK derives.) Sims: zombie
  complete is a no-op; chaining is attempt-neutral. Nightly seeded-fuzz run
  wired into `pnpm verify:fuzz`. Two FDB adoptions land here: a determinism
  lint (Date.now/Math.random/timers banned in core/driver/sdk — discipline
  becomes structure) and buggify flags (sim-only spurious lease-lost, short
  claims, failed heartbeats — engine code must survive its own error paths).

## Phase 2 — drive (both modes) → first dogfood

- **PR2.1 tick()**: pure composition over the ports (cancel→sweep→claim→launch→
  next-wake, K/K_s bounds, successor-tick rule). Unit-tested against fakes.
- **PR2.2 resident driver**: loop + adaptive sleep-until-next-wake + `/wake` +
  graceful shutdown (asyncio-style lifecycle discipline, TS edition);
  single-shard registry heartbeat row. Runs locally against `turso dev`.
  Carries a deliberate deferral from the PR2.1 review: a launch watchdog —
  a hanging launcher call currently stalls its tick, and the timeout seam
  (an injected clock, since engine code bans ambient timers) belongs to
  the loop, not to tick().
- **PR2.3 worker runtime + Launcher**: local worker HTTP server (activate →
  preload → execute → transition → unconditional ping), HMAC fire-and-forget
  launcher over localhost, SDK core (`ctx.step`, `sleepFor/Until`). Local e2e:
  enqueue → done; kill-worker chaos → sweep recovers. Carries two deferrals
  from the loop review: the `/wake` HTTP endpoint (producers currently
  cannot reach the in-process wake(); it rides the worker server's process
  entry), and an abort signal through the Launcher port so a timed-out
  transport call can actually be cancelled instead of abandoned.
- **PR2.4 local chaos e2e**: multi-driver + multi-worker processes against one
  SQLite file; scripted kill/drop/duplicate scenarios from the sim harness run
  against real processes. Also carries the transport-lifecycle deferrals
  from the residual review: graceful worker shutdown that drains queued
  acks before force-closing sockets, deadlines + abort on the detached
  launch and wake fetches, connection/header timeouts and body draining on
  every route, and splitting permanent SQL errors from transient
  unavailability in the executor's error typing. Includes the systematic fault MATRIX from the
  PR2.1 lesson: every batch label x every legal fault (crash, duplicate),
  with per-operation bounds asserted — curated fault lists missed the
  duplicated-claim bound violation for four review cycles. *Phase gate: a dogfood job (e.g. a local repo-backup
  task) running continuously on the engine.*

## Phase 3 — full Absurd semantics

- **PR3.1 events** (SPEC-FIRST: implements the TLC-verified EmitEvent /
  AwaitEventRegister / TimeoutWake actions from the extended Scheduler.tla —
  the spec lands before this PR opens): emit/await (inline durable-at-emit
  batches), timeout branch, wait rows. Conformance: emit-before-await,
  await-before-emit, timeout-vs-emit race, one-shot first-write-wins, plus
  executable twins of the spec's no-lost-wakeup and no-resurrection
  invariants. The review round found five bugs (see
  postmortems/pr11-events-review.md); it carries three deferrals from that
  round: a stale-fence fault column in the generated fault matrix
  (per-label zombie probes with snapshot comparison), a fence-surface lint
  (every caller-supplied identity parameter appears in every write fence
  of its batch or carries an explicit waiver), and structural
  wake-consumption binding (a wake bound to its awaiting step instead of
  consumed by a flag — DONE: the wake_step column, codex final review).
  A second review round against the final head found six more bugs (see
  postmortems/pr11-codex-final-review.md), leaving two deferrals of its own:
  a schema/emit-boundary guarantee that an event payload is never SQL NULL
  (lifting the timeout sentinel from a type-only to a structural guarantee);
  and canonicalize-and-classify a handler result at the source so a
  non-serializable result is a permanent user failure, not a silent completion
  with NULL. Attestation-artifact freshness is DONE: the Codex log and
  multi-lens journal each carry one exact review-head binding checked against
  the PR head before the status can post.
- **PR3.6 write provenance** — DONE. Every table a compare-and-set targets
  carries `fence_stamp`/`fence_at_ms` (migration v4, DESIGN.md §3.4 rule 8),
  stamps are per STATEMENT, and all thirteen store operations go through
  FencedBatch; the batch-lint debt set is empty and deleted. Seven review
  passes found forty-four defects — see postmortems/pr3.6-fence-provenance.md,
  whose detection ledger records that our own machinery found seven of them,
  three of those in round 6.
  Its residual is NOT recorded here: every item is owned by a named PR below
  (PR3.7, PR3.2, PR4.1). A deferral parked under a DONE heading is a silent
  drop, because DONE is the section a reader skips.

- **PR3.7 close the provenance residual** — DONE. It began after the final
  PR3.6 residual review recorded 0 of 51 defects found by our machinery; the
  preceding provenance round had recorded 7 of 44 (16%).
  PR3.7 closes at 10 of 51 findings self-caught (20%) and 41 review-caught
  (80%); the full mutation audit contributed the final six self-catches.
  Landed: the typed target expression (the primitive generates each
  overwriting follow-on's row selection from the fence whenever its source is
  a table this batch stamped, and `narrow` can only shrink it; `wake-runs` is
  the sole structural exception described below); the data-level provenance
  audit as two invariants
  (`one-batch-two-instants`, `provenance-pair-broken`) which hold for any write
  path, including ones that never touch the primitive; the per-statement
  clock-jitter executor, which compares complete traces and protocol tables in
  its enumerated retry, event, suspend, and cancellation scenarios, including
  an invariant-clean later-clock retry mutation; and a
  canonical monotone source for routine test IDs and provenance tokens. The
  invariant found two fixtures whose reused seeds survived at different
  instants, but it is not an issuance-uniqueness assertion: same-instant reuse,
  zero-row borrowing of old evidence, and reuse after overwrite require the
  source-level mechanism.
  The residuals and the machinery required to close them landed here:
  - **Many-row bounds and typed key pairing are one structural property.**
    `FencedBatch.derived()` now accepts one of five frozen contract relations,
    not independently spellable table and key halves; construction proves the
    named fence stamped that relation's source table, and `seal()` accepts only
    an exact self-table/self-key relation. `rows: 'source-keys'` then means the
    distinct target keys are generated as a subset of the stamped source keys.
    It is not a post-commit count alarm: several physical waits may legitimately
    share one run key, and an alarm after commit cannot prevent amplification.
    Self-source updates use a non-mergeable `DISTINCT` derived table so the
    shared generated shape is legal on MySQL too. Generated UPDATE assignment
    left-hand sides also come from a closed per-table contract: callers supply
    scalar right-hand sides only and cannot name provenance columns through
    duplicate/quoted assignments or mutate public primary identity such as
    `runs.run_id`.
  - **Attributable mutation catches.** The first closeout's 37 live mutations
    each carry an exact behavioral or construction verdict: test file, full
    test name, and marker.
    The marker must be the structured failure diagnostic's first line: bare,
    `Error: <marker>`, or `AssertionError: <marker>: …`; an arbitrary substring
    in rendered source context is not evidence.
    Structured Vitest output makes a green survivor, bind/compile error,
    different failing assertion, malformed report, suite error, or
    process/report disagreement a wrong-path result rather than credit. The
    verifier runs a 17-case classifier self-test, nineteen promise-message
    source cases, and ten canonical helper-descriptor cases, with seven
    injected classifier faults maintained by `lint-selftest.py`. The parallel
    coordinator has its own twenty injected faults for shard coverage, exact
    head, exact result inventory, process/report agreement, protective memory
    and CPU ceilings, transport failures, and cleanup ownership. Full audits
    use deterministic shards in detached exact-head worktrees, build
    worker-local frozen pnpm link farms, require an all-green baseline barrier,
    and reconcile structured results in registry order. One outer
    `scripts/confine.sh` scope contains the coordinator and every raw worker
    suite; the coordinator proves the live cgroup preserves 25% of host memory
    and the host CPU reserve, while per-worker Vitest concurrency divides that
    aggregate CPU budget. A missing or signaled Vitest report is infrastructure
    failure, never a completed mutation verdict. The source checkout never
    contains a mutant.
    The first full clean-tree audit ran all 34 mutations: 28 were attributable
    and six were `wrong-path`. Those six exposed two construction failures
    mislabeled as behavior, a split plan verdict plus a mutation with semantic
    collateral, a nondiscriminating wake-event fixture, and Vitest dropping
    custom messages on unexpected resolve/reject. Exact-call construction
    wrappers, one marked plan vector with a behavior-preserving mutation, a
    split A/B wake witness, and explicit require/attribute failure helpers made
    that audit, including the exact inline-ending identity and typed
    schema-absence and version-row mutations, **37 of 37 attributable**. The
    registry later expanded to 50. Its closing audit found one new
    postcondition test outside the original helper's package still entrusted
    an inverse promise marker to Vitest. One `@durablerun/core/testing`
    definition now owns success-to-error, expected-error-to-success, and
    expected-error-to-replacement-error verdicts. Callers pass a structured
    kind/name descriptor; the helper alone constructs the canonical marker and
    rejects decorated names. One TypeScript-compiler AST pass rejects every
    custom-message argument on direct Vitest
    `expect(...).rejects`/`.resolves` chains, owns parenthesized,
    optional-call, generic, and relational syntax, distinguishes real helper
    calls from methods and constructors, and inventories exact marker string
    literals rather than comments. The shared lightweight lexer remains only
    on source-harvest surfaces; it preserves the postfix state of TypeScript
    non-null assertions so following division cannot hide executable batch
    calls as regex contents. Removing the mutation runner's repository-local
    Python parser/import makes its bytecode self-dirty path unrepresentable;
    the executable fixture still rejects any analyzer import artifact.
  - **A generated corrupt-pre-state ("poison") fault surface.** The 17
    classified write labels cross 54 atomic witnesses covering all 57
    invariant condition IDs: 918 generated cells, plus two inventory cases.
    Every injectable witness invokes its label; a strict dialect may instead
    return `structurally-rejected`, the stronger proof that the forbidden
    pre-state is unwritable. Each invoked cell freezes structured tuple keys
    for a protected before-population across all six protocol/bookkeeping
    tables and permits insertions only through explicit full ownership tuples.
    Progress requires both a semantic healthy win and a durable six-table
    snapshot delta attributable to each store call; CTE DML counts because it
    changes state, while a SELECT returning rows and a no-op DML statement
    cannot impersonate progress. One closed snapshot descriptor owns each
    table's name, stable ordering, and required identity/ownership columns;
    snapshot construction rejects a row missing any authority column instead
    of admitting an `undefined` key into the oracle. The multiple-live-run
    claim witness is due
    when invoked, so the exact candidate-CAS mutation proves the corrupt
    subject reaches claim; a second exact mutation attacks the same-token
    receipt after a sibling is injected. A post-claim/pre-activate regression
    injects that sibling after a legitimate claim, and a third exact mutation
    proves activation refuses it.
    All three doors compose the canonical `soleLiveRun` fragment and refuse
    every task with multiple live runs. Claim's one `candidateEligibility`
    composition combines live-task, sole-live-run, and wait-unambiguity guards
    inside both pending and sleeping ordered legs before their limits, so a
    corrupt earlier row cannot spend the claim budget and starve healthy work.
    Shared conformance pins the bounded-progress behavior; libSQL query-plan
    coverage records the shipped CAS and pins both index-backed legs and their
    sibling probes. The task-book projection uses a singleton aggregate so a
    guard regression has one portable outcome rather than SQLite silently
    choosing a row that PostgreSQL/MySQL reject.
    Sixteen adversarial oracle meta-tests maintain exact result vectors,
    authority, progress, canonical number/bigint equality, structured finding
    identity, and numeric worsening—including deadline deltas and
    provenance-instant spans. Emit's atomic firing exception is one condition
    ID on the exact structured poisoned-run component, never a display-name
    waiver. The surface found three store bugs
    before review: both suspension APIs left an obsolete event registration
    behind when replacing it with a timer, and cancellation trusted the
    denormalized `waits.task_id` instead of deleting through the runs its own
    CAS had cancelled. The fixes share one suspension cleanup chokepoint and
    make cancelled run IDs the authority.
  - **Portable, atomic invariant evidence.** The invariant library has one
    typed inventory of 57 semantic conditions under 24 display names, evaluates
    explicit dialect-neutral table projections in TypeScript, and rejects a
    short, long, or malformed executor result vector instead of treating a
    missing table as empty. Row and finding identity are structured tuples,
    never delimiter-joined display strings. Exact integers returned as safe
    numbers or bigint compare canonically; strings remain storage corruption,
    including provenance instants and all seven durable counter columns.
    Counter decoding is total: corrupt storage emits its typed finding and
    dependent arithmetic is skipped rather than aborting the invariant pass.
    A shared statement-name grammar and fence-stamp parser are used by both the
    builder and persisted-stamp evaluators. The fixture-level
    `injectStorageCorruption` seam returns `injected` on permissive stores or
    `structurally-rejected` on strict native types, so all dialects run the
    identical witness inventory without encoding SQLite's dynamic typing.
  - **Schema and inline-ending boundaries fail closed.** A stored
    `schema_version` is a canonical nonnegative base-10 safe integer (`0`
    exactly, otherwise no leading zero), and migration success requires it to
    equal the binary's current version exactly; malformed, negative, unsafe,
    and future versions are mismatches. Only the dialect executor can emit
    `SchemaNotInitializedError`, for the canonical singleton version read and
    the native missing-`meta` error; admin catches that type rather than
    rendered text, so neither a stored value nor an unrelated executor failure
    can impersonate a fresh database. Once metadata exists, its read must return
    exactly one result containing exactly one version row; zero, missing, or
    duplicated results are schema mismatches, never version zero. Inline
    `Ending` values have the exact
    launch identity `(runId, claimToken)` at the type boundary, and
    reconciliation makes no write for a different run, a stale token, or
    hostile tokenless input.
    Tokenless EndingFeed reconciliation remains deferred to PR6.4 because its
    heartbeat-cutoff check and expiry need one new atomic, spec-first store
    operation.

  Final evidence: the clean-tree mutation audit was **37/37 attributable**;
  classifier maintenance covered 17 cases and seven injected faults; the
  poison oracle carried 16 meta-tests; the focused review-regression run passed
  56 tests; and `pnpm verify` passed 67 files / 1,503 tests.

  The sole structural exception is **emitEvent's `wake-runs`**, the one
  follow-on that cannot be generated, because it selects from `waits` — rows an
  earlier await registered, which the batch never stamped — and uses the event
  fence only as a gate. It keeps the hand-written WHERE and the text checks that
  guard it, documented in place. Closing it needs a second escape shape, not
  more scanning. It is now the ONLY such statement: the cleanup that used to
  select waits by event name is generated from the runs the emit woke. What
  guards it meanwhile is a generated surface
  (`wake-witness-surface.test.ts`) comparing the engine against a row-at-a-time
  statement of what a legitimate registration is, across every corruption of a
  wait row in ones and pairs, both timeout arms, both task-liveness arms, and
  every shape of park — 6,912 cases.
  The gap that remains after all of it is owned by PR3.8.

- **PR3.8 active-wait identity** (SPEC-FIRST). Everything above makes a wait row
  hard to misuse; none of it lets one PROVE it is current. Emit infers that
  from five fields agreeing — run, queue, event, step, deadline — which is
  inference, and three rounds of review each found a row that satisfied
  whatever subset existed at the time. The structural answer, proposed by codex
  in round 6: an immutable `wait_id` per registration plus `runs.active_wait_id`,
  written by `awaitEvent`, cleared by emit, by timeout, by cancellation and by
  every terminal transition, and deliberately NOT restored by a preserve-
  deferral — so emit requires `waits.wait_id = runs.active_wait_id` and a stale
  row cannot enlist anyone regardless of what its other columns say. The wake
  predicate then collapses to an identity comparison plus liveness, and
  `wake-runs` can finally be generated like every other follow-on.
  Not done in PR3.6 on purpose, and the reasons are the ones this plan exists
  to record: it is a migration plus a new field in six transitions; it is a
  protocol change, so the spec-first rule says it is modelled in TLA and
  TLC-verified before its SQL is written; and it would otherwise land unreviewed
  at the end of a branch that has already produced six fix-induced defects.
  Until it lands, the generated wake surface is what holds the line, and its
  limit is written down: it can only find a wrong DECISION about rows it
  constructs, never a wrong payload, and never a row shape nobody thought of.

- **PR3.9 compile the SQL instead of scanning it** (candidate, spiked not started).
  Every recurring defect in this engine's history is the same shape: a checker
  that matches one way of WRITING a condition and misses an equivalent one.
  `NOT EXISTS (` was recognised and `NOT (EXISTS (` was not; `x = x + 1` was and
  `x = 1 + x` was not; `UNIXEPOCH()` was and `now()` was not; and finding 39 was
  a string-concatenation precedence bug inside the generator built to end the
  class. Text is the wrong representation to be checking, and no amount of
  better regexes fixes that.
  The alternative is to BUILD the SQL as a tree and check the tree. Kysely
  (0.29) is the closest thing TypeScript has to jOOQ for this purpose: an
  immutable `OperationNode` AST, `.compile()` to `{sql, parameters}` without any
  connection, and dialect compilers for exactly our three targets. Used as a
  COMPILER ONLY -- never as a client -- FencedBatch keeps its batch semantics
  and swaps string templates for composed nodes.
  Spiked at scratchpad/kysely-spike: the three checks rewritten against the node
  tree decide all six shapes correctly, including the two spellings that beat
  the regexes and the OR bug that shipped this week. Two things the spike also
  established, both worth knowing before committing:
  - The first version of the AST check was WRONG in the same way the regex was:
    it asked whether a conjunct CONTAINED a fence rather than whether it WAS
    one, and passed the OR case exactly like its predecessor. An AST does not
    make the question easy, it makes the question ANSWERABLE -- position is
    expressible in a tree and is not expressible in a substring match.
  - Raw SQL fragments reintroduce untyped text, and we need several
    for `IS` null-safe comparisons and partial-index upserts. But "is there a
    raw fragment in a boolean position" is itself a structural question, so the
    escape hatch stays countable instead of invisible.
  Against the standing rule that the contract must not live only in TypeScript
  types: this makes it MORE language-neutral, not less. `.compile()` yields the
  exact per-dialect SQL, so the contract artifact becomes a generated corpus of
  every labelled statement in every dialect, derived rather than hand-kept.
  Its own PR: it rewrites the SQL of thirteen operations, and the provenance
  branches have repeatedly produced fix-induced defects.

- **PR3.10 condition-mutation ratchet**. PR3.7's condition inventory, now 57
  IDs, makes every
  currently declared boolean/null/type arm independently witnessable; they do
  not prove the declaration itself is complete. One condition can still group
  semantic alternatives — for example the `failed` and `cancelled` members of
  a terminal-state set — and a witness for one member does not kill deletion
  of the other. Generate one red mutation per claimed branch and enum literal,
  and require every mutation to resolve to that condition's attributable
  verdict. Condition-ID coverage without this attack is still a proxy for the
  property.

- **PR3.2 lifecycle polish**: retry_task revival, idempotency-key edge cases,
  defer-unknown-task deploy rule. Carries two deferrals: cancellation
  DISCOVERY inside a running pass (today a cancelled task surfaces to its
  worker as a lost lease; the distinct AB001 signal and a 'cancelled'
  worker outcome need the store to distinguish "fence lost because task
  terminal"), and a wake-coalescing floor on the driver's /wake before it
  is exposed beyond localhost.
  From PR3.6, because both turn on cancellation discovery:
  - **The rolling-deploy deferral disarms the start deadline** — pre-existing,
    identical on main, and modelled nowhere in `specs/Scheduler.tla`.
    Spec-first: model it, TLC it, then fix it.
  - **`SleepSuspend`'s task-eligibility guard is not in the model.** Both
    suspension paths require the task live and not past a due cancellation
    deadline; `Fenced(c)` constrains only the run. Strictly narrower, so safety
    is unaffected, but the refusal reaches the worker as a lost lease and no
    model lacking the guard can settle whether that path keeps liveness.

- **PR3.3 child tasks + SDK completion**: spawn-from-step, completion-event
  await, same-queue refusal; `/api/runs/:id` result route.
- **PR3.4 saga / step rollbacks** per DESIGN §3.10 (Cloudflare's shipped
  June-2026 API shape): `ctx.step(name, fn, { rollback, rollbackConfig })`,
  engine-triggered on terminal failure only, reverse step-START order,
  rollback handlers as ordinary durable steps (`rollback:<step>#<count>`)
  with their own retry budgets, halt-on-rollback-failure, no distinct
  terminal state (rollback outcome is a separate result field). Conformance:
  crash mid-rollback resumes; reverse order exactly once each; caught errors
  never trigger rollback; `output === undefined` for started-not-persisted
  steps; rollback-failure halts the chain and surfaces in the result.

- **PR3.5 simplification sweep**: the deferred findings from the
  full-codebase simplify/elegance review (SIMPLIFY-BACKLOG.md) — chiefly
  the store SQL builders (successor-insert, checkpoint LWW tail, the
  eligibility/stamped-fence fragments repeated 9–11 times), the
  bounded-pump-teardown helper, TaskResult as a discriminated union, the
  `forEachSeed` conformance helper, and a batch of stale spec/script
  comments. Correctness-flavoured items (the successor-insert drift
  surface, the pump-teardown race) sequence first. The events PR applied
  the review's correctness-critical findings and the ones in its own new
  code; this sweep is the pre-existing remainder, kept explicit rather than
  dropped.

## Phase 4 — dialect matrix

- **PR4.1 suite extraction hardening**: conformance runs from a store factory
  matrix; purge accidental turso-isms.
  From PR3.6, because each is only decidable with a second dialect in hand:
  - **Postgres double-claim**: `casMany` guarantees a win rule, not a
    concurrency semantics; store-pg needs `FOR UPDATE SKIP LOCKED` and a
    conformance scenario before it is DONE.
  - **Rule 2's lock prelude**: the primitive has no statement kind for
    acquiring a lock, and every non-tail statement must carry a fence.
  - **MySQL cannot derive the winner from row counts alone** — no targeted
    `ON CONFLICT`; the `SqlResult` normalization contract must state
    matched-not-changed semantics.
  From PR3.7:
  - **Migration-version conformance**: lift PR3.7's libSQL schema gate into the
    shared admin contract. Every dialect must accept only the canonical
    nonnegative safe base-10 representation, require exact equality with the
    binary's current version, and classify an actually absent metadata table
    at the dialect boundary without allowing stored error-like text or an
    unrelated read failure to impersonate a fresh database.

- **PR4.2 store-postgres**: transliterate absurd.sql (SKIP LOCKED CTE, row-lock
  awaitEvent); **oracle tests**: same scenario on real Absurd (docker) vs our
  engine, diff outcomes.
- **PR4.3 store-mysql**: token claim, READ COMMITTED, DATETIME(6), tx-per-
  transition; MySQL 8 container in CI; optional PlanetScale smoke job.

## Phase 5 — operations + sharding

- **PR5.1 registry + fan-out**: status semantics (active/draining/paused),
  routing with versioned cache, multi-shard tick fan-out, driver adoption caps.
- **PR5.2 retention + metrics**: cleanup policies + event-GC barrier; metrics
  (queue depth, claim latency, lease expiries); usage-API quota alerting +
  BLOCKED runbook; fleet migration sweep.
- **PR5.3 inspection**: inspect CLI over any store (local habitat-equivalent).

## Phase C — cloudification (first cloud touch; any time after Phase 2)

- **PRC.1 Turso Cloud store wiring**: remote `libsql://` URLs + auth in
  store-libsql; the remote-claw readiness gate; env scheme (marketplace
  per-db creds vs fleet `TURSO_API_TOKEN`/`TURSO_GROUP_AUTH_TOKEN`).
- **PRC.2 Vercel app + serverless tick**: `apps/web` routes (`/api/tick` GET
  cron + POST ping/QStash with auth, `/api/worker` HMAC, tasks/events/inspect);
  QStash alarms with (shard,t) dedup; `vercel.json` cron; preview-deploy e2e
  re-running the Phase 2 chaos scripts.
- **PRC.3 probes + prod dogfood**: empirical probes (Free-plan archival,
  Platform-API rate limits); a production dogfood job.

## Phase 6 — dedicated placement (build only when dogfood demands it)

- **PR6.1** RunStateStore port + inline impl refactor (zero behavior change).
- **PR6.2** per-run DB store: fence meta row, warm pool protocol, janitor.
- **PR6.3** delivered-wait materialization, successor pointer carry, PITR
  restore tooling.
- **PR6.4** EndingFeed port + reconcile consumers (SPEC-FIRST). Token-bearing
  signals preserve the exact `(runId, claimToken)` identity and stale or
  mismatched signals stutter. A tokenless signal is ignored until this PR
  models and adds one atomic scheduler-store operation that reads the current
  claim, proves no heartbeat landed after the feed's cutoff, and expires that
  same claim without a read/write race; a separate read followed by
  `expireLeaseNow` is not sufficient.

## Phase 7 (optional) — WDK spec-v5 World wrapper.

- **PR1.7 TLA+ spec of the scheduler protocol** (`specs/Scheduler.tla`): model
  runs as state machines (state, claim_gen, activated_gen, lease deadline,
  attempt/infra counters) with actions Spawn, Claim, DeliverLaunch (an
  at-least-once channel that can duplicate and drop), Activate, Heartbeat,
  Complete, FailWithRetry, SleepSuspend, VoluntaryChain, SweepLostLaunch,
  SweepClaimTimeout, WorkerCrash, TimeAdvance. TLC-checked invariants: no two
  activations of the same (run, gen); terminal states never regress;
  `max_attempts` consumed only by user-code failures; every claim eventually
  resolves (leases can't wedge) under weak fairness. The proof stack: TLA+
  proves the DESIGN.md protocol; the sim harness proves the implementation
  refines it (labeled batch ≙ TLA action); conformance pins the SQL to the
  atomic-action assumption. Model checking runs in `pnpm verify:tla` when a
  TLC toolchain is present.

## Standing verification discipline

Every phase ends with driving the real flow on a preview deployment (not just
green units): enqueue → suspend → kill something → recover → done. The
conformance suite only ever grows; a finding fixed = a test added.
