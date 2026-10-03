import {
  type RunFacts,
  type TaskFacts,
  type WaitFacts,
  isLiveState,
  isTerminalState,
  taskIdOfDoneEvent,
} from '@durablerun/core'
import { COMMANDS, type CommandSpec } from './commands.js'
import { factsAreReadable, statesNotTheEngines } from './inspect.js'
import { failureReason } from './render.js'

/**
 * Why one task is where it is. `diagnose` reads the facts `inspect` prints and answers one
 * cause from the closed table below, with a verdict and the facts behind it. It is pure: it
 * reads no clock and no store, and database time is one of the facts.
 *
 * A verdict says whether anything is owed to the task, never whether the task did well:
 * a task that failed for good is `ok`, because nothing will move it and nothing should.
 * A verdict is the CLI's reading for an operator, and the engine reads none of it.
 */
export const VERDICTS = ['ok', 'waiting', 'stuck', 'inconsistent', 'unexplained'] as const
export type Verdict = (typeof VERDICTS)[number]

/**
 * How late a move the driver owes may be before the verdict is `stuck`. A run that came
 * due, a lease that lapsed and a cancellation deadline that passed are each the next
 * tick's work, so up to this long after the instant the verdict is `waiting`. It is two
 * periods of the once-a-minute cron tick that backs a serverless deployment (DESIGN.md
 * section 3.1).
 */
export const DUE_GRACE_MS = 120_000

/**
 * How long a first pass may run under a live lease before `explain` names it. A worker
 * whose handler hangs keeps its lease alive, so the lease never lapses and the sweep never
 * takes the run. Nothing is owed to such a run, so the verdict stays `ok`: the cause says
 * the pass is long, and whether to cancel it is the operator's call. Only a run claimed
 * once is held to the bound: its pass began when it started, and no fact says when a later
 * pass of a run began.
 */
export const HUNG_RUN_MS = 3_600_000

/** How many awaits of a child `explain` follows from the task it was asked about. */
export const CHILD_HOPS = 8

/**
 * How a cause gets its verdict: a verdict of its own, `late` (`waiting` until the instant
 * it names is more than DUE_GRACE_MS past, `stuck` from then), or `child` (the verdict of
 * the cause the awaited child was followed to, or of the ring the await closes). No cause
 * may have `stuck` as a verdict of its own. `stuck` means that a move the driver owes is
 * late, which only the `late` rule measures, or that no move can come, which only the
 * `child` rule finds, for a ring of awaits that no clock ends.
 */
type Rule = Exclude<Verdict, 'stuck'> | 'late' | 'child'

interface CauseSpec {
  readonly verdict: Rule
  /** The verb of the command that looks closer or clears the cause, or null for none. */
  readonly next: string | null
  readonly meaning: string
}

/**
 * The closed cause table. DESIGN.md section 3.11 holds the same table, and a test parses
 * both and requires them equal. `unexplained` is what `diagnose` answers when no arm takes
 * the facts, so a state nobody listed is never read as a healthy one.
 */
export const CAUSES = Object.freeze({
  unreadable: {
    verdict: 'inconsistent',
    next: 'inspect',
    meaning:
      "a stored row the decoders refuse, a stored integer outside its bounds, or a stored state that is not the engine's own",
  },
  'terminal-task-with-a-live-run': {
    verdict: 'inconsistent',
    next: 'inspect',
    meaning: 'the task has ended and one of its runs is still live, which no engine path writes',
  },
  completed: { verdict: 'ok', next: 'result', meaning: 'the task completed' },
  cancelled: { verdict: 'ok', next: 'result', meaning: 'the task was cancelled' },
  'failed-by-an-engine-reason': {
    verdict: 'ok',
    next: 'result',
    meaning: 'the engine failed the task, for the reason named',
  },
  'failed-attempts-exhausted': {
    verdict: 'ok',
    next: 'result',
    meaning: "the task's code failed and no attempt of its budget is left",
  },
  'failed-with-no-retry': {
    verdict: 'ok',
    next: 'result',
    meaning: "the task's code failed and its worker asked for no retry, with attempts left",
  },
  'live-task-without-one-live-run': {
    verdict: 'inconsistent',
    next: 'inspect',
    meaning: 'the task is live and does not have exactly one live run',
  },
  'task-and-run-states-differ': {
    verdict: 'inconsistent',
    next: 'inspect',
    meaning: "the task's state is not its live run's state",
  },
  'cancellation-deadline-passed': {
    verdict: 'late',
    next: 'sweep',
    meaning: "the task's cancellation deadline passed, and no sweep has cancelled it",
  },
  'lease-lapsed-unswept': {
    verdict: 'late',
    next: 'sweep',
    meaning: "the run's lease expired, and no sweep has taken the run back",
  },
  'running-past-the-hung-bound': {
    verdict: 'ok',
    next: 'inspect',
    meaning:
      'the run was claimed once and has run under a live lease for longer than the hung-run bound',
  },
  'running-under-a-live-lease': {
    verdict: 'ok',
    next: null,
    meaning: 'the run is claimed under a lease that has not expired',
  },
  'pending-delayed': {
    verdict: 'waiting',
    next: null,
    meaning:
      'the run is pending and not due yet: a start delay holds it, or the backoff after a lost launch or after a lease that ran out',
  },
  'woken-unclaimed': {
    verdict: 'late',
    next: 'tick',
    meaning: 'the run holds a wake from the event named and is due, and no claim has taken it',
  },
  'pending-due-unclaimed': {
    verdict: 'late',
    next: 'tick',
    meaning: 'the run is due, and no claim has taken it',
  },
  'backing-off': {
    verdict: 'waiting',
    next: null,
    meaning:
      'the run follows a failed run and sleeps until its retry delay or its rollback delay has run',
  },
  'never-started': {
    verdict: 'waiting',
    next: null,
    meaning:
      'the run was claimed and parked again before any worker started it, which a worker does for a task name it has no handler for',
  },
  'wait-outlives-its-event': {
    verdict: 'inconsistent',
    next: 'inspect',
    meaning: 'the run waits on an event that exists, which no engine path writes',
  },
  'never-started-alpha1-form': {
    verdict: 'waiting',
    next: null,
    meaning:
      'the run was started and parked on a timer with no checkpoint committed, which the release alpha.1 does for a task name it has no handler for',
  },
  'sleeping-past-its-wake': {
    verdict: 'late',
    next: 'tick',
    meaning:
      "the run's timer, its backoff or its await's timeout has passed, and no claim has taken it",
  },
  'awaiting-a-child': {
    verdict: 'child',
    next: 'inspect',
    meaning: 'the run waits for the child task named to end',
  },
  'awaiting-a-timed-event': {
    verdict: 'waiting',
    next: null,
    meaning: 'the run waits on the event named, until its timeout',
  },
  'awaiting-an-untimed-event': {
    verdict: 'waiting',
    next: null,
    meaning: 'the run waits on the event named, with no timeout',
  },
  'sleeping-on-a-timer': {
    verdict: 'waiting',
    next: null,
    meaning: 'the run sleeps until its timer',
  },
  unexplained: {
    verdict: 'unexplained',
    next: 'inspect',
    meaning: 'no cause of this table takes the facts',
  },
} as const satisfies Record<string, CauseSpec>)

export type Cause = keyof typeof CAUSES

/** What `diagnose` says of one task. */
export interface Diagnosis {
  readonly taskId: string
  readonly cause: Cause
  readonly verdict: Verdict
  /**
   * For a `waiting` verdict, the earliest instant from which a clock lets the engine move
   * the task, or null when no clock does: the instant the run comes due or its await times
   * out, or the task's cancellation deadline when that is ahead and comes first. It is at
   * or before database time when the run is already due and the driver's next tick owes
   * the move. Null for every other verdict.
   */
  readonly nextTransitionAtMs: number | null
  /** Whether the task has ended, which the verdict of a task that waits for it turns on. */
  readonly ended: boolean
  /** The facts behind the cause. None is a value a user wrote. */
  readonly facts: Readonly<Record<string, unknown>>
  /** What the child this task awaits was diagnosed as, when it was followed. */
  readonly child?: Diagnosis
}

/**
 * A ring of awaits: the awaited child is a task already on the way, the task itself among
 * them. A clock ends the ring when any task of it has one that ends its own wait.
 */
export interface Ring {
  readonly ringEndedBy: 'a-clock' | 'nothing'
}

/** What following an awaited child found: its diagnosis, no such task, a hop not taken, or a ring. */
export type ChildEvidence = Diagnosis | 'absent' | 'not-followed' | Ring

/** A task on the way from the one `explain` was asked about to the one it is reading. */
export interface TaskOnTheWay {
  readonly taskId: string
  readonly endsByAClock: boolean
}

/**
 * Whether a clock ends this task's wait, whatever the task it waits for does: the task has
 * a cancellation deadline, at which the sweep cancels it, or its live run has an instant it
 * comes due at, which for a run parked on an await is the await's timeout.
 */
export const endsByAClock = (facts: TaskFacts): boolean =>
  facts.task.cancelAtMs !== null ||
  facts.runs.some((run) => isLiveState(run.state) && run.availableAtMs !== null)

/**
 * The ring an await of `childTaskId` closes, for the task at the end of `path`, or null
 * when that child is not on the path. The ring is the path from that child on.
 */
export function ringClosedBy(path: readonly TaskOnTheWay[], childTaskId: string): Ring | null {
  const from = path.findIndex((one) => one.taskId === childTaskId)
  if (from === -1) return null
  return { ringEndedBy: path.slice(from).some((one) => one.endsByAClock) ? 'a-clock' : 'nothing' }
}

/** What the facts of one task do not hold, which `diagnose` asks for when a cause turns on it. */
export interface Evidence {
  /** How many checkpoints the task has committed, or that their rows could not be read. */
  readonly checkpoints?: number | 'unreadable'
  readonly child?: ChildEvidence
}

/** Evidence `diagnose` needs before it can answer. */
export type Needed =
  | { readonly needs: 'checkpoints' }
  | { readonly needs: 'child'; readonly taskId: string }

interface View {
  readonly facts: TaskFacts
  readonly evidence: Evidence
  /** The task's runs that are in a live state. */
  readonly live: readonly RunFacts[]
}

interface Found {
  readonly cause: Cause
  /** The instant the cause turns on: when the run came due, or when it next may move. */
  readonly at?: number | null
  readonly facts: Readonly<Record<string, unknown>>
}

/** One cause's condition: what it found, the evidence it turns on, or null when it declines. */
type Arm = (view: View) => Found | Needed | null
type RunArm = (view: View, run: RunFacts) => Found | Needed | null

/** An arm that reads a task's one live run, and declines a task that does not have exactly one. */
const ofTheLiveRun =
  (arm: RunArm): Arm =>
  (view) => {
    const [run] = view.live
    return run !== undefined && view.live.length === 1 ? arm(view, run) : null
  }

/** Whether `at` is an instant at or before database time. */
const isPast = ({ facts }: View, at: number | null): at is number =>
  at !== null && facts.nowMs !== null && at <= facts.nowMs

/** Whether `at` is an instant after database time. */
const isAhead = ({ facts }: View, at: number | null): at is number =>
  at !== null && facts.nowMs !== null && at > facts.nowMs

/**
 * What is not readable, named and never quoted: whether the outcome decoded, each corrupt
 * integer by its field and the ids of its row, and the task and each run or wait whose
 * state or status is not the engine's own.
 */
const unreadableArm: Arm = ({ facts }) =>
  factsAreReadable(facts)
    ? null
    : {
        cause: 'unreadable',
        facts: {
          outcome: 'result' in facts.outcome ? 'readable' : 'unreadable',
          corrupt: facts.corrupt.map(({ field, runId, stepName, eventName }) => ({
            field,
            runId,
            stepName,
            eventName,
          })),
          notTheEngines: statesNotTheEngines(facts),
        },
      }

/** A task's state and its live runs, which a cause names when the two do not fit together. */
const liveRuns = ({ facts, live }: View) => ({
  taskState: facts.task.state,
  liveRuns: live.map((run) => run.runId),
})

const liveRunUnderATerminalTaskArm: Arm = (view) =>
  isTerminalState(view.facts.task.state) && view.live.length > 0
    ? { cause: 'terminal-task-with-a-live-run', facts: liveRuns(view) }
    : null

/** A task's attempts and its budget, which every ended task's cause names. */
const budget = ({ task }: TaskFacts) => ({
  attempts: task.attempts,
  maxAttempts: task.maxAttempts,
  infraRetries: task.infraRetries,
})

const completedArm: Arm = ({ facts }) =>
  facts.task.state === 'completed' ? { cause: 'completed', facts: budget(facts) } : null

const cancelledArm: Arm = ({ facts }) =>
  facts.task.state === 'cancelled' ? { cause: 'cancelled', facts: budget(facts) } : null

/** The name of the engine's own reason a failed task holds, or null for a reason its code wrote. */
function engineReason(facts: TaskFacts): string | null {
  if (!('result' in facts.outcome)) return null
  const stored = facts.outcome.result.failureReasonJson
  if (stored === undefined) return null
  const reason = failureReason(stored, false)
  return 'engine' in reason ? reason.engine : null
}

const failedByTheEngineArm: Arm = ({ facts }) => {
  const reason = facts.task.state === 'failed' ? engineReason(facts) : null
  return reason === null
    ? null
    : { cause: 'failed-by-an-engine-reason', facts: { reason, ...budget(facts) } }
}

const attemptsExhaustedArm: Arm = ({ facts }) => {
  const { state, attempts, maxAttempts } = facts.task
  return state === 'failed' && attempts !== null && maxAttempts !== null && attempts >= maxAttempts
    ? { cause: 'failed-attempts-exhausted', facts: budget(facts) }
    : null
}

const failedWithNoRetryArm: Arm = ({ facts }) => {
  const { state, attempts, maxAttempts } = facts.task
  return state === 'failed' && attempts !== null && maxAttempts !== null && attempts < maxAttempts
    ? { cause: 'failed-with-no-retry', facts: budget(facts) }
    : null
}

const notOneLiveRunArm: Arm = (view) =>
  isLiveState(view.facts.task.state) && view.live.length !== 1
    ? { cause: 'live-task-without-one-live-run', facts: liveRuns(view) }
    : null

const statesDifferArm: RunArm = ({ facts }, run) =>
  run.state === facts.task.state
    ? null
    : {
        cause: 'task-and-run-states-differ',
        facts: { taskState: facts.task.state, runId: run.runId, runState: run.state },
      }

const cancellationDeadlinePassedArm: RunArm = (view, run) =>
  isPast(view, view.facts.task.cancelAtMs)
    ? {
        cause: 'cancellation-deadline-passed',
        at: view.facts.task.cancelAtMs,
        facts: {
          runId: run.runId,
          runState: run.state,
          started: view.facts.task.firstStartedAtMs !== null,
        },
      }
    : null

/** Whether a worker started the run under its newest claim. */
const activated = (run: RunFacts): boolean =>
  run.claimGen !== null && run.claimGen > 0 && run.activatedGen === run.claimGen

/** What a cause says of a run that holds a lease. */
const lease = (run: RunFacts) => ({
  runId: run.runId,
  activated: activated(run),
  leaseExpiresAtMs: run.claimExpiresAtMs,
  heartbeatAtMs: run.heartbeatAtMs,
})

const leaseLapsedArm: RunArm = (view, run) =>
  run.state === 'running' && isPast(view, run.claimExpiresAtMs)
    ? { cause: 'lease-lapsed-unswept', at: run.claimExpiresAtMs, facts: lease(run) }
    : null

/** How long a run claimed once has run, or null for a run no fact gives the pass of. */
function firstPassMs({ facts }: View, run: RunFacts): number | null {
  if (run.claimGen !== 1 || !activated(run)) return null
  return run.startedAtMs === null || facts.nowMs === null ? null : facts.nowMs - run.startedAtMs
}

const hungArm: RunArm = (view, run) => {
  const runningForMs = firstPassMs(view, run)
  return run.state === 'running' &&
    isAhead(view, run.claimExpiresAtMs) &&
    runningForMs !== null &&
    runningForMs > HUNG_RUN_MS
    ? {
        cause: 'running-past-the-hung-bound',
        facts: { ...lease(run), startedAtMs: run.startedAtMs, runningForMs },
      }
    : null
}

const liveLeaseArm: RunArm = (view, run) =>
  run.state === 'running' && isAhead(view, run.claimExpiresAtMs)
    ? { cause: 'running-under-a-live-lease', facts: lease(run) }
    : null

const pendingDelayedArm: RunArm = (view, run) =>
  run.state === 'pending' && isAhead(view, run.availableAtMs)
    ? {
        cause: 'pending-delayed',
        at: run.availableAtMs,
        facts: { runId: run.runId, attempt: run.attempt, relaunchCount: run.relaunchCount },
      }
    : null

const wokenUnclaimedArm: RunArm = (view, run) =>
  run.state === 'pending' && isPast(view, run.availableAtMs) && run.wakeEvent !== null
    ? {
        cause: 'woken-unclaimed',
        at: run.availableAtMs,
        facts: { runId: run.runId, event: run.wakeEvent, step: run.wakeStep },
      }
    : null

const dueUnclaimedArm: RunArm = (view, run) =>
  run.state === 'pending' && isPast(view, run.availableAtMs) && run.wakeEvent === null
    ? {
        cause: 'pending-due-unclaimed',
        at: run.availableAtMs,
        facts: { runId: run.runId, attempt: run.attempt, relaunchCount: run.relaunchCount },
      }
    : null

/**
 * A run asleep that no claim has ever taken. Only a failure's successor is inserted asleep:
 * the next attempt of a retry with a delay, or a rollback pass that follows a failed
 * rollback with a delay. Every other sleeping run was parked by the worker that held it.
 */
const asleepSinceItWasInserted = (run: RunFacts): boolean =>
  run.state === 'sleeping' && run.claimGen === 0

const backingOffArm: RunArm = (view, run) =>
  asleepSinceItWasInserted(run) && isAhead(view, run.availableAtMs)
    ? {
        cause: 'backing-off',
        at: run.availableAtMs,
        facts: { runId: run.runId, attempt: run.attempt },
      }
    : null

/** What a never-started cause says of its run: the task name no worker had a handler for. */
const neverStarted = ({ task }: TaskFacts, run: RunFacts) => ({
  runId: run.runId,
  taskName: task.taskName,
  claims: run.claimGen,
})

/**
 * A run that was claimed and parked on a timer before any worker activated it, with no
 * wait registered. The launch deferral writes that, and no other call of a worker in this
 * repository does: the worker activates a run before it runs a line of the task, and the
 * sweep reopens a lost launch as pending. The store's port does not refuse a park from a
 * claim that was never activated, so a caller that is not that worker can write the same
 * row. One that registered a wait is declined here.
 */
const neverStartedArm: RunArm = ({ facts }, run) =>
  run.state === 'sleeping' &&
  run.availableAtMs !== null &&
  run.claimGen !== null &&
  run.activatedGen !== null &&
  run.activatedGen < run.claimGen &&
  !facts.waits.some((wait) => wait.runId === run.runId && wait.status === 'waiting')
    ? { cause: 'never-started', at: run.availableAtMs, facts: neverStarted(facts, run) }
    : null

/**
 * The one wait a sleeping run is parked on: registered by this run for the event and the
 * step the run names, still waiting, and timing out when the run comes due. Undefined when
 * the run names no event, or when no wait or several match, so a run and a wait that
 * disagree are never read as an await.
 */
function registeredWait({ facts }: View, run: RunFacts): WaitFacts | undefined {
  if (run.state !== 'sleeping' || run.wakeEvent === null || !activated(run)) return undefined
  const matching = facts.waits.filter(
    (wait) =>
      wait.runId === run.runId &&
      wait.eventName === run.wakeEvent &&
      (run.wakeStep === null || wait.stepName === run.wakeStep) &&
      wait.status === 'waiting' &&
      wait.timeoutAtMs === run.availableAtMs,
  )
  return matching.length === 1 ? matching[0] : undefined
}

/** What an await's cause says: the run, the event it waits on, and the step that awaits it. */
const awaited = (wait: WaitFacts) => ({
  runId: wait.runId,
  event: wait.eventName,
  step: wait.stepName,
})

const waitOutlivesItsEventArm: RunArm = (view, run) => {
  const wait = registeredWait(view, run)
  const event = view.facts.events.find((one) => one.eventName === wait?.eventName)
  return wait !== undefined && event?.exists === true
    ? {
        cause: 'wait-outlives-its-event',
        facts: { ...awaited(wait), emittedAtMs: event.emittedAtMs },
      }
    : null
}

/** A started run parked on a timer and no event, which a sleep and the alpha.1 deferral both write. */
const onABareTimer = (run: RunFacts): boolean =>
  run.state === 'sleeping' && run.wakeEvent === null && run.availableAtMs !== null && activated(run)

/**
 * The alpha.1 worker starts a run before it looks for the handler, and parks a run it has
 * no handler for with `reschedule`. A sleep parks with its checkpoint, so a started run on
 * a bare timer whose task has committed no checkpoint never ran a step of its code.
 */
const neverStartedAlpha1Arm: RunArm = ({ facts, evidence }, run) => {
  if (!onABareTimer(run)) return null
  if (evidence.checkpoints === undefined) return { needs: 'checkpoints' }
  if (evidence.checkpoints === 'unreadable') {
    return { cause: 'unreadable', facts: { checkpoints: 'unreadable' } }
  }
  return evidence.checkpoints === 0
    ? { cause: 'never-started-alpha1-form', at: run.availableAtMs, facts: neverStarted(facts, run) }
    : null
}

const pastItsWakeArm: RunArm = (view, run) => {
  const wait = registeredWait(view, run)
  const asleep = wait !== undefined || onABareTimer(run) || asleepSinceItWasInserted(run)
  return asleep && isPast(view, run.availableAtMs)
    ? {
        cause: 'sleeping-past-its-wake',
        at: run.availableAtMs,
        facts: { runId: run.runId, event: run.wakeEvent, step: run.wakeStep },
      }
    : null
}

/** What an await's cause says of how far its child was followed, and of a ring, what ends it. */
const followedTo = (child: ChildEvidence) => {
  if (typeof child === 'string') return { followed: child }
  return 'ringEndedBy' in child
    ? { followed: 'ring', ringEndedBy: child.ringEndedBy }
    : { followed: 'followed' }
}

const awaitingAChildArm: RunArm = (view, run) => {
  const { evidence } = view
  const wait = registeredWait(view, run)
  const childTaskId = wait === undefined ? null : taskIdOfDoneEvent(wait.eventName)
  if (wait === undefined || childTaskId === null) return null
  if (evidence.child === undefined) return { needs: 'child', taskId: childTaskId }
  return {
    cause: 'awaiting-a-child',
    at: wait.timeoutAtMs,
    facts: {
      ...awaited(wait),
      childTaskId,
      ...followedTo(evidence.child),
    },
  }
}

const awaitingATimedEventArm: RunArm = (view, run) => {
  const wait = registeredWait(view, run)
  return wait !== undefined && isAhead(view, wait.timeoutAtMs)
    ? { cause: 'awaiting-a-timed-event', at: wait.timeoutAtMs, facts: awaited(wait) }
    : null
}

const awaitingAnUntimedEventArm: RunArm = (view, run) => {
  const wait = registeredWait(view, run)
  return wait !== undefined && wait.timeoutAtMs === null
    ? { cause: 'awaiting-an-untimed-event', facts: awaited(wait) }
    : null
}

const sleepingOnATimerArm: RunArm = (view, run) =>
  onABareTimer(run) && isAhead(view, run.availableAtMs)
    ? { cause: 'sleeping-on-a-timer', at: run.availableAtMs, facts: { runId: run.runId } }
    : null

/**
 * The condition of every cause but `unexplained`, in the table's order, which is the order
 * they are asked in: the first that does not decline is the answer. An arm of a live run is
 * reached only once the arms above it have found the task live with one live run.
 */
export const ARMS: { readonly [C in Exclude<Cause, 'unexplained'>]: Arm } = {
  unreadable: unreadableArm,
  'terminal-task-with-a-live-run': liveRunUnderATerminalTaskArm,
  completed: completedArm,
  cancelled: cancelledArm,
  'failed-by-an-engine-reason': failedByTheEngineArm,
  'failed-attempts-exhausted': attemptsExhaustedArm,
  'failed-with-no-retry': failedWithNoRetryArm,
  'live-task-without-one-live-run': notOneLiveRunArm,
  'task-and-run-states-differ': ofTheLiveRun(statesDifferArm),
  'cancellation-deadline-passed': ofTheLiveRun(cancellationDeadlinePassedArm),
  'lease-lapsed-unswept': ofTheLiveRun(leaseLapsedArm),
  'running-past-the-hung-bound': ofTheLiveRun(hungArm),
  'running-under-a-live-lease': ofTheLiveRun(liveLeaseArm),
  'pending-delayed': ofTheLiveRun(pendingDelayedArm),
  'woken-unclaimed': ofTheLiveRun(wokenUnclaimedArm),
  'pending-due-unclaimed': ofTheLiveRun(dueUnclaimedArm),
  'backing-off': ofTheLiveRun(backingOffArm),
  'never-started': ofTheLiveRun(neverStartedArm),
  'wait-outlives-its-event': ofTheLiveRun(waitOutlivesItsEventArm),
  'never-started-alpha1-form': ofTheLiveRun(neverStartedAlpha1Arm),
  'sleeping-past-its-wake': ofTheLiveRun(pastItsWakeArm),
  'awaiting-a-child': ofTheLiveRun(awaitingAChildArm),
  'awaiting-a-timed-event': ofTheLiveRun(awaitingATimedEventArm),
  'awaiting-an-untimed-event': ofTheLiveRun(awaitingAnUntimedEventArm),
  'sleeping-on-a-timer': ofTheLiveRun(sleepingOnATimerArm),
}

/** What the first arm that takes the facts found, or null when every arm declines. */
function firstFound(view: View): Found | Needed | null {
  for (const arm of Object.values(ARMS)) {
    const found = arm(view)
    if (found !== null) return found
  }
  return null
}

/**
 * The verdict of a task that awaits a child. A child that is waiting, stuck, inconsistent
 * or unexplained gives its verdict to the task that waits for it. A child that is `ok` and
 * has not ended makes it `waiting`, whatever that child's cause is called: an `ok` task
 * that has not ended is one a worker is running. A child that has ended would have woken
 * the run in the batch that ended it, so a run still parked on it is `unexplained`, as is
 * a child the queue does not hold and a child that was not followed. Tasks that wait on
 * each other in a ring, or a task that waits on itself, are `waiting` when a clock of some
 * task of the ring ends its wait, and `stuck` when none does: no move can come to them.
 */
function verdictThrough(child: ChildEvidence | undefined): Verdict {
  if (child === undefined || typeof child === 'string') return 'unexplained'
  if ('ringEndedBy' in child) return child.ringEndedBy === 'nothing' ? 'stuck' : 'waiting'
  if (child.verdict !== 'ok') return child.verdict
  return child.ended ? 'unexplained' : 'waiting'
}

/** The verdict a cause's rule gives, for a cause that is `lateMs` past the instant it names. */
function verdictOf(rule: Rule, lateMs: number | null, child: ChildEvidence | undefined): Verdict {
  if (rule === 'child') return verdictThrough(child)
  if (rule !== 'late') return rule
  return lateMs !== null && lateMs > DUE_GRACE_MS ? 'stuck' : 'waiting'
}

/**
 * One cause for one task, from its facts and whatever evidence was gathered for it, or the
 * evidence a cause turns on and was not given. A caller answers a request and asks again.
 * The answer for facts no arm takes is `unexplained`.
 */
export function diagnose(facts: TaskFacts, evidence: Evidence = {}): Diagnosis | Needed {
  const view: View = { facts, evidence, live: facts.runs.filter((run) => isLiveState(run.state)) }
  const found: Found | Needed = firstFound(view) ?? {
    cause: 'unexplained',
    facts: liveRuns(view),
  }
  if ('needs' in found) return found
  const at = found.at ?? null
  const lateMs = at === null || facts.nowMs === null ? null : facts.nowMs - at
  const rule: Rule = CAUSES[found.cause].verdict
  const verdict = verdictOf(rule, lateMs, evidence.child)
  // A live task's cancellation deadline is a fact of every cause, and a clock of its own:
  // at it the sweep cancels the task, whatever its run waits for.
  const cancelAtMs = isLiveState(facts.task.state) ? facts.task.cancelAtMs : null
  const next = earlier(at, isAhead(view, cancelAtMs) ? cancelAtMs : null)
  return {
    taskId: facts.task.taskId,
    cause: found.cause,
    verdict,
    nextTransitionAtMs: verdict === 'waiting' ? next : null,
    ended: isTerminalState(facts.task.state),
    facts: {
      ...found.facts,
      ...(rule === 'late' ? { dueAtMs: at, lateByMs: lateMs } : {}),
      ...(cancelAtMs === null ? {} : { cancelAtMs }),
    },
    ...(rule === 'child' && typeof evidence.child === 'object' && 'cause' in evidence.child
      ? { child: evidence.child }
      : {}),
  }
}

/** The earlier of two instants, either of which may be absent. */
function earlier(one: number | null, other: number | null): number | null {
  if (one === null || other === null) return one ?? other
  return Math.min(one, other)
}

/** The diagnosis at the end of a chain of awaited children: the task's own when it awaits none. */
function deepest(diagnosis: Diagnosis): Diagnosis {
  return diagnosis.child === undefined ? diagnosis : deepest(diagnosis.child)
}

/** Why a next command was not built: what its command requires that `explain` has no value for. */
export interface Withheld {
  readonly withheld: string
}

const noValueFor = (what: string, spec: CommandSpec): Withheld => ({
  withheld: `explain knows no value for ${what} of ${spec.verb}`,
})

/**
 * The next command for a diagnosis, as arguments the command table parses. It is built
 * from the table: the verb the cause names, each of that command's arguments, and each
 * flag it requires, filled from the queue and the task the command is for. A required flag
 * and its value are one argument, `--queue=<value>`, so a value that begins with a dash is
 * still read as the flag's value. No flag that is not required is ever added, so no
 * suggestion confirms a write.
 *
 * The answer is null when no command is owed or known: a `waiting` verdict owes none, and
 * a verb the table does not hold gives none, so a cause whose command a later build adds
 * prints nothing until the verb joins the table. When the command requires an argument or
 * a flag that `explain` has no value for, the answer says which and builds nothing: a
 * command line with a hole in it is worse than none, and the diagnosis stands without it.
 */
export function suggestion(
  { cause, verdict, taskId }: Pick<Diagnosis, 'cause' | 'verdict' | 'taskId'>,
  queue: string,
  commands: Readonly<Record<string, CommandSpec>> = COMMANDS,
): readonly string[] | Withheld | null {
  const verb = CAUSES[cause].next
  const spec = verb === null ? undefined : commands[verb]
  if (spec === undefined || verdict === 'waiting') return null
  const known: Readonly<Record<string, string>> = { taskId, queue }
  const argv: string[] = [spec.verb]
  for (const name of spec.positionals) {
    const value = known[name]
    if (value === undefined) return noValueFor(`<${name}>`, spec)
    argv.push(value)
  }
  for (const [name, flag] of Object.entries(spec.flags)) {
    if (flag.required !== true) continue
    const value = known[name]
    if (value === undefined) return noValueFor(`--${name}`, spec)
    argv.push(`--${name}=${value}`)
  }
  return argv
}

/** A word a POSIX shell reads back as itself with no quoting. */
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/

/** One argument as a POSIX shell reads it back: bare when it is plain, single-quoted otherwise. */
const shellWord = (word: string): string =>
  PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/** A suggestion as one line an operator can paste. */
export const pastedLine = (argv: readonly string[]): string =>
  `pnpm cli ${argv.map(shellWord).join(' ')}`

/** What `explain` prints of a diagnosis, and of each child it followed, under `awaits`. */
function diagnosisView(diagnosis: Diagnosis): Record<string, unknown> {
  return {
    taskId: diagnosis.taskId,
    cause: diagnosis.cause,
    verdict: diagnosis.verdict,
    meaning: CAUSES[diagnosis.cause].meaning,
    nextTransitionAtMs: diagnosis.nextTransitionAtMs,
    facts: diagnosis.facts,
    ...(diagnosis.child === undefined ? {} : { awaits: diagnosisView(diagnosis.child) }),
  }
}

/** The next command as `explain` prints it, or none, with the reason when one was withheld. */
function nextView(next: ReturnType<typeof suggestion>): Record<string, unknown> {
  if (next === null) return { next: null }
  if ('withheld' in next) return { next: null, nextWithheld: next.withheld }
  return { next: { argv: next, command: pastedLine(next) } }
}

/**
 * What `explain` prints of the task it was asked about: its diagnosis, the cause at the end
 * of the awaits that were followed, when one was, and the next command, which is the one
 * for that last task.
 */
export function answerView(
  diagnosis: Diagnosis,
  queue: string,
  commands: Readonly<Record<string, CommandSpec>> = COMMANDS,
): Record<string, unknown> {
  const last = deepest(diagnosis)
  return {
    ...diagnosisView(diagnosis),
    ...(last === diagnosis
      ? {}
      : { deepest: { taskId: last.taskId, cause: last.cause, verdict: last.verdict } }),
    ...nextView(suggestion(last, queue, commands)),
  }
}

/** Whether any task of the chain was read from a row that is not readable. */
export function readUnreadableRow(diagnosis: Diagnosis): boolean {
  return (
    diagnosis.cause === 'unreadable' ||
    (diagnosis.child !== undefined && readUnreadableRow(diagnosis.child))
  )
}
