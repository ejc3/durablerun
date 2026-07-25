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
  postmortems/pr11-codex-final-review.md), leaving three deferrals of its
  own: enforce attestation-artifact freshness in review-attest.sh (refuse
  a codex log or journal older than the branch head — the header promises
  it, the code does not check it); a schema/emit-boundary guarantee that an
  event payload is never SQL NULL (lifting the timeout sentinel from a
  type-only to a structural guarantee); and canonicalize-and-classify a
  handler result at the source so a non-serializable result is a permanent
  user failure, not a silent completion with NULL.
- **PR3.6 write provenance** — DONE. Every table a compare-and-set targets
  carries `fence_stamp`/`fence_at_ms` (migration v4, DESIGN.md §3.4 rule 8),
  stamps are per STATEMENT, and all thirteen store operations go through
  FencedBatch; the batch-lint debt set is empty and deleted. Six review passes
  found thirty-eight defects — see postmortems/pr3.6-fence-provenance.md,
  whose detection ledger records that our own machinery found four of them.
  Its residual is NOT recorded here: every item is owned by a named PR below
  (PR3.7, PR3.2, PR4.1). A deferral parked under a DONE heading is a silent
  drop, because DONE is the section a reader skips.

- **PR3.7 close the provenance residual** (the PR3.6 postmortem's "what this
  round still would not catch", each item owned rather than parked):
  - **A typed target expression for follow-ons — and it makes the primitive
    SMALLER.** This is the one mechanism that closes the class that recurred
    in every PR3.6 review round, and it should not be read as more machinery.
    Today the caller writes free-form SQL and 126 lines of hand-rolled
    scanning (`topLevelWhere`, `negatedSpans`, `hasTopLevelOr`,
    `blankComments`, `skipString`, `matchingParen`, …) try to verify a
    property of that text afterwards — 18% of `fenced-batch.ts`, 19 of its 45
    unit tests, and every false negative the round found. Generating the row
    selection instead:

    ```ts
    b.followOn('wake-tasks', {
      target: 'tasks',
      key: 'task_id',
      derivedFrom: { table: 'runs', column: 'task_id', fence: 'wake-runs' },
      set: `state = 'pending'`,
      narrow: `state IN ${LIVE}`,   // ANDed: may only shrink the set
      rows: { many: 'one task per woken run' },
    })
    ```

    `WHERE key IN (SELECT col FROM src WHERE fence_stamp = ?) AND (narrow)`
    is generated, so there is no caller-authored WHERE to parse, no OR to
    ban, no comment to blank, and no NOT to recognise. The whole scanner and
    its 19 tests are DELETED, and "the write set derives from this batch's
    post-state" holds by construction. PR3.6 deferred this claiming join
    shapes differ per dialect; that was never tested and looks wrong —
    `IN (SELECT …)` is ordinary SQL in all three. Test the claim first.

    Known residual, to be an explicit escape with a written reason rather
    than a hole: emitEvent's fan-out genuinely selects from `waits`, which
    this batch did not stamp, and uses the event's fence only as a gate. One
    escape with a reason is a better shape than a scanner defending every
    statement — the same trade `openTail` already makes for reads.
  - **A data-level provenance audit**: every inserted-or-changed row carries a
    well-formed `<seed>:<statement>` stamp, over paths that never touch the
    primitive. Measured too slow for the deep fuzz leg (a scan per batch), so:
    always-on in conformance and the fault matrix, sampled in the volume legs.
  - **A per-statement clock-jitter executor.** Now a DIFFERENTIAL proof rather
    than a bug hunt: with the clock banned outside a compare-and-set, jittering
    each statement's clock must produce zero behavioural change.
  - **A generated corrupt-pre-state ("poison") fault surface** driving every
    write label against each invariant-forbidden pre-state.
  - **A simulation assertion that a batch seed is never issued twice.** The
    whole scheme is exactly as strong as `IdSource.token()` uniqueness, and the
    harness deliberately hands out colliding ids.
  - **A bound on many-row follow-ons.** `{ many: reason }` costs a sentence and
    bounds nothing, so amplification is unlimited wherever the target set is
    wider than intended.

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
- **PR6.4** EndingFeed port + reconcile consumers.

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
