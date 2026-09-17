-------------------------- MODULE ChildTasksProbes --------------------------
\* Vacuity probes for ChildTasks.tla, as Probes.tla is for Scheduler.tla.  Each is
\* EXPECTED TO FAIL under the configuration that bears its name, and its
\* counterexample is a witness.  Two show that an invariant can fail, one that the
\* liveness property can, and three that a behaviour the protocol exists for is
\* reachable.  Run one at a time.
EXTENDS ChildTasks

\* AtomicEmit = FALSE: the emit is a second step, so a terminal child has no event.
ChildTasksProbeNonAtomicEmit == TerminalImpliesDone
\* AtomicEmit = FALSE under SpecFair: nothing makes the second step happen, which is
\* a crash between the two, and the registered waiter waits forever.
ChildTasksProbeStrandedWaiter == EveryWaitResolves
\* UserMayForge = TRUE: a user emit under the reserved name forges the outcome.
ChildTasksProbeForgedEmit == DoneIsFirstOutcome
\* Witness: a parent that registered a wait and was woken by the child's end.
ChildTasksProbeWokenParent == parent # "woken"
\* Witness: a revived child that ends a second time with another outcome, while
\* the event still carries the first.
ChildTasksProbeSecondOutcome == ~(retries > 0 /\ child \in Outcomes /\ child # doneEvent)
\* Witness: an await the rule refused.
ChildTasksProbeRefusedAwait == parent # "refused"
=============================================================================
