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
         computed in SQL, carrying forward SUCCESSOR_CARRIED_RUN_COLUMNS:
         the run-DB pointer, wake_event, event_payload, and wake_step), fail
         the old run, update the task.
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
  carries it. The payload's identity is `LAUNCH_IDENTITY_FIELDS`: the queue, run id,
  and claim token as non-empty strings and the claim generation as a positive
  integer. A worker refuses a launch whose identity is missing or malformed, and
  ignores every other field, so drivers and workers of different versions still
  interoperate. The worker first reads the claimed task's name for this unactivated
  claim (`claimedTaskName`); a build with no handler for that name defers the
  claim before this CAS (`deferLaunch`, fenced on the same claim receipt with
  `activated_gen < :claim_gen`), so an undispatchable launch never latches the
  first start, which would disarm the start deadline and start the duration
  clock for a task no handler ran. Otherwise activation is
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
- **An activation answer this worker cannot read is refused before user code
  runs.** A store built from another commit may answer without a field the worker
  reads, or with a malformed one. `decodeClaimedRunAnswer` decodes every read field
  with the stores' own bounds and their `attempt > infra_retries` relation, and the
  worker runs on the decoded run. Otherwise the pass ends as `incompatible-store`
  naming the first such field, writing nothing. Activation has already latched the first start,
  so the lease expires, the sweep charges an infrastructure retry, and a compatible
  worker completes the successor; a mismatch that persists ends at the
  infrastructure cap.
- Loads visible checkpoints (`c_` rows for the task, committed, owner attempt ≤
  current) into memory — Absurd's TaskContext preload, one SELECT.
- Runs the registered task handler with `ctx`: `step(name, fn)` (memoize→execute→
  `set_checkpoint` upsert which also extends the lease), `sleepFor/sleepUntil`
  (throw Suspend CARRYING the sleep marker; the runtime lands marker + park in
  ONE fenced batch — `suspendRun` — because a marker whose park failed would
  read as "the wake already happened" to the next attempt), `awaitEvent`
  (checkpoint-or-register-wait, throw Suspend), `emitEvent`, and `spawn` and
  `awaitTask` (child tasks, below). A task name given to `spawn` follows the
  rules of a step name, because it becomes part of a replay key.
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
  refused `heartbeat` names why, like a refused write: `cancelled` when the
  task's cancellation ended the run (the AB001 equivalent), and `lease-lost`
  otherwise (AB002). Either one stops the handler at its next context call.
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
- The worker server and the resident driver's `/wake` server bind to 127.0.0.1
  only. Neither installs a server `error` handler after bind, so a server error
  is an uncaught event that ends the host process. Every pass it was running
  recovers through the lease, like any other worker death.
- Rolling deploys, ported from Absurd: a worker whose build has no handler for
  the claimed task name **defers** the claim before activation (`deferLaunch`,
  15s + jitter, nothing consumed; the activation bullet above says how the name
  is read). The launch still carries only ids, so older drivers keep working and
  no payload can name a task the claim does not hold. Deploy workers before enabling producers, and old runs survive
  new code. In-flight runs resuming under changed code rely on checkpoint
  stability: step names/order must stay compatible, or the task name is
  versioned (`report@v2`) so old runs finish on old handlers.
- Child tasks: `ctx.spawn` a child, then await it *as an event*. The spawn is
  its own memoized step, so like every durable operation it is not called
  inside a `ctx.step` body. The await suspends like any other wait and holds no
  worker slot.
  `specs/ChildTasks.tla` models the completion event ahead of its
  implementation, for an await whose event and wait row live in ONE queue, and
  TLC checks it:
  - The child's FIRST terminal transition writes the completion event
    `$task-done:<taskId>` as a follow-on of the same fenced batch, and the same
    batch wakes a registered waiter. Every terminal batch does this: complete,
    terminal failure, both cancellations, and both sweep caps. With the emit as
    a second step, a crash between the two leaves a registered waiter asleep
    forever, which the model's liveness probe exhibits.
  - Every terminal batch takes the dialect's event lock, as `emit-event` and
    `await-event` do (§3.4 rule 2). The model's actions are atomic and
    mutually exclusive, and on PostgreSQL only the lock makes them so: without
    it a parent reads no event, the child inserts the event and sees no wait
    row, and the parent then sleeps forever. SQLite's single writer hides the
    race. Each of the five PostgreSQL sites takes the lock on its own line, and
    each is held by a PostgreSQL case that keeps the await's transaction open
    across the whole terminal batch, with a trigger that sleeps after the wait
    row is inserted: a locked batch waits and wakes the parent, and an unlocked
    one loses the wakeup every time. The await that records an outcome writes
    the event too, so it takes the same lock, and a case of the same kind holds
    it: two such awaits of one child, the first held open after its insert.
    Without the lock the second inserts the same row, the table's key refuses
    it, and the await is reported as an outage. The emit has a case of the same
    kind, and the await's lock is the other side of every one of them, so each
    of the eight lines that take the lock has a case that cannot miss and a
    mutation that removes it. A race of twelve real concurrent awaits
    against every terminal batch also runs on both dialects. It is a smoke and
    not the proof: with the lock dropped it caught one site of five.
  - The PostgreSQL event lock has two forms, chosen by who owns the name. A
    caller's event takes the row of `event_locks` that every build has taken:
    inserted when it is missing, then locked. A process of an older build keeps
    running after a newer build has migrated, because a store never reads the
    schema version, so for the length of a deploy both builds emit and await the
    same events, and two lock kinds would not exclude each other. A PostgreSQL
    case runs one side as the older build, holds the await open, and sees the
    waiter woken in both directions. A task's completion event takes
    `pg_advisory_xact_lock` on a key hashed from the tag `durablerun:event`, the
    identity of the `events` table as the session resolves it, the queue, and
    the event name. No build before child tasks locks a completion event, so
    nothing has to agree with a row, and a row would be left for every task that
    ever ends, awaited or not. Keyed on the table and not on `current_schema()`,
    two pools that reach the same tables through different search paths still
    exclude each other. A hash collision can only serialize two unrelated
    events. The row lock can go once no build that takes it can still run, which
    BUILD.md records.
  - The MySQL event lock has one form. Every event lock there is a session
    named lock, taken before the transaction and released after it, and its
    name is `SHA2(JSON_ARRAY(DATABASE(), 'durablerun:event', queue, event
    name), 256)`. A completion event's lock is that same derivation over the
    name `$task-done:<taskId>`, so the await of a child, the batch that records
    an unrecorded ending, and all five terminal sites take one lock, and it
    is held across the completion event as it is across a caller's. It cannot
    collide with a caller's event. `emitEvent` and `awaitEvent` refuse a name
    that starts with `$`, so no caller's name equals a completion event's. The
    queue and the name are separate members of the array and never joined
    text, and the database is a member too, so two different events share a
    lock only if SHA-256 collides, which would serialize them and nothing
    else. The rolling-deploy concern does not apply to MySQL, because no MySQL
    build older than child tasks exists, so no process can be taking another
    lock for the same event. A case against a MySQL server holds the lock of one
    task's completion event and sees that task's terminal batch finish after
    the lock is released, and another task's before.
  - The event is first-write-wins like every event (§3.8.3), so it means "the
    first outcome this task reached", never "the task is terminal now".
    `retryTask` can take a failed task back to live, and a revived child that
    ends again does not rewrite the event. A parent that awaited before or
    after the revival sees the same outcome, which keeps its replay
    deterministic. The await can therefore disagree with the task's current
    result: after a failed child is revived and completes, the await still
    returns the failure while `getTaskResult` reports the completion.
  - A task can be terminal with no completion event: a build older than this
    protocol ended it, during a rolling deploy or before the protocol existed.
    No terminal batch will fire for it again, so an await that registered a
    wait would sleep forever. The await never registers on an ended child. It
    records the missing event itself (the model's `AwaitMaterialize`): it reads
    the child's row, and a batch of its own, `record-task-done`, inserts the event from
    that outcome, fenced on the row still carrying the stamp that was read, on
    no event existing, and on the awaiting run's live claim, under the event
    lock, and answers as a hit. "First outcome" for such a task means the first
    outcome RECORDED: the task row's terminal outcome at that moment is the
    best fact left, and it is the recorded first outcome from then on, through
    any later revival. A child revived between the read and the batch is live
    again, so nothing is recorded and the next round registers.
  - One case stays open, and it is an assumption the model states and cannot
    enforce: an older build that ends a child WHILE a parent is parked on it
    writes no event and wakes nobody, and no await is left to record it. The
    deploy rule covers it: every worker and driver runs this build before any
    task awaits a child. The model's probe `LegacyEndStrandsWaiter` lifts the
    rule and shows the waiter stranded. A timed await or a cancellation
    deadline bounds it, as it bounds an await cycle.
  - The completion event outlives every await of it. Event cleanup must not
    remove one while its task can still be awaited, or a late await would
    register a wait that nothing will ever wake.
  - A timed await that comes due consumes its wait row and returns no
    outcome, and a later emit finds no row to wake.
  - The name is reserved. Every event statement and the event lock take an
    `EventName`, which only core mints, in two ways: `EventName.fromPort`
    refuses a name that starts with `$` with `RangeError`, and a name no store
    can keep, one with a NUL or a lone surrogate, with
    `InvalidDurableStringError`, and `EventName.taskDone` is the completion
    event of a task. So the `emitEvent`
    and `awaitEvent` ports cannot forget the refusal, and they write or
    register nothing for a reserved name. The hosted emit route and the SDK
    already refused one through `UserName.parse`. Any other caller of the emit
    port could have won first-write-wins and forged a child's result, and any
    caller of the await port could have skipped the queue rule below. The child
    await is therefore its own port method, `awaitTaskDone(queue, taskId,
    runId, claimToken, stepName, childTaskId, timeoutSeconds)`.
  - A child's idempotency key is reserved the same way. `ctx.spawn` keys its
    child by the parent task and the call site, and the spawn receipt adopts
    whatever task holds a key, so a caller who could take that key would hand
    a parent a task of its own choosing, and its result. The spawn port refuses
    a caller's `idempotencyKey` that starts with `$`, the hosted enqueue route
    answers 400 for one, and the key is not a string the SDK passes:
    `SpawnOptions.childOf` names the parent's live claim and the call site, and
    the store builds the key in core (`childSpawnKey`), with the parent id's
    length first, so that no two pairs spell one key. `childOf` and
    `idempotencyKey` together are refused. A child is created only under its
    parent's live claim (ChildTasks.tla's `SpawnAuthority`): the insert presents
    the claim a child await presents, and a child spawn that created nothing and
    found nothing answers with the run's own refusal. A child that exists is
    found without a claim, which is what a replay asks. Refusing a caller's `$`
    key is a breaking change to the enqueue contract. A caller that used such
    keys gets `RangeError` at the port and 400 at the hosted route, and has to
    rename them. Rows already stored under such a key stay as they are.
  - The payload is the child's first outcome, in the shape `getTaskResult`
    answers with: the terminal state, and the completed payload or the failure
    reason (`encodeTaskOutcome`, `decodeTaskOutcome`). The terminal batch binds
    it as a value, so no dialect builds JSON in SQL. The insert selects from
    the task row the batch made terminal, under the stamp of the statement
    that ended it, so a batch that ended nothing writes no event, and a `fail`
    that scheduled a retry writes none. It carries no conflict clause, which a
    follow-on insert may not have. An event that exists is left alone by a
    `NOT EXISTS` guard, which the event lock makes safe. Both stores add the
    insert and the wake through one core function (`addTaskDone`). Nothing is
    checked after the batch. A terminal write's answer is its batch's answer,
    and a read after the commit could only change that answer for a transition
    that has happened. A batch that named the wrong task or the wrong terminal
    statement would end the task with no event, and an insert that writes
    nothing passes every row-count audit. What holds that is
    `childTaskViolations`, which runs after every case of the surface, over
    every terminal label, in the fuzz, and in the SDK harness.
  - A terminal batch names the task, and `complete` and `fail` are handed only
    the run. The store that activated a run remembers its task, so the
    worker's own terminal write pays no read. Any other caller pays one read of
    the run's task (`run-task`) before the batch. A run's task never changes
    and run ids are never reused, so neither the read nor the memory can be
    stale. Passing the task id through the port would remove the read, and
    would change the rule that a launch carries only the run and its token. The
    maintainer chose the memory.
  - A child is awaited only within its parent's queue. Events are keyed by
    queue and are shard-local (§3.7), so a same-queue child is the only one
    whose terminal batch can wake its parent: a child in another queue writes
    its event under that queue, where the parent's wait row is not. Awaiting a
    child in another queue is refused, as a permanent error that registers
    nothing, until a delivery protocol across queues exists and is modeled.
    The rule is decided inside the await batch: its compare-and-set registers
    a wait only while a task with that id is live in the parent's queue, read
    under the event lock, so the common await is one batch and no read. An
    await that neither registered nor hit reads the child once
    (`task-done-state`) to say why. A child in another queue, and a task that
    does not exist (the model's `AwaitUnknown`), throw
    `ChildAwaitRefusedError`, classified in core. A child that ended with
    nothing recorded is recorded, as above. A live child means the awaiting
    run's own claim is gone. A child in the parent's queue is never refused.
    This departs from Absurd, which refuses the same-queue await because its
    await polls and holds a worker slot, so a parent and its child can
    deadlock a small pool. Ours suspends and holds nothing. The model isolates
    the rule as one constant and checks the protocol with the await allowed
    and with it refused.
  - Not modeled, and bounded elsewhere: an await cycle, where a parent awaits
    a child that awaits the parent, waits forever in any queue. Nothing
    detects it, and only a cancellation deadline bounds it, as it bounds any
    untimed await. A task that awaits itself is the shortest such cycle.
  - The SDK surface is `ctx.spawn(taskName, params, opts?)` and
    `ctx.awaitTask(child, opts?)`. A spawn is memoized like a step, and it
    carries the idempotency key `$spawn:<length of the parent task id>:<parent
    task id>:<replay key>`, so a
    pass that died after the spawn committed and before its checkpoint did
    finds the same child on the next pass, and so does a zombie. `awaitTask`
    resolves to the child's first outcome and does not throw for a failed or
    cancelled child, so the parent decides what a failure means. A timeout
    throws `TaskTimeoutError`, which is an `EventTimeoutError` that names the
    task awaited and never the engine's event, and an error the store raises
    from a child await names the task the same way. A refused await, and a spawn the
    store refuses as invalid input, are permanent failures (`FatalTaskError`),
    because neither changes on a retry: that covers `RangeError`, and
    `InvalidDurableStringError` for a queue no store can keep. A child's recorded
    outcome that cannot be read, which the store and the decoder refuse with
    `RangeError`, is permanent the same way. A child defaults
    to its parent's queue. A queue the task names is the first queue name task
    code chooses, so the spawn port holds it to the durable string domain, where
    the dialects otherwise disagree on a NUL and on a lone surrogate, and the SDK
    makes that refusal permanent.
  - The model's actions and guards have executable twins in the conformance
    surface `child-tasks`, which every dialect runs: one case over every
    terminal batch, generated from the batch labels, plus the hit, the retry
    that writes no event, the first outcome after a revival, the await port's
    refusal of the reserved name, both directions of the queue rule, the
    unknown task, the unrecorded ending and its fences, a child revived before
    the read that says why, a committed answer when a later read fails, the
    checker seen reporting a missing event,
    the timeout, the cancelled parent, and every simulated interleaving of the
    await with the child's ending. The emit port's refusal of the reserved name,
    the reserved idempotency key, the durable queue, the durable event name, and
    the child spawn's claim are cases of the
    scheduler suite, which needs nothing but those ports. Rows that
    only the engine wrote are also held to `childTaskViolations`: a terminal
    task has its completion event, and a completion event names a task of its
    queue and decodes. It runs in the operation fuzz, which awaits children
    and requires a cross-queue await to be refused, and in the SDK's
    replay-equivalence harness, which generates `spawn` and `awaitTask`, counts
    tasks so that a second child fails the comparison, and faults every program
    through its last measured store call. It is
    not part of the invariant library, because that library also judges states
    the poison matrix writes by hand, where no batch could have written the
    event.
- Three executor and batch rules came with child tasks, because every task
  ending now carries a completion event and its wake:
  - A gated statement names its gate. A tree statement that must be gated
    tells the executor which earlier statement of its batch gates it
    (`SqlStatement.skipUnlessWrote`), read from the tied gate the gating rule
    requires. Seeds are unique to an invocation, so when that statement wrote
    no row, nothing carries its stamp and the gated statement cannot match. The
    PostgreSQL and MySQL executors pay a round trip for each statement, so they
    do not send such a statement and answer with no rows. MySQL counts rows
    changed where the port means rows matched, so its executor reads the gate
    from the normalized count: a gate that matched a row and changed nothing
    still sends its gated statement, which a case against a MySQL server holds
    beside the skip. The libSQL executor sends a
    batch whole and ignores the field. On a first delivery the two leave the
    same state. On an exact replay the gate writes nothing, and the skip leaves
    alone what the first delivery committed. A compare-and-set and an open tail
    carry no gate. Neither does a tail that answers with a row whatever it
    matched, such as one that counts: skipped, it would answer with no row on
    one dialect and with 0 on the other. Measured as client queries on
    PostgreSQL: a task ending is 8 round trips (5 before child tasks, 12
    without this rule), and an emit with nobody waiting is 7 (10 before).
  - A generated follow-on over a queue-scoped relation may bind its queue. The
    source rows and the written rows then each compare their queue with that
    bind, and the source is not correlated to the target. Every call site over
    a queue-scoped relation binds it. Left correlated, the source is a
    correlated subquery, and SQLite cannot drive a write from one: it scans the
    written table and probes the source once for each row, so claim, activate,
    and complete each read every task in the database, in any queue. One
    `complete` on libSQL beside 100,000 tasks of its queue took 43.4 ms
    correlated and 3.6 ms bound. PostgreSQL and MySQL join from the source
    either way and were keyed before: PostgreSQL plans all 16 task updates with
    an `Index Cond` on `tasks_pkey`, which a plan test in `store-postgres` holds
    for the shipped statements, and MySQL walked 54, 14, and 27 rows for
    claim, activate, and complete beside 4,000 tasks. A follow-on that is handed
    the key of the one row it writes also names that key on the written side, as
    the cancellation's runs follow-on names its task and the await's park names
    its run. The source already selects that row, so the predicate narrows
    nothing and the fence reaches the same rows through the same stamp. It is
    there for the planner: beside a bound queue and a state, SQLite prefers the
    (queue, state) index to the key and walks the queue. `store-libsql`'s plan
    pins recover every UPDATE and DELETE of thirteen labels from the real
    operations. One requires the plan step over the written table, under its
    name or its alias in that statement, to be a seek by the key the write was
    handed, so a scan, a walk, or an index added later fails alike. The other
    refuses any step, under any alias, that is pinned by a queue and a state and
    nothing more. It excuses three statements by name, the claim's, which find
    the runs that claim took by queue and state because the stamp has no index.
    BUILD.md records that as open. `store-mysql`'s plan test measures claim,
    activate, and complete beside 2,000 tasks from inside each batch. The
    wake's task
    follow-on selects its source by queue and state, so correlated it ran once
    for every task row: one `complete` on libSQL cost 1,063 ms at 2,000 pending
    runs in its queue. The three follow-ons after the wake also name what the
    wake set on exactly the rows it woke, `wake_event` and `state = 'pending'`,
    and the partial index `runs_woken` holds only runs that were woken and not
    yet claimed. By queue and state alone the only index is `runs_poll`, and
    every task ending walked every pending run of its queue: 215 ms beside
    100,000 pending runs, against 0.1 to 0.2 ms for each follow-on through the
    index. `query-plans.test.ts` pins both sides of the plan, for `complete`, a
    terminal `fail`, and `cancel-task`. The index is migration 6 and creates
    nothing else. A process of an older build runs against it unchanged. An
    older build that starts afterwards fails in `migrate()` with
    `SchemaMismatchError`, as it does after every migration. PostgreSQL builds
    the index under a lock that blocks writes to `runs` while it builds. MySQL
    has no partial index, so its `runs_woken` is `(queue, wake_event, state)`:
    the state is the last column, and the lookup is one seek to the pending
    runs of one event, whatever else the queue holds and however many runs that
    event woke before. Measured on MySQL 8.4 with the session's handler
    counters read inside the batch: a child's terminal batch beside 800
    pending runs walked 35 rows through the index and 3,243 without it, and
    `store-mysql`'s plan tests hold the first. MySQL also has no `CREATE INDEX
    IF NOT EXISTS`, and its DDL commits on its own, so version 6 chooses its
    statement from the catalog and prepares it, which is safe to repeat after a
    migrator that died between the index and the version.
  - PostgreSQL lock order. Every worker write, every sweep, and the wake lock a
    run's row and then its task's. A cancellation updates the task first, which
    deadlocked against a child ending that woke the cancelled parent, and
    against any worker write that ends nothing. The PostgreSQL cancel
    compare-and-set now locks the task's runs inside the statement that updates
    the task, through a predicate that is always true and reads the task's live
    runs (`runsLockedBeforeTask`). And a write batch PostgreSQL aborts as a
    deadlock victim (SQLSTATE 40P01) committed nothing, so the executor runs it
    again at once, up to three times in all,
    before it reports an outage: reported at once, a finished run was left for
    the sweep to charge an infrastructure retry. MySQL has no twin of the
    predicate: InnoDB locks a row before it evaluates the predicates on it, so
    a predicate cannot order anything. Its executor runs a write batch again
    when InnoDB rolls it back as a deadlock victim (error 1213), up to three
    times in all and under the named lock it already holds, and a read batch
    never.
  - The executors' deadlock count. A victim that is run again is invisible to
    its caller and to every test of that caller, so a wrong lock order can
    pass. Each of the two executors counts the victims it meets, the ones it
    runs again and the ones it reports, and one function in each says what a
    victim is, for the count and for the decision to run the batch again. A
    conformance fixture reads the count (`deadlocks()`). The server's own
    count cannot serve: `pg_stat_database.deadlocks` and InnoDB's counter are
    shared by every test worker connected to the server. libSQL has one writer
    at a time and never picks a victim, so its fixture answers zero. The suite
    holds the count at zero where a hold can fail, which is where real callers
    overlap on connections that are already open: the self-concurrency surface
    (§3.4), four cases of the shared suite (an await beside its emit, the beats
    of distinct drivers, one claim token sent sixteen times, and a child's
    await beside every terminal batch), and the PostgreSQL lock-order test. It
    is held on PostgreSQL and on MySQL alike, because both executors run a
    victim again. It is not held where it could not fail. The seeded scenarios
    run through the simulator, one batch at a time. The native claim case and
    the eight-migrator case open their connections inside their race, and on
    MySQL every migration write takes one named lock. The fuzz walk is one
    caller on libSQL. Measured before any hold: no fixture of the whole
    conformance suite met a victim on PostgreSQL or on MySQL, in one run of
    4311 fixtures on each, and none did in 20 runs of six real-concurrency
    cases on each. On MySQL one contest of the surface is excused, by name and
    with its reason, up to a bound, in that dialect's fixture (§3.4, MySQL).
- Cancellation discovery: a refused worker write names why (the refused-write
  contract, §3.4), and a `RunCancelledError` ends the pass with a `cancelled`
  outcome, consuming nothing. A refused heartbeat names the cancellation the
  same way. The pump beats every half lease, and once a beat is refused the
  handler's next context call throws, even a replayed step that writes nothing:
  `RunCancelledError` when the beat reported the cancellation, `LeaseLostError`
  otherwise. So a cancelled handler ends as cancelled whether its next engine
  call is a context call after that beat, or a complete or fail that is
  refused. A suspension refused because
  the task's cancellation deadline is due, before the sweep has cancelled the
  task, raises `LeaseLostError`, because the run is not cancelled yet.

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
(which cuts its current sleep short, at most once per wake floor: a wake sooner
than `wakeFloorMs` after the last tick started waits out the rest of that
interval, so a flood of pings looks once; the floor defaults to the busy
ceiling). That wait never exceeds the floor and never passes the look the
interrupted park planned, so coalescing delays neither a due wake nor the
registry beat. The floor, the planned look, and the registry beat cadence are
measured in elapsed time (`Clock.elapsedMs`), so a host clock step cannot stretch
any of them. In serverless mode
the ping goes to `/api/tick` instead.
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
   **Statements as trees.** A batch statement may be a Kysely operation tree.
   Core defines such a statement once for every dialect with `defineStatement`,
   which refuses an undefined bind, and a store supplies only its compiler and
   the SQL fragments it owns. Kysely compiles and never connects. The stamp,
   the clock, and a fence are value nodes holding engine sentinel objects, so
   `FencedBatch` decides by node identity and position inside a closed
   statement grammar: a node kind or clause the grammar does not list is
   refused, which excludes common table expressions, RETURNING,
   `UPDATE … FROM`, writes below the root, and schema-qualified tables. It
   lists one set operation, UNION ALL, and only for a batch of reads. It
   lists the functions a statement may call as well, `coalesce` and the
   aggregates `avg`, `count`, `max`, `min`, and `sum`, so a call of anything
   else is refused by name. The
   grammar binds what is built from nodes. A store fragment is opaque text,
   reviewed through the generated corpus.
   - A follow-on or tail needs a top-level WHERE conjunct that is itself
     `fence_stamp = <fence>`, or that requires a row from a subquery gated the
     same way, and the fence must stamp the table whose `fence_stamp` it is
     compared with. A subquery whose only source is one derived table is gated
     by whatever gates that table, because it reads a subset of its rows. A
     join or a second source gates nothing. A row required from a subquery, or
     read through a derived table, proves that SELECT's WHERE only if the
     SELECT can return no row. An ungrouped aggregate returns one row whether
     or not the fence matched, the builder spells an aggregate more than one
     way, and a fragment hides one. So such a SELECT gates only when it is
     grouped, or when it has no HAVING and every selection is built from nodes
     with no function and no fragment. The rule is not asked of a statement's
     own root: a tail may count the rows its own WHERE gates, and a losing
     batch then counts none.
     A gated subquery counts only when it reads one source, with no join, and
     is tied through that source to the row of the query that requires it: IN
     with a column on its left and one plain column of the source selected,
     directly or through one derived table that selects such a column, or
     EXISTS with a top-level equality between a column of the source and a
     column of an outer source. A bound value or an expression in the IN
     list, a second FROM source, and a join are each refused, because the key
     or the match would then be the caller's or another table's and not the
     fenced row's. A subquery that is gated and not tied proves only that the
     batch won, and is refused with its own message. The tie is on any column
     and need not be a key, because an event wakes every run in its queue
     through such a tie. So a tie on a column that is not a key still passes,
     and what then bounds the rows is the rest of the WHERE, which may be store
     text. `fenced-batch-tree.test.ts` runs that exhibit beside its control.
   - The generated follow-ons, `derived()` and `seal()`, are trees built from
     the closed relation contract, so they take every rule above like any tree
     statement. Their selections are correlated by construction: the written
     key is IN the fenced source's paired key, with queue equality where the
     relation is queue-scoped, so a generated follow-on cannot write a row the
     fenced rows do not own. The caller's `where`, `narrow`, and text values
     enter as fragments, and arguments need their text: `whereArgs` with no
     `where`, `narrowArgs` with no `narrow`, and empty text for either are
     refused, so a computed correlation that comes out empty fails and never
     widens the write to every row under the fence. A value that reads the
     column it is assigned to must be built from nodes, because the counting
     rule cannot read a fragment. In a fragment it refuses any mention of that
     column that is unqualified or qualified by the table being written,
     whatever wraps it, and arithmetic on that column under any other
     qualifier, such as `x = t.x + 1`. A copy of
     another row's column stays allowed. A fragment may hold a fence token,
     which becomes a fence node: it is bound and must name a fence of the
     batch, and it gates nothing. Nothing may be left over beside a token. The
     stamp never rides in a fragment. A hand-written follow-on is a tree too,
     and the tie rule above is what holds its subquery gate to the rows it
     writes.
   - An update of a provenance-carrying table assigns the stamp and the
     instant once each, and a compare-and-set takes its instant from the clock
     token. The rule reads the table the tree writes, not a declaration.
   - A compare-and-set may be an INSERT, with or without ON CONFLICT. A tail
     may not. A follow-on may be an INSERT … SELECT, under the rule in the next
     item. A compare-and-set's insert into a provenance-carrying table
     supplies `fence_stamp` as the stamp and `fence_at_ms` as the clock token,
     once each, read by column position from its VALUES row or its SELECT
     list. An upsert's conflict arm must leave the row carrying this
     statement's stamp, or a later statement could fence on a stamp the batch
     never wrote there. For a table whose first instant is a preserved fact,
     today `events.emitted_at_ms`, the arm assigns the stamp and copies that
     column into `fence_at_ms`. For any other table it assigns the stamp and
     the clock token. DO NOTHING is allowed, because it writes no row and the
     compare-and-set then loses. A fact with a preserved first instant also
     takes that instant from the clock token when it is inserted, and its
     conflict arm assigns the two provenance columns and nothing else, so a
     re-emit cannot overwrite the instant or the payload beside it. The
     grammar fixes an insert's shape, because these checks read by position:
     exactly one row of values, or a SELECT with one plain selection for each
     column and no star. A conflict clause names its columns, or it would
     swallow a violation of any unique index. An INSERT … SELECT with a
     conflict clause has a WHERE, which SQLite needs to parse it. The
     await-event registration and the event emit are such statements, shared
     by every dialect. The emit compares stamps with IS DISTINCT FROM, which
     SQLite and PostgreSQL both take, and a dialect passes what it requires of
     an existing event. A shared statement is a tree, and each dialect's
     compiler spells it, so a dialect without those spellings compiles the same
     conflict clause and comparison into its own. A core test shows the
     spelling for MySQL, and `store-mysql` proves the behaviour against a real
     server through the conformance suite. The registration builds the claim it depends on from
     nodes: this run, this queue and task, this claim token, still running. A
     store passes only its join of the run to its task and what it requires of
     the task.
   - A follow-on that inserts selects what it inserts, because only a SELECT
     can be gated, so a row of VALUES is refused. Its gate is a top-level fence
     equality of that SELECT, or a tied subquery. Into a provenance-carrying
     table it supplies `fence_stamp` as the stamp, and `fence_at_ms` as a
     reference to the `fence_at_ms` of a source whose `fence_stamp` a top-level
     conjunct compares with a fence, both read by column position. The clock, a
     bind, another column, and the instant of a joined row the fence does not
     gate are all refused, and so is an unqualified instant among two sources.
     A preserved first instant, today `events.emitted_at_ms`, is held the same
     way: a compare-and-set takes it from the clock token, and a follow-on,
     which reads no clock, takes it from the fenced row's `fence_at_ms` and
     from nothing else, so it cannot be bound or left to a default.
     It carries no conflict clause there, so a collision with a foreign row
     fails loudly. Its SELECT reads the fenced row alone: one FROM item, the
     source whose `fence_stamp` it compares, with any join explicit and
     carrying its ON. A second FROM item would insert a row for every row of
     it, and a FROM item that is not the fenced source would do the same with
     the fenced row merely joined. The `'one'` row bound does not protect
     against this. A bound is audited after the batch returns, so it turns a
     wrong write into a thrown error, and on PostgreSQL the rows have
     committed by then. It is a detector of a broken statement and never the
     thing that keeps a statement narrow. Its SELECT list holds no aggregate and no function call, and
     the SELECT has no HAVING, because each can return a row the fence did not
     match. That is asked of the statement's own SELECT and does not lean on
     what the gating rule decides about aggregates. A SQL fragment in that
     list is refused whatever it holds, because text can spell a call in more
     ways than a reader of text closes: a reader of names before a parenthesis
     passed the schema-qualified `pg_catalog.max(...)`. A value that needs a
     function is computed by the caller and bound. No shipped follow-on insert
     passes a value fragment: the failure
     successors' deadline, the failed run's instant plus a delay the store
     binds, is built from nodes in the shared statement. A value taken from a
     joined row that only store text ties to the fenced one is still outside
     what the rule can read, and that exhibit runs in
     `fenced-batch-tree.test.ts`. A table without provenance
     columns, today `checkpoints`, takes the gate and may carry a conflict arm,
     which the counting rule reads like a SET list. In that arm `excluded` is
     the incoming row and never the row being written, so arithmetic on
     `excluded.column` counts nothing twice and is allowed, in nodes and in a
     fragment, while the written row's own column stays refused.
   - Every insert of a run is built from one record, `insertedRun`: spawn's
     first run, the claim-timeout and user-retry successors, and a revival. The
     new run takes its queue, its task, and both its instants from the fenced
     row, and its carried columns from `SUCCESSOR_CARRIED_RUN_COLUMNS`. The two
     successor deadlines and the successor ownership guard stay store text,
     because registered mutations own them. The retry state is decided from
     the delay before the statement is built, pending with no delay and
     sleeping otherwise, and bound as a value, so the statement holds no cast
     and no dialect's spelling of one. Both checkpoint placements
     write through one statement, `checkpointWrite`, whose last-writer-wins arm
     is nodes, so the inline write and the suspension marker cannot drift.
   - Suspend and reschedule are one shared statement and differ only in the
     admission fragment each store passes. Every compare-and-set that parks a
     claimed run, the launch deferral included, takes its assignments from one
     core helper, so the state, the wake instant, the cleared claim, and the
     stamp cannot drift between them. The await-event registration parks its
     run through a generated follow-on. It takes the cleared claim columns from
     the same list, held to it by a type.
   - A failing run, the cancel transition that `cancel-task` and the deadline
     sweep share, a task's revival, and a checkpoint's lease extension are
     shared statements too. Core holds what they assign and the identity they
     act on: the claimed run, or the task in its queue and, for a
     cancellation, in a live state. A store passes what it requires of the
     owning task or of the task's runs and counters, the retry deadline's
     headroom guard when a retry follows, the due deadline when the sweep
     cancels, the charge a revival records, and the lease deadline with its
     guard. The failed state and the well-formed failure a revival requires
     are part of the store's predicate, because registered mutations own that
     text.
   - Spawn's task insert and the lease sweeps' compare-and-sets are shared
     statements too. The insert is an INSERT … SELECT whose columns and values
     come from one record. Its conflict clause names the idempotency columns
     and narrows them with the partial index's predicate, built from nodes, so
     a taken key loses there. The grammar admits that index predicate on a
     named conflict target and no other kind of target. A taken task id loses
     through the store's identity predicate. The enqueue and cancellation
     deadlines and their guards are the store's. Every lease sweep acts on the
     claim its scan read: this run, this queue, still running, under that
     generation, as nodes. The lost-launch sweep's reopen raises the relaunch
     count in nodes, which a compare-and-set may do because its guard consumes
     the state it matched, and its cap fails a run at the relaunch cap. The
     claim-timeout sweep's fail is its own statement and not a variant of
     `fail`, because no worker presents a token and it keeps the expired
     deadline on the failed run. A store passes the generation order with the
     expired claim, what it requires of the owner, and the relaunch backoff
     with its guard, where PostgreSQL says LEAST.
     The generation is what makes anything else the scan read safe to act on.
     The claim-timeout write takes everything it needs from the stored row
     (still running, activated at its own generation, lease expired, owner
     admissible), so without the comparison it admits only a sweep the stored
     row justifies, and no test failed when it was removed. The lost-launch
     write reports the relaunch count its scan read, which only the generation
     ties to the row, and the claim-timeout batch once took its successor's
     attempt from the scan. Both keep the comparison, and the stale-token
     column holds both to it: a sweep whose scan read another generation acts
     on nothing.
   - The emit's wake is a shared UPDATE, `wakeRunsUpdate`. It reads the event
     the batch recorded through one node-built subquery in four places: the
     gate, the wake instant, the stored payload, and the provenance instant.
     The gate is nodes because a fence token in a fragment gates nothing, and
     it is tied to each run by its queue. The waiter subquery stays store text
     and uncorrelated, so the waits index drives the statement, and the match
     on the parked event, the wait witness, and the live-task probe stay store
     text beside it.
   - Every tail and open tail is a shared SELECT. `tailTree` takes a gated
     read. `openTailTree` takes a read of rows the batch did not write, keeps
     the declared reason `openTail` requires, and skips the gate and nothing
     else: a fence it does compare must still be on the table that fence's
     compare-and-set stamps, as for a gated tail. Both reads of a claimed run select one list,
     `CLAIMED_RUN_SELECTION`, whose names every store's decoder reads. The
     claim receipt's identity is nodes and its admission is one store fragment.
     Spawn's receipt is one read of `tasks` whose store predicate joins its two
     disjoint legs with OR, ordered by a CASE on the task id, because the
     grammar of a transition has no UNION. How a dialect names a stored
     payload's type is a store fragment.
   - A store's reads outside a transition are batches of reads. `readTree`
     takes a shared SELECT into a batch that holds nothing else: it has no
     compare-and-set, stamps nothing, and runs in read mode whatever its
     caller asks. A batch holds reads or a transition and never both, because
     a read beside a write must be a tail that a fence gates. Every other tree
     rule still reads a read, and its reads of the clock are under the clock
     rule below. A store sends each read through `readPrepared`: the read is
     built, checked and compiled once for a dialect and a clock, from stand-in
     values, and every call after that sends the same SQL with its own values
     in a statement object of its own. A prepared read declares each bind's
     type, and every call's values are held to that declaration before the
     read is prepared or sent, the first call included: what a read compiled
     to is kept for the whole process and for every store in it, so no
     caller's values may decide it. A statement whose shape depends on a value
     it is sent, or that holds its own stamp, is refused when it is first
     prepared. What depends on the
     batch is asked on every call: that it holds reads alone, and the clock
     rule. `next-wake` and the sweep's two scans run on every driver tick, so
     a read costs a few microseconds to send, as its text did. The read labels
     left `scripts/batch-lint.py`'s tables, which describe only the batches
     still sent as text. Every batch of reads shares one seed, `READS_SEED`: it
     writes no stamp, and drawing an id would shift the ids a seeded test
     predicts. The grammar lists UNION ALL for a batch of reads alone, and
     `next-wake` uses it to keep each wake source on its own index. A condition
     on a state or a stored instant stays a store fragment, so a partial index
     still sees the literal it was declared with. A state a shared read
     compares from nodes is written inline (`literalValue`), and a batch of
     reads refuses a state or status column compared with a bound value, whose
     placeholder no partial index can match. MySQL builds its own `next-wake`,
     because it does not answer MIN from an index: each leg is a store fragment
     holding a scalar subquery and its index hint, so the grammar lists no
     hint, as for the claim. The libSQL and MySQL query-plan suites pin these
     reads by recording the statements a real sweep and a real `next-wake`
     send. PostgreSQL's plan suite pins none of them. An executor answers a
     batch with one result for each statement it was sent, and `run` refuses
     any other count for a batch of reads as for a transition, so a read that
     got no answer throws and is never taken for no row. A result of a batch
     of reads that holds no list of rows is refused for the same reason.
   - One rule says who may hold the clock token. In a transition, only a
     compare-and-set may. In a batch of reads any read may, and because two
     statements of one batch see different clocks on a real backend, a second
     read of the clock owes `readTree` or `readPrepared` a reason why a
     disagreement between the two is harmless. No other read may give one,
     because a reason would outlive the read it excused, and a read is counted
     only after every other rule has admitted it. The sweep's two discovery
     reads give the one reason in use, `SWEEP_SCAN_DRIFT`: every item they find
     is checked again under its own fence. A clock called as a
     function node is outside the grammar whatever it is named, because the
     grammar lists the functions a statement may call and lists no clock. Raw
     fragment text is the one thing a tree cannot read, so it is scanned for
     the batch clock's text and for the clock spellings
     `scripts/clock-lint.py` lists, which include a date function called with
     no argument, SQLite's spelling of the current time, and the literal
     `'now'`, whatever function takes it. The tree's own list adds
     `fake_now_ms`, the column a store's clock reads under test, which a
     fragment could read with no clock call at all. That scan is a
     spelling proxy, confined to raw text, and a spelling nobody has listed
     passes it.
   - A statement holds no second definition of eligibility.
     `eligibilityDefinitionProblem` asks the rules `scripts/fragment-lint.py`
     applies to store SQL text of the tree, where a condition built from nodes
     is as visible as one written as text. A list that IN or NOT IN compares
     with a `state` column is one of the defined sets: the live, the queued,
     or the terminal states. It is read from nodes, or from a fragment's text
     with the binds the list takes, and the column is found bare or quoted in
     text, and through arithmetic, a call, or a cast in nodes. A list compared
     with a column of any other name is never read, and the refusal never
     quotes a value. The rule keys on the column's name, so it does read a list
     compared with `checkpoints.state`, which holds caller JSON. A JSON string
     carries its own quotes and cannot equal a state's name, so such a list
     names no state and is not judged. This half is a check of spellings. It does not read a set
     spelled as alternatives joined by OR, a chain of `<>`, CASE arms, the
     complement of a defined set, an array, or a join to a list of values, and
     the verdict tests run each of those as an exhibit that passes. The
     deadline half is a closed list: the only tests of `cancel_at_ms` a
     statement may build from nodes are IS NULL and IS NOT NULL. Any other
     operator is refused with the column on either side, through arithmetic, a
     call, or a cast, and a subquery is judged as its own statement. Each
     dialect compares the deadline in its own `cancelDue` and `cancelNotDue`
     fragments, which carry the bounds a stored deadline must be within, so a
     comparison written in a fragment's text is not read.
   - A follow-on may not assign a column a value that combines that column
     with an arithmetic or concatenation operator, or that hides it in a raw
     fragment. The rule reads an UPDATE's SET list and an INSERT's conflict arm.
   - A dialect's predicates stay store-owned SQL text and reach a shared
     statement as data: a fragment's text plus its binds. Core turns each `?`
     into a value node and each clock token into the clock node, so a
     fragment's placeholders equal its bound arguments by construction and the
     clock rules see a fragment's clock token. The batch still checks the
     compiled counts, because an operator or identifier built from nodes can
     add a `?`. A fragment may not hold a stamp or a fence, which the rules
     need as nodes. Its text is split without reading SQL beyond plain
     single-quoted literals, so a comment, a dollar-quoted or prefixed string,
     and a bind or clock token inside a literal are refused. The claim's
     candidate subquery is such a fragment, because libSQL bounds each state's
     leg before merging them and PostgreSQL locks candidates with SKIP LOCKED.
   - A fragment's role is declared where it is placed: a predicate that decides
     rows, the subquery a row must be IN, or a value. `FencedBatch` reads each
     raw node's position from the tree and refuses one that is not where it was
     declared, that stands in two places, or that `rawSql` did not mint, the
     builder's own ORDER BY direction aside. A predicate is a boolean of a
     WHERE, HAVING, ON, or CASE condition at any depth, and a subquery is the
     operand of IN, NOT IN, or EXISTS. A statement must place every fragment it
     takes. A predicate or value compiles
     inside parentheses, so an OR inside it cannot void the conjuncts around
     it, and a subquery must be one parenthesized group of its own.
   - Arithmetic on database time stays a store fragment beside the headroom
     guard that protects it, such as a lease deadline and its `leaseFits`. The
     guard and the write it guards are then read together, a dialect keeps its
     own casts, and the mutations that cap the sum or weaken the guard own both
     as SQL text. Core does not fix such a sum as nodes.
   - Activation and the launch deferral act on a claim receipt. Both apply one
     core helper: the receipt's identity, the generation latch, and the store's
     admission fragment, so a guard added for one reaches the other. The
     admission fragment is composed per dialect, and the corpus holds the
     dialects' copies to the same shape.
   - A tree statement compiles once, when it is added, so what was checked is
     what runs.

   `packages/conformance/corpus` records every statement a tree-built label
   compiles to, per dialect, and a conformance case compares the builder's
   column descriptor with every dialect's catalog. `FencedBatch` has no text
   path: every statement it holds is a tree, its constructor's type requires
   the dialect that compiles one, and the scanners that read a
   statement's text are deleted. A batch reads a statement's object graph
   once for all of its checks. `scripts/fragment-lint.py` and
   `scripts/clock-lint.py` still read every store source file whole, because
   two kinds of text reach no tree rule. One is the statements no tree holds:
   `expire-lease-now`, `driver-heartbeat`, and the admin's statements. That
   text is one list, `scripts/text-statements.json`, with the reason each
   statement cannot be a tree. `scripts/batch-lint.py` classifies a store's
   raw batches from it, and `packages/conformance/test/text-statements.test.ts`
   fails when a store's source, or a store on a real backend, sends SQL text
   under a label that is not on the list, and when a listed statement is no
   longer sent. The other is a comparison hand-written inside a fragment. A
   tree carries a fragment as text, and `eligibilityDefinitionProblem` does
   not read a comparison written there, so `fragment-lint` is what refuses a
   cancellation deadline compared outside `fragments.ts`. The lints read a
   file and not a call, so text that a raw batch sends is read wherever in
   the file it is written. A store's reads are batches of reads built as
   trees. `heartbeat` is a fenced batch of two trees on every dialect, the
   shape MySQL needs because it has no RETURNING: the compare-and-set extends
   the lease and stamps the run, and a gated read subtracts the two instants
   it stored, so the remainder reads no clock. The three that remain are
   writes that stamp nothing, which `FencedBatch` does not have:
   `expire-lease-now` may change one column of a run and no provenance, and
   `drivers` and `meta` carry none. The lints' rules have a tree-level form
   for everything a tree holds, and the two scans stay for that text.
2. **`awaitEvent`/`emitEvent` must be atomic AND mutually exclusive.** The
   read-branch-write shape across client round trips loses the wakeup if emit
   interleaves (emit flips waiters exactly once). Realization is per dialect:
   on SQLite/Turso, ONE batch with the branch folded into WHERE guards
   (sentinel insert; register wait `… WHERE (SELECT payload FROM events WHERE
   name=:e) IS NULL`; sleep the run under the same guard; checkpoint `… WHERE
   payload IS NOT NULL`; final SELECT tells the SDK which branch won) — the
   single writer serializes it. On Postgres/MySQL a batch is NOT serialized
   against emit, so the batch carries a lock coordinate and the executor takes
   it first: a row lock inside the transaction on PostgreSQL, and a session
   named lock around the transaction on MySQL.
   `FencedBatch.lockEvent({ queue, eventName })` carries only that closed lock
   coordinate — never caller SQL — to the dialect executor, which acquires it
   before the first fenced CAS and holds it through commit or rollback. The
   executor binds both coordinate values as data, returns no result slot for
   the prelude, and matching event coordinates are mutually exclusive. A
   dialect may realize the coordinate with a durable sentinel row, as
   PostgreSQL does, or with a named lock the session takes before the
   transaction starts and releases after it ends, as MySQL does. MySQL's named lock
   waits at most 30 seconds, for the event, claim, and migration locks alike. A
   batch that cannot take its lock in that time has written nothing and fails
   with `StoreUnavailableError`, which a caller retries like any outage.
   PostgreSQL's row lock has no bound of the store's own. Any further
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
   MySQL `NOW(6)` is (it is the statement's start time), and so is
   `UTC_TIMESTAMP(6)`, which `store-mysql` uses because it does not depend on the
   session time zone (measured identical on both sides of a `SLEEP` inside one
   statement), and `SYSDATE()` is NOT;
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

   **One exception: `retryTask` revives a failed task in place** (Absurd's
   `retry_task`, TLA action `RetryTask`). It is an operator action on a task
   whose state is `failed`, and nothing else may leave a terminal state. It
   inserts a new pending run due now, with the next ordinal after every run the
   task has, and returns the task to `pending`. A task that failed at the
   infrastructure-retry or relaunch cap has a top run no counter recorded, so
   the revival charges that run as a user attempt, keeping attempts plus
   infrastructure retries equal to the top ordinal (TLA `AccountingBand`).
   That charge never exceeds the budget (TLA `FailedChargeWithinBudget`), so
   the budget grows by one, which for a task that failed on its budget is
   Absurd's default of budget plus one. The revival run carries the top run's
   parked wake like every successor. The revival clears the task's failure
   reason. Every failed run stays failed, and infrastructure retries, the
   first-start latch, and the cancellation deadline are untouched, so a revived
   task past its duration limit is cancelled by the next sweep. A completed or
   cancelled task is never revived, and neither is a failed task whose outcome
   or counters are corrupt: a missing reason, a completed payload, a counter or
   run ordinal that is not an exact integer in range, a budget that cannot take
   one more, or a charge outside the accounting band or past the budget.
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
   A version read never reports a concurrent bootstrap's metadata table
   without its version row, and each dialect's adapter owns the means.
   PostgreSQL resolves a name against the newest catalog, so a read under a
   REPEATABLE READ snapshot, which is taken first, can see the table and not
   the row. Its adapter reads the version under READ COMMITTED, where the
   snapshot follows the name lookup, and so has the property. SQLite commits
   schema and rows under one snapshot and has it. MySQL commits each DDL
   statement on its own and does not have it from isolation alone: a bootstrap
   written as a CREATE and then an INSERT leaves the table committed and its row
   not yet. Its adapter therefore writes the bootstrap as one statement, `CREATE
   TABLE … AS SELECT`, which commits the table and its version row together and
   inserts nothing over a table that is there, and reads the version under READ
   COMMITTED, because a consistent snapshot is older than its statement and MySQL
   refuses to read a table defined after the snapshot. Measured over 250 cold
   starts with six racing readers: two statements gave 765 rowless reads and the
   snapshot gave 1500 refusals, and one statement under READ COMMITTED gave
   neither.
   Concurrent cold-start migrators converge: after an error from bootstrap or
   a versioned migration batch, the loser re-reads the authoritative version
   and treats the write as complete only when metadata now exists at or beyond
   that batch's target. An absent or behind version rethrows the original
   failure; `IF NOT EXISTS` alone is never the concurrency mechanism.
   Malformed dialect-returned values are described only by non-coercive storage
   kind; diagnostics may not invoke serialization or user hooks and change the
   permanent `SchemaMismatchError` classification.
10. **A durable identifier holds 255 characters, on every dialect.** The
   identifiers are a queue, a task id, a run id, a driver id, an idempotency
   key, an event name, a step name, and a checkpoint name. A character is a
   Unicode code point, which is how MySQL counts a `VARCHAR`. It is not a
   UTF-16 unit and not a byte: 255 characters outside the basic plane are 510
   units and 1020 bytes, and they fit. The width is MySQL's, which cannot index
   unbounded text and indexes nothing wider. The engine behaves identically on
   every dialect, so the narrowest dialect sets the width for all of them, and
   core holds it once (`IDENTIFIER_CHARACTERS`, `requireIdentifiersFit`). Every
   entry of the port holds every identifier it is passed to the width first,
   before any statement is sent, and refuses a longer one with
   `InvalidDurableStringError`, whatever the excess is, trailing spaces
   included. A driver holds its queue and its id the same way when it is
   constructed, because a refused tick reads as an outage and a refused
   registry beat is swallowed. A task name, a claim token, and a payload are
   not identifiers: nothing indexes them, and the port does not bound their
   length. A child's task name is still bounded through `ctx.spawn`, which
   stores the spawn under a key built from the name (below).

   The width also holds the names the engine derives from an identifier, which
   are longer than it. Each is refused at the call that passes the identifier,
   and the refusal names what the caller passed and never the derived name.
   - An awaited child task id holds 244 characters at the port, because its
     completion event name, `$task-done:` and the id, must fit.
   - A child spawn's replay key is held as the child key that is stored:
     `$spawn:`, the length of the parent task id, the id, the replay key, and
     two colons. Under a 36-character parent id that leaves 208 characters.
     The parent's task id is held through that key, and the parent's queue and
     run id are held on their own.
   - A registered saga step's key holds 239 characters (§3.10). A step's
     checkpoints are named by a prefix and its key, and the longest prefix is
     `$rollback-tries:`, 16 characters. The key is held where the step starts:
     a start marker, `$started:` and the key, is refused past 239 at the
     entries that carry a checkpoint name. `$started:` is the shortest of the
     saga names, so a key held only to the width there, 240 to 246 characters,
     would start, and the batch that fails its rollback could never store the
     attempt record. A step's other saga names are held to the plain width,
     like any checkpoint name. A step that started under this rule has room
     for them, and one that started before it must still be able to record
     that its rollback ran (below).

   The SDK stores a task's names under keys of its own, and holds each key
   where it builds it, to the same constant. A repeated step name is
   `name#<count>`, an await is `$await:` and the event name, a child await is
   `$await-task:` and the child's id, a spawn is `$spawn:` and the child's task
   name, and a step that registers a rollback has the 239 of its saga key. So
   through the SDK an awaited event name holds 248 characters. An awaited
   child id holds 243, one fewer than at the port, because the SDK's prefix is
   one longer. A child task name holds 201 on the first spawn from a call site
   under a 36-character parent id, which is what the stored child key leaves
   its replay key. An emitted event name has no key and is held as it is. A
   key past its room fails the task for good, with a `FatalTaskError` that
   names what the task passed, before the step's body runs and before any
   store call, and it is never retried. A child task name is the one
   exception to where and how. The SDK holds only its own key, `$spawn:` and
   the name, and the longer child key is built and held by the store. So a
   name past its 201 is refused by `spawn`, in a message that names
   `childOf.replayKey`, and `ctx.spawn` turns that refusal into the same
   permanent failure on the first pass. The store's own refusal would be
   retried: the SDK reads it as an ordinary failure, so every earlier side
   effect would run again on each attempt until the budget was gone.

   The rule is held on the way in, and nothing rewrites a row. A row written
   before the rule can hold a longer name only on libSQL or PostgreSQL, since
   MySQL never could. What is already stored still works where the engine
   hands it back, and is refused where a caller must pass it in again.
   - A key that is already stored as a memo replays, because nothing is
     written under it again. The SDK looks the memo up before it holds a key,
     so a task in flight under a longer step name finishes. A read returns a
     longer checkpoint name, and the port's `complete` still ends the task.
   - A step that started and never persisted is stored too, as its start
     marker, but its body runs again and its result must then be written under
     the same key. It is excused the 239 of a saga key, which its stored
     marker already passed, so under a stored key of 240 to 255 characters it
     runs again and completes. It is still held to the width: under a longer
     key the task fails for good before the body runs again, because the
     write that would follow can never succeed. The pass that follows still
     runs the rollback the first body is owed, once, and cannot record it.
   - A saga in flight under a step key of 240 to 245 characters still rolls
     back, records that each rollback ran, and ends with the failure that
     began it. It cannot record a rollback that fails, because the attempt
     record, `$rollback-tries:` and the key, is past the width: such a saga
     ends failed in one pass, with a failed rollback outcome and the store's
     refusal in place of its cause. Under a key of 246 even a rollback that
     succeeds cannot be recorded, because `$rollback:` and the key are 256
     characters: the rollback runs once, its record is refused, and the saga
     ends the same way.
   - An await parked under a key past the width, which takes an event name
     past 248, cannot record its wake, so its task fails for good when it
     wakes.
   - A longer idempotency key is no longer deduplicated, a longer checkpoint
     name cannot be written again, and a wait on a longer event name can no
     longer be woken by an emit.
   - A task in a longer queue is out of the port's reach, because claim,
     sweep, read, and cancel all refuse its queue, until its rows are renamed
     in SQL. The invariant library reports each such row, and any other stored
     name past the width, as `identifier-over-width`. That is a check of the
     table snapshots that tests, sims, and fuzz walks read. It is not an admin
     check: nothing reads the length of a name in a production database, and
     no command lists such rows.

   This is what holds it. The `identifier-bound` conformance surface runs on
   every dialect: a table typed by the port, so a method without an entry does
   not compile, with a call for each place an identifier enters each method,
   refused before anything is sent; the code point count; each derived name at
   its last fitting length and one past it; and the longest names that fit,
   stored and read back exactly as they were passed.
   `packages/sdk/test/identifier-width.test.ts` runs on libSQL and PostgreSQL:
   each SDK key one past its room fails its task on the first pass, and the
   task and the saga in flight finish. Two cases in `legacy-rows.test.ts` hold
   the readable row and the unreachable queue at the port, and the violations
   the invariant library reports for exactly those rows. The
   replay-equivalence harness runs every generated call that passes a name
   with a name one character under its room, at its room, and one past it,
   each room computed from the width and what the engine adds to the name:
   under and at its room a program replays like any other, and past it the
   task fails for good before the body runs, and the SDK then makes no store
   call but the one that records the failure. That harness and the table case
   of `identifier-width.test.ts` take every length from one table of what the
   engine adds to a name, `packages/sdk/test/name-rooms.ts`. The invariant
   library's `identifier/over-width` condition is this rule's executable twin
   on libSQL and PostgreSQL, whose columns do not bound a name. It reads every
   identifier column of the six table snapshots, counted with core's function.
   Its inventory of columns is described with the invariant library, below.
   The operation fuzz passes the port names one character past the width,
   drawn from a random stream of its own so that no other op's draws move, and
   leaves an accepted one for the condition to report at the walk's next
   check. It is the one op that builds a name that long, so it is what lets
   the condition fail in a walk. Two registered mutations keep the audit checking
   that these two generated surfaces can fail: one of the SDK's hold names the
   harness as the test that catches it, and one of a store entry's hold names
   a pinned case of eight such walks.

**Refused-write contract (AB001 and AB002):** a refused worker write
(`complete`, `fail`, `reschedule`, `suspendRun`, `setCheckpoint`, `awaitEvent`,
`awaitTaskDone`, `deferLaunch`) reads its run's state only after the refusal
(`refusal-state`), so a write that wins pays for no refusal read. The one read a
winning `complete` or `fail` can pay is its run's task (`run-task`, §3.2), and
only in a store that did not activate the run. It throws `RunCancelledError` (AB001)
when the task's cancellation ended the run and `LeaseLostError` (AB002)
otherwise, including when that read fails. `heartbeat` reports `held: false`
with `reason: 'cancelled'` or `reason: 'lease-lost'`, from the same read. A worker retrying `complete` after a lost
response treats `LeaseLostError` as possible-prior-success: verify via
`getTaskResult` and exit (verify-then-exit), never re-execute.

**Task-result contract:** `getTaskResult` reports only outcomes the engine
recorded. A completed task carries its payload, a failed or cancelled task
carries its reason, and no other state carries either. A row that contradicts
this, names an unknown state, or lacks an outcome column is refused with
`RangeError`, never returned. Outside the stores, every production reader of a
task outcome selects `TASK_RESULT_COLUMNS` and decodes the row through core's
`decodeTaskResult`, so a second read path cannot report a row the store refuses.
`scripts/outcome-lint.py` refuses any other spelling of those columns in a
production TypeScript source, with one exception: core's shared statements and
their column descriptor may name one as an object key, the column a statement
assigns or the descriptor lists. A property read, a selected column, and SQL
text are refused there too. The conformance harness reads raw task state as
its oracle, and the engine invariants report each rule a task row breaks as its
own condition.

**Event-wake disposition:** a carried wake (`wake_event`/`event_payload`) is
CONSUMED by the transition that ends the attempt that processed it
(`complete` and `reschedule`); it is CARRIED to
failure successors (`fail` retry, sweep claim-timeout — §3.8.2, the attempt
never processed it); it is PRESERVED by the rolling-deploy deferral (`deferLaunch`, §3.2: a worker
that cannot dispatch the task consumes nothing).

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
- *The self-concurrency surface* (`conformance/src/self-concurrency.ts`): every
  call of the store's two ports raced against copies of itself, on every
  dialect. A call that is safe alone can be unsafe beside itself under a
  server's locking. Two such defects were found by hand, a migrator that read a
  concurrent bootstrap half done and driver heartbeats that deadlocked on each
  other's rows, and each got a case for its one transition, so the class stayed
  open. The contests are generated from two tables typed by `SchedulerStore`
  and `StoreAdmin`, `migrate()` included, so a port method without an entry,
  or with an entry that holds no state, does not compile. An entry arranges a
  state in which its call is legal. The contest runs four copies one at a time
  and then four at once, from the same state on two fixtures of one seed, with
  a connection opened for each copy before the race, because a handshake inside
  it puts the copies one after another. It holds that the race answered what
  this build's own serial order answered, left the rows it left, violated no
  invariant, met no outage, and met no deadlock victim (§3.2, the executors'
  deadlock count). That serial order is the only oracle. The contract is not
  consulted, so an answer that is wrong in both orders passes: a review made
  libSQL's `cancelTask` answer true every time, and its contest stayed green.
  The scheduler suite's own cases hold the answers. Ids and tokens drawn during
  the contest are set aside, because which copy wins is not decided. That also
  sets aside a link between two rows the contest itself wrote, which the
  invariant checkers hold, because they read the rows as they are. A contest in
  which no copy answers anything and nothing the store holds changes fails.
  That floor reads the six tables, the schema version and the engine's clock,
  because nine calls of the ports answer nothing when they succeed. A claim may
  come back short of what is due, so the claimers' contest holds that no run is
  claimed twice and that one more claimer can take what the others did not, and
  not how the runs were split. With the heartbeat's fix reverted the surface
  fails 10 runs of 10 on MySQL. It does not reach the migrator's race: with
  that fix reverted
  it passed 300 rounds at four migrators and 200 at eight on PostgreSQL, and
  150 each on MySQL and libSQL with their own fixes reverted. Ordering that
  race takes a lock held inside one server, which
  `postgres-bootstrap-window.test.ts` does for PostgreSQL and a shared surface
  cannot. A race cannot own a mutation's verdict, so the surface owns none.
  The property held is each call beside ITSELF. The wider one, that a call is
  safe beside its neighbours, is not held here. Both lock-order inversions
  found on PostgreSQL were pairs of different calls, a cancel beside a child's
  `complete` and a cancel beside a worker write that ends nothing, and
  `postgres-lock-order.test.ts` holds those two by holding the window open
  inside the server, under a registered mutation. Other pairs of different
  calls stay with the fuzz and the fault matrix. On libSQL two calls interleave
  only between batches, because one connection runs a batch to its end.
  Measured there: in 24 of the 37 contests every copy sends one batch, so both
  orders send the same batches in the same order, and on libSQL those contests
  can fail only on an invariant, an outage or the idle floor, and never on a
  race. In 10 the only second batch is a loser's read of why it was refused.
  In three a writer sends several batches, and a race can change the outcome:
  `sweep`, `awaitTaskDone` of a child that has not ended, and `migrate`. The
  surface costs 1.8 s of test time on libSQL, 6.6 s on PostgreSQL and 6.0 s on
  MySQL on a shared machine, and 1.8, 8.5 and 7.1 s at a load average of 45 to
  58, about half of it the two fixtures each contest migrates. CI's `verify`
  job, which runs the libSQL and PostgreSQL legs, took 1,482 s on this work's
  first head, with the surface in it. Against the rule for that job's 90 minute
  limit the figure is a recorded 1,767 s, the slowest run the PR3.13 entry
  records, plus a projected 21 s, which is twice the larger local figure: three
  times 1,788 s is 5,364 s of the limit's 5,400.
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
  one of 115 typed condition IDs for every semantic arm. The eight durable
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
  never by a second hard-coded positional table list. One identifier inventory,
  `IDENTIFIER_COLUMNS`, names every column of those tables that holds a durable
  identifier (§3.4 rule 10): it selects them into the snapshot, the `identifier/over-width`
  condition reads each, one checker case plants a name past the width in
  every one, and a test holds every VARCHAR column of MySQL's schema, by name
  and width, to that inventory or to a short named list of bounded columns
  that are not identifiers. The test's reader refuses a migration statement
  that types a VARCHAR column it did not read.
  Generated just-over-bound witnesses, along with the ownership witnesses,
  keep the poison matrix complete. The poison surface crosses the 21 classified
  write labels with 146 corrupt-state witnesses covering that exact
  condition inventory: 3,066 generated cells,
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
- *The stale-token column* (`conformance/src/stale-token-column.ts`): a worker
  write is fenced on the claim its caller presents (rules 4 and 5), and each
  compare-and-set composes that comparison by its own choice. The rules that
  read a batch read the fences between its statements, not which binds a
  statement compares, so a statement that leaves the token out passes them.
  Stale-caller tests were written by hand, one operation at a time, and
  `failRollback` had none: with its token comparison removed a stale caller
  ended a saga while the whole libSQL conformance file stayed green. The
  column generates the cases. It calls the poison matrix's `invoke` for every
  write label, over every shape of target `invoke` tells apart, on a store
  that records the call, and it enrolls a call exactly when the call carries
  the target's claim token or generation. A new label that presents a claim
  gets its case unlisted, and a label that presents none cannot be listed.
  Thirteen calls are enrolled. Activate and defer-launch present the token
  and the generation of a claim receipt. Heartbeat, reschedule, suspend,
  await-event, record-task-done, complete, fail, fail-rollback,
  expire-lease-now, set-checkpoint, and the spawn of a child present the
  token. `claim` presents a token of its own making and no claim it must
  hold, so it is outside. A case seeds the call's healthy target from the
  poison matrix's own seeds, makes the call as callers that do not hold the
  claim, and requires the port's lost-lease answer and six unchanged tables.
  The answer is `LeaseLostError`, or, where the method answers in band,
  `null` from `activate`, `false` from `expireLeaseNow`, and a lease reported
  lost from `heartbeat`. Then the same call under the claim itself must win.
  That is what makes a refusal the lease's: with `fail-rollback` seeded
  outside the rolling-back phase, the refusal and the unchanged rows held with
  the token unfenced, and the case failed only at the holder's call. The
  stale callers are chosen against what a statement can spell. The statement
  grammar lists no function, so a comparison that folds the token's case or
  reads part of it cannot be written: a call of `lower` is refused when the
  batch is built. An ordering comparison can be written, and it admits every
  value on one side of the claim's: with `<=` in place of `=` in the shared
  claim predicate, a column that presented two arbitrary tokens stayed green.
  So the token is presented with its last character dropped and with one
  added, beside the token of another live claim in the queue, which a
  comparison that asks whether any run holds the token would admit. A
  receipt's generation is presented from the claim before and from a claim
  not yet made. The lease sweeps present no token and act on the claim their
  scan read (the shared statements, above), so their two cases run the sweep
  over a scan that reports the run one claim later, require that nothing is
  swept and no row moves, and then require the honest sweep to act. A typed
  record asks
  every `sweep:` label whether its scan hands it a generation, and each case
  checks that answer against the scan the store sends. Seventeen registered
  mutations, one for each comparison of each call, remove it from the
  statement the call sends, and the enrollment case holds the marker tables
  to the derived column, so a call that joins the column fails there until
  its mutation is registered. What the column cannot see, written and run. It
  sees the calls `invoke` makes. The spawn of a child was the one token-taking
  call `invoke` did not make: with the parent's token comparison removed from
  the spawn statement alone, the column without that call passed 16 of 16
  while a hand-written case failed. `invoke` now makes that call, and an
  inventory of target shapes, whose type asks every optional field of a target
  for its shape, keeps a second such argument from arriving unseen. A
  token-taking argument that `invoke` never passes is still outside. It makes
  each call once, with one set of arguments, from one seed: the immediate
  chain, a `reschedule` with no delay, shares the park's statement and keeps
  its hand-written case. It samples the callers and does not prove equality,
  and a sweep's scan is presented from one side only. The column costs about
  0.4 s of test time on libSQL and about 1.4 s on PostgreSQL and on MySQL, on
  a shared machine.
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
  The verifier runs only the registered tests of the mutations it checks, so
  collateral counts failures among those tests. A mutation runs only its own
  test, so collateral is rare, and whole-suite collateral is no longer measured.
  A registered test that did not pass or fail in the report is a suite error,
  never a survivor.
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
  mutant-syntax cases, and four live-enrollment attacks across every live
  mutation. A separate generated coordinator surface injects 40 faults
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
| claim core stmt | `UPDATE…WHERE id IN (SELECT…LIMIT k) RETURNING run_id,…` (single-writer = no skip needed), inside the fenced claim batch (rule 4) | READ COMMITTED; the shared claim `UPDATE`, its candidates a derived table of one `FOR UPDATE SKIP LOCKED` leg per state; no RETURNING, so the receipt is the batch's own read by token | `FOR UPDATE SKIP LOCKED` CTE only (Absurd's SQL — the bare `UPDATE…WHERE id IN (subselect)` shape double-claims under concurrent EvalPlanQual re-checks) |
| atomicity | `batch(…, 'write')`; **never** interactive tx (5s cap) | short tx (READ COMMITTED) for every multi-statement transition — autocommit only for genuinely single-statement ops (20s PlanetScale cap is ample for 2–3-stmt claims) | normal tx |
| timestamps | INTEGER epoch-ms | BIGINT epoch-ms | BIGINT epoch-ms |
| hot index | partial index OK | composite `(state, available_at)` only | partial index |
| upsert | `ON CONFLICT` | `ON DUPLICATE KEY UPDATE` (any unique key!) | `ON CONFLICT` |
| ids | UUIDv7 client-generated (time-ordered; Absurd orders by run_id) | same | same |
| scale-out | DB-per-tenant/queue via Platform API (free, ~100ms create + ~2.5s data-plane readiness gate — see §5) | vitess sharding | partitioning (Absurd has it) |

**What MySQL 8 makes a store do (measured against 8.4 by `store-mysql`).** Every
shared statement tree and every labeled batch runs on MySQL from the same tree.
None needed a change to a tree or to the checker. Each difference below is
realized in the store's compiler, executor, fragments, or schema:

- **A single-table `UPDATE` assigns left to right**, and a later assignment
  reads an earlier one's new value, where the standard and the other two
  dialects read the row as it was. `SET n = n + 1, due = f(n)` computes `due`
  from the new `n`. The compiler orders a SET list so every assignment that
  reads a column comes before the one that writes it, and refuses a cycle. The
  upsert arm has the same rule, and there the conflict condition rides in each
  assignment as `IF(condition, value, column)`.
- **A subquery may not read the table its statement writes** (error 1093)
  unless the read goes through a derived table. The compiler wraps a self-read
  built from nodes, and the fragments put theirs in a derived table that
  carries the correlation, so MySQL materializes one task's runs and not the
  table. `LIMIT` directly inside `IN` is refused too (error 1235), and the same
  derived table answers it.
- **A locking read locks what it scans, before any sort or `LIMIT`.** With both
  claimable states in one leg and the task joined, a claim of two locked all
  forty due runs and a concurrent claim found none. With no locking read at
  all, the second claim waits for the first's row locks, re-checks only the id
  list, and overwrites the first claim. Each state is therefore its own
  index-ordered `FOR UPDATE SKIP LOCKED` leg, which locked exactly the runs it
  returned.
- **Rows written.** MySQL reports rows changed, where the port means rows
  matched, and counts an upsert that updated as two. The executor runs without
  `CLIENT_FOUND_ROWS`, so an upsert whose conflict arm changes nothing reports
  zero, and normalizes the rest from the server's own `Rows matched:` and
  `Duplicates:` lines. A single-row upsert that updated carries no such line
  and reports two, which the executor counts once. A `DELETE` carries no such
  line either, so that rule reads the statement and applies to an `INSERT`
  alone. The flag is part of the handshake and mysql2 turns it on by default,
  so a pool the application owns is refused unless it connects without it.
  The session settings are sent once for each physical connection. The store's
  own pool therefore never resets a connection on release, and a pool the
  application owns is refused if it does, because a reset clears the settings
  and every later write would run at REPEATABLE READ with no strict mode. For
  the same reason, a pool handed to `fromPool` must not have its session state
  changed by anything else that uses it: the store does not send the settings
  again.
- **A write with no index to find its rows locks every row it scans**, under
  READ COMMITTED too, and waits on rows other transactions hold. The driver
  registry's cleanup was such a `DELETE`: 171 of 200 concurrent beats
  deadlocked, each waiting on the row another had just upserted. It now finds
  expired rows with a `FOR UPDATE SKIP LOCKED` read in a derived table kept
  materialized, and deletes them by primary key with the expired rows first in
  the join. It waits on nothing, and measured 0 deadlocks of 200. The same
  read under `IN (...)` let the `DELETE` scan, and 22 of 200 still deadlocked.
- **A keyed `UPDATE` whose keys come from a subquery is run as a scan when the
  table is tiny, and then locks every row.** Open, and measured on MySQL 8.4.
  While `runs` holds five rows or fewer, the claim's `UPDATE runs ... WHERE
  run_id IN (candidates)` is planned as a scan of `runs` with the FirstMatch
  semijoin strategy, and that one statement holds an X record lock on every
  row of `runs`. From six rows the plan is the materialized candidates and
  then `runs` by primary key, and it holds the claimed rows alone. It follows
  the size of the table, not the number of due runs. A claimer already holds
  the run its locking leg chose, so two claimers each wait for the other's row
  and InnoDB rolls one back. With four claimers at limit 1 over four due runs,
  one run of four was claimed in 20 runs of 20, and the executor counted
  victims in 17 of the 20: one run met one, two met two, and fourteen met
  three. In 300 more rounds, run by a review, 61 met none, 36 one, 30 two and
  173 three, and none met more. No run is claimed twice or lost, and a
  short claim is legal, so the cost is throughput and retries for a database's
  first five runs, and for every table of the conformance suite. The
  self-concurrency surface found it. Two fixes were measured to give the
  production plan and one lock on a four-row table: `FORCE INDEX (PRIMARY)` on
  the `UPDATE` target, and `/*+ SEMIJOIN(MATERIALIZATION) */` in the candidate
  subquery, which core's rule against a comment in a SQL fragment refuses
  today. The fix is planned (BUILD.md, PR4.4e). Until it lands, the MySQL
  fixture excuses the deadlock count of that one contest, up to a bound, and
  nothing else: the contest still holds its answers, its rows, and the
  invariants. The bound is eight, four copies times the two attempts a copy can
  lose without an outage, against a measured most of three. If
  `conformance-mysql` ever fails on that contest with `outages` that is not
  empty, a claimer was the victim on all three of its attempts, and that is
  this same defect: it happened in none of the 320 rounds. PR4.4e deletes the
  fixture's entry, the fixture member that holds it, and the special case that
  reads it in the surface's final expectation.
- **`MIN()` is not answered from an index once another predicate stands beside
  it.** The next-wake read walked 1207 rows of a 1200-row queue. Each wake
  source is now the first row in index order of one state, with the index
  named, and walks fewer than 20. The store has its own measured plan tests,
  `query-plans.test.ts`, which read the session's handler counters around the
  exact production SQL.
- **No RETURNING.** That is why `heartbeat` is a fenced batch of two tree
  statements, on every dialect: the extension stamps the run, and the
  remainder is read under that stamp from the two instants the extension
  stored, so it reads no clock. The statements are core's, shared by all
  three stores.
- **DDL commits on its own**, so a migration batch is not atomic and a
  sentinel row cannot roll one back. The bootstrap is one statement, so the
  version table never exists without its row (rule 9). Every migration
  statement is safe to repeat, so a migrator that died halfway leaves work a
  rerun finishes, and migrators take turns under one named lock. A rowless
  version table is a foreign database on the first read, as on every dialect.
- **The schema.** An indexed string is `VARCHAR(255)` under
  `utf8mb4_0900_bin`, which is case, accent, and trailing-space exact. MySQL
  cannot index unbounded text, and that is where the width of a durable
  identifier comes from (rule 10). Core holds the width for every dialect, and
  this store imports it for its columns and keeps no check of its own. What
  stays here guards the column and not the contract: MySQL refuses most excess
  with error 1406, which the executor reports as an invalid durable string and
  not as an outage, and it cuts excess that is only trailing spaces with note
  1265 in every `sql_mode`, where the cut value is a different identifier. The
  executor refuses any write that raised that note, and its transaction rolls
  back.
  Payloads, the claim token, and the statement stamp are `LONGTEXT`. There is
  no partial index: a unique index already holds NULL keys apart, and the hot
  indexes lead with the state after the queue, `tasks_cancel` included, because
  a failed task keeps its deadline and would otherwise be walked by every sweep. `key` is a reserved word, so every statement
  over the version table quotes it.
- **A BIGINT column rounds a fraction** where PostgreSQL refuses it, in strict
  mode too. The column still cannot hold one, and the conformance fixture shows
  that by writing a fraction to the real column and reading it back.
- **JSON.** MySQL keeps the last of two members with one key, as `JSON.parse`
  does, and cannot ask whether a key occurred twice. The stored-JSON guards
  therefore read the member the decoder reads, and do not refuse a repeated
  key as the other dialects do. `JSON_VALID` is tested before any JSON function,
  because those raise on text it answers false for.
- **`||` is OR** under the store's fixed `sql_mode`, so a string is built with
  `CONCAT`. One saga fragment builds a name, a rollback's from its step's, and
  it is the only line of the saga protocol this store spells differently: the
  325 lines sagas added to the PostgreSQL store are in this one verbatim, and
  so are 64 of the 67 lines of saga fragments. That one operator is why the
  saga fragments stay in the stores and are not hoisted into core.

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
   counts only user-code failures. Successor runs carry forward core's
   `SUCCESSOR_CARRIED_RUN_COLUMNS` (the run-DB pointer, `wake_event`,
   `event_payload`, and `wake_step`) on **every** path that creates one (the
   sweep, the worker-side fail-with-retry, and `retryTask`'s revival from the
   task's top run). Every other runs column a successor sets for itself: its
   identity and attempt, its state and availability, `created_at_ms` at the
   parent's failure instant (a revival's own instant), fresh claim,
   lease, heartbeat, and relaunch fields, no outcome, and its own fence stamp.
   The conformance case "both successor paths carry every inherited run
   column" classifies every runs column as one or the other.
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
   `awaitTaskDone` (the same registration for a child's completion event, §3.2),
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

- **Trigger**: rollback runs only when the task's terminal failure is decided:
  its retries are exhausted, it threw FatalTaskError, or a sweep failed it at
  an infrastructure cap (decided below). An error the user code catches and
  survives never triggers rollback, and neither does a cancellation.
- **Eligibility & order**: every started-or-completed step that registered a
  rollback is eligible (the handler receives `{ output, error, ctx }` with
  `output === undefined` when the forward step never persisted — handlers
  guard on it); handlers run in **reverse step-start order**.
- **Mechanics on this engine**: a saga's durable state is checkpoints under
  reserved names (core `sagas.ts`). A user step name cannot begin with `$`, so
  no step can take one. There is no schema change and no migration.
  - `$started:<step>` is a step's START marker, and its state is the step's
    ordering index. `<step>` is the step's storage key, which already carries
    `#<count>` for a repeated name.
  - `$rolling-back` is the phase marker. Its state is the failure that decided
    the task's end, which every rollback handler is handed as `error`. The
    task result reports the reason of the write that ends the task. The SDK
    passes the marker's failure when it finishes or halts a saga. A sweep cap
    or a cancellation that ends the task inside the phase records its own
    reason, and the store keeps whatever reason a caller of the port passes.
  - `$rollback:<step>` says the rollback of that step ran. It is the
    `rollback:<step>#<count>` step above, under the reserved prefix.
  - `$rollback-tries:<step>` holds a rollback's failed attempts,
    `{ tries, errorJson }`.

  On terminal failure the run enters the rolling-back phase; the task function
  re-runs, memoized steps skip and re-register their closures, and the SDK
  executes handlers as durable steps with their own `rollbackConfig` retry
  budgets on the normal claim/lease machinery. Crash mid-rollback resumes
  exactly where it died. This is strictly simpler than Cloudflare's
  replay-plus-RPC-stub reconstruction because re-execution is already our
  model.
- **Failure semantics** (matching Cloudflare exactly): a rollback step that
  exhausts its retries or throws FatalTaskError marks the rollback outcome
  `failed` and halts the remaining handlers; the task still terminates in
  `failed` either way. There is **no distinct "compensated" terminal state**.
  The rollback outcome `{ outcome: 'complete' | 'failed', errorJson }` is a
  separate field on the task result. Rollback handlers must be idempotent
  and use distinct idempotency keys (`<id>:rollback-<step>`).
- **Modeled first**: `specs/Sagas.tla` models the rolling-back phase ahead of
  its SQL, and TLC checks it. The model settles these points, and the
  implementation maps its batches onto the model's actions:
  - A step that registers a rollback writes a START marker, carrying its
    ordering index, BEFORE its body runs. A step commits only after its body
    returns, so without the marker a step that started and never persisted
    leaves nothing for a rollback to find. The index is first-write-wins: the
    SDK writes it only when the step has none, only the lease holder writes
    checkpoints, and the next index is one past the highest handed out. So a
    step retried by a later attempt keeps its place, and no two started steps
    share one. Steps do not start concurrently: a durable call made while a
    registered step is still writing its start marker is refused as a nested
    call, exactly as one made while a step's body runs, so two registered
    steps under `Promise.all` fail the task as two unregistered ones do. The
    model keys the index by saga generation because a fresh
    revival would forget it. Under the decision below no revival follows a
    saga, so a task has one generation and the key is not needed.
  - The terminal decision and the phase marker are ONE batch, whoever decides:
    the worker's `fail`, or a sweep. As two steps, a crash between them leaves
    a failed task that no worker will run again, and its rollbacks never
    happen.
  - Once the phase is entered no forward step starts or commits, and the task
    cannot complete. The next rollback is a function of durable state alone,
    the pending step that started last, so a pass that resumes after a crash
    derives the same sequence.
  - Rollback passes run after the task's user attempt budget is spent, so the
    phase admits runs past it. Each rollback's spent attempts are durable with
    the rollback, and they are never given back.
  - A rollback that fails for good ends the task in the batch that records
    its last failed attempt. A rollback is recorded as done only when its
    compensation happened. An infrastructure cap that ends a task inside the
    phase ends the saga there, and the outcome is `failed` exactly when a step
    that started is left uncompensated.
  - A cancellation in the forward phase triggers no rollback: only a terminal
    failure does.
- **The batches**, each mapped onto one action of the model. Nothing here is a
  new kind of statement: a rollback pass is the failed run's successor, and
  every saga checkpoint is an ordinary fenced checkpoint write.

  | Model action | Batch | What it does |
  | --- | --- | --- |
  | StartStep | `set-checkpoint` of `$started:<step>` | One SQL shape for every checkpoint. The phase predicate is one expression over the name. |
  | UserTerminal | `fail` with no retry, or with a retry the budget refuses | Places the rollback pass, writes the phase marker, and the task follows the pass. The terminal arm yields to the pass by id, so nothing ends. |
  | InfraCap | the cap arm of `sweep:lost-launch`, and `sweep:claim-timeout` at the infrastructure cap | The same three statements. The sweep reports `rollback-started`. Inside the phase each ends the task as it always did. |
  | RunRollback | `set-checkpoint` of `$rollback:<step>` | Admitted only inside the phase, and through no other batch: a suspension's marker is held to the same predicate over the name, and a suspension runs only before the phase. Any other checkpoint is admitted only before it. |
  | RollbackRetry, RollbackHalts | `fail-rollback` | Its own port method, `failRollback`, and its own label. The attempt record lands behind the failure. With a retry a pass follows, past the user budget. With none the task ends. Refused outside the phase. |
  | FinishSaga | `fail` with no retry, inside the phase | Ends the task with the reason the caller passes, which the SDK makes the failure that began the saga. |
  | Cancel | `cancel-task`, `sweep:cancel` | Unchanged. |
  | Revive | `retry-task` | Refuses a task whose saga began. |

  A failed rollback is a separate port method, not an option of `fail`, so that
  nothing which forwards `fail` can drop the attempt record, and because a
  batch label is one SQL shape: labels are the addresses the fault matrix and
  the poison matrix enroll by. `fail-rollback` is a terminal label, so the
  child-task cases, the PostgreSQL terminal lock case, both matrices, and the
  saga endings case each reach it from the list of terminal labels.
- **The forward phase is frozen by the store.** Inside the phase it refuses a
  forward checkpoint, a completion, a suspension, which commits a marker, and
  a wait registration, which would park the pass on an event that may never
  come. Two names are the engine's alone in either phase: the phase marker,
  which only the batch that decides a failure writes, and a rollback's attempt
  record, which only the batch that fails a pass writes. A lease holder's
  plain checkpoint write is refused both, and so is the marker a suspension
  commits for its caller. A rollback's name is admitted through a plain
  checkpoint write inside the phase and through nothing else: a suspension,
  which runs only before the phase, refuses it, because a rollback recorded
  that early leaves its step owed nothing when the failure is decided. The
  attempt record a failed rollback commits for its caller is refused every
  other name. Those are the three batches that take a caller's checkpoint
  name, and one conformance case holds the whole table: each of the three
  against every reserved name, in both phases, refused or admitted only in
  its phase. A reserved name is matched byte for byte on every dialect, so a
  name in another case, or padded with a space, is a plain name everywhere.
  The MySQL store casts the reserved literal to binary to get that, because a
  bind compared with a literal there takes the connection's collation, which
  folds case and pads spaces. So no caller of the port, a worker in another
  language included, can forge a saga, replace its cause, or spend a
  rollback's budget. `reschedule` and `defer-launch` stay open, because a build without
  the task's handler must still be able to defer a launch. The SDK never asks:
  the first durable call with no memo ends a pass's replay. An emit is the one
  durable call with no memo at all, and the store cannot freeze it, because an
  emit belongs to no run. The SDK freezes it: a rollback pass's replay emits
  nothing and goes on, so the steps after it still register their rollbacks.
  An emit the forward pass did reach is first-write-wins, so skipping it
  changes nothing. A rollback handler is a step of its own and may emit.
- **The completion event** is a task's first terminal outcome, so the batch
  that enters the phase writes none, and each batch that can end a task writes
  exactly one when it ends a task that is rolling back. A parent awaiting a
  rolling-back child sees nothing until the saga ends. One conformance case
  runs over every terminal label, and its list of endings is a record keyed by
  the label type, so a new terminal label does not compile until it says how
  it ends a saga.
- **Budget accounting.** A rollback pass is one ordinal past the spent user
  budget. The batch that places it sets the task's `max_attempts` to the
  pass's own user ordinal, derived from the failed run as `attempts` is, so
  every existing accounting invariant holds as it stands. The consequence is
  visible: `attempts` counts rollback passes. A task that failed on its first
  attempt and rolled back in one pass reads two attempts. An infrastructure
  retry of a pass spends none of it. A rollback pass replays as the run that
  failed: `ctx.attempt` reads that run's attempt on every pass, however many
  passes the rollbacks take, because a pass that replayed as a later attempt
  would find no memo for a step named after the attempt. A handler that names
  steps after the attempt still cannot register the steps of its earlier
  attempts, which no replay reaches. The saga compensates what it can in
  order and then halts, naming the step it could not reach.
- **The rollback outcome is derived, and stored nowhere.** When a task result
  is read, the outcome is `failed` exactly when a step that started has no
  `$rollback:` checkpoint, and `complete` otherwise, for an ended task whose
  saga began. `errorJson` is the attempt record of a rollback that did not
  run. It cannot disagree with the checkpoints, and no checkpoint of an ended
  task changes.
- **A saga with nothing to roll back skips the phase.** The task fails as it
  did before sagas, and its result carries no rollback field. The model calls
  that saga complete at entry and allows the skip. The engine records nothing
  for it, which is the one place it says less than the model.
- **The SDK.** A registered step writes its start marker and then runs. A pass
  replays the task function so every memoized step registers its closure with
  what it returned, and a step that started and never persisted registers with
  no output. However the replay ends, its ending means nothing: the failure is
  decided. One limit follows from replaying to register. A step that started
  and never persisted throws the engine's phase signal on a rollback pass,
  where its body threw its own error before: the body does not run again, and
  its error was never stored. A handler that caught that error and went on to
  start further registered steps must catch the signal too. If its `catch`
  lets through only its own error class, the replay ends there, the later
  steps register no rollback, and the saga halts as failed with nothing
  compensated, because no earlier step is compensated ahead of one that cannot
  be. The halt names both steps, whether or not the step that ended the
  replay registered a rollback. Storing the error would not close this: an
  error rebuilt from storage is no instance of the handler's class either.
  Then each rollback owed runs as a step of its own, the step that
  started last first. A failed rollback is counted with the failure and
  retried under its own budget, three attempts and the task's retry strategy
  unless `rollbackConfig` says otherwise. Four things halt a saga for good: a
  FatalTaskError, a spent budget, a saga checkpoint that cannot be read, and a
  step owed a rollback that the replay did not register, ahead of which no
  earlier step is compensated. Options that cannot be kept fail the task for
  good before the body runs and burn no retry. The worker reports
  `rolling-back`, `rolled-back`, or `rollback-failed`.
- **Rolling deploys.**
  - A worker of an older build that claims a rollback pass replays the task
    function as a forward pass. The store refuses what it tries to commit, so
    the lease story recovers the run, and the infrastructure cap bounds it and
    ends the saga where it stands. The body of the first step it has no memo
    for does run once more before its checkpoint is refused, as a step's body
    may on any retry. A failure it reports with a retry is capped like any
    other, which halts the saga.
  - A terminal failure decided by a build that predates sagas has no saga arm.
    The task ends, nothing rolls back, and the result carries no rollback
    field. The rollback stays owed: if the task is revived and a build that
    knows sagas decides its next terminal failure, the phase is entered.
  - A step that committed before its code registered a rollback has no start
    marker, so no saga knows it started, and it is not rolled back.
  - A task that failed before this build has no saga checkpoints, and nothing
    about it changes.
- **What it costs.** On PostgreSQL every failure sends one more query than
  before, nine where it sent eight, because the rollback pass is gated on the
  failure alone and so is sent, matching nothing when no rollback is owed.
  A completion and a checkpoint send what they did, eight and four. The store
  decides whether a rollback is owed from its own rows. A caller's hint that
  none is would be a second account of those rows, which a worker of an older
  build could not give. A test pins the count for each batch a saga touches.
  Every saga read reaches the checkpoints by primary key with the task bound,
  and query plan pins hold that over every statement of those batches.
- **A known limit.** The store records the attempt count the SDK hands it and
  does not check it against the last one, and nothing caps how many passes a
  task may take. Rollback budgets are the SDK's to keep.
- **Decided by the maintainer.** The model isolates three questions, each as
  one constant, and is checked under both answers. These are the answers the
  implementation is built under:
  - Cancelling a task that is rolling back HALTS the saga. The remaining
    rollbacks never run, and the outcome is `failed` exactly when a step that
    started is left uncompensated. A cancellation that lands after the last
    rollback records `complete`. This is what cancellation does to any live
    task.
  - `retry-task` REFUSES a task whose saga began. Reviving it without
    forgetting its rolled-back steps is unsound under any rule: the forward
    replay would skip memoized steps whose effects were compensated.
  - A task the sweeps fail at an infrastructure cap ROLLS BACK like any other
    terminal failure.

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
  (completion-event await + cross-queue refusal), step repeat counters,
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
