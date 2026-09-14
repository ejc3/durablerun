# Simplify / elegance backlog

A full-codebase simplify-and-elegance review pass (six area reviewers, each
finding adversarially refuted before it survived) ran on 2026-07-24 against
branch pr3.1. It confirmed 45 findings. The correctness-critical ones and
those inside the events PR's own new code were applied on pr3.1 (see below);
the rest are pre-existing structure that belongs in a dedicated
simplification PR, recorded here per the scope-reconciliation rule rather
than silently dropped.

## Status after the 2026-09-14 re-audit

The findings below were re-audited against `main` at `06bba58` before the PR3.5
sweep. Of the 40 deferred findings, 10 had already been fixed by later PRs, 6
had changed shape, and 24 remained; the audit found 5 more. This section is the
current record; the lists further down are the original 2026-07-24 findings,
kept as written. The file is deleted when every finding has landed or been
rejected with a reason (BUILD.md, current milestone, exit test 7).

**Already fixed by later PRs (10):** the wake expression block in
reschedule/suspendRun, the unused `MAX_EPOCH_MS`/`MAX_DURATION_MS`, the
checkpoint LWW tail, the unpinned `NEXT_WAKE_SQL`, `notYet()`, the waits-gone
DELETE, the reschedule/suspendRun wake decode and task mirror, the run-worker
pump-teardown race, the LIVE-state list in the invariant checkers, and the
CLAUDE.md confinement caps.

**Landed in PR3.5a:** the wake union named once (`WakeSpec`), the suspension
checkpoint pair named once (`CheckpointWrite`; `key` and `checkpointName` keep
their names because `key` is a property of the public `SuspendSignal`), the
heartbeat parameter renamed `extendLeaseSeconds`, the registry interval default
bound once, one `listenLocal` helper, `createWakeServer` taking only `wake`, the
chaos tests' database bootstrap through `openTestDb`, one `commitCheckpoint`
for steps and await markers, one `EventMemo` type and resolver, one
infrastructure-outcome mapping in `runClaimedRun`, and the stale TLC
configuration and `tla.sh` headers.

**Landed in PR3.5b:** the successor-insert columns built once in core
(`SUCCESSOR_PARENT_COLUMNS`), the spawn cancellation deadline bound once, the
spawn winner ordered by `attempt` alone, and `mapLimit` and `clampLimit`
hoisted into core.

**Rejected:** each with its reason in BUILD.md under PR3.5. PR3.5a rejected
five findings. PR3.5b rejected the task-liveness EXISTS guard wrapper, the
terminal-or-sole-live CAS wrapper, the stamped-fence helper, the persisted-row
decoder hoist, and the `sweepClaimTimeout` owner split.

**Remaining:** the conformance and fuzz items, for PR3.5c.

**Found by the re-audit (5), not in the lists below:**

- `runClaimedRun` repeated the lease-lost and store-outage mapping that
  `trustedStoreOutcome` owns. Landed in PR3.5a.
- `sweepClaimTimeout` spells the live-owner and terminal-owner split by hand
  while `sweepLostLaunch` names it once. Rejected in PR3.5b; see BUILD.md.
- `complete` and `fail` share a hand-written terminal-or-sole-live CAS wrapper.
  Rejected in PR3.5b; see BUILD.md.
- Two wake-accelerator vocabularies exist: core `WakeSignals` and driver
  `WakeRequest`/`WakeScheduler`. Rejected; see BUILD.md.
- `mapLimit`, `clampLimit`, `persistedRowInteger` and `decodeClaimedRun` are
  byte-identical in both stores. `mapLimit` and `clampLimit` landed in PR3.5b,
  and the two decoders were rejected; see BUILD.md.

**Applied on pr3.1** (commits `572ab84`, `1d68119`, and the events
mechanism commits):
- runClaimedRun: one `infraOutcome` classifier for all five transition
  catch sites, closing the two that dropped the store-outage arm and
  rethrew raw (landed red/green — a real latent bug); user-attempt ordinal
  derived once from `ctx.attempt`.
- Context: the consume-once wake is structural (`takeWake`), not a boolean;
  suspension docblock moved onto the method it describes.
- Fault matrix: `CLAIM_LIMIT` is one constant across workload and checker.
- Vacuous-green hole in the stale-token heartbeat test closed.
- The three simulated-exclusivity / successor-race loops now assert engine
  invariants at quiescence (the gate's Part 4 rule, previously skipped).

**Deferred to a dedicated simplification PR.** Grouped by area; `bug-risk`
items should be sequenced first. Each has been confirmed against the tree
(line anchors in the review record). None may merge or parameterize a batch
label, weaken a fence, or move dialect SQL into engine logic.

## core
- [bug-risk] core/src/types.ts — TaskResult permits impossible states; give
  it the discriminated-union treatment EventWake already has (completed →
  payload; failed/cancelled → reason; live → neither).
- [duplication] core/src/ports.ts — the `{ inSeconds } | { atEpochMs }`
  wake union is spelled inline six times across three packages; name it
  once (`WakeSpec`) in core.
- [duplication] store-libsql/src/store.ts — the wake expr+validation block
  is verbatim in reschedule and suspendRun; one dialect-side helper.
- [dead-code] core/src/ports.ts — `WakeSignals` port has no implementation
  and no consumer while the live /wake accelerator is an inline fetch;
  either wire it through the port or drop the interface until its phase
  (sibling ports EndingFeed/RunStateStore have no TS type yet — match that).
- [dead-code] core/src/retry.ts — `retryDelaySeconds` is exported but only
  its own unit test imports it.
- [readability] core/src/ports.ts — one concept, two parameter names:
  `extendSeconds` vs `extendLeaseSeconds`.
- [duplication] core/src/ports.ts — the checkpoint-write pair is spelled
  three times and its key field has two names on one surface.
- [dead-code] core/src/validate.ts — `MAX_EPOCH_MS` / `MAX_DURATION_MS` are
  exported contract constants nothing imports or asserts.

## store-libsql
- [bug-risk] store.ts — the two successor-insert sites (fail, sweep
  claim-timeout) share their carried-column shape by discipline; extract a
  `successorInsert(...)` builder so drift is unwritable (each keeps its
  own label + SQL text).
- [bug-risk] store.ts — the checkpoint LWW upsert tail (the `>=` tiebreak
  that is wire-visible LWW semantics) is duplicated at both write sites;
  one constant.
- [bug-risk] store.ts:160 — `CASE WHEN ? IS NOT NULL` wrappers force
  duplicate adjacent binds; SQLite NULL-propagation through `+` does the
  same in one bind (compute the offset in TS, no SQL arithmetic on client
  numbers).
- [bug-risk] store.ts:192 — spawn's winner subquery orders by `run_id DESC`
  (temp b-tree) — the exact shape a Part-3 lesson replaced with
  `attempt DESC` over `runs_task_attempt`.
- [bug-risk] store.ts:74 — `NEXT_WAKE_SQL` is exported "so the query-plan
  suite pins it" but no test imports it; add the pin or drop the export.
- [dead-code] store.ts — helper `notYet()` is never referenced.
- [dead-code] store.ts — `waits.status` is single-valued now that delivery
  DELETEs waits; the docstring describes code that no longer exists.
- [dead-code] store.ts — `checkpoints.status` is single-valued; the
  getCheckpoints filter on it is a tautology.
- [duplication] store.ts — the task-liveness/eligibility EXISTS guard is
  hand-spelled at nine sites (fragments.ts exists for exactly this).
- [duplication] store.ts — stamped-run fence fragments repeated ~11 times.
- [duplication] store.ts — the waits-gone DELETE is the same whole
  statement four times.
- [duplication] store.ts — reschedule/suspendRun duplicate the wake decode
  and the task-mirror statement verbatim.

## sdk
- [bug-risk] run-worker.ts:116 — pump teardown is duplicated, and the early
  getCheckpoints-failure copy lacks the bounded-finalization race the
  finally block has (an in-flight hung heartbeat could retain the pass);
  one `stopPump` helper.
- [duplication] context.ts — awaitEvent's three resolution paths repeat the
  memo-commit-settle shape with a weak inline memo type; name the memo type
  and the commit.
- [duplication] context.ts — step duplicates commitMarker's fenced
  checkpoint-commit shape, leaving two parse sites for one canonical value.

## driver
- [bug-risk] loop.ts:126 — the "ttl = 2x cadence" contract is held by two
  copies of the defaulted expression; bind the default once and derive both.
- [duplication] http.ts:175 — the 13-line `listen()` promise-wrap is
  verbatim in both server factories.
- [duplication] bin/driver-host.ts — the open-migrate-store bootstrap is
  repeated seven times across bin hosts and driver tests.
- [readability] http.ts:208 — createWakeServer demands the whole DriverLoop
  but uses one method.

## conformance / harness
- [bug-risk] suite.ts — the seven 10-seed SimWorld loops want one
  `forEachSeed` helper that closes the fixture in `finally` and asserts
  invariants at quiescence (three were fixed inline on pr3.1; the helper
  itself, and the try/finally leak on all seven, remain).
- [bug-risk] suite.ts:108 — claimOne is duplicated byte-identical; four
  block-local claim/activate variants and ~20 inline claim guards want
  module-scope helpers (the one vacuous guard was fixed on pr3.1).
- [duplication] suite.ts:878 — five single-run tests build a second fixture
  while the beforeEach fixture sits unused.
- [duplication] suite.ts:1153 — a buggify test re-implements the
  ownerless-running-run invariant inline instead of calling the library.
- [duplication] invariants.ts — the LIVE-state list literal is spelled nine
  times inside the checkers; one constant.
- [readability] suite.ts — 36 single-statement raw reads each pay the
  batch/destructure/optional-chain tax; a `readOne(f, sql, args)` helper.
- [readability] suite.ts:626 — awaitEvent/setCheckpoint call sites repeat
  7-positional-argument packs; three adjacent strings come off the run.
- [readability] fuzz.ts:153 — the count-if-lease-held wrapper is repeated
  six times as nested multi-line ifs.

## scripts / specs (stale comments — cheap, do together)
- [bug-risk] specs/SchedulerCI.cfg + others — the pasted "Sized for
  exhaustive checking" trailer contradicts the constants beneath it in 6 of
  7 cfgs, and "4 liveness properties" is stale everywhere (CI lists nine).
- scripts/tla.sh header describes the pre-split gate ("four concurrent TLC
  processes").
- specs/SchedulerLiveness1/2.cfg headers still say "group 1/3", "2/3", and
  "the three groups run concurrently".
- specs/Scheduler.cfg references specs/SchedulerLiveness.cfg, deleted when
  the liveness scope was split.
- CLAUDE.md describes confine.sh's abandoned fixed caps (MemoryMax 16G,
  CPUQuota 3200%) — confine.sh now scales to the machine.
