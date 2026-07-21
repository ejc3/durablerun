---- MODULE Probes_TTrace_1784623817 ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, Probes_TEConstants, Probes

_expression ==
    LET Probes_TEExpression == INSTANCE Probes_TEExpression
    IN Probes_TEExpression!expression
----

_trace ==
    LET Probes_TETrace == INSTANCE Probes_TETrace
    IN Probes_TETrace!trace
----

_inv ==
    ~(
        TLCGet("level") = Len(_TETrace)
        /\
        lastCtx = ([run |-> 1, gen |-> 2])
        /\
        claimGen = (<<2, 0, 0>>)
        /\
        firstStarted = ((t1 :> 0))
        /\
        channel = ({[run |-> 1, gen |-> 1], [run |-> 1, gen |-> 2]})
        /\
        contexts = ({[run |-> 1, gen |-> 2, id |-> 2]})
        /\
        nextRun = (2)
        /\
        waitAt = (<<0, 0, 0>>)
        /\
        runTask = (<<t1, t1, t1>>)
        /\
        taskState = ((t1 :> "running"))
        /\
        runPayload = (<<1, 0, 0>>)
        /\
        lastAction = ("Activate")
        /\
        eventState = ((e1 :> 1))
        /\
        availableAt = (<<0, 0, 0>>)
        /\
        now = (0)
        /\
        attempts = ((t1 :> 0))
        /\
        policy = ((t1 :> "none"))
        /\
        waitEv = (<<"none", "none", "none">>)
        /\
        relaunchCount = (<<0, 0, 0>>)
        /\
        nextCtx = (3)
        /\
        cancelAt = ((t1 :> 5))
        /\
        activatedGen = (<<2, 0, 0>>)
        /\
        wakeEvent = (<<e1, "none", "none">>)
        /\
        leaseDeadline = (<<2, 0, 0>>)
        /\
        infraRetries = ((t1 :> 0))
        /\
        runAttempt = (<<1, 0, 0>>)
        /\
        hops = ((t1 :> 1))
        /\
        runState = (<<"running", "unused", "unused">>)
    )
----

_init ==
    /\ eventState = _TETrace[1].eventState
    /\ infraRetries = _TETrace[1].infraRetries
    /\ relaunchCount = _TETrace[1].relaunchCount
    /\ attempts = _TETrace[1].attempts
    /\ runTask = _TETrace[1].runTask
    /\ availableAt = _TETrace[1].availableAt
    /\ claimGen = _TETrace[1].claimGen
    /\ now = _TETrace[1].now
    /\ runState = _TETrace[1].runState
    /\ hops = _TETrace[1].hops
    /\ activatedGen = _TETrace[1].activatedGen
    /\ taskState = _TETrace[1].taskState
    /\ channel = _TETrace[1].channel
    /\ lastAction = _TETrace[1].lastAction
    /\ leaseDeadline = _TETrace[1].leaseDeadline
    /\ lastCtx = _TETrace[1].lastCtx
    /\ waitAt = _TETrace[1].waitAt
    /\ runPayload = _TETrace[1].runPayload
    /\ cancelAt = _TETrace[1].cancelAt
    /\ nextRun = _TETrace[1].nextRun
    /\ runAttempt = _TETrace[1].runAttempt
    /\ policy = _TETrace[1].policy
    /\ waitEv = _TETrace[1].waitEv
    /\ firstStarted = _TETrace[1].firstStarted
    /\ nextCtx = _TETrace[1].nextCtx
    /\ contexts = _TETrace[1].contexts
    /\ wakeEvent = _TETrace[1].wakeEvent
----

_next ==
    /\ \E i,j \in DOMAIN _TETrace:
        /\ \/ /\ j = i + 1
              /\ i = TLCGet("level")
        /\ eventState  = _TETrace[i].eventState
        /\ eventState' = _TETrace[j].eventState
        /\ infraRetries  = _TETrace[i].infraRetries
        /\ infraRetries' = _TETrace[j].infraRetries
        /\ relaunchCount  = _TETrace[i].relaunchCount
        /\ relaunchCount' = _TETrace[j].relaunchCount
        /\ attempts  = _TETrace[i].attempts
        /\ attempts' = _TETrace[j].attempts
        /\ runTask  = _TETrace[i].runTask
        /\ runTask' = _TETrace[j].runTask
        /\ availableAt  = _TETrace[i].availableAt
        /\ availableAt' = _TETrace[j].availableAt
        /\ claimGen  = _TETrace[i].claimGen
        /\ claimGen' = _TETrace[j].claimGen
        /\ now  = _TETrace[i].now
        /\ now' = _TETrace[j].now
        /\ runState  = _TETrace[i].runState
        /\ runState' = _TETrace[j].runState
        /\ hops  = _TETrace[i].hops
        /\ hops' = _TETrace[j].hops
        /\ activatedGen  = _TETrace[i].activatedGen
        /\ activatedGen' = _TETrace[j].activatedGen
        /\ taskState  = _TETrace[i].taskState
        /\ taskState' = _TETrace[j].taskState
        /\ channel  = _TETrace[i].channel
        /\ channel' = _TETrace[j].channel
        /\ lastAction  = _TETrace[i].lastAction
        /\ lastAction' = _TETrace[j].lastAction
        /\ leaseDeadline  = _TETrace[i].leaseDeadline
        /\ leaseDeadline' = _TETrace[j].leaseDeadline
        /\ lastCtx  = _TETrace[i].lastCtx
        /\ lastCtx' = _TETrace[j].lastCtx
        /\ waitAt  = _TETrace[i].waitAt
        /\ waitAt' = _TETrace[j].waitAt
        /\ runPayload  = _TETrace[i].runPayload
        /\ runPayload' = _TETrace[j].runPayload
        /\ cancelAt  = _TETrace[i].cancelAt
        /\ cancelAt' = _TETrace[j].cancelAt
        /\ nextRun  = _TETrace[i].nextRun
        /\ nextRun' = _TETrace[j].nextRun
        /\ runAttempt  = _TETrace[i].runAttempt
        /\ runAttempt' = _TETrace[j].runAttempt
        /\ policy  = _TETrace[i].policy
        /\ policy' = _TETrace[j].policy
        /\ waitEv  = _TETrace[i].waitEv
        /\ waitEv' = _TETrace[j].waitEv
        /\ firstStarted  = _TETrace[i].firstStarted
        /\ firstStarted' = _TETrace[j].firstStarted
        /\ nextCtx  = _TETrace[i].nextCtx
        /\ nextCtx' = _TETrace[j].nextCtx
        /\ contexts  = _TETrace[i].contexts
        /\ contexts' = _TETrace[j].contexts
        /\ wakeEvent  = _TETrace[i].wakeEvent
        /\ wakeEvent' = _TETrace[j].wakeEvent

\* Uncomment the ASSUME below to write the states of the error trace
\* to the given file in Json format. Note that you can pass any tuple
\* to `JsonSerialize`. For example, a sub-sequence of _TETrace.
    \* ASSUME
    \*     LET J == INSTANCE Json
    \*         IN J!JsonSerialize("Probes_TTrace_1784623817.json", _TETrace)

=============================================================================

 Note that you can extract this module `Probes_TEExpression`
  to a dedicated file to reuse `expression` (the module in the 
  dedicated `Probes_TEExpression.tla` file takes precedence 
  over the module `Probes_TEExpression` below).

---- MODULE Probes_TEExpression ----
EXTENDS Sequences, TLCExt, Toolbox, Naturals, TLC, Probes_TEConstants, Probes

expression == 
    [
        \* To hide variables of the `Probes` spec from the error trace,
        \* remove the variables below.  The trace will be written in the order
        \* of the fields of this record.
        eventState |-> eventState
        ,infraRetries |-> infraRetries
        ,relaunchCount |-> relaunchCount
        ,attempts |-> attempts
        ,runTask |-> runTask
        ,availableAt |-> availableAt
        ,claimGen |-> claimGen
        ,now |-> now
        ,runState |-> runState
        ,hops |-> hops
        ,activatedGen |-> activatedGen
        ,taskState |-> taskState
        ,channel |-> channel
        ,lastAction |-> lastAction
        ,leaseDeadline |-> leaseDeadline
        ,lastCtx |-> lastCtx
        ,waitAt |-> waitAt
        ,runPayload |-> runPayload
        ,cancelAt |-> cancelAt
        ,nextRun |-> nextRun
        ,runAttempt |-> runAttempt
        ,policy |-> policy
        ,waitEv |-> waitEv
        ,firstStarted |-> firstStarted
        ,nextCtx |-> nextCtx
        ,contexts |-> contexts
        ,wakeEvent |-> wakeEvent
        
        \* Put additional constant-, state-, and action-level expressions here:
        \* ,_stateNumber |-> _TEPosition
        \* ,_eventStateUnchanged |-> eventState = eventState'
        
        \* Format the `eventState` variable as Json value.
        \* ,_eventStateJson |->
        \*     LET J == INSTANCE Json
        \*     IN J!ToJson(eventState)
        
        \* Lastly, you may build expressions over arbitrary sets of states by
        \* leveraging the _TETrace operator.  For example, this is how to
        \* count the number of times a spec variable changed up to the current
        \* state in the trace.
        \* ,_eventStateModCount |->
        \*     LET F[s \in DOMAIN _TETrace] ==
        \*         IF s = 1 THEN 0
        \*         ELSE IF _TETrace[s].eventState # _TETrace[s-1].eventState
        \*             THEN 1 + F[s-1] ELSE F[s-1]
        \*     IN F[_TEPosition - 1]
    ]

=============================================================================



Parsing and semantic processing can take forever if the trace below is long.
 In this case, it is advised to uncomment the module below to deserialize the
 trace from a generated binary file.

\*
\*---- MODULE Probes_TETrace ----
\*EXTENDS IOUtils, TLC, Probes_TEConstants, Probes
\*
\*trace == IODeserialize("Probes_TTrace_1784623817.bin", TRUE)
\*
\*=============================================================================
\*

---- MODULE Probes_TETrace ----
EXTENDS TLC, Probes_TEConstants, Probes

trace == 
    <<
    ([lastCtx |-> [run |-> 0, gen |-> 0],claimGen |-> <<0, 0, 0>>,firstStarted |-> (t1 :> 5),channel |-> {},contexts |-> {},nextRun |-> 1,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "unused"),runPayload |-> <<0, 0, 0>>,lastAction |-> "Init",eventState |-> (e1 :> 0),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 1,cancelAt |-> (t1 :> 5),activatedGen |-> <<0, 0, 0>>,wakeEvent |-> <<"none", "none", "none">>,leaseDeadline |-> <<0, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<0, 0, 0>>,hops |-> (t1 :> 0),runState |-> <<"unused", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 0, gen |-> 0],claimGen |-> <<0, 0, 0>>,firstStarted |-> (t1 :> 5),channel |-> {},contexts |-> {},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "pending"),runPayload |-> <<0, 0, 0>>,lastAction |-> "Spawn",eventState |-> (e1 :> 0),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 1,cancelAt |-> (t1 :> 5),activatedGen |-> <<0, 0, 0>>,wakeEvent |-> <<"none", "none", "none">>,leaseDeadline |-> <<0, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 0),runState |-> <<"pending", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 0, gen |-> 0],claimGen |-> <<1, 0, 0>>,firstStarted |-> (t1 :> 5),channel |-> {[run |-> 1, gen |-> 1]},contexts |-> {},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "running"),runPayload |-> <<0, 0, 0>>,lastAction |-> "Claim",eventState |-> (e1 :> 0),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 1,cancelAt |-> (t1 :> 5),activatedGen |-> <<0, 0, 0>>,wakeEvent |-> <<"none", "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 0),runState |-> <<"running", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 1, gen |-> 1],claimGen |-> <<1, 0, 0>>,firstStarted |-> (t1 :> 0),channel |-> {[run |-> 1, gen |-> 1]},contexts |-> {[run |-> 1, gen |-> 1, id |-> 1]},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "running"),runPayload |-> <<0, 0, 0>>,lastAction |-> "Activate",eventState |-> (e1 :> 0),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 2,cancelAt |-> (t1 :> 5),activatedGen |-> <<1, 0, 0>>,wakeEvent |-> <<"none", "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 0),runState |-> <<"running", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 1, gen |-> 1],claimGen |-> <<1, 0, 0>>,firstStarted |-> (t1 :> 0),channel |-> {[run |-> 1, gen |-> 1]},contexts |-> {},nextRun |-> 2,waitAt |-> <<1, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "sleeping"),runPayload |-> <<0, 0, 0>>,lastAction |-> "AwaitMiss",eventState |-> (e1 :> 0),availableAt |-> <<1, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<e1, "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 2,cancelAt |-> (t1 :> 5),activatedGen |-> <<1, 0, 0>>,wakeEvent |-> <<e1, "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 1),runState |-> <<"sleeping", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 0, gen |-> 0],claimGen |-> <<1, 0, 0>>,firstStarted |-> (t1 :> 0),channel |-> {[run |-> 1, gen |-> 1]},contexts |-> {},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "pending"),runPayload |-> <<1, 0, 0>>,lastAction |-> "Emit",eventState |-> (e1 :> 1),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 2,cancelAt |-> (t1 :> 5),activatedGen |-> <<1, 0, 0>>,wakeEvent |-> <<e1, "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 1),runState |-> <<"pending", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 0, gen |-> 0],claimGen |-> <<2, 0, 0>>,firstStarted |-> (t1 :> 0),channel |-> {[run |-> 1, gen |-> 1], [run |-> 1, gen |-> 2]},contexts |-> {},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "running"),runPayload |-> <<1, 0, 0>>,lastAction |-> "Claim",eventState |-> (e1 :> 1),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 2,cancelAt |-> (t1 :> 5),activatedGen |-> <<1, 0, 0>>,wakeEvent |-> <<e1, "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 1),runState |-> <<"running", "unused", "unused">>]),
    ([lastCtx |-> [run |-> 1, gen |-> 2],claimGen |-> <<2, 0, 0>>,firstStarted |-> (t1 :> 0),channel |-> {[run |-> 1, gen |-> 1], [run |-> 1, gen |-> 2]},contexts |-> {[run |-> 1, gen |-> 2, id |-> 2]},nextRun |-> 2,waitAt |-> <<0, 0, 0>>,runTask |-> <<t1, t1, t1>>,taskState |-> (t1 :> "running"),runPayload |-> <<1, 0, 0>>,lastAction |-> "Activate",eventState |-> (e1 :> 1),availableAt |-> <<0, 0, 0>>,now |-> 0,attempts |-> (t1 :> 0),policy |-> (t1 :> "none"),waitEv |-> <<"none", "none", "none">>,relaunchCount |-> <<0, 0, 0>>,nextCtx |-> 3,cancelAt |-> (t1 :> 5),activatedGen |-> <<2, 0, 0>>,wakeEvent |-> <<e1, "none", "none">>,leaseDeadline |-> <<2, 0, 0>>,infraRetries |-> (t1 :> 0),runAttempt |-> <<1, 0, 0>>,hops |-> (t1 :> 1),runState |-> <<"running", "unused", "unused">>])
    >>
----


=============================================================================

---- MODULE Probes_TEConstants ----
EXTENDS Probes

CONSTANTS t1, e1

=============================================================================

---- CONFIG Probes_TTrace_1784623817 ----
CONSTANTS
    Tasks = { t1 }
    MaxRuns = 3
    MaxTime = 4
    MaxAttempts = 2
    InfraRetryCap = 1
    RelaunchCap = 1
    MaxHops = 1
    LeaseLen = 2
    SleepDur = 1
    Backoff = 1
    CancelLen = 2
    Events = { e1 }
    t1 = t1
    e1 = e1

INVARIANT
    _inv

CHECK_DEADLOCK
    \* CHECK_DEADLOCK off because of PROPERTY or INVARIANT above.
    FALSE

INIT
    _init

NEXT
    _next

CONSTANT
    _TETrace <- _trace

ALIAS
    _expression
=============================================================================
\* Generated on Tue Jul 21 08:50:18 UTC 2026