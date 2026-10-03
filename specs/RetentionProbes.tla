-------------------------- MODULE RetentionProbes --------------------------
\* Vacuity probes for Retention.tla, as ChildTasksProbes.tla is for ChildTasks.tla.
\* Each is EXPECTED TO FAIL under the configuration that bears its name, and its
\* counterexample is a witness.  Most lift one condition of the barrier with the
\* constant Lift and name the property that the condition holds.  An action
\* property is written out here from its step, because TLC names a violated
\* action property by the definition that holds its box.  Run one at a time.
EXTENDS Retention

\* Lift = {"age"}: a unit is purged before its window ends.
RetentionProbeAge == [][PurgeStepIsDeadAndOld]_vars
\* Lift = {"state"}: a failed task the policy keeps is purged.
RetentionProbeState == [][PurgeStepIsDeadAndOld]_vars
\* Lift = {"live"}: a live task whose stamp is old is purged.  The stamp is the
\* last write of the task row, which for a sleeping task can be days old.
RetentionProbeLiveTask == [][PurgeStepIsDeadAndOld]_vars
\* Lift = {"parent"}: a child is purged under a parent that can still replay.
RetentionProbeParent == ReplayableParentKeepsChild
\* Lift = {"parent"}: and that parent's replay of its spawn, which died before its
\* memo, finds the key free and creates a second child.
RetentionProbeSecondChild == ~second
\* Lift = {"parentQueue"} with the parent in another queue: the barrier looks the
\* parent up in the child's queue only, finds nothing, and purges the child.
RetentionProbeParentInAnotherQueue == ReplayableParentKeepsChild
\* Lift = {"carry"}: a child is purged while a run carries its outcome.
RetentionProbeCarry == CarrierKeepsEvent
\* Lift = {"wait"}, with an older build ending the child under a wait: the purge
\* takes the task the wait needs to be woken.
RetentionProbeWait == NoStrandedWaiter
\* Lift = {"whole"}: the purge deletes the unit in two batches, the task row last,
\* and retry-task revives the task between them with none of its memos.
RetentionProbeChunkedPurge == [][RevivalStepSeesWholeUnit]_vars
\* Lift = {"await"}: an await of a purged child registers a wait that nothing
\* will ever wake, instead of being refused.
RetentionProbeAwaitRegisters == [][AwaitStepOnPurgedIsRefused]_vars
\* Lift = {"materialize"}: the await that records an older build's ending reads
\* the row, the purge takes the unit, and the await's unfenced write leaves a
\* completion event with no task.
RetentionProbeUnfencedMaterialize == WholeUnit
\* Witness, with HandleWithinWindow = FALSE: a third party awaits after the
\* child's unit went, and the await is refused loudly.
RetentionProbeLateHandle == ~(aw["H"] = "refused" /\ st["C"] = "absent")
\* Witness: a unit an older build ended, which has no completion event, is purged
\* whole.  The delete of the event matches nothing.
RetentionProbeLegacyNoEvent ==
  [][~(Present("C") /\ st'["C"] = "absent" /\ legacy /\ ~cEvent)]_vars
\* Witness: after the purge, a producer redelivers the child's key and gets a
\* fresh task.  A key dedupes for the window of its task's terminal state.
RetentionProbeRedeliveredKey == ~redelivered
=============================================================================
