# Durable Workflows on Turso with Serverless Tick-Driven Execution

Design document, researched and written 2026-07-18. All version numbers, limits, and
prices are as verified on that date; primary sources are cited inline.

## 0. Goal

Run durable workflows — with the semantics of Absurd, Armin Ronacher's
Postgres-backed durable-execution engine (§1.2): tasks, checkpointed steps,
sleeps, events, retries — with:

- **Storage on a pluggable SQL backend** — Turso/libSQL first, MySQL and Postgres
  behind the same interface.
- **Workers on a serverless platform whose primitive is "launch this function now"**
  (Lambda-shaped), optionally "launch it at time T". Workers are heavyweight and
  numerous — they must be launched on demand, run one unit of work, and exit.
  True scale-to-zero for all worker compute when there is no work.
- **N lightweight, stateless drivers ("ticks")** that decide when to launch
  workers. Something has to own the clock; the drivers are allowed to be
  long-lived precisely because they are tiny (a poll loop over two indexed
  queries), while everything heavyweight scales to zero.
- Deployable to Vercel today; portable to any launch-primitive platform later.

The reference architecture is Cloudflare Workflows: every workflow instance is a
SQLite-backed Durable Object whose alarm is "set with the timestamp of the next
expected state transition" — hibernate at zero cost, wake exactly when needed. We
rebuild that shape from commodity parts: Turso holds the state, driver ticks are
the "alarm handler", and a one-shot scheduler primitive (QStash — Upstash's
service that HTTP-POSTs your endpoint at a chosen time — Vercel Queues delayed
messages, or a platform timer) replaces the proprietary alarm infrastructure
where no resident driver runs.

## 1. What the research established (read this before arguing with the design)

### 1.1 The Vercel Workflow SDK ("WDK") and its Worlds

- The DevKit was renamed **Workflow SDK**; docs at workflow-sdk.dev (useworkflow.dev
  307-redirects). npm `workflow` latest is **4.6.0**; the 5.x betas (5.0.0-beta.35)
  restructure the World contract and **hard-reject** any World that does not declare
  `specVersion: 5` (check introduced in 5.0.0-beta.27, PR #2659).
- A **World** = `Queue + Storage + Streamer` (`@workflow/world`). Execution is always
  "a queue message causes an HTTP POST to the app's own
  `/.well-known/workflow/v1/{flow,step}` routes"; the workflow function replays from
  an append-only event log and returns `{ timeoutSeconds }` when suspended (sleep),
  which the Queue turns into a delayed re-delivery.
- **On Vercel (managed path)**: zero-config. The Vercel World uses Vercel Queues
  (`queue/v2beta` triggers — handlers are air-gapped, only the queue can invoke
  them), managed encrypted persistence, and delayed messages for sleep (23h max per
  hop, chained). **No ticks anywhere — the queue push IS the invocation.** Crash
  recovery = at-least-once redelivery, 48 deliveries max. GA since 2026-04-16;
  priced per workflow event ($0.02/1K) + data written/retained.
- **Every DB-backed World is a resident poller.** world-postgres embeds
  graphile-worker (500ms poll + LISTEN/NOTIFY) inside the app process, started by
  `world.start()` from `instrumentation.ts`; docs and maintainer say flatly it
  "does not work on serverless environments".
- **The community Turso World exists**: `@workflow-worlds/turso` 0.2.2
  (mizzle-dev/workflow-worlds, listed in Vercel's worlds-manifest.json). Storage is
  a clean event-sourced schema on libSQL (8 tables, Drizzle migrations, CBOR
  payloads). But its queue is a 100ms `setTimeout` poller that claims one message
  per tick and POSTs it to the app — "without start(), messages are stored but not
  processed". It is pinned to the **spec-2 era**: works on `workflow@4.2.0–4.6.0`
  (tolerant negotiation), **broken on every 5.x beta**, and the upstream repo has
  been quiet since 2026-06 with the v5 port explicitly identified as a significant
  unstarted migration.
- The one **serverless-native community World** is `@fantasticfour/world-upstash`:
  no `start()`, no poller — `queue()` publishes to QStash, QStash POSTs to the app,
  sleep is re-published with `delay`, retries budgeted to 47 to match the runtime's
  48-delivery expectation, signatures verified in `createQueueHandler`. This is the
  proven template for "push queue instead of poller".
- Endpoint security: only the Vercel World air-gaps the workflow routes. For any
  self-hosted World the `/.well-known/workflow/v1/*` routes are ordinary public
  routes that **appear to have no built-in authentication** (inferred, not
  corpus-verified: the follow-up commissioned on exactly this returned no data;
  the local/postgres worlds POST plain `x-vqs-*` headers over loopback, and
  world-upstash adds its own QStash signature verification — evidence auth is
  the world's job). Assume hostile regardless: any world we ship verifies a
  signature/secret in `createQueueHandler`.

### 1.2 Absurd (the engine we are porting)

Repo `earendil-works/absurd` (Armin Ronacher / mitsuhiko; Apache-2.0; announced
2025-11-03; 5-month production retrospective 2026-04-04 — "the design held up").
The entire engine is one ~3,083-line `sql/absurd.sql` of plpgsql; SDKs (TS/Python/Go)
are thin clients calling ~15 stored functions.

Per-queue tables: `t_<q>` tasks, `r_<q>` runs, `c_<q>` checkpoints, `e_<q>` events,
`w_<q>` wait registrations. The load-bearing ideas, all of which we keep:

- **Everything future is a run row.** Retries, sleeps, event timeouts, deferred
  tasks — all are runs with `state IN ('pending','sleeping')` and an `available_at`
  timestamp. One poll index `(state, available_at)` drives everything.
- **Claim = lease.** `claim_task(queue, worker_id, timeout, qty)` claims due runs
  (`FOR UPDATE SKIP LOCKED` in Postgres) and sets `claimed_by` +
  `claim_expires_at`. Checkpoint writes and heartbeats extend the lease.
- **The next claimer is the reaper.** The same `claim_task` call first sweeps
  expired leases (fails those runs with `$ClaimTimeout`, which schedules a retry
  run) and enforces cancellation policies. No separate reaper process. Docs warn:
  "brief overlapping execution is possible — design your steps to tolerate it."
- **Checkpoints, not deterministic replay.** `ctx.step(name, fn)` memoizes results
  in `c_<q>` keyed `(task_id, checkpoint_name)` with an automatic repeat counter
  (`iteration`, `iteration#2`, …) so agent-style unbounded loops work. Retries are
  task-level; code outside steps re-runs. ~2k LOC of SDK vs Temporal's ~170k.
- **Sleep** = persist wake time as a checkpoint, then `schedule_run(run,wake_at)`
  (state='sleeping', available_at=wake_at) and throw an internal SuspendTask. Wake
  is purely "a poller notices available_at <= now".
- **Events** are first-write-wins facts in a queue-global namespace: their key,
  stored payload, and `emitted_at` never change. Delivery provenance may be
  re-stamped by a fresh invocation, but always at that immutable emitted
  instant; exact replay can therefore never move one seed to a second instant.
  `emit_event` flips all sleeping waiters to pending and writes each waiter's
  checkpoint atomically; `await_event` checkpoints-or-registers-a-wait.
- **Retry math is data**: `retry_strategy` jsonb (fixed/exponential/none, base,
  factor, cap), computed at fail time; a new run row (attempt+1) is inserted with
  `available_at = now + delay`. One total constructor validates spawned,
  decoded, and directly calculated strategies, canonicalizes every duration to
  milliseconds, and returns exact frozen nominal data bounded to 100 years.
  Only an omitted spawn policy selects the default; explicit `null` is invalid.
  Zero-base exponential retries stay zero even after exponentiation would
  overflow; every other overflow clamps to the validated cap before the failure
  transition is attempted.
- Absurd uses **no** LISTEN/NOTIFY, no triggers, no advisory locks — strictly
  pull-based. This is why it ports. The main Postgres-isms (the corpus lists 15
  categories): plpgsql itself, SKIP LOCKED + FOR SHARE/KEY SHARE row locks,
  jsonb, data-modifying CTEs, dynamic per-queue DDL (`EXECUTE format()`),
  conditional upserts (`ON CONFLICT … DO UPDATE … WHERE`), `'infinity'`
  timestamps, the `absurd.fake_now` session-GUC time override, custom SQLSTATEs
  (AB001/AB002), partitioning, and UUIDv7 helpers — each has a §3.4 mapping.
- Stock deployment is a long-lived worker polling every 250ms — the part we replace.

### 1.3 SQLite/Turso port surface (verified against real implementations)

- **The claim pattern without SKIP LOCKED** — used by goqite, litequeue, and River's
  experimental SQLite driver — is a single atomic statement:
  `UPDATE ... SET state='running', ... WHERE id IN (SELECT id ... WHERE due ORDER BY
  ... LIMIT n) RETURNING *`. SQLite's single-writer serialization makes it
  race-free; there is never a concurrent writer to skip. libSQL supports RETURNING.
- **Turso Cloud transport rules**: interactive transactions lock the whole DB for
  writes and are killed after a **5-second window**; idle connections close at 10s.
  `client.batch(stmts, 'write')` IS atomic (implicit BEGIN IMMEDIATE). Therefore
  every engine transition must be a **single statement or one atomic batch** —
  which conveniently forces the plpgsql→client rewrite into the correct shape.
- **Turso has no DB cold start** on the AWS diskless platform ("a database is a
  file, not a process"; idle DB = files in object storage, costs storage only).
  First query after long idle pays lazy S3 segment fetch — expect tens of ms,
  unpublished. Caveat: Free-plan docs still mention 10-day archival requiring
  explicit unarchive (likely stale Fly-era text; avoid by paying $4.99/mo or verify
  empirically).
- **Commit latency ceilings by plan** (documented): Free ≤100ms, Developer ≤50ms,
  Scaler ≤25ms, Pro ≤10ms added per commit (S3-Express-backed WAL; batched).
  Single-writer + ceiling ⇒ order 10–100 claims/sec/DB worst case.
- **The binding constraint is monthly rows-written quotas**, not latency: Free 10M,
  Developer 25M (+$1/M), Scaler 100M. A naive 1s-interval tick doing one 1-row
  UPDATE is ~2.6M rows-written/month — 26% of the Free quota for one idle queue.
  Rows *read* are a different story: 500M/mo included, $1/billion after.
  Conclusion: **an idle tick must be read-only; writes only when work exists.
  Read-polling is cheap; write-polling is not.**
- **Turso cannot launch compute on write.** `/beta/listen` (SSE change stream) is
  not available on AWS Free/Developer/Scaler, is at-most-once with no
  cursor/replay (in-memory broadcast, drops on lag), payload is only per-table op
  counts, and it needs a resident SSE consumer. The new engine's `turso_cdc` table
  (stable v0.5.0) is poll-only and not in GA Cloud. Triggers can't call HTTP.
  **Ping-on-enqueue + swept outbox is the only reliable enqueue-time launch path**
  — which Turso's own blog also recommends.
- **DB-per-tenant sharding is idiomatic and free**: unlimited DBs on paid plans,
  created via Platform API in ~100ms. Each DB is an independent single-writer
  domain — the scale-out mechanism for queue throughput.
- New-engine MVCC (`BEGIN CONCURRENT`) exists as a tech preview and next-gen cloud
  is in private beta (2026-04); design for graceful upgrade but do not depend on it.

### 1.4 MySQL as the second backend

- MySQL 8.0.1+ has `FOR UPDATE SKIP LOCKED` (blessed for queue tables by the
  manual) but **no RETURNING**. Claim shapes: (a) 2-statement transaction
  (SELECT...SKIP LOCKED then UPDATE), or (b) **transactionless token claim** —
  `UPDATE jobs SET claimed_by=:me, ... WHERE due ORDER BY ... LIMIT n` then
  `SELECT ... WHERE claimed_by=:me` — autocommit-friendly, ideal over HTTP drivers.
- Use **READ COMMITTED** on queue tables (default REPEATABLE READ takes gap locks
  on scanned ranges → deadlocks on hot queues).
- PlanetScale-style serverless MySQL: 20s transaction cap, concurrent-transaction
  pool ceiling → prefer the token claim.
- No partial indexes (use composite `(state, priority, available_at)` or a separate
  ready-rows table à la Solid Queue); temporal fields use exact BIGINT epoch-ms,
  matching the shared integer contract; upsert is `ON DUPLICATE KEY UPDATE` (no
  conflict target) vs `ON CONFLICT` elsewhere.
- MySQL also cannot wake external compute (no NOTIFY, triggers are SQL-only, EVENT
  scheduler runs SQL only) — **the driver/tick architecture is required for every
  backend, so it is the portable core of the design, not a Turso workaround.**

### 1.5 How production systems solve scale-to-zero wake-up

| System | Who decides to run code | Timer primitive | Idle cost |
|---|---|---|---|
| Vercel Workflows | Vercel Queues pushes → function invoked | delayed message ≤23h, chained | zero |
| Inngest | central engine POSTs each step to app endpoint | queue item vested in future | zero (for user) |
| Cloudflare Workflows | Durable Object alarm wakes the engine object | `setAlarm(next transition)`, ms-precise, ≤1min worst case, at-least-once | zero |
| Trigger.dev | central engine + CRIU checkpoint/restore of containers | DB waitpoints + engine timers | zero (for user) |
| QStash (as a part) | QStash POSTs to your URL at T | `Upstash-Not-Before` (1s granularity, up to 1yr) | $1/100K messages |
| Absurd stock | resident worker polls 250ms | `available_at` row scan | one process, always |

The convergent pattern (and ours): **(1) ping-on-enqueue** for new work,
**(2) a one-shot "launch at T" alarm re-armed to the next known transition** for
timers/leases, **(3) a slow recurring cron sweep as the safety net** for lost
pings, dead alarms, and non-cooperating writers. All three launch the same
idempotent dispatcher; claims are atomic so duplicate launches are benign no-ops.

## 2. Decision

Two deliverables, in this order:

**Deliverable A — deploy the WDK's managed path to Vercel now (baseline).** A small
Next.js app using `workflow@4.6.0` `"use workflow"` / `"use step"` deployed to
Vercel with the zero-config Vercel World. This gives immediate durable workflows in
production, the observability dashboard, and a behavioral reference. Turso can be
the *application* data store. Do **not** attempt `@workflow-worlds/turso` on Vercel
(resident poller; unsupported there) and do not use `workflow@beta` 5.x with it
(hard spec rejection).

**Deliverable B — "durablerun": port Absurd's engine to a pluggable-SQL,
serverless-driven engine.** This is the real project. Keep Absurd's data model and
semantics nearly verbatim (they are proven and deliberately minimal); move the
plpgsql into a TypeScript core issuing per-dialect atomic SQL; replace the resident
worker poll loop with the driver/tick architecture below. Optionally (Phase 7) wrap
it as a spec-v5 WDK World so `"use workflow"` apps can run on it.

## 3. Architecture (Deliverable B)

```
                                   ┌────────────────────────────────────────┐
   producers (app code, API)       │            Turso (per shard)           │
   ────────────────────────────    │  tasks / runs / checkpoints / events   │
   spawn(task) ──INSERT──────────▶ │  waits            (Absurd schema, SQL) │
        │                          └────────────▲────────────┬──────────────┘
        │ ping (fire-and-forget                 │            │ claim batch:
        │  HTTP, after commit)                  │            │ single UPDATE…RETURNING
        ▼                                       │            ▼
   ┌──────────────┐   launch N workers   ┌─────────────────────────┐
   │ DRIVER /tick │ ───────────────────▶ │  WORKER (one run each)  │
   │  stateless,  │   (fire-and-forget   │  ctx.step → checkpoint  │
   │  <1s, idem-  │    HTTP / platform   │  heartbeat → extend     │
   │  potent)     │    "launch thing")   │  lease; sleep → suspend │
   └──▲───▲───▲───┘                      └───────────┬─────────────┘
      │   │   │                                      │ done/suspended:
      │   │   └── re-arm: one-shot alarm at          │ ALWAYS ping driver
      │   │       min(next available_at,             │ (every suspension
      │   │       next claim_expires_at)             ▼  creates future work)
      │   │       (QStash Not-Before / VQ delayed msg / platform timer)
      │   └────── cron sweep (1/min Pro) — best-effort safety net
      └────────── pings from producers, workers, event emitters
```

### 3.1 The driver ("tick")

`tick()` is the unit of driving: small, stateless, idempotent, sub-second. Any
number of drivers may run concurrently — the claim statement is the mutual
exclusion. There are **two drive modes over the same `tick()` code**, chosen per
deployment:

- **Resident driver (preferred)** — a tiny long-lived process:
  `while (true) { tick(); await sleep(adaptive) }`. Poll interval ~100–500ms when
  recently busy, backing off toward a few seconds when idle. This is affordable
  because an idle tick is *reads only* — `min(available_at)` over an indexed empty
  set scans ~0 rows; on Turso, rows read are effectively free (500M/mo included on
  Free, $1/billion after) while rows written stay proportional to actual work, not
  to time. A 250ms idle poll costs ~2% of the Free read quota and zero writes.
  Run 1 driver for simplicity, N identical ones (with poll jitter) for HA and
  claim throughput; no leader election — the DB arbitrates. The driver is the one
  component that does not scale to zero, and it is the cheapest thing in the
  system: single-digit MB of memory, near-zero CPU, no state beyond its loop.
  It cannot run on Vercel (no resident processes) — host it on a container
  platform, a VM, or the target "launch this thing" platform itself as a pinned
  service.
- **Serverless tick (fallback / Vercel-only deployments)** — no resident process
  at all: the same `tick()` runs per-invocation, fired by ping-on-enqueue +
  one-shot alarms re-armed to the next transition + a cron sweep (the rest of
  this section). Higher wake-path complexity, same engine code. Also the backstop
  if resident drivers are down: a 1/min cron tick makes driver outages degrade to
  added latency instead of stalls.

Either way, every trigger — poll timer, ping, alarm, cron — means the same thing:
*"there may be runnable work; look."*

The current remote-Turso dogfood uses a bounded validation host, not a third
production drive mode: one scheduled process owns one launch slot, runs one
claimed worker synchronously until that worker completes or durably suspends,
then exits under a workflow-level deadline. The schedule supplies later ticks,
so no process remains resident while the task sleeps. This is a deliberately
thin outcome probe; general serverless ticks still use asynchronous launches
and the ping/alarm machinery above. Before any remote command can migrate or
query state, the workflow requires its secret database URL to equal an
independently configured repository-variable pin for the dedicated dogfood
database. A missing or mismatched pin fails the job without opening the
database. Its normal receipt gate requires the
durable task type, repository, ref, cycle count, and interval to match the
configured workload intent exactly, and the durable interval span itself to
cover at least seven days. An idempotently reused wrong-target, short, or
long-cadence task therefore fails both start and receipt validation instead of
qualifying under new process configuration. The task handler, status reader,
and receipt verifier share one parser for that durable workload shape. A live
receipt uses database time and rolls a two-hour freshness deadline from task
creation or the latest contiguous checkpoint; exceeding the next durable
interval plus that grace fails the scheduled run, so zero or stalled progress
cannot remain green for seven days. A deliberate-death probe derives
an isolated queue from its fresh idempotency key; its probe identity remains
set while the one-shot injection hook is cleared, so start, injection,
recovery, and verification all select that queue. Its one-slot tick therefore
cannot inject the fault into older due journal work instead of the task whose
recovery receipt will be verified. After advisory lease reconciliation, this
bounded host fails the scheduled invocation when its inline slot observes a
task failure, a store outage, lease loss, an unknown task type, or a failed
launcher. Quiescent suspension and a stale duplicate delivery remain
successful outcomes.

Resident-driver launch watchdog: with an ASYNC (fire-and-forget) launcher,
the loop abandons a launch call that has not acked within a deadline
(default 10s) and treats it as a failed launch — the run recovers through
the normal lost-launch path, so a hung transport costs one timeout, never a
stalled driver. With a bounded-slot SYNC launcher (§3.9 — the call runs the
worker inline and legitimately lasts as long as the run) the watchdog must
be DISABLED; the slot bound, not a timeout, is the backpressure.

```
tick():
  0. cancel: enforce cancellation policies (max_delay / max_duration):
     advisory SELECT of violating tasks, then one fenced batch per task
  1. sweep expired leases (bounded: K_s per tick): advisory SELECT of runs
     with claim_expires_at <= now (reads only), then PER RUN one atomic
     batch. Two cases, told apart by activation state (§3.2):
       lost launch (activated_gen < claim_gen): the worker never started —
         re-open the SAME run for claiming: no new row, no attempt consumed,
         relaunch_count+1 with backoff on available_at; past its cap the run
         AND its task fail terminally — a broken launcher must surface as
         failed tasks, never spawn successors through itself (TLA-pinned).
         Reopening leaves claim_gen untouched: stale in-flight launches die
         on the state guard now and the gen guard after the next claim.
       died mid-run (activated): $ClaimTimeout — insert the successor run
         (fresh UUIDv7, infra_retries+1 — NOT max_attempts — available_at
         computed in SQL, carrying forward the run-DB pointer, wake_event,
         and event_payload), fail the old run, update the task.
     Batch fencing (§3.4 rule 1): the FIRST statement is the guarded CAS
     transition; later statements key on the post-transition state plus the
     batch's own stamp — never on the pre-condition the CAS just consumed.
  2. claim: ONE fenced batch with two distinct identities. The caller's
     per-tick claim_token is the durable lease and retry receipt; the batch
     also mints a fresh per-invocation provenance seed:
     UPDATE runs SET state='running', claimed_by=:token,
       claim_gen = claim_gen + 1, claim_expires_at=…
       WHERE run_id IN (SELECT … due, ORDER BY available_at LIMIT K)
       RETURNING run_id, task_id, attempt, claim_gen;
     mutating follow-ons (task updates and expired-wait deletes) key on the
     claim CAS's statement stamp and post-state. The task-data receipt read
     alone keys on claimed_by = :token so a same-token retry can return the
     prior invocation's selection.
  3. launch: fire-and-forget one worker invocation per claimed run, payload
     {runId, attempt, claim_token, claim_gen} (HMAC-signed). The worker acks
     immediately and executes inside its OWN invocation — the tick never
     waits on run duration and returns in <1s. (Sync launchers — §3.9 — are
     for bounded-slot hosts only, including the one-slot dogfood host; general
     serverless ticks always launch asynchronously.)
  4. next-wake: t = min( available_at over pending/sleeping,
                         claim_expires_at over running,
                         cancellation deadlines )
     resident mode: sleep until min(t, poll ceiling) — the loop IS the alarm
     serverless mode: arm a one-shot alarm at t (QStash Not-Before / Vercel
     Queues delayed message ≤7d). If deduplication is used, it may match only
     alarms that have NOT yet fired; the hosted example does not deduplicate.
     A sooner wake is never dropped for an outstanding later one, and a
     duplicate alarm is an idempotent no-op tick.
     If sweep or claim backlog remains (> K_s / > K), fire an immediate
     successor tick — the tick chain is the drain loop; cron resurrects a
     dead chain.
  5. return counts (for observability)
```

Notes:
- **The fencing rule is the master rule.** A libSQL `batch()` is atomic but
  *unconditional* — every statement executes even when an earlier guard matched
  zero rows, and there is no early return. Therefore every dependent statement in
  every engine batch re-embeds its full fencing predicate (§3.4). Sweeping dead
  leases, enforcing cancellation, and claiming due runs in one tick is Absurd's
  `claim_task` contract, ported — but split into read-then-fenced-batches because
  each expired run gets its own atomic transition. The scan is advisory: successor
  ordinals and task-terminal collision checks derive from the failed row carrying
  this batch's fence, never from values returned by the earlier read.
- Timer latency: resident mode sleeps until `min(next transition, poll ceiling)`,
  so wakes are as precise as the loop (ms). Serverless mode's re-arm makes it ≈
  alarm precision (seconds via QStash, ms via DO alarms on Cloudflare) instead of
  cron granularity. The cron sweep (once per minute on Vercel Pro; slower is fine)
  bounds the worst case — a lost ping, a dropped alarm, a dead driver, rows
  INSERTed by writers that don't ping — but note it is **best-effort recurring,
  not at-least-once**: Vercel never retries a failed or missed cron invocation,
  so budget a few cron periods of worst-case latency, not one. (QStash is the leg
  with real at-least-once semantics: retries + DLQ.)
- Duplicate/concurrent ticks: harmless. A fresh per-tick claim token owns the
  durable lease and retry receipt, while a fresh FencedBatch seed fences each
  invocation's mutations; duplicate re-arms remain safe; sweep batches
  re-check their fences per statement. Herds are bounded by the K/K_s batch
  caps plus poll jitter — deliberately NOT by a tick-singleton lease, which
  would break the invariant that every trigger causes a look.
- With zero work: a resident driver's idle tick is two indexed reads returning
  nothing (~0 rows scanned) and zero writes; in serverless mode no pings arrive,
  no alarm is armed, and the cron tick exits the same way. Either way the idle
  cost is a rounding error on Turso's read quota and no worker compute exists.

### 3.2 The worker function

One invocation executes one claimed run to its next suspension point:

- **Activation CAS first — and the latch is per-claim, not per-run.** The same
  launch can be delivered twice (at-least-once channel), and the same run row
  is legitimately re-claimed many times (every sleep wake, every lost-launch
  relaunch, every chain hop), so a one-shot flag can never work. Each claim
  increments the run row's `claim_gen` (§3.1 step 2) and the launch payload
  carries it; activation is
  `UPDATE runs SET activated_gen = :claim_gen, claim_expires_at = <re-extended>
  WHERE run_id=:r AND claimed_by=:token AND claim_gen=:claim_gen AND
  activated_gen < :claim_gen AND <soleLiveRun(runs)>`. The final fragment
  refuses activation if another live run now belongs to the task, including
  corruption introduced after claim. Zero rows = a duplicate delivery already
  activated this claim, the claim was superseded, the lease was swept, or the
  task no longer has one live run: exit immediately. Activation re-extends the
  lease, so a launch that sat in the channel for most of the lease doesn't
  start life nearly expired; and
  `activated_gen < claim_gen` at sweep time is exactly what identifies a lost
  launch (§3.1 step 1).
- Loads visible checkpoints (`c_` rows for the task, committed, owner attempt ≤
  current) into memory — Absurd's TaskContext preload, one SELECT.
- Runs the registered task handler with `ctx`: `step(name, fn)` (memoize→execute→
  `set_checkpoint` upsert which also extends the lease), `sleepFor/sleepUntil`
  (throw Suspend CARRYING the sleep marker; the runtime lands marker + park in
  ONE fenced batch — `suspendRun` — because a marker whose park failed would
  read as "the wake already happened" to the next attempt), `awaitEvent`
  (checkpoint-or-register-wait, throw Suspend), `emitEvent`, `spawn` (child tasks).
  User-supplied names — step names AND event names, on `awaitEvent` and
  `emitEvent` alike — may not contain `#` (reserved for the SDK's repeat
  counters — `poll`, `poll#2` — which are user-visible in the checkpoints
  table) or start with `$` (reserved for engine markers); both are refused
  as permanent failures. So are invalid numeric knobs (`sleepFor`,
  `sleepUntil`, `awaitEvent` timeouts): deterministic bad inputs must never
  loop through lease recovery. Task option properties are read once before
  validation: `awaitEvent.timeoutSeconds` is snapshotted into one lexical, and
  that exact validated value is the one persisted by the atomic store call.
  Structurally, every user input crosses the
  context through ONE classified boundary (core's `UserName.parse` /
  `userDurationToMs` / `userEpochMs`, which throw `FatalTaskError`
  directly); durable replay keys are only constructible from validated
  names, so a future context method cannot re-open the class. Every durable
  task value—step result, final result, and parsed event payload—crosses the
  same `serializeTaskValue` boundary. It returns the canonical JSON wire form;
  top-level `undefined` pins to `null` on every pass, while functions, symbols,
  bigint, cycles, and hostile serialization hooks are permanent
  `FatalTaskError`s. Scheduler task names and idempotency keys cross one
  durable-string validator at each store's spawn ingress: actual NUL and lone
  UTF-16 surrogates are rejected before IDs are minted or executor I/O can
  change or alias their identity. Scheduler headers, which dialect SQL later parses as an
  object before issuing worker authority, must enter as a plain object whose
  own enumerable string-keyed values are strings. Their keys and values also
  have a narrower portable string domain: actual NUL and lone UTF-16 surrogates
  are rejected before SQL. Runtime type escapes fail permanently before
  executor I/O, so a successful spawn cannot create a task the claim predicate
  refuses.
  Opaque result, checkpoint, parameter, and event JSON
  retains ordinary JSON string semantics. Scheduler payloads obey the same source rule: spawn routes
  normalized retry, an own-data-property cancellation snapshot, and headers
  through the module-captured task-value and header serializers; claim decodes
  admitted retry and headers through the matching captured parser. The canonical wire value,
  not a second ambient JSON path, is the durable representation. At the
  user-handler catch boundary, only controls minted
  by that invocation's private runtime authority can suspend or abort; a public
  `SuspendSignal`, `LeaseLostError`, or `StoreUnavailableError` constructed by
  task code is an ordinary task failure. `FatalTaskError` is the intentionally
  public policy signal that skips retries. Every other thrown value becomes one
  owned canonical failure snapshot; error-like diagnostics come only from
  guarded data-string descriptors, and uninspectable objects use one fixed JSON
  spelling without invoking getters or coercion.
  The operations that implement these durable boundaries are captured when the
  core and SDK modules load: retry arithmetic and field reads, owned JSON graph
  construction, name classification, replay maps, abort accessors, promise
  adoption, registry lookup, and the production clock do not re-resolve their
  public global or prototype properties after task code runs. Authentic Map
  entries are handler authority even for Map subclasses; overridable `get`
  methods may neither revoke a stored entry nor grant a missing one. A non-Map
  structural registry remains trusted host resolver code and owns its own
  dependencies.

  This captured-operation contract is not a JavaScript sandbox. Handlers share
  the worker process and are trusted with host-realm integrity: they must not
  mutate unrelated platform/driver machinery or terminate the process.
  Executing untrusted application code requires a separate process or realm;
  enumerating more captured methods cannot provide that isolation. Hostile
  values, getters, proxies, serialization hooks, and public control
  construction at the named boundaries remain fully in contract.
  Error taxonomy on a pass: infrastructure failures from the caught checkpoint
  read and defer, complete, park, or fail transitions are classified at the
  immediate catch; context store failures are enrolled before they cross the
  handler boundary. Once the heartbeat pump starts, one outer cleanup scope
  covers checkpoint loading, context construction, handler execution, and
  finalization; every exit stops and joins the pump. The join is bounded, and
  its losing deadline is cancelled so a completed short-lived host retains no
  idle timer. Retry accounting uses the
  worker-owned lexical attempt snapshot taken before task code and never
  rereads the public context after the handler. Handler execution plus result
  serialization and the completion write are lexically separate phases. Only
  the former can enter user-failure accounting: an ordinary completion
  rejection propagates and never calls `fail`, while an authenticated
  completion-store control maps to its infrastructure outcome. Activation
  errors still propagate to the worker caller, while an advisory heartbeat
  error only ends that upkeep loop. A
  classified infrastructure failure aborts the pass with NO ADDITIONAL
  transition — a lost response may already have committed — so recovery is the
  lease story and the user's retry budget is never touched; only errors from
  user code spend user attempts.
- Heartbeats via the scheduler-plane `heartbeat` CAS. Under `inline` placement
  this rides along with checkpoint writes (same DB); under `dedicated` placement
  it is a separate call on its own cadence — extend when remaining lease < ~50%,
  throttled, so shard-DB write rate stays transitions + throttled heartbeats.
  The cadence is derived from the exact lease milliseconds, including legal
  subsecond leases; no one-second floor may outlive the lease it protects. A
  zero-row `heartbeat` is the AB002 equivalent (lease gone): abort the handler
  immediately.
- On completion/failure: `complete_run` / `fail_run` — the leading CAS checks
  `claimed_by=:token AND state='running'`, so a zombie whose lease was swept
  cannot win; every mutating follow-on keys on that CAS's per-invocation
  statement stamp and post-state. Retry *policy* lives client-side (same jsonb
  strategy) but all absolute timestamps are computed in SQL
  (`unixepoch('subsec')` arithmetic) with clients passing only relative
  durations — instance clock skew must never move engine time (Absurd's
  `current_time()` discipline, ported; a nullable fake-now in the shard-meta
  row recreates its test affordance).
- **After every suspension or terminal transition that leaves future work —
  sleep, await-with-timeout, retry scheduled, voluntary exit — the worker
  unconditionally pings the driver** (or arms an alarm for its wake time). Not
  just "if backlog remains": a 10s `sleepFor` creates a wake the currently-armed
  alarm knows nothing about, and without the ping it would wait for cron.
- Function-timeout safety: before `maxDuration` (800s Pro; 300s default) the
  worker checkpoints and exits via **voluntary, attempt-neutral chaining**:
  `schedule_run(run, now)` (same run, same attempt — Absurd's own suspend shape)
  + ping; the next tick relaunches and the checkpoint cache resumes it. Lease
  expiry is NOT the sanctioned continuation path — it routes through the sweep
  and costs an infra retry plus latency. Runaway chains (the risk AWS documents
  for recursive Lambda patterns) are bounded by the task's
  `cancellation.max_duration` wall-clock policy, with the lease as the
  concurrency guard.
- Rolling deploys, ported from Absurd: a worker that claims a task name its
  build doesn't know **defers** it (`scheduleRun(now + 15s + jitter)`, nothing
  consumed) — deploy workers before enabling producers, and old runs survive
  new code. In-flight runs resuming under changed code rely on checkpoint
  stability: step names/order must stay compatible, or the task name is
  versioned (`report@v2`) so old runs finish on old handlers.
- Child tasks: `spawn` from a step, then await the child *as an event* — the
  child's terminal transition emits `task-done:<taskId>` and the parent's
  `awaitEvent` suspends like any other wait (no polling worker slot). Absurd's
  deadlock rule is kept: awaiting a same-queue child from inside a worker is
  refused.
- Cancellation discovery: state transitions raise the ported `AB001/AB002`
  equivalents (SELECT state guard inside each engine call), aborting quietly.

Sizing: claim batch K per tick and per-worker concurrency are tunables; Vercel
Fluid compute multiplexes concurrent invocations in one instance and bills Active
CPU only while running, so I/O-bound workers are cheap. Nothing idles: a worker
either progresses a run or exits.

### 3.3 Enqueue and event paths (the "when to launch" contract)

Every code path that makes work runnable **commits first, then pings**:

- `spawn(task)` → INSERT (idempotency_key upsert) → `waitUntil(ping)`.
- `emitEvent(name, payload)` → one atomic scheduler-plane batch: first-write-wins
  payload and emitted instant; a fresh invocation may establish a new delivery
  fence at that original instant, while exact replay preserves it. Sleeping
  waiters flip to pending/`available_at=emitted_at`. Under `inline` placement
  the waiters' checkpoints are written in the same batch (Absurd verbatim —
  durable-at-emit); under `dedicated` placement the payload is parked on the
  run row and wait rows flip to `delivered` for materialize-on-resume (§3.8.3)
  → ping. The parked run carries `wake_step` — the replay key of the await that
  registered the wait — alongside `wake_event`/`event_payload`, so a delivered
  wake binds to the exact await that requested it. The SDK matches a carried
  wake by `wake_step` (unique per await), never by the event name (shared across
  a task's awaits of the same event), so one await can never consume another's
  wake. `wake_step` travels with the wake through every transition
  (suspend/reschedule consume or preserve it as a unit; failure and
  claim-timeout successors carry it forward).
- Hook/webhook arrivals (HTTP routes) → same.
- Worker suspending or finishing with any future work created (its own sleep, a
  scheduled retry, remaining backlog) → ping, unconditionally (§3.2).

A ping is a fire-and-forget POST — to the resident driver's `/wake` endpoint
(which just cuts its current sleep short), or to `/api/tick` in serverless mode.
Its loss is tolerable because the poll ceiling / cron sweep exists; with a
resident driver at a sub-second poll ceiling, pings are optional entirely. Writers
outside our code (arbitrary clients inserting rows directly into Turso) are
covered by the poll/sweep alone — by design, since Turso offers no reliable
on-write notification (§1.3).

### 3.4 The backend abstraction (SQLite/Turso, MySQL, Postgres)

The core engine is dialect-independent TypeScript emitting per-dialect SQL through
a small interface — the shape River uses (per-dialect SQL files, logic client-side):

The normative interface surface is §3.9's five ports (SchedulerStore, Launcher,
EndingFeed, RunStateStore, WakeSignals) — this section defines the SQL contract
rules and the dialect mapping every SchedulerStore/RunStateStore implementation
must obey. (An earlier draft carried a second interface listing here; it drifted
and is deliberately deleted — one normative surface.)

Contract rules every dialect must obey (these came out of adversarial review and
are load-bearing):

1. **Fenced batches, keyed on the post-state.** Batches are atomic but
   unconditional (no control flow, no early return) — and statements see the
   effects of earlier statements in the same batch, so a later statement must
   NOT re-check the pre-condition the first statement just consumed. The
   pattern: the FIRST statement is the guarded CAS transition
   (`… WHERE run_id=:r AND state='running' AND claimed_by=:token`), and every
   later mutation keys on the post-transition state plus the winning
   statement's per-invocation provenance stamp
   (`… WHERE run_id=:r AND state='failed' AND fence_stamp=:seed:cas`). A
   stale actor's whole batch then matches zero rows on statement one and zero
   rows on every follow-on. Where a partial effect would still be corrupt, add
   an abort-sentinel statement that deliberately errors (CHECK violation) when
   the guard fails, rolling the batch back.
   Successor replay identity is the immutable triple `(run_id, task_id,
   attempt)`. An existing row may suppress a successor insert or its terminal
   alternative only when all three fields equal the intended successor;
   collision with the parent, a historical attempt of the same task, or a
   foreign task must abort the whole transition. The schema's unique
   `(task_id, attempt)` key makes two attempts of one task unable to claim the
   same ordinal.
   Run ownership is total: every run names an existing task in the same queue.
   Spawn therefore admits its task insert only when no pre-existing run already
   names the newly minted task id. Losing that ownership guard aborts with no
   task or run written; it may never create a task after an orphan run and then
   report a different, never-inserted run as the receipt. Its receipt has two
   closed queue-scoped legs: the task-id leg may return only the inserted task,
   and otherwise the idempotency leg may return only the same-queue winner. A
   foreign task-id collision with no same-queue winner is an unexplained loss
   and aborts rather than becoming a receipt.
2. **`awaitEvent`/`emitEvent` must be atomic AND mutually exclusive.** The
   read-branch-write shape across client round trips loses the wakeup if emit
   interleaves (emit flips waiters exactly once). Realization is per dialect:
   on SQLite/Turso, ONE batch with the branch folded into WHERE guards
   (sentinel insert; register wait `… WHERE (SELECT payload FROM events WHERE
   name=:e) IS NULL`; sleep the run under the same guard; checkpoint `… WHERE
   payload IS NOT NULL`; final SELECT tells the SDK which branch won) — the
   single writer serializes it. On Postgres/MySQL a batch is NOT serialized
   against emit: use a short transaction taking Absurd's original row locks.
   `FencedBatch.lockEvent({ queue, eventName })` carries only that closed lock
   coordinate — never caller SQL — to the dialect executor, which acquires it
   before the first fenced CAS and holds it through commit or rollback. The
   executor binds both coordinate values as data, returns no result slot for
   the prelude, and matching event coordinates are mutually exclusive. A
   dialect may realize the coordinate with a durable sentinel row. Any further
   row locks retain the documented order: event first, then run (FOR
   SHARE/FOR UPDATE). The timeout branch is part of the contract: a wait with
   a timeout sets `available_at = timeout_at`; a claim returning `wake_event` with NULL
   payload is the TimeoutError path, and that claim batch deletes the wait row
   so a later emit cannot resurrect a timed-out wait. The SDK snapshots and
   validates the optional timeout once before this atomic call; the store never
   receives a second read from user-owned option state. That run-level NULL is
   protocol branch state, not an event fact: an emitted `events.payload` must be
   stored as TEXT. A SQL NULL or other non-TEXT event payload is corruption and
   fails closed; it may never be decoded as the legitimate timeout sentinel.
   A timer suspension replaces an event registration: `reschedule` and
   `suspendRun` delete every wait belonging to the run their suspension CAS
   stamped, in the same batch. Cancellation likewise deletes waits through
   the `run_id`s of the runs its follow-on actually cancelled, never through
   the denormalized `waits.task_id`; a corrupt mirror cannot redirect
   ownership.
   **A wake needs ONE wait row that justifies it, and the cleanup follows the
   wake.** Emit selects waiters from `waits`, a table its batch never wrote,
   so it is the one place the fence cannot decide which rows may be written
   and a hand-written predicate does. Two obligations follow. First, a run
   wakes only if a SINGLE row says all of: it belongs to this run, in this
   queue, for this event, still waiting, at the run's `wake_step` (or the run
   has none — parks predating the column match any step), with
   `timeout_at_ms` equal to the run's `available_at_ms`. Where an index-driver
   subquery is split out for the query plan, every condition on it must also
   appear on the witness, or the two are answered by different rows and the
   pair accepts what neither row would. Second, the cleanup deletes the
   registrations of the runs the emit WOKE, never every registration naming
   the event: those two sets are kept equal by nothing, and no later emit is
   guaranteed to repair a registration whose evidence was deleted. A
   registration the emit declines therefore survives, where
   `wait-for-fired-event` names it as the lost wakeup it is.
   Before claim or emit consumes a pre-`wake_step` registration whose run
   still has `wake_step = NULL`, it copies the exact `step_name` from that same
   full witness into the run. The decoder never infers a step from the event
   name: one task may await the same event at several replay keys.
3. **Engine time is database time.** All absolute timestamps are computed in SQL
   (`unixepoch('subsec')` / `NOW(6)` / `statement_timestamp()`); clients pass only
   relative durations. User-supplied absolutes (`sleepUntil`) are the only
   exception. A wake union selects `{inSeconds}` versus `{atEpochMs}` only with
   a captured own-property check, once per consumer; inherited `inSeconds`
   never converts an absolute wake to a relative one. Each store suspension
   consumer prepares one wake snapshot that supplies its SQL expression,
   arguments, and epoch-headroom guard. Relative and absolute wakes are two
   representations of the same `reschedule` or `suspend` transition, not two
   label variants: within a dialect they use one ordered statement inventory,
   SQL text, and bind arity, with only bind values selecting the mode. More
   generally, a declared batch-label variant has one compiled signature;
   genuinely different transition branches must be named or declared as
   separate variants rather than hidden in representation-dependent SQL.
   **The clock expression must be at least statement-stable**: every occurrence
   within one statement — including inside a scalar subquery — must yield the
   same value. Measured: SQLite `unixepoch('subsec')` is (4000/4000 identical);
   MySQL `NOW(6)` is (it is the statement's start time), and `SYSDATE()` is NOT;
   Postgres `statement_timestamp()` and `now()` are, and `clock_timestamp()` is
   NOT — it re-reads the wall clock per call, so a single statement using it
   twice can write two different instants. An earlier draft of this rule named
   `clock_timestamp()`, which would have made rule 8 unsatisfiable on Postgres.
   Stability does NOT extend across statements: the same expression in two
   statements of one batch differs about 2% of the time on local SQLite (94 of
   4000 measured) and far more over a network, which is what rule 8 exists for.
   Database ownership of the clock does not exempt it from the numeric
   contract. Every engine instant is an exact native integer in
   `[0, MAX_EPOCH_MS]`, and every persisted relative duration is an exact
   native integer in its field's duration domain. Before writing `now + delta`,
   the authoritative statement proves both the instant and every delta valid
   and proves `now <= MAX_EPOCH_MS - sum(delta)`. This applies to all fourteen
   derived-deadline sites: spawn delay and cancellation, claim and activation
   leases, activation max-duration, heartbeat, both sweep successors, driver
   heartbeat, both suspension APIs, user retry, checkpoint extension, and
   event timeout. A terminal arm that derives no successor remains legal at
   the ceiling; an irrelevant future deadline may not prevent quiescence.
   Persisted timestamp consumers enforce the same exact field contract at the
   door that consumes it: before an ordered `LIMIT`, again at a winning CAS
   after an advisory scan, and before copying or comparing it into another
   durable value. A negative or over-ceiling deadline therefore cannot starve
   healthy work, become due through comparison, or be laundered by a write.
   Driver heartbeat is one atomic, one-statement transition for this purpose:
   its upsert and expired-row cleanup derive from the same statement-stable
   instant. If its derived expiry is unrepresentable, neither the heartbeat row
   nor its cleanup may change. Cleanup also validates the stored last-beat and
   expiry fields of both its source heartbeat and each deletion candidate;
   corrupt observability rows are refused, not compared into authority or
   deleted. `expireLeaseNow` likewise consumes only a native integer expiry
   that is within range and strictly after the statement's instant; an invalid,
   fractional, or already-expired value may not be rewritten into validity.
4. **Claim is a fenced batch, not a lone statement.** It has two identities:
   `claimed_by = :claim_token` is the durable lease and idempotent receipt,
   while the FencedBatch invocation seed gives the claim CAS its fresh
   per-statement provenance stamp. Mutating follow-ons update tasks and delete
   expired waits strictly through the claim CAS stamp, never through the
   durable token or a re-computed candidate set. The final receipt read uses
   `claimed_by = :claim_token` as its durable identity rather than the CAS
   stamp: a same-token retry claims nothing new and returns the original
   selection (guarded by "no running rows already carry this token"), so a
   lost response cannot multiply the claim bound.
   Multi-writer dialects serialize `(queue, claim_token)` before candidate
   selection with `FencedBatch.lockClaim({ queue, claimToken })`. `SKIP LOCKED`
   candidate rows are not that serialization: simultaneous retries can lock
   disjoint candidates before either token becomes visible, multiplying one
   logical receipt. The closed claim coordinate is acquired before the claim
   CAS and held through its receipt read. PostgreSQL realizes that lock as the
   transaction-scoped expression
   `pg_advisory_xact_lock(hashtextextended(jsonb_build_array(current_database(), current_schema(), 'durablerun:claim', $1::text, $2::text)::text, 0))`:
   the database, schema, fixed domain tag, queue, and token determine one
   server-computed key; collisions only over-serialize. The executor binds the
   coordinates, discards the prelude's void result, and runs the claim SQL on
   that same client and transaction, so commit, rollback, or disconnect
   releases the lock without durable sentinel garbage.
   The candidate set also excludes tasks whose cancellation deadline is
   already due — a sweep budget too small to cancel everything this pass must
   not leak due-to-cancel tasks into launches. All claim eligibility—live task,
   sole live run, and unambiguous carried wait—must be applied inside BOTH the
   pending and sleeping ordered candidate legs before each `LIMIT`. A late
   outer join or filter is not equivalent: an earlier corrupt row can consume
   the bounded budget before being refused and permanently starve later
   healthy work. Durable worker payload admission is field-specific and shared:
   `durableTaskRetryAdmissible` and `durableTaskHeadersAdmissible` both gate
   each ordered candidate leg before its `LIMIT`, the same-token receipt before
   it returns durable authority, and the activation CAS before it latches the
   generation. Only after those store doors win may the captured parser decode
   retry and headers; a stamped tail is not a substitute for gating the CAS.
   Those durable guards are corruption backstops, not an alternate ingress
   contract: successful spawn already admits the same object-of-strings header
   domain before SQL.
   Every newly claimed or
   receipt-returned run must also be the task's sole live run: the canonical
   `soleLiveRun(run)` eligibility fragment gates both the candidate CAS and the
   final `picked` receipt tail. It rejects every run with another live sibling,
   so a corrupt multiple-live-run task is refused rather than double-launched,
   including when corruption appears between a successful claim and its
   same-token retry. The activation CAS is the third door and composes the same
   fragment: a live sibling appearing after claim but before activation
   invalidates the issued launch. The task-book follow-on derives
   `last_attempt_run` with the shared portable singleton aggregate
   grouped on `f.task_id`, which its predicate equality-fixes to the task; even
   if the sole-live guard regresses, every dialect observes the same
   non-singleton outcome rather than choosing an arbitrary scalar row. The
   shared builder pairs every aggregate `HAVING` with that fixed-key `GROUP BY`,
   and every current claim singleton projection uses it: remote Turso rejects
   ungrouped aggregate `HAVING` even though local libSQL accepts it.
5. **Checkpoint writes are lease-fenced in both placements.** Inline: the upsert
   joins the run-row guard (`claimed_by=:token AND state='running'`) — same DB,
   free. Dedicated: `heartbeat` CAS on the scheduler first (zero rows = lease
   lost = abort, the AB002 equivalent), then the token-fenced run-DB write
   (§3.8). Attempt/owner guards remain as tiebreakers, never as the fence.
   The fence binds the FULL argument surface — run id, task id, queue, AND
   token; a mismatched task id is a fence loss, never a write. LWW semantics:
   `ON CONFLICT DO UPDATE … WHERE excluded.owner_attempt >= owner_attempt` —
   a lower-attempt writer under a still-valid lease is silently dropped (its
   lease still extends); replay determinism, not error, is the goal.
   Any CAS whose follow-ons copy or derive an owner/ordinal from the stored
   run attempt first requires that attempt to have the dialect's native integer
   representation. A corrupt value refuses the whole suspend or sweep batch;
   it may not park without its checkpoint or be coerced into a successor.
6. **Terminal tasks are inert (TerminalStability, executable form).** No
   transition may mutate a terminal task's state, and none may create or
   revive a live run under a terminal task — even from externally corrupted
   state, transitions must not AMPLIFY divergence. Concretely: every
   task-mutating statement carries a `state IN ('pending','running','sleeping')`
   guard; run-REVIVING CASes (reschedule's suspend, the sweep's lost-launch
   reopen, heartbeat's extension, checkpoint's lease extension, successor
   inserts) additionally require the owning task live; run-TERMINALIZING
   CASes (complete/fail/sweep failure) stay valid under a terminal task —
   they only quiesce. When the owner task is still live, `complete`, `fail`, and
   the sweep relaunch-cap arm may terminalize it only if the winning run is its
   sole live run. An already-terminal owner may still let a matching live run
   quiesce, because that cannot amplify task state. A refused suspension
   surfaces as AB002.
7. **Client numbers are validated at the port; SQL never multiplies them.**
   Every relative duration crosses the boundary through `durationToMs`
   (finite, ≥ 0, rounded to integer milliseconds, ≤ 100 years; leases and
   extensions require ≥ 1ms), absolute instants through `requireEpochMs`
   (safe integer, ≤ year 9999), counts through `requirePositiveInt` — all
   throwing RangeError BEFORE any SQL executes. Rationale: drivers bind JS
   numbers as REAL and INTEGER columns are affinity, not enforcement — an
   unchecked Infinity is an unexpirable lease, an unsafe integer poisons
   later reads with a driver RangeError, and a fractional product silently
   breaks the integer epoch-ms contract. Durations stored in JSON
   (`cancellation.maxDurationSeconds`) are validated at spawn and revalidated
   when consumed from durable JSON. Their SQL conversion implements the same
   rounded-millisecond result as `durationToMs`; a seconds value slightly above
   the nominal seconds quotient is legal when rounding still yields exactly
   `MAX_DURATION_MS`, while a value whose rounded result exceeds the ceiling is
   refused. The administrative `fake_now` seam is a port too:
   `setFakeNowEpochMs` crosses `requireEpochMs` before any metadata write.
   Integer values are canonicalized at the dialect boundary before shared
   decoding. PostgreSQL `int8` values inside JavaScript's safe-integer range
   become numbers, preserving the ordinary protocol representation shared
   with libSQL; exact values outside that range remain bigint so corruption
   and bound checks retain full evidence. A decimal string or lossy Number
   conversion never crosses the integer port. The dialect-neutral
   `decodeBoundedInteger` boundary then enforces each field's semantic bounds
   before the value becomes engine state. Run
   ordinals have the distinct exact ceiling
   `MAX_RUN_ORDINAL = MAX_COUNT + INFRA_RETRY_CAP`, because they count both
   user attempts and infrastructure successors; all other durable counts use
   `MAX_COUNT`.
8. **Write provenance is a column, never a borrowed one.** Every table a CAS
   targets — `tasks`, `runs`, `waits`, `events` (the contract list, `core`'s
   `FENCED_TABLES`) — carries `fence_stamp TEXT` and `fence_at_ms INTEGER`.
   A batch mints one seed; each stamp-writing statement writes
   `<seed>:<statement name>`, together with the ONE instant that statement
   read, into `fence_at_ms`. Every later statement in the batch filters on
   that stamp and derives every instant it needs from `fence_at_ms`. Rule 1
   says a follow-on keys on the post-transition state *plus the batch's own
   stamp*; this rule says where the stamp LIVES, and it exists because the
   answer used to be "some column that already meant something else" —
   `runs.claimed_by` (the worker's lease) and `tasks.failure_reason` (a
   user-visible string). A borrowed column can be written by something other
   than this batch, so a follow-on keyed on it fires for a stale or
   duplicated caller; that is not a coding mistake to be avoided but the
   direct consequence of having nowhere correct to write.
   Three consequences are contract, not implementation detail:
   *(a)* the stamp names a STATEMENT, not just a batch. One stamp per batch
   aliases across its statements, and a follow-on asking "does the row at
   this id carry my batch's stamp" can then be answered by a *different* row
   the same batch stamped — which is how a failing run whose successor id
   collided with its own impersonated that successor. Statement names obey
   the one contract grammar `[a-zA-Z0-9_-]+`; the builder and the persisted
   provenance evaluator import that same definition, so an invalid suffix
   cannot be accepted by one representation and emitted by the other.
   *(b)* a follow-on may not read the clock at all. It has `fence_at_ms`, so
   the class of bug where two statements of one batch disagree about "now"
   has no remaining legal instance to hide in.
   *(c)* every generated UPDATE follow-on writes its own stamp and copies the
   instant from its earlier fenced source. When later statements use an
   intermediate statement stamp as an execution capability, the batch
   consumes it after the final dependent by re-stamping those source rows at
   the same source instant. A delayed exact replay then cannot borrow work
   that the first execution left behind. A first-write-wins fact may acquire
   a fresh invocation's stamp, but its `fence_at_ms` stays the immutable
   instant at which the fact first became true. The exception is enumerated
   in the dialect-neutral contract, not supplied as SQL by a caller: the only
   preserved fact instant is `(events, emitted_at_ms)`. An events upsert
   conflict arm re-stamps `fence_stamp` while copying
   `events.emitted_at_ms`; `$NOW$` and every other column are illegal there.
   Adding another exception requires extending that enumeration and its
   rejection tests. Its ordinary assignments are generated from a closed
   per-table list of left-hand sides; callers provide scalar right-hand sides
   only. Provenance columns and public primary identity are absent, so quoted
   identifiers, duplicate assignments, and `runs.run_id` cannot compete with
   the primitive's writes.
   *(d)* generated follow-ons traverse one of the contract's closed logical-key
   relations: `runs.task_id → tasks.task_id`, `runs.run_id → waits.run_id`,
   `tasks.task_id → runs.task_id`, `waits.run_id → runs.run_id`, or the exact
   self relation `runs.run_id → runs.run_id`. Callers name the relation; they
   cannot spell either key independently. Queue policy is part of each closed
   entry: runs→tasks, tasks→runs, and waits→runs require queue equality;
   authoritative runs→waits cleanup deliberately ignores the wait's corrupt
   denormalized queue; and the exact runs→runs self relation needs no additional
   queue comparison. Construction also requires the
   named fence to have stamped the relation's source table, and sealing
   requires both source table and logical key to be identical. A
   `rows: 'source-keys'` follow-on is therefore bounded structurally: its
   distinct target keys are a subset of the stamped source keys, while several
   physical target rows may share one key. This is a construction property,
   not a count query checked after commit. Self-source reads are wrapped in a
   non-mergeable `DISTINCT` derived table so the identical generated shape is
   legal for MySQL updates as well as SQLite and Postgres. Raw
   `{ many: reason }` remains only for emit's `wake-runs` pending the active
   wait identity in PR3.8.
   The columns are nullable, unindexed, and never a lookup key — a stamp is
   only ever a filter, and every fenced statement is anchored by a primary key
   or an existing index. Rows written before the provenance migration read
   NULL, and NULL never equals a stamp, so no fence can match one.
9. **A schema version is an exact fact, not a coercible hint.** The stored
   `schema_version` wire form is a canonical nonnegative base-10 safe integer:
   `0` is the only zero form and no positive value has a leading zero.
   Migration reports success only when the recorded version equals the
   binary's current version exactly; malformed, negative, unsafe, and future
   versions fail closed. Only an actual absent metadata table means a fresh
   database at version zero. The dialect adapter alone classifies the canonical
   singleton version read's native missing-metadata error as
   `SchemaNotInitializedError`; admin catches that type, never rendered text.
   Validation of a returned row happens outside the read-error catch, so stored
   text—even text identical to a missing-table diagnostic—or an unrelated
   executor failure cannot enter the fresh-database path. Once metadata exists,
   the version read returns exactly one result containing exactly one row;
   zero, missing, or duplicated result/row shapes are schema mismatches, never
   version zero. `migrate()` performs that typed read before issuing any
   bootstrap DDL; only its explicit absent-metadata result authorizes
   `CREATE meta` and the version-zero insert. `CREATE IF NOT EXISTS` is not
   evidence of freshness and may not relabel an existing empty metadata table.
   Concurrent cold-start migrators converge: after an error from bootstrap or
   a versioned migration batch, the loser re-reads the authoritative version
   and treats the write as complete only when metadata now exists at or beyond
   that batch's target. An absent or behind version rethrows the original
   failure; `IF NOT EXISTS` alone is never the concurrency mechanism.
   Malformed dialect-returned values are described only by non-coercive storage
   kind; diagnostics may not invoke serialization or user hooks and change the
   permanent `SchemaMismatchError` classification.

**Fence-loss (AB002) contract:** `complete`/`fail`/`reschedule`/
`setCheckpoint` throw `LeaseLostError` when their CAS matches zero rows;
`heartbeat` reports `held: false`. A worker retrying `complete` after a lost
response treats `LeaseLostError` as possible-prior-success: verify via
`getTaskResult` and exit (verify-then-exit), never re-execute.

**Event-wake disposition:** a carried wake (`wake_event`/`event_payload`) is
CONSUMED by the transition that ends the attempt that processed it
(`complete`, and `reschedule` with the default `'consume'`); it is CARRIED to
failure successors (`fail` retry, sweep claim-timeout — §3.8.2, the attempt
never processed it); it is PRESERVED by §3.8.2 deferral (`reschedule` with
`'preserve'` — a driver that cannot dispatch the task consumes nothing).

**Structural enforcement (the mechanisms behind the rules).** The contract
rules above started as review checklist items; each now has a mechanism
that makes its bug class unwritable or machine-caught, so compliance does
not depend on careful reading:

- *Eligibility fragments* (`store-*/src/fragments.ts`): what "live",
  "cancellation due", "sole live run", and "eligible to proceed" mean is
  spelled once per dialect; every door composes the fragments, and a lint in
  the verify gate fails any store source containing an eligibility comparison
  or raw state list elsewhere. A door cannot carry a stale copy of a predicate
  it cannot spell. Claim has one `candidateEligibility` composition—live task,
  sole live run, and unambiguous wait—inserted into both state legs before
  their per-leg limits. Shared conformance pins bounded progress; the libSQL
  query-plan suite records the shipped CAS rather than a hand-written stand-in
  and pins its indexed scans and sibling probes.
- *Opaque launch outcomes* (`core/launch.ts`): a launcher's report has no
  readable fields; the only affordance is `LaunchOutcome.reconcile`, which
  owns parsing, exact `(runId, claimToken)` identity checking, and the single
  advisory-expiry door. A mismatched or tokenless ending makes no write.
  Authentication is a module-private WeakMap, not `instanceof`, an instance
  field, or a TypeScript-private class property. Construction snapshots each
  untrusted ending field exactly once inside a non-throwing guard, validates
  the complete payload, and copies it; forged prototypes, throwing/changing
  getters, and malformed payloads become `launch-failed`. Trusting a report's
  content is a compile error, not a review catch.
- *The generated fault matrix* (`conformance/src/fault-matrix.ts`): every
  batch label, harvested from source by the same script that checks the
  spec ledger, is classified write/read/exempt — a new label fails the
  build until classified, and classification enrolls it against
  crash-before, crash-after, and duplicated-request faults automatically,
  with invariants, the claim QUANTITY bound, and a post-fault progress
  probe asserted. Cap-edge seeds use a non-first claim generation, and when
  the trace shows their transition reached the database the matrix requires
  the exact task/run post-state — observing a label without crossing its
  seeded edge is not coverage. Fault coverage is enumerated, never curated.
  Dialects enter through the central fixture registry and one
  `storeConformance` umbrella, which always enrolls scheduler, fault, poison,
  timestamp-boundary, generated wake-witness, and schema/admin behavior; a
  backend cannot select only the cheaper sub-suites. The schema/admin surface
  starts from both current and genuinely uninitialized fixtures, injects the
  dialect's real admin over hostile result/error executors, and executes the
  dialect's catalog statements through the fixture's real raw executor.
- *The invariant condition inventory and poison matrix*
  (`conformance/src/invariants.ts`, `poison-matrix.ts`): invariant evidence is
  one dialect-neutral read batch whose result cardinality is exact and every
  slot/column is validated; a missing or malformed result is an error, never
  an empty table. The poison snapshot's one closed descriptor owns all six
  protocol/bookkeeping table names, their stable order, and every required
  identity/ownership column. A row missing an authority column is rejected
  before keys are constructed. Dialect adapters expose exact integers as
  safe numbers or bigint, which the evaluator compares canonically without a
  lossy Number conversion. For invalid native representations, the fixture
  prepares a nonempty dialect statement and a narrow native-error classifier;
  the shared runner alone executes the attempt through the raw executor. A
  permissive store must verify the injection, while a strict schema receives
  `structurally-rejected` credit only after an observed attempted write raises
  the classified error. A fixture cannot return evidence by assertion.
  TypeScript evaluates
  one of 109 typed condition IDs for every semantic arm. The eight durable
  counters and 23 temporal fields are decoded totally through core's
  bounded decoder: a non-integer storage representation and an exact-but-
  out-of-range value emit distinct typed findings and suppress dependent
  arithmetic instead of aborting the invariant pass. Run→task existence and
  queue ownership are checked explicitly. One frozen temporal inventory covers
  all 23 `_ms` fields across tasks, runs, checkpoints, events, waits, and
  drivers, derives the public condition/witness identity from the nominal
  `table.column` bounds identity, records each field's epoch/duration kind and
  exact nullability, and
  generates both temporal conditions, the six-table snapshot projection, and
  three witnesses per field: invalid storage, one below the lower bound, and
  one above the upper bound. The shared schema/admin surface discovers every
  native integer column across those tables and compares the exact
  field/64-bit-width/nullability vector to the union of eight counter
  descriptors and 23 temporal descriptors: all 31 durable integers are
  enrolled without relying on a name suffix. Catalog SQL remains
  dialect-owned—libSQL projects real `PRAGMA table_info` rows—but the shared
  runner executes, validates, and compares the evidence.
  Snapshot results are assembled by each projection's declared table key,
  never by a second hard-coded positional table list.
  Generated just-over-bound witnesses, along with the ownership witnesses,
  keep the poison matrix complete. The poison surface crosses the 17 classified
  write labels with 139 atomic corrupt-state witnesses covering that exact
  condition inventory: 2,363 generated cells,
  plus two inventory cases. Every injectable witness invokes its label; a
  strict dialect may instead produce an observed `structurally-rejected`
  attempt before invocation, the stronger result that the forbidden pre-state
  is unwritable. Each invoked
  cell freezes structured tuple keys for a protected pre-operation population
  across every protocol/bookkeeping table, permits new rows only through
  explicit complete ownership tuples, and rejects writes outside before-state
  authority, new violations, live-run amplification, and worsening hidden
  behind the same condition and structured subject. Severity is exact numeric evidence,
  including absolute wait-deadline divergence and the span of instants under
  one provenance seed.
  A label proves progress only when a semantically healthy transition wins
  and its individual store call produces a durable delta in the exact
  six-table snapshot. State change, not SQL spelling or returned row count, is
  the property: dialect DML beginning with a CTE counts, while SELECT rows and
  no-op DML do not. The `cardinality/two-live-runs` claim witness is already
  due, and exact behavioral mutations remove the sole-live guard from the
  candidate CAS and receipt tail, so that generated cell cannot be satisfied
  solely by an unrelated healthy delta or a stale same-token receipt. A
  separate post-claim/pre-activate regression and exact mutation attack the
  activation door; the generated `activate × two-pending-runs` cell alone
  cannot prove that temporal placement because its target is not claimed.
  Emit's one atomic exception is keyed to condition
  `wait/fired-event` and the exact structured poisoned-run component; display
  names cannot widen it. Counting names, delimiter-joining keys or findings,
  observing that a label was called, or deriving authority from the
  after-state are prohibited proxies. Sixteen adversarial oracle meta-tests
  attack these distinctions.
- *Timestamp-domain construction and consumption* (`core/src/validate.ts`,
  `store-*/src/fragments.ts`, and the mandatory timestamp conformance surface):
  the 23-field inventory above is the sole persisted temporal representation.
  Fixed-field fragments own due/not-due comparisons, and one
  `epochAdditionFits` constructor owns derived-epoch headroom. Each delta
  expression appears exactly once in the generated predicate, so an anonymous
  SQL placeholder consumes one argument rather than being duplicated by a
  textual helper. The conformance registry enrolls the timestamp surface as a
  peer of scheduler, fault, poison, and wake-witness coverage; nesting it
  inside another suite is not enrollment. Fourteen exact-ceiling/overflow
  pairs, bounded-discovery and post-scan interpositions, all four next-wake
  sources, direct copy/compare consumers, fake-clock inputs, terminal-arm
  controls, rounded-duration parity, and driver-cleanup atomicity pin the
  contract independently of the global invariant.
- *Attributable mutation verdicts* (`scripts/mutation-probe.py`): every
  mutation names the exact behavioral or construction assertion that must
  kill it — test file, full test name, and marker in its failure. Compilation
  or bind failure, a different assertion, any suite-level error, malformed or
  internally contradictory structured output, process/report disagreement,
  or any other wrong path receives no credit. A marker matches only the
  structured failure diagnostic's first line: bare, `Error: <marker>`, exact
  `AssertionError: <marker>`, or `AssertionError: <marker>: …`; its appearance
  later in rendered assertion source is not evidence. One mutation condition
  has one decisive assertion owner: broader controls may remain in the test,
  and that owner must emit exactly one attributable failure message. Other
  failed tests may accompany it only in a coherent, clean-baseline-backed
  result with complete diagnostics: this is `caught-with-collateral`, counted
  separately from exact-only `caught`. Missing/wrong owners, suite errors,
  missing collateral messages, and ambiguous owner messages remain blocking.
  Both
  `FencedBatch` compiler bind exits use one
  module-captured `TypeError` factory and private brand. The three canonical
  promise helpers propagate that brand before consulting a caller matcher, so
  an argument-count or explicit-undefined failure cannot be laundered into an
  exact semantic marker. An exact mutation deletes the private-brand read
  itself, independently of both branded producers. Raw question-token
  reconciliation is only a cheap source alarm; an executed equal-count
  cancellation case defines its limit. A canonical-CLI injected fault withholds
  all question-delta reasons in one live-inventory traversal and requires an
  aggregate refusal; it proves enrollment is not a removable second call, not
  each declaration independently.
  The verify gate runs 24 classifier cases, nineteen promise-message source
  cases, ten canonical helper-descriptor cases, two helper-binding cases,
  three helper-marker cases, sixteen direct-marker cases, three title-owner
  cases, six verdict-inventory cases, seven question-delta cases, eleven
  mutant-syntax cases, and four live-enrollment attacks across all 423 live
  mutations. A separate generated coordinator surface injects 40 faults
  covering shard omission and overlap, wrong heads, missing/duplicate/extra
  results, process/report disagreement, and non-owned cleanup targets, plus
  unconfined execution, an unowned worker,
  a skipped baseline barrier, an external workspace link, malformed identity
  types, an interruptible cleanup, an orphaned descendant, oversized finite
  memory and CPU ceilings, missing/malformed/signaled suite transport, and false
  infrastructure-success classifications. An additional 18-fault routing
  surface exercises the exact Vitest/typecheck baseline order, fail-fast
  behavior, mutation dispatch, and registry-digest authority. Session-state
  evidence classifies
  Linux `Z`, `X`, and `x` through one `TERMINAL_PROCESS_STATES` definition and
  one `process_is_gone` decision for the initial observation, failure rechecks
  after owner, argv, and cwd phases, and the final-identity observation; a
  generated phase matrix attacks each transition.
  The parser requires all nine
  aggregate counters to be nonnegative integers and internally consistent
  within their reporter domains. Test counters match test rows; each file
  status matches its own assertion/message rows; suite counters are not
  equated with file counts because the reporter does not expose that topology.
  Every status is type-checked before classification. A full audit binds itself
  to one clean committed head, assigns every selected registry entry exactly
  once in deterministic order, and runs each shard in a detached worktree at
  that exact head. Every worktree gets an isolated frozen pnpm link farm whose
  workspace packages resolve inside that worktree; sharing the source
  checkout's `node_modules` could silently test unmutated code. All worker
  baselines must pass before any mutation begins. The aggregate rejects a
  wrong head or registry, missing/duplicate/extra/malformed result, incomplete
  worker, or process/report disagreement. A missing, malformed, or signaled
  Vitest report is transport failure and cannot become a domain verdict. The
  coordinator and all raw Vitest children share one `scripts/confine.sh`
  scope, with Vitest workers divided across shards; the live scope must cap
  memory at no more than 75% of host memory, disable swap, and preserve the
  host CPU reserve. Per-suite scopes are prohibited because their independent
  memory ceilings would multiply. The source checkout is never mutated, and
  cleanup may remove only manifest-owned worktrees. The first full clean-tree
  audit classified 28 of 34 mutations as attributable and six as wrong-path;
  after exact-call
  construction wrappers, a single marked plan vector with a
  behavior-preserving mutation, a discriminating A/B wake witness, and
  explicit require/attribute failure helpers, that round's final audit
  classified all **37 of 37 as attributable**. The registry later grew to 50;
  its closing audit caught a promise verdict added outside the helper's
  original package that still relied on Vitest's lossy custom message. The
  promise helpers now have one package-neutral definition under
  `@durablerun/core/testing`, their success, expected-error, replacement-error,
  and unrelated-error arms have direct tests, and callers provide a structured
  kind/name descriptor from which only the helper can construct a canonical,
  undecorated marker. One TypeScript-compiler AST pass makes the verify gate
  refuse every custom-message argument on a direct Vitest
  `expect(...).rejects` or `.resolves` chain; compiler syntax owns nested
  parentheses, optional generics, relational expressions, methods, and
  constructors, while exact string-literal and helper-descriptor inventories
  exclude comments and decorated names. The separate lightweight source lexer
  preserves prefix/postfix state for TypeScript's non-null assertion so a
  following division slash cannot hide executable batch calls as regex
  contents. Verdict altitude follows the
  earliest load-bearing boundary, not the downstream scenario story; a
  construction wrapper encloses the exact call and exact error. Behavioral
  mutations preserve unrelated semantics, every multi-part verdict has one
  marked vector, and inverse promise outcomes use the shared helpers to emit
  the marker directly rather than relying on framework custom-message
  propagation. The mutation runner no longer imports its former
  repository-local Python parser; the executable lint self-test rejects any
  analyzer import artifact before a clean-tree audit can begin.
- *Duplicate-delivery in the model*: the spec models a retried request per
  labeled action, and the ledger tags each label's duplicate semantics
  ([cas-fenced] / [receipt] / [read] / [setup]), machine-checked — so a
  transition whose replay is NOT a no-op is a TLC counterexample at design
  time, not a production incident.


Dialect implementations:

| Concern | Turso/libSQL | MySQL 8 | Postgres |
|---|---|---|---|
| claim core stmt | `UPDATE…WHERE id IN (SELECT…LIMIT k) RETURNING run_id,…` (single-writer = no skip needed), inside the fenced claim batch (rule 4) | READ COMMITTED; token claim: `UPDATE…ORDER BY…LIMIT k` + `SELECT WHERE claimed_by=:token` (no RETURNING) | `FOR UPDATE SKIP LOCKED` CTE only (Absurd's SQL — the bare `UPDATE…WHERE id IN (subselect)` shape double-claims under concurrent EvalPlanQual re-checks) |
| atomicity | `batch(…, 'write')`; **never** interactive tx (5s cap) | short tx (READ COMMITTED) for every multi-statement transition — autocommit only for genuinely single-statement ops (20s PlanetScale cap is ample for 2–3-stmt claims) | normal tx |
| timestamps | INTEGER epoch-ms | BIGINT epoch-ms | BIGINT epoch-ms |
| hot index | partial index OK | composite `(state, available_at)` only | partial index |
| upsert | `ON CONFLICT` | `ON DUPLICATE KEY UPDATE` (any unique key!) | `ON CONFLICT` |
| ids | UUIDv7 client-generated (time-ordered; Absurd orders by run_id) | same | same |
| scale-out | DB-per-tenant/queue via Platform API (free, ~100ms create + ~2.5s data-plane readiness gate — see §5) | vitess sharding | partitioning (Absurd has it) |

Schema: Absurd's five tables essentially verbatim (`tasks`, `runs`, `checkpoints`,
`events`, `waits`), plus an observability-only `drivers` registry table, minus per-queue dynamic DDL (use a `queue` column + the hot
index instead; per-queue table-sets were a Postgres-partitioning affordance),
minus `'infinity'` timestamps (use NULL/sentinel max), JSON as TEXT for the lowest
common denominator.

State placement is two-plane (§3.8): the shard DB is the *scheduler plane* and
owns everything the engine queries **across** runs (tasks, runs/leases, waits,
events); a run's *progress* — checkpoints, run event log, streams — can live in
its own per-run SQLite (Cloudflare's Engine-DO shape) or inline in the shard DB,
per task type. Anything large (artifacts, transcripts, stream archives) goes to
object storage by reference regardless of placement. Conformance: one shared test suite (Absurd semantics: claim,
lease expiry, checkpoint replay, repeat counters, sleep, events first-write-wins,
event timeouts, cancellation, idempotent spawn — plus the review-derived
adversarial cases: duplicate launch delivery vs the activation CAS, zombie
complete after lease sweep, awaitEvent/emitEvent interleaving) run against all
dialects — SQLite in-memory/file in CI, Turso and MySQL as integration targets.

### 3.5 Vercel deployment shape (initial target)

- **App**: a Web `Request` adapter (Next.js App Router initially), Fluid compute
  on. The hosted-alpha surface is exactly `POST /api/tasks`, `POST /api/events`,
  `GET|POST /api/tick`, and `GET /api/inspect?taskId=...`; recognized paths with
  other methods return 405 and unknown paths return 404 without authorization or
  store work. Enqueue accepts `{taskName, params?, idempotencyKey?}` and returns
  the spawn receipt (201 when created, 200 on an idempotent replay); task names
  and idempotency keys outside the portable durable-string domain return 400
  before store I/O. Emit accepts
  `{eventName, payload?}`. Inspection returns the state plus the canonically
  decoded result/failure when present. Every response is stable JSON with
  `Cache-Control: no-store`. The checked-in external example fixes its Vercel
  install command to npm so the enclosing repository's pnpm workspace cannot
  suppress its release-asset dependencies.
- **Driver hosting**: the hosted alpha is fully serverless. Each accepted
  mutation gives the host a best-effort opportunity to run the same bounded
  inline tick, and an independent cron recovers a lost hint. Vercel itself
  cannot host the resident driver; a separately hosted resident driver,
  `/api/worker`, and detached HTTP workers are future placement options and are
  not part of the exact four-route alpha surface above.
- **Hosted authorization port**: task enqueue, event emit, tick, and inspection
  routes own the closed operations `task.enqueue`, `event.emit`, `tick.run`, and
  `task.inspect`. Before parsing or doing work, the router reads its body once,
  enforces a 64 KiB byte ceiling, and gives one required host-supplied function
  the request method, URL, a detached native `Headers` clone, and that exact
  decoded body text. The same text is parsed after authorization; the port never
  exposes a Node `IncomingMessage` or a consumable body stream. An explicit allow
  proceeds; unauthenticated/forbidden denials become 401/403,
  plugin failures become 503, and malformed decisions or unmapped operations
  become 500. All are fail-closed: there is no allow default. The driver supplies
  only a fixed-digest timing-safe Bearer adapter. JWT, platform signatures,
  multiple-scheme composition, per-operation policy, and worker launch signing
  remain ordinary host/transport code rather than policy baked into this port.
  A trusted host adapter may call the router's non-HTTP `runTick()` directly.
  The checked-in two-token example refuses construction when its API and cron
  credentials are equal, preserving the documented operation split.
  The checked-in hosted receipt accepts only an HTTPS base URL and validates
  it before constructing any request carrying either Bearer credential.
  After a successful enqueue or emit, an optional best-effort work-available hook
  can hand that promise to host lifecycle machinery such as `waitUntil`; hook
  throws/rejections never alter the already-durable mutation response, and cron
  remains the recovery path for a lost hint.
  These routes execute registered code and remain admin surfaces (lesson from
  §1.1: self-hosted worlds get no auth for free).
- **Hosted wake scheduling port**: optional `scheduleWake` receives one immutable
  `{queue, kind: 'immediate'}` hint when a completed tick reports backlog, or
  `{queue, kind: 'scheduled', atEpochMs}` from the database-computed next wake
  otherwise. An idle queue emits no hint. This is the same path for public
  authorized ticks and host-trusted `runTick()`. A scheduling failure propagates
  to the trusted caller (so queue delivery can retry) and returns a sanitized
  HTTP 503; it does not undo work already committed by the tick. Enqueue/emit
  acceleration retains its existing best-effort semantics. The host owns the
  initial kick, process lifetime, and independent recurring recovery trigger.
  Requests add deliveries; a delayed old request must never cancel a newer,
  earlier one. Do not deduplicate a fresh request against an already-fired
  message. Duplicate/reordered ticks remain safe through database fencing.
  `specs/WakeDelivery.tla` models this delivery/recovery layer separately from
  scheduler ownership. Its eventual-progress proof assumes fair time, delivery,
  and recurring recovery; it does not claim a wall-clock latency guarantee.
- **Cron sweep**: the unattended example invokes `/api/tick` every minute on
  the existing Vercel Pro project. The first alpha used a once-daily Hobby
  configuration; a Hobby host must keep that coarser fallback. Vercel cron
  issues **GET**, so `/api/tick` accepts GET (cron, `CRON_SECRET`) and POST
  (host-authenticated pings) alike. Cron is best-effort, never retried, and may
  double-fire; a missed invocation can exceed one period. The unattended
  receipt measures normal scheduled completion within 60 seconds of becoming
  due and repeats with its initial enqueue hint omitted, without issuing ticks.
- **Alarm adapter**: the example uses Vercel Queues `queue/v2beta`, with a
  provider-private callback that invokes trusted `runTick()`, not a fifth public
  route. It converts database due times to nonnegative whole-second delays,
  caps each delay at 23 hours with 24-hour message retention, and lets subsequent
  ticks rearm long sleeps. Messages contain only the queue hint, never execution
  authority. Receiver failure retries after five seconds with a 30-second
  visibility timeout; acknowledged callbacks may still duplicate.
  There is no resident timer, persistent alarm owner, or queue-wide replacement.
  Provider identity stays in the example; another host may supply any
  `WakeScheduler` with the same contract, independently of its auth plugin.
  The provider promises at-least-once delivery, not a 60-second SLA; see the
  [SDK](https://vercel.com/docs/queues/sdk) and
  [delivery/security contract](https://vercel.com/docs/queues/concepts).
- **Turso wiring** (per `~/remote-claw`, battle-tested): marketplace per-db creds
  (`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`) for the single-DB start; the fleet
  model (`TURSO_API_TOKEN`/`TURSO_ORG`/`TURSO_GROUP` + **`TURSO_GROUP_AUTH_TOKEN`**
  — deliberately not the integration-owned name) when sharding per-tenant.
  Idempotent DDL via `client.batch(DDL,'write')` memoized per client; the
  create→serve 404 race needs the `SELECT 1` readiness probe with backoff
  (~2.2–2.5s typical) before first use.
- **Observability**: scheduler tables are directly queryable; under `dedicated`
  placement the inspector follows the run row's run-DB pointer to join
  checkpoint/step history, so "why is run X stuck" is answerable across both
  planes from one `/api/inspect` (habitat-style read-only views later; WDK
  dashboards apply to Deliverable A only). Payloads note: params, checkpoints,
  and event payloads are stored plaintext in these DBs — treat them as
  secret-bearing, encrypt sensitive fields app-side if needed, and retention
  (`cleanup`) covers scheduler rows and run DBs alike.

#### Hosted consumer: PR-check watcher

The external example registers `watch-pr-checks`, a read-only GitHub consumer
over the unchanged SDK. Its input pins `repository` (`owner/name`), a positive
`pullNumber`, a full 40-hex `headSha`, and a nonempty `checks` list. A check-run
selector is `{kind: 'check-run', name, appId}`; a commit-status selector is
`{kind: 'status', name}` (case-insensitive context, with no publisher-identity
claim). Duplicate selectors are rejected. The host may supply a read-only
`GITHUB_TOKEN`; credentials never enter task parameters or checkpoints.

Each poll checkpoints one GitHub observation through `ctx.step('github-checks')`.
Pending observations suspend through `ctx.sleepFor`, so no worker stays alive
between polls. Replaying an interrupted invocation reuses committed observations.
`maxPolls` defaults to 10 and accepts 1–30; `intervalSeconds` defaults to 60 and
accepts 60–3600. These are poll/sleep bounds, not a wall-clock completion SLA.
Consecutive retryable observer errors back off exponentially up to an hour,
honoring a bounded server retry delay; a server delay beyond an hour ends this
watch as unavailable instead of retrying too early.
GitHub 403 responses without rate-limit headers are ambiguous: secondary rate
limits use that form too. They retain the `github-http-403` reason and retry
within the same budget without parsing error messages. Consequently a genuine
permission-related GitHub 403 also uses that budget before returning unavailable;
401/404 remain non-retryable. This does not change hosted endpoint authorization.

Both check runs and commit statuses use the exact SHA. The observer exhausts
pagination (100 rows/page, at most five pages per endpoint) and re-reads the PR
after the checks. A changed head terminates `superseded`; a closed PR terminates
`closed`. Every selected check must be present and successful for `ready`:
check runs match exact name and app ID, using GitHub's `filter=latest` with no
completed-only filter; statuses use the newest entry for their context.
Missing or ambiguous check runs remain pending. Completed non-success
conclusions (including neutral/skipped) and failure/error statuses produce
`failed`. An incomplete page sequence, unknown response shape/state, transport
failure, or HTTP error is an observer error, never evidence that CI passed or
failed. Exhausted polling produces `timed-out`, or `unavailable` if the final
observation could not be obtained.

The terminal task result retains the pinned input identity, poll count, latest
timestamped observation, verdict, and user attempt. A `failed` verdict is a
successfully completed watch whose selected CI failed, distinct from task
execution failure. `ready` means only that these selected checks were observed
successful for this SHA. It does not assert branch protection, all checks,
absence of a requested rerun, review approval, or mergeability. GitHub reads
are not an atomic snapshot; a later push/rerun may invalidate an observation.
The consumer never merges, emits notifications, or mutates GitHub.

### 3.6 Portability to a bare "launch this thing" platform

(E.g. an fcvm-based one — fcvm being our Firecracker-microVM launch platform; the
section applies to any system exposing a bare `launch(fn, payload)` primitive.)

The design intentionally reduces platform requirements to three verbs:

1. `launch(fn, payload)` — start a worker/driver now (HTTP POST suffices).
2. `launchAt(t, fn, payload)` — one-shot scheduled launch. If absent, emulate with
   (3) + coarser latency, or run one tiny alarm service (or a Cloudflare DO alarm
   as rented precision).
3. `cron(expr, fn)` — the sweep. Any external cron works.

Everything else is SQL against Turso. With a resident driver, only verb (1) is
strictly required — the driver owns the clock, and (2)/(3) exist as backstops or
for fully-serverless drive. Drivers and workers are stateless by construction, so
"N lightweight stateless drivers" is just running more of them — concurrency is
arbitrated in the database by the claim statement, exactly like N Absurd workers
against one Postgres, except our drivers dispatch heavyweight workers instead of
executing tasks themselves.

### 3.7 Sharding model (multi-DB)

Sharding is the scale-out answer to Turso's single-writer domain (§1.3), so the
drive model must be shard-aware from day one even if v1 runs one shard. (Shards
here are the *scheduler plane*; run-state placement layers on top — §3.8. A hot
queue can additionally split into hash-slices, each slice its own shard, since a
claim only ever needs its own slice — subject to the event-locality and
fairness constraints in §3.8's scalability paragraph.)

- **Registry**: a control-plane table (in a dedicated `engine-meta` DB, or any
  durable store) mapping `shard_id → {db name, tenant/queue set, status,
  version}`. `status` has semantics: `active` | `draining` (finish in-flight,
  claim nothing new) | `paused` (ticks skip entirely) — every tick reads its
  shard's status first, which is also the pause/quiesce mechanism for
  maintenance. DBs are named deterministically (`wf-<scope>-<shard>` per the
  remote-claw convention) and created idempotently via the Platform API with
  the readiness gate (§3.5). Registry writes are control-plane-privileged
  (drivers and operators only — tenant code never touches it); routing caches
  invalidate by TTL + the bumped `version`.
- **Drive**: assignment is leased **per driver, not per shard** — each resident
  driver maintains one heartbeat row carrying its assigned shard set (jittered
  expiry; on a driver death, survivors adopt at most M orphaned shards per
  tick — §3.8). One driver comfortably polls many shards since idle polls are
  read-only. In serverless mode the cron tick reads the registry and fans out
  one sub-tick per active shard (`waitUntil`-parallel), and alarm/ping dedup
  keys are `shard:t` — idle cost scales with active shards, not total shards.
- **Routing**: `spawn`/`emitEvent` resolve shard by tenant/queue through the
  registry (cached; events are shard-local — cross-shard signaling goes through
  `spawn` on the target shard).

### 3.8 Two-plane state: sharded scheduler plane, per-run SQLite data plane

The Cloudflare shape (§1.5, one SQLite per Engine DO) maps onto Turso as a
two-plane design. The rule for what goes where: **anything the engine queries
across runs is scheduler-plane; anything a run does between transitions is
data-plane.**

**Scheduler plane** — the shard DB (§3.7), holding small rows only: `tasks`,
`runs` (state, `available_at`, `claimed_by`, `claim_expires_at`, attempt,
`event_payload`, run-DB pointer), `waits`, `events`. All §3.1/§3.2 semantics —
fenced claims, leases, activation CAS, sweeps, `nextWakeAt` — live here
unchanged. This is the analogue of Cloudflare's alarm/routing substrate: it
answers "who may execute" and "who wakes when" with one indexed query.

**Data plane** — the run's progress: checkpoints, run event log, stream chunks.
Placement is pluggable per task type behind a `RunStateStore` interface:

- `inline` (default): tables in the shard DB — right for high-volume short
  tasks, where per-run DB lifecycle would dominate the work itself.
- `dedicated`: one SQLite DB per run (Turso Cloud DB, or a local file on an
  fcvm-style host) — right for long-lived runs, agents, and fat histories.
  This is the Engine-DO shape — but single-writer-per-run-DB must be
  **enforced, not assumed**: each run DB carries a claim-fence meta row; at
  activation (right after the scheduler CAS) the worker CASes
  `{claim_token, fence_key}` into it, and every subsequent run-DB write batch
  re-embeds `WHERE meta.claim_token = :mine`. The fence key is the pair
  `(attempt, claim_gen)` — `claim_gen` increments on every claim of a run row
  (§3.1 step 2) and successor runs carry a higher `attempt` (or, for
  lost-launch reopens, a higher `claim_gen` on the same row), so the pair is
  monotonic across a task's whole history; the CAS guard is `new > stored`
  lexicographically. The new holder's takeover thereby fences a partitioned
  zombie out of the data plane, shrinking the zombie window back to Absurd's
  documented brief overlap. Attempt/owner guards alone are insufficient here
  because chaining is attempt-neutral — a same-attempt straggler could
  otherwise clobber its successor. Checkpoint writes in dedicated mode are
  therefore: `heartbeat` CAS on the scheduler (zero rows = lease lost =
  abort), then the fenced run-DB write. One asymmetry to name: remote-Turso
  run DBs share the platform's durability; a **local-file** run DB (fcvm-style
  worker with embedded replica) only counts as "committed" for §3.8.2's
  ordering once its sync-back to Turso is acknowledged — the scheduler
  transition waits for the flush.

Why `dedicated` is worth having: (a) **the shared write bottleneck moves to
where it's harmless** — the shard DB scales with *transitions/sec*, not
*steps/sec*, since checkpoint traffic spreads across run DBs; (b) retention is
`DELETE DATABASE` instead of five-table row GC; (c) the run's entire state is
one portable SQLite file — on the target platform it can travel with the worker
(embedded replica: local reads/writes, background sync to Turso for durability),
a data-shaped equivalent of Trigger.dev's CRIU container checkpoints; (d) it is
Turso's own database-per-agent pattern, which the next-gen cloud (unlimited DBs
via REST) is explicitly built for.

Costs and the consistency discipline (there are **no cross-DB transactions**):

1. **Authority split.** The scheduler row is authoritative for *execution
   rights* (claim/lease/activation); the run DB is authoritative for
   *progress* (checkpoints, wake times as data). The scheduler shard is
   **primary state, not a rebuildable cache**: tasks (params, retry policy,
   idempotency keys, results) and events exist nowhere else, and inline-mode
   runs have no other home — so shards get durability treatment (Turso
   PITR/backups). Only leases, schedules, and waits are re-derivable by replay
   from run-DB checkpoints. Restore runbook: after restoring a shard to T₁,
   mark every non-terminal run's lease expired and let sweeps reconcile
   against run DBs; runs that completed after T₁ re-run (safe under activation
   fencing + checkpoint replay) — an accepted anomaly window, minimized by
   frequent PITR points.
2. **Write ordering.** Progress commits to the run DB first, then the scheduler
   transition (sleep/complete/fail). A crash between the two leaves the
   scheduler stale-but-safe: the lease expires, the sweep re-claims, and the
   next worker reads the run DB's checkpoints (including persisted wake times)
   and re-issues the scheduler transition idempotently. Accounting is decided
   by activation state, needing no other evidence: lost launches
   (`activated_gen < claim_gen`) reopen the same run — no attempt, no new row,
   their own capped relaunch counter; activated-but-dead runs cost an
   `infra_retries` increment (own generous cap), never `max_attempts` — which
   counts only user-code failures. Successor runs carry forward the run-DB
   pointer, `wake_event`, and `event_payload` on **every** path that creates
   one (the sweep and the worker-side fail-with-retry alike).
3. **Events never fan out into other runs' DBs.** `emitEvent` is scheduler-plane
   only: first-write-wins event row + flip waiting runs to pending with the
   payload parked on the run row (`event_payload`, as in Absurd's `r_` table).
   The woken worker materializes its own checkpoint into its own run DB on
   resume. Delivery is therefore durable-at-materialization, not
   durable-at-emit as in Absurd — so the undelivered window is first-class:
   the flip marks the wait row `delivered` instead of deleting it; the resuming
   worker deletes it in the same act as materializing (run DB first, then the
   fenced wait-delete — a crash between re-materializes idempotently); the
   sweep copies `wake_event`/`event_payload` onto retry runs; and event cleanup
   never GCs an event row with outstanding `delivered` waits. Ordering per
   branch: on the already-emitted branch the payload checkpoint goes to the
   run DB first, then the fenced scheduler ack; on the not-yet-emitted branch
   there is nothing to checkpoint — the scheduler wait batch is the only
   write, and materialization happens on resume. A crash between re-runs
   `awaitEvent` idempotently. Two SDK invariants, explicit: waits are strictly
   serial (one outstanding `awaitEvent` per run — combinators over events are
   unsupported, enforced by the suspend-on-await SDK shape), and events are
   **one-shot** — repeated deliveries embed an occurrence id in the name
   (Absurd's own documented pattern, `shipment.packed:${orderId}`); iterable
   hooks are explicitly out of scope for v1.
4. **Spawn latency & pool protocol.** Run-DB creation (~100ms + the ~2.5s
   readiness race) comes off the hot path via a warm pool of pre-created DBs,
   with crash-safe assignment: (1) pool-claim CAS stamped with a spawn token;
   (2) write the claim/manifest row *into* the pooled run DB; (3) pool-entry
   CAS `assigned → committed` (fenced by the spawn token — failing here means
   the janitor condemned the entry: abort and retry with a fresh DB); (4)
   scheduler task INSERT. Janitor rule: only entries still `assigned` past TTL
   are condemned and destroyed — never returned to the pool (DB creation is
   cheap, double-assignment is not); `committed` entries past a much longer
   TTL with no scheduler row are also destroyed, and as a belt-and-braces
   fence the worker's first activation cross-checks the run-DB manifest's
   task/spawn-token against its launch payload, failing closed on mismatch. Stated honestly: dedicated placement needs
   a paid plan (Free caps 100 DBs org-wide); Platform-API create/delete rate
   limits are unpublished (empirical probe in Phase 5); and when the pool is
   empty, spawn degrades to `inline` placement rather than blocking on DB
   creation.

**Scalability — two independent axes, stated honestly.** The goal is not "no
central point" (impossible: two workers must agree on who executes a run, so
*some* serialization per run is irreducible) but "no *global* central point" —
and on that axis everything fans out. **Axis 1, throughput:** transitions/sec
per shard is bounded by the commit ceiling (§1.3) and scales ~linearly with
shard count — shards per tenant/queue, or per hash-slice of a hot queue, with
two stated costs: slicing weakens queue-wide oldest-first fairness to
per-slice ordering, and sliced queues **forgo emit/await events entirely**
(events are queue-global by contract; an "event-home slice" would reintroduce
the exact cross-DB lost-wakeup race rule 2 forbids, so it is not an option).
**Axis 2, volume:** Turso meters rows-written **per organization, not per
DB** — sharding multiplies throughput but not the write budget. On paid plans
volume is a linear cost (overage ≈ $0.75–1 per million rows, i.e. a few
dollars per million task lifecycles); on Free it is a hard fleet-wide stop
(`BLOCKED` — in which state ticks fail closed and everything stalls until the
quota resets, so usage-API alerting is part of the ops surface, §6 Phase 5).
One honest caveat on the transitions-not-steps claim: throttled heartbeats
are a *time-proportional* scheduler write (∝ concurrent leased runs ÷
cadence) — negligible for short tasks, but a real metered term for many
concurrent long-running runs. Drivers scale as N stateless loops leased **per driver, not per
shard** — one heartbeat row per driver carrying its assigned shard set keeps
the registry genuinely read-mostly — with jittered lease expiries and an
adoption cap (at most M orphaned shards claimed per tick) so a dead driver's
portfolio drains over a few ticks instead of stampeding; orphans degrade to
cron-sweep latency until adopted. The registry (tenant/queue → shard) stays
cacheable and itself shardable. This is Cloudflare's scaling story without
the branding — per-object serialization over a sharded substrate, no global
queue — plus a metered bill Cloudflare hides.

### 3.9 The pluggable ports and the advisory-signal rule

The system decomposes into five ports. One invariant makes the decomposition
safe: **the scheduler lease is the only source of truth for execution rights;
every other signal is advisory** — it may be lost (lease timer recovers),
duplicated (fences no-op), late, or wrong under split-brain (fences reject
stale tokens) — and advisory signals get exactly one write:
`expireLeaseNow(queue, runId, claimToken)`, i.e. they may only *accelerate* what
the lease timer would do anyway, never directly complete or fail a run. It
returns true only when that exact queue/run/token still names a running lease,
the stored expiry is a native integer strictly in the future, and a task with
the same id and queue owns the run; the write then shortens the lease to the
database instant. Every mismatch, invalid expiry, or already-expired lease
stutters.

1. **SchedulerStore** (dialect port: Postgres | MySQL | SQLite/Turso) —
   scheduling only, every method one fenced idempotent tx/statement, DB-side
   time: `spawn`, `claim(claimToken,k,lease)` (increments `claim_gen`),
   `activate` (per-claim generation CAS, §3.2; re-extends the lease),
   `heartbeat` (returns lease state so zombies learn they're dead),
   `reschedule`, `complete`, `fail` (retry policy in core, applied fenced),
   `sweep` (expired leases + cancellation, classified by activation state),
   `expireLeaseNow(queue, runId, claimToken)`, `emitEvent`/`registerWait`
   (worker-initiated registration is claim-fenced like every worker write),
   `nextWakeAt`, and `driverHeartbeat` — an observability-only upsert of the
   driver's liveness row (`drivers` table: queue+driver id, last beat, expiry at
   twice the beat cadence; each beat also deletes expired rows so the registry
   is self-cleaning). Nothing in the protocol reads it; a failed beat costs
   nothing but visibility.
2. **Launcher** (execution transport, agnostic on "how"):
   `launch({runId, attempt, claimToken, claimGen, shard, deadlineHint}) →`
   `accepted` (fire-and-forget ack — may still be lost) |
   `ended({runId, claimToken, kind})` (sync HTTP: outcome observed inline — a
   reliable Ending carrying the exact launch identity; reconcile makes no
   write unless both fields match the invocation; legal only for drivers
   holding bounded launch slots, including the one-slot dogfood host — general
   serverless ticks always fire-and-forget, §3.1 step 3) |
   `launch-failed` (transport-level rejection → fenced immediate relaunch —
   still counted by the relaunch counter, since "never ran" is the launcher's
   claim, not a guarantee).
3. **EndingFeed** (runner-termination log; honest contract: at-most-once,
   duplicated, delayed, split-brain-capable): events
   `{queue, runId, claimToken?, endedAtEpochMs, kind:
   completed|failed|crashed|timeout|unknown}`. A token-bearing consumer calls
   `expireLeaseNow` only for that exact `(queue, runId, claimToken)`; a
   mismatched signal stutters. Tokenless signals make no write until PR6.4 adds
   the spec-first atomic heartbeat-cutoff operation: it must read the run's
   current token, prove no heartbeat landed after the ending's cutoff, and
   expire that same claim in one store action. A separate read followed by
   `expireLeaseNow` races a new claim or heartbeat and is forbidden. Feed loss
   therefore costs only acceleration, never correctness.
4. **RunStateStore** (data plane, §3.8): `load`, attempt-guarded
   `saveCheckpoint`, streams; placements inline | per-run DB | local file+sync.
5. **WakeSignals** (optional accelerators): `ping(shard)`, `alarmAt(shard,t)`,
   external cron.

Failure taxonomy → port mapping: lost fire-and-forget launch = claimed but
never activated → sweep sees `activated_gen < claim_gen` at lease expiry → relaunch
without burning an attempt (this is why activation is separate from claim).
Sync launch = a Launcher whose exact-identity EndingFeed is inline and reliable
— identical reconcile path, better p50. Catastrophic ending =
`expireLeaseNow` → reclaim now instead of at lease expiry. Split-brain "death"
of a live zombie = the same
brief-overlap window lease expiry already tolerates; the zombie's scheduler
writes die on the stale token, its checkpoints on attempt guards, and its next
`heartbeat` tells it to exit. Feed totally lost = reclaim latency degrades to
the lease timeout; correctness unchanged.

Any combination of implementations across the five ports is correct, because
the only load-bearing component is the lease in port 1 — that is the
pluggability guarantee.

### 3.10 Sagas: per-step rollbacks (modeled on Cloudflare's June-2026 API)

Compensation is declared per step, co-located with the forward action —
`ctx.step(name, fn, { rollback, rollbackConfig })` — and engine-triggered,
never user-triggered (no Temporal-style explicit `compensate()` call):

- **Trigger**: rollback runs only when the task is about to fail terminally
  (retries exhausted or FatalTaskError). An error the user code catches and
  survives never triggers rollback.
- **Eligibility & order**: every started-or-completed step that registered a
  rollback is eligible (the handler receives `{ output, error, ctx }` with
  `output === undefined` when the forward step never persisted — handlers
  guard on it); handlers run in **reverse step-start order**.
- **Mechanics on this engine**: the checkpoint records a `rollback_registered`
  flag and a step-start ordering index. On terminal failure the run enters a
  `rolling_back` phase (a checkpoint, so it survives crashes); the task
  function re-runs, memoized steps skip and re-register their closures, and
  the SDK executes handlers as ordinary durable steps named
  `rollback:<step>#<count>` with their own `rollbackConfig` retry budgets on
  the normal claim/lease machinery. Crash mid-rollback resumes exactly where
  it died — this is strictly simpler than Cloudflare's replay-plus-RPC-stub
  reconstruction because re-execution is already our model.
- **Failure semantics** (matching Cloudflare exactly): a rollback step that
  exhausts its retries or throws FatalTaskError marks the rollback outcome
  `failed` and halts the remaining handlers; the task still terminates in
  `failed` either way. There is **no distinct "compensated" terminal state**
  — the rollback outcome `{ outcome: 'complete' | 'failed', error }` is a
  separate field on the task result. Rollback handlers must be idempotent
  and use distinct idempotency keys (`<id>:rollback-<step>`).

## 4. What "ticks" mean here — direct answers to the original questions

- **How do ticks drive workflows?** A tick is one pass of the driver: sweep
  expired leases → claim due runs → launch workers → compute the next wake → done.
  In resident mode the driver loops `tick(); sleep(min(next transition, poll
  ceiling))` — the loop is the alarm, like Absurd's 250ms worker poll but
  dispatch-only. In serverless mode the same `tick()` runs per invocation, fired
  by pings/alarms/cron — Cloudflare's alarm-shape (DO alarm set to the next state
  transition) rebuilt from commodity schedulers over Turso. Vercel's managed
  World is the degenerate case: no ticks, the queue push is the invocation.
- **How do workers get kicked off when needed?** The driver launches exactly as
  many workers as it claimed runs — fire-and-forget "launch this thing" calls.
  What wakes the driver: its own poll timer (resident), ping-on-enqueue (ms
  latency), one-shot alarm at the next known `available_at`/lease expiry, or the
  cron sweep (best-effort recurring backstop). Workers never poll and never
  idle.
- **How do we avoid idle CPU/memory?** All heavyweight compute is launch-on-demand
  and exits at suspension points; long tasks chain invocations via checkpoints +
  leases. The only resident thing (optional, by choice) is the driver — a few MB
  doing two indexed reads per poll, launching nothing when there's nothing due.
  Sleeping workflows are rows, not processes (Turso idle DBs are files in object
  storage).
- **Scale-to-zero with pending timers?** The driver sleeps until the next
  transition (resident) or the alarm re-arm carries the wake (serverless); the
  cron sweep recovers progress even if both die. Timer precision = poll/alarm
  precision in the normal case, degrading to a few best-effort cron periods only
  when a ping *and* its alarm are both lost.

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Turso rows-written quota burn / exhaustion | idle ticks are read-only (reads are ~free); writes only on actual transitions + throttled heartbeats; batch claims; usage-API alerting with documented `BLOCKED` degraded mode (ticks fail closed, recover on quota reset); Developer plan headroom is 25M writes/mo |
| Turso single-writer throughput (~10–100 claims/s/DB) | claim batches (K per statement); shard DB-per-tenant/queue via Platform API; MVCC engine later |
| Free-plan 10-day archival ambiguity | use Developer plan ($4.99) or empirical probe; unarchive API exists |
| Duplicate execution (duplicate launch delivery; lease expiry with live worker) | per-claim activation CAS on `(claimed_by, claim_gen, activated_gen < claim_gen)` kills duplicate deliveries; Absurd's contract covers lease-overlap (steps tolerate brief overlap); run-DB writes token-fenced (§3.8); completes/fails fenced by claim token |
| Crash-looping launches (never activated — e.g. bad HMAC config) | sweep classifies by activation state: capped relaunch counter with backoff → terminal failure, so misconfig surfaces as failed runs, not infinite launch spend |
| Lost ping AND lost alarm | cron sweep recovers it — best-effort (Vercel never retries a missed cron), so worst case is a few cron periods, and QStash's retries+DLQ make the alarm leg the reliable one |
| Thundering herd on big backlog | K/K_s-bounded claims and sweeps; successor-tick chain drains K per hop instead of launching thousands at once; poll jitter across drivers |
| 5s interactive-tx limit bites a future multi-statement need | rule: every engine transition is one statement or one `batch()`; enforced in the §3.4 contract rules + conformance tests |
| Vercel cron best-effort/duplicate | idempotent tick; overlap-safe claims; QStash alarms as the primary wake, cron as backup |
| MySQL claim differences (no RETURNING, gap locks) | token-claim dialect + READ COMMITTED; conformance suite runs identically |
| Cross-plane staleness (run DB committed, scheduler transition lost) | §3.8 discipline: progress-first ordering; lease expiry + run-DB read reconciles idempotently with infra-retry accounting (no attempt burn); scheduler shards are primary state under PITR/backup; conformance covers kill-between-planes and zombie-fence cases |
| Run-DB creation on the spawn hot path (~100ms + ~2.5s readiness race) | warm pool with crash-safe claim protocol (§3.8.4); degrade to `inline` when pool empty; paid plan required for dedicated; Platform-API rate limits unpublished → Phase 5 probe |
| WDK ecosystem drift (if Phase 7 wrapper) | target `@workflow/world@5.0.0-beta.27+` (the release that introduced the strict `specVersion` gate) with `specVersion` declared; the 4.x-pinned community Turso world shows the cost of not doing this |

## 6. Phased plan (stack of PRs)

- **Phase 0 — scaffold + baseline deploy (Deliverable A).** Repo, `workflow@4.6.0`
  demo workflow on managed Vercel World, Turso provisioned (marketplace creds),
  CI. Proves the deploy pipeline and gives the reference behavior.
- **Phase 1 — scheduler plane on Turso (inline placement).** Schema +
  idempotent migrations with a `schema_version`; the `SchedulerStore` port,
  Turso dialect: spawn / claim (with `claim_gen`) / activate / heartbeat /
  reschedule / complete / fail / sweep-with-activation-classification /
  expireLeaseNow / nextWakeAt; retry policy in core, timestamps in SQL.
  Conformance suite v1 (claim, lease expiry, lost-launch reopen,
  checkpoint replay, chaining) on `file:` SQLite + Turso integration
  (readiness gate, remote-claw patterns).
- **Phase 2 — drive, both modes.** The shared `tick()`; the **resident driver
  first** (loop + adaptive sleep, `/wake` endpoint, per-driver registry
  heartbeat) since it is the preferred mode; then the serverless tick
  (`/api/tick` GET+POST, ping-on-enqueue, QStash alarms with per-(shard,t)
  dedup, Vercel cron sweep); the fire-and-forget HTTP `Launcher` with HMAC;
  fail-closed authorization through the hosted plugin port (transport HMAC
  remains separate). Chaos
  tests: kill-worker → sweep recovers; drop-launch → relaunch without attempt
  burn; duplicate delivery → activation CAS.
- **Phase 3 — full Absurd semantics.** Events (emit/await, first-write-wins,
  timeout branch), cancellation policies, idempotent spawn, child tasks
  (completion-event await + same-queue refusal), step repeat counters,
  defer-unknown-task deploy rule; Absurd's docs-level API (`ctx.step`,
  `sleepFor`, `awaitEvent`, `spawn`) as the TS SDK.
- **Phase 4 — dialects + conformance matrix.** MySQL 8 in a CI container
  (token-claim dialect, READ COMMITTED, concurrent-claim/gap-lock cases;
  optional PlanetScale smoke job for the 20s-cap/HTTP-driver constraints) AND
  Postgres (Absurd's own SQL — the cheapest dialect, closing the promise §0
  makes); conformance suite runs ×3 including the adversarial cases (zombie
  fencing, kill-between-planes, awaitEvent/emitEvent interleavings).
- **Phase 5 — operations + sharding.** Shard registry with status semantics
  (active/draining/paused) + per-driver shard assignment + cron fan-out tick
  (§3.7); shard create/route APIs; cleanup/retention (Absurd queue policies,
  event-GC barrier); metrics + usage-API quota alerting with the `BLOCKED`
  degraded-mode runbook; fleet migration sweep (`schema_version`-gated);
  empirical probes promised above (Free-plan archival, Platform-API rate
  limits); CLI-first inspection (UI deferred).
- **Phase 6 — two-plane data plane (`dedicated` placement).** `RunStateStore`
  port with per-run DBs: warm pool + crash-safe assignment protocol, run-DB
  claim-fence meta row, delivered-wait materialization, successor-carried
  run-DB pointers, PITR restore runbook; `EndingFeed` port with the
  reconcile rule. Until this phase, `dedicated` placement and §3.8's protocol
  details are **specified-but-deferred** — v1 ships inline-only.
- **Phase 7 (optional) — WDK World wrapper.** Expose the engine as a spec-v5
  World (`Queue` = ping/alarm push via our driver, `Storage` = event-log mapping,
  `Streamer` = chunk table + polling reads) so `"use workflow"` apps run on it —
  the serverless Turso World that doesn't exist today (§1.1).

## 7. Key sources

- Absurd: github.com/earendil-works/absurd (sql/absurd.sql); lucumr.pocoo.org
  2025-11-03 announcement + 2026-04-04 production retrospective.
- Workflow SDK: workflow-sdk.dev docs; github.com/vercel/workflow (packages/world
  interfaces, world-vercel/world-postgres/world-local sources, worlds-manifest.json,
  PR #2659 spec gate, issue #689 "postgres world isn't meant to work on vercel").
- Community worlds: github.com/mizzle-dev/workflow-worlds (@workflow-worlds/turso
  0.2.2); vinnymac/worlds (@fantasticfour/world-upstash — the push-queue template).
- Vercel: vercel.com/docs/workflows, /docs/queues (delayed messages, `queue/v2beta`
  beta), /docs/cron-jobs (per-minute Pro, best-effort), Fluid/Active-CPU pricing.
- Turso: docs.turso.tech (5s interactive tx, batch atomicity, durability/commit
  ceilings, /beta/listen contract + availability, usage quotas, platform API);
  turso.tech blog (AWS diskless, outbox+cron pattern, new-engine CDC/MVCC).
- SQLite queue prior art: riverqueue riversqlite driver, goqite, litequeue,
  Solid Queue; DBOS system tables + SQLite system-DB support; Cloudflare Workflows
  architecture (SQLite DO per instance + alarms).
- MySQL: dev.mysql.com refman (SKIP LOCKED, isolation, fractional seconds, upsert);
  Solid Queue / Laravel claim implementations; PlanetScale limits.
- Local: ~/remote-claw (Turso fleet credential scheme, 404-readiness gate,
  idempotent DDL, cron+CRON_SECRET patterns); ~/ts-api (single-DB Turso wiring).
