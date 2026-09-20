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
\*  - A child can be terminal with NO completion event: an older build ended it,
\*    in a rolling deploy or before this protocol existed.  No terminal batch will
\*    ever fire for it again, so an await that registered a wait would sleep
\*    forever.  The await therefore never registers on an ended child.  It WRITES
\*    the missing event from the child's current outcome, in the same atomic step,
\*    and answers as a hit.  That outcome is the best fact left, and it is the
\*    recorded first outcome from then on: firstOutcome below is the first outcome
\*    RECORDED, and an older build's ending records nothing.
\*  - An older build may end the child only while no wait is registered.  That
\*    is the deploy rule (every worker and driver runs this build before any task
\*    awaits a child), and it is an assumption, not something the protocol
\*    enforces: LegacyEndWhileWaiting lifts it in a probe, and the waiter strands.
\*  - An await of a task that does not exist is refused like an await across
\*    queues: nothing would ever end it.
\*
\* SCOPE: ONE QUEUE.  Events are keyed by queue and are shard-local (S3.7), so
\* the child's terminal batch can write the event and wake the waiter in one
\* atomic step only when the event, the wait row, and the parent's run live in
\* one queue.  That is the await this model covers.  An await across queues
\* needs a delivery protocol that does not exist, and nothing here speaks for it.
\*
\* THE QUEUE RULE, isolated as one constant.  A child is awaited only within its
\* parent's queue.  An await across queues is refused, as a permanent error that
\* registers nothing.  AwaitAllowed is that rule: TRUE is a child in the parent's
\* queue, FALSE a child in another.  The three await actions read it.
\* RefusedNeverWaits holds one direction, a refused await never waits, and
\* RefusalIsTheRule the other, an allowed await is never refused.  The protocol
\* is checked with the await allowed and with it refused.  Absurd refuses the SAME-queue await instead, because its
\* await polls and holds a worker slot.  Ours suspends and holds nothing.
\*
\* WHAT THE SQL OWES THIS MODEL, beyond its actions:
\*  - Every terminal batch takes the dialect's event lock, as emit-event and
\*    await-event do (S3.4 rule 2).  Actions here are atomic and mutually
\*    exclusive.  Without the lock on PostgreSQL, a parent reads no event, the
\*    child inserts the event and sees no wait row, and the parent sleeps forever.
\*  - The completion event outlives every await of it.  No action here removes an
\*    event, so event cleanup must not take one while its task can be awaited.
\*  - The child await reaches the store by an internal path: the SDK's awaitEvent
\*    refuses a name that starts with $, and the store's emitEvent port must.
\*
\* NOT MODELED, and why that is sound or what bounds it:
\*  - The parent's own retry successor.  Scheduler.tla's SuccessorCarriesWake and
\*    EventImmutable cover it: a successor awaits again and hits the same event.
\*  - Several parents or children.  Each child has its own event and each wait
\*    is its own row, which Scheduler.tla's event protocol covers.  The one wait
\*    here cannot show that an emit wakes EVERY waiter.
\*  - Await cycles.  A parent that awaits a child that awaits the parent waits
\*    forever in any queue.  Nothing detects it, and only a cancellation
\*    deadline bounds it, as it bounds any untimed await.
\*  - The dedicated placement, where an emit marks the wait row delivered and
\*    does not delete it (S3.3, S3.8.3).  `wait` here is a wait row an emit can
\*    still wake, which a delivered row is not.
\*  - A second await by the same parent.  After a timeout the parent's code may
\*    await again, which is a new await: it hits the event or registers a new
\*    wait.  One await is modeled, so its answer is final here.
\*  - Whether a wait is timed.  Any registered wait may time out here, which
\*    checks a superset of the behaviours.
\*  - The fairness below borrows Scheduler.tla's EventuallyTerminal, which holds
\*    under that model's own restrictions: an untimed await only under an armed
\*    cancellation deadline.
\*
\* ---------------------------------------------------------------------------
\* BATCH-LABEL LEDGER -- machine-checked by scripts/spec-ledger.py.  The model
\* came before its SQL (spec-first), and these are the batches that implement
\* it.  The script holds this block to what it can see: every quoted label is
\* a batch some store sends, every action named is an action of Next below,
\* and every action of Next is mapped here or listed as having no batch, with
\* the reason.  It reads no guard.  The guards are held by conformance cases
\* under descriptive titles: the `child-tasks` surface holds the awaits and the
\* terminal batches, and the scheduler suite holds SpawnChild's guard, that a
\* child is created only under its parent's live claim.
\*
\* An entry starts three spaces in and keeps its labels, its actions, and its
\* class on that one line, and its prose continues five spaces in.  The class
\* is the label's duplicate-semantics class, which Scheduler.tla's ledger
\* defines and assigns, so an entry that states one must agree with it.
\*
\* Modeled (a label and its condition, its actions, its class):
\*   'spawn' of a child -> SpawnChild  [receipt]  (the insert presents the
\*     parent's live claim, the one a child await presents.  A replay finds the
\*     child by its reserved key, with no claim, and creates nothing)
\*   'complete' -> ChildTerminal  [cas-fenced]
\*   'fail' that ends the task -> ChildTerminal  [cas-fenced]
\*   'fail-rollback' that ends the task -> ChildTerminal  [cas-fenced]
\*   'cancel-task' -> ChildTerminal  [cas-fenced]
\*   'sweep:cancel' -> ChildTerminal  [cas-fenced]
\*   'sweep:lost-launch' at its cap -> ChildTerminal  [cas-fenced]
\*   'sweep:claim-timeout' at the infra cap -> ChildTerminal  [cas-fenced]
\*     (every batch that can end a task, which the conformance suite lists as
\*     TERMINAL_BATCH_LABELS.  The completion event and the waiter's wake are
\*     follow-ons of the terminal compare-and-set, so a replay finds the task
\*     already terminal and writes nothing.  A failure that retries, and a
\*     failure or a cap that starts a saga (Sagas.tla), end no task and write
\*     no event)
\*   'retry-task' -> ReviveChild  [cas-fenced]  (leaves the event alone)
\*   'await-event' -> AwaitHit / AwaitMiss  [cas-fenced]  (the batch a caller's
\*     await sends, reached by an internal path that builds the reserved name.
\*     It registers only while a task with the child's id is live in the
\*     parent's queue, which it reads inside the batch, under the event lock)
\*   'await-event' -> AwaitRefused / AwaitUnknown  [cas-fenced]  (it registered
\*     nothing and hit nothing, and the 'task-done-state' read says why: a child
\*     in another queue, or no such task.  Nothing is written)
\*   'record-task-done' -> AwaitMaterialize  [cas-fenced]  (the same read found
\*     the child ended with nothing recorded.  The batch writes the event from
\*     that row, fenced on the row's stamp, on no event existing, and on the
\*     awaiting run's live claim, under the event lock, and answers as a hit)
\*   'claim' of the woken run -> ParentClaimWoken  [receipt]  (the claim returns
\*     the outcome the emit parked on the run)
\*   'claim' of a run whose timed wait came due -> AwaitTimeout  [receipt]
\*     (unchanged: the claim consumes the wait row)
\*   'cancel-task', 'sweep:cancel' of the parent -> CancelParent  [cas-fenced]
\*     (unchanged: the cancellation deletes the parent's wait rows)
\* No batch (action -- reason):
\*   LegacyTerminal -- a terminal batch of an older build: no SQL of this build,
\*     it is what this build must tolerate
\*   LateEmit -- exists only for a vacuity probe
\*   ForgedEmit -- exists only for a vacuity probe: the emit port refuses a
\*     reserved name, so 'emit-event' never writes this event
\* ---------------------------------------------------------------------------

EXTENDS Naturals

CONSTANTS
  MaxRetries,     \* retry-task revivals of the child.  ARTIFICIAL bound.
  AwaitAllowed,   \* TRUE: the child is in the parent's queue.  FALSE: the await is refused
  AtomicEmit,     \* TRUE in the protocol.  FALSE only in a vacuity probe.
  UserMayForge,   \* FALSE in the protocol.  TRUE only in a vacuity probe.
  LegacyEnd,      \* TRUE in the protocol: an older build may end the child.
  LegacyEndWhileWaiting  \* FALSE in the protocol.  TRUE only in a vacuity probe.

ASSUME /\ MaxRetries \in Nat
       /\ AwaitAllowed \in BOOLEAN
       /\ AtomicEmit \in BOOLEAN
       /\ UserMayForge \in BOOLEAN
       /\ LegacyEnd \in BOOLEAN
       /\ LegacyEndWhileWaiting \in BOOLEAN

Outcomes == {"completed", "failed", "cancelled"}
None     == "none"

VARIABLES
  child,         \* "unspawned", "live", or an outcome
  firstOutcome,  \* ghost: the first outcome RECORDED for the child, or None
  doneEvent,     \* the completion event's payload, or None (unset)
  parent,        \* "running", "waiting", "woken", "resolved", "timedout",
                 \* "refused", "cancelled"
  \* wait and parked could be derived from parent and doneEvent.  They are kept
  \* because they are the two stored representations, the wait row and the run's
  \* parked payload, whose agreement WaitIntegrity and ParkedMatchesEvent check.
  wait,          \* a wait row for the completion event exists
  parked,        \* the outcome parked on the parent's run by the emit
  seen,          \* the outcome the parent's await returned, or None
  retries        \* revivals consumed

vars == <<child, firstOutcome, doneEvent, parent, wait, parked, seen, retries>>

Init ==
  /\ child = "unspawned" /\ firstOutcome = None /\ doneEvent = None
  /\ parent = "running" /\ wait = FALSE /\ parked = None /\ seen = None
  /\ retries = 0

SpawnChild ==
  /\ parent = "running" /\ child = "unspawned"
  /\ child' = "live"
  /\ UNCHANGED <<firstOutcome, doneEvent, parent, wait, parked, seen, retries>>

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
     THEN Emit(o)
     ELSE UNCHANGED <<doneEvent, parent, parked, wait>>
  /\ UNCHANGED <<seen, retries>>

\* An older build ends the child.  It writes no event, wakes nobody, and records
\* nothing.  The deploy rule keeps it away from a registered wait.
LegacyTerminal(o) ==
  /\ LegacyEnd /\ child = "live"
  /\ (wait => LegacyEndWhileWaiting)
  /\ child' = o
  /\ UNCHANGED <<firstOutcome, doneEvent, parent, wait, parked, seen, retries>>

\* Probe only: the emit as its own later step, which a crash can separate
\* from the terminal transition.
LateEmit ==
  /\ ~AtomicEmit /\ child \in Outcomes /\ doneEvent = None
  /\ Emit(child)
  /\ UNCHANGED <<child, firstOutcome, seen, retries>>

\* retry-task: a failed child returns to live.  The event is untouched.
ReviveChild ==
  /\ child = "failed" /\ retries < MaxRetries
  /\ child' = "live" /\ retries' = retries + 1
  /\ UNCHANGED <<firstOutcome, doneEvent, parent, wait, parked, seen>>

AwaitHit ==
  /\ parent = "running" /\ child # "unspawned" /\ AwaitAllowed
  /\ doneEvent # None
  /\ parent' = "resolved" /\ seen' = doneEvent
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, retries>>

\* Register and sleep in one step, guarded on the event being absent.
AwaitMiss ==
  /\ parent = "running" /\ child # "unspawned" /\ AwaitAllowed
  /\ child \notin Outcomes
  /\ doneEvent = None
  /\ parent' = "waiting" /\ wait' = TRUE
  /\ UNCHANGED <<child, firstOutcome, doneEvent, parked, seen, retries>>

\* The child has ended and nothing recorded it.  The await writes the event from
\* the child's current outcome and returns it, in one step, and registers nothing.
AwaitMaterialize ==
  /\ parent = "running" /\ AwaitAllowed
  /\ child \in Outcomes /\ doneEvent = None
  /\ doneEvent' = child
  /\ firstOutcome' = IF firstOutcome = None THEN child ELSE firstOutcome
  /\ parent' = "resolved" /\ seen' = child
  /\ UNCHANGED <<child, wait, parked, retries>>

\* No such task: nothing would ever end the await, so it is refused.
AwaitUnknown ==
  /\ parent = "running" /\ child = "unspawned"
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, seen, retries>>
  /\ parent' = "refused"

AwaitRefused ==
  /\ parent = "running" /\ child # "unspawned" /\ ~AwaitAllowed
  /\ parent' = "refused"
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, seen, retries>>

\* The woken run is claimed and its await returns the parked outcome.
ParentClaimWoken ==
  /\ parent = "woken"
  /\ parent' = "resolved" /\ seen' = parked
  /\ UNCHANGED <<child, firstOutcome, doneEvent, wait, parked, retries>>

\* A timed wait comes due and the claim that finds it consumes the wait row
\* (Scheduler.tla's Claim).  The await returns no outcome, and a later emit finds
\* no wait row, so it cannot wake this parent a second time.
AwaitTimeout ==
  /\ parent = "waiting"
  /\ parent' = "timedout" /\ wait' = FALSE
  /\ UNCHANGED <<child, firstOutcome, doneEvent, parked, seen, retries>>

\* Cancelling the parent deletes its wait rows, as CancelCore does.
CancelParent ==
  /\ parent \in {"running", "waiting", "woken"}
  /\ parent' = "cancelled" /\ wait' = FALSE
  /\ UNCHANGED <<child, firstOutcome, doneEvent, parked, seen, retries>>

\* Probe only: a user emit under the completion event's name.
ForgedEmit(o) ==
  /\ UserMayForge /\ doneEvent = None
  /\ Emit(o)
  /\ UNCHANGED <<child, firstOutcome, seen, retries>>

Next ==
  \/ SpawnChild
  \/ \E o \in Outcomes : ChildTerminal(o) \/ ForgedEmit(o) \/ LegacyTerminal(o)
  \/ LateEmit \/ ReviveChild
  \/ AwaitHit \/ AwaitMiss \/ AwaitMaterialize \/ AwaitRefused \/ AwaitUnknown
  \/ ParentClaimWoken \/ AwaitTimeout \/ CancelParent

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
  /\ parent \in {"running", "waiting", "woken", "resolved", "timedout", "refused",
                "cancelled"}
  /\ wait \in BOOLEAN
  /\ parked \in Outcomes \cup {None} /\ seen \in Outcomes \cup {None}
  /\ retries \in 0..MaxRetries

\* A child whose ending was recorded has its completion event.  The emit cannot
\* be a second step: a crash between the two would strand every waiter.  Only an
\* older build's ending, which records nothing, leaves a terminal child without one.
TerminalImpliesDone == (child \in Outcomes /\ firstOutcome # None) => doneEvent # None

\* A registered wait has something left to wake it: its child is live, so a
\* terminal batch of this build is still to come.  An await that registered on an
\* ended child would sleep forever.
WaitIsWakeable == wait => child = "live"

\* The event is the FIRST outcome, and only a terminal transition wrote it.
DoneIsFirstOutcome == doneEvent # None => doneEvent = firstOutcome

\* A wait row never sits beside an emitted event, so no wake is lost.
WaitIntegrity == wait => (parent = "waiting" /\ doneEvent = None)

ParkedMatchesEvent == parked # None => parked = doneEvent

\* Whatever an await returned is the child's first outcome, and only a resolved
\* await returned one.
SeenIsFirstOutcome ==
  /\ seen # None => seen = firstOutcome
  /\ (parent = "resolved") <=> (seen # None)

\* The refusing rule refuses: with the await not allowed, the parent never
\* waits, is never woken, and never gets an outcome or a timeout from an await.
RefusedNeverWaits ==
  ~AwaitAllowed => parent \notin {"waiting", "woken", "resolved", "timedout"}

\* The rule's other direction: only an await the rule does not allow, or an
\* await of no task at all, is refused.  Without it, SQL that refuses every child
\* await satisfies the model.
RefusalIsTheRule == parent = "refused" => (~AwaitAllowed \/ child = "unspawned")

DoneImmutable == [][doneEvent # None => doneEvent' = doneEvent]_vars

\* Only a running parent spawns.  The pass that calls ctx.spawn holds the parent's live
\* claim, and the spawn batch creates a child only under that claim.  A caller that
\* knows a parent's id and nothing else cannot place a task under the key the parent
\* will look up, which the reserved key alone left open to any caller of the port.
SpawnAuthority ==
  [][(child = "unspawned" /\ child' = "live") => parent = "running"]_vars

\* The event is written only in the step that ends a live child, or by an await
\* that finds the child ended with nothing recorded, and then it is the child's
\* own outcome and the await returns it.
DoneAuthority ==
  [][doneEvent' # doneEvent =>
       \/ (child = "live" /\ child' \in Outcomes)
       \/ (child \in Outcomes /\ child' = child /\ doneEvent' = child /\ seen' = child)]_vars

\* A woken parent gets its outcome.  The emit consumed the wait row, so no
\* timeout can take the wake back, and only a cancellation can come first.
WakeIsDelivered ==
  [][parent = "woken" => parent' \in {"woken", "resolved", "cancelled"}]_vars

\* An await ends in one answer: an outcome, a timeout, a refusal, or the
\* parent's cancellation.  The wait row went with it, so a later emit wakes
\* nobody and nothing moves the parent again.
AnswerIsFinal ==
  [][(parent \in {"resolved", "timedout", "refused", "cancelled"}) => parent' = parent]_vars

\* A registered wait is resolved, times out, or dies with a cancelled parent.
EveryWaitResolves ==
  (parent = "waiting") ~> (parent \in {"resolved", "timedout", "cancelled"})
=============================================================================
