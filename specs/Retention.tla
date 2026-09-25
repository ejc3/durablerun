------------------------------ MODULE Retention ------------------------------
\* Retention: the purge of whole terminal task units (DESIGN.md S3.12), modeled
\* before its SQL.  A side model, as ChildTasks.tla and Sagas.tla are.  Those
\* models never delete a task, a run, a checkpoint, or an event: Scheduler.tla
\* keeps every event forever, and ChildTasks.tla asks that the completion event
\* outlive every await of it.  Bounding the rows means deleting some, so this model holds the
\* one thing retention adds: which unit a purge may take, and when, beside every
\* engine action the purge can race.
\*
\* THE UNIT.  One terminal task and what only it owns: its task row, its runs,
\* its checkpoints (and the waits naming its runs, which go with the runs), and
\* its completion event $task-done:<taskId>.  The purge deletes the unit in one
\* atomic batch, and never a part of it.  The model keeps the child's unit as its
\* task row and three booleans.
\*
\* THE ACTORS.  One queue holds the child C and a third party H, which holds C's
\* handle and may await C.  The spawning parent P is in C's queue, in another
\* queue, or absent (C was enqueued by a producer with its own key), one per
\* configuration.  An await is allowed only within the child's queue
\* (ChildTasks.tla), so only a holder in C's queue waits on C or carries C's
\* outcome.  Each of C, P and H ends, and each unit may be purged.
\*
\* TIME.  Engine time is database time.  The barrier reads the time since a
\* task's ending was stamped (tasks.fence_at_ms), so that is what the model
\* keeps: each task's age in ticks, saturated at the window.  An age is reset by
\* the batches the model has that write the task row, and it grows while a task
\* is live too: the stamp of a task that sleeps for days is days old, which is
\* why the barrier reads the state beside the age.
\*
\* THE BARRIER.  A unit is purged only when every condition holds, read inside
\* the purge batch's compare-and-set:
\*  B1  the task is in a state the policy names, and its stamp is at least a
\*      window old;
\*  B2  no run of the task is live.  Tasks mirror their runs (Scheduler.tla), so
\*      B1 implies it here, and it is a defence in the SQL with no twin here;
\*  B3  no run in the child's queue, in any state, names the child's completion
\*      event: one that carries its outcome, or one that holds only the name
\*      (a timed await that came due, or a parked run whose task was
\*      cancelled).  This is the conservative condition: a failed holder that
\*      names the event can be revived in place by retry-task and replay its
\*      await, and a cancelled one is inspected;
\*  B4  no wait names the child's completion event;
\*  B5  the spawning parent, looked up by its id in every queue, is absent,
\*      completed, or cancelled.
\*
\* WHAT THE SQL OWES THIS MODEL, beyond its actions:
\*  - The purge is one batch, and it takes the event lock of the completion event
\*    it deletes, so it is atomic and mutually exclusive with every await, emit,
\*    and terminal batch of that event, as the actions here are.
\*  - The conditions are read inside the compare-and-set, at the instant of
\*    deletion.  A candidate list read earlier is only a list of candidates.
\*  - The parent is found by the id the child's reserved key names, in any queue:
\*    ctx.spawn takes a queue option and the key does not encode the parent's
\*    queue.  RetentionProbeParentInAnotherQueue shows what a lookup inside the
\*    child's queue costs.
\*  - The record-task-done batch stays fenced on the stamp of the row it read.
\*    RetentionProbeUnfencedMaterialize shows the orphan event a purge leaves
\*    beside an unfenced one.
\*
\* TWO CONTRACT CHANGES follow from deleting task rows, and DESIGN.md S3.12
\* states them for the maintainer's approval:
\*  - An idempotency key dedupes for the window of its task's terminal state.
\*    A producer that redelivers a key after its task was purged gets a fresh
\*    task (RetentionProbeRedeliveredKey).
\*  - A child handle is valid until its unit is purged.  The parent's is valid
\*    for as long as the parent can run, by B5.  A third party's handle cannot be
\*    found from rows, so its lifetime is the window, and an await after the
\*    purge is refused loudly (AwaitOnPurgedIsRefused).  HandleWithinWindow is
\*    that contract as a constant.  No property of this model needs it: every one
\*    holds with it lifted, in RetentionNoParent.cfg.  What it buys the third
\*    party is the outcome instead of the refusal, which
\*    RetentionProbeLateHandle shows is reachable without it.
\*
\* WHAT KEEPS A UNIT FOREVER, by design: a failed spawning parent the policy
\* keeps (failed tasks are kept by default because retry-task can revive them);
\* a run of a kept task that failed or was cancelled while naming the child's
\* completion event, with its outcome or with the name alone (such a run never
\* clears the columns); and a wait an older build left stranded.  AgedUnblockedIsPurged says nothing else does.
\*
\* NOT MODELED, and why that is sound or what bounds it:
\*  - Several parents or children, and a chain of ancestors.  Each unit's barrier
\*    names only its own spawning parent.  A failed ancestor keeps its children
\*    until it is purged itself, so such a chain goes top-down one link at a
\*    time, and RetentionFailedPolicy.cfg checks one link of it.
\*  - A third party's await replayed after a retry of its own.  It is another
\*    await of the handle, and the window bounds every await of a third party's
\*    handle, a replay's included.
\*  - Caller events.  The purge never removes one.
\*  - Sizes, the unit cap, chunked deletes, and lock order.  The purge is one
\*    atomic step here.  The concurrency contest and the unit cap are PR5.2c2's.
\*  - Several windows.  The policy's windows differ per state in the SQL, and one
\*    window is enough for the ordering the barrier reads.  The window's edges,
\*    minus and plus one millisecond, are the barrier grid's.
\*  - A retry successor's carried wake.  Scheduler.tla's SuccessorCarriesWake
\*    covers it.  The failed attempt's run keeps the columns until its unit goes,
\*    which HolderAttemptFails makes a stuck carry.
\*  - A stamp left NULL by a build older than the column.  The purge never
\*    selects one, and PR5.2c1 proves that every terminal path of this build
\*    stamps it.
\*  - A key that starts with $spawn: and does not parse.  The barrier keeps its
\*    unit, and a generated round-trip case owns the parse.
\*
\* ---------------------------------------------------------------------------
\* BATCH-LABEL LEDGER -- machine-checked by scripts/spec-ledger.py, as
\* ChildTasks.tla's is: every quoted label is a batch some store sends, every
\* action named is an action of Next below, and every action of Next is mapped
\* here or listed as having no batch, with the reason.  An entry's layout and
\* its class are as that block describes them.  The engine's actions keep the
\* labels ChildTasks.tla and Sagas.tla map them from.  No store sends a purge
\* batch yet, so the purge's actions are listed as having none.  PR5.2c2 writes
\* that batch and turns those lines into mappings.  The script reads no guard.
\* Each property below names its executable twin.
\*
\* Modeled (a label and its condition, its actions, its class):
\*   'spawn' of a child -> PSpawn  [receipt]  (the replay of a spawn finds the
\*     child by its reserved key, or creates one when the key is free)
\*   'spawn' by a producer -> Enqueue / Redeliver  [receipt]  (a key whose task
\*     exists dedupes, and a key whose task was purged is free)
\*   'set-checkpoint' of $spawn -> PMemo  [cas-fenced]
\*   'complete' -> ChildEnds / HolderCompletes  [cas-fenced]
\*   'fail' that ends the task -> ChildEnds / HolderFails  [cas-fenced]
\*   'fail' in the forward phase -> EnterRollback  [cas-fenced]  (a terminal
\*     failure that enters a saga, Sagas.tla's UserTerminal)
\*   'fail' with no retry, in the rolling-back phase -> ChildEnds / FinishSaga  [cas-fenced]
\*   'fail-rollback' that ends the task -> ChildEnds / FinishSaga  [cas-fenced]
\*   'cancel-task' -> ChildEnds / HolderCancelled  [cas-fenced]
\*   'sweep:cancel' -> ChildEnds / HolderCancelled  [cas-fenced]
\*   'sweep:lost-launch' at its cap -> ChildEnds / HolderFails  [cas-fenced]
\*   'sweep:claim-timeout' at the infra cap -> ChildEnds / HolderFails  [cas-fenced]
\*   'retry-task' -> Revive  [cas-fenced]
\*   'await-event' -> AwaitHit / AwaitMiss  [cas-fenced]
\*   'await-event' -> AwaitUnknown / AwaitRefused  [cas-fenced]  (the
\*     'task-done-state' read says why: no such task, or a child in another queue)
\*   'record-task-done' -> AwaitMaterialize  [cas-fenced]
\*   'claim' of the woken run -> ClaimWoken  [receipt]
\*   'claim' of a run whose timed wait came due -> Timeout  [receipt]
\*   'suspend' of the woken run -> MoveOn  [cas-fenced]  (a later suspend
\*     clears the wake columns, as complete does)
\*   'fail' with a retry -> HolderAttemptFails  [cas-fenced]  (the failed run
\*     keeps the wake columns, and the successor carries them)
\* No batch (action -- reason):
\*   PurgeChild / PurgeHolder -- the purge batch lands in PR5.2c2
\*   LegacyEnds -- a terminal batch of an older build: no SQL of this build
\*   Tick -- database time passes
\*   PurgeRow / MaterializeWrite -- exist only for vacuity probes
\* ---------------------------------------------------------------------------

EXTENDS Naturals

CONSTANTS
  ParentQueue,            \* "same", "other", or "none": where the spawning parent is
  Policy,                 \* the terminal states the purge policy names
  Window,                 \* the retention window, in ticks.  ARTIFICIAL scale.
  MaxRetries,             \* retry-task revivals of C and of P.  ARTIFICIAL bound.
  HandleWithinWindow,     \* TRUE: the third party awaits before C's unit goes
  LegacyEndWhileWaiting,  \* TRUE: an older build may end C under a registered wait
  Lift                    \* the barrier conditions a probe lifts.  {} in the protocol.

Outcomes == {"completed", "failed", "cancelled"}

ASSUME /\ ParentQueue \in {"same", "other", "none"}
       /\ Policy \subseteq Outcomes
       /\ Window \in Nat \ {0}
       /\ MaxRetries \in Nat
       /\ HandleWithinWindow \in BOOLEAN
       /\ LegacyEndWhileWaiting \in BOOLEAN
       /\ Lift \subseteq {"age", "state", "live", "parent", "parentQueue", "carry",
                          "wait", "whole", "await", "materialize"}

Tasks   == {"C", "P", "H"}
Holders == {"P", "H"}
\* "none": no such task exists yet (or ever: P when C has no parent).  "absent":
\* its unit was purged.
States  == {"none", "live", "rolling", "absent"} \cup Outcomes
AwaitStates == {"idle", "waiting", "woken", "resolved", "timedout", "refused",
                "cancelled", "reading"}

VARIABLES
  st,           \* per task: its state
  saga,         \* per task: its terminal failure began a saga, which retry-task refuses
  age,          \* per task: ticks since its row was last stamped, saturated at Window
  retries,      \* per task: revivals consumed
  cRuns,        \* C's runs exist
  cCkpts,       \* C's checkpoints exist
  cEvent,       \* C's completion event exists
  spawned,      \* P's spawn created C under P's reserved key
  memo,         \* P's $spawn memo, naming C, is committed
  aw,           \* per holder: its await of C
  carry,        \* per holder: "none"; "live", its current run parks C's outcome;
                \* "stuck", a failed or cancelled run of it does, until its unit goes
  named,        \* per holder: "none"; "live", its current run names C's completion
                \* event with no outcome parked on it (its timed await came due);
                \* "stuck", a failed or cancelled run of it does, until its unit goes
  legacy,       \* ghost: C's latest ending was an older build's, which recorded nothing
  second,       \* ghost: a replay of P's spawn found C's key free and created a second child
  redelivered,  \* ghost: a producer redelivered C's key after C's unit went, and got a fresh task
  purging       \* probe only: a purge deleted C's rows and not yet its task row

vars == <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry,
          named, legacy, second, redelivered, purging>>

Init ==
  /\ st = [t \in Tasks |-> IF t = "H" \/ (t = "P" /\ ParentQueue # "none") THEN "live" ELSE "none"]
  /\ saga = [t \in Tasks |-> FALSE]
  /\ age = [t \in Tasks |-> 0]
  /\ retries = [t \in Tasks |-> 0]
  /\ cRuns = FALSE /\ cCkpts = FALSE /\ cEvent = FALSE
  /\ spawned = FALSE /\ memo = FALSE
  /\ aw = [x \in Holders |-> "idle"]
  /\ carry = [x \in Holders |-> "none"]
  /\ named = [x \in Holders |-> "none"]
  /\ legacy = FALSE /\ second = FALSE /\ redelivered = FALSE /\ purging = FALSE

Lifted(c) == c \in Lift
Present(t) == st[t] \notin {"none", "absent"}
IsLive(t) == st[t] \in {"live", "rolling"}
\* A holder running task code: live, and not parked on a wait or woken and unclaimed.
Running(x) == st[x] = "live" /\ aw[x] \notin {"waiting", "woken", "reading"}
\* Only a holder in C's queue can await C.
Awaiters == IF ParentQueue = "same" THEN Holders ELSE {"H"}
Stamp(t) == age' = [age EXCEPT ![t] = 0]

\* C's insert writes its task row, its first run, and its checkpoints' owner together.
Create ==
  /\ st' = [st EXCEPT !["C"] = "live"] /\ cRuns' = TRUE /\ cCkpts' = TRUE /\ Stamp("C")

\* A producer enqueues C under a key of its own.
Enqueue ==
  /\ ParentQueue = "none" /\ st["C"] = "none"
  /\ Create
  /\ UNCHANGED <<saga, retries, cEvent, spawned, memo, aw, carry, named, legacy, second, redelivered, purging>>

\* The producer redelivers C's key.  A key whose task exists dedupes and changes
\* nothing, so only the other case is a step: the key was freed by the purge and
\* the spawn creates a fresh task, which the model does not follow.
Redeliver ==
  /\ ParentQueue = "none" /\ st["C"] = "absent" /\ ~redelivered
  /\ redelivered' = TRUE
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry, named, legacy, second, purging>>

\* P's spawn, under its live claim in the forward phase.  With no memo it may be a
\* replay after a pass that died between the spawn and its memo.  A key that
\* holds C finds it and changes nothing, so only a free key is a step: the first
\* spawn, or a replay after C's unit went, which creates a second child.
PSpawn ==
  /\ ParentQueue # "none" /\ Running("P") /\ ~memo
  /\ st["C"] \in {"none", "absent"} /\ ~second
  /\ IF st["C"] = "none"
     THEN Create /\ spawned' = TRUE /\ UNCHANGED second
     ELSE second' = TRUE /\ UNCHANGED <<st, age, cRuns, cCkpts, spawned>>
  /\ UNCHANGED <<saga, retries, cEvent, memo, aw, carry, named, legacy, redelivered, purging>>

PMemo ==
  /\ Running("P") /\ spawned /\ ~memo
  /\ memo' = TRUE
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, aw, carry, named, legacy, second, redelivered, purging>>

\* C's completion event and the waiters' wake, as follow-ons of its terminal
\* batch.  First write wins: an event that exists is left alone.  A woken run
\* carries C's outcome until complete or suspend clears it.
Emit ==
  IF cEvent
  THEN UNCHANGED <<cEvent, aw, carry, named>>
  ELSE /\ cEvent' = TRUE
       /\ aw' = [x \in Holders |-> IF aw[x] = "waiting" THEN "woken" ELSE aw[x]]
       /\ carry' = [x \in Holders |-> IF aw[x] = "waiting" THEN "live" ELSE carry[x]]

\* Every batch of this build that ends C: complete, a terminal failure with no
\* saga, a saga's end, either cancellation, and either sweep cap.
ChildEnds(o) ==
  /\ IsLive("C")
  /\ (st["C"] = "rolling") => (o # "completed")
  /\ st' = [st EXCEPT !["C"] = o]
  /\ saga' = [saga EXCEPT !["C"] = (st["C"] = "rolling")]
  /\ Stamp("C")
  /\ Emit
  /\ legacy' = FALSE
  /\ UNCHANGED <<retries, cRuns, cCkpts, spawned, memo, named, second, redelivered, purging>>

\* An older build ends C.  It stamps the row, writes no event, and wakes nobody.
\* The deploy rule keeps it away from a registered wait, and LegacyEndWhileWaiting
\* lifts that rule.
LegacyEnds(o) ==
  /\ st["C"] = "live"
  /\ (\E x \in Holders : aw[x] = "waiting") => LegacyEndWhileWaiting
  /\ st' = [st EXCEPT !["C"] = o]
  /\ Stamp("C")
  /\ legacy' = TRUE
  /\ UNCHANGED <<saga, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry, named, second, redelivered, purging>>

\* A terminal failure of C or P that enters a saga.  The task stays live while it
\* rolls back.  A failing run of P keeps the wake columns it carried.
EnterRollback(t) ==
  /\ t \in {"C", "P"} /\ st[t] = "live" /\ (t = "P" => Running("P"))
  /\ st' = [st EXCEPT ![t] = "rolling"]
  /\ carry' = [x \in Holders |-> IF x = t /\ carry[x] = "live" THEN "stuck" ELSE carry[x]]
  /\ named' = [x \in Holders |-> IF x = t /\ named[x] = "live" THEN "stuck" ELSE named[x]]
  /\ UNCHANGED <<saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, legacy, second, redelivered, purging>>

\* retry-task revives a failed task that began no saga.  Its checkpoints are
\* intact, so P's replay finds its memos.  An await P had not answered may be
\* taken again.
Revive(t) ==
  /\ t \in {"C", "P"} /\ st[t] = "failed" /\ ~saga[t] /\ retries[t] < MaxRetries
  /\ st' = [st EXCEPT ![t] = "live"]
  /\ retries' = [retries EXCEPT ![t] = @ + 1]
  /\ Stamp(t)
  /\ aw' = [x \in Holders |-> IF x = t /\ aw[x] # "resolved" THEN "idle" ELSE aw[x]]
  /\ UNCHANGED <<saga, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* A holder's await of C: P's from its memo, H's from the handle it was given.
MayAwait(x) ==
  /\ x \in Awaiters /\ Running(x) /\ aw[x] = "idle"
  /\ (x = "P") => memo
  /\ (x = "H") => (st["C"] # "none" /\ (HandleWithinWindow => st["C"] # "absent"))

AwaitHit(x) ==
  /\ MayAwait(x) /\ Present("C") /\ cEvent
  /\ aw' = [aw EXCEPT ![x] = "resolved"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* Register and sleep in one step, only on a live child with no event.
AwaitMiss(x) ==
  /\ MayAwait(x) /\ IsLive("C") /\ ~cEvent
  /\ aw' = [aw EXCEPT ![x] = "waiting"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* C ended and nothing recorded it.  The await writes the event from C's row and
\* answers as a hit, in one batch fenced on the stamp of the row it read.
AwaitMaterialize(x) ==
  /\ MayAwait(x) /\ st["C"] \in Outcomes /\ ~cEvent
  /\ IF Lifted("materialize")
     THEN aw' = [aw EXCEPT ![x] = "reading"] /\ UNCHANGED cEvent
     ELSE cEvent' = TRUE /\ aw' = [aw EXCEPT ![x] = "resolved"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* Probe only: the materializing write as a batch of its own, fenced on nothing.
MaterializeWrite(x) ==
  /\ aw[x] = "reading" /\ st[x] = "live"
  /\ cEvent' = TRUE /\ aw' = [aw EXCEPT ![x] = "resolved"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* C's task row is gone, so nothing will ever end the await: it is refused, and
\* registers nothing.
AwaitUnknown(x) ==
  /\ MayAwait(x) /\ st["C"] = "absent"
  /\ aw' = [aw EXCEPT ![x] = IF Lifted("await") THEN "waiting" ELSE "refused"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* P in another queue: its await of C is refused, whatever C's state.
AwaitRefused ==
  /\ ParentQueue = "other" /\ Running("P") /\ aw["P"] = "idle" /\ memo
  /\ aw' = [aw EXCEPT !["P"] = "refused"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* The woken run is claimed, and its await returns the outcome parked on it.
ClaimWoken(x) ==
  /\ st[x] = "live" /\ aw[x] = "woken"
  /\ aw' = [aw EXCEPT ![x] = "resolved"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, named, legacy, second, redelivered, purging>>

\* A timed wait comes due, and the claim that finds it consumes the wait row.
\* The claim leaves wake_event on the run, which names C's completion event with
\* no outcome until the run suspends again or completes.  A run that already
\* holds a stuck name keeps it.
Timeout(x) ==
  /\ st[x] = "live" /\ aw[x] = "waiting"
  /\ aw' = [aw EXCEPT ![x] = "timedout"]
  /\ named' = [named EXCEPT ![x] = IF @ = "stuck" THEN "stuck" ELSE "live"]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, carry, legacy, second, redelivered, purging>>

\* The run that carries C's outcome, or names its event, suspends again, which
\* clears the columns.
MoveOn(x) ==
  /\ Running(x) /\ (carry[x] = "live" \/ named[x] = "live")
  /\ carry' = [carry EXCEPT ![x] = IF @ = "live" THEN "none" ELSE @]
  /\ named' = [named EXCEPT ![x] = IF @ = "live" THEN "none" ELSE @]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, legacy, second, redelivered, purging>>

HolderCompletes(x) ==
  /\ Running(x)
  /\ st' = [st EXCEPT ![x] = "completed"]
  /\ carry' = [carry EXCEPT ![x] = IF @ = "live" THEN "none" ELSE @]
  /\ named' = [named EXCEPT ![x] = IF @ = "live" THEN "none" ELSE @]
  /\ Stamp(x)
  /\ UNCHANGED <<saga, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, legacy, second, redelivered, purging>>

\* A terminal failure with no saga.  The failed run keeps the columns it carried.
HolderFails(x) ==
  /\ Running(x)
  /\ st' = [st EXCEPT ![x] = "failed"]
  /\ carry' = [carry EXCEPT ![x] = IF @ = "live" THEN "stuck" ELSE @]
  /\ named' = [named EXCEPT ![x] = IF @ = "live" THEN "stuck" ELSE @]
  /\ Stamp(x)
  /\ UNCHANGED <<saga, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, legacy, second, redelivered, purging>>

\* An attempt of the holder that carries C's outcome, or names its event, fails
\* and is retried.  The failed run keeps the columns, and its successor carries
\* them on.
HolderAttemptFails(x) ==
  /\ Running(x) /\ (carry[x] = "live" \/ named[x] = "live")
  /\ carry' = [carry EXCEPT ![x] = IF @ = "live" THEN "stuck" ELSE @]
  /\ named' = [named EXCEPT ![x] = IF @ = "live" THEN "stuck" ELSE @]
  /\ UNCHANGED <<st, saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, legacy, second, redelivered, purging>>

\* Cancelling a holder deletes its wait rows.  Its runs keep the columns they
\* carried, and a run parked on C keeps wake_event naming C's event.
HolderCancelled(x) ==
  /\ IsLive(x)
  /\ st' = [st EXCEPT ![x] = "cancelled"]
  /\ aw' = [aw EXCEPT ![x] = IF @ \in {"waiting", "woken", "reading"} THEN "cancelled" ELSE @]
  /\ carry' = [carry EXCEPT ![x] = IF @ = "live" THEN "stuck" ELSE @]
  /\ named' = [named EXCEPT ![x] = IF @ = "live" \/ aw[x] = "waiting" THEN "stuck" ELSE @]
  /\ Stamp(x)
  /\ UNCHANGED <<saga, retries, cRuns, cCkpts, cEvent, spawned, memo, legacy, second, redelivered, purging>>

\* P's saga ends, and P is failed with a saga, which retry-task refuses.
FinishSaga ==
  /\ st["P"] = "rolling"
  /\ st' = [st EXCEPT !["P"] = "failed"] /\ saga' = [saga EXCEPT !["P"] = TRUE]
  /\ Stamp("P")
  /\ UNCHANGED <<retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry, named, legacy, second, redelivered, purging>>

\* B1, the policy's half: the task is in a state the policy names.
Admitted(t) ==
  \/ st[t] \in Policy
  \/ Lifted("state") /\ st[t] \in Outcomes
  \/ Lifted("live") /\ IsLive(t)

\* B1, the age's half: the task's stamp is at least a window old.
Aged(t) == Lifted("age") \/ age[t] >= Window

\* B5: the spawning parent, found by its id in every queue.  "none" is a child
\* with no spawning parent, whose key is a producer's own.
ParentAllows ==
  \/ Lifted("parent")
  \/ Lifted("parentQueue") /\ ParentQueue = "other"
  \/ st["P"] \in {"none", "absent", "completed", "cancelled"}

PurgeChild ==
  /\ Present("C") /\ ~purging
  /\ Admitted("C")
  /\ Aged("C")
  /\ Lifted("carry") \/ \A x \in Holders : carry[x] = "none" /\ named[x] = "none"
  /\ Lifted("wait") \/ \A x \in Holders : aw[x] # "waiting"
  /\ ParentAllows
  /\ cCkpts' = FALSE /\ cRuns' = FALSE /\ cEvent' = FALSE
  /\ IF Lifted("whole")
     THEN purging' = TRUE /\ UNCHANGED st
     ELSE st' = [st EXCEPT !["C"] = "absent"] /\ UNCHANGED purging
  /\ UNCHANGED <<saga, age, retries, spawned, memo, aw, carry, named, legacy, second, redelivered>>

\* Probe only: the task row, deleted by a second batch after the rest of the unit.
PurgeRow ==
  /\ purging
  /\ st' = [st EXCEPT !["C"] = "absent"] /\ purging' = FALSE
  /\ UNCHANGED <<saga, age, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry, named, legacy, second, redelivered>>

\* The parent's or the third party's own unit.  Nothing here awaits either of
\* them, and neither was spawned by a task, so B1 is their whole barrier.  Their
\* runs go with them, and with the runs any outcome of C they carried.
PurgeHolder(x) ==
  /\ Present(x)
  /\ Admitted(x)
  /\ Aged(x)
  /\ st' = [st EXCEPT ![x] = "absent"]
  /\ carry' = [carry EXCEPT ![x] = "none"]
  /\ named' = [named EXCEPT ![x] = "none"]
  /\ memo' = (memo /\ x # "P")
  /\ UNCHANGED <<saga, age, retries, cRuns, cCkpts, cEvent, spawned, aw, legacy, second, redelivered, purging>>

\* Database time passes for every task row.
Tick ==
  /\ \E t \in Tasks : Present(t) /\ age[t] < Window
  /\ age' = [t \in Tasks |-> IF Present(t) /\ age[t] < Window THEN age[t] + 1 ELSE age[t]]
  /\ UNCHANGED <<st, saga, retries, cRuns, cCkpts, cEvent, spawned, memo, aw, carry, named, legacy, second, redelivered, purging>>

Next ==
  \/ Enqueue \/ Redeliver \/ PSpawn \/ PMemo
  \/ \E o \in Outcomes : ChildEnds(o) \/ LegacyEnds(o)
  \/ \E t \in {"C", "P"} : EnterRollback(t) \/ Revive(t)
  \/ \E x \in Holders : AwaitHit(x) \/ AwaitMiss(x) \/ AwaitMaterialize(x) \/ MaterializeWrite(x)
  \/ \E x \in Holders : AwaitUnknown(x) \/ ClaimWoken(x) \/ Timeout(x) \/ MoveOn(x) \/ HolderAttemptFails(x)
  \/ \E x \in Holders : HolderCompletes(x) \/ HolderFails(x) \/ HolderCancelled(x) \/ PurgeHolder(x)
  \/ AwaitRefused \/ FinishSaga \/ PurgeChild \/ PurgeRow \/ Tick

Spec == Init /\ [][Next]_vars

\* Fairness for liveness only.  Time passes, a live task eventually ends (which
\* Scheduler.tla's EventuallyTerminal proves for one task), a woken run is
\* claimed, a saga ends, and a unit the barrier admits is eventually purged: the
\* operator runs purge on a schedule.  Spawns, awaits, cancellations, revivals,
\* and timeouts are the task's or an operator's choice: unfair.
SpecFair ==
  /\ Spec
  /\ WF_vars(Tick)
  /\ WF_vars(\E o \in Outcomes : ChildEnds(o))
  /\ \A x \in Holders : WF_vars(HolderCompletes(x) \/ HolderFails(x))
  /\ \A x \in Holders : WF_vars(ClaimWoken(x))
  /\ WF_vars(FinishSaga)
  /\ WF_vars(PurgeChild)
  /\ WF_vars(PurgeRow)
  /\ \A x \in Holders : WF_vars(PurgeHolder(x))

-----------------------------------------------------------------------------
TypeOK ==
  /\ st \in [Tasks -> States]
  /\ saga \in [Tasks -> BOOLEAN]
  /\ age \in [Tasks -> 0..Window]
  /\ retries \in [Tasks -> 0..MaxRetries]
  /\ cRuns \in BOOLEAN /\ cCkpts \in BOOLEAN /\ cEvent \in BOOLEAN
  /\ spawned \in BOOLEAN /\ memo \in BOOLEAN
  /\ aw \in [Holders -> AwaitStates]
  /\ carry \in [Holders -> {"none", "live", "stuck"}]
  /\ named \in [Holders -> {"none", "live", "stuck"}]
  /\ legacy \in BOOLEAN /\ second \in BOOLEAN /\ redelivered \in BOOLEAN
  /\ purging \in BOOLEAN

\* The unit is whole or gone: a task row has its runs and its checkpoints' owner,
\* and no run, checkpoint, or completion event outlives the task row.  Twin: the
\* invariant library's run-owner-missing, checkpoint-owner-run-missing, and
\* wait-run-missing conditions, and the contest's rule that every completion
\* event names an existing task.
WholeUnit ==
  IF Present("C") THEN cRuns /\ cCkpts ELSE ~cRuns /\ ~cCkpts /\ ~cEvent

\* A purge takes only a task in a state the policy names whose stamp is at least
\* a window old.  So a live task is never touched, and a key dedupes for the
\* window of its task's terminal state.  Twin: the barrier grid's state and age
\* legs, at the window and one millisecond either side of it (PR5.2c2).
PurgeStepIsDeadAndOld ==
  \A t \in Tasks : (Present(t) /\ st'[t] = "absent") => (st[t] \in Policy /\ age[t] >= Window)
PurgeOnlyDeadAndOld == [][PurgeStepIsDeadAndOld]_vars

\* A parent that can still run its code, live or failed with no saga for
\* retry-task to revive, finds the child it spawned: its replay of the spawn
\* finds the child's key taken, and its await finds the child's task.  Twin: the
\* condition PR5.2c1 adds to engineHistoryViolations, that a live or revivable
\* task's $spawn memo names an existing task, and the consequence oracle.
ReplayableParentKeepsChild ==
  (spawned /\ (st["P"] = "live" \/ (st["P"] = "failed" /\ ~saga["P"]))) => Present("C")

\* A registered wait on C's completion event has C's task row, so a terminal
\* batch of this build, or a revival that ends C again, can still wake it.
\* Twin: the condition PR5.2c1 adds, that a wait on a completion event has its
\* task or its event.
NoStrandedWaiter == \A x \in Holders : aw[x] = "waiting" => Present("C")

\* A run that carries C's outcome still has the event it was parked from.  Twin:
\* the invariant library's payload/event-missing condition (wake-payload-mismatch).
CarrierKeepsEvent == \A x \in Holders : carry[x] # "none" => cEvent

\* A run that names C's completion event with no outcome parked on it keeps C's
\* unit: a timed-out await's run until it suspends again or completes, and a
\* failed or cancelled one until its holder's unit goes.  A failed holder can be
\* revived in place by retry-task and replay its await, and a cancelled one is
\* inspected.  Twin: the barrier grid's holder leg, a run naming the completion
\* event in any state (PR5.2c2).
NameCarrierKeepsChild == \A x \in Holders : named[x] # "none" => Present("C")

\* retry-task revives C only with its whole unit, so the revived task finds every
\* memo it wrote and runs no step again.  Twin: the purge label's crash-before,
\* crash-after, and duplicate cells, which leave a whole unit or none.
RevivalStepSeesWholeUnit == (st["C"] = "failed" /\ st'["C"] = "live") => (cRuns /\ cCkpts)
RevivalSeesWholeUnit == [][RevivalStepSeesWholeUnit]_vars

\* An await of a child whose unit is gone registers nothing and returns nothing:
\* it is refused.  Twin: the native purge-versus-await race in the retention
\* surface, and ChildAwaitRefusedError('no-such-task').
AwaitStepOnPurgedIsRefused ==
  \A x \in Holders : (aw[x] = "idle" /\ aw'[x] # "idle" /\ st["C"] = "absent") => aw'[x] = "refused"
AwaitOnPurgedIsRefused == [][AwaitStepOnPurgedIsRefused]_vars

\* What keeps C's unit forever by design (the header lists why).
KeptForever ==
  \/ st["P"] = "failed" /\ "failed" \notin Policy
  \/ \E x \in Holders : carry[x] = "stuck" /\ st[x] \in Outcomes \ Policy
  \/ \E x \in Holders : named[x] = "stuck" /\ st[x] \in Outcomes \ Policy
  \/ st["C"] \in Outcomes /\ \E x \in Holders : aw[x] = "waiting"

\* A unit in a state the policy names, which nothing the policy keeps holds, is
\* purged, or leaves that state by revival, or comes to be held by what the
\* policy keeps.  The barrier holds no unit forever for any other reason.  Twin:
\* the simulated week's floors (PR5.2d).
AgedUnblockedIsPurged ==
  (st["C"] \in Policy /\ ~KeptForever) ~> (st["C"] \notin Policy \/ KeptForever)
=============================================================================
