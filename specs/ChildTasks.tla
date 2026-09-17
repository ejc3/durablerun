----------------------------- MODULE ChildTasks -----------------------------
\* Child tasks: a parent awaits a child's completion as an event (DESIGN.md
\* S3.2, "Child tasks").  Not another scheduler protocol.  Scheduler.tla proves
\* ownership, fencing, and the event protocol for one task at the largest scope
\* TLC can exhaust, and a second task multiplies that space several-fold.  This
\* model holds the one thing child tasks add: the completion event, written by
\* the child's terminal transition and awaited by the parent.
\*
\* One parent and one child.  The child's own lifecycle is abstracted to live,
\* terminal with an outcome, and revived: every path Scheduler.tla proves ends
\* a task (complete, terminal failure, either cancellation, either sweep cap)
\* is one ChildTerminal step here, and retry-task is ReviveChild.
\*
\* THE PROTOCOL
\*  - The child's FIRST terminal transition writes its completion event in the
\*    same atomic batch.  The event is first-write-wins like every event
\*    (S3.8.3), so a revived child that ends again does not rewrite it.  The
\*    event therefore means "the first outcome this task reached", never "the
\*    task is terminal now": retry-task can take a failed task back to live.
\*  - The same batch wakes a registered waiter: its run turns pending with the
\*    outcome parked on it, and its wait row is deleted (S3.4 rule 2).
\*  - The parent's await is the ordinary await-event: a hit returns the outcome
\*    with no suspension, and a miss registers the wait and sleeps in one step.
\*  - The event's name is reserved.  No user emit can write it, or a caller
\*    could win first-write-wins and forge a child's result.
\*
\* THE OPEN QUESTION, isolated as one guard.  DESIGN.md keeps Absurd's rule that
\* awaiting a same-queue child is refused.  Absurd refuses it because its await
\* polls and holds a worker slot, and ours suspends.  AwaitAllowed is that rule
\* and nothing else reads SameQueue, so both answers are model-checked and the
\* protocol is sound under either.
\*
\* Ledger, modeled ahead of implementation (spec-first):
\*   every terminal batch ('complete', 'fail', 'cancel-task', 'sweep:cancel',
\*     'sweep:lost-launch' cap, 'sweep:claim-timeout' at the infra cap)
\*     -> ChildTerminal  [cas-fenced]  (the completion event and the waiter's
\*     wake are follow-ons of the terminal compare-and-set, so a replay finds
\*     the task already terminal and writes nothing)
\*   'retry-task' -> ReviveChild  [cas-fenced]  (leaves the event alone)
\*   'await-event' -> AwaitHit / AwaitMiss  [cas-fenced]  (unchanged)
EXTENDS Naturals

CONSTANTS
  MaxRetries,     \* retry-task revivals of the child.  ARTIFICIAL bound.
  SameQueue,      \* the parent and the child share a queue
  SameQueueRule,  \* "refuse" (DESIGN.md today) or "allow"
  AtomicEmit,     \* TRUE in the protocol.  FALSE only in a vacuity probe.
  UserMayForge    \* FALSE in the protocol.  TRUE only in a vacuity probe.

ASSUME /\ MaxRetries \in Nat
       /\ SameQueue \in BOOLEAN
       /\ SameQueueRule \in {"refuse", "allow"}
       /\ AtomicEmit \in BOOLEAN
       /\ UserMayForge \in BOOLEAN

Outcomes == {"completed", "failed", "cancelled"}
None     == "none"

VARIABLES
  child,         \* "unspawned", "live", or an outcome
  firstOutcome,  \* ghost: the first outcome the child reached, or None
  doneEvent,     \* the completion event's payload, or None (unset)
  parent,        \* "running", "waiting", "woken", "resolved", "refused",
                 \* "cancelled"
  wait,          \* a wait row for the completion event exists
  parked,        \* the outcome parked on the parent's run by the emit
  seen,          \* the outcome the parent's await returned, or None
  retries,       \* revivals consumed
  owed           \* probe only: a terminal committed and its emit has not

vars == <<child, firstOutcome, doneEvent, parent, wait, parked, seen, retries, owed>>

Init ==
  /\ child = "unspawned" /\ firstOutcome = None /\ doneEvent = None
  /\ parent = "running" /\ wait = FALSE /\ parked = None /\ seen = None
  /\ retries = 0 /\ owed = FALSE

AwaitAllowed == ~SameQueue \/ SameQueueRule = "allow"

SpawnChild ==
  /\ parent = "running" /\ child = "unspawned"
  /\ child' = "live"
  /\ UNCHANGED <<firstOutcome, doneEvent, parent, wait, parked, seen, retries, owed>>

\* The emit and the waiter's wake, as the terminal batch's follow-ons.  First
\* write wins: an event that exists is left alone, and so is the parent.
Emit(o) ==
  IF doneEvent = None
  THEN /\ doneEvent' = o
       /\ IF wait
          THEN parent' = "woken" /\ parked' = o /\ wait' = FALSE
          ELSE UNCHANGED <<parent, parked, wait>>
  ELSE UNCHANGED <<doneEvent, parent, parked, wait>>

ChildTerminal(o) ==
  /\ child = "live"
  /\ child' = o
  /\ firstOutcome' = IF firstOutcome = None THEN o ELSE firstOutcome
  /\ IF AtomicEmit
     THEN Emit(o) /\ UNCHANGED owed
     ELSE owed' = TRUE /\ UNCHANGED <<doneEvent, parent, parked, wait>>
  /\ UNCHANGED <<seen, retries>>

\* Probe only: the emit as its own later step, which a crash can separate
\* from the terminal transition.
LateEmit ==
  /\ ~AtomicEmit /\ owed /\ child \in Outcomes
  /\ Emit(child) /\ owed' = FALSE
  /\ UNCHANGED <<child, firstOutcome, seen, retries>>

\* retry-task: a failed child returns to live.  The event is untouched.
ReviveChild ==
  /\ child = "failed" /\ retries < MaxRetries
  /\ child' = "live" /\ retries' = retries + 1
  /\ UNCHANGED <<firstOutcome, doneEvent, parent, wait, parked, seen, owed>>

AwaitHit ==
  /\ parent = "running" /\ child # "unspawned" /\ AwaitAllowed
  /\ doneEvent # None
  /\ parent' = "resolved" /\ seen' = doneEvent
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, retries, owed>>

\* Register and sleep in one step, guarded on the event being absent.
AwaitMiss ==
  /\ parent = "running" /\ child # "unspawned" /\ AwaitAllowed
  /\ doneEvent = None
  /\ parent' = "waiting" /\ wait' = TRUE
  /\ UNCHANGED <<child, firstOutcome, doneEvent, parked, seen, retries, owed>>

AwaitRefused ==
  /\ parent = "running" /\ child # "unspawned" /\ ~AwaitAllowed
  /\ parent' = "refused"
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, seen, retries, owed>>

\* The woken run is claimed and its await returns the parked outcome.
ParentClaimWoken ==
  /\ parent = "woken"
  /\ parent' = "resolved" /\ seen' = parked
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, retries, owed>>

\* Cancelling the parent deletes its wait rows, as CancelCore does.
CancelParent ==
  /\ parent \in {"running", "waiting", "woken"}
  /\ parent' = "cancelled" /\ wait' = FALSE
  /\ UNCHANGED <<child, firstOutcome, doneEvent, parked, seen, retries, owed>>

\* Probe only: a user emit under the completion event's name.
ForgedEmit(o) ==
  /\ UserMayForge /\ doneEvent = None
  /\ Emit(o)
  /\ UNCHANGED <<child, firstOutcome, seen, retries, owed>>

Next ==
  \/ SpawnChild
  \/ \E o \in Outcomes : ChildTerminal(o) \/ ForgedEmit(o)
  \/ LateEmit \/ ReviveChild
  \/ AwaitHit \/ AwaitMiss \/ AwaitRefused
  \/ ParentClaimWoken \/ CancelParent

Spec == Init /\ [][Next]_vars

\* Fairness for liveness only.  A live child eventually ends, which
\* Scheduler.tla's EventuallyTerminal proves for one task, and a woken run is
\* eventually claimed.  Revival and cancellation are operator actions: unfair.
SpecFair ==
  /\ Spec
  /\ WF_vars(\E o \in Outcomes : ChildTerminal(o))
  /\ WF_vars(ParentClaimWoken)

-----------------------------------------------------------------------------
TypeOK ==
  /\ child \in {"unspawned", "live"} \cup Outcomes
  /\ firstOutcome \in Outcomes \cup {None}
  /\ doneEvent \in Outcomes \cup {None}
  /\ parent \in {"running", "waiting", "woken", "resolved", "refused", "cancelled"}
  /\ wait \in BOOLEAN /\ owed \in BOOLEAN
  /\ parked \in Outcomes \cup {None} /\ seen \in Outcomes \cup {None}
  /\ retries \in 0..MaxRetries

\* A terminal child has its completion event.  The emit cannot be a second
\* step: a crash between the two would strand every waiter.
TerminalImpliesDone == child \in Outcomes => doneEvent # None

\* The event is the FIRST outcome, and only a terminal transition wrote it.
DoneIsFirstOutcome == doneEvent # None => doneEvent = firstOutcome

\* A wait row never sits beside an emitted event, so no wake is lost.
WaitIntegrity == wait => (parent = "waiting" /\ doneEvent = None)

ParkedMatchesEvent == parked # None => parked = doneEvent

\* Whatever an await returned is the child's first outcome.
ResolvedSawFirstOutcome ==
  /\ (parent = "resolved") => (seen # None /\ seen = firstOutcome)
  /\ (parent # "resolved") => seen = None

\* A refused await registers nothing.
RefusedRegistersNothing == parent = "refused" => (~wait /\ seen = None)

\* The refusal is exactly the same-queue rule.
RefusalIsTheRule == parent = "refused" => (SameQueue /\ SameQueueRule = "refuse")

DoneImmutable == [][doneEvent # None => doneEvent' = doneEvent]_vars

\* The event is written only in the step that ends a live child.
DoneAuthority ==
  [][doneEvent' # doneEvent => (child = "live" /\ child' \in Outcomes)]_vars

\* Vacuity probes, each EXPECTED TO FAIL: its counterexample is a witness that
\* the behaviour the protocol exists for is reachable.
\* Witness: a parent that registered a wait and was woken by the child's end.
ProbeNoWokenParent == parent # "woken"
\* Witness: a revived child that ends a second time with another outcome, while
\* the event still carries the first.
ProbeNoSecondOutcome == ~(retries > 0 /\ child \in Outcomes /\ child # doneEvent)
\* Witness: an await that the same-queue rule refused.
ProbeNoRefusedAwait == parent # "refused"

\* A registered wait is resolved, unless the parent is cancelled first.
EveryWaitResolves == (parent = "waiting") ~> (parent \in {"resolved", "cancelled"})
=============================================================================
