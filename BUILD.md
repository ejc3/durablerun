# Build plan: phases → PR stack of tractable diffs

<!-- mutation-suite-transport-contract:start -->
This top-of-file block is the sole normative suite transport contract:
`parse_report` and `run_suite` raise `SuiteInfrastructureError`; only a
structurally valid `SuiteResult` reaches verdict classification.
<!-- mutation-suite-transport-contract:end -->

## Completed milestone — remote dogfood plus PostgreSQL portability

The product milestone passed. The remote-Turso ref-journal completed **15 of
15** 12-hour cycles over **7d 7h 27m**, retaining one checkpoint per cycle with
zero attempts, infrastructure retries, or relaunches. Hourly ticks launched those
cycles when they became due. Its deliberate
driver-before-activation and worker-after-checkpoint probes recovered with the
expected counters, and idle periods consumed no resident worker. PostgreSQL 17
also passes the identical six-surface conformance suite, including native
claim concurrency and the emit/await event race; that work merged in PR #16.

Repository health is a separate verdict. The seven nightlies from September
1–7 failed before TLC because the upstream `v1.8.0` prerelease artifact changed
under its pinned checksum. `pnpm verify` and all 32 fuzz shards stayed green:
this was verification infrastructure failure, not a protocol counterexample.
The closeout vendors and verifies the exact known-green checker so an upstream
asset replacement cannot silently turn the proof gate off again; see
`postmortems/nightly-2026-09-07-mutable-tla-artifact.md`.
Repository health returned fully green in [recovery run
34138471466](https://github.com/ejc3/durablerun/actions/runs/34138471466):
`pnpm verify`, all 32 deep-fuzz shards, and all six isolated full-volume TLA
targets passed. Later closeout commits only correct the redistribution and
milestone records and do not change the checker, scripts, model, or configs
validated by that run.

## Current milestone — cancellation discovery, child tasks, sagas, SQL trees, and MySQL

**Status: IN PROGRESS (named 2026-09-16).** The maintainer named six items, in
this order: PR3.11, the mutation-runner fixes, PR3.9, PR3.3, PR3.4, and PR4.3.
PR3.9 ends with PR3.9f, which the review of PR3.9e part 3c added: exit test 3
needs it, so it is the last part of PR3.9 and not a seventh item.
Each lands as its own PR, and only one implementation PR is in flight at a time.
PR3.9 lands before the new batches, so child tasks, sagas, and the MySQL store
write their SQL as trees once. PR4.3 lands last, so the third dialect
implements the finished surface once.

**Exit test:**

1. A heartbeat on a cancelled task reports the cancellation, and a handler
   that makes a context call after that beat ends with a cancelled outcome.
   Conformance cases on libSQL and PostgreSQL and an SDK case show it and were
   committed red first. PR3.11's two generated surfaces also land: a launch
   payload case crossing older and newer driver and worker builds, and a
   driver clock-shape surface.
2. A mutation audit whose worker baseline goes red names the failing test in
   the coordinator's failure message, and an aborted audit's teardown either
   reaps every worker group or reports a measured reason it cannot.
   This is met. PR #33 made a red worker baseline name its failing tests in
   the coordinator's failure message, and gave killed verifier groups time to
   empty, so an aborted audit's teardown reaps them or reports why it cannot,
   and PR #31 drains a process group before calling a descendant live.
3. Every store batch's SQL is built as a tree and checked as a tree, per
   PR3.9, and the textual scanners it replaces are deleted. PR3.9e part 3b
   deleted `FencedBatch`'s text path and its scanners, and part 3c asked the
   rules of `fragment-lint` and `clock-lint` of the tree. This is NOT met. The
   two lints still scan store SQL text, because a store still sends its reads,
   some of its writes, and its admin's statements as text that no tree holds.
   It is met when PR3.9f builds that text as trees and deletes the two scans.
4. A task can spawn a child from a step and await the child's completion as an
   event, and awaiting a child in another queue is refused. It is
   modeled in TLA before its SQL exists, and conformance on every dialect pins
   it.
5. A step can declare a rollback that the engine runs in reverse step-start
   order on terminal failure, per DESIGN.md §3.10, with the PR3.4 conformance
   cases on every dialect. It is modeled in TLA before its SQL exists.
6. `store-mysql` passes the identical conformance suite against MySQL 8 in CI.

**Non-goals:** active-wait identity (PR3.8), the condition-mutation ratchet
(PR3.10), operations and sharding (Phase 5), dedicated placement (Phase 6), and
the cloudification PRs.

## Completed milestone — lifecycle correctness and the simplification sweep

**Status: COMPLETE, with exit test 2 qualified; pause after green merge
(2026-09-15).** The stack merged green into `main` in order: PR3.5a, PR3.5b, and
PR3.5c as PRs #25 to #27, then PR3.2a as PR #28 and PR3.2b as PR #29. `ci`
passed on each merge commit, ending with
[run 35006099023](https://github.com/ejc3/durablerun/actions/runs/35006099023)
on the merged head `55412c3`. Every scheduled dogfood run on that head passed,
from [run 35009666322](https://github.com/ejc3/durablerun/actions/runs/35009666322)
through [run 35049435712](https://github.com/ejc3/durablerun/actions/runs/35049435712).

**Exit test:**

1. A task with a start deadline (`maxDelaySeconds`) that a worker build
   without its registration defers is cancelled by the sweep once the deadline
   passes, and a `maxDurationSeconds` clock starts when a registered handler
   first runs, not at a deferral. Conformance cases on libSQL and PostgreSQL
   show both and were committed red before the fix; TLC produces a
   counterexample against the unfixed model first.
2. A worker whose task was cancelled mid-pass receives a distinct cancelled
   outcome (the store raises `RunCancelledError`), while a swept lease still
   surfaces as a lost lease.
3. `specs/Scheduler.tla` carries the suspension paths' task-eligibility guard,
   TLC passes the CI and full scopes, and a probe witnesses a refused
   suspension.
4. A failed task can be retried in place through `retryTask`, following
   Absurd's `retry_task`. It is modeled in TLA before its SQL exists, and
   DESIGN.md states its exception to the terminal-inertness rule.
5. Idempotency-key reuse follows Absurd's `spawn_task` behavior and is pinned
   by conformance cases.
6. A flood of `/wake` requests ticks the driver at most once per floor
   interval.
7. Every finding in SIMPLIFY-BACKLOG.md is landed or rejected with a written
   reason under PR3.5, and the file is deleted.

**Closeout:** exit tests 1, 3, 5, and 6 landed in
[PR #28](https://github.com/ejc3/durablerun/pull/28), exit test 4 in
[PR #29](https://github.com/ejc3/durablerun/pull/29), and exit test 7 across
PRs #25 to #27, where PR3.5c deleted SIMPLIFY-BACKLOG.md. Exit test 2 landed for
refused writes in PR #28: a worker whose write is refused on a cancelled run
raises `RunCancelledError` and ends with a cancelled outcome. A heartbeat on a
cancelled task then still reported only a lost lease, so a handler that made a
context call after that beat ended as lease-lost. PR3.11a closed that path.

**Non-goals:** exposing `/wake` beyond loopback or authenticating it, a hosted
cancel route, stopping a handler mid-step when its task is cancelled (discovery
stays at the next engine call, DESIGN.md §3.2), child tasks (PR3.3), sagas
(PR3.4), active-wait identity (PR3.8), the PR3.9/PR3.10 assurance expansions,
and new dialects.

## Completed milestone — a useful hosted PR-check watcher

**Status: COMPLETE (2026-09-09).** The clean external
Vercel/Turso app watched PR #24's exact head while its selected `tla` check was
pending, checkpointed the observation, and survived a deliberately killed
invocation. The deployed host persisted `ready` after two observations in
102,421 ms, with zero manual ticks, exactly one infrastructure retry, zero user
failures, and user attempt one. The original checkpoint was unchanged. The
[redacted receipt](receipts/hosted-pr-watcher-2026-09-09.json) binds the exact
input, source, deployment, four unchanged alpha.1 packages, and recovery result.
This proves selected-check completion and unattended recovery, not mergeability
or which recovery provider delivered a particular wake.

**Exit test:** from a clean external install, watch an exact real GitHub PR
head while selected checks are pending, checkpoint that observation, interrupt
the invocation, and let the deployed host recover and persist an inspectable
ready/failed result without manual ticks. Retain the exact input, deployment,
checkpoint/recovery counters, terminal observation, and package provenance.
The result describes selected checks at an observed commit, not mergeability.
No multi-day soak is required.

**Closeout:** the bounded read-only observer, durable polling task, generated
interruption/replay and fail-closed selection tests, clean external deployment,
and live receipt merged green in [PR #24](https://github.com/ejc3/durablerun/pull/24).

**Non-goals:** automatic merges, notifications, a UI, branch-protection policy
discovery, private-repository credential provisioning, new engine protocols or
SQL, MySQL, sharding, sagas, and new global assurance machinery. Existing auth
and wake-provider ports remain unchanged. Polling is bounded and configurable;
the receipt measures recovery, not a provider latency SLA.

Deferred provider-fixture residual: the adapter matrices do not exhaust
repository-ID widths or every HTTP-status/body combination; expand them for an
observed consumer failure, not as a new global assurance project.

## Completed milestone — unattended hosted workflow

**Status: COMPLETE (2026-09-08).** Both hosted sleep
workflows completed on attempt one without manual ticks: normal resume took
576 ms after due time; the deliberately dropped enqueue hint recovered through
cron and resumed 620 ms after due time, completing within 51,946 ms of enqueue.
The [redacted alpha.1 receipt](receipts/hosted-alpha-v0.1.0-alpha.1.json) binds
the immutable package hashes, corrected example, deployment, and both outcomes.
Its [complete sanitized provider trace](receipts/hosted-alpha-v0.1.0-alpha.1-provider-requests.ndjson)
proves private queue delivery for both resumes, with no public tick during
either sleep-to-completion interval. The next consumer milestone is above;
this completed host is not being reopened.

**Exit test:** deploy the one-queue Vercel/Turso example, enqueue a short sleep,
observe its durable suspension, then observe completion no more than 60 seconds
after it becomes due, with no manual tick calls. Repeat after deliberately
omitting the initial enqueue hint: the independent recovery cron must start the
workflow and its scheduled wake must finish it. Retain both measured receipts.
The latency threshold is acceptance evidence, not an unconditional provider SLA.

**Live delivery ownership:**

- **PRH.3 unattended hosted progress — DONE:** [PR #22](https://github.com/ejc3/durablerun/pull/22)
  merged the pluggable wake scheduler, Vercel Queues adapter, and independent
  minutely recovery cron. Public authorization remains host-owned and queue
  callbacks provider-private. The subsequent provider build exposed an
  overlapping function selector, recorded in
  [the function-selection postmortem](postmortems/hosted-2026-09-08-function-selection.md).
  Deploy the [corrected example at `289cd7c`](https://github.com/ejc3/durablerun/tree/289cd7cc7bf5607652b20531c46507c7c4a2e19b/examples/vercel-turso):
  the immutable alpha.1 tag retains the old example configuration, while its
  four package assets are unchanged. The corrected production deployment and
  both unattended receipts passed.
- **PRA.1 release audit closure — DONE:** [#18](https://github.com/ejc3/durablerun/issues/18)
  preserves exact mutation ownership and complete collateral diagnostics.
  The [full audit in #17](https://github.com/ejc3/durablerun/issues/17#issuecomment-5587332479)
  passed all 423 entries (409 exact-only, 14 with collateral, zero blocking)
  on clean `e8a6bb4`, whose tree equals merged `a9527cf`. The disposable
  PostgreSQL fixture was stopped with durability settings on; both issues are
  closed. No source-identical full audit was repeated for release packaging.

**Non-goals:** new SQL transitions, persistent alarm ownership/deduplication,
detached workers, a resident driver, another cloud account, a UI, multiple queues,
MySQL, sagas, sharding, and the PR3.9/PR3.10 assurance expansions. They remain
options until observed use requires them.

## Completed milestone — hosted alpha

**Status: COMPLETE (2026-09-07).** The foundation merged in
[PR #20](https://github.com/ejc3/durablerun/pull/20) at
[`a7b3078`](https://github.com/ejc3/durablerun/commit/a7b307844d80b092de5a8c2b11b5b32d2f2cacbc).
The immutable
[`v0.1.0-alpha.0`](https://github.com/ejc3/durablerun/releases/tag/v0.1.0-alpha.0)
release passed a clean external install and the live Vercel/Turso exit test.
The [redacted hosted-alpha receipt](receipts/hosted-alpha-v0.1.0-alpha.0.json)
retains the source commit, package hashes, deployment, and outcome evidence.

`v0.1.0-alpha.0` was published without the full pre-release mutation sweep.
The closeout in
[PR #21](https://github.com/ejc3/durablerun/pull/21) records the explicit alpha
exception, not a retroactively completed audit. The follow-up audit in
[#17](https://github.com/ejc3/durablerun/issues/17) and classifier repair in
[#18](https://github.com/ejc3/durablerun/issues/18) were completed before the
alpha.1 closeout above; the historical alpha.0 exception remains disclosed.

The default product thesis remains a Turso-first TypeScript durable-workflow
engine. The historical phase inventory below is an options map, not permission
to run several tracks at once.

**Exit test:** from a clean external application, a developer installs
`@durablerun/core`, `@durablerun/sdk`, `@durablerun/driver`, and
`@durablerun/store-libsql`, deploys one Vercel application backed by Turso, and
runs a one-queue workflow through trigger, suspend, resume, and inspection.
One bounded tick executes inline, a lost launch is recovered, and every public
mutation or inspection is denied unless a host-supplied authorization plugin
allows its operation. The complete path is reproducible from checked-in
instructions and a hosted receipt, not workspace links or maintainer state.

**Critical path:**

1. Make the four packages consumable from a clean app: built artifacts,
   exports, dependency metadata, and an install smoke test.
2. Add one small, fail-closed authorization port at the HTTP boundary. A host
   may plug in its own scheme; the framework supplies request facts and asks
   for an allow/deny decision for `task.enqueue`, `event.emit`, `tick.run`, and
   `task.inspect` before parsing or performing work.
3. Ship the minimum Vercel route adapter and example for one Turso database,
   one queue, and an inline bounded tick. Reuse the scheduler and SDK rather
   than adding a parallel hosted engine.
4. Retain one hosted end-to-end receipt proving trigger → suspend → resume →
   inspect and the existing lost-launch recovery path, then stop.

**Live delivery ownership:**

- **PRH.1 hosted-alpha foundation — DONE (GitHub PR #20, merge `a7b3078`):**
  shipped the four consumable packages, fail-closed authorization plugin
  boundary, exact four-route Vercel adapter, and Turso example.
- **PRH.2 immutable release, deployment, and receipt — DONE (2026-09-07):**
  bound `v0.1.0-alpha.0` and its four package assets to the PRH.1 merge,
  passed a clean external install, typecheck, and all five example tests,
  migrated the dedicated Turso database, and deployed the Vercel example.
  The [hosted receipt](receipts/hosted-alpha-v0.1.0-alpha.0.json) proves all four
  unauthenticated operations were denied, event suspension and completion,
  and exactly one lost-launch reopen with the user attempt still one.

**Non-goals:** QStash or another alarm service, detached HTTP workers, a
resident driver, MySQL, child workflows, sagas, sharding, dedicated placement,
EndingFeed, the WDK wrapper, a hosted UI, and the PR3.9/PR3.10 assurance
expansions. These remain options until hosted-alpha use supplies a concrete
reason to pull one forward.

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

**LOCAL-FIRST IMPLEMENTATION (decided 2026-07-18):** engine work remains
reproducible on this machine — SQLite via `file:`/`:memory:` libsql,
PostgreSQL 17 in a local container, and driver/workers as local Node processes.
The hosted-alpha milestone admits exactly one Vercel + Turso vertical slice;
fleet infrastructure, external alarms, and a hosted UI remain later options.
`pnpm verify` is the local CI gate.

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
    `Error: <marker>`, exact `AssertionError: <marker>`, or
    `AssertionError: <marker>: …`; an arbitrary substring in rendered source
    context is not evidence.
    Structured valid Vitest output makes a green survivor, bind/compile error,
    different failing assertion, suite error, or process/report disagreement a
    wrong-path result rather than credit.
    The sole normative suite-transport classification is the top-of-file
    contract; this item records attribution behavior without redefining it.
    The verifier runs its classifier, source-owner, and generated-construction
    surfaces across every live mutation. Every TypeScript replacement is
    materialized and parsed before enrollment. Every mutant routed to Vitest
    also passes an incremental compiler value-binding comparison against its
    original source, so a newly unbound runtime identifier is rejected before
    checkpoint or worker creation; only project-typechecked construction
    mutants retain their compiler invocation as the semantic authority.
    Type-only aliases are not runtime values, while class heritage and
    shorthand expressions remain runtime references. Same-file direct
    behavioral markers are bound to their enclosing static Vitest full title,
    while genuinely dynamic titles require an explicit mutation-specific
    reason. Four canonical
    live-enrollment faults attack question-delta, generated-syntax,
    runtime-binding, and static-title coverage. The parallel coordinator and
    routing surfaces exercise their declared injected faults. Exact fixture
    counts live in the canonical self-test output rather than a second
    hand-maintained BUILD inventory.
    The parallel coordinator has its own generated injected faults for shard
    coverage, exact head, exact result inventory, process/report agreement,
    protective memory and CPU ceilings, missing/malformed/signaled transport,
    and cleanup ownership. Full audits use deterministic shards in detached
    exact-head worktrees, build worker-local frozen pnpm link farms, require an
    all-green baseline barrier, and reconcile structured results in registry
    order. One outer `scripts/confine.sh` scope contains the coordinator and
    every raw worker suite; the coordinator proves the live cgroup preserves
    25% of host memory and the host CPU reserve, while per-worker Vitest
    concurrency divides that aggregate CPU budget. The source checkout never
    contains a mutant.
    Session evidence uses one `TERMINAL_PROCESS_STATES` definition and one
    `process_is_gone` decision for the initial observation, failure rechecks
    after owner, argv, and cwd phases, and the final identity observation. A
    generated phase matrix covers Linux `Z`, `X`, and `x` transitions so an
    exiting process cannot become a false live-process refusal merely because
    it releases `/proc` data between reads.
    The nightly's execution proof pairs source and observation: the registry
    replaces the real `"${command[@]}"` dispatch with `:`, while the focused
    verdict runs the shipped real-mode loop with `PATH` set to a temporary
    directory containing a probe `env`. For shard 0, that child emits one
    tagged stdout record for each of the four batch indices derived from the
    canonical plan.
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
    rejects decorated names. One TypeScript-compiler `Program`/`TypeChecker`
    pass rejects every custom-message argument on direct Vitest
    `expect(...).rejects`/`.resolves` chains, owns parenthesized,
    optional-call, generic, and relational syntax, and counts a helper
    descriptor only when its bare callee resolves to the exact unaliased
    canonical testing import; shadowed and same-spelled local helpers own
    nothing. A mutation-specific helper descriptor owns that mutation's exact
    canonical marker, and generated cases carry literal executable helper
    closures rather than detached marker inventories or reconstructed mutation
    names. Construction markers are owned by compiler-recognized
    `@ts-expect-error` directives: exactly one exact marker must occur on
    exactly one directive, on the line whose unused directive produces TS2578.
    Direct runtime markers remain exact string literals. The shared lightweight
    lexer remains only on source-harvest surfaces; it preserves the postfix
    state of TypeScript non-null assertions so following division cannot hide
    executable batch calls as regex contents. Removing the mutation runner's
    repository-local Python parser/import makes its bytecode self-dirty path
    unrepresentable; the executable fixture still rejects any analyzer import
    artifact.
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
    typed inventory of semantic conditions, 109 at this PR's closeout, evaluates
    explicit dialect-neutral table projections in TypeScript, and rejects a
    short, long, or malformed executor result vector instead of treating a
    missing table as empty. Row and finding identity are structured tuples,
    never delimiter-joined display strings. Exact integers returned as safe
    numbers or bigint compare canonically; strings remain storage corruption,
    including provenance instants and all eight durable counter columns.
    Counter decoding is total: corrupt storage emits its typed finding and
    dependent arithmetic is skipped rather than aborting the invariant pass.
    A shared statement-name grammar and fence-stamp parser are used by both the
    builder and persisted-stamp evaluators. A fixture prepares dialect-specific
    invalid-storage SQL, but the shared runner owns its nonempty execution and
    may credit `structurally-rejected` only after the raw executor raises a
    narrowly classified native error. A fixture cannot opt out by returning a
    disposition. All dialects therefore run the identical witness inventory
    without encoding SQLite's dynamic typing.
  - **Persisted temporal-domain containment.** One frozen core inventory now
    owns all 23 temporal fields across the six scheduler/bookkeeping tables,
    including field identity, epoch-versus-duration kind, exact bounds, and
    migrated nullability. Public condition/witness IDs are derived from the
    nominal `table.column` bounds identity rather than being a second
    independently swappable label. The inventory generates 46 storage/bound
    conditions, the portable snapshot columns, and 69 storage/lower/upper
    poison witnesses.
    At this PR's closeout the matrix was 109 conditions, 139 witnesses, and
    2,363 ambient cells. The central schema/admin conformance surface discovers every native
    integer column and compares the exact field/64-bit-width/nullability vector
    to the union of all eight counter plus 23 temporal descriptors—31 durable
    integer fields, without a naming proxy. LibSQL supplies real
    `PRAGMA table_info` statements while the shared runner owns their execution
    and comparison. Invariant result assembly keys each projection by its
    declared table rather than rebinding the six result slots through another
    positional table list.
    Fourteen derived-deadline sites prove exact headroom before addition, while
    fixed-field fragments reject corrupt persisted instants before ordered
    limits, at post-scan CASes, in all four next-wake sources, and before direct
    comparison or propagation. The shared addition helper renders each delta
    once so anonymous placeholders cannot be duplicated. Terminal-arm controls
    keep quiescing paths legal at the epoch ceiling. Stored JSON
    max-duration uses the same rounded-millisecond semantics as the port;
    `setFakeNowEpochMs` now validates the administrative clock before SQL; and
    an unrepresentable driver expiry leaves both the heartbeat and its cleanup
    unchanged. Cleanup also refuses invalid stored last-beat/expiry inputs
    rather than comparing or deleting them. The first full 23-field generated
    poison run found the invalid-expiry cleanup defect before review; the
    direct case pins the self-catch without replacing its generated detector.
    The timestamp suite is a
    first-class central conformance surface, not a nested call another backend
    can omit. Sixty-four attributable temporal/admin/enrollment mutations
    brought the registry to 191. The final attribution closeout inventories
    207 live mutations; the dispatch mutation has its own exact targeted
    verdict, while the complete final branch-head evidence remains below.
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
  - **Retry and task-throwable boundaries are total.** Retry policies now cross
    one parser at spawn, durable decode, and both public math entry points. The
    parser snapshots hostile fields once, returns frozen millisecond-canonical
    data with a nominal type, and makes zero-delay exponential math total even
    after exponent overflow. The worker snapshots every JavaScript throwable
    into owned canonical failure JSON without invoking object getters or
    coercion. Runtime suspension, lease-loss, and store-outage authority is
    invocation-local: public constructors and forged prototypes carry no
    authority, context calls enroll trusted controls before they cross task
    code, and the worker retains the paired classifier. Module-time captured
    WeakMap and `Symbol.hasInstance` intrinsics prevent task initialization
    from replacing the authority machinery. The core classifier and SDK
    runtime corpus each have per-condition exact mutations; together with the
    retry surface they bring the live registry from 207 to 269. The targeted
    audit caught one wrong-path hostile-classifier verdict rather than
    crediting it; the canonical expected-failure helper now owns that marker.
    Source-side generation of those condition mutations remains PR3.10's
    responsibility.
  - **Task-realm durable boundaries use captured operations and owned data.**
    Retry math, task-value encoding, user input classification, replay maps,
    worker abort/finalization, event-wake discrimination, native-Map registry
    authority, and the production clock resolve their safety-critical
    JavaScript operations when the runtime modules load. Task values are first
    copied into an owned, closed JSON model; composite built-ins whose behavior
    dispatches through mutable peers (`RegExp.test`, `Promise.race`) are replaced
    by leaf-operation helpers. Authentic Map entries, not subclass overrides,
    grant handler authority; non-Map structural resolvers remain explicitly
    trusted host code. Sixty exact mutations raised the registry from 269 to
    329.

    Task option properties are also effects at this boundary: `awaitEvent`
    snapshots `timeoutSeconds` once, validates that lexical value, and persists
    the same value. Suspension wake unions use captured own-property decisions
    independently at the task-control snapshot, `reschedule`, and `suspendRun`;
    an inherited `inSeconds` can never convert an absolute wake. Each store
    consumer feeds one `prepareWake` snapshot to its SQL expression, arguments,
    and headroom guard. Relative and absolute wakes are bind-data modes of one
    `CASE`-based SQL text, statement inventory, and bind arity for each of the
    `reschedule` and `suspend` labels; neither input representation selects a
    second compiled topology. Handler/serialization and completion are sibling
    lexical phases, so an ordinary completion rejection propagates and cannot
    enter user-failure accounting.

    The unresolved-thread closeout then completed the already-counted collision
    and bind-arity findings. Three collision paths have independent exact
    owners. Source question-token reconciliation is only a cheap construction
    alarm—its equal-count cancellation case is explicit—while a private
    `FencedBatch` compiler-error brand makes both bind-validation exits
    ineligible for all three expected-failure helpers. Those ten additions
    bring the live registry to **339**. The final boundary review added exact
    completion-origin, timeout single-read, three wake-discriminant, and
    private-brand-read owners. Those six independently attributable additions
    bring the current live registry from 339 to **345**. A canonical live
    question-delta injected fault also completes the already-counted bind-arity
    source alarm; it adds no mutation and does not change that total.
    The first complete 345-entry run then rejected three real kills as
    wrong-path: a nested-symbol guard had two collateral generic tests, an
    exact no-detail Vitest assertion diagnostic was outside the classifier,
    and the context lease-loss marker sat after an earlier decisive assertion.
    One combined nested-symbol owner, exact first-line diagnostic recognition,
    and first-observable SDK ownership make all three targeted reruns exact;
    the completed immutable 345-entry cycle is a historical checkpoint.

    The durable-boundary ownership tranche then moved the registry from 345 to
    369 at `2619b64`, queue-scoped the remaining spawn-receipt collision at
    370, rehomed two driver-cleanup attacks away from frozen migration history
    without changing the count, and added sixteen current-source owners while
    removing the dead `trustedMax` entry. The then-current total was **385**. Spawn
    now uses the captured core codec for owned retry, cancellation, and header
    values; claim uses the captured parser for admitted retry and headers. The
    split `durableTaskRetryAdmissible` and `durableTaskHeadersAdmissible`
    predicates gate the current candidate, same-token receipt, and activation
    doors. Exact declarations are also enrolled for each true-valued generated
    relation policy and `expireLeaseNow`'s future-integer-expiry and task/run
    queue ownership conditions; frozen migration DDL is not a live mutation
    target.

    At `80cafa2`, the bounded focused ledger passed **80/80 assertions** and the
    confined full verify passed **81 files / 3,583 tests**, all eleven lints,
    format-check, and typecheck. The mutation self-test enrolled all 385 entries
    with the inventories above. No targeted audit of the new entries or full
    385-entry audit was claimed at that checkpoint; current-head fuzz, TLC, and
    final-head review also remained final-merge gates.

    The subsequent exact-attribution marathon grew the registry from **385 to
    419**. Its first residual audit exposed eleven rows collapsing to eight
    site-and-cause findings: one survivor, stale static owner titles, generated
    TypeScript syntax failures, and collateral mutation dispatch. Consolidated
    red `0a24790` raises title and syntax ownership into the build and isolates
    the remaining selected/control observations; green `98c3dee` closes those
    eight causes without changing cardinality. The complete 419-row checkpoint
    at `98c3dee` then reported **417 exact catches and two wrong-path rows**, with
    no survivor or stale row: both driver-cleanup bound mutants referenced an
    unimported `MAX_EPOCH_MS` and failed before their declared owners. Red
    `be917fa` makes syntactically valid unbound runtime names fail the generated
    preflight; green `fafcd13` resolves value bindings before audit setup and
    derives both cleanup bounds from
    `PERSISTED_INTEGER_BOUNDS.drivers`. Mandatory follow-up review then found
    three binding-policy/classification false negatives and an ordering-proof
    gap. Red `e21ffdb` exposes the executable misses; green `fc9171d` makes
    `typecheck_project` the sole routing authority, rejects erased type-only
    aliases, retains runtime class heritage, and proves rejection precedes
    checkpoint/worktree creation. The exact focused rerun is 2/2. The closing
    simplify pass then added two exact poison-settlement mutations, bringing the
    registry at that checkpoint to **421**. The clean `a00fc27` checkpoint had
    already
    caught all 419 then-declared entries; those two additions supersede that
    historical receipt. The first 421-entry run at `5cf87d5` then refused two
    pre-existing relative-only timestamp mutants as wrong-path because the new
    shape control also failed. Green `1d005de` rewrites their relative `CASE`
    arm without changing the compiled wake signature, and both focused audits
    are exact. The subsequent [clean release-head full audit](https://github.com/ejc3/durablerun/issues/17#issuecomment-5587332479)
    caught all 423 entries: 409 exact-only and 14 with retained collateral
    failures, with zero blocking results.

    This is not a same-process JavaScript sandbox. Application handlers share
    the worker realm and are trusted not to mutate unrelated host/driver
    infrastructure or terminate the process; the captured tables own only the
    named durable boundaries. Deployments that execute untrusted application
    code need process or realm isolation as a separate host boundary rather
    than another list of captured methods.

  Pre-temporal closeout evidence: the clean-tree mutation audit was **37/37
  attributable**; classifier maintenance covered 17 cases and seven injected
  faults; the poison oracle carried 16 meta-tests; the focused
  review-regression run passed 56 tests; and `pnpm verify` passed 67 files /
  1,503 tests.
  Final merge evidence is attached to PR #12 and is accepted only when
  `pnpm verify`, the confined fuzz and TLC legs, and the complete mutation
  registry all pass on one clean committed head. Earlier exact totals in this
  section are historical checkpoints, not substitutes for that final cycle.

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
  The residual is recorded as the trigger-based PR3.8 option below.

- **PR3.8 active-wait identity** (TRIGGERED OPTION; SPEC-FIRST IF ACTIVATED).
  The 2026-08-29 reachability audit found no valid public-API sequence that can
  create the stale, exactly matching wait row this change would reject:
  registration and parking are atomic, and timeout, suspension, cancellation,
  and terminal transitions reap their waits. The known counterexamples require
  direct SQL/corruption, a partial restore, or a mixed-version writer. Events
  remain public, and the generated wake-witness surface remains their defense.
  Activate this work only when the product supports an in-place v5 upgrade or
  mixed-version writers, accepts external writers or partial restores, or gains
  a public-API counterexample. Until then it is outside the current milestone.

  Everything above makes a wait row hard to misuse; none of it lets one PROVE
  it is current. Emit infers that
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
  at the end of a branch that has already produced repeated fix-induced defects.
  Until it lands, the generated wake surface is what holds the line, and its
  limit is written down: it can only find a wrong DECISION about rows it
  constructs, never a wrong payload, and never a row shape nobody thought of.

- **PR3.9 compile the SQL instead of scanning it** (in progress, five PRs).
  Thirteen operations across two dialects, plus about 170 registered mutations
  whose finds quote store SQL, do not fit one reviewable PR, so it lands in five.
  Since PR3.9e part 3b a batch holds tree statements only, and `FencedBatch`
  has no text path. PR3.9e part 3c made a batch read each statement's tree
  once, asked the two text lints' rules of the tree, and enrolled the corpus
  from a descriptor. PR3.9f is what remains.
  - PR3.9a: the tree layer in core. Engine tokens are value nodes carrying
    sentinel objects, and `FencedBatch` checks a tree statement by node identity
    and position inside a closed statement grammar. Statements are defined once
    in core for every dialect with `defineStatement`, and a store supplies only
    its compiler, which keeps the executor's `?` binds, and its SQL fragments. A
    generated corpus starts, a conformance case checks the builder's column
    descriptor against every dialect's catalog, and `complete`'s compare-and-set
    moves to a tree.
  - PR3.9b: claim, activation, and `deferLaunch`, with the one admission
    fragment below. A dialect's predicates reach a shared statement as SQL
    fragments with their binds, which core turns into nodes. The claim's
    candidate subquery stays store-owned, because the dialects select
    candidates differently. A fragment's role is declared where it is placed
    and checked against its position in the tree.
  - PR3.9c: suspend, reschedule, await-event, and emit-event. The statement
    grammar gains INSERT and ON CONFLICT for compare-and-sets, with an insert
    stamp rule and a conflict rule that keeps a preserved instant. Suspend and
    reschedule share one statement and one set of park assignments with the
    launch deferral. Wake arithmetic, the event timeout, and their headroom
    guards stay store-owned fragments, as the lease deadline did in PR3.9b.
    The stores' text copy of the parked claim columns and the wake guard's AND
    form are deleted. Its review round is
    `postmortems/pr3.9c-insert-rules-review.md`.
  - PR3.9d, in two halves. The first moves the compare-and-sets of fail,
    retry-task, set-checkpoint, and the cancel transition that cancel-task and
    the deadline sweep share. `failure_reason` joins `STORE_TABLE_COLUMNS`,
    and the outcome lint allows core's `statements/` directory and
    `store-tables.ts` to name the outcome columns. The failed state and the
    well-formed failure that retry-task requires stay store text, because
    registered mutations own them. The second half moves spawn and the two
    lease sweeps, lost-launch and claim-timeout. The grammar's conflict entry
    gains a partial-index predicate for spawn's idempotency target. The swept
    claim's identity becomes nodes, shared by the three sweep statements. The
    identity check spawn requires, the generation order, the owner checks, and
    the deadlines with their guards stay store fragments, because registered
    mutations own that text. `sweep-rejects-noninteger-attempt` no longer adds
    a cast to the SET list, which is nodes in core, and still bypasses all
    three attempt proofs. After this half every compare-and-set is a tree, and
    what remains text is follow-ons, derived statements, tails, and reads. The first half's
    review round is `postmortems/pr3.9d-first-half-review.md`. The second half's is
    `postmortems/pr3.9d-second-half-review.md`.
  - PR3.9e, in five parts. Part 1: the generated follow-ons, `derived()` and
    `seal()`, build trees from the relation contract and take the tree path.
    The stores change in one place, activation's first-start value, which
    reads its own column and so is built from nodes. A fragment may carry a
    fence token as a node. The grammar gains DISTINCT, and gating reads
    through one derived table and never through an aggregate with no GROUP BY.
    Part 2, done: the hand-written follow-ons and tails are trees, so no
    `FencedBatch` statement in a store is text. A follow-on may be an
    INSERT … SELECT, gated through its SELECT, stamped, and taking its instant
    from the fenced row. A subquery gate counts only when it is tied to the
    outer row. `openTailTree` takes an open read with its reason. Every run
    insert is built from one record, both checkpoint placements write through
    one statement, the emit's wake reads the recorded event through nodes, and
    both reads of a claimed run select one list. `checkpoints` joins
    `STORE_TABLE_COLUMNS`. Spawn's receipt became one read of `tasks` with an
    OR predicate, because the grammar has no UNION. Part 2's review
    round is `postmortems/pr3.9e-part2-review.md`. Part 1's review round,
    `postmortems/pr3.9e-part1-review.md`, is the third running whose findings
    trace to one cause: the corpus proves statements, and nothing compares
    what the tree rules refuse with what the text rules refused.
    Part 3a, done: the tree rules have registered mutations, two hundred and
    fourteen of them, in their own PR before the text path is deleted. Each
    removes one condition in `fenced-batch.ts` or in `sql-tree.ts`, and each is
    caught by one test, in `fenced-batch-tree-verdicts.test.ts` for the rules a
    batch applies and in `sql-tree-verdicts.test.ts` for the rules that read a
    tree or a fragment's text. They cover stamping and which token a
    provenance value is, the gate and where a fence may stand, a subquery that
    returns a row whatever it matched, the tie of a subquery gate to the fenced
    source, the follow-on insert, the inserting compare-and-set, counting
    assignments, the clock, the open tail, the statement grammar and the shape
    of an INSERT, the text of a fragment, where a fragment stands, the binds
    of a statement, and the batch's own naming and lock rules. A spelling list
    is a rule for each entry, so every clock function, clock keyword, and
    counting operator has its own mutation. The registry gained 214 entries
    and no entry of main changed. The first eighty went to review, and the
    review's line map of every find showed whole ranges no mutation touched:
    `postmortems/pr3.9e-part3a-review.md`. Giving each clock spelling its own
    mutation showed clocks the rule accepted, so the grammar now lists the
    functions a statement may call, which makes a clock called as a node
    unwritable whatever it is named, and the scan of fragment text names a
    date function with no argument and the literal `'now'`. That scan stays a
    spelling list: `age(column)` reads the clock on PostgreSQL and passes it.
    What has no mutation is derived, not listed here. The registry self-test,
    `pnpm lint:mutation-verdicts`, reads every condition-bearing line of
    `sql-tree.ts` and of the tree path in `fenced-batch.ts`, and fails when a
    line holds more conditions than registered mutations touch it, unless
    `TREE_CONDITIONS_WITHOUT_A_MUTATION` in `scripts/mutation-probe.py` lists
    the line with what a run showed: deleting it fails ordinary tests, or no
    shape can tell it from the code. Part 3b deleted one entry by name,
    `compiled.readsClock`. The comparison that stood beside it,
    `compiled.sql.includes(this.now)`, refuses every shape `readsClock` refused,
    because the clock token compiles to the batch clock's text, and also that
    text written into a fragment. `tree-clock-text-in-followon` holds the
    comparison with both shapes.
    Part 3b, done: `FencedBatch` has no text path. `cas`, `casMany`,
    `followOn`, `tail`, `openTail`, and `fenceSetAt` are deleted with the text
    compiler and every scanner that read a statement's text. The text path's
    copy of the string-literal and parenthesis scanner went with them, so the
    tree module's is the only one, and `derived()` reads a set value's
    literals through it. The `tree` option is required, so a batch built
    without the dialect that compiles its trees fails typecheck. It stays an
    option because it is the dialect's compiler and not a flag. The alpha
    release exported `FENCE_SET`, `FENCE_COLS`, `FENCE_VALS`, and `fenceSetAt`,
    so the published-surface check now takes a withdrawal with a reason, and
    refuses one of a name that is still exported. That check reads export
    names, so it does not see the rest of the break to an alpha consumer:
    `FencedBatch` lost the methods `cas`, `casMany`, `followOn`, `tail`, and
    `openTail`, and its constructor requires `tree`.
    Fourteen registered mutations are retired, each with a successor. Twelve
    owned text that is gone: `followon-provenance-check`,
    `positive-fence-required`, `positive-fence-is-not`, `top-level-or-reach`,
    `clock-ban-in-followon`, `clock-ban-raw-dialect-in-followon`,
    `raw-fence-token-check`, `event-upsert-requires-preserved-instant`, and the
    four `testing-helper-bind-*` entries that mutated the text compiler's bind
    count and undefined-argument errors. Their successors are the tree
    mutations part 3a registered for the same conditions.
    `tree-needs-a-dialect` is retired because the question it removed is gone,
    and its successor is the type. `tree-clock-ban-token-in-followon` is
    retired because, with `readsClock` deleted, it removed the same condition
    as `tree-clock-text-in-followon`, whose test now holds both shapes. The
    tests that began from a text statement build trees. The twenty-seven that
    only exercised the text scanners are deleted, and the PR accounts for each
    by name. The failure successors' deadline is built from nodes in the
    shared statement, and a follow-on insert's SELECT list holds no fragment,
    as the option below records. The registry holds 665 mutations. Its review
    round is `postmortems/pr3.9e-part3b-review.md`.
  - PR3.9e part 3c, DONE. A batch reads a statement's object graph once for
    all of its checks (`packages/core/src/tree-walk.ts`). A statement is held
    to one definition of eligibility, which is `fragment-lint`'s rules asked of
    the tree, where a condition built from nodes is visible: a list that IN or
    NOT IN compares with a state column is one of the defined sets, read from
    nodes or from a fragment's text with its binds, and the only tests of
    `cancel_at_ms` a statement may build from nodes are IS NULL and IS NOT
    NULL. The state-list half is a check of spellings, and its verdict tests
    run the spellings it does not read. `clock-lint`'s rule already had its
    tree-level form: the grammar lists no clock function and a fragment's text
    is read for a clock spelling. The corpus is enrolled from
    `corpus/labels.json`, from what a `FencedBatch` compiled, and from every
    `FencedBatch` a store's sources construct. The base gate's bridge is one
    table of pinned file pairs and one live registry arm. Completion's task
    mirror is a tree statement in core and `tasks.completed_payload` is in the
    column table. The registry holds 770 mutations. The two text lints are NOT
    deleted, and the entry below that owned that says why. Its review round is
    `postmortems/pr3.9e-part3c-review.md`.
  - PR3.9f, not started. Build the statements a store still sends as text as
    trees, then delete `fragment-lint` and `clock-lint`. They are the reads
    (`claimed-task-name`, `refusal-state`, `run-task`, `task-done-state`,
    `sweep:scan`, `get-checkpoints`, `task-result`, `next-wake`), two writes
    that are no fenced batch on any dialect (`expire-lease-now` and
    `driver-heartbeat`), `heartbeat` on libSQL and PostgreSQL, where it is one
    text statement with RETURNING, and the admin's statements. MySQL already
    builds `heartbeat` as a fenced batch of trees, because it has no
    RETURNING. They need what the statement grammar does not list today:
    RETURNING, UNION ALL, LIMIT with a bind, and an index hint on MySQL. Exit
    test 3 of the current milestone is met when it lands.
  - Delivered in PR3.9e part 3c, with the rebuild left as an option: the
    checks read a statement's object graph once. A profile of a store call put
    about two fifths of its time in reading node fields generically, once for
    every check. One walk now records each node's children and where its
    subtree ends, and every later pass reads those lists. Measured on libSQL's
    compiler with a stub executor, the lower minimum of two alternating rounds,
    before and after in microseconds for each call, on a loaded machine under
    the confinement limits, so the ratio is the result and the absolute
    numbers are not comparable with the figures below: reschedule 354 to 304,
    suspend 560 to 488, await-event 814 to 695, emit-event 908 to 727, set-checkpoint
    274 to 226, cancel 307 to 257, complete 319 to 239, and a retrying fail 848 to 699.
    The after figures include the new eligibility rule. What remains is that a
    tree statement is still rebuilt and re-checked on every call, and the
    grammar check's own work for each node: an option, not scheduled, until a
    measurement on a real deployment shows store CPU matters beside a round
    trip. The record this entry replaced: a tree statement is rebuilt and
    re-checked on every
    call, and the checks walk the tree once each. PR3.9c's review measured the
    four moved methods on libSQL with a stub executor: reschedule 78.5 µs to
    about 167 µs, suspend 121 µs to about 201 µs, await-event 141 µs to about
    270 µs, and emit-event 276 µs to about 334 µs. A local `file:` round trip
    is about 100 µs and a remote one is milliseconds. PR3.9d's review measured
    about 68 to 153 µs more store CPU for each set-checkpoint and 68 to 136 µs
    for each cancel, by the same cause. Collect node kinds, raw nodes, and
    function nodes in one pass, and measure before and after the same way.
  - Delivered in PR3.9e part 3c by the one walk above: a generated follow-on
    cost about 159 µs to
    build, check, and compile, where the text generator cost about 44 µs,
    measured on libSQL's compiler with a stub executor. Building the tree is
    about 28 µs and compiling it about 19 µs, so most of the rest is the tree
    checks, which walk the tree once each. A batch holds up to five generated
    statements. The one-pass item above owned this.
  - Delivered in PR3.9e part 3c by the one walk above: a hand-written
    follow-on cost more as a tree by
    the same cause. The revival's run insert takes about 247 µs to build, check,
    and compile where its text took about 59 µs, and the `revived` tail about
    32 µs where its text took about 1 µs, measured on libSQL's compiler with a
    stub executor, beside a batch that costs about 66 µs with its
    compare-and-set alone. The one-pass item above owned this too.
  - Resolved by PR4.3: the shared await-event, emit-event, and
    checkpoint-write statements are built with the builder's conflict clause
    and `IS DISTINCT FROM`, and MySQL 8 has neither spelling. `store-mysql`'s
    compiler spells the same trees as `ON DUPLICATE KEY UPDATE` and `<=>`, and
    the conformance suite proves the behaviour against a real server. What
    this entry expected, measured on MySQL 8.4: assignments do run left to
    right, so a column the condition reads is assigned last, and the same
    holds for a plain `UPDATE`, which this entry had not foreseen. A SELECT
    with a WHERE and no FROM parses, so `FROM DUAL` is not needed. The clause
    does fire on any unique key. Three of the four upserted tables have none
    besides the conflict target, and `tasks` has its primary key, which
    spawn's identity guard already refuses before the insert. The checkpoint
    tiebreak rides in each assignment as `IF(condition, value, column)`, with
    the incoming row named `excluded` through a derived table, and the
    checkpoint conformance cases pass.
  - Delivered in PR3.9e part 3c as far as a tree reaches, and deferred to
    PR3.9f for the rest. The rules have their tree-level form:
    `eligibilityDefinitionProblem` holds a list compared with a state column
    to the defined sets and allows only IS NULL tests of `cancel_at_ms` built
    from nodes, and the clock rule was already asked of the tree. The two
    lints are not deleted, because
    their subjects are not gone: a store still sends its reads,
    `expire-lease-now`, `driver-heartbeat`, `heartbeat` on libSQL and
    PostgreSQL, and its admin's statements as text
    that no tree holds, and a raw clock call or a second eligibility
    comparison written there is visible to those scans alone. PR3.9f builds
    that text as trees and then deletes them. The record this entry replaced:
    `fragment-lint` and `clock-lint` scan store SQL text, and
    a condition built from nodes in `packages/core/src/statements/` is outside
    what a text lint can see. PR #41's review asked for the wider scope. Run
    with core's statements in scope: a second definition of the live states
    built from nodes passes `fragment-lint`, and the same list as SQL text in
    that file is refused. So the wider scope would check nothing. The rules
    that still matter, one definition of the live states among them, get a
    tree-level form, and then the two text lints are deleted.
  - Delivered in PR3.9e part 3c: the corpus is enrolled from
    `packages/conformance/corpus/labels.json`, the label and variant
    descriptor this entry requires below, and from what ran. Core answers
    whether a `FencedBatch` compiled a statement, by identity, so the recorder
    sees every tree-built batch whatever its label, and one the descriptor does
    not name fails. That sees only what the scenario drives, and MySQL's
    `heartbeat` was a fenced batch it never drove, so a test also reads every
    `FencedBatch` a store's sources construct and holds each store's labels to
    the labels the descriptor enrols for its dialect. The enrolment's refusals
    are tested as failing controls.
  - Delivered in PR3.9e part 3c: none of the base hashes the base gate's
    bridges were pinned to named a file main still had, so the five checker
    bridges and the seventeen registry arms are deleted. A checker bridge is
    now a row in one table of pinned file pairs, a path with the base file's
    hash and the head file's hash, and the registry step keeps the one live arm
    and the helpers that arm calls. A helper that re-aims or retires a base
    entry comes back, from the file's history, with the arm that needs it. The
    table has no live row: the last one a pull request needed carried the batch
    lint that child tasks changed, which main has. So the step runs the table's
    three answers as controls on every pull request.
  - Option, not scheduled, from
    `postmortems/pr3.9a-statement-trees-review.md`: PR3.9e part 2 made the
    gating rule check that a gated subquery is tied to the outer row, which
    refuses that postmortem's exhibit. Its review then tied the gate to the
    fenced source itself: one source, no join, and a plain column of it as the
    IN key. What the rules still do not check is recorded beside run exhibits
    in `fenced-batch-tree.test.ts`. A tie on a column that is not a key passes,
    because the emit's wake is tied by queue on purpose, and the rows are then
    bounded by store text. A follow-on insert may read a value from a joined
    row that only store text ties to the fenced one. Both have one cause: a
    store fragment is opaque to the tree. Closing them means building those
    predicates from nodes, which the registered mutations that own their text
    do not allow today. The third residual of that round, an aggregate spelled
    inside a value fragment, is closed. Part 2's review built a reader of a
    value fragment's text for a call and took it back, because two registered
    mutations wrote SQLite's scalar `MIN(<deadline>, <cap>)` into the
    successor's deadline, and the reader refused the mutant before its own
    verdict could catch it. PR3.9e part 3b built that deadline from nodes in
    the shared statement, re-aimed those two mutations there, where they cap
    it with a CASE, and then refused every fragment in a follow-on insert's
    SELECT list, because a reader of text passed a schema-qualified call.
  - Delivered in PR3.9e part 3c: completion's task mirror is
    `completeTaskMirror`, one tree statement in core, and
    `tasks.completed_payload` is in `STORE_TABLE_COLUMNS`. `checkpoints.status`
    stays out: every checkpoint write leaves it to its default.
  - Option, not scheduled: load compiled statements from the generated corpus at
    run time, so Kysely becomes a build-time dependency. Importing Kysely
    unbundled measured about 65 ms per cold start, beside about 72 ms for
    `@libsql/client`, and about 9 ms once bundled. Every engine process loads a
    store, so moving the tree code to a core subpath would not avoid the import.
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
  The PR must prove in checked-in tests that the three checks rewritten against
  the node tree decide all six shapes correctly, including the two spellings
  that beat the regexes and the OR bug that shipped this week. Those tests must
  also pin two failure modes before implementation:
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
  That corpus must enumerate every declared legal branch of each label and
  reject two compiled signatures—ordered statement SQL plus bind arity—for one
  undeclared label variant. The current libSQL regression covers only relative
  and absolute wakes for `reschedule` and `suspend`; it cannot enroll a future
  input branch, label, statement, or dialect. PR3.9 must generate that enrollment
  from the same language-neutral label/variant descriptor and either give a
  genuinely different transition its own label or declare its branch topology
  explicitly, so a hand-maintained example is never the completeness claim.
  Its own PR: it rewrites the SQL of thirteen operations, and the provenance
  branches have repeatedly produced fix-induced defects.
  - Delivered in PR3.9b, from `postmortems/pr3.2a-lifecycle-review.md`: one
    admission fragment for the claim receipt, used by both activation and
    `deferLaunch`, so a guard added to one reaches the other. Six registered
    mutations that owned find texts inside activation's SQL now own the
    fragment's.
  - Deferred from `postmortems/pr3.2b-retry-task-review.md`: a successor-carry
    case generated from every batch that inserts a run, in place of one
    hand-listed family per path. The model property covers the protocol today,
    and generating the SQL-side enumeration belongs with this PR's SQL-tree work.

- **PR3.10 condition-mutation ratchet**. PR3.7's condition inventory
  IDs, makes every currently declared boolean/null/type arm witnessable; it
  does not prove the declaration itself complete. The closeout already removes
  the assertion-side proxy for checkpoint conflicts: all nine relations crossed
  with two operations carry literal executable helper closures, and a
  compiler-resolved mutation-specific helper descriptor must own its exact
  marker. PR3.10 owns the remaining source-side property: generate one red
  mutation per claimed semantic branch and enum literal across every condition ID, and
  require each mutation to resolve to that condition's attributable verdict. A
  condition ID, detached marker inventory, or one mutation per mechanism is
  still a proxy. The subsequent durable-boundary ownership tranche raised the
  live registry to **419** and declared exact owners for the then-enumerated
  classifier, codec, replay, worker, clock, collision,
  compiler-bind, completion-origin, task-option, wake-discriminant, payload,
  relation-policy, advisory-expiry, generated-syntax, static-title, and
  intrinsic-dispatch arms. Two closing settlement owners brought that registry
  to **421**; PostgreSQL JSON-input validity is the 422nd owner and the nested
  retry-factor cast guard is the current 423rd. A final-head 423/423 exact
  audit is required to prove those current declarations; even that receipt
  cannot prove that a future semantic arm is enrolled. PR3.10 must derive both
  the cases and their mutation/verdict ownership from the same layer descriptor.
  The same gate must verify each postmortem's cited red and green hashes are
  distinct, ordered commits and that the red commit demonstrably leaves the
  named probe failing; the final attribution closeout showed that prose-only
  evidence still permits repair findings to be bundled into a green commit.
  - Deferred from `postmortems/pr3.2a-lifecycle-review.md`: a poison target
    profile for a running, unactivated claim, so the `activate` and
    `defer-launch` cells reach their corruption guards instead of refusing on
    the receipt.
  - Deferred from `postmortems/pr3.2b-retry-task-review.md`: a poison target
    profile for a failed task, so the `retry-task` cells reach the counter
    guards behind its state condition. The conformance cases pin each guard
    today.

- **PR3.11 lifecycle residual**: DONE. PR3.2's rounds left three items that no
  other entry owned.
  - PR3.11a (PR #32) made a refused heartbeat name the cancellation, so a
    cancelled handler ends as cancelled at its next context call.
  - PR3.11b (PR #35) generated the launch payload case and the driver loop
    clock-shape surface, which found a wake's floor wait stretched by a clock step
    and malformed launch identity acknowledged. The loop measures its waits with
    `Clock.elapsedMs`, and `launchIdentity` validates a launch's identity once.
  - PR3.11c (PR #36) generated the store answer case, which found handlers running
    on activation answers missing or malforming required fields. The worker
    checks the answer with `claimedRunAnswerProblem` before any user code runs,
    ends the pass as `incompatible-store` naming the field, and the run recovers
    through the sweep for a compatible build. It also added a due-wake axis to the
    clock-shape surface.

- **PR3.2 lifecycle polish**: DONE. Merged green as two stacked PRs. PR3.2a
  (PR #28) parks a claim that a build without the task's handler cannot run
  before activating it, raises `RunCancelledError` from a refused write on a
  cancelled run, models the suspension paths' eligibility guard, pins
  idempotency-key reuse to Absurd's `spawn_task`, and floors `/wake` at one look
  per interval. PR3.2b (PR #29) adds `retryTask`, following Absurd's
  `retry_task`. Their review rounds are `postmortems/pr3.2a-lifecycle-review.md`
  and `postmortems/pr3.2b-retry-task-review.md`.
  Its residual is NOT recorded here: each item sits under the named PR that will
  do it, with its source postmortem.

- **PR3.3 child tasks + SDK completion**: spawn-from-step, completion-event
  await, cross-queue refusal; `/api/runs/:id` result route. Spec first:
  `specs/ChildTasks.tla` models the completion event and lands before its SQL,
  for an await whose event and wait row live in one queue. TLC checks it with
  the await allowed and with it refused, and ten probes each exhibit one
  violation or one reachable behaviour. Thirty mutants, each one guard of
  the model bent or deleted, must each violate the property its entry names
  (`specs/ChildTasks.mutants.json`, run by `scripts/tla.sh`), because a probe
  shows that an invariant can fail and cannot show that a guard is held. The
  implementation then maps every terminal batch onto the model's ChildTerminal, takes the dialect's event
  lock in each of them, reserves the `$task-done:` name at the store's
  `emitEvent` port, and adds `ctx.spawn` and an internal child await to the
  SDK. Nothing reads the model's ledger block, because `scripts/spec-ledger.py`
  reads Scheduler.tla only. So the implementation adds one conformance case
  per terminal batch, six of them, generated from the batch labels: the batch
  writes the completion event and wakes a registered waiter, on both dialects.
  Event cleanup, when it is built, must not remove a completion event whose
  task can still be awaited. The spec's review round is
  `postmortems/pr3.3-child-tasks-spec-review.md`.
  The maintainer settled the queue rule on 2026-09-17, after the spec's
  review showed that Absurd's same-queue refusal leaves no await that works
  here: a same-queue await is allowed, and an await across queues is refused
  until a delivery protocol for it is modeled, because events are keyed by
  queue.
  The implementation is built on that model. Every terminal batch writes the
  completion event and wakes its waiters as follow-ons of the statement that
  ended the task, and takes the event lock on PostgreSQL. The `emitEvent` and
  `awaitEvent` ports refuse a reserved name, `awaitTaskDone` is the child
  await, and the SDK adds `ctx.spawn` and `ctx.awaitTask`. The conformance
  surface `child-tasks` holds the model's actions and guards on both dialects,
  the operation fuzz and the SDK's replay-equivalence harness generate child
  awaits, and `childTaskViolations` checks every history only the engine wrote.
  Two reads were added and are recorded in DESIGN.md §3.2: `task-done-state`
  says why a child await neither registered nor hit, and `run-task` names the
  task of a run that another store activated. The review round is
  `postmortems/pr3.3-child-tasks-impl-review.md`. It changed the model first:
  a child that a build older than this protocol ended has no completion event,
  and the await records its outcome (`AwaitMaterialize`), under the deploy rule
  the model states as an assumption. The maintainer decided four things as
  built: the store remembers a run's task and the task id does not pass through
  the port, `ctx.spawn` is its own memoized step, `ctx.awaitTask` resolves for a
  failed or cancelled child, and `TerminalImpliesDone` is held by
  `childTaskViolations` and not the invariant library. Not built here, each
  with its reason:
  - The `/api/runs/:id` route, because `/api/inspect` already answers with a
    task's result, and a route by run id is left to the PR that needs it.
  - A repair for the one case the deploy rule covers: an older build that ends
    a child while a parent is parked on it strands the parent until its timeout
    or its cancellation deadline. An await that records the outcome wakes
    nobody, so a second parent's await does not free the first. A sweep that records the event of a terminal
    task that has a registered waiter would close it. It is deferred because it
    is a protocol step, so it is modeled first.
  - Detection of an await cycle, which the model leaves to the cancellation
    deadline.
  - Event cleanup, which does not exist yet. It must not remove a completion
    event whose task can still be awaited.
  - The completed payload of an awaited child is stored five times: in the task
    row, in the run's result, inside the completion event, in each waiter's
    `event_payload`, and in the parent's checkpoint memo, where it is escaped
    twice. A pointer to the task row cannot replace the event's copy, because a
    revival overwrites that row. It waits until result sizes are observed.
  - A task ending on PostgreSQL is 8 round trips where main's was 5. The three
    more are the completion event, the wake, and the lock. Folding statements
    needs a grammar the tree path does not have.
  - Every other string a store port takes. This round holds the spawn queue
    and a port's event name to the durable string domain, each where it enters.
    A queue or a step name at the other ports is not checked at the port. One
    check for the whole port is its own change.
  - A plan check over every write of the libSQL corpus. `query-plans.test.ts`
    pins the statements someone chose, so the terminal wake had no pin when it
    moved into six batches, and the keyed follow-ons below scan `tasks` today
    with every test green. The property is that no write scans a table once
    for each row of another, and a check generated from the corpus would hold
    it for every statement. It is its own change.
  - Deferred to PR3.3b, the hoists the second review named. Core declares the
    event lock, so that the eight lines that take it leave the dialect store and
    a batch that adds a completion event without it is refused, and it decides
    there whether a batch that ends no task needs the lock. A tree rule refuses a
    statement that writes a terminal `tasks.state` unless the batch carries the
    completion event's follow-on. The child await's engine logic, which is the
    same text in both stores, and its two reads move into core beside
    `addTaskDone`, so that a third dialect inherits them.
  - The row lock of a caller's event can be dropped once no build that takes it
    can still run. That needs a stated oldest build, which nothing records today.
  - Holding the deadlock count at zero across the PostgreSQL concurrency cases
    and the fuzz, so that a new lock-order inversion fails a test and is not
    hidden by the victim's retry. The database's counter is shared by parallel
    test workers, so it needs a counter on the executor that a fixture can read.
  - Smaller, from the same review: the run-to-task memo does not forget a run
    its terminal batch has ended, `EventName` does not carry the task id or a
    display form, port refusals have no one typed class mapped once at the hosted
    route, no single helper runs both violation checkers, and a few test helpers
    are copies.
  - Promoted to PR3.14 below: the generated follow-ons that select their source
    by key correlated it to `tasks` on the queue, and on libSQL their plan was
    a scan of `tasks`.
- **PR3.4 saga / step rollbacks** per DESIGN §3.10 (Cloudflare's shipped
  June-2026 API shape): `ctx.step(name, fn, { rollback, rollbackConfig })`,
  engine-triggered on terminal failure only, reverse step-START order,
  rollback handlers as ordinary durable steps (`rollback:<step>#<count>`)
  with their own retry budgets, halt-on-rollback-failure, no distinct
  terminal state (rollback outcome is a separate result field). Conformance:
  crash mid-rollback resumes; reverse order exactly once each; caught errors
  never trigger rollback; `output === undefined` for started-not-persisted
  steps; rollback-failure halts the chain and surfaces in the result.
  Spec first: `specs/Sagas.tla` models the rolling-back phase and lands before
  its SQL. TLC checks it under the recommended answers to three questions
  DESIGN.md §3.10 leaves to the maintainer and under each alternative, and the
  configurations explore different graphs. Its probes must each fail, and its
  mutants must each be caught by the property the entry names. A mutant bends
  a guard. Behaviour that is removed is a probe's to catch, as the
  forward-phase revival is. `scripts/tla.sh` serves each side model that has a
  mutant list beside it, and fails when a module or a cfg beside the specs
  belongs to nothing it runs. WakeDelivery.tla is older and runs from its own
  line. The implementation then writes the start marker before a registered
  step's body, enters the phase in the same batch as the terminal decision in
  `fail` and in both sweep caps, admits rollback passes past the user attempt
  budget, and changes `retry-task`'s admission, because reviving a task whose
  saga ran is unsound today. `scripts/spec-ledger.py` reads Scheduler.tla
  only, so nothing checks this model's ledger block, and the implementation PR
  owes every guard an executable twin on every dialect. Beyond the conformance
  cases above those are: the start marker commits before the body runs; the
  decision and the phase marker are one batch in `fail` and in both sweep
  caps; no forward step starts or commits in the phase; `retry-task` refuses a
  task whose saga began; a cancellation mid-rollback records `failed` exactly
  when a step is left uncompensated; the infrastructure-cap rule; and a failed
  rollback attempt is counted, which the model cannot see because an uncounted
  attempt is a stuttering step. The review round is
  `postmortems/pr3.4-sagas-spec-review.md`.
  The implementation is built on that model, under the maintainer's three
  answers: a cancellation in the phase halts the saga, `retry-task` refuses a
  task whose saga began, and an infrastructure cap rolls back. A saga's state
  is checkpoints under reserved names, so there is no migration. One batch
  label is new, `fail-rollback`, with its own port method, and DESIGN.md
  §3.10 maps each action of the model to its batch. Exit test item 5 is held
  on libSQL and PostgreSQL by the `sagas` conformance surface, 18 cases on
  each dialect, and by the SDK's saga suite, 14 cases on each dialect, which
  runs through a PostgreSQL twin of the SDK's test harness. Each owed twin,
  and the case that holds it:
  - The start marker commits before the body runs: the SDK case `commits the
    start marker before the body runs`, which reads the checkpoints from
    inside the body.
  - The decision and the phase marker are one batch in `fail` and in both
    sweep caps: `enters the phase in the batch that decides the failure, and
    ends nothing`, `a sweep cap enters the phase when a rollback is owed, and
    ends the saga inside it`, and the fault matrix's `saga-cap-edges` starting
    state, which seeds a task at each of the three caps and lets the armed
    fault land on each crossing.
  - No forward step starts or commits in the phase: `freezes the forward
    phase, and admits a rollback only inside it`, which also refuses a
    completion, a suspension, and a wait. The row checker `sagaViolations`
    runs behind every saga case, every fault matrix cell, and every fuzz walk,
    and each of its eight conditions has a hand-written saga it must name.
  - `retry-task` refuses a task whose saga began: `ends failed with the
    deciding failure and a complete outcome once every rollback ran`.
  - A cancellation mid-rollback records `failed` exactly when a step is left
    uncompensated: `a cancellation in the phase halts the saga, and the
    outcome says what was left`, and the SDK's cancellation case.
  - The infrastructure-cap rule: the sweep cap case, and `a parent awaiting a
    rolling-back child sees nothing until the saga ends, then one outcome`,
    which runs over every terminal label from a record keyed by the label
    type.
  - A failed rollback attempt is counted: `counts a failed rollback attempt,
    retries it past the budget, and halts when told to`, `refuses a failed
    rollback of a task that is not rolling back, and writes nothing`, and the
    SDK's counting case.
  - Crash mid-rollback resumes, reverse order exactly once each, caught errors
    never trigger rollback, `output === undefined` for a step that started and
    never persisted, and a rollback failure halts and surfaces: the SDK's saga
    suite on both dialects, and the replay-equivalence harness, which
    generates saga programs and faults each at every sampled store call across
    the forward phase and the rollback passes.
  - Rolling deploys: `leaves a failure an older build decided alone, and rolls
    back once a newer one decides`, `caps a failure in the phase that carries
    no attempt record, which halts the saga`, `revives a failed task whose
    saga never began, as before`, and the SDK case for a step that committed
    before it registered a rollback.
  The mutation registry gains 45 mutations, one condition each, and moves
  from 729 to 774. Writing one for each condition showed three guards that
  nothing could kill, because the compare-and-set their statement is fenced
  on already holds them, and they were removed. Measured on one machine: on
  PostgreSQL every failure sends nine queries where it sent eight, because
  the rollback pass is gated on the failure alone, and a completion and a
  checkpoint send what they did. A test pins the count for each batch a saga
  touches. Query plan pins hold that every saga read reaches the checkpoints
  by primary key with the task bound. The fault matrix gained a fifth
  starting state and a six-call saga block that every cell runs. That costs
  time. In three paired runs on one shared machine, the base and this branch
  interleaved, the four PostgreSQL tests the base also has took 38 to 49
  seconds on the base, median 45.5, and 47 to 55 on this branch, median 52.0.
  The new starting state took 51 to 61. The limit is 120 seconds. Single runs
  on that machine spread wider than the difference between the two, so only
  the paired runs compare them.
  Open, and owned by this entry until it merges:
  - The poison matrix seeds no task with a started step, so it never reaches
    the rollback pass. The pass's one stored-integer guard is held by a
    boundary case in the `sagas` surface.
  - The store records the attempt count the SDK hands it and does not check
    it against the last one, and nothing caps how many passes a task may
    take. Rollback budgets are the SDK's to keep.
  - A saga with nothing to roll back records nothing, where the model calls
    it complete at entry.
  - The registry bridge arm in `ci.yml` is keyed on the registry of the
    child-task branch this branch is built on. It must be keyed again on
    main's registry when that branch merges or changes.
  - `packages/store-mysql` merged to main after this branch was cut, and
    this branch does not have it. The MySQL store owes `fail-rollback`, the
    rollback pass in `fail` and in both sweep caps, and the phase predicate
    in `complete`, `set-checkpoint`, `retry-task`, `suspend`, and
    `await-event`, and must pass the `sagas` surface, before this entry can
    merge.

- **PR3.12 concurrent PostgreSQL migrators**: DONE. A concurrent cold-start
  migrator could be rejected as facing a malformed database. `lets concurrent
  cold-start migrators converge on the current schema` failed PR #40's
  `verify` twice on PostgreSQL, with two of eight migrators rejected, and
  passed on a rerun. The cause: the executor read the schema version under
  REPEATABLE READ, which takes its snapshot before the statement resolves the
  name, and PostgreSQL resolves a name against the newest catalog. A version
  read racing a concurrent bootstrap's commit was answered with the `meta`
  table and no `schema_version` row, which the admin calls a schema mismatch.
  The server raises no error for that read, so PostgreSQL's log for a failed
  run showed only the designed losers: `pg_type_typname_nsp_index` on `CREATE
  TABLE IF NOT EXISTS meta`, then `meta_pkey` on each `applied:vN` sentinel,
  each raised at the instant a winner committed. `applyVersionedWrite`
  forgives those once the recorded version has reached the write's version,
  and they are expected after a concurrent cold start. Raced through the real
  migrator, 2 of 300 rounds rejected a migrator in the test's exact shape, and
  18 and 22 of 300 with ten jittered migrators, every time with `got 1 results
  and 0 rows`, the reason that test has reported since PR #40. The executor
  now reads the version under READ COMMITTED, where the snapshot follows the
  name lookup, and none of 3000 rounds rejected one. DESIGN.md states the
  property for each dialect. `postgres-bootstrap-window.test.ts` orders the
  race inside one statement on the server, under each isolation level: the
  statement names a second table first, and a concurrent transaction holds
  that table locked until it has bootstrapped and committed. The executor's
  canonical read names one table and cannot be held that way, so the
  executor's unit test and its registered mutation hold the isolation level,
  and the eight-migrator case still meets the race in under one run in a
  hundred. A first fix, a confirming second read in both admins, treated the
  symptom and was replaced in review. The same review found that the libSQL
  admin ran its bootstrap bare, against DESIGN.md, so a bootstrap that lost to
  a concurrent winner rejected the loser. It is forgiven now once the metadata
  exists. The round is `postmortems/pr3.12-migrator-race-review.md`.
- **PR3.13 `verify` fails with every test passing**: three times on 2026-09-17
  the `verify` job exited 1 after every test had passed, on vitest's unhandled
  error `[vitest-worker]: Timeout calling "onTaskUpdate"`. Measured: a worker
  whose event loop does not turn for 60 seconds produces exactly that error.
  The libSQL client runs every statement as a blocking native call, and vitest
  does not reach the timers phase between tests that never yield. The deadline
  was already known here: `nightly.yml` splits the fuzz into batches to stay
  under it. The conformance file was the case nobody had batched, and its
  worker went 48.9 seconds without turning on a devserver. `makeLibsqlFixture`
  now awaits one zero-delay timer. Every test of the generated conformance
  suite and every fuzz walk builds its fixture there, and
  `fixture-libsql-yields.test.ts` holds that line for every build, without
  measuring a duration. It is a timer on purpose. Run in a worker thread, a
  blocking stretch that resumes from a timer callback has a waiting reply
  handled before a deadline armed during it, and one that resumes from
  `setImmediate` meets the deadline first. How that maps onto vitest's own
  calls is inferred, not run. With it the conformance file's longest stretch
  is 15.7 seconds, and a nightly-sized fuzz batch, which was one stretch of
  43.6 seconds, has none of two seconds or more. Estimated, not measured: no
  stall was timed on a CI runner. Vitest timed the libSQL wake-witness test at
  16.2 to 22.3 seconds in five CI logs against 17.1 on the devserver, which
  puts the old stretch between 46 and 64 seconds there, across the limit,
  though the run with the slowest timing passed. The root `vitest.config.ts`
  sets `testTimeout` and `hookTimeout` to 15 seconds and is type-checked
  through `tsconfig.vitest.json`, because vitest loads a misspelled key in
  silence, and `root-vitest-config.test.ts` reads the limit back. Open: (1)
  One loop that never yields is still one stretch. The wake-witness test runs
  two loops, one for each generated case list and each on its own fixture. The
  test takes 16 to 22 seconds on CI, and its longer loop was one stretch of
  15.1 seconds here. If it grows, build a fixture for each chunk of cases, or
  split the test, which needs its registered mutations re-aimed by name. (2)
  `verify:fuzz:deep` sets no `FUZZ_BATCHES`, so each shard is one test of
  about 3,125 walks, some 830 seconds at the 0.266 seconds a walk that the
  review's verifier measured, past that test's own 600 second budget. It is
  older than this entry and runs in no gate. (3) Not explained: three of PR
  #42's last four runs hit the error and none of eleven other runs did, on a
  branch whose one executed change finishes in the first ten seconds. (4)
  Eighteen files under test directories open a libSQL database through
  `openTestDb` and not through the fixture factory, four of them in the
  conformance package, and get no yield. They are small today. The yield
  cannot move into `openTestDb`, which lives in `packages/store-libsql/src`,
  where the determinism lint bans timers. The review rounds are
  `postmortems/verify-event-loop-yield-review.md` and
  `postmortems/verify-fixture-yield-review.md`.

- **PR3.14 keyed generated follow-ons**: on libSQL, eleven shipped writes
  scanned the table they wrote: the task update of claim, activate,
  defer-launch, reschedule, suspend, await-event, complete, fail, and both
  sweeps, and the runs update of cancel-task. A generated follow-on over a
  queue-scoped relation may bind its queue, as the wake's task follow-on
  already did, and fourteen call sites in each store gave it none, so the
  source was correlated to the written table on the queue, and SQLite cannot
  drive a write from a correlated subquery. Each call site now binds the queue
  its method was given. The fence reaches the same rows through the same
  stamp, no tree rule changed, no registered mutation's find text moved, and
  the three corpus files are regenerated. Two follow-ons that are handed the
  key of the one row they write also name it on the written side, the
  cancellation's task and the await's run, because beside a bound queue and a
  state SQLite prefers the (queue, state) index to the key. One `complete` on
  libSQL, median of 7, beside tasks of its own queue:

  | Tasks | Correlated | Queue bound |
  |---|---|---|
  | 2,000 | 5.4 ms | 5.0 ms |
  | 10,000 | 8.9 ms | 4.1 ms |
  | 40,000 | 21.7 ms | 3.7 ms |
  | 100,000 | 43.4 ms | 3.6 ms |

  The child-task work measured the correlated form on main at 2, 5, 20, and
  61 ms. PostgreSQL was keyed and is keyed: all 16 task updates plan with an
  `Index Cond` on `tasks_pkey`, and a plan test in `store-postgres` holds that
  for the shipped statements. MySQL was keyed too, measured with rows in the
  table: beside 4,000 tasks claim walked 54 rows, activate 14, and complete
  27 with the queue unbound, and a plan test now holds those three batches.
  The PostgreSQL fault matrix took 212 s before and 209 s after, which is
  flat. `store-libsql`'s plan pins recover every UPDATE and DELETE of thirteen
  labels from the real operations and refuse a scan of the written table.
  This PR merges after PR3.4 and PR3.9e part 3c. Both regenerate the corpus
  and touch these call sites, so the rebase regenerates the corpus and binds
  the queue in part 3c's `completeTaskMirror` too.
  - Option, not a deferral of this PR: three statements of `claim` select
    their source rows by queue and state, through `runs_poll`, so every claim
    walks the running runs of its queue on libSQL: the runs update, the task
    update, and the delete of expired waits. The stamp that says which runs
    this claim took has no index. The wake's follow-ons had the same shape and
    found their rows by `wake_event` through `runs_woken`. A claim has no such
    column, so this needs its own design.
- **PR3.5 simplification sweep**: DONE. The findings recorded in
  SIMPLIFY-BACKLOG.md were re-audited against `main` at `06bba58`. Every finding
  landed or was rejected with a reason below, and PR3.5c deleted that file. It
  landed as three stacked PRs, #25 to #27:
  - **PR3.5a:** core, driver, and SDK shapes, plus stale spec and script
    comments, and this milestone record.
  - **PR3.5b:** the successor's parent-taken columns defined once in core, a
    single cancellation-deadline bind, the spawn winner's redundant tiebreak
    removed, `mapLimit` and `clampLimit` hoisted into core, and one core decoder,
    `decodeTaskResult`, that refuses a task row whose outcome contradicts its
    state. Both stores and the dogfood status command decode through it,
    `scripts/outcome-lint.py` refuses a second decoder, and an engine invariant
    checks every snapshot against it.
  - **PR3.5c:** the conformance and fuzz helpers. One scenario module holds a
    single-row read that runs in read mode, a fixture opener that always closes
    its fixture and keeps the scenario's failure when closing also fails, and
    claim, claim-and-activate, and owner-bound transition helpers that take the
    store and queue they act on. The suite and the fuzz walk use them, seeded
    worlds start inside one helper, single-run tests use the default fixture, the
    fuzz walk counts lease-holding transitions through one helper, and
    SIMPLIFY-BACKLOG.md is deleted.
  - Rejected: deleting the `WakeSignals` port. It has no implementation, but it
    is exported from the published `@durablerun/core` barrel, so deleting it
    breaks consumers that import the type. Removing a published export belongs
    in a deliberate API change, not a behavior-preserving sweep.
  - Rejected: unifying core `WakeSignals` with the driver's `WakeRequest` and
    `WakeScheduler`. All three are published exports, so unifying them changes
    published interfaces, which belongs in a deliberate API change.
  - Rejected: a `TaskResult` discriminated union. Every consumer that reads
    `completedPayloadJson` without narrowing on state stops compiling, including
    the published example, so the stores refuse impossible rows instead.
  - Rejected: wrappers for the owner `EXISTS` guard and the terminal-or-sole-live
    guard. Their predicates already have single definitions in `fragments.ts`,
    enforced by the fragment lint; the SQL around them differs at every site, and a
    wrapper would move 24 mutation-registered guard texts behind interpolation.
  - Rejected: a stamped-fence helper. Each site is already one `b.fence(...)`
    expression, so a helper would rename it without removing a second copy.
  - Rejected: hoisting the persisted-row decoders into core. They are identical in
    both stores, but `persistedRowInteger` owns a type-level mutant bound to the
    libSQL typecheck project; moving it needs a typecheck project the mutation
    registry does not have, a registry-wide change that requires the full audit.
  - Rejected: naming `sweepClaimTimeout`'s live-owner and terminal-owner split the
    way `sweepLostLaunch` does. Its live arm also carries the infra-retry headroom
    condition, so the named fragments would need a parameter for it, and four
    registered guard mutations match the split's current text.
  - Rejected: a core record of the runs columns a successor sets for itself. Its
    only consumer would be one conformance case, so DESIGN.md §3.8 states the list
    and that case classifies every runs column.
  - Rejected: reading the refusal case's rows concurrently. Sequential reads keep
    the first refusal message deterministic.
  - Rejected: requiring each poison-matrix case to fire exactly the conditions it
    covers. Measured on this branch, 13 cases also fire closely related
    conditions, such as a counter bound beside a negative generation, so the
    check needs a reclassification of the poison inventory, which is not a store
    simplification. The two cases that fired an outcome condition now carry a
    consistent outcome instead.
  - Rejected: removing `retryDelaySeconds`. It is a working function in the
    published `@durablerun/core` barrel, so deleting it breaks consumers
    rather than simplifying the engine.
  - Rejected: removing the single-valued `waits.status` and
    `checkpoints.status` columns. It needs a schema migration, and the poison
    matrix writes `delivered` wait rows that the status filters must keep
    excluding, so it is not a behavior-preserving simplification.
  - Rejected: opening the host binaries' database through `openTestDb`. They
    are real processes and must not inherit test-helper defaults.
  - Rejected: opening `replay-equivalence.test.ts`'s database through
    `openTestDb`. Its own `try`/`finally` closes the database even when
    migration throws.
  - Rejected: moving the time-boundary suite's claim and activation helpers, and
    the make-then-close fixture sites in the time-boundary, schema-admin, poison
    matrix, fault matrix, and store conformance suites, onto the scenario module.
    The schema-admin, fault matrix, and store conformance sites close their
    fixture in `finally`, so there the change would alter only which error a
    double failure reports. The time-boundary `fixtureAt` sets the fake clock
    before its caller's `try`, so a failing clock write leaks that fixture, and
    the poison matrix closes a prepared fixture in `catch` and hands it to
    callers that close it in `finally`, a shape `withFixture` does not fit. 59
    registered mutations own verdict markers in `time-boundaries.ts` alone, and
    every one would join this PR's mutation closure.
  - Rejected: passing a claimed run to the port's `awaitEvent` and
    `setCheckpoint` in place of three identifiers. That changes published port
    signatures, which belongs in a deliberate API change, and the owner-bound
    helpers already remove the repeated arguments from the tests.

## Phase 4 — dialect matrix

- **PR4.1 suite extraction hardening**: conformance runs from a store factory
  matrix; purge accidental turso-isms.
  From PR3.6, because each is only decidable with a second dialect in hand:
  - **Postgres double-claim**: `casMany` guarantees a win rule, not a
    concurrency semantics; store-pg needs `FOR UPDATE SKIP LOCKED` and a
    conformance scenario before it is DONE.
  - **Closed lock preludes**: `FencedBatch.lockEvent` and `lockClaim` pass only
    their typed coordinates to the executor before the fenced SQL. They do not
    accept SQL or contribute a result slot, so the new dialect can acquire its
    transaction lock without opening an unfenced-write escape.
  - **MySQL cannot derive the winner from row counts alone** — no targeted
    `ON CONFLICT`; the `SqlResult` normalization contract must state
    matched-not-changed semantics.
  From PR3.7:
  - **Migration-version conformance**: the sixth indivisible `schema-admin`
    surface lifts PR3.7's libSQL schema gate into the shared admin contract.
    Every dialect must accept only the canonical
    nonnegative safe base-10 representation, require exact equality with the
    binary's current version, and classify an actually absent metadata table
    at the dialect boundary without allowing stored error-like text or an
    unrelated read failure to impersonate a fresh database.
  - **Temporal schema enrollment for each new dialect**: the 23-field temporal
    contract, conditions, snapshots, and corruption witnesses are
    dialect-neutral. The shared schema/admin runner now checks the combined
    31-field durable integer inventory; each fixture supplies only its native
    catalog projection (`PRAGMA table_info` for libSQL). No dialect may declare
    itself conformant without exact 64-bit numeric encoding and nullability.

- **PR4.2 store-postgres**: native executor/schema, `SKIP LOCKED` claim, closed
  event and same-token claim lock preludes, and the identical six-surface
  conformance suite against PostgreSQL 17. Upstream Absurd oracle parity
  remains deferred by the current milestone.
- **PR4.3 store-mysql**: `packages/store-mysql` passes the identical
  six-surface conformance suite against MySQL 8.4, in its own CI job,
  `conformance-mysql`, beside `verify`. READ COMMITTED, BIGINT epoch-ms, one
  transaction for each transition. Every shared statement tree and every
  labeled batch runs from the same tree: the portability survey found no
  statement that needed a change to a tree or to the checker. What MySQL makes
  a store do is in DESIGN.md §3.4, each item measured on a real server. Three
  changes reached the shared conformance package, none of them to a scenario:
  the two raw writes to the version table became the fixture's, because `key`
  is a reserved word MySQL must quote and MySQL cannot make a TEXT column a
  primary key; the corpus test matches either identifier quote; and
  `DURABLERUN_CONFORMANCE_DIALECTS` narrows a run to the servers it has,
  failing on an unknown or empty list, which
  `packages/conformance/bin/dialect-conformance.sh` checks again from the
  reporter's record. Open: (1) MySQL bounds an indexed
  identifier at 255 characters and the other dialects do not, so the same long
  queue or event name is accepted there and refused here as an invalid durable
  string. Making the engine identical means a length rule in core's
  `requireDurableString`, which changes the other dialects' contract and is
  the maintainer's call. (2) The stored-JSON guards cannot refuse a repeated
  key on MySQL. The guard and the decoder read the same member, so nothing is
  decoded that was not checked. (3) A claim leg can lock up to the limit in
  runs the merged order leaves out, which other claimers skip until that claim
  commits. (4) Version 1 holds the whole schema because MySQL DDL cannot roll
  back. The first migration that alters a table needs a repeatable form, which
  MySQL has no `ADD COLUMN IF NOT EXISTS` for. Version 6, the `runs_woken`
  index that child tasks read through, is the first statement after version 1:
  it is chosen from the catalog and prepared, which is safe to repeat, and a
  column will need the same form. (5) The optional PlanetScale
  smoke job is not built. (6) Sagas land their batches on libSQL and PostgreSQL
  first, and `store-mysql` ports them after. Child tasks are ported, in PR3.3
  itself: the MySQL leg of the identical suite runs the child-task cases and
  the fault and poison matrix cells of the new labels, and nothing is owed.
  The review
  of this PR found eleven defects, eight of them in behaviour and one of them
  introduced by a fix, recorded in
  `postmortems/pr4.3-store-mysql-review.md`. Since it, the store refuses an
  identifier past 255 characters itself, whatever the excess is, because MySQL
  cuts trailing spaces past the width where it refuses any other excess.
  - **Discharged from PR3.12:** MySQL commits each DDL statement on its own,
    so a `meta` table without its version row would be an ordinary state
    during every cold start, and isolation alone cannot hide it. The adapter
    removes the state: the bootstrap is one `CREATE TABLE … AS SELECT`
    statement, and the version read begins under READ COMMITTED, because MySQL
    refuses to read a table defined after a consistent snapshot. Measured over
    250 cold starts with six racing readers: two statements gave 765 rowless
    reads, the snapshot gave 1500 refusals, and one statement under READ
    COMMITTED gave neither. At volume: eight concurrent cold-start migrators
    converged in 3200 of 3200 runs, and the eight-migrator and lost-bootstrap
    schema/admin cases both passed in 120 repeated runs.
- **PR4.4 store-mysql follow-ups**: what the PR4.3 review found that the
  milestone does not need, none of it a correctness hole today.
  - Deferred from PR4.3: the migration lock is chosen by the batch label
    (`migrate:bootstrap` or `migrate:vN`), spelled in the executor, the admin,
    and `batch-lint.py`, where the event and claim locks travel in
    `SqlBatchControl` so a wrapper cannot drop them. Carry it there as a lock
    coordinate. With it goes the case no test has: a version that was half
    applied, rerun through `migrate()`. It changes core's batch control and
    every executor, which PR3.9e part 3b and the child-task fold are editing.
  - Deferred from PR4.3: a read batch costs four round trips and a
    single-statement write three, where autocommit needs one. Five of the six
    read batches hold one statement, the per-tick next-wake among them.
  - Deferred from PR4.3: `migrate()` reads the version before each of the four
    empty versions and takes the lock for each. One read and one locked batch
    would do, which matters most to the conformance suite, which migrates a
    database for every case.
  - Deferred from PR4.3: the claim's `FORCE INDEX (runs_poll)` legs have no
    measured plan test. `store-mysql/test/query-plans.test.ts` is where it
    goes. The shared concurrency case fails when a leg over-locks, which is
    how the shape was found.
  - Deferred from PR4.3: third copies. The test id source, the admin's
    version read and versioned write, the fixture's corruption-table switch,
    and the store's dialect-free declarations are now in three packages.
    Hoisting them is one change to all three stores.
  - Deferred from PR4.3: a generated conformance surface that runs every store
    call concurrently with itself on every dialect. PR #50 and PR4.3 each
    found a transition no concurrent case reached, and each added a case for
    that one transition, so the class is expected again until the surface is
    generated.

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
  - **Triggered residual — full hosted dialect enrollment:** PR #15 proves the
    selected claim path against the deployed Turso parser, not every labeled
    batch. Enroll the identical conformance fixture against an isolated hosted
    database when PRC.1 supplies safe ephemeral database lifecycle and
    credential handling; do not turn the current production dogfood database
    into a destructive all-operation test fixture.
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
