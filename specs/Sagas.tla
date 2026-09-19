------------------------------- MODULE Sagas -------------------------------
\* Sagas: per-step rollbacks (DESIGN.md S3.10), modeled ahead of their SQL.
\*
\* A side model, as WakeDelivery.tla and ChildTasks.tla are.  Scheduler.tla proves
\* ownership, leases, retries, and the terminal transitions for one task, and it
\* is already at the largest scope TLC can exhaust.  So the one thing a saga
\* adds is modeled alone: the rolling-back phase between the decision that a task
\* fails terminally and the task's terminal state.
\*
\* THE PROTOCOL.  A step that registers a rollback writes a START marker before
\* its body runs, carrying an ordering index, and its result when the body ends.
\* When the task's terminal failure is decided, the same atomic batch enters the
\* rolling-back phase, a durable marker.  From then on no forward step runs.  The
\* task function re-runs, memoized steps skip, and the rollback of every
\* registered step that started runs as a durable step of its own, in reverse
\* start order, each under its own retry budget.  A rollback that fails for good
\* halts the rest.  The task ends failed either way, and the rollback outcome,
\* complete or failed, is a separate field of its result.
\*
\* THREE QUESTIONS DESIGN.md DOES NOT SETTLE, each isolated as one constant that
\* actions read and an invariant holds, so the protocol is checked under both
\* answers:
\*  - CancelMidRollback.  "halts": cancelling a task that is rolling back wins,
\*    the remaining rollbacks never run, and the outcome is failed exactly when a
\*    step that started is left uncompensated.
\*    "refused": a task that is rolling back cannot be cancelled.
\*  - ReviveAfterSaga.  "refused": retry-task refuses a failed task whose saga
\*    began.  "fresh": it admits one whose saga COMPLETED, forgets every
\*    rolled-back step, and starts a new saga generation.  Reviving without
\*    forgetting is unsound under either answer: the forward replay would skip
\*    memoized steps whose effects were compensated.
\*  - InfraCapRollsBack.  TRUE: a task the sweeps fail at an infrastructure cap
\*    enters the rolling-back phase like any other terminal failure.  FALSE: it
\*    fails at once and its steps stay uncompensated, with no outcome recorded.
\*
\* WHAT THE SQL OWES THIS MODEL, beyond its actions:
\*  - The start marker is committed BEFORE the step body runs.  Today a step
\*    commits only after its body returns, so a step that started and never
\*    persisted leaves nothing to find.
\*  - The ordering index is first-write-wins for a step within a saga generation,
\*    so a step retried by a later attempt keeps its place, and no two started
\*    steps share one.  A fresh revival forgets it with the step, so the SQL keys
\*    it by generation: an index kept across a revival would order the next
\*    saga's rollbacks by the last one's starts.
\*  - The terminal decision and the phase marker are one batch.  As two steps, a
\*    crash between them leaves a failed task that no worker will ever run again.
\*  - Rollback passes are admitted past the task's user attempt budget, which is
\*    spent by then, and each rollback's budget is durable with the rollback.
\*    Within a generation its spent attempts are never given back.  A failed
\*    attempt that is not counted at all is a stuttering step, which no property
\*    here can see, so a conformance case owes that half.
\*  - Under "fresh", the rollback checkpoints belong to a saga generation, so a
\*    second saga does not find the first one's rollbacks memoized.
\*
\* NOT MODELED, and why that is sound or what bounds it:
\*  - A failure with budget left.  It is a retry, it changes nothing a saga
\*    reads, and it is not an action here.  An error the user code catches never
\*    reaches the engine at all.
\*  - Leases, claims, and crashes.  Every action is one fenced batch, which
\*    Scheduler.tla proves.  A crash between batches changes nothing durable, and
\*    the next rollback is a function of durable state alone, so a pass that
\*    resumes derives the same sequence.
\*  - How often a handler's body runs.  A rollback is a durable step, so its
\*    body runs at least once per commit, and handlers must be idempotent.
\*  - A cancellation in the forward phase triggers no rollback, as S3.10 has it:
\*    only a terminal failure does.
\*  - Reviving a HALTED saga to retry its rollbacks.  No such operation exists.
\*  - A saga with nothing to roll back is complete at entry.  The SQL may skip
\*    the phase for it.
\*
\* Ledger.  The quoted labels are the stores' batches, and DESIGN.md S3.10 gives
\* the same mapping as a table.  A saga's state is checkpoints under reserved
\* names (core sagas.ts), so no action needed a new kind of statement, and one
\* new label exists: 'fail-rollback'.  scripts/spec-ledger.py reads Scheduler.tla
\* only, where 'fail-rollback' is listed and 'set-checkpoint' is excluded, so
\* nothing checks this block.  Every guard below has an executable twin on every
\* dialect: the `sagas` conformance surface and the SDK's saga suite.
\*   'set-checkpoint' of $started:<step> -> StartStep;  of a step -> FinishStep
\*   'fail' with no retry, or with a retry the budget refuses, in the forward
\*     phase -> UserTerminal  [cas-fenced]
\*   'sweep:lost-launch' cap, 'sweep:claim-timeout' at the infra cap -> InfraCap,
\*     in either phase: it enters the phase from the forward one, and ends the
\*     task inside it
\*   'set-checkpoint' of $rollback:<step> -> RunRollback
\*   'fail-rollback' with a retry -> RollbackRetry;  with none -> RollbackHalts
\*   'fail' with no retry, in the rolling-back phase -> FinishSaga
\*   'cancel-task', 'sweep:cancel' -> Cancel;  'retry-task' -> Revive
\* LateMarker and LateEnter exist only for the vacuity probes and map to nothing.
\* The model's CancelMidRollback, ReviveAfterSaga, and InfraCapRollsBack are
\* decided: "halts", "refused", and TRUE.
EXTENDS Naturals

CONSTANTS
  Steps,                \* the task's steps.  ARTIFICIAL bound.
  Registered,           \* the steps that registered a rollback
  MaxRollbackAttempts,  \* a rollback's own budget.  ARTIFICIAL bound.
  MaxRevivals,          \* retry-task revivals.  ARTIFICIAL bound.
  CancelMidRollback,    \* "halts" or "refused"
  ReviveAfterSaga,      \* "refused" or "fresh"
  InfraCapRollsBack,    \* TRUE or FALSE
  AtomicEnter,          \* TRUE in the protocol.  FALSE only in a vacuity probe.
  MarkerFirst           \* TRUE in the protocol.  FALSE only in a vacuity probe.

ASSUME /\ Registered \subseteq Steps
       /\ MaxRollbackAttempts \in Nat \ {0}
       /\ MaxRevivals \in Nat
       /\ CancelMidRollback \in {"halts", "refused"}
       /\ ReviveAfterSaga \in {"refused", "fresh"}
       /\ InfraCapRollsBack \in BOOLEAN
       /\ AtomicEnter \in BOOLEAN
       /\ MarkerFirst \in BOOLEAN

VARIABLES
  task,        \* "live", "completed", "failed", "cancelled"
  phase,       \* "forward" or "rolling_back": the durable phase marker
  fwd,         \* per step: "none", "started", "done"
  startIdx,    \* per step: its start ordering index, 0 before it starts
  rb,          \* per step: its rollback, "none", "done", "failed"
  rbTries,     \* per step: failed attempts of its rollback so far
  outcome,     \* the rollback outcome: "none", "complete", "failed"
  cause,       \* ghost: what decided the terminal failure: "none", "user", "infra"
  effect,      \* ghost, per step: "absent", "maybe", "live", "gone"
  revivals,    \* revivals consumed
  generation,  \* saga generations started by a revival
  owed         \* probe only: the decision committed and the marker has not

vars == <<task, phase, fwd, startIdx, rb, rbTries, outcome, cause, effect,
          revivals, generation, owed>>

Init ==
  /\ task = "live" /\ phase = "forward"
  /\ fwd = [s \in Steps |-> "none"] /\ startIdx = [s \in Steps |-> 0]
  /\ rb = [s \in Steps |-> "none"] /\ rbTries = [s \in Steps |-> 0]
  /\ outcome = "none" /\ cause = "none"
  /\ effect = [s \in Steps |-> "absent"]
  /\ revivals = 0 /\ generation = 0 /\ owed = FALSE

\* The highest index handed out, which the next start exceeds.
TopIdx == CHOOSE n \in {startIdx[s] : s \in Steps} \cup {0} :
            \A t \in Steps : startIdx[t] <= n

\* A rollback is owed for every registered step that started, finished or not.
Eligible == {s \in Registered : fwd[s] # "none"}
Pending == {s \in Eligible : rb[s] = "none"}
\* What a saga that ends early records: failed when a step that started is left
\* uncompensated, and complete when none is.
HaltOutcome == IF \E s \in Eligible : rb[s] # "done" THEN "failed" ELSE "complete"

\* The start marker commits, and then the body runs.
StartStep(s) ==
  /\ task = "live" /\ phase = "forward"
  /\ fwd[s] = "none"
  /\ effect' = [effect EXCEPT ![s] = "maybe"]
  /\ IF MarkerFirst
     THEN /\ fwd' = [fwd EXCEPT ![s] = "started"]
          /\ startIdx' = [startIdx EXCEPT ![s] = TopIdx + 1]
     ELSE UNCHANGED <<fwd, startIdx>>
  /\ UNCHANGED <<task, phase, rb, rbTries, outcome, cause, revivals, generation, owed>>

\* Probe only: the marker written after the body began, as a step commits today.
LateMarker(s) ==
  /\ ~MarkerFirst /\ task = "live" /\ phase = "forward"
  /\ fwd[s] = "none" /\ effect[s] = "maybe"
  /\ fwd' = [fwd EXCEPT ![s] = "started"]
  /\ startIdx' = [startIdx EXCEPT ![s] = TopIdx + 1]
  /\ UNCHANGED <<task, phase, rb, rbTries, outcome, cause, effect, revivals, generation, owed>>

FinishStep(s) ==
  /\ task = "live" /\ phase = "forward"
  /\ fwd[s] = "started"
  /\ fwd' = [fwd EXCEPT ![s] = "done"]
  /\ effect' = [effect EXCEPT ![s] = "live"]
  /\ UNCHANGED <<task, phase, startIdx, rb, rbTries, outcome, cause, revivals, generation, owed>>

Complete ==
  /\ task = "live" /\ phase = "forward"
  /\ task' = "completed"
  /\ UNCHANGED <<phase, fwd, startIdx, rb, rbTries, outcome, cause, effect, revivals, generation, owed>>

\* Retries exhausted, or a fatal error: the worker fails the run with no retry.
\* The decision and the phase marker are one batch.
UserTerminal ==
  /\ task = "live" /\ phase = "forward"
  /\ cause' = "user"
  /\ IF AtomicEnter
     THEN phase' = "rolling_back" /\ UNCHANGED <<task, owed>>
     ELSE task' = "failed" /\ owed' = TRUE /\ UNCHANGED phase
  /\ UNCHANGED <<fwd, startIdx, rb, rbTries, outcome, effect, revivals, generation>>

\* Probe only: the marker as its own later step.
LateEnter ==
  /\ ~AtomicEnter /\ owed
  /\ phase' = "rolling_back" /\ owed' = FALSE
  /\ UNCHANGED <<task, fwd, startIdx, rb, rbTries, outcome, cause, effect, revivals, generation>>

\* A sweep fails the task at an infrastructure cap.  In the forward phase the
\* rule decides.  In the rolling-back phase the saga ends there, and the outcome
\* says whether anything was left.
InfraCap ==
  /\ task = "live"
  /\ IF phase = "forward"
     THEN /\ cause' = "infra"
          /\ IF InfraCapRollsBack
             THEN phase' = "rolling_back" /\ UNCHANGED <<task, outcome>>
             ELSE task' = "failed" /\ UNCHANGED <<phase, outcome>>
     ELSE task' = "failed" /\ outcome' = HaltOutcome /\ UNCHANGED <<phase, cause>>
  /\ UNCHANGED <<fwd, startIdx, rb, rbTries, effect, revivals, generation, owed>>

\* The next rollback is the pending step that started last.
IsNext(s) ==
  /\ s \in Pending
  /\ \A t \in Pending : startIdx[t] <= startIdx[s]

RunRollback(s) ==
  /\ task = "live" /\ phase = "rolling_back"
  /\ IsNext(s)
  /\ rb' = [rb EXCEPT ![s] = "done"]
  /\ effect' = [effect EXCEPT ![s] = "gone"]
  /\ UNCHANGED <<task, phase, fwd, startIdx, rbTries, outcome, cause, revivals, generation, owed>>

\* A rollback attempt fails with its own budget left.
RollbackRetry(s) ==
  /\ task = "live" /\ phase = "rolling_back"
  /\ IsNext(s)
  /\ rbTries[s] + 1 < MaxRollbackAttempts
  /\ rbTries' = [rbTries EXCEPT ![s] = rbTries[s] + 1]
  /\ UNCHANGED <<task, phase, fwd, startIdx, rb, outcome, cause, effect, revivals, generation, owed>>

\* A rollback fails for good, by a fatal error or a spent budget.  It halts the
\* saga: the outcome and the task's end are the same batch.
RollbackHalts(s) ==
  /\ task = "live" /\ phase = "rolling_back"
  /\ IsNext(s)
  /\ rb' = [rb EXCEPT ![s] = "failed"]
  /\ outcome' = "failed" /\ task' = "failed"
  /\ UNCHANGED <<phase, fwd, startIdx, rbTries, cause, effect, revivals, generation, owed>>

FinishSaga ==
  /\ task = "live" /\ phase = "rolling_back"
  /\ Pending = {}
  /\ outcome' = "complete" /\ task' = "failed"
  /\ UNCHANGED <<phase, fwd, startIdx, rb, rbTries, cause, effect, revivals, generation, owed>>

Cancel ==
  /\ task = "live"
  /\ (phase = "rolling_back") => (CancelMidRollback = "halts")
  /\ task' = "cancelled"
  /\ outcome' = IF phase = "rolling_back" THEN HaltOutcome ELSE outcome
  /\ UNCHANGED <<phase, fwd, startIdx, rb, rbTries, cause, effect, revivals, generation, owed>>

\* retry-task.  A task that failed with no saga revives as it does today.  One
\* whose saga began revives only under "fresh", only when the saga completed,
\* and then every rolled-back step is forgotten.
Revive ==
  /\ task = "failed" /\ revivals < MaxRevivals
  /\ task' = "live" /\ revivals' = revivals + 1 /\ cause' = "none"
  /\ IF phase = "forward"
     THEN UNCHANGED <<phase, fwd, startIdx, rb, rbTries, outcome, generation>>
     ELSE /\ ReviveAfterSaga = "fresh"
          /\ outcome = "complete"
          /\ phase' = "forward" /\ outcome' = "none"
          /\ generation' = generation + 1
          /\ fwd' = [s \in Steps |-> IF s \in Eligible THEN "none" ELSE fwd[s]]
          /\ startIdx' = [s \in Steps |-> IF s \in Eligible THEN 0 ELSE startIdx[s]]
          /\ rb' = [s \in Steps |-> "none"]
          /\ rbTries' = [s \in Steps |-> 0]
  /\ UNCHANGED <<effect, owed>>

Next ==
  \/ \E s \in Steps : StartStep(s) \/ LateMarker(s) \/ FinishStep(s)
  \/ \E s \in Steps : RunRollback(s) \/ RollbackRetry(s) \/ RollbackHalts(s)
  \/ Complete \/ UserTerminal \/ LateEnter \/ InfraCap
  \/ FinishSaga \/ Cancel \/ Revive

Spec == Init /\ [][Next]_vars

\* Fairness for liveness only.  A rolling-back task's pass is claimed and makes
\* its next commit, which Scheduler.tla's EventuallyTerminal proves for one task
\* under that model's own restrictions.  Failures, cancellation, and revival
\* are unfair.
SpecFair ==
  /\ Spec
  /\ WF_vars(\E s \in Steps : RunRollback(s))
  /\ WF_vars(FinishSaga)

-----------------------------------------------------------------------------
\* The invariants spell their sets out.  They do not reuse Eligible or Pending,
\* so a wrong definition above cannot excuse itself.

TypeOK ==
  /\ task \in {"live", "completed", "failed", "cancelled"}
  /\ phase \in {"forward", "rolling_back"}
  /\ fwd \in [Steps -> {"none", "started", "done"}]
  /\ startIdx \in [Steps -> Nat]
  /\ rb \in [Steps -> {"none", "done", "failed"}]
  /\ rbTries \in [Steps -> Nat]
  /\ outcome \in {"none", "complete", "failed"}
  /\ cause \in {"none", "user", "infra"}
  /\ effect \in [Steps -> {"absent", "maybe", "live", "gone"}]
  /\ revivals \in Nat /\ generation \in Nat
  /\ owed \in BOOLEAN

\* A rollback's failed attempts stay inside its own budget.
RollbackBudgetHeld == \A s \in Steps : rbTries[s] < MaxRollbackAttempts

\* Revivals are counted and bounded.  The bound is ARTIFICIAL: it keeps the model
\* finite, and the SQL owes it nothing.
RevivalBoundHeld == revivals <= MaxRevivals /\ generation <= revivals

\* A step has an index exactly when it started, and no two steps share one.
StartOrderDistinct ==
  /\ \A s \in Steps : (fwd[s] = "none") <=> (startIdx[s] = 0)
  /\ \A s, t \in Steps : (s # t /\ startIdx[s] # 0) => startIdx[s] # startIdx[t]

\* Only a registered step that started is ever rolled back or retried.
RollbackOnlyEligible ==
  \A s \in Steps : (rb[s] # "none" \/ rbTries[s] > 0) => (s \in Registered /\ fwd[s] # "none")

\* Reverse start order: a rollback is touched only once every registered step
\* that started after it is rolled back.
ReverseOrder ==
  \A s, t \in Registered :
    ((rb[s] # "none" \/ rbTries[s] > 0) /\ startIdx[t] > startIdx[s]) => rb[t] = "done"

\* Nothing of a saga exists before the terminal failure is decided, and the
\* phase is entered only by a decision.
SagaOnlyAfterDecision ==
  /\ (outcome # "none" \/ \E s \in Steps : rb[s] # "none" \/ rbTries[s] > 0)
       => phase = "rolling_back"
  /\ phase = "rolling_back" => cause # "none"

\* "complete" means complete.
OutcomeHonest ==
  outcome = "complete" =>
    \A s \in Registered : fwd[s] # "none" => rb[s] = "done"

\* "failed" means failed: a step that started was left uncompensated.
FailedOutcomeHonest ==
  outcome = "failed" =>
    \E s \in Registered : fwd[s] # "none" /\ rb[s] # "done"

OutcomeOnlyWhenTerminal == outcome # "none" => task \in {"failed", "cancelled"}

\* A failed task has a rollback outcome, unless the rule let an infrastructure
\* cap skip the saga.
FailedImpliesSettled ==
  task = "failed" => (outcome # "none" \/ (cause = "infra" /\ ~InfraCapRollsBack))

\* A cancellation that ends a saga records its outcome.
CancelledSagaIsSurfaced ==
  (task = "cancelled" /\ phase = "rolling_back") => outcome # "none"

\* What replay will skip really holds its effect, and what it will run again
\* does not: a memoized forward step is live, and an unstarted one is absent
\* or compensated.
MemoMatchesEffect ==
  \A s \in Steps :
    /\ (phase = "forward" /\ fwd[s] = "done") => effect[s] = "live"
    /\ fwd[s] = "none" => effect[s] \in {"absent", "gone"}

\* The three rules are held, each by its own invariant.
RefusedCancelNeverHalts ==
  CancelMidRollback = "refused" => ~(task = "cancelled" /\ phase = "rolling_back")
RefusedRevivalNeverRestarts == ReviveAfterSaga = "refused" => generation = 0
InfraSkipNeverRollsBack == (~InfraCapRollsBack /\ cause = "infra") => phase = "forward"

\* A step keeps its place, and a saga freezes the forward steps.
StartOrderImmutable ==
  [][\A s \in Steps : (startIdx[s] # 0 /\ generation' = generation) => startIdx'[s] = startIdx[s]]_vars
ForwardFrozenInSaga ==
  [][(phase = "rolling_back" /\ phase' = "rolling_back") => (fwd' = fwd /\ startIdx' = startIdx)]_vars

\* Within a generation a rollback's end, its spent attempts, the outcome, and the
\* decision are final or only grow.
RollbackIsFinal ==
  [][\A s \in Steps : (rb[s] # "none" /\ generation' = generation) => rb'[s] = rb[s]]_vars
TriesOnlyGrow ==
  [][\A s \in Steps : generation' = generation => rbTries'[s] >= rbTries[s]]_vars
OutcomeIsFinal ==
  [][(outcome # "none" /\ generation' = generation) => outcome' = outcome]_vars
DecisionIsMadeOnce ==
  [][(cause # "none" /\ cause' # cause) => cause' = "none"]_vars

\* A rollback compensates something: an effect that is live or may be.
CompensatesAnEffect ==
  [][\A s \in Steps : (rb[s] = "none" /\ rb'[s] = "done") => effect[s] \in {"live", "maybe"}]_vars

\* A saga ends failed or cancelled, never completed.  A completed or cancelled
\* task is quiet, and a failed one moves only by a revival.
SagaEndsFailed ==
  [][(phase = "rolling_back" /\ task = "live" /\ task' # "live") => task' \in {"failed", "cancelled"}]_vars
TerminalIsQuiet ==
  [][(task \in {"completed", "cancelled"}) => vars' = vars]_vars
FailedMovesOnlyByRevival ==
  [][(task = "failed") => (vars' = vars \/ (task' = "live" /\ revivals' = revivals + 1))]_vars
RevivalOnlyOfFailed ==
  [][(revivals' # revivals) => task = "failed"]_vars

\* A rollback recorded as done did compensate its step.
DoneMeansCompensated == \A s \in Steps : rb[s] = "done" => effect[s] = "gone"

\* Every decision settles: a saga that began reaches an outcome.
DecisionSettles == (phase = "rolling_back" \/ owed) ~> (outcome # "none")
=============================================================================
