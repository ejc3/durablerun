------------------------------ MODULE Scheduler ------------------------------
\* ===========================================================================
\* durablerun scheduler protocol -- DESIGN.md S3.1 (tick: sweep
\* classification, claim with claim_gen), S3.2 (per-claim activation CAS,
\* heartbeats, voluntary attempt-neutral chaining), S3.4 (contract rules:
\* fenced batches keyed on post-state), S3.9 (advisory-signal rule).
\*
\* GRANULARITY: one TLA+ action per labeled implementation batch
\* (packages/store-libsql/src/store.ts) -- a libSQL batch() is atomic, so
\* "SQL atomicity" is assumed exactly as action atomicity here:
\*
\*   Spawn                <-> db.batch('spawn')
\*   Claim                <-> db.batch('claim') + tick step 3 launch enqueue
\*                            (fused: "claimed but launch never sent" is
\*                            indistinguishable from a dropped message, which
\*                            Drop covers; K = 1 -- a K-run batch claim is
\*                            MORE atomic than the K interleaved single
\*                            claims modeled, so the model checks a superset
\*                            of schedules)
\*   Activate             <-> db.batch('activate')  (the per-claim CAS)
\*   Heartbeat            <-> db.batch('heartbeat')
\*   CompleteRun          <-> complete()            [PR1.5, spec'd in DESIGN]
\*   FailRunWithRetry /
\*     FailRunTerminal    <-> fail()                [PR1.5] (two branches of
\*                            one batch; Terminal is the max-attempts branch)
\*   SleepSuspend /
\*     VoluntaryChain     <-> reschedule()          [PR1.5]
\*   SweepLostLaunch / SweepRelaunchExhausted /
\*     SweepClaimTimeout / SweepInfraExhausted
\*                        <-> sweep()'s per-run fenced batches [PR1.5];
\*                            classifications match core/types.ts SweptRun
\*   Drop / WorkerCrash / TimeAdvance : environment, not batches.
\*
\* WORKERS ARE IMPLICIT: an "execution context" record is created per
\* delivered activation (the set `contexts`); after activation a context may
\* Heartbeat any number of times, then take exactly one of
\* Complete/Fail/Sleep/Chain -- or crash/hang.  "2 workers" of the sizing
\* brief = up to 2 concurrent contexts, which the run pool already bounds.
\* Concurrent tick drivers need no explicit count either: any interleaving of
\* Claim/Sweep actions IS N concurrent ticks (claims arbitrate in the DB).
\*
\* THE LAUNCH CHANNEL IS AT-LEAST-ONCE: `channel` is a set that delivery
\* does NOT remove from (so redelivery is always possible), plus an explicit
\* Drop action for loss.  Dedup happens ONLY at the activation CAS.
\*
\* DELIBERATELY NOT MODELED (honest list):
\*  - Checkpoint content, the data plane (RunStateStore), events/waits,
\*    cancellation policies, child tasks, defer-unknown-task, multi-queue,
\*    multi-shard.
\*  - SQL atomicity: assumed as action atomicity (see mapping above).
\*  - Token randomness: a claim of run r is uniquely named by (r, claim_gen),
\*    so claim_token is modeled AS the pair -- "claimed_by = :token" becomes
\*    "claimGen[r] = c.gen".  Cross-run UUID collisions are not modeled.
\*  - Pings, alarms, cron, EndingFeed, expireLeaseNow: by S3.9's
\*    advisory-signal rule these may only ACCELERATE what lease expiry does
\*    anyway; TimeAdvance already reaches lease expiry, so omitting them
\*    removes no reachable states -- only timing, which fairness abstracts.
\*  - Heartbeat throttling, clock skew (engine time is the single `now` --
\*    S3.4 rule 3 "engine time is database time" makes this faithful).
\*  - The brief lease-overlap window Absurd tolerates IS modeled: sweeping a
\*    run does NOT remove its live (zombie) context; the zombie may still
\*    attempt Heartbeat/Complete/Fail/Sleep/Chain and every attempt must be
\*    guard-disabled (the impl's zero-row fenced batch).  LeaseAuthority is
\*    exactly that check.
\*
\* BOUNDED-TIME ARTIFACTS: every future timestamp is capped at MaxTime.  At
\* the horizon, backoffs collapse to "due now" and fresh leases are born
\* expired -- an over-approximation (more adversarial interleavings, never
\* fewer), and what makes the liveness property checkable in bounded time.
\* Off the horizon (now < MaxTime) all delays are strictly future.
\*
\* SUGGESTED CONSTANTS (exhaustive TLC in seconds-to-minutes):
\*   Tasks = {t1}   MaxRuns = 3   MaxTime = 4   MaxAttempts = 2
\*   InfraRetryCap = 1   RelaunchCap = 1   MaxHops = 1
\*   LeaseLen = 2   SleepDur = 1   Backoff = 1
\* Two-task variant: Tasks = {t1, t2}, MaxRuns = 6 (safety-only recommended:
\* SPECIFICATION Spec, drop EventuallyTerminal).
\* ===========================================================================
EXTENDS Naturals, FiniteSets

CONSTANTS
  Tasks,          \* task ids (model values)
  MaxRuns,        \* run-row pool; successors allocate from it
  MaxTime,        \* time horizon (bounded nat clock)
  MaxAttempts,    \* user-failure budget per task (task.max_attempts)
  InfraRetryCap,  \* cap on claim-timeout successors per task ("own generous
                  \* cap" in DESIGN S3.8.2 -- size unspecified there)
  RelaunchCap,    \* cap on lost-launch reopens per run row (S3.1 step 1)
  MaxHops,        \* Sleep+Chain budget per task.  ARTIFICIAL: real workflows
                  \* may suspend unboundedly (bounded in production by the
                  \* cancellation.max_duration policy, S3.2, not modeled);
                  \* bounded here so liveness is checkable.
  LeaseLen,       \* lease length (claim & heartbeat extension)
  SleepDur,       \* sleepFor duration
  Backoff         \* retry/reopen backoff delay

ASSUME
  /\ MaxAttempts \in Nat \ {0}
  /\ InfraRetryCap \in Nat
  /\ RelaunchCap \in Nat
  /\ MaxHops \in Nat
  /\ MaxTime \in Nat \ {0}
  /\ LeaseLen \in Nat \ {0}
  /\ SleepDur \in Nat \ {0}
  /\ Backoff \in Nat \ {0}
  /\ MaxRuns \in Nat \ {0}
  \* Pool sizing so successor creation is never blocked (else liveness would
  \* fail on an artifact): per task, rows = 1 initial + at most
  \* (MaxAttempts-1) user-retry successors + InfraRetryCap infra successors.
  /\ MaxRuns >= Cardinality(Tasks) * (MaxAttempts + InfraRetryCap)

RunIds        == 1..MaxRuns
NoRun         == 0
\* Claims of one run row: 1 initial + at most MaxHops sleep/chain re-claims
\* + at most RelaunchCap lost-launch re-claims.  TypeOK verifies this bound.
GenBound      == 1 + MaxHops + RelaunchCap
\* run.attempt ordinal: starts at 1, +1 per successor (user or infra).
OrdinalBound  == MaxAttempts + InfraRetryCap
CtxIdBound    == MaxRuns * GenBound

RunStates      == {"unused", "pending", "running", "sleeping", "completed", "failed"}
TerminalStates == {"completed", "failed"}
LaunchMsgs     == [run : RunIds, gen : 1..GenBound]

ActionNames ==
  {"Init", "Spawn", "Claim", "Drop", "Activate", "Heartbeat", "Complete",
   "FailRunWithRetry", "FailRunTerminal", "Sleep", "Chain",
   "SweepLostLaunch", "SweepRelaunchExhausted", "SweepClaimTimeout",
   "SweepInfraExhausted", "Crash", "TimeAdvance"}

WorkerWrites == {"Heartbeat", "Complete", "FailRunWithRetry",
                 "FailRunTerminal", "Sleep", "Chain"}
SweepActions == {"SweepLostLaunch", "SweepRelaunchExhausted",
                 "SweepClaimTimeout", "SweepInfraExhausted"}

VARIABLES
  now,            \* bounded engine clock (S3.4 rule 3: DB time, one clock)
  \* -- per task (tasks table) --------------------------------------------
  taskState,      \* "unused" = not yet spawned (allocation marker only)
  attempts,       \* USER-failure count; the budget max_attempts meters
  infraRetries,   \* claim-timeout count (split accounting, S3.8.2)
  hops,           \* ghost: Sleep+Chain budget consumed (see MaxHops)
  \* -- per run row (runs table); pool-allocated by nextRun ---------------
  runState,
  runTask,
  runAttempt,     \* per-task run ordinal; +1 on EVERY successor -- the
                  \* monotonic (attempt, claim_gen) fence component of S3.8
  claimGen,       \* incremented by every claim of this row
  activatedGen,   \* set by the activation CAS; invariant: <= claimGen
  relaunchCount,  \* lost-launch reopens of this row (per-row, never reset)
  leaseDeadline,  \* claim_expires_at; meaningful only while running
  availableAt,    \* due time while pending/sleeping
  nextRun,        \* pool allocation pointer
  \* -- environment -------------------------------------------------------
  channel,        \* at-least-once launch channel: {[run, gen]}
  contexts,       \* live execution contexts: {[id, run, gen]}
  nextCtx,        \* context id source (ids make dual activation observable)
  \* -- ghost variables for action properties -----------------------------
  lastAction,
  lastCtx         \* [run, gen] of the acting context, for LeaseAuthority

vars == <<now, taskState, attempts, infraRetries, hops,
          runState, runTask, runAttempt, claimGen, activatedGen,
          relaunchCount, leaseDeadline, availableAt, nextRun,
          channel, contexts, nextCtx, lastAction, lastCtx>>

NoCtx == [run |-> NoRun, gen |-> 0]

\* All future timestamps are clipped to the horizon (see header note).
Clip(x) == IF x > MaxTime THEN MaxTime ELSE x

\* The worker-write fence (S3.4 rules 1/5): the acting context must still
\* own the CURRENT claim of a still-running run.  claimed_by = :token is
\* claimGen[r] = c.gen under the token = (run, gen) modeling.  activatedGen
\* = c.gen is implied for any existing context (contexts are only created by
\* the CAS and later claims raise claimGen); it is stated for clarity.
Fenced(c) ==
  /\ runState[c.run] = "running"
  /\ claimGen[c.run] = c.gen
  /\ activatedGen[c.run] = c.gen

CtxKey(c) == [run |-> c.run, gen |-> c.gen]

-----------------------------------------------------------------------------

Init ==
  /\ now = 0
  /\ taskState     = [t \in Tasks |-> "unused"]
  /\ attempts      = [t \in Tasks |-> 0]
  /\ infraRetries  = [t \in Tasks |-> 0]
  /\ hops          = [t \in Tasks |-> 0]
  /\ runState      = [r \in RunIds |-> "unused"]
  /\ runTask       = [r \in RunIds |-> CHOOSE t \in Tasks : TRUE]
  /\ runAttempt    = [r \in RunIds |-> 0]
  /\ claimGen      = [r \in RunIds |-> 0]
  /\ activatedGen  = [r \in RunIds |-> 0]
  /\ relaunchCount = [r \in RunIds |-> 0]
  /\ leaseDeadline = [r \in RunIds |-> 0]
  /\ availableAt   = [r \in RunIds |-> 0]
  /\ nextRun = 1
  /\ channel = {}
  /\ contexts = {}
  /\ nextCtx = 1
  /\ lastAction = "Init"
  /\ lastCtx = NoCtx

-----------------------------------------------------------------------------
\* Spawn <-> batch('spawn'): task row + initial run (attempt 1), due now.
\* (Idempotency-key dedup and enqueue_at overrides are not modeled.)
Spawn(t) ==
  /\ taskState[t] = "unused"
  /\ nextRun <= MaxRuns
  /\ LET r == nextRun IN
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ runState'    = [runState EXCEPT ![r] = "pending"]
       /\ runTask'     = [runTask EXCEPT ![r] = t]
       /\ runAttempt'  = [runAttempt EXCEPT ![r] = 1]
       /\ availableAt' = [availableAt EXCEPT ![r] = now]
       /\ nextRun' = nextRun + 1
  /\ UNCHANGED <<now, attempts, infraRetries, hops, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, channel, contexts, nextCtx>>
  /\ lastAction' = "Spawn" /\ lastCtx' = NoCtx

\* Claim <-> batch('claim'), K = 1 (S3.1 step 2): a due run of a live task
\* -> running, claim_gen+1, fresh lease, launch message enqueued (tick step
\* 3, fused -- see header).  The message carries the new gen; its token is
\* the (run, gen) pair.  Task bookkeeping: state -> running.  NOTE the model
\* does NOT mirror store.ts's `attempts = MAX(attempts, run.attempt)` here
\* -- see AttemptAccounting; that impl line conflicts with the split
\* accounting this spec checks (review finding).
Claim(r) ==
  /\ runState[r] \in {"pending", "sleeping"}
  /\ availableAt[r] <= now
  /\ taskState[runTask[r]] \notin TerminalStates
  /\ runState'      = [runState EXCEPT ![r] = "running"]
  /\ claimGen'      = [claimGen EXCEPT ![r] = @ + 1]
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![r] = Clip(now + LeaseLen)]
  /\ taskState'     = [taskState EXCEPT ![runTask[r]] = "running"]
  /\ channel' = channel \cup {[run |-> r, gen |-> claimGen[r] + 1]}
  /\ UNCHANGED <<now, attempts, infraRetries, hops, runTask, runAttempt,
                 activatedGen, relaunchCount, availableAt, nextRun,
                 contexts, nextCtx>>
  /\ lastAction' = "Claim" /\ lastCtx' = NoCtx

\* Environment: the at-least-once channel may lose a message.  (Also covers
\* "worker launched but crashed before the activation CAS".)
Drop(m) ==
  /\ m \in channel
  /\ channel' = channel \ {m}
  /\ UNCHANGED <<now, taskState, attempts, infraRetries, hops, runState,
                 runTask, runAttempt, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, availableAt, nextRun, contexts, nextCtx>>
  /\ lastAction' = "Drop" /\ lastCtx' = NoCtx

\* DeliverLaunch -> Activate <-> batch('activate') (S3.2): the per-claim CAS
\*   gen = claimGen /\ activatedGen < gen  (and state = running, i.e. the
\* claim was not superseded or swept), re-extending the lease.  Delivery
\* does NOT consume the message: a duplicate delivery finds activatedGen =
\* gen and is a no-op (guard false).  A successful CAS births an execution
\* context -- the only way one is created.
Activate(m) ==
  /\ m \in channel
  /\ runState[m.run] = "running"
  /\ claimGen[m.run] = m.gen
  /\ activatedGen[m.run] < m.gen
  /\ activatedGen'  = [activatedGen EXCEPT ![m.run] = m.gen]
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![m.run] = Clip(now + LeaseLen)]
  /\ contexts' = contexts \cup {[id |-> nextCtx, run |-> m.run, gen |-> m.gen]}
  /\ nextCtx' = nextCtx + 1
  /\ UNCHANGED <<now, taskState, attempts, infraRetries, hops, runState,
                 runTask, runAttempt, claimGen, relaunchCount, availableAt,
                 nextRun, channel>>
  /\ lastAction' = "Activate" /\ lastCtx' = CtxKey(m)

\* Heartbeat <-> batch('heartbeat'): extend the lease while claimed_by
\* matches and state = running.  (Impl checks claimed_by+state only; the
\* activatedGen conjunct of Fenced is implied -- see Fenced.)  A zombie's
\* heartbeat is guard-disabled = the impl's zero-row AB002 signal.
Heartbeat(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ leaseDeadline' = [leaseDeadline EXCEPT ![c.run] = Clip(now + LeaseLen)]
  /\ UNCHANGED <<now, taskState, attempts, infraRetries, hops, runState,
                 runTask, runAttempt, claimGen, activatedGen, relaunchCount,
                 availableAt, nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "Heartbeat" /\ lastCtx' = CtxKey(c)

\* CompleteRun <-> complete(): fenced terminal transition; context exits.
CompleteRun(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ runState'  = [runState EXCEPT ![c.run] = "completed"]
  /\ taskState' = [taskState EXCEPT ![runTask[c.run]] = "completed"]
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, attempts, infraRetries, hops, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, nextRun, channel, nextCtx>>
  /\ lastAction' = "Complete" /\ lastCtx' = CtxKey(c)

\* FailRunWithRetry <-> fail(), retry branch: USER-code failure with budget
\* left -> old run failed, successor row (ordinal+1) due after backoff,
\* attempts+1.  This is the ONLY family of actions allowed to move
\* task.attempts (AttemptAccounting).
FailRunWithRetry(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t  == runTask[c.run]
         r2 == nextRun IN
       /\ attempts[t] + 1 < MaxAttempts   \* budget remains after this failure
       /\ nextRun <= MaxRuns
       /\ runState'    = [runState EXCEPT ![c.run] = "failed", ![r2] = "pending"]
       /\ runTask'     = [runTask EXCEPT ![r2] = t]
       /\ runAttempt'  = [runAttempt EXCEPT ![r2] = runAttempt[c.run] + 1]
       /\ availableAt' = [availableAt EXCEPT ![r2] = Clip(now + Backoff)]
       /\ attempts'    = [attempts EXCEPT ![t] = @ + 1]
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ nextRun' = nextRun + 1
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, infraRetries, hops, claimGen, activatedGen,
                 relaunchCount, leaseDeadline, channel, nextCtx>>
  /\ lastAction' = "FailRunWithRetry" /\ lastCtx' = CtxKey(c)

\* FailRunTerminal <-> fail(), max-attempts branch: budget exhausted -> run
\* and task terminally failed.  Still a user failure: attempts+1.
FailRunTerminal(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ attempts[t] + 1 >= MaxAttempts
       /\ runState'  = [runState EXCEPT ![c.run] = "failed"]
       /\ taskState' = [taskState EXCEPT ![t] = "failed"]
       /\ attempts'  = [attempts EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, infraRetries, hops, runTask, runAttempt, claimGen,
                 activatedGen, relaunchCount, leaseDeadline, availableAt,
                 nextRun, channel, nextCtx>>
  /\ lastAction' = "FailRunTerminal" /\ lastCtx' = CtxKey(c)

\* SleepSuspend <-> reschedule() with a future wake (S3.2 sleepFor): SAME
\* run row re-scheduled, no accounting consumed; context exits.
SleepSuspend(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ hops[t] < MaxHops
       /\ runState'    = [runState EXCEPT ![c.run] = "sleeping"]
       /\ availableAt' = [availableAt EXCEPT ![c.run] = Clip(now + SleepDur)]
       /\ taskState'   = [taskState EXCEPT ![t] = "sleeping"]
       /\ hops'        = [hops EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, attempts, infraRetries, runTask, runAttempt, claimGen,
                 activatedGen, relaunchCount, leaseDeadline, nextRun,
                 channel, nextCtx>>
  /\ lastAction' = "Sleep" /\ lastCtx' = CtxKey(c)

\* VoluntaryChain <-> reschedule(now) (S3.2 voluntary attempt-neutral
\* chaining): same row, same attempt, due immediately; context exits.  The
\* sanctioned continuation path -- costs nothing but a hop.
VoluntaryChain(c) ==
  /\ c \in contexts
  /\ Fenced(c)
  /\ LET t == runTask[c.run] IN
       /\ hops[t] < MaxHops
       /\ runState'    = [runState EXCEPT ![c.run] = "pending"]
       /\ availableAt' = [availableAt EXCEPT ![c.run] = now]
       /\ taskState'   = [taskState EXCEPT ![t] = "pending"]
       /\ hops'        = [hops EXCEPT ![t] = @ + 1]
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, attempts, infraRetries, runTask, runAttempt, claimGen,
                 activatedGen, relaunchCount, leaseDeadline, nextRun,
                 channel, nextCtx>>
  /\ lastAction' = "Chain" /\ lastCtx' = CtxKey(c)

-----------------------------------------------------------------------------
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
  /\ UNCHANGED <<now, attempts, infraRetries, hops, runTask, runAttempt,
                 claimGen, activatedGen, leaseDeadline, nextRun, channel,
                 contexts, nextCtx>>
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
  /\ UNCHANGED <<now, attempts, infraRetries, hops, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "SweepRelaunchExhausted" /\ lastCtx' = NoCtx

\* SweepClaimTimeout <-> sweep(), died-mid-run branch: lease expired and
\* activated -- $ClaimTimeout.  Old run failed; successor row with
\* runAttempt+1 (the S3.8 monotonic fence pair) and infraRetries+1 -- NOT
\* task.attempts (split accounting, S3.8.2).  The zombie context, if the
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
       /\ infraRetries' = [infraRetries EXCEPT ![t] = @ + 1]
       /\ taskState'    = [taskState EXCEPT ![t] = "pending"]
       /\ nextRun' = nextRun + 1
  /\ UNCHANGED <<now, attempts, hops, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, channel, contexts, nextCtx>>
  /\ lastAction' = "SweepClaimTimeout" /\ lastCtx' = NoCtx

\* Infra-retry cap exhausted.  CHOICE (DESIGN says only "own generous cap"):
\* terminal task failure, no successor, infraRetries NOT incremented.
SweepInfraExhausted(r) ==
  /\ LeaseExpired(r)
  /\ activatedGen[r] = claimGen[r]
  /\ infraRetries[runTask[r]] = InfraRetryCap
  /\ runState'  = [runState EXCEPT ![r] = "failed"]
  /\ taskState' = [taskState EXCEPT ![runTask[r]] = "failed"]
  /\ UNCHANGED <<now, attempts, infraRetries, hops, runTask, runAttempt,
                 claimGen, activatedGen, relaunchCount, leaseDeadline,
                 availableAt, nextRun, channel, contexts, nextCtx>>
  /\ lastAction' = "SweepInfraExhausted" /\ lastCtx' = NoCtx

\* Environment: a worker silently stops -- no DB write, its context (and all
\* its future actions) simply vanishes.  Recovery is the lease timer alone.
WorkerCrash(c) ==
  /\ c \in contexts
  /\ contexts' = contexts \ {c}
  /\ UNCHANGED <<now, taskState, attempts, infraRetries, hops, runState,
                 runTask, runAttempt, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, availableAt, nextRun, channel, nextCtx>>
  /\ lastAction' = "Crash" /\ lastCtx' = NoCtx

TimeAdvance ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<taskState, attempts, infraRetries, hops, runState, runTask,
                 runAttempt, claimGen, activatedGen, relaunchCount,
                 leaseDeadline, availableAt, nextRun, channel, contexts,
                 nextCtx>>
  /\ lastAction' = "TimeAdvance" /\ lastCtx' = NoCtx

-----------------------------------------------------------------------------
Next ==
  \/ \E t \in Tasks : Spawn(t)
  \/ \E r \in RunIds : Claim(r) \/ SweepLostLaunch(r)
                       \/ SweepRelaunchExhausted(r) \/ SweepClaimTimeout(r)
                       \/ SweepInfraExhausted(r)
  \/ \E m \in LaunchMsgs : Drop(m) \/ Activate(m)
  \/ \E c \in contexts : Heartbeat(c) \/ CompleteRun(c)
                         \/ FailRunWithRetry(c) \/ FailRunTerminal(c)
                         \/ SleepSuspend(c) \/ VoluntaryChain(c)
                         \/ WorkerCrash(c)
  \/ TimeAdvance

Spec == Init /\ [][Next]_vars

\* Fairness for the liveness check only: the machinery (clock, some tick's
\* claim, some delivery, some sweep) eventually acts when continuously able.
\* Worker actions and the adversary (Drop, Crash) are deliberately UNFAIR:
\* liveness must hold even when every launch is dropped, every worker hangs
\* or crashes -- the caps and the lease timer are what guarantee progress.
ClaimAny   == \E r \in RunIds : Claim(r)
DeliverAny == \E m \in LaunchMsgs : Activate(m)
SweepAny   == \E r \in RunIds : SweepLostLaunch(r) \/ SweepRelaunchExhausted(r)
                                \/ SweepClaimTimeout(r) \/ SweepInfraExhausted(r)

Fairness == /\ WF_vars(TimeAdvance)
            /\ WF_vars(ClaimAny)
            /\ WF_vars(DeliverAny)
            /\ WF_vars(SweepAny)

SpecFair == Spec /\ Fairness

-----------------------------------------------------------------------------
\* INVARIANT 1
TypeOK ==
  /\ now \in 0..MaxTime
  /\ taskState \in [Tasks -> RunStates]
  /\ attempts \in [Tasks -> 0..MaxAttempts]
  /\ infraRetries \in [Tasks -> 0..InfraRetryCap]
  /\ hops \in [Tasks -> 0..MaxHops]
  /\ runState \in [RunIds -> RunStates]
  /\ runTask \in [RunIds -> Tasks]
  /\ runAttempt \in [RunIds -> 0..OrdinalBound]
  /\ claimGen \in [RunIds -> 0..GenBound]
  /\ activatedGen \in [RunIds -> 0..GenBound]
  /\ \A r \in RunIds : activatedGen[r] <= claimGen[r]
  /\ relaunchCount \in [RunIds -> 0..RelaunchCap]
  /\ leaseDeadline \in [RunIds -> 0..MaxTime]
  /\ availableAt \in [RunIds -> 0..MaxTime]
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
                   /\ runState[r] \in {"pending", "running", "sleeping"}})
      <= 1

TerminalTaskQuiescent ==
  \A t \in Tasks :
    taskState[t] \in TerminalStates =>
      \A r \in RunIds :
        (runTask[r] = t /\ runState[r] # "unused")
          => runState[r] \in TerminalStates

-----------------------------------------------------------------------------
\* PROPERTY (invariant 3, as an action property): terminal runs and tasks
\* never change state again.
TerminalStability ==
  [][ /\ \A r \in RunIds :
           runState[r] \in TerminalStates => runState'[r] = runState[r]
      /\ \A t \in Tasks :
           taskState[t] \in TerminalStates => taskState'[t] = taskState[t]
    ]_vars

\* PROPERTY (invariant 4): task.attempts moves only on user failures
\* (fail()'s two branches), NEVER on sweeps; infraRetries moves only on
\* SweepClaimTimeout.  Both are monotone.
AttemptAccounting ==
  [][ /\ \A t \in Tasks : attempts'[t] >= attempts[t]
      /\ \A t \in Tasks : infraRetries'[t] >= infraRetries[t]
      /\ (attempts' # attempts)
           => lastAction' \in {"FailRunWithRetry", "FailRunTerminal"}
      /\ (infraRetries' # infraRetries) => lastAction' = "SweepClaimTimeout"
      /\ lastAction' \in SweepActions => attempts' = attempts
    ]_vars

\* PROPERTY (invariant 5): every worker write that actually happened was
\* taken by the context whose token (= gen, under the token modeling)
\* matches claimed_by, on a run still 'running' and activated for that very
\* claim -- evaluated in the PRE-state (unprimed).  A swept or superseded
\* context's writes are disabled (impl: zero-row fenced batches), so they
\* can never be the action taken.  This is the fencing that makes the
\* tolerated lease-overlap window safe.
LeaseAuthority ==
  [][ lastAction' \in WorkerWrites =>
        /\ lastCtx'.run \in RunIds
        /\ runState[lastCtx'.run] = "running"
        /\ claimGen[lastCtx'.run] = lastCtx'.gen
        /\ activatedGen[lastCtx'.run] = lastCtx'.gen
    ]_vars

\* PROPERTY (invariant 6, liveness; check with SPECIFICATION SpecFair):
\* every spawned task eventually reaches a terminal state.  Cap exhaustion
\* (relaunch or infra) IS terminal failure in this model, so "completed,
\* failed, or the relaunch cap" collapses to TerminalStates.
EventuallyTerminal ==
  \A t \in Tasks :
    (taskState[t] # "unused") ~> (taskState[t] \in TerminalStates)

===============================================================================
