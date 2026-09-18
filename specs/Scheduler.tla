------------------------------ MODULE Scheduler ------------------------------
\* ===========================================================================
\* durablerun scheduler protocol -- DESIGN.md S3.1 (tick: cancel enforcement,
\* sweep classification, claim with claim_gen), S3.2 (per-claim activation
\* CAS, heartbeats, voluntary attempt-neutral chaining), S3.4 (contract
\* rules: fenced batches keyed on post-state; rule 2 event atomicity), S3.8.3
\* (event protocol: first-write-wins emit, parked wake fields, wait
\* lifecycle), S3.9 (advisory-signal rule).
\*
\* GRANULARITY: one TLA+ action per labeled implementation batch
\* (packages/store-libsql/src/store.ts) -- a libSQL batch() is atomic, so
\* "SQL atomicity" is assumed exactly as action atomicity here:
\*
\*   Spawn                <-> db.batch('spawn')  (incl. arming cancel_at_ms
\*                            from cancellation.max_delay)
\*   Claim                <-> db.batch('claim') + tick step 3 launch enqueue
\*                            (fused: "claimed but launch never sent" is
\*                            indistinguishable from a dropped message, which
\*                            Drop covers; K = 1 -- a K-run batch claim is
\*                            MORE atomic than the K interleaved single
\*                            claims modeled, so the model checks a superset
\*                            of schedules).  The claim batch's timed-out-
\*                            wait DELETE (its statement 3) is folded in: a
\*                            claim CONSUMES a due wait so a later emit
\*                            cannot resurrect it (S3.4 rule 2, timeout
\*                            branch) -- there is no separate TimeoutWake.
\*   DuplicateClaim       <-> db.batch('claim') REDELIVERED (S3.4 rule 4,
\*                            replay half): the same claim request -- same
\*                            wire token, same parameters -- delivered
\*                            again.  Guarded by the impl's receipt
\*                            predicate; see the action comment.
\*   Activate             <-> db.batch('activate')  (the per-claim CAS, incl.
\*                            the cancel-deadline refusal guard and the
\*                            first-start deadline rewrite: max_delay is
\*                            disarmed by starting; max_duration is anchored
\*                            at FIRST start, recomputed idempotently on
\*                            every re-activation)
\*   Heartbeat            <-> db.batch('heartbeat')
\*   CompleteRun          <-> complete()  (clears the cancel deadline)
\*   FailRunWithRetry /
\*     FailRunTerminal    <-> fail()  (two branches of one batch; Terminal is
\*                            the max-attempts branch; the retry successor
\*                            carries wake_event/event_payload forward)
\*   SleepSuspend /
\*     VoluntaryChain     <-> reschedule()
\*   DeferLaunch          <-> 'defer-launch' (SPEC-FIRST): the rolling-deploy
\*                            deferral, decided before activation from the
\*                            claimed task's name, fenced on the claim receipt
\*   SweepLostLaunch / SweepRelaunchExhausted /
\*     SweepClaimTimeout / SweepInfraExhausted
\*                        <-> sweep()'s per-run fenced batches;
\*                            classifications match core/types.ts SweptRun;
\*                            the claim-timeout successor carries
\*                            wake_event/event_payload forward (S3.8.2)
\*   CancelSweep          <-> cancelTransition('sweep:cancel'): deadline-due
\*                            task + its live runs -> cancelled, waits gone
\*   RetryTask            <-> 'retry-task' (SPEC-FIRST): revive a failed task
\*                            in place with a new run (Absurd retry_task)
\*   CancelExplicit       <-> cancelTransition('cancel-task'): same shape,
\*                            NO deadline guard (the explicit API)
\*   EmitEvent            <-> 'emit-event' (SPEC-FIRST, modeled ahead
\*                            of implementation): first-write-wins event row;
\*                            every registered waiter flips sleeping ->
\*                            pending-now with the payload parked on the run
\*                            row and its wait row deleted -- one atomic
\*                            batch (S3.4 rule 2), durable-at-emit (S3.8.3
\*                            inline placement)
\*   AwaitEventHit /
\*     AwaitEventMiss     <-> 'await-event' (SPEC-FIRST): one atomic
\*                            fenced batch; already-emitted -> immediate
\*                            payload, worker continues (Hit); else register
\*                            the wait and sleep with available_at = timeout
\*                            or infinity (Miss)
\*   Drop / WorkerCrash / TimeAdvance : environment, not batches.
\*
\* WORKERS ARE IMPLICIT: an "execution context" record is created per
\* delivered activation (the set `contexts`); after activation a context may
\* Heartbeat / AwaitEventHit any number of times, then take exactly one of
\* Complete/Fail/Sleep/Chain/AwaitMiss -- or crash/hang.  "2 workers" of the
\* sizing brief = up to 2 concurrent contexts, which the run pool already
\* bounds.  Concurrent tick drivers need no explicit count either: any
\* interleaving of Claim/Sweep/Cancel actions IS N concurrent ticks (claims
\* arbitrate in the DB).  EmitEvent is an environment/API action: any HTTP
\* route or other worker may emit at any moment.
\*
\* THE LAUNCH CHANNEL IS AT-LEAST-ONCE: `channel` is a set that delivery
\* does NOT remove from (so redelivery is always possible), plus an explicit
\* Drop action for loss.  Dedup happens ONLY at the activation CAS.
\*
\* THE CLAIM REQUEST IS AT-LEAST-ONCE TOO (S3.4 rule 4, replay half): a
\* tick's claim request (one wire token) may be redelivered.  `tokRuns` is
\* the claimed_by projection for the LATEST minted token -- the set of rows
\* it currently claims.  Every exit from running overwrites claimed_by
\* (reschedule/complete/fail/sweep stamp it, cancel nulls it), so a token
\* is only ever carried by still-running rows and tokRuns is pruned on
\* every such exit.  DuplicateClaim is the redelivery, guarded by the
\* impl's receipt predicate ("no running rows already carry this token"):
\* while a carrier runs, the retry is the idempotent receipt of S3.4 rule 4
\* -- it returns the original selection and claims NOTHING, a pure no-op
\* modeled as a stutter (the guard is false), exactly like re-emit and
\* dup-activate.  ClaimReplayBound is the guard's executable twin: the
\* token never owns more than K = 1 running rows however often the request
\* is redelivered.  Duplicate semantics of every OTHER batch are per-label
\* guard analyses -- see the [dup-class] tags in the BATCH-LABEL LEDGER.
\*
\* DELIBERATELY NOT MODELED (honest list):
\*  - THE WAITS TABLE.  A wait is modeled as two per-run fields, waitEv[r]
\*    and waitAt[r]: one registration per run, named by the run.  The
\*    implementation stores waits in a TABLE keyed (run_id, step_name), so it
\*    can hold rows the run is not parked on -- a leftover from an earlier
\*    step, a row naming another task, a row whose deadline is not the run's.
\*    None of those states exists here, so EmitEvent's guard can be the whole
\*    truth (waitEv[r] = e) while the implementation needs five conditions to
\*    approximate it.  This is not a small abstraction: EVERY emit defect
\*    found by review -- waking a run parked on a timer, moving a task named
\*    by a foreign wait row, and two rows answering one question between them
\*    -- lives exactly in the gap, which is why TLC could not have found any
\*    of them.  The model is not wrong; the implementation is not yet a
\*    refinement of it.  PR3.8 (an immutable wait id plus runs.active_wait_id)
\*    is what closes the gap, and it is this abstraction written down as
\*    schema.  Until then the executable twin is a generated fault surface
\*    over corrupt wait rows, not this spec.
\*  - Checkpoint content, the data plane (RunStateStore), child tasks,
\*    multi-queue, multi-shard, sagas.
\*  - SQL atomicity: assumed as action atomicity (see mapping above).
\*  - Token randomness: a claim of run r is uniquely named by (r, claim_gen),
\*    so claim_token is modeled AS the pair -- "claimed_by = :token" becomes
\*    "claimGen[r] = c.gen".  Cross-run UUID collisions are not modeled.
\*    Cross-run token IDENTITY -- one wire token claiming several rows over
\*    replays -- IS modeled, but for the latest token only (tokRuns; the
\*    restriction is argued sound at DuplicateClaim).
\*  - Pings, alarms, cron, EndingFeed, expireLeaseNow: by S3.9's
\*    advisory-signal rule these may only ACCELERATE what lease expiry does
\*    anyway, PROVIDED the signal preserves the exact (run, claim token)
\*    identity. A mismatched or tokenless signal stutters; it may not expire
\*    the run's current claim. TimeAdvance already reaches the exact claim's
\*    lease expiry, so omitting identity-preserving acceleration removes no
\*    reachable states -- only timing, which fairness abstracts. PR6.4 must
\*    extend this spec before adding atomic tokenless heartbeat-cutoff
\*    reconciliation.
\*  - Heartbeat throttling, clock skew (engine time is the single `now` --
\*    S3.4 rule 3 "engine time is database time" makes this faithful).
\*  - Re-emit of an already-emitted event: the implementation may refresh an
\*    unmodeled delivery-provenance stamp while preserving the first payload
\*    and emitted instant.  No valid waiter can exist for a fired event (see
\*    WaitIntegrity), so the modeled state stutters, which [][Next]_vars
\*    always allows; the checked content is EventImmutable + WaitIntegrity.
\*  - Event GC / iterable events: events are one-shot by contract (S3.8.3);
\*    occurrence ids live in the event NAME, outside the model.
\*  - The dedicated-placement wait state 'delivered' (materialize-on-resume,
\*    S3.8.3): this spec models the INLINE placement -- durable-at-emit,
\*    waits deleted at emit.  Dedicated placement adds run-DB ordering on
\*    top of the same scheduler-plane transitions and gets its own spec
\*    extension when RunStateStore lands.
\*  - The brief lease-overlap window Absurd tolerates IS modeled: sweeping
\*    or CANCELLING a run does NOT remove its live (zombie) context; the
\*    zombie may still attempt Heartbeat/Complete/Fail/Sleep/Chain/Await and
\*    every attempt must be guard-disabled (the impl's zero-row fenced
\*    batch).  LeaseAuthority is exactly that check -- including that a
\*    cancelled run's old token writes are disabled.
\*
\* BOUNDED-TIME ARTIFACTS: every future timestamp is capped at MaxTime.  At
\* the horizon, backoffs collapse to "due now", fresh leases are born
\* expired, and armed cancel deadlines are due -- an over-approximation
\* (more adversarial interleavings, never fewer), and what makes the
\* liveness properties checkable in bounded time.  Off the horizon
\* (now < MaxTime) all delays are strictly future.  Inf == MaxTime + 1 is
\* the one value past the horizon: "no deadline" / "wait forever" -- never
\* due, because now never exceeds MaxTime.
\*
\* MODELING CHOICES for the two new protocol areas (each is a deliberate
\* deviation-or-restriction, stated so the impl PR can't silently diverge):
\*  - Cancellation policy is chosen nondeterministically at Spawn
\*    ("none"/"delay"/"dur"/"both" -- the four subsets of
\*    {max_delay, max_duration}); both durations share one constant
\*    CancelLen (the semantics differ in ANCHOR -- spawn time vs first
\*    start -- not in length, and one constant keeps the state space flat).
\*  - first_started_at_ms is a genuine one-shot latch in the impl (COALESCE)
\*    and is modeled as one: the no-one-shot-flags rule is about RE-ENTRANT
\*    lifecycles; a task starts for the first time exactly once.
\*  - Claim has NO cancel-deadline guard (faithful: the impl claim joins
\*    tasks on state IN LIVE only), so a deadline-due task's runs can churn
\*    claim -> activation-refused -> lease-expiry -> lost-launch-reopen
\*    until CancelSweep lands; TLC verifies this churn terminates (fair
\*    CancelAny + RelaunchCap).  A run of a deadline-due task swept past its
\*    relaunch cap fails as $RelaunchCapExhausted, not $Cancelled -- both
\*    terminal; accepted (the impl's sweep processes cancels first to make
\*    this rare, but the race is legal).
\*  - AwaitEventMiss consumes a hop from the MaxHops budget, like Sleep and
\*    Chain (same artificial liveness bound; production bounds it with
\*    cancellation.max_duration).
\*  - AwaitEventMiss with NO timeout is model-restricted to tasks whose
\*    cancel deadline is armed (cancelAt # Inf at await time, i.e.
\*    max_duration policy) -- otherwise "wait forever on an event nobody
\*    emits" is a REAL infinite behavior and EventuallyTerminal would fail
\*    on it by design.  Production allows untimed awaits on policy-free
\*    tasks; this is a liveness-checkability restriction exactly like
\*    MaxHops, not a protocol rule.
\*  - AwaitEventHit changes no scheduler state (the payload read and the
\*    checkpoint write are data-plane; checkpoint content is unmodeled).  It
\*    is still an explicit fenced action so LeaseAuthority pins that a
\*    zombie's awaitEvent must be guard-disabled.  It does not extend the
\*    lease: a lease-extending await-hit is Heartbeat composed with
\*    AwaitEventHit, both already modeled.
\*  - EmitEvent flips the waiter's TASK to "pending" (mirror discipline);
\*    it can never touch a cancelled task because cancel deletes the task's
\*    waits in the same atomic action (checked by WaitIntegrity +
\*    TerminalStability).
\*  - Payloads = 1..2: two distinct values so PayloadMatchesEvent (the
\*    parked copy equals the event row) is non-vacuous.  NoPayload = 0 is
\*    SQL NULL: a claimed run with wake_event set and payload NULL is the
\*    TimeoutError wake (decodeClaimedRun's timedOut branch).
\*  - wake_event/event_payload persist on the run row after delivery until
\*    the next await overwrites them or a successor carries them (faithful:
\*    no impl transition clears them).  IMPLEMENTATION NOTE: the SDK must treat them
\*    as "latest wake reason", memoizing consumption via checkpoints -- a
\*    resumed run that suspends again via plain sleepFor will re-see stale
\*    wake fields at its next claim.
\*  - Cancel canonicalizes availableAt/leaseDeadline/waitAt of the runs it
\*    kills to 0 (impl: claim_expires_at = NULL, wait rows deleted).
\*    Nothing reads these fields off non-live runs; zeroing merges
\*    otherwise-identical states.
\*
\* SUGGESTED CONSTANTS (exhaustive TLC in single-digit minutes):
\*   Tasks = {t1}   MaxRuns = 3   MaxTime = 4   MaxAttempts = 2
\*   InfraRetryCap = 1   RelaunchCap = 1   MaxHops = 1
\*   LeaseLen = 2   SleepDur = 1   Backoff = 1   CancelLen = 2
\*   Events = {e1}
\* Two-task or two-event variants multiply the space; prefer safety-only
\* (SPECIFICATION Spec, drop the liveness PROPERTYs) beyond one task/event.
\* ===========================================================================

\* ---------------------------------------------------------------------------
\* BATCH-LABEL LEDGER -- machine-checked by scripts/spec-ledger.py: every
\* labeled batch in store-libsql/src must appear below, either mapped to a
\* modeled action or excluded with a reason. This catches "implemented but
\* silently unmodeled" drift.
\*
\* Every label also carries its DUPLICATE-SEMANTICS class (the spec-side
\* twin of the fault matrix's 'duplicate' column): what happens when the
\* SAME request -- same token/generation/parameters -- is delivered twice.
\*   [cas-fenced] the batch's own guards make the replay a zero-row no-op
\*   [receipt]    the replay returns the original result, claims nothing new
\*   [read]       side-effect free
\*   [setup]      fixture plumbing outside the protocol
\*
\* Modeled (label -> action  [dup-class]):
\*   'spawn' -> Spawn  [receipt]  (idempotency-key dedup: the replay
\*     resolves to the original winner row; the model's unused-task guard)
\*   'claim' -> Claim / DuplicateClaim  [receipt]  (S3.4 rule 4: the
\*     same-token retry is an idempotent receipt while any of its rows
\*     still runs; DuplicateClaim models the redelivery, ClaimReplayBound
\*     pins the bound)
\*   'activate' -> Activate  [cas-fenced]  (per-claim CAS: a duplicate
\*     delivery finds activatedGen = gen, guard false -- NoDualActivation)
\*   'heartbeat' -> Heartbeat  [cas-fenced]  (token-fenced absolute-value
\*     write: a replay under a live fence re-extends from now, which is a
\*     legal fresh heartbeat; after fence loss it is zero-row)
\*   'complete' -> CompleteRun  [cas-fenced]  (replay finds state #
\*     'running': zero-row)
\*   'fail' -> FailRun  [cas-fenced]  (replay zero-row; the successor
\*     insert keys on the CAS stamp, so no double successor)
\*   'reschedule' -> SleepSuspend / VoluntaryChain  [cas-fenced]
\*   'defer-launch' -> DeferLaunch  [cas-fenced]  (fenced on the claim receipt:
\*     a replay finds the run parked, or activated, and matches nothing)
\*   'retry-task' -> RetryTask  [cas-fenced]  (a replay finds the task no longer
\*     failed, or its revival run live, and writes nothing)
\*   'suspend' -> SleepSuspend  [cas-fenced]  (reschedule's transition plus
\*     the suspension MARKER in the same batch — the marker's meaning, "the
\*     wake already happened", is only sound if it commits with the park;
\*     checkpoint content itself stays unmodeled (header), the atomicity
\*     obligation lives in the conformance crash case)
\*   'sweep:lost-launch' -> SweepLostLaunch  [cas-fenced]  (replay finds
\*     the row already reopened: state # 'running')
\*   'sweep:claim-timeout' -> SweepClaimTimeout  [cas-fenced]  (replay
\*     zero-row on the dead run; no double infra successor)
\*   'sweep:cancel' -> CancelSweep  [cas-fenced]  (task CAS on LIVE states)
\*   'cancel-task' -> CancelExplicit  [cas-fenced]  (same CAS, no deadline)
\*   (the claim batch's timed-out-wait DELETE is part of Claim; activate's
\*   cancel-refusal guard and first-start deadline rewrite are part of
\*   Activate -- one label, one action, even when the batch has follow-ons)
\* Modeled ahead of implementation (the event implementation must use these labels and match
\* these actions -- spec-first per the standing rule):
\*   'emit-event' -> EmitEvent  [cas-fenced]  (first-write-wins fact:
\*     replay may refresh unmodeled delivery provenance but preserves the
\*     payload and first instant; EventImmutable)
\*   'await-event' -> AwaitEventHit / AwaitEventMiss  [cas-fenced]  (hit
\*     replay re-reads under a live fence; miss replay is zero-row -- the
\*     run it parked is no longer 'running')
\*   'record-task-done' -> AwaitMaterialize  [cas-fenced]  (ChildTasks.tla: the
\*     await of a child that ended with no outcome recorded writes the completion
\*     event from the child's row, fenced on that row's stamp and on the live
\*     claim; a replay finds the event it wrote and answers with it)
\* Excluded (reason  [dup-class]):
\*   'driver-heartbeat' [receipt] -- observability liveness upsert; nothing
\*     in the protocol reads it, and a replay re-applies the same row
\*   'claimed-task-name' [read] -- the worker's pre-activation read of a claimed
\*     run's immutable task name; part of DeferLaunch's decision, no transition
\*   'refusal-state' [read] -- after a refused worker write, the run's state names
\*     why (cancelled or lost fence); no transition
\*   'run-task' [read] -- the task of the run a terminal batch is about to end,
\*     read only when this store did not activate the run; a run's task never
\*     changes, and the batch names that task's completion event (ChildTasks.tla)
\*   'task-done-state' [read] -- a task as a child await sees it: its queue,
\*     its outcome, and the stamp its row carries. Read only by
\*     a child await that neither registered nor hit, to say why (ChildTasks.tla's
\*     AwaitRefused, AwaitUnknown, and the outcome AwaitMaterialize records)
\*   'sweep:scan' [read] -- read-only discovery, no state transition
\*   'expire-lease-now' [cas-fenced] -- advisory-only token-fenced write
\*     for the exact signal claim identity (replay re-applies the same
\*     absolute value; mismatched/tokenless signals stutter); omission argued
\*     sound in the header (accelerates TimeAdvance-reachable states only)
\*   'set-checkpoint' [cas-fenced] -- lease-fenced LWW upsert; a replay
\*     re-applies the identical row (data-plane content unmodeled by
\*     design -- header; its lease fence rides Heartbeat)
\*   'get-checkpoints' [read] -- read-only query
\*   'task-result' [read] -- read-only query
\*   'next-wake' [read] -- read-only query
\*   'migrate:bootstrap' [setup] -- infrastructure, not protocol
\*   'migrate:version' [setup] -- infrastructure, not protocol
\*   'admin:set-fake-now' [setup] -- infrastructure, not protocol
\*   'admin:clear-fake-now' [setup] -- infrastructure, not protocol
\*   'admin:now' [setup] -- infrastructure, not protocol
\* ---------------------------------------------------------------------------

EXTENDS Naturals, FiniteSets

CONSTANTS
  Tasks,          \* task ids (model values)
  MaxRuns,        \* run-row pool; successors allocate from it
  MaxTime,        \* time horizon (bounded nat clock)
  MaxAttempts,    \* initial user-failure budget per task (task.max_attempts)
  MaxRetries,     \* retryTask revivals per task.  ARTIFICIAL, like MaxHops:
                  \* an operator may revive a task any number of times.
  InfraRetryCap,  \* cap on claim-timeout successors per task ("own generous
                  \* cap" in DESIGN S3.8.2 -- size unspecified there)
  RelaunchCap,    \* cap on lost-launch reopens per run row (S3.1 step 1)
  MaxHops,        \* Sleep+Chain+AwaitMiss budget per task.  ARTIFICIAL: real
                  \* workflows may suspend unboundedly (bounded in production
                  \* by the cancellation.max_duration policy, S3.2); bounded
                  \* here so liveness is checkable.
  LeaseLen,       \* lease length (claim & heartbeat extension)
  SleepDur,       \* sleepFor duration AND the await-event timeout duration
  Backoff,        \* retry/reopen backoff delay
  CancelLen,      \* cancellation.max_delay AND max_duration length (they
                  \* differ in anchor, not length -- header note)
  Events          \* event names (model values); single queue, queue-global

ASSUME
  /\ MaxAttempts \in Nat \ {0}
  /\ MaxRetries \in Nat
  /\ InfraRetryCap \in Nat
  /\ RelaunchCap \in Nat
  /\ MaxHops \in Nat
  /\ MaxTime \in Nat \ {0}
  /\ LeaseLen \in Nat \ {0}
  /\ SleepDur \in Nat \ {0}
  /\ Backoff \in Nat \ {0}
  /\ CancelLen \in Nat \ {0}
  /\ MaxRuns \in Nat \ {0}
  /\ IsFiniteSet(Events) /\ Events # {}
  \* Pool sizing so successor creation is never blocked (else liveness would
  \* fail on an artifact): per task, rows = 1 initial + at most
  \* (MaxAttempts-1) user-retry successors + InfraRetryCap infra successors +
  \* MaxRetries revivals, each of which also adds exactly one attempt.
  /\ MaxRuns >= Cardinality(Tasks) * (MaxAttempts + MaxRetries + InfraRetryCap)

RunIds        == 1..MaxRuns
NoRun         == 0
\* Claims of one run row: 1 initial + at most MaxHops sleep/chain/await
\* re-claims + at most RelaunchCap lost-launch re-claims.  TypeOK verifies.
GenBound      == 1 + MaxHops + RelaunchCap
\* run.attempt ordinal: starts at 1, +1 per successor (user, infra, or revival).
OrdinalBound  == MaxAttempts + MaxRetries + InfraRetryCap
CtxIdBound    == MaxRuns * GenBound

\* One value past the horizon: "never" (no deadline / wait forever).  now
\* never exceeds MaxTime, so Inf is never due.
Inf           == MaxTime + 1

LiveStates     == {"pending", "running", "sleeping"}
TerminalStates == {"completed", "failed", "cancelled"}
RunStates      == {"unused"} \cup LiveStates \cup TerminalStates
LaunchMsgs     == [run : RunIds, gen : 1..GenBound]

\* Cancellation policy = which of {max_delay, max_duration} the spawn set.
Policies  == {"none", "delay", "dur", "both"}

\* Event payloads: 0 is SQL NULL (unset / timeout wake); 1..2 are two
\* distinguishable payloads so first-write-wins is observable.
NoPayload == 0
Payloads  == 1..2
NoEvent   == "none"

ActionNames ==
  {"Init", "Spawn", "Claim", "DuplicateClaim", "Drop", "Activate",
   "Heartbeat", "Complete",
   "FailRunWithRetry", "FailRunTerminal", "Sleep", "Chain",
   "SweepLostLaunch", "SweepRelaunchExhausted", "SweepClaimTimeout",
   "SweepInfraExhausted", "CancelSweep", "CancelExplicit",
   "Emit", "AwaitHit", "AwaitMiss", "Crash", "TimeAdvance", "Defer", "RetryTask"}

WorkerWrites == {"Heartbeat", "Complete", "FailRunWithRetry",
                 "FailRunTerminal", "Sleep", "Chain",
                 "AwaitHit", "AwaitMiss"}
SweepActions == {"SweepLostLaunch", "SweepRelaunchExhausted",
                 "SweepClaimTimeout", "SweepInfraExhausted"}
CancelActions == {"CancelSweep", "CancelExplicit"}

VARIABLES
  now,            \* bounded engine clock (S3.4 rule 3: DB time, one clock)
  \* -- per task (tasks table) --------------------------------------------
  taskState,      \* "unused" = not yet spawned (allocation marker only)
  attempts,       \* USER-failure count; the budget max_attempts meters
  infraRetries,   \* claim-timeout count (split accounting, S3.8.2)
  hops,           \* ghost: Sleep+Chain+AwaitMiss budget consumed (MaxHops)
  policy,         \* ghost: the cancellation policy chosen at spawn
  cancelAt,       \* tasks.cancel_at_ms: armed deadline, or Inf (SQL NULL)
  firstStarted,   \* tasks.first_started_at_ms: one-shot latch, Inf = NULL
  dispatched,     \* ghost: a worker ran this task's code, or may have (a crash)
  maxAttempts,    \* tasks.max_attempts: the user-failure budget; retryTask raises it
  retries,        \* ghost: retryTask revivals consumed (MaxRetries)
  \* -- per run row (runs table); pool-allocated by nextRun ---------------
  runState,
  runTask,
  runAttempt,     \* per-task run ordinal; +1 on EVERY successor -- the
                  \* monotonic (attempt, claim_gen) fence component of S3.8
  claimGen,       \* incremented by every claim of this row
  activatedGen,   \* set by the activation CAS; invariant: <= claimGen
  relaunchCount,  \* lost-launch reopens of this row (per-row, never reset)
  leaseDeadline,  \* claim_expires_at; meaningful only while running
  availableAt,    \* due time while pending/sleeping; Inf = untimed wait
  wakeEvent,      \* runs.wake_event: last event this run waited on (parked)
  runPayload,     \* runs.event_payload: parked payload, NoPayload = NULL
  nextRun,        \* pool allocation pointer
  \* -- waits table (serial: at most one outstanding wait per run, S3.8.3;
  \*    enforced structurally -- the wait is a per-run field) -------------
  waitEv,         \* event name this run's wait row registers, or NoEvent
  waitAt,         \* wait timeout (= the run's availableAt), Inf = untimed
  \* -- events table ------------------------------------------------------
  eventState,     \* first-write-wins payload per event; NoPayload = unset
  \* -- claimed_by projection (S3.4 rule 4, replay half) ------------------
  tokRuns,        \* rows currently claimed by the LATEST wire token; every
                  \* exit from running overwrites claimed_by, so members
                  \* are always running rows (ClaimReplayBound)
  \* -- environment -------------------------------------------------------
  channel,        \* at-least-once launch channel: {[run, gen]}
  contexts,       \* live execution contexts: {[id, run, gen]}
  nextCtx,        \* context id source (ids make dual activation observable)
  \* -- ghost variables for action properties -----------------------------
  lastAction,
  lastCtx         \* [run, gen] of the acting context, for LeaseAuthority

vars == <<now, taskState, attempts, infraRetries, hops, policy, cancelAt,
          firstStarted, dispatched, maxAttempts, retries, runState, runTask, runAttempt, claimGen,
          activatedGen, relaunchCount, leaseDeadline, availableAt,
          wakeEvent, runPayload, nextRun, waitEv, waitAt, eventState,
          tokRuns, channel, contexts, nextCtx, lastAction, lastCtx>>

NoCtx == [run |-> NoRun, gen |-> 0]

OwnedRuns(t) == {r \in RunIds : runTask[r] = t /\ runState[r] # "unused"}
TopOrdinal(t) == CHOOSE o \in {runAttempt[r] : r \in OwnedRuns(t)} :
                   \A r \in OwnedRuns(t) : runAttempt[r] <= o
TopRun(t) == CHOOSE r \in OwnedRuns(t) : runAttempt[r] = TopOrdinal(t)

\* All future timestamps are clipped to the horizon (see header note).
Clip(x) == IF x > MaxTime THEN MaxTime ELSE x

\* The worker-write fence (S3.4 rules 1/5): the acting context must still
\* own the CURRENT claim of a still-running run.  claimed_by = :token is
\* claimGen[r] = c.gen under the token = (run, gen) modeling.  activatedGen
\* = c.gen is implied for any existing context (contexts are only created by
\* the CAS and later claims raise claimGen); it is stated for clarity.
\* Cancellation needs no extra conjunct: a cancelled run is not "running",
\* so every zombie write on it is already guard-disabled.
Fenced(c) ==
  /\ runState[c.run] = "running"
  /\ claimGen[c.run] = c.gen
  /\ activatedGen[c.run] = c.gen

\* An eligible task: its cancellation deadline is not yet due.  The twin of the
\* stores' eligibleTask fragment; activation, the launch deferral, and every
\* suspension require it.
EligibleTask(t) == cancelAt[t] > now

\* A launch whose claim receipt still holds: the run is running under the
\* message's claim generation and not yet activated.  Activation and the launch
\* deferral both fence on it.
ReceiptFenced(m) ==
  /\ m \in channel
  /\ runState[m.run] = "running"
  /\ claimGen[m.run] = m.gen
  /\ activatedGen[m.run] < m.gen

\* The context's task has run a handler; the start latch requires it.
MarkDispatched(c) == dispatched' = [dispatched EXCEPT ![runTask[c.run]] = TRUE]

CtxKey(c) == [run |-> c.run, gen |-> c.gen]

-----------------------------------------------------------------------------

Init ==
  /\ now = 0
  /\ taskState     = [t \in Tasks |-> "unused"]
  /\ attempts      = [t \in Tasks |-> 0]
  /\ infraRetries  = [t \in Tasks |-> 0]
  /\ hops          = [t \in Tasks |-> 0]
  /\ policy        = [t \in Tasks |-> "none"]
  /\ cancelAt      = [t \in Tasks |-> Inf]
  /\ firstStarted  = [t \in Tasks |-> Inf]
  /\ dispatched    = [t \in Tasks |-> FALSE]
  /\ maxAttempts   = [t \in Tasks |-> MaxAttempts]
  /\ retries       = [t \in Tasks |-> 0]
  /\ runState      = [r \in RunIds |-> "unused"]
  /\ runTask       = [r \in RunIds |-> CHOOSE t \in Tasks : TRUE]
  /\ runAttempt    = [r \in RunIds |-> 0]
  /\ claimGen      = [r \in RunIds |-> 0]
  /\ activatedGen  = [r \in RunIds |-> 0]
  /\ relaunchCount = [r \in RunIds |-> 0]
  /\ leaseDeadline = [r \in RunIds |-> 0]
  /\ availableAt   = [r \in RunIds |-> 0]
  /\ wakeEvent     = [r \in RunIds |-> NoEvent]
  /\ runPayload    = [r \in RunIds |-> NoPayload]
  /\ waitEv        = [r \in RunIds |-> NoEvent]
  /\ waitAt        = [r \in RunIds |-> 0]
  /\ eventState    = [e \in Events |-> NoPayload]
  /\ tokRuns = {}
  /\ nextRun = 1
  /\ channel = {}
  /\ contexts = {}
  /\ nextCtx = 1
  /\ lastAction = "Init"
  /\ lastCtx = NoCtx

-----------------------------------------------------------------------------
\* Spawn <-> batch('spawn'): task row + initial run (attempt 1), due now.
\* The cancellation policy is the spawner's nondeterministic choice; a
\* max_delay policy arms cancel_at_ms at spawn (materialized in SQL so the
\* cancel scan and nextWakeAt stay indexed reads).
\* (Idempotency-key dedup and enqueue_at overrides are not modeled.)
Spawn(t, pol) ==
  /\ taskState[t] = "unused"
  /\ nextRun <= MaxRuns
  /\ LET r == nextRun IN
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ runState'    = [runState EXCEPT ![r] = "pending"]
       /\ runTask'     = [runTask EXCEPT ![r] = t]
       /\ runAttempt'  = [runAttempt EXCEPT ![r] = 1]
       /\ availableAt' = [availableAt EXCEPT ![r] = now]
       /\ nextRun' = nextRun + 1
  /\ policy'   = [policy EXCEPT ![t] = pol]
  /\ cancelAt' = [cancelAt EXCEPT ![t] =
                    IF pol \in {"delay", "both"} THEN Clip(now + CancelLen)
                    ELSE Inf]
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, firstStarted, claimGen,
                 activatedGen, relaunchCount, leaseDeadline, wakeEvent,
                 runPayload, waitEv, waitAt, eventState, tokRuns, channel,
                 contexts, nextCtx>>
  /\ lastAction' = "Spawn" /\ lastCtx' = NoCtx

\* ClaimCore -- the claim batch's shared body (everything except the token
\* bookkeeping), used by Claim (a fresh request) and DuplicateClaim (the
\* redelivery of the latest one), K = 1 (S3.1 step 2): a due run of a live
\* task -> running, claim_gen+1, fresh lease, launch message enqueued (tick
\* step 3, fused -- see header).  The message carries the new gen; its
\* token is the (run, gen) pair.  Task bookkeeping: state -> running.
\* Attempts are deliberately untouched here -- see AttemptAccounting.
\* The model has NO cancel-deadline guard on claim; the implementation is
\* STRICTER (its claim also excludes tasks whose cancellation deadline is
\* due -- the eligibility fragment).  A more permissive model is safe for
\* every proof here: implementation behaviors are a subset of modeled
\* behaviors, and the extra modeled churn (claim then activation-refusal)
\* only widens the checked space.  Kept permissive for state-space economy.
\* The claim batch's statement 3 rides along: claiming a run whose wait
\* timed out CONSUMES the wait row, so a later emit cannot resurrect it
\* (S3.4 rule 2 timeout branch).  The run keeps wake_event with a NULL
\* payload -- exactly decodeClaimedRun's TimeoutError wake.  A sleeping
\* waiter with an unexpired timeout is unclaimable (availableAt = waitAt >
\* now), an untimed waiter never claimable (availableAt = Inf): only
\* emit's flip to pending-now frees them.
ClaimCore(r) ==
  /\ runState[r] \in {"pending", "sleeping"}
  /\ availableAt[r] <= now
  /\ taskState[runTask[r]] \notin TerminalStates
  /\ runState'      = [runState EXCEPT ![r] = "running"]
  /\ claimGen'      = [claimGen EXCEPT ![r] = @ + 1]
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![r] = Clip(now + LeaseLen)]
  /\ taskState'     = [taskState EXCEPT ![runTask[r]] = "running"]
  /\ channel' = channel \cup {[run |-> r, gen |-> claimGen[r] + 1]}
  /\ LET timedOut == waitEv[r] # NoEvent /\ waitAt[r] <= now IN
       /\ waitEv' = [waitEv EXCEPT ![r] = IF timedOut THEN NoEvent ELSE @]
       /\ waitAt' = [waitAt EXCEPT ![r] = IF timedOut THEN 0 ELSE @]
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runTask, runAttempt, activatedGen,
                 relaunchCount, availableAt, wakeEvent, runPayload,
                 eventState, nextRun, contexts, nextCtx>>

\* Claim <-> batch('claim'): a fresh request MINTS a new wire token, so the
\* claimed_by projection resets to exactly {r} (older tokens stop being
\* tracked -- the latest-only restriction, argued sound at DuplicateClaim).
Claim(r) ==
  /\ ClaimCore(r)
  /\ tokRuns' = {r}
  /\ lastAction' = "Claim" /\ lastCtx' = NoCtx

\* DuplicateClaim <-> batch('claim') REDELIVERED (S3.4 rule 4, replay
\* half): the SAME claim request -- same wire token, same parameters --
\* delivered a second (or n-th) time; the fault the fault matrix injects as
\* 'duplicate' at label 'claim'.  The second guard IS the impl's receipt
\* predicate (store.ts claim statement 1: `AND NOT EXISTS (SELECT 1 FROM
\* runs held WHERE ... held.state = 'running' AND held.claimed_by =
\* :token)`): while ANY row claimed by this token still runs, the retry is
\* an idempotent receipt -- it returns the original selection and claims
\* NOTHING.  That branch changes no state, so it is a stutter here (guard
\* false), exactly like dup-activate and re-emit.  Only when no running
\* row carries the token (its rows completed/failed/were swept/cancelled
\* -- every one of those exits overwrites claimed_by) does the retry
\* proceed, and then it is behaviorally a fresh claim under a recycled
\* token.  tokRuns' extends by UNION, deliberately not reset: if the
\* receipt guard is ever weakened (the observed bug -- a duplicated claim
\* claiming a SECOND batch of runs under the same token), the extra
\* carrier lands in tokRuns and ClaimReplayBound trips.  (That tripwire is
\* red-validated: at a two-task scope, deleting the receipt guard yields a
\* ClaimReplayBound counterexample; at the shipped one-task scopes the bug
\* class needs a second concurrently claimable run, which
\* SingleActiveRunPerTask precludes.)
\* MODEL RESTRICTION (argued sound): only the LATEST request is retryable.
\* An older token's retry hits the same token-parameterized predicate: if
\* its carrier still runs it is a receipt (changes nothing -- omitting it
\* loses no transitions), and otherwise it proceeds as a fresh claim under
\* a token no other state references -- indistinguishable from Claim to
\* every checked property.
DuplicateClaim(r) ==
  /\ \E rr \in RunIds : claimGen[rr] > 0  \* a claim request exists to retry
  /\ tokRuns = {}                         \* the impl receipt guard: no
                                          \* running row carries the token
  /\ ClaimCore(r)
  /\ tokRuns' = tokRuns \cup {r}
  /\ lastAction' = "DuplicateClaim" /\ lastCtx' = NoCtx

\* Environment: the at-least-once channel may lose a message.  (Also covers
\* "worker launched but crashed before the activation CAS".)
Drop(m) ==
  /\ m \in channel
  /\ channel' = channel \ {m}
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, taskState, attempts, infraRetries, hops, policy,
                 cancelAt, firstStarted, runState, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, wakeEvent, runPayload, waitEv, waitAt,
                 eventState, tokRuns, nextRun, contexts, nextCtx>>
  /\ lastAction' = "Drop" /\ lastCtx' = NoCtx

\* DeliverLaunch -> Activate <-> batch('activate') (S3.2): the per-claim CAS
\*   gen = claimGen /\ activatedGen < gen  (and state = running, i.e. the
\* claim was not superseded or swept), re-extending the lease.  Delivery
\* does NOT consume the message: a duplicate delivery finds activatedGen =
\* gen and is a no-op (guard false).  A successful CAS births an execution
\* context -- the only way one is created.
\* Cancellation (both statements of the impl batch):
\*   - REFUSAL GUARD: a launch whose task is already past its cancel
\*     deadline must not start (store.ts NOT EXISTS cancel_at <= now); the
\*     sweep will cancel it.  The refused run idles running-unactivated
\*     until lease expiry classifies it lost-launch.
\*   - FIRST-START REWRITE: starting disarms max_delay (its whole meaning
\*     is "cancel if never started"); max_duration is anchored at FIRST
\*     start.  Recomputed idempotently on every re-activation from the
\*     first_started latch -- NEVER re-anchored at the current activation
\*     (re-anchoring would stretch the wall-clock budget per re-claim; the
\*     reviewed inverse bug kept the stale spawn deadline via MIN and
\*     cancelled healthy running tasks).
Activate(m) ==
  /\ ReceiptFenced(m)
  /\ EligibleTask(runTask[m.run])
  /\ LET t  == runTask[m.run]
         fs == IF firstStarted[t] = Inf THEN now ELSE firstStarted[t] IN
       /\ firstStarted' = [firstStarted EXCEPT ![t] = fs]
       /\ cancelAt' = [cancelAt EXCEPT ![t] =
                         IF policy[t] \in {"dur", "both"}
                           THEN Clip(fs + CancelLen) ELSE Inf]
  /\ activatedGen'  = [activatedGen EXCEPT ![m.run] = m.gen]
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![m.run] = Clip(now + LeaseLen)]
  /\ contexts' = contexts \cup {[id |-> nextCtx, run |-> m.run, gen |-> m.gen]}
  /\ nextCtx' = nextCtx + 1
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, taskState, attempts, infraRetries, hops, policy,
                 runState, runTask, runAttempt, claimGen, relaunchCount,
                 availableAt, wakeEvent, runPayload, waitEv, waitAt,
                 eventState, tokRuns, nextRun, channel>>
  /\ lastAction' = "Activate" /\ lastCtx' = CtxKey(m)

\* DeferLaunch <-> 'defer-launch' (SPEC-FIRST): the rolling-deploy deferral,
\* decided before activation.  A worker whose build has no handler for the
\* claimed task parks the claimed run: same row, no attempt,
\* no relaunch, wake fields kept.  It is fenced on the claim receipt -- the run
\* still running under this claim generation and not yet activated -- so a
\* replay after the park, or after an activation, matches nothing.  It never
\* activates, so the first-start latch, the start deadline, and the duration
\* clock are untouched: a task no handler ever ran still carries its start
\* deadline.  Its guard also requires an eligible task, as every suspension
\* does.  Consumes a hop, the artificial suspension budget (header note);
\* production deferral ends when a worker build that knows the task arrives,
\* or at the start deadline.
DeferLaunch(m) ==
  /\ ReceiptFenced(m)
  /\ LET t == runTask[m.run] IN
       /\ EligibleTask(t)
       /\ hops[t] < MaxHops
       /\ runState'    = [runState EXCEPT ![m.run] = "sleeping"]
       /\ availableAt' = [availableAt EXCEPT ![m.run] = Clip(now + Backoff)]
       /\ taskState'   = [taskState EXCEPT ![t] = "sleeping"]
       /\ hops'        = [hops EXCEPT ![t] = @ + 1]
  /\ tokRuns' = tokRuns \ {m.run}   \* impl stamps claimed_by on exit
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, wakeEvent, runPayload,
                 waitEv, waitAt, eventState, nextRun, channel, contexts,
                 nextCtx>>
  /\ lastAction' = "Defer" /\ lastCtx' = CtxKey(m)

\* Heartbeat <-> batch('heartbeat'): extend the lease while claimed_by
\* matches and state = running.  (Impl checks claimed_by+state only; the
\* activatedGen conjunct of Fenced is implied -- see Fenced.)  A zombie's
\* heartbeat is guard-disabled = the impl's zero-row AB002 signal.
Heartbeat(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![c.run] = Clip(now + LeaseLen)]
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, taskState, attempts, infraRetries, hops, policy,
                 cancelAt, firstStarted, runState, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, availableAt,
                 wakeEvent, runPayload, waitEv, waitAt, eventState, tokRuns,
                 nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "Heartbeat" /\ lastCtx' = CtxKey(c)

\* CompleteRun <-> complete(): fenced terminal transition; context exits.
\* The task's cancel deadline is cleared (impl: cancel_at_ms = NULL).
\* fail() deliberately does NOT clear it: max_duration keeps metering the
\* task across user retries, anchored at first start.
CompleteRun(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ runState'  = [runState EXCEPT ![c.run] = "completed"]
  /\ taskState' = [taskState EXCEPT ![runTask[c.run]] = "completed"]
  /\ cancelAt'  = [cancelAt EXCEPT ![runTask[c.run]] = Inf]
  /\ contexts' = contexts \ {c}
  /\ tokRuns' = tokRuns \ {c.run}   \* impl stamps claimed_by on exit
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, attempts, infraRetries, hops, policy, firstStarted,
                 runTask, runAttempt, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, availableAt, wakeEvent, runPayload, waitEv,
                 waitAt, eventState, nextRun, channel, nextCtx>>
  /\ lastAction' = "Complete" /\ lastCtx' = CtxKey(c)

\* FailRunWithRetry <-> fail(), retry branch: USER-code failure with budget
\* left -> old run failed, successor row (ordinal+1) due after backoff,
\* attempts+1.  This is the ONLY family of actions allowed to move
\* task.attempts (AttemptAccounting).  The successor CARRIES the parked
\* wake_event/event_payload (S3.8.2: every successor-creating path carries
\* them); it starts with no wait row.
FailRunWithRetry(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t  == runTask[c.run]
         r2 == nextRun IN
       /\ attempts[t] + 1 < maxAttempts[t]   \* budget remains after this failure
       /\ nextRun <= MaxRuns
       /\ runState'    = [runState EXCEPT ![c.run] = "failed", ![r2] = "pending"]
       /\ runTask'     = [runTask EXCEPT ![r2] = t]
       /\ runAttempt'  = [runAttempt EXCEPT ![r2] = runAttempt[c.run] + 1]
       /\ availableAt' = [availableAt EXCEPT ![r2] = Clip(now + Backoff)]
       /\ wakeEvent'   = [wakeEvent EXCEPT ![r2] = wakeEvent[c.run]]
       /\ runPayload'  = [runPayload EXCEPT ![r2] = runPayload[c.run]]
       /\ attempts'    = [attempts EXCEPT ![t] = @ + 1]
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ nextRun' = nextRun + 1
  /\ contexts' = contexts \ {c}
  /\ tokRuns' = tokRuns \ {c.run}   \* impl stamps claimed_by on exit
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, infraRetries, hops, policy, cancelAt, firstStarted,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 waitEv, waitAt, eventState, channel, nextCtx>>
  /\ lastAction' = "FailRunWithRetry" /\ lastCtx' = CtxKey(c)

\* FailRunTerminal <-> fail(), max-attempts branch: budget exhausted -> run
\* and task terminally failed.  Still a user failure: attempts+1.
FailRunTerminal(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ attempts[t] + 1 >= maxAttempts[t]
       /\ runState'  = [runState EXCEPT ![c.run] = "failed"]
       /\ taskState' = [taskState EXCEPT ![t] = "failed"]
       /\ attempts'  = [attempts EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ tokRuns' = tokRuns \ {c.run}   \* impl stamps claimed_by on exit
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, infraRetries, hops, policy, cancelAt, firstStarted,
                 runTask, runAttempt, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, availableAt, wakeEvent, runPayload, waitEv,
                 waitAt, eventState, nextRun, channel, nextCtx>>
  /\ lastAction' = "FailRunTerminal" /\ lastCtx' = CtxKey(c)

\* SleepSuspend <-> reschedule() with a future wake (S3.2 sleepFor): SAME
\* run row re-scheduled, no accounting consumed; context exits.  Parked
\* wake fields are deliberately NOT cleared (header note).
\*
\* Like every suspension, it requires the owning TASK to be eligible: its
\* cancellation deadline not yet due.  Fenced(c) already implies the task is
\* live, because cancellation also cancels the task's running runs.  A task
\* about to be cancelled cannot re-park itself into the queue the claim path
\* is already refusing to launch from; the refused worker keeps its context
\* until the deadline sweep cancels the task or its lease expires, and the
\* liveness properties are checked with that refusal in place.
SleepSuspend(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ EligibleTask(t)
       /\ hops[t] < MaxHops
       /\ runState'    = [runState EXCEPT ![c.run] = "sleeping"]
       /\ availableAt' = [availableAt EXCEPT ![c.run] = Clip(now + SleepDur)]
       /\ taskState'   = [taskState EXCEPT ![t] = "sleeping"]
       /\ hops'        = [hops EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ tokRuns' = tokRuns \ {c.run}   \* impl stamps claimed_by on exit
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, attempts, infraRetries, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, wakeEvent, runPayload,
                 waitEv, waitAt, eventState, nextRun, channel, nextCtx>>
  /\ lastAction' = "Sleep" /\ lastCtx' = CtxKey(c)

\* VoluntaryChain <-> reschedule(now) (S3.2 voluntary attempt-neutral
\* chaining): same row, same attempt, due immediately; context exits.  The
\* sanctioned continuation path -- costs nothing but a hop.
VoluntaryChain(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ EligibleTask(t)
       /\ hops[t] < MaxHops
       /\ runState'    = [runState EXCEPT ![c.run] = "pending"]
       /\ availableAt' = [availableAt EXCEPT ![c.run] = now]
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ hops'        = [hops EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ tokRuns' = tokRuns \ {c.run}   \* impl stamps claimed_by on exit
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, attempts, infraRetries, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, wakeEvent, runPayload,
                 waitEv, waitAt, eventState, nextRun, channel, nextCtx>>
  /\ lastAction' = "Chain" /\ lastCtx' = CtxKey(c)

-----------------------------------------------------------------------------
\* 'await-event' (SPEC-FIRST), hit branch: the event already fired --
\* the worker reads the payload immediately and KEEPS RUNNING (no suspend,
\* no wait row, no wake-field write; the payload checkpoint is data-plane).
\* Modeled as an explicit fenced action so LeaseAuthority pins that a
\* zombie's awaitEvent batch must be guard-disabled (zero rows).
AwaitEventHit(c, e) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ eventState[e] # NoPayload
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, taskState, attempts, infraRetries, hops, policy,
                 cancelAt, firstStarted, runState, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, wakeEvent, runPayload, waitEv, waitAt,
                 eventState, tokRuns, nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "AwaitHit" /\ lastCtx' = CtxKey(c)

\* 'await-event' (SPEC-FIRST), miss branch: not yet emitted -- one
\* atomic fenced batch registers the wait AND parks the run (S3.4 rule 2:
\* register `WHERE (SELECT payload...) IS NULL` folds the branch into the
\* guard; no client round trip between check and sleep).  The run sleeps
\* with available_at = the timeout (or Inf for untimed waits -- claimable
\* only via emit's flip); wake_event is parked with a NULL payload; any
\* stale wake fields from a previous wake are overwritten.  Consumes a hop
\* (header note).  The serial-wait constraint (S3.8.3: ONE outstanding wait
\* per run) is structural: the wait is a per-run field, and a running run
\* has no wait (WaitIntegrity), so registration never finds one to violate.
AwaitRegister(c, e, tAt) ==
  LET t == runTask[c.run] IN
    /\ EligibleTask(t)
    /\ hops[t] < MaxHops
    /\ eventState[e] = NoPayload
    /\ runState'    = [runState EXCEPT ![c.run] = "sleeping"]
    /\ availableAt' = [availableAt EXCEPT ![c.run] = tAt]
    /\ waitEv'      = [waitEv EXCEPT ![c.run] = e]
    /\ waitAt'      = [waitAt EXCEPT ![c.run] = tAt]
    /\ wakeEvent'   = [wakeEvent EXCEPT ![c.run] = e]
    /\ runPayload'  = [runPayload EXCEPT ![c.run] = NoPayload]
    /\ taskState'   = [taskState EXCEPT ![t] = "sleeping"]
    /\ hops'        = [hops EXCEPT ![t] = @ + 1]
    /\ contexts' = contexts \ {c}
    /\ tokRuns' = tokRuns \ {c.run}   \* suspension carries no live token
    /\ MarkDispatched(c)
    /\ UNCHANGED <<maxAttempts, retries, now, attempts, infraRetries, policy, cancelAt,
                   firstStarted, runTask, runAttempt, claimGen,
                   activatedGen, relaunchCount, leaseDeadline, eventState,
                   nextRun, channel, nextCtx>>
    /\ lastAction' = "AwaitMiss" /\ lastCtx' = CtxKey(c)

AwaitEventMiss(c, e) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ \/ AwaitRegister(c, e, Clip(now + SleepDur))    \* with timeout
     \/ /\ cancelAt[runTask[c.run]] # Inf  \* MODEL RESTRICTION: untimed
                                           \* waits only under an armed
                                           \* cancel deadline (header note)
        /\ AwaitRegister(c, e, Inf)                  \* wait forever

\* 'emit-event' (SPEC-FIRST): ONE atomic batch, first-write-wins
\* (S3.8.3).  Guard: only the FIRST emit of a name transitions -- a re-emit
\* is a payload/first-instant no-op and may refresh only implementation
\* provenance (= stutter here; see header).  Every
\* registered waiter of the event flips sleeping -> pending due now with
\* the payload parked on its run row, its wait row deleted, and its task
\* flipped pending (durable-at-emit, inline placement).  Keying the flip on
\* the WAIT ROWS -- never on runs.wake_event ALONE -- is what makes timed-out
\* and cancelled waits non-resurrectable: their wait rows are already gone.
\*
\* MODEL/IMPL GAP: here a run has AT MOST ONE wait
\* (waitEv[r]), so "a wait row for e names run r" and "r is parked on e" are
\* the same statement.  The implementation's waits table is keyed
\* (run_id, step_name), so a run can carry a wait row while being parked on
\* something else entirely -- a durable timer, say -- and keying the flip on
\* the wait row alone woke it, up to its whole remaining sleep early.  The
\* impl therefore intersects the two: the wait row AND the run's own
\* wake_event/wake_step, and refuses a legacy NULL-step recovery when more
\* than one full witness matches.  Those checks narrow the gap but do not
\* prove that a matching row is the CURRENT registration.  PR3.8's immutable
\* wait_id/runs.active_wait_id is still required before the implementation is
\* a refinement of this one-wait-per-run action.
EmitEvent(e, p) ==
  /\ eventState[e] = NoPayload
  /\ eventState' = [eventState EXCEPT ![e] = p]
  /\ LET W == {r \in RunIds : waitEv[r] = e} IN
       /\ runState'    = [r \in RunIds |->
                            IF r \in W THEN "pending" ELSE runState[r]]
       /\ availableAt' = [r \in RunIds |->
                            IF r \in W THEN now ELSE availableAt[r]]
       /\ runPayload'  = [r \in RunIds |->
                            IF r \in W THEN p ELSE runPayload[r]]
       /\ waitEv'      = [r \in RunIds |->
                            IF r \in W THEN NoEvent ELSE waitEv[r]]
       /\ waitAt'      = [r \in RunIds |-> IF r \in W THEN 0 ELSE waitAt[r]]
       /\ taskState'   = [t \in Tasks |->
                            IF \E r \in W : runTask[r] = t THEN "pending"
                            ELSE taskState[t]]
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, wakeEvent, tokRuns, nextRun,
                 channel, contexts, nextCtx>>
  /\ lastAction' = "Emit" /\ lastCtx' = NoCtx

-----------------------------------------------------------------------------
\* Shared cancel transition <-> cancelTransition(): the task CAS (state IN
\* LIVE -> cancelled) plus its follow-ons keyed on the batch stamp: all
\* LIVE runs -> cancelled with leases cleared, all the task's wait rows
\* deleted.  Live CONTEXTS are deliberately NOT removed -- a cancelled
\* run's worker is a zombie whose every subsequent write is guard-disabled
\* (Fenced fails on state; the impl also nulls claimed_by).  This is the
\* direct running -> cancelled transition that sits OUTSIDE the
\* advisory-signal soundness argument -- hence modeled, not excluded.
\* cancel_at_ms is cleared (the deadline is consumed).
CancelCore(t) ==
  LET dead == {r \in RunIds : runTask[r] = t /\ runState[r] \in LiveStates} IN
    /\ taskState' = [taskState EXCEPT ![t] = "cancelled"]
    /\ cancelAt'  = [cancelAt EXCEPT ![t] = Inf]
    /\ runState'    = [r \in RunIds |->
                         IF r \in dead THEN "cancelled" ELSE runState[r]]
    /\ leaseDeadline' = [r \in RunIds |->
                           IF r \in dead THEN 0 ELSE leaseDeadline[r]]
    /\ availableAt' = [r \in RunIds |->
                         IF r \in dead THEN 0 ELSE availableAt[r]]
    /\ waitEv' = [r \in RunIds |-> IF r \in dead THEN NoEvent ELSE waitEv[r]]
    /\ waitAt' = [r \in RunIds |-> IF r \in dead THEN 0 ELSE waitAt[r]]
    /\ tokRuns' = tokRuns \ dead      \* impl nulls claimed_by on cancel
    /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, firstStarted,
                   runTask, runAttempt, claimGen, activatedGen,
                   relaunchCount, wakeEvent, runPayload, eventState,
                   nextRun, channel, contexts, nextCtx>>

\* CancelSweep <-> cancelTransition('sweep:cancel') via S3.1 step 0: fires
\* only on a DUE deadline (max_delay never started in time, or max_duration
\* exceeded since first start).
CancelSweep(t) ==
  /\ taskState[t] \in LiveStates
  /\ ~EligibleTask(t)
  /\ CancelCore(t)
  /\ lastAction' = "CancelSweep" /\ lastCtx' = NoCtx

\* CancelExplicit <-> cancelTransition('cancel-task'): the explicit API --
\* same transition, NO deadline guard; may fire on any live task at any
\* time (user action, hence unfair).
CancelExplicit(t) ==
  /\ taskState[t] \in LiveStates
  /\ CancelCore(t)
  /\ lastAction' = "CancelExplicit" /\ lastCtx' = NoCtx

-----------------------------------------------------------------------------
\* RetryTask <-> 'retry-task' (SPEC-FIRST, Absurd's retry_task): an operator
\* revives a FAILED task in place.  A new run row with the next ordinal after
\* every run the task has becomes due now, carrying the top run's parked wake
\* as every successor does (SuccessorCarriesWake), and the task returns to
\* pending.  A task can fail with its top run charged to no counter (the
\* infrastructure or relaunch cap), so the revival first charges that run as a
\* user attempt, keeping the accounted ordinal equal to the top ordinal, then
\* raises the budget by one.  The charge never exceeds the budget
\* (FailedChargeWithinBudget), so for a task that failed on its budget this is
\* Absurd's default of budget plus one.  Infra retries, hops, the first-start
\* latch, and the cancellation deadline are untouched, and every failed run
\* stays failed.  This is the one exception to terminal stability: a failed
\* TASK may leave "failed" here and nowhere else.  An operator action, so
\* unfair.  Bounded by MaxRetries (header).
RetryTask(t) ==
  /\ taskState[t] = "failed"
  /\ retries[t] < MaxRetries
  /\ nextRun <= MaxRuns
  /\ LET top == TopRun(t)
         r2  == nextRun IN
       /\ runState'    = [runState EXCEPT ![r2] = "pending"]
       /\ runTask'     = [runTask EXCEPT ![r2] = t]
       /\ runAttempt'  = [runAttempt EXCEPT ![r2] = TopOrdinal(t) + 1]
       /\ availableAt' = [availableAt EXCEPT ![r2] = now]
       /\ wakeEvent'   = [wakeEvent EXCEPT ![r2] = wakeEvent[top]]
       /\ runPayload'  = [runPayload EXCEPT ![r2] = runPayload[top]]
       /\ nextRun' = nextRun + 1
  /\ attempts'    = [attempts EXCEPT ![t] = TopOrdinal(t) - infraRetries[t]]
  /\ maxAttempts' = [maxAttempts EXCEPT ![t] = @ + 1]
  /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
  /\ retries'     = [retries EXCEPT ![t] = @ + 1]
  /\ UNCHANGED <<now, infraRetries, hops, policy, cancelAt,
                 firstStarted, dispatched, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, waitEv,
                 waitAt, eventState, tokRuns, channel, contexts, nextCtx>>
  /\ lastAction' = "RetryTask" /\ lastCtx' = NoCtx

LeaseExpired(r) == runState[r] = "running" /\ leaseDeadline[r] <= now

\* SweepLostLaunch <-> sweep(), lost-launch branch (S3.1 step 1): lease
\* expired and activatedGen < claimGen -- the worker never started.  Reopen
\* the SAME row: no new row, no attempt, no infra retry; relaunchCount+1
\* with backoff.  claimGen is left as-is; the stale message (if any) is
\* dead: it fails state="running" now and gen=claimGen after the re-claim.
SweepLostLaunch(r) ==
  /\ LeaseExpired(r)
  /\ activatedGen[r] < claimGen[r]
  /\ relaunchCount[r] < RelaunchCap
  /\ runState'      = [runState EXCEPT ![r] = "pending"]
  /\ availableAt'   = [availableAt EXCEPT ![r] = Clip(now + Backoff)]
  /\ relaunchCount' = [relaunchCount EXCEPT ![r] = @ + 1]
  /\ taskState'     = [taskState EXCEPT ![runTask[r]] = "pending"]
  /\ tokRuns' = tokRuns \ {r}       \* impl stamps claimed_by on reopen
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 leaseDeadline, wakeEvent, runPayload, waitEv, waitAt,
                 eventState, nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "SweepLostLaunch" /\ lastCtx' = NoCtx

\* Relaunch cap exhausted (types.ts 'relaunch-cap-exhausted'): "past its cap
\* the run fails terminally" (S3.1).  CHOICE (DESIGN is silent on the task):
\* the TASK fails terminally too -- the launcher is broken; an infra-retry
\* successor would relaunch through the same broken launcher.
SweepRelaunchExhausted(r) ==
  /\ LeaseExpired(r)
  /\ activatedGen[r] < claimGen[r]
  /\ relaunchCount[r] = RelaunchCap
  /\ runState'  = [runState EXCEPT ![r] = "failed"]
  /\ taskState' = [taskState EXCEPT ![runTask[r]] = "failed"]
  /\ tokRuns' = tokRuns \ {r}       \* impl stamps claimed_by on exit
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, availableAt, wakeEvent,
                 runPayload, waitEv, waitAt, eventState, nextRun, channel,
                 contexts, nextCtx>>
  /\ lastAction' = "SweepRelaunchExhausted" /\ lastCtx' = NoCtx

\* SweepClaimTimeout <-> sweep(), died-mid-run branch: lease expired and
\* activated -- $ClaimTimeout.  Old run failed; successor row with
\* runAttempt+1 (the S3.8 monotonic fence pair) and infraRetries+1 -- NOT
\* task.attempts (split accounting, S3.8.2).  The successor CARRIES the
\* parked wake_event/event_payload (S3.8.2).  The zombie context, if the
\* worker is actually alive, is deliberately NOT removed: from here on every
\* write it attempts is fence-rejected (LeaseAuthority) -- this is the
\* lease-overlap window, modeled.
SweepClaimTimeout(r) ==
  /\ LeaseExpired(r)
  /\ activatedGen[r] = claimGen[r]
  /\ LET t  == runTask[r]
         r2 == nextRun IN
       /\ infraRetries[t] < InfraRetryCap
       /\ nextRun <= MaxRuns
       /\ runState'     = [runState EXCEPT ![r] = "failed", ![r2] = "pending"]
       /\ runTask'      = [runTask EXCEPT ![r2] = t]
       /\ runAttempt'   = [runAttempt EXCEPT ![r2] = runAttempt[r] + 1]
       /\ availableAt'  = [availableAt EXCEPT ![r2] = Clip(now + Backoff)]
       /\ wakeEvent'    = [wakeEvent EXCEPT ![r2] = wakeEvent[r]]
       /\ runPayload'   = [runPayload EXCEPT ![r2] = runPayload[r]]
       /\ infraRetries' = [infraRetries EXCEPT ![t] = @ + 1]
       /\ taskState'    = [taskState EXCEPT ![t] = "pending"]
       /\ nextRun' = nextRun + 1
  /\ tokRuns' = tokRuns \ {r}       \* impl stamps claimed_by on exit
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, hops, policy, cancelAt, firstStarted,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 waitEv, waitAt, eventState, channel, contexts, nextCtx>>
  /\ lastAction' = "SweepClaimTimeout" /\ lastCtx' = NoCtx

\* Infra-retry cap exhausted.  CHOICE (DESIGN says only "own generous cap"):
\* terminal task failure, no successor, infraRetries NOT incremented.
SweepInfraExhausted(r) ==
  /\ LeaseExpired(r)
  /\ activatedGen[r] = claimGen[r]
  /\ infraRetries[runTask[r]] = InfraRetryCap
  /\ runState'  = [runState EXCEPT ![r] = "failed"]
  /\ taskState' = [taskState EXCEPT ![runTask[r]] = "failed"]
  /\ tokRuns' = tokRuns \ {r}       \* impl stamps claimed_by on exit
  /\ UNCHANGED <<maxAttempts, retries, dispatched, now, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runTask, runAttempt, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, availableAt, wakeEvent,
                 runPayload, waitEv, waitAt, eventState, nextRun, channel,
                 contexts, nextCtx>>
  /\ lastAction' = "SweepInfraExhausted" /\ lastCtx' = NoCtx

\* Environment: a worker silently stops -- no DB write, its context (and all
\* its future actions) simply vanishes.  Recovery is the lease timer alone.
WorkerCrash(c) ==
  /\ c \in contexts
  /\ contexts' = contexts \ {c}
  /\ MarkDispatched(c)
  /\ UNCHANGED <<maxAttempts, retries, now, taskState, attempts, infraRetries, hops, policy,
                 cancelAt, firstStarted, runState, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, wakeEvent, runPayload, waitEv, waitAt,
                 eventState, tokRuns, nextRun, channel, nextCtx>>
  /\ lastAction' = "Crash" /\ lastCtx' = NoCtx

TimeAdvance ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<maxAttempts, retries, dispatched, taskState, attempts, infraRetries, hops, policy, cancelAt,
                 firstStarted, runState, runTask, runAttempt, claimGen,
                 activatedGen, relaunchCount, leaseDeadline, availableAt,
                 wakeEvent, runPayload, waitEv, waitAt, eventState, tokRuns,
                 nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "TimeAdvance" /\ lastCtx' = NoCtx

-----------------------------------------------------------------------------
Next ==
  \/ \E t \in Tasks, pol \in Policies : Spawn(t, pol)
  \/ \E t \in Tasks : CancelSweep(t) \/ CancelExplicit(t) \/ RetryTask(t)
  \/ \E r \in RunIds : Claim(r) \/ DuplicateClaim(r) \/ SweepLostLaunch(r)
                       \/ SweepRelaunchExhausted(r) \/ SweepClaimTimeout(r)
                       \/ SweepInfraExhausted(r)
  \/ \E m \in LaunchMsgs : Drop(m) \/ Activate(m) \/ DeferLaunch(m)
  \/ \E e \in Events, p \in Payloads : EmitEvent(e, p)
  \/ \E c \in contexts : Heartbeat(c) \/ CompleteRun(c)
                         \/ FailRunWithRetry(c) \/ FailRunTerminal(c)
                         \/ SleepSuspend(c) \/ VoluntaryChain(c)
                         \/ WorkerCrash(c)
                         \/ \E e \in Events : AwaitEventHit(c, e)
                                              \/ AwaitEventMiss(c, e)
  \/ TimeAdvance

Spec == Init /\ [][Next]_vars

\* Fairness for the liveness check only: the machinery (clock, some tick's
\* claim, some delivery, some sweep, deadline-cancel enforcement)
\* eventually acts when continuously able.  Worker actions and the
\* adversary (Drop, Crash, DuplicateClaim -- a redelivery nobody is owed)
\* are deliberately UNFAIR, and so are EmitEvent and CancelExplicit
\* (user/API actions -- liveness must hold when nobody ever emits or
\* cancels): the caps, the lease timer, and deadline enforcement are what
\* guarantee progress.  ClaimAny is fair on Claim alone: progress never
\* depends on a duplicate arriving.  CancelAny is its own fairness term
\* (the impl's sweep runs the cancel scan every tick, before expired
\* leases).
ClaimAny   == \E r \in RunIds : Claim(r)
DeliverAny == \E m \in LaunchMsgs : Activate(m)
SweepAny   == \E r \in RunIds : SweepLostLaunch(r) \/ SweepRelaunchExhausted(r)
                                \/ SweepClaimTimeout(r) \/ SweepInfraExhausted(r)
CancelAny  == \E t \in Tasks : CancelSweep(t)

Fairness == /\ WF_vars(TimeAdvance)
            /\ WF_vars(ClaimAny)
            /\ WF_vars(DeliverAny)
            /\ WF_vars(SweepAny)
            /\ WF_vars(CancelAny)

SpecFair == Spec /\ Fairness

-----------------------------------------------------------------------------
\* INVARIANT 1
TypeOK ==
  /\ now \in 0..MaxTime
  /\ taskState \in [Tasks -> RunStates]
  /\ attempts \in [Tasks -> 0..(MaxAttempts + MaxRetries)]
  /\ infraRetries \in [Tasks -> 0..InfraRetryCap]
  /\ hops \in [Tasks -> 0..MaxHops]
  /\ policy \in [Tasks -> Policies]
  /\ cancelAt \in [Tasks -> 0..Inf]
  /\ firstStarted \in [Tasks -> 0..Inf]
  /\ dispatched \in [Tasks -> BOOLEAN]
  /\ maxAttempts \in [Tasks -> MaxAttempts..(MaxAttempts + MaxRetries)]
  /\ retries \in [Tasks -> 0..MaxRetries]
  /\ runState \in [RunIds -> RunStates]
  /\ runTask \in [RunIds -> Tasks]
  /\ runAttempt \in [RunIds -> 0..OrdinalBound]
  /\ claimGen \in [RunIds -> 0..GenBound]
  /\ activatedGen \in [RunIds -> 0..GenBound]
  /\ \A r \in RunIds : activatedGen[r] <= claimGen[r]
  /\ relaunchCount \in [RunIds -> 0..RelaunchCap]
  /\ leaseDeadline \in [RunIds -> 0..MaxTime]
  /\ availableAt \in [RunIds -> 0..Inf]
  /\ wakeEvent \in [RunIds -> Events \cup {NoEvent}]
  /\ runPayload \in [RunIds -> {NoPayload} \cup Payloads]
  /\ waitEv \in [RunIds -> Events \cup {NoEvent}]
  /\ waitAt \in [RunIds -> 0..Inf]
  /\ eventState \in [Events -> {NoPayload} \cup Payloads]
  /\ tokRuns \subseteq RunIds
  /\ nextRun \in 1..(MaxRuns + 1)
  /\ channel \subseteq LaunchMsgs
  /\ \A c \in contexts :
       /\ DOMAIN c = {"id", "run", "gen"}
       /\ c.id \in 1..CtxIdBound
       /\ c.run \in RunIds
       /\ c.gen \in 1..GenBound
  /\ nextCtx \in 1..(CtxIdBound + 1)
  /\ lastAction \in ActionNames
  /\ lastCtx \in [run : RunIds \cup {NoRun}, gen : 0..GenBound]

\* INVARIANT (start latch): first_started_at_ms disarms max_delay and anchors
\* max_duration (Activate), so it may be set only for a task some worker has
\* dispatched -- ran, or may have run before crashing -- or while an activated
\* context of the task is still live and may yet dispatch.  A deferral that
\* latches the start and exits without dispatching leaves a never-started task
\* with its start deadline disarmed and its duration clock running.
StartLatchMeansDispatched ==
  \A t \in Tasks :
    firstStarted[t] # Inf =>
      \/ dispatched[t]
      \/ \E c \in contexts : runTask[c.run] = t

\* INVARIANT (attempt accounting band), the executable twin of the engine
\* invariants accounting/above-top, accounting/below-top-minus-one, and
\* accounting/live-run-not-next: a spawned task's accounted ordinal (user
\* attempts plus infrastructure retries) is its highest owned run ordinal or
\* one below it, and a live task whose single live run exists runs exactly the
\* next accounted ordinal.
AccountingBand ==
  \A t \in Tasks :
    OwnedRuns(t) # {} =>
      attempts[t] + infraRetries[t] \in {TopOrdinal(t) - 1, TopOrdinal(t)}

\* INVARIANT (retryTask's budget): a failed task's charge, its top ordinal less
\* its infrastructure retries, never exceeds its budget, so a revival raises
\* the budget by exactly one.  The store's revive CAS refuses a charge past
\* the budget as corruption.
FailedChargeWithinBudget ==
  \A t \in Tasks :
    (taskState[t] = "failed" /\ OwnedRuns(t) # {}) =>
      TopOrdinal(t) - infraRetries[t] <= maxAttempts[t]

LiveRunIsNextAccounted ==
  \A t \in Tasks :
    LET live == {r \in OwnedRuns(t) : runState[r] \in LiveStates} IN
      (taskState[t] \in LiveStates /\ Cardinality(live) = 1) =>
        \A r \in live : runAttempt[r] = attempts[t] + infraRetries[t] + 1

\* INVARIANT 2 -- the OBSERVABLE for "at most one activation per (run,
\* gen)".  The CAS makes activation a one-way state change activatedGen:
\* g-1 -> g, so it structurally happens once; what could still go wrong is
\* two execution contexts both believing they hold (run, gen).  Context ids
\* make that observable: two activations of the same (run, gen) would yield
\* two records with distinct ids.
NoDualActivation ==
  \A c1, c2 \in contexts :
    (c1.run = c2.run /\ c1.gen = c2.gen) => c1 = c2

\* Corollary worth checking on its own: never two live contexts whose fence
\* currently passes for the same RUN (two writers of one run's future).
NoDualFencedWriter ==
  \A c1, c2 \in contexts :
    (Fenced(c1) /\ Fenced(c2) /\ c1.run = c2.run) => c1 = c2

\* Model-derived structure (not in the brief, cheap and catches modeling
\* bugs): a task has at most one non-terminal run row at a time -- every
\* successor is created in the same atomic batch that kills its predecessor.
SingleActiveRunPerTask ==
  \A t \in Tasks :
    Cardinality({r \in RunIds : runTask[r] = t
                   /\ runState[r] \in LiveStates})
      <= 1

TerminalTaskQuiescent ==
  \A t \in Tasks :
    taskState[t] \in TerminalStates =>
      \A r \in RunIds :
        (runTask[r] = t /\ runState[r] # "unused")
          => runState[r] \in TerminalStates

\* INVARIANT (S3.4 rule 4, replay half) -- THE CLAIM BOUND UNDER REPLAYS.
\* K = 1: however many times the latest claim request is redelivered
\* (DuplicateClaim), its wire token never owns more than one running row;
\* and a token is only ever carried by running rows (every exit from
\* running overwrites claimed_by, so tokRuns is pruned on the exit).  This
\* is the executable twin of the impl's receipt guard: the observed bug -- a
\* duplicated claim claiming a SECOND batch of runs under the same token
\* -- is exactly a second member appearing here while the first still
\* runs.  (At a one-task scope SingleActiveRunPerTask subsumes the
\* cardinality half; the guard-regression tripwire is red-validated at a
\* two-task scope -- see DuplicateClaim.)
ClaimReplayBound ==
  /\ Cardinality(tokRuns) <= 1
  /\ \A r \in tokRuns : runState[r] = "running"

\* INVARIANT (events) -- the wait-row well-formedness bundle.  The heart is
\* eventState[waitEv[r]] = NoPayload: A REGISTERED WAITER'S EVENT IS
\* UNFIRED.  Because awaitEvent registers only under the not-yet-emitted
\* guard and emitEvent flips every registered waiter (deleting its wait) in
\* the same atomic action, the state "waiting on an already-fired event" is
\* unreachable -- this is the no-lost-wakeup SAFETY core, and it is
\* precisely what the read-branch-write race (which S3.4 rule 2 forbids)
\* would violate.  The rest: waits belong to LIVE sleeping runs of live
\* tasks only (cancel/terminal paths delete them), the parked wake_event
\* mirrors the wait, the payload slot is NULL while waiting, and the run's
\* due time IS the wait timeout.
WaitIntegrity ==
  \A r \in RunIds :
    waitEv[r] # NoEvent =>
      /\ runState[r] = "sleeping"
      /\ taskState[runTask[r]] \notin TerminalStates
      /\ wakeEvent[r] = waitEv[r]
      /\ runPayload[r] = NoPayload
      /\ eventState[waitEv[r]] = NoPayload
      /\ availableAt[r] = waitAt[r]

\* INVARIANT (events): a parked payload is always EXACTLY the first-written
\* payload of the event the run was woken by -- emit copies it in the same
\* atomic action, successors carry it verbatim, and event rows are
\* immutable (EventImmutable).  A second emit overwriting a parked copy, or
\* a waiter woken with the wrong event's payload, would break this.
PayloadMatchesEvent ==
  \A r \in RunIds :
    runPayload[r] # NoPayload =>
      /\ wakeEvent[r] \in Events
      /\ eventState[wakeEvent[r]] = runPayload[r]

-----------------------------------------------------------------------------
\* PROPERTY (invariant 3, as an action property): terminal runs and tasks
\* never change state again -- "cancelled" included: cancellation is
\* terminal, and neither a straggler emit nor a zombie write nor a sweep
\* may resurrect a cancelled task or run.
TerminalStability ==
  [][ /\ \A r \in RunIds :
           runState[r] \in TerminalStates => runState'[r] = runState[r]
      /\ \A t \in Tasks :
           taskState[t] \in TerminalStates =>
             \/ taskState'[t] = taskState[t]
             \/ lastAction' = "RetryTask" /\ taskState[t] = "failed"
    ]_vars

\* PROPERTY (invariant 4): task.attempts moves only on user failures
\* (fail()'s two branches), NEVER on sweeps or cancels; infraRetries moves
\* only on SweepClaimTimeout.  Both are monotone.  Cancellation is
\* accounting-neutral: it consumes no attempt, no infra retry, no hop.
AttemptAccounting ==
  [][ /\ \A t \in Tasks : attempts'[t] >= attempts[t]
      /\ \A t \in Tasks : infraRetries'[t] >= infraRetries[t]
      /\ (attempts' # attempts)
           => lastAction' \in {"FailRunWithRetry", "FailRunTerminal", "RetryTask"}
      /\ (infraRetries' # infraRetries) => lastAction' = "SweepClaimTimeout"
      /\ lastAction' \in SweepActions \cup CancelActions
           => attempts' = attempts /\ hops' = hops
    ]_vars

\* PROPERTY (invariant 5): every worker write that actually happened was
\* taken by the context whose token (= gen, under the token modeling)
\* matches claimed_by, on a run still 'running' and activated for that very
\* claim -- evaluated in the PRE-state (unprimed).  A swept, superseded, or
\* CANCELLED context's writes are disabled (impl: zero-row fenced batches;
\* cancel additionally nulls claimed_by), so they can never be the action
\* taken.  This is the fencing that makes the tolerated lease-overlap
\* window safe -- now including the direct running -> cancelled transition:
\* after CancelSweep/CancelExplicit kill a running run under a live worker,
\* that zombie's Heartbeat/Complete/Fail/Sleep/Chain/Await all die on the
\* state guard.  awaitEvent (both branches) is a worker write and obeys the
\* same fence.
LeaseAuthority ==
  [][ lastAction' \in WorkerWrites =>
        /\ lastCtx'.run \in RunIds
        /\ runState[lastCtx'.run] = "running"
        /\ claimGen[lastCtx'.run] = lastCtx'.gen
        /\ activatedGen[lastCtx'.run] = lastCtx'.gen
    ]_vars

\* PROPERTY (events): first-write-wins immutability -- once an event's
\* payload is written it NEVER changes (a re-emit is a payload no-op; there
\* is no delete/GC in scope).
EventImmutable ==
  [][ \A e \in Events :
        eventState[e] # NoPayload => eventState'[e] = eventState[e]
    ]_vars

\* PROPERTY (events): an emit's run-state effects are confined to its
\* registered waiters -- every run an Emit step touches was a sleeping run
\* holding a wait row (on which the flip keys), and it wakes to pending.
\* In particular a run whose wait TIMED OUT (wait consumed at claim) or was
\* CANCELLED (wait deleted) is untouchable by a later emit: no resurrection
\* after timeout, S3.4 rule 2.
EmitAuthority ==
  [][ lastAction' = "Emit" =>
        \A r \in RunIds :
          (runState'[r] # runState[r]) =>
            /\ waitEv[r] # NoEvent
            /\ runState[r] = "sleeping"
            /\ runState'[r] = "pending"
    ]_vars

\* PROPERTY (events): the parked payload slot (runs.event_payload) changes
\* only through the three sanctioned channels -- (a) an emit delivering to
\* a run that was REGISTERED (pre-state wait row!), writing exactly the
\* event's payload; (b) a new await registration clearing the slot for the
\* run of the acting fenced context; (c) successor creation copying onto a
\* fresh (pre-state unused) row.  Together with WaitIntegrity this is the
\* no-resurrection theorem in action form: after a timeout consumed the
\* wait, no emit can ever set this run's payload.
PayloadAuthority ==
  [][ \A r \in RunIds :
        (runPayload'[r] # runPayload[r]) =>
          \/ /\ lastAction' = "Emit"
             /\ waitEv[r] # NoEvent
             /\ runPayload'[r] = eventState'[waitEv[r]]
          \/ /\ lastAction' = "AwaitMiss"
             /\ lastCtx'.run = r
             /\ runPayload'[r] = NoPayload
          \/ /\ lastAction' \in {"SweepClaimTimeout", "FailRunWithRetry", "RetryTask"}
             /\ runState[r] = "unused"
    ]_vars

\* PROPERTY (S3.8.2): every path that creates a successor carries the parked
\* wake.  A run row that comes into use for a task that already owns runs
\* copies wake_event and event_payload from the task's top run.
SuccessorCarriesWake ==
  [][ \A r \in RunIds :
        (runState[r] = "unused" /\ runState'[r] # "unused"
           /\ OwnedRuns(runTask'[r]) # {}) =>
          LET top == TopRun(runTask'[r]) IN
            /\ wakeEvent'[r] = wakeEvent[top]
            /\ runPayload'[r] = runPayload[top]
    ]_vars

\* PROPERTY (invariant 6, liveness; check with SPECIFICATION SpecFair):
\* every spawned task eventually reaches a terminal state.  Cap exhaustion
\* (relaunch or infra) IS terminal failure in this model, and cancellation
\* IS terminal, so "completed, failed, cancelled, or a cap" collapses to
\* TerminalStates.  Holds even when every launch drops, every worker
\* crashes, nobody ever emits, and deadlines race claims (the churn note in
\* the header).
EventuallyTerminal ==
  \A t \in Tasks :
    (taskState[t] # "unused") ~> (taskState[t] \in TerminalStates)

\* PROPERTY (events, liveness): every registered wait eventually resolves
\* -- by emit (flip), by timeout (consumed at the waking claim), or by
\* cancellation cleanup.  Untimed waits are covered because the model
\* admits them only under an armed cancel deadline (header note) and
\* CancelAny is fair.
EveryWaitResolves ==
  \A r \in RunIds : (waitEv[r] # NoEvent) ~> (waitEv[r] = NoEvent)

\* PROPERTY (events, liveness): NO LOST WAKEUP, delivery half.  A waiter
\* woken by an emit (payload parked, run pending) is eventually handed to a
\* worker -- claimed AND activated, at which point the claim payload
\* carries wake_event + event_payload (decodeClaimedRun) -- or the task
\* legitimately dies first (cancellation deadline, infra/relaunch caps:
\* policy trumps delivery).  PayloadAuthority guarantees the payload still
\* parked at that hand-off is the event's first-written payload.
WakeupDelivered ==
  \A r \in RunIds :
    (runState[r] = "pending" /\ runPayload[r] # NoPayload)
      ~> (\/ (runState[r] = "running" /\ activatedGen[r] = claimGen[r])
          \/ runState[r] \in TerminalStates)

===============================================================================
