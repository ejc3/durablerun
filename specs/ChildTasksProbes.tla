-------------------------- MODULE ChildTasksProbes --------------------------
\* Vacuity probes for ChildTasks.tla, as Probes.tla is for Scheduler.tla.  Each is
\* EXPECTED TO FAIL under the configuration that bears its name, and its
\* counterexample is a witness.  Run one at a time.
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
\* Witness: a parent whose wait timed out, and whose child then ended.  The emit
\* found no wait row and woke nobody.
ChildTasksProbeTimedOutThenEmitted == ~(parent = "timedout" /\ doneEvent # None)
\* Witness: an await that wrote the event itself, for a child an older build ended.
\* The event is written by a step that does not end the child.
ChildTasksProbeMaterializedAwait ==
  [][~(doneEvent = None /\ doneEvent' # None /\ child' = child)]_vars
\* LegacyEndWhileWaiting = TRUE under SpecFair: an older build ends the child while
\* a wait is registered.  Nothing wakes the waiter, and no await is left to write
\* the event.  The deploy rule is an assumption, and this is what lifting it costs.
ChildTasksProbeLegacyEndStrandsWaiter == EveryWaitResolves
\* Witness: an await of a task that does not exist, refused.
ChildTasksProbeUnknownChild == ~(parent = "refused" /\ child = "unspawned")
=============================================================================
