----------------------------- MODULE SagasProbes -----------------------------
\* Vacuity probes for Sagas.tla, as Probes.tla is for Scheduler.tla.  Each is
\* EXPECTED TO FAIL under the configuration that bears its name, and its
\* counterexample is a witness: that an invariant or the liveness property can
\* fail, or that a behaviour the protocol exists for is reachable.  A witness of a
\* saga asks for a rollback that ran, because a saga with nothing to roll back
\* completes at entry and shows nothing.  Run one at a time.
EXTENDS Sagas

\* AtomicEnter = FALSE: the phase marker is a second step, so a task is failed
\* with no rollback outcome.
SagasProbeNonAtomicEnter == FailedImpliesSettled
\* AtomicEnter = FALSE under SpecFair: nothing makes the second step happen, which
\* is a crash between the two, and the decision never settles.
SagasProbeStrandedSaga == DecisionSettles
\* MarkerFirst = FALSE: the body runs before anything durable says the step
\* started, so an effect exists that no rollback will find.
SagasProbeBodyBeforeMarker == MemoMatchesEffect
\* Witness: a saga that rolled back two steps and completed.
SagasProbeCompletedSaga ==
  ~(outcome = "complete" /\ \A s \in Registered : rb[s] = "done")
\* Witness: a halted saga, with an earlier step left uncompensated.
SagasProbeHaltedSaga ==
  ~(\E s, t \in Registered : rb[s] = "failed" /\ fwd[t] # "none" /\ rb[t] = "none")
\* Witness: the rollback of a step that started and never persisted.
SagasProbeStartedNotFinished == ~(\E s \in Steps : rb[s] = "done" /\ fwd[s] = "started")
\* Witness: a rollback that failed once, was retried, and succeeded.
SagasProbeRollbackRetried == ~(\E s \in Steps : rb[s] = "done" /\ rbTries[s] > 0)
\* Witness: a cancellation that halted a saga.
SagasProbeCancelledMidRollback == ~(task = "cancelled" /\ phase = "rolling_back")
\* Witness, under "fresh": a step whose effect a rollback compensated runs again
\* in the next generation.  An action property, because only a step shows it.
SagasProbeRevivedAfterSaga ==
  [][~(generation = 1 /\ \E s \in Registered : effect[s] = "gone" /\ effect'[s] = "maybe")]_vars
\* Witness, with InfraCapRollsBack = TRUE: a saga an infrastructure cap began,
\* which rolled a step back and completed.
SagasProbeInfraRolledBack ==
  ~(cause = "infra" /\ outcome = "complete" /\ \E s \in Registered : rb[s] = "done")
\* Witness, with InfraCapRollsBack = FALSE: a failed task with a started step and
\* no rollback outcome.
SagasProbeInfraSkipped ==
  ~(task = "failed" /\ outcome = "none" /\ \E s \in Registered : fwd[s] # "none")
\* Witness, with InfraCapRollsBack = FALSE: a failed task no saga began for is
\* revived in the forward phase, as retry-task revives any failed task today.
SagasProbeRevivedWithNoSaga == ~(task = "live" /\ revivals = 1 /\ generation = 0)
=============================================================================
