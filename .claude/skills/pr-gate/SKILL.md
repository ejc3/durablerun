---
name: pr-gate
description: The consolidated review gate for durablerun — run before every PR push. All review checks, simplify gotchas, dialect traps, and process rules in one place, each linked to where the lesson lives. Invoke on a branch to walk the gate against its diff.
---

# The durablerun PR gate

This skill is the single consolidated reference for reviewing and shipping
changes to this repo. Every entry exists because a review, a simulation, TLC,
or a crashed box taught it. When invoked: run **Part 1** mechanically against
the current branch, then review the diff against **Parts 2–5**, then confirm
**Part 6**. A PR pushes only when every gate passes or a deviation is
explicitly written into the PR description.

Case law lives in `packages/conformance/test/regressions.test.ts` — every
past bug as a red/green pair. When in doubt about a rule's meaning, read the
regression that created it.

---

## Part 1 — The mechanical gate (all must pass, in order)

```
pnpm verify        # lints + spec ledger + format + types + 200+ tests (~2 min)
pnpm verify:tla    # full TLC proof: probes + safety + 5 liveness groups (~12 min)
pnpm verify:fuzz   # 2000 seeds x 100 steps (confined; ~2 min)
```

1. **`pnpm verify` green** — includes the determinism lint (no ambient
   time/randomness/timers in engine packages; entropy enters only via
   `IdSource`, `NOW_MS`, or a port) and the spec ledger (every batch label
   mapped to a TLA action or excluded with a reason, block-scoped).
2. **TLC green** — if the diff touches any protocol transition and the spec
   was not updated, stop: that violates spec-first (below).
3. **Fuzz green** — includes the progress floor; a vacuous or stalled walk
   fails by design.
4. **Reviews ran**: codex (background, confined via `scripts/confine.sh`) +
   the review angles + a coverage auditor when the diff adds transitions.
   Findings triaged; every accepted bug got its red/green pair.
   NEVER scope every reviewer to the diff: at least one reviewer gets the
   WHOLE system with the diff as entry point. A scoped review inherits the
   author's assumptions — "the store is already verified" excluded exactly
   where two of the four driver-review bugs lived (claim idempotency, cancels
   ordering).
5. **Merge on green only** — CI (verify + tla jobs) must pass on the PR head.
6. **Launched reviewers report before merge** — MECHANIZED: main's branch
   protection requires the 'adversarial-review' commit status, which only
   scripts/review-attest.sh produces, and it refuses to attest unless the
   codex log and the review-workflow journal are each bound to the current
   PR head and verifiably COMPLETED (or the PR body carries an explicit
   'reviews-abandoned:<reason>' trailer, which the status echoes publicly).
   Merging without reviews is an operation
   GitHub refuses, not a rule to remember — it was forgotten under
   momentum twice; now the failure mode requires deliberately attesting
   falsely, a different and auditable class. The same script enforces the
   SEV rule FIRST — a mandatory `review-findings: <count>` line in the PR
   body, and for a nonzero count an added, filled-in postmortem (Part 6);
   the abandonment trailer never skips that gate.
7. **Affected mutation evidence for guard-changing PRs** — before running,
   enumerate the affected mutation closure. Include a canonical mutation name
   when the diff touches its mutation target, its attributable verdict owner,
   or the shared fixture and execution path that exercises the guard. Because
   `-k` accepts one substring, run one self-confined
   `pnpm verify:mutations -k '<unique full mutation name>'` invocation per
   name. A common substring may cover several names only after the declared
   closure and the runner's actual selected inventory are shown to be
   identical.

   The PR body lists every selected mutation and its observed exact expected
   owner verdict, and labels the evidence an affected-subset audit. Never call
   a filtered run a full audit. A PR that changes this cadence or waives a full
   sweep required below also includes `gate-changes:` with the old and new
   gate, bounded closure, and property-preservation justification.

   Run unfiltered `pnpm verify:mutations` when the PR changes the mutation
   runner, registry, verdict classifier, orchestration, checkpoint/resume
   logic, confinement, or a shared verifier; when the affected closure cannot
   be bounded and explicitly enumerated; for a scheduled audit with a named
   owner and cadence; or for an explicit pre-release audit. In every mode the
   exact attributable verdict must fail: collateral failures never substitute
   for that owner. A missing exact owner is a product survivor and blocks the
   guard change.

   The current classifier reports exact-owner plus collateral failures as
   `wrong-path`, so the run remains non-clean even though the guard is not a
   product survivor. Until the classifier distinguishes that case, its
   transcript can support only an explicit PR-body gate deviation that proves
   the exact owner fired, quotes the collateral failures, and records them as
   audit/tooling debt. Do not relabel the run clean or widen the outcome PR to
   repair that debt.

   Subset and full runs keep the same no-proxy and transport guarantees. The
   command self-confines once, captures the clean committed head, and uses
   isolated detached worktrees (`--jobs auto` by default). A STALE pattern,
   incomplete worker, wrong-head/missing/duplicate/extra result, cleanup leak,
   or process/report disagreement fails the audit. The aggregate cgroup must
   preserve 25% of host memory and the host CPU reserve; merely finite limits
   are not confinement. A missing, malformed, or signaled Vitest report is
   infrastructure failure, never a completed wrong-path mutation. The final
   success line must name the current head, and the next session-state check
   must show no mutation worktrees left behind.
8. **`bash scripts/session-state.sh` clean** — before reporting a round
   finished. Repository ownership comes from cwd, argv, and live ancestry;
   unrelated host sleeps are not repository evidence.
   The same snapshot covers registered worktrees, while Git reports stashes and
   uncommitted files. Never grep the process table for tool names to decide
   nothing is running: that answer was given once from
   `ps | grep -E 'codex-cli|tla2tools|vitest'`, which cannot match a shell loop
   sitting in `sleep`, and it missed two — one spinning for 38 hours from an
   earlier session, and one whose own exit condition was `! pgrep -f "tla.sh"`,
   which matched the waiter's own command line and so could never become true.
   A negative claim needs a check that would visibly fail if the claim were
   false.
9. **Simplify + elegance pass ran** — before the final push, a dedicated
   simplification review over the FULL branch diff (`/simplify`, or an
   equivalent walk of Part 5): every accepted simplification lands in the
   PR, every rejected one gets a written reason in the PR body. "It works"
   is not the bar. [CLAUDE.md standing rule]

## Part 2 — Correctness checks (what reviews hunt, learned here)

**Fencing (the #1 bug source in this repo's history):**
- Every multi-statement transition goes through `FencedBatch` (core), or —
  for worker-token ops like `setCheckpoint` — documents that the claim token
  IS the stamp. Hand-rolled batches with positional destructuring are how the
  losing-sweeper race shipped. [DESIGN §3.4 rule 1; core/fenced-batch.ts]
- Batch statements SEE earlier statements' effects: follow-ons key on the
  POST-transition state + this batch's stamp, never the consumed
  pre-condition. [CLAUDE.md rule 1]
- A fence must bind the FULL argument surface: `setCheckpoint` once trusted a
  caller `task_id` outside its fence and wrote foreign checkpoints.
  [regression: "setCheckpoint rejects a task_id..."]
- No one-shot flags for re-entrant lifecycles — latch on generations
  (`activated_gen < claim_gen`). The `started_at IS NULL` latch broke on the
  first sleep wake. [DESIGN §3.2]
- Guards that exist in the TLA model MUST have an executable twin: an
  invariant in `conformance/src/invariants.ts` or a conformance case.
  `max_attempts` was modeled-but-unenforced while fuzz ran green.
- Mirror discipline: every run transition mirrors `tasks.state`; successor-
  creating paths (`fail`, sweep) carry `wake_event`/`event_payload`/`run_db`
  and share guard shapes — check the two successor-insert sites for drift.
- Consumable state gets consumed: wakes clear on `reschedule`/`complete`
  ('consume'), carry on failure successors, and survive §3.8.2 deferral
  (`reschedule` 'preserve'). Timed-out waits are deleted at claim so emits
  cannot resurrect them.
- Terminal tasks are inert (§3.4 rule 6): task mutations guard
  `state IN LIVE`; run-REVIVING CASes require the owning task live;
  terminalizing CASes still quiesce. Even corrupt state must not be
  AMPLIFIED. [regressions: complete/reschedule under a terminal task]
- Successor inserts are STAMPED (`claimed_by = stamp`) and follow-ons key on
  the stamped row, never bare run-id existence — a suppressed insert plus an
  id collision otherwise books a FOREIGN run. Both successor sites (fail,
  sweep claim-timeout) share the shape. [regression: fail-collide]
- Accounting: `tasks.attempts` moves ONLY in user-failure transitions;
  infra (`$ClaimTimeout`) successors move `infra_retries`; `run.attempt` is
  the fence ordinal (counts both). User ordinal = `attempt - infraRetries`.

**Time and identity:**
- Engine time is database time (`NOW_MS`); clients pass relative durations;
  `sleepUntil` is the one sanctioned user absolute. [CLAUDE.md rule 3]
- All ids/tokens from `IdSource` — seeded ids are also how tests predict
  collisions (see the successor-collision regression).

**Advisory-signal rule:** the scheduler lease is the only truth; launcher
acks, ending feeds, `expireLeaseNow` may only ACCELERATE lease expiry.
A live worker's heartbeat legitimately revives an advisorily-expired lease.
[DESIGN §3.9; conformance "revival" scenario]
- Bounds are invariants too: fences and state checkers cannot see a
  QUANTITY violation (a duplicated claim doubled K with every row
  consistent). MECHANIZED: conformance/src/fault-matrix.ts enumerates
  label x fault from the source harvest (label-inventory test = the
  completeness gate); new labels enroll automatically. Never hand-curate
  fault coverage again.
- Eligibility predicates: MECHANIZED via store fragments.ts + the
  fragment lint (verify gate). New doors compose fragments; raw
  comparisons/state lists outside fragments.ts fail the build.
- Launch-outcome consumption: MECHANIZED via the opaque LaunchOutcome +
  reconcile (core/launch.ts). There is no second way to consume a report.
- When a guard lands at one chokepoint, enumerate every OTHER door to the
  same bad state and decide placement explicitly (the activation guard
  against due-to-cancel launches left the claim door open for a year of
  commits). Where the TLA model is deliberately looser than intent, the
  intent needs an executable home (conformance case) — TLC cannot flag
  what the model permits.
- Port docs carry CONSUMER obligations, not just implementer guarantees —
  Ending carries runId/token so callers verify them; a consumer that uses
  a report positionally is trusting it. Runtime-validate every object
  (not just number) crossing a port from untyped territory.
- Reconcile by FENCE, never by kind: an advisory report's content may never
  choose the code path — take the same guarded write unconditionally and
  let its fence no-op when the report was right. Skipping a write "because
  the report says it's unnecessary" IS trusting the report (the tick
  believed a lying 'completed' and cost a full lease of latency).
- Every advisory input gets LYING-signal tests — one false-positive, one
  false-negative. Honest-signal tests are author-predicted scenarios and
  catch nothing (no invariant trips on a latency bug).
- The honest path asserts its COUNTERS, not just call counts: the loop's
  watchdog misclassified every successful launch and stayed green because
  tests counted invocations, never `stats.launched`. Every consumer of an
  advisory signal pins launched/failed/ended numbers on the happy path.
- Racing a promise against its own settlement signal: `.finally` adds
  microtask hops, so the interrupted sleep can WIN against the launch that
  interrupted it. Check the settled flag to decide, never race order.
- Migrations are APPEND-ONLY, machine-enforced: schema.test.ts freezes
  every migration's content hash — editing shipped history fails the
  build; schema changes append a new version (and its hash).
- Best-effort writes are try/caught: a lost hint may never cost the
  caller's result. Advisory-ness must be visible in code SHAPE, not just
  in your head.
- Rules travel to NEW boundaries: every new public entry point (tick was
  the first above the store) re-validates its numeric knobs at entry —
  the layer below validating does not exempt it, and a value legal below
  (sweep limit 0 is a pinned store behavior) can be degenerate above
  (backlog spins forever).

## Part 3 — SQL & dialect traps (each bit us once)

- `ON CONFLICT` targeting a partial unique index must repeat the index's
  `WHERE` clause (SQLite).
- Compound SELECT members can't carry `ORDER BY`/`LIMIT` — wrap each leg as a
  derived table (the claim query).
- `LIMIT -1` means UNLIMITED on SQLite — clamp every limit (`clampLimit`).
- `INSERT OR IGNORE` swallows ALL conflicts including PK collisions — under a
  stamp fence use plain `INSERT` so real violations fail loudly.
- JS numbers bind as REAL; INTEGER columns are affinity, not enforcement
  (§3.4 rule 7): Infinity becomes an unexpirable `Inf` lease, unsafe
  integers throw RangeError on READ-back, fractional `? * 1000` products
  store REAL epochs. Every client number crosses the port through
  core/validate.ts and SQL NEVER multiplies a client number — ms are
  computed in TS. Detection twin: the `temporal-storage-class` invariant.
- `rowsAffected` lies for DML…RETURNING on the local libsql client — the
  executor normalizes (rows.length for row-returning statements); fence
  checks rely on that contract. [store-libsql/test/executor.test.ts pins it]
- Blobs arrive as ArrayBuffer; the executor normalizes to Uint8Array.
- No numeric underscore literals (`1_000_000`) inside SQL strings.
- Partial-index usability requires the query's WHERE to textually imply the
  index's WHERE — an added state in an IN-list can silently drop the index.
  Hot queries are pinned by EXPLAIN QUERY PLAN tests against the EXACT
  exported production SQL, never stand-ins. [query-plans.test.ts]
- `ORDER BY run_id DESC` in correlated subqueries can force temp b-trees;
  prefer an indexed column (`attempt DESC` over `runs_task_attempt`).
- Interactive transactions are banned (Turso 5s window): one `batch()` or
  nothing. Reads pass `'read'` mode — never take the writer lock idly.
- Dialect drift watchlist for Phase 4: `MIN` scalar → `LEAST` (MySQL), no
  RETURNING (MySQL), `EvalPlanQual` double-claims on bare
  `UPDATE…WHERE id IN (subselect)` (Postgres — SKIP LOCKED CTE only),
  `DATETIME(6)` explicitly (MySQL rounds whole seconds by default).

## Part 4 — Harness & test-construction gotchas

- SimWorld crash = PROCESS death: pending calls purge as `crash-orphan`;
  effects before death are real, after are forbidden — assert trace order,
  not just final values.
- Injected rejections are pre-handled; stateful regex flags (g/y) are
  neutralized; unfired injection specs THROW (vacuous-green prevention);
  ambiguous specs THROW. Actors may only await port calls — violations are
  detected, never hung.
- Assert INVARIANTS at quiescence (`engineInvariantViolations`), not only
  scenario expectations — detection must not depend on predicting the
  failure while authoring the test. Orphan checks use LEFT JOINs (an inner
  join hides a MISSING row from the checker).
- Fuzz floors: per-walk floors on individual ops are deterministic flakes
  (one unlucky seed fails forever) — use AGGREGATE per-op floors across the
  shard plus a per-walk total-progress floor.
- Put sims at BOUNDARY values ({0, cap−1, cap}) and include the actor the
  race needs (the sweeper race needed a claimer; the sim without one was
  blind).
- Test-arithmetic traps: cancel deadlines include `startDelaySeconds`
  (deadline = enqueue + delay + maxDelay); a max_delay deadline can never
  beat its own run's available time; overlapping backlogs make budget tests
  vacuously pass — keep populations disjoint.
- Checkers must be checked: the first spec-ledger grep matched prose and
  accounted labels vacuously. Validate knobs (`FUZZ_SEEDS=''` must fail, not
  fuzz nothing).
- Anything that can grow runs confined (`scripts/confine.sh`) — memory is
  the killer; in-process pooling can't use cores against sync-native libsql
  (shard across vitest files instead).

## Part 5 — Simplify & altitude gotchas

- Load-bearing literals are contract constants: failure reasons, LIVE-state
  lists, cap/backoff values — one definition, exported, asserted by the
  suite, pinned in DESIGN.md. Reasons are DATA, never fence keys (stamps
  fence).
- Repeated SQL shapes get builders/constants before the third copy:
  successor-insert columns, waits-gone deletes, fence fragments,
  `CLAIMED_RUN_COLUMNS`.
- Two adjacent same-type params invite silent swaps — options objects
  (`{leaseSeconds, limit}`).
- Impossible states get unrepresentable types (`EventWake` union: payload
  XOR timedOut; nullable `runId` on the cancelled arm instead of `''`).
- One batch label = one SQL shape (labels are crash-injection addresses);
  don't splice SQL from booleans under a single label.
- Config nobody can set is not config — either it's contract (pin it in
  DESIGN.md as constants) or it's YAGNI (delete it). StoreOptions caps died
  this death.
- Hoist duplicated test helpers to suite scope (`claimOne`, `activatedRun`);
  a "changes nothing" claim needs a `snapshot()` comparison, not just a
  `rejects.toThrow`.

## Part 6 — Process rules (non-negotiable, from CLAUDE.md)

- **Spec-first**: new protocol areas (cross-actor transitions) are modeled in
  `specs/*.tla` and TLC-verified BEFORE their SQL exists; the ledger maps
  labels→actions.
- **Red test before fix**: every bug = red commit (run it, SEE it fail) then
  green commit. If a bug can't be red-tested, a seam is missing — build the
  seam first.
- **Prevention + class altitude**: every fix ships the class-level tripwire —
  invariant checker, fuzz op, sim actor, or lint — not just the instance
  test.
- **Every review-caught bug is a SEV**: a bug that survives the author's
  machinery and is found by review — or later (nightly, production) — gets
  a complete postmortem under `postmortems/` committed in the SAME PR:
  impact, red/green commits, the finder artifact quoted, per-finding layer
  analysis (which layer should have caught it and why it could not), the
  mechanisms instituted with their ladder rungs, deferrals in BUILD.md.
  MECHANIZED: review-attest.sh requires a `review-findings: <count>` line
  in every PR body; a nonzero count requires the PR to ADD a postmortem
  containing every template section, placeholders filled, findings table
  non-empty; the abandonment trailer never skips this gate. Declaring 0
  over a branch with red-test commits publicly claims they were
  machinery-caught — the same auditable-if-false class as the attestation
  itself. [CLAUDE.md standing rule]
- **DESIGN.md updates in the same diff** for any observable behavior change
  (thrown error types, LWW semantics, mirror rules — all were missed once).
- **BUILD.md scope reconciliation**: promised-but-deferred items get an
  explicit deferral note, never silence (repeat counters were silently
  dropped once).
- **Pluggability is law**: no dialect SQL in engine logic; a dialect is done
  when its factory passes the identical conformance suite; the contract is
  language-neutral (schema + batch semantics + wire formats + spec +
  scenarios), never TypeScript types alone.
- **Merge on green; PRs are the record** — descriptive commits covering the
  actual diff, `git log main..HEAD` read in full before writing the PR body.
- **No internal waypoint numbers in source comments**: "the PR2.1 lesson"
  is meaningless outside these sessions — comments describe the failure
  itself. BUILD.md (the numbered plan) is the one exception.
- **Plain language in commits and PR bodies**: ordinary sentences describing
  what changed and what behavior changed — no repo-private shorthand
  ("stamps", "altitude", "K_s") without an in-line gloss. Spec section
  numbers are pointers in parentheses, never the explanation itself. A
  reader outside these sessions must understand the log cold.

## Reference map

| What | Where |
|---|---|
| Contract rules 1–5, ports, planes | `DESIGN.md` §3.4, §3.9, §3.8 |
| Standing rules (all) | `CLAUDE.md` |
| Verified protocol + label ledger | `specs/Scheduler.tla` |
| Case law (every past bug, red/green) | `packages/conformance/test/regressions.test.ts` |
| Class tripwires | `packages/conformance/src/invariants.ts` |
| Structural fencing | `packages/core/src/fenced-batch.ts` |
| Backend contracts pinned | `packages/store-libsql/test/executor.test.ts`, `query-plans.test.ts` |
| Fault injection semantics | `packages/harness/src/sim.ts` |
| Confinement | `scripts/confine.sh` |
| Phase plan + deferrals | `BUILD.md` |
