----------------------------- MODULE Probes -----------------------------
\* Vacuity probes: each PROBE invariant is EXPECTED TO FAIL -- its
\* counterexample is a witness trace proving the modeled feature is
\* reachable (not vacuously verified).  Run one at a time.
EXTENDS Scheduler

\* Witness: an emitted payload delivered to an activated worker.
ProbeNoDelivery ==
  \A r \in RunIds :
    ~(runState[r] = "running" /\ activatedGen[r] = claimGen[r]
      /\ runPayload[r] # NoPayload)

\* Witness: a timeout wake (wake_event set, payload NULL, claimed).
ProbeNoTimeoutWake ==
  \A r \in RunIds :
    ~(runState[r] = "running" /\ wakeEvent[r] # NoEvent
      /\ runPayload[r] = NoPayload /\ waitEv[r] = NoEvent)

\* Witness: a cancellation that killed a RUNNING run (direct
\* running -> cancelled) while its worker context is still alive (zombie).
ProbeNoCancelledZombie ==
  \A c \in contexts : runState[c.run] # "cancelled"

\* Witness: an untimed (Inf) wait registered.
ProbeNoForeverWait ==
  \A r \in RunIds : waitAt[r] # Inf

\* Witness: a max_duration deadline armed by first activation.
ProbeNoDurDeadline ==
  \A t \in Tasks : ~(firstStarted[t] # Inf /\ cancelAt[t] # Inf)
\* Witness: a launch deferral that parks a task with an armed start deadline
\* and leaves the start unlatched.
ProbeNoDeferredStartDeadline ==
  \A t \in Tasks :
    ~(lastAction = "Defer" /\ policy[t] = "delay" /\ cancelAt[t] # Inf
      /\ firstStarted[t] = Inf)
\* Witness: a live worker whose task's cancellation deadline is due, so every
\* suspension it attempts is refused.
ProbeNoRefusedSuspension ==
  \A c \in contexts : ~(Fenced(c) /\ ~EligibleTask(runTask[c.run]))
=========================================================================
