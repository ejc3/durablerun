---------------------------- MODULE WakeDelivery ----------------------------
\* The hosted wake adapter, not another scheduler protocol. Scheduler.tla
\* proves durable ownership/state transitions assuming fair driver actions;
\* this model supplies those invocations through advisory hints, immutable
\* one-shot alarms, and an independently owned recurring recovery source.
\*
\* Two already-checkpointed sleepers share one queue. Enqueue abstracts the
\* durable sleep write; only Tick can complete due work. A tick's next-wake
\* read and its host publication are separate actions, so older/later plans
\* may publish after newer/earlier ones. Publishing ADDS a delivery: it never
\* replaces a queue-wide alarm or permanently deduplicates a fired alarm.
\* Accepted delivery may duplicate/reorder, and advisory requests may be lost.
\* The first enqueue hint is deliberately lost in every execution.
\*
\* Fairness is an ENVIRONMENT obligation: database time advances, an
\* independent recovery source keeps invoking ticks, and accepted ticks
\* eventually run. It proves eventual completion, NOT a latency bound. The
\* hosted receipt measures the desired 60-second recovery bound separately.
\* SQL fencing, worker crashes/retries, and authentication remain covered by
\* Scheduler.tla and executable tests, not weakened assumptions here.
EXTENDS Naturals, FiniteSets

CONSTANTS Tasks, MaxTime
ASSUME /\ Tasks # {}
       /\ Tasks \subseteq 1..MaxTime

VARIABLES now, enqueued, done, hints, plans, alarms, tickPending
vars == <<now, enqueued, done, hints, plans, alarms, tickPending>>
Times == 0..MaxTime
Minimum(values) == CHOOSE value \in values : \A other \in values : value <= other

Init == /\ now = 0
        /\ enqueued = {}
        /\ done = {}
        /\ hints = {}
        /\ plans = {}
        /\ alarms = {}
        /\ tickPending = FALSE

\* Task identifiers are their fixed database due times. Arbitrary enqueue
\* order includes an earlier sleeper appearing after a later alarm exists.
Enqueue(task) ==
  /\ task \notin enqueued
  /\ enqueued' = enqueued \cup {task}
  /\ hints' = IF enqueued = {} THEN hints ELSE hints \cup {task}
  /\ UNCHANGED <<now, done, plans, alarms, tickPending>>

Hint(task) ==
  /\ task \in hints
  /\ hints' = hints \ {task}
  /\ tickPending' \in {tickPending, TRUE}
  /\ UNCHANGED <<now, enqueued, done, plans, alarms>>

\* This finite abstraction handles every due sleeper in a tick; the
\* bounded-backlog case is the same action repeated by immediate hints.
Tick ==
  LET remaining == {task \in enqueued \ done : task > now}
  IN /\ tickPending
     /\ done' = done \cup {task \in enqueued : task <= now}
     /\ plans' = IF remaining = {} THEN plans ELSE plans \cup {Minimum(remaining)}
     /\ tickPending' = FALSE
     /\ UNCHANGED <<now, enqueued, hints, alarms>>

Publish(at) ==
  /\ at \in plans
  /\ plans' = plans \ {at}
  /\ alarms' = alarms \cup {at}
  /\ UNCHANGED <<now, enqueued, done, hints, tickPending>>

LosePlan(at) ==
  /\ at \in plans
  /\ plans' = plans \ {at}
  /\ UNCHANGED <<now, enqueued, done, hints, alarms, tickPending>>

\* Retaining a delivered alarm permits duplicates; choosing any due alarm
\* permits reordering. Accepted alarms have fair, at-least-once delivery;
\* LosePlan is a failed publication, not a silently acknowledged delivery.
Deliver(at) ==
  /\ at \in alarms /\ at <= now
  /\ alarms' \in {alarms, alarms \ {at}}
  /\ tickPending' = TRUE
  /\ UNCHANGED <<now, enqueued, done, hints, plans>>

Recover ==
  /\ ~tickPending
  /\ tickPending' = TRUE
  /\ UNCHANGED <<now, enqueued, done, hints, plans, alarms>>

TimeAdvance ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<enqueued, done, hints, plans, alarms, tickPending>>

Next == \/ \E task \in Tasks : Enqueue(task) \/ Hint(task)
        \/ Tick
        \/ \E at \in Times : Publish(at) \/ LosePlan(at) \/ Deliver(at)
        \/ Recover
        \/ TimeAdvance

Spec == Init /\ [][Next]_vars
             /\ WF_vars(TimeAdvance) /\ WF_vars(Recover) /\ WF_vars(Tick)
             /\ \A at \in Times : WF_vars(Deliver(at))

TypeOK == /\ now \in Times
          /\ done \subseteq enqueued /\ enqueued \subseteq Tasks
          /\ hints \subseteq enqueued
          /\ plans \subseteq Times /\ alarms \subseteq Times
          /\ tickPending \in BOOLEAN
NoEarlyCompletion == \A task \in done : task <= now
DurableProgress == [][enqueued \subseteq enqueued' /\ done \subseteq done']_vars
\* This checks actual outstanding times, not which publication ran last.
NoLostEarlierWake == [][\A at \in Times : Publish(at) => alarms \subseteq alarms']_vars
EventuallyCompletes == \A task \in Tasks : (task \in enqueued) ~> (task \in done)
=============================================================================
