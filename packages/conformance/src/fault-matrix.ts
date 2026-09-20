import {
  INFRA_RETRY_CAP,
  REASON_INFRA_CAP,
  REASON_RELAUNCH_CAP,
  RELAUNCH_CAP,
  SAGA_PHASE_CHECKPOINT,
  SAGA_ROLLBACK_PREFIX,
  SAGA_STARTED_PREFIX,
  type SqlExecutor,
  taskDoneEventName,
} from '@durablerun/core'
import { SimWorld } from '@durablerun/harness'
import type { StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'
import { sagaViolations } from './saga-rows.js'
import { awaitTaskOwned } from './scenario.js'

const Q = 'q'

/**
 * The per-tick claim bound the matrix asserts as a QUANTITY invariant (the
 * one state checkers cannot see). One definition: the workload claims at
 * this limit and the post-run check forbids any tick holding more — a
 * hardcoded copy in the assertion is exactly how a raised limit would
 * silently turn the bound wrong.
 */
const CLAIM_LIMIT = 2

/**
 * The label inventory, classified. The store-libsql label-inventory test
 * asserts (via the same harvester the spec ledger uses) that every batch
 * label in the store source appears in exactly one of these lists — a new
 * label fails the build until it is classified, and classification into
 * WRITE or READ automatically enrolls it in the full fault matrix below.
 *
 * Why: fault coverage used to be curated by suspicion, and
 * the one case nobody suspected — a duplicated claim — violated the claim
 * bound for four review cycles. A machine enumerating label x fault cannot
 * skip the case nobody suspected.
 */
export const MATRIX_WRITE_LABELS = [
  'driver-heartbeat',
  'spawn',
  'claim',
  'activate',
  'heartbeat',
  'reschedule',
  'defer-launch',
  'suspend',
  'emit-event',
  'await-event',
  'record-task-done',
  'complete',
  'fail',
  'fail-rollback',
  'cancel-task',
  'retry-task',
  'expire-lease-now',
  'set-checkpoint',
  'sweep:cancel',
  'sweep:lost-launch',
  'sweep:claim-timeout',
] as const

/**
 * The write labels whose batch can end a task (specs/ChildTasks.tla's ledger block).
 * Each owes the task's parent its completion event and the wake of every waiter. The
 * child-task conformance surface generates its terminal cases from this list, and the
 * poison matrix lets exactly these labels insert a completion event.
 */
export const TERMINAL_BATCH_LABELS = [
  'complete',
  'fail',
  'fail-rollback',
  'cancel-task',
  'sweep:cancel',
  'sweep:lost-launch',
  'sweep:claim-timeout',
] as const satisfies readonly (typeof MATRIX_WRITE_LABELS)[number][]

export const MATRIX_READ_LABELS = [
  'claimed-task-name',
  'refusal-state',
  'run-task',
  'rollback-tries',
  'task-done-state',
  'sweep:scan',
  'get-checkpoints',
  'task-result',
  'next-wake',
] as const

/** Fixture plumbing that runs outside any simulated actor. */
export const MATRIX_EXEMPT_LABELS = [
  'migrate:bootstrap',
  'migrate:version',
  'admin:set-fake-now',
  'admin:clear-fake-now',
  'admin:now',
] as const

export type MatrixFault = 'crash-before' | 'crash-after' | 'duplicate'

/**
 * The second axis: what state the database is ALREADY in when the fault
 * fires.
 *
 * Faults alone were not enough. The matrix injected a duplicate at
 * `sweep:claim-timeout` and stayed green for months, while replaying that
 * exact batch one retry below the infrastructure cap terminalized a task and
 * left its successor run live. The bug was never reached because the one
 * canonical workload starts every run from zero and never visits a cap
 * boundary — the matrix varied the fault and held the pre-state fixed.
 *
 * Each edge below seeds a task sitting exactly one transition below a cap,
 * in a state the engine itself could have produced, and lets the workload
 * cross it while the fault is armed. The offsets are computed from the
 * contract constants, so raising a cap moves the edge instead of silently
 * aiming the test at the middle of the range.
 *
 * Unlike the label axis this list cannot be harvested from source — a
 * boundary is a property of the protocol, not a string in a file. It is
 * therefore curated, and every cap the engine enforces belongs in it.
 */
export const MATRIX_PRE_STATES = [
  'fresh',
  'infra-cap-edge',
  'relaunch-cap-edge',
  'attempt-cap-edge',
  'saga-cap-edges',
] as const
export type MatrixPreState = (typeof MATRIX_PRE_STATES)[number]

/** The seeded edge task's run, when the pre-state has one. */
const EDGE_TASK = 'edge-task'
const EDGE_RUN = 'edge-run'
const EDGE_TOKEN = 'edge-worker'
const EDGE_MAX_ATTEMPTS = 2
const EDGE_CLAIM_GEN = 3

/**
 * Writes the edge population directly. The engine's fences exist to make
 * these states expensive to reach through the API — driving twenty
 * infrastructure retries per matrix cell would dominate the suite's runtime
 * — so the rows are written as the engine would have left them. Every seed
 * satisfies the accounting identity the invariant library checks
 * (`attempts + infra_retries` equals the top run ordinal, less one while a
 * successor is still due), so a seeded cell that fails is failing on the
 * transition under test and not on its own setup.
 */
/**
 * Three tasks, each with a registered step that started, and each standing AT the cap
 * one of the three batches that decide a terminal failure enforces: the user attempt
 * budget, the infrastructure retry cap, and the relaunch cap. Crossing it enters the
 * rolling-back phase (Sagas.tla's UserTerminal and InfraCap). Each batch has its own
 * label, so one starting state puts the armed fault on all three crossings. Each run has
 * its own claim token, so an untouched seed stays inside the claim bound.
 */
const SAGA_EDGE_BOOM = '{"name":"SagaEdgeBoom"}'
const SAGA_EDGES = [
  {
    key: 'attempt',
    label: 'fail',
    cause: SAGA_EDGE_BOOM,
    attempts: EDGE_MAX_ATTEMPTS - 1,
    infraRetries: 0,
    attempt: EDGE_MAX_ATTEMPTS,
    activated: true,
    relaunchCount: 0,
    expired: false,
  },
  {
    key: 'infra',
    label: 'sweep:claim-timeout',
    cause: REASON_INFRA_CAP,
    attempts: 0,
    infraRetries: INFRA_RETRY_CAP,
    attempt: INFRA_RETRY_CAP + 1,
    activated: true,
    relaunchCount: 0,
    expired: true,
  },
  {
    key: 'relaunch',
    label: 'sweep:lost-launch',
    cause: REASON_RELAUNCH_CAP,
    attempts: 0,
    infraRetries: 0,
    attempt: 1,
    activated: false,
    relaunchCount: RELAUNCH_CAP,
    expired: true,
  },
] as const
type SagaEdge = (typeof SAGA_EDGES)[number]
const sagaEdgeTask = (edge: SagaEdge) => `saga-edge-${edge.key}`
const sagaEdgeRun = (edge: SagaEdge) => `saga-edge-${edge.key}-run`
const sagaEdgeToken = (edge: SagaEdge) => `saga-edge-${edge.key}-worker`
const SAGA_EDGE_STEP = 'edge'

function sagaEdgeSeed(nowMs: number) {
  return SAGA_EDGES.flatMap((edge) => [
    {
      sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
              state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
            VALUES (?, ?, 'saga-edge', '{}', '{"kind":"none"}', ?, 'running', ?, ?, ?, ?)`,
      args: [
        sagaEdgeTask(edge),
        Q,
        EDGE_MAX_ATTEMPTS,
        edge.attempts,
        edge.infraRetries,
        nowMs,
        nowMs,
      ],
    },
    {
      sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by, claim_gen,
              activated_gen, relaunch_count, lease_ms, claim_expires_at_ms, created_at_ms)
            VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 30000, ?, ?)`,
      args: [
        sagaEdgeRun(edge),
        Q,
        sagaEdgeTask(edge),
        edge.attempt,
        sagaEdgeToken(edge),
        EDGE_CLAIM_GEN,
        edge.activated ? EDGE_CLAIM_GEN : EDGE_CLAIM_GEN - 1,
        edge.relaunchCount,
        edge.expired ? nowMs - 1 : nowMs + 60_000,
        nowMs,
      ],
    },
    {
      // The step started under this run: a launch that was lost at this claim
      // generation was activated at an earlier one.
      sql: `INSERT INTO checkpoints (task_id, checkpoint_name, queue, state, status,
              owner_run_id, owner_attempt, updated_at_ms)
            VALUES (?, ?, ?, '1', 'committed', ?, ?, ?)`,
      args: [
        sagaEdgeTask(edge),
        `${SAGA_STARTED_PREFIX}${SAGA_EDGE_STEP}`,
        Q,
        sagaEdgeRun(edge),
        edge.attempt,
        nowMs,
      ],
    },
  ])
}

/**
 * Each saga edge is exactly where it was seeded, exactly inside the phase, or exactly
 * ended, and never between. An edge whose crossing reached the database entered the
 * phase, and when no crash cut the workload's saga prefix short, every edge ended with
 * its rollback run.
 */
async function assertSagaEdges(
  raw: SqlExecutor,
  trace: readonly { label: string; outcome: string }[],
  cell: string,
): Promise<void> {
  const crashed = (outcome: string) => outcome === 'crash-before' || outcome === 'crash-after'
  const firstCrash = trace.findIndex(({ outcome }) => crashed(outcome))
  const firstSpawn = trace.findIndex(({ label }) => label === 'spawn')
  const prefixRan = firstSpawn !== -1 && (firstCrash === -1 || firstCrash >= firstSpawn)
  for (const edge of SAGA_EDGES) {
    const exact = (condition: boolean, detail: string): void => {
      if (!condition) {
        throw new Error(`matrix ${cell}: saga edge '${edge.key}' is not exact: ${detail}`)
      }
    }
    const crossing = trace.find(({ label }) => label === edge.label)?.outcome
    const reached = crossing === 'ok' || crossing === 'dup' || crossing === 'crash-after'
    const [tasks, runs, checkpoints, events] = await raw.batch(
      'matrix:saga-edge-postcondition',
      [
        {
          sql: `SELECT state, attempts, max_attempts, infra_retries, failure_reason
                FROM tasks WHERE task_id = ?`,
          args: [sagaEdgeTask(edge)],
        },
        {
          sql: 'SELECT run_id, attempt, state FROM runs WHERE task_id = ? ORDER BY attempt, run_id',
          args: [sagaEdgeTask(edge)],
        },
        {
          sql: 'SELECT checkpoint_name, state FROM checkpoints WHERE task_id = ?',
          args: [sagaEdgeTask(edge)],
        },
        {
          sql: 'SELECT COUNT(*) AS n FROM events WHERE queue = ? AND event_name = ?',
          args: [Q, taskDoneEventName(sagaEdgeTask(edge))],
        },
      ],
      'read',
    )
    const task = tasks?.rows[0]
    const rows = runs?.rows ?? []
    const named = (name: string) =>
      (checkpoints?.rows ?? []).find((row) => row.checkpoint_name === name)
    const doneEvents = Number(events?.rows[0]?.n)
    const marker = named(SAGA_PHASE_CHECKPOINT)
    const rolledBack = named(`${SAGA_ROLLBACK_PREFIX}${SAGA_EDGE_STEP}`) !== undefined
    if (marker === undefined) {
      exact(!reached, 'its crossing reached the database and wrote no phase marker')
      exact(
        task?.state === 'running' &&
          rows.length === 1 &&
          rows[0]?.state === 'running' &&
          !rolledBack &&
          doneEvents === 0,
        'neither seeded nor in the phase',
      )
      continue
    }
    const [failed, pass] = rows
    const userAttempts = edge.attempt - edge.infraRetries
    exact(marker.state === edge.cause, 'the phase marker does not hold the deciding failure')
    exact(
      rows.length === 2 &&
        failed?.run_id === sagaEdgeRun(edge) &&
        failed?.state === 'failed' &&
        Number(pass?.attempt) === edge.attempt + 1,
      'the rollback pass is not the one successor of the failed run',
    )
    // The pass is one ordinal past the user budget, so entering raises the budget to the
    // pass's own ordinal. The pass that ends the task charges that ordinal, as any
    // failing run charges its own, so an ended saga reads one attempt more than at entry.
    const ended = task?.state === 'failed'
    exact(
      Number(task?.attempts) === userAttempts + (ended ? 1 : 0) &&
        Number(task?.max_attempts) === userAttempts + 1 &&
        Number(task?.infra_retries) === edge.infraRetries,
      `task bookkeeping ${ended ? 'after the saga ended' : 'inside the phase'}`,
    )
    if (ended) {
      exact(
        task?.failure_reason === edge.cause &&
          pass?.state === 'failed' &&
          rolledBack &&
          doneEvents === 1,
        'ended, but not with its rollback run, its deciding failure, and one completion event',
      )
    } else {
      exact(!prefixRan, 'the saga prefix ran to its end and the task did not end')
      exact(
        (pass?.state === 'pending' || pass?.state === 'running') &&
          task?.state === pass.state &&
          doneEvents === 0,
        'inside the phase, but the task does not mirror a live pass, or an event was written',
      )
    }
  }
}

async function seedPreState(raw: SqlExecutor, preState: MatrixPreState, nowMs: number) {
  if (preState === 'fresh') return
  if (preState === 'saga-cap-edges') {
    await raw.batch('setup', sagaEdgeSeed(nowMs), 'write')
    return
  }
  const task = (attempts: number, infraRetries: number) => ({
    sql: `INSERT INTO tasks (task_id, queue, task_name, params, retry_strategy, max_attempts,
            state, attempts, infra_retries, enqueue_at_ms, created_at_ms)
          VALUES (?, ?, 'edge', '{}', '{"kind":"none"}', ?, 'running', ?, ?, ?, ?)`,
    args: [EDGE_TASK, Q, EDGE_MAX_ATTEMPTS, attempts, infraRetries, nowMs, nowMs],
  })
  const run = (attempt: number, activatedGen: number, relaunchCount: number, leaseEnd: number) => ({
    sql: `INSERT INTO runs (run_id, queue, task_id, attempt, state, claimed_by, claim_gen,
            activated_gen, relaunch_count, lease_ms, claim_expires_at_ms, created_at_ms)
          VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 30000, ?, ?)`,
    args: [
      EDGE_RUN,
      Q,
      EDGE_TASK,
      attempt,
      EDGE_TOKEN,
      EDGE_CLAIM_GEN,
      activatedGen,
      relaunchCount,
      leaseEnd,
      nowMs,
    ],
  })
  const expired = nowMs - 1
  const statements = {
    // One infrastructure retry below the cap, activated then died: the
    // workload's sweep crosses the cap via the claim-timeout arm.
    'infra-cap-edge': [
      task(0, INFRA_RETRY_CAP - 1),
      run(INFRA_RETRY_CAP, EDGE_CLAIM_GEN, 0, expired),
    ],
    // One relaunch below the cap, claimed but never activated: the sweep
    // crosses the cap via the lost-launch arm.
    'relaunch-cap-edge': [task(0, 0), run(1, EDGE_CLAIM_GEN - 1, RELAUNCH_CAP - 1, expired)],
    // One user attempt below the cap with a live lease: the workload fails
    // it, and the failure has to refuse the successor rather than retry past
    // the budget the caller asked for.
    'attempt-cap-edge': [
      task(EDGE_MAX_ATTEMPTS - 1, 0),
      run(EDGE_MAX_ATTEMPTS, EDGE_CLAIM_GEN, 0, nowMs + 60_000),
    ],
  }[preState]
  await raw.batch('setup', statements, 'write')
}

const EDGE_TRANSITION: Record<Exclude<MatrixPreState, 'fresh' | 'saga-cap-edges'>, string> = {
  'infra-cap-edge': 'sweep:claim-timeout',
  'relaunch-cap-edge': 'sweep:lost-launch',
  'attempt-cap-edge': 'fail',
}

/**
 * A fired matrix label is only a transport observation. It does not prove the
 * seeded boundary crossed: a legal-looking extra guard can make the edge row
 * a no-op while the same label still transitions ordinary workload rows.
 *
 * Whenever the trace says the edge transition reached the database, pin its
 * complete durable outcome. Crash-before/orphan calls made no write and are
 * deliberately excluded; ok, duplicate, and crash-after calls all owe the
 * same post-state.
 */
async function assertEdgePostcondition(
  raw: SqlExecutor,
  preState: MatrixPreState,
  trace: readonly { label: string; outcome: string }[],
  cell: string,
): Promise<void> {
  if (preState === 'fresh') return
  if (preState === 'saga-cap-edges') return assertSagaEdges(raw, trace, cell)
  const transition = EDGE_TRANSITION[preState]
  const reached = trace.some(
    ({ label, outcome }) =>
      label === transition && (outcome === 'ok' || outcome === 'dup' || outcome === 'crash-after'),
  )
  if (!reached) return

  const [tasks, runs] = await raw.batch(
    'matrix:edge-postcondition',
    [
      {
        sql: `SELECT state, attempts, infra_retries, failure_reason
              FROM tasks WHERE task_id = ?`,
        args: [EDGE_TASK],
      },
      {
        sql: `SELECT run_id, attempt, state, claimed_by, claim_gen, activated_gen,
                     relaunch_count, failure_reason
              FROM runs WHERE task_id = ? ORDER BY attempt, run_id`,
        args: [EDGE_TASK],
      },
    ],
    'read',
  )
  const task = tasks?.rows[0]
  const rows = runs?.rows ?? []
  const exact = (condition: boolean, detail: string): void => {
    if (!condition) throw new Error(`matrix ${cell}: edge did not cross exactly: ${detail}`)
  }

  exact(task !== undefined, 'edge task missing')
  if (preState === 'infra-cap-edge') {
    const parent = rows.find((row) => row.run_id === EDGE_RUN)
    const successor = rows.find((row) => row.run_id !== EDGE_RUN)
    exact(
      task?.state === 'pending' &&
        Number(task?.attempts) === 0 &&
        Number(task?.infra_retries) === INFRA_RETRY_CAP,
      'claim-timeout task bookkeeping',
    )
    exact(rows.length === 2, 'claim-timeout successor cardinality')
    exact(
      parent?.state === 'failed' &&
        Number(parent?.attempt) === INFRA_RETRY_CAP &&
        parent?.claimed_by === null &&
        Number(parent?.claim_gen) === EDGE_CLAIM_GEN &&
        Number(parent?.activated_gen) === EDGE_CLAIM_GEN,
      'claim-timeout parent state',
    )
    exact(
      successor?.state === 'pending' && Number(successor?.attempt) === INFRA_RETRY_CAP + 1,
      'claim-timeout successor state',
    )
    return
  }

  if (preState === 'relaunch-cap-edge') {
    const run = rows[0]
    exact(
      task?.state === 'pending' &&
        Number(task?.attempts) === 0 &&
        Number(task?.infra_retries) === 0,
      'lost-launch task bookkeeping',
    )
    exact(rows.length === 1, 'lost-launch run cardinality')
    exact(
      run?.run_id === EDGE_RUN &&
        run?.state === 'pending' &&
        Number(run?.attempt) === 1 &&
        run?.claimed_by === null &&
        Number(run?.claim_gen) === EDGE_CLAIM_GEN &&
        Number(run?.activated_gen) === EDGE_CLAIM_GEN - 1 &&
        Number(run?.relaunch_count) === RELAUNCH_CAP,
      'lost-launch reopened run state',
    )
    return
  }

  const run = rows[0]
  exact(
    task?.state === 'failed' &&
      Number(task?.attempts) === EDGE_MAX_ATTEMPTS &&
      Number(task?.infra_retries) === 0 &&
      task?.failure_reason === '{"name":"EdgeBoom"}',
    'attempt-cap task terminal state',
  )
  exact(rows.length === 1, 'attempt-cap run cardinality')
  exact(
    run?.run_id === EDGE_RUN &&
      run?.state === 'failed' &&
      Number(run?.attempt) === EDGE_MAX_ATTEMPTS &&
      run?.claimed_by === null &&
      run?.failure_reason === '{"name":"EdgeBoom"}',
    'attempt-cap run terminal state',
  )
}

/**
 * One matrix cell: run the canonical workload with the given fault armed
 * at the given label, then require (1) engine invariants clean, (2) the
 * claim bound held — no token ever owns more running rows than the limit
 * it asked for, (3) the system still makes progress afterward: a fresh
 * task can be driven to completion. strictSpecs means a workload that
 * fails to FIRE the armed label is itself an error — the workload's
 * coverage of the inventory is machine-checked, not assumed.
 */
export async function runFaultMatrixCase(
  makeFixture: StoreFixtureFactory,
  label: string,
  fault: MatrixFault,
  seed: number | string,
  preState: MatrixPreState = 'fresh',
): Promise<void> {
  const cell = `${label}/${fault}/${preState}/${seed}`
  const f = await makeFixture(`matrix-${label}-${fault}-${preState}-${seed}`)
  try {
    let now = 1_000_000
    await f.admin.setFakeNowEpochMs(now)
    await seedPreState(f.raw, preState, now)
    const world = new SimWorld(f.raw, `matrix-${label}-${fault}-${preState}-${seed}`)
    if (fault === 'duplicate') {
      world.injectDuplicate({ label })
    } else {
      world.injectCrash({
        actor: 'driver',
        label,
        when: fault === 'crash-before' ? 'before' : 'after',
      })
    }

    world.actor('driver', async (simDb) => {
      const store = f.storeOver(simDb)
      const admin = f.adminOver(simDb)
      // Every call is fault-tolerant: a crash rejection means "this call's
      // process died" — the workload carries on, like real traffic would.
      const go = async <T>(op: () => Promise<T>): Promise<T | null> => {
        try {
          return await op()
        } catch {
          return null
        }
      }
      await go(() => store.driverHeartbeat(Q, 'matrix-driver', 30))
      // Cross the seeded cap edge FIRST, before the workload creates any
      // other candidate, so the armed fault lands on the crossing itself.
      // Ordering is the whole point here: with the crossing at the end of
      // the workload, the seeded run competes with the workload's own
      // expired runs for a single-occurrence fault, the fault usually lands
      // on one of those instead, and the cell goes green without the
      // boundary ever having been tested — exactly the vacuous coverage
      // this axis exists to remove.
      if (preState === 'saga-cap-edges') {
        // Cross all three caps, then run each rollback pass to its end: one rollback,
        // and the failure with no retry that finishes the saga.
        const [attemptEdge] = SAGA_EDGES
        await go(() =>
          store.fail(Q, sagaEdgeRun(attemptEdge), sagaEdgeToken(attemptEdge), SAGA_EDGE_BOOM, {
            delaySeconds: 0,
          }),
        )
        await go(() => store.sweep(Q, 10))
        for (const worker of ['w-saga-edge-1', 'w-saga-edge-2']) {
          const passes =
            (await go(() => store.claim(Q, worker, { leaseSeconds: 60, limit: CLAIM_LIMIT }))) ?? []
          for (const pass of passes) {
            const edge = SAGA_EDGES.find((candidate) => sagaEdgeTask(candidate) === pass.taskId)
            if (edge === undefined) continue
            await go(() => store.activate(Q, pass.runId, pass.claimToken, pass.claimGen))
            await go(() =>
              store.setCheckpoint(
                Q,
                pass.taskId,
                pass.runId,
                pass.claimToken,
                `${SAGA_ROLLBACK_PREFIX}${SAGA_EDGE_STEP}`,
                'null',
                60,
              ),
            )
            await go(() => store.fail(Q, pass.runId, pass.claimToken, edge.cause, null))
          }
        }
      } else if (preState === 'attempt-cap-edge') {
        await go(() =>
          store.fail(Q, EDGE_RUN, EDGE_TOKEN, '{"name":"EdgeBoom"}', { delaySeconds: 0 }),
        )
      } else if (preState !== 'fresh') {
        await go(() => store.sweep(Q, 10))
      }
      // Spawn a small population: an idempotent pair and a one-attempt task.
      await go(() => store.spawn(Q, 'a', '{}', { idempotencyKey: 'k1' }))
      await go(() => store.spawn(Q, 'a', '{}', { idempotencyKey: 'k1' }))
      const t2 = await go(() => store.spawn(Q, 'b', '{}', { maxAttempts: 1 }))

      // Claim + activate + the worker-side surface.
      const claimed =
        (await go(() => store.claim(Q, 'w1', { leaseSeconds: 60, limit: CLAIM_LIMIT }))) ?? []
      if (claimed.length > CLAIM_LIMIT) throw new Error('claim bound violated in-flight')
      for (const run of claimed) {
        await go(() => store.activate(Q, run.runId, run.claimToken, run.claimGen))
      }
      const [first, second] = claimed
      if (first) {
        await go(() => store.heartbeat(Q, first.runId, first.claimToken, 60))
        await go(() =>
          store.setCheckpoint(Q, first.taskId, first.runId, first.claimToken, 's1', '{"v":1}', 60),
        )
        await go(() => store.getCheckpoints(Q, first.taskId, first.attempt))
        await go(() =>
          store.suspendRun(
            Q,
            first.runId,
            first.claimToken,
            { inSeconds: 1 },
            { key: '$sleep', stateJson: '{"inSeconds":1}' },
          ),
        )
      }
      if (second) {
        await go(() =>
          store.awaitEvent(Q, second.taskId, second.runId, second.claimToken, 'w-ev', 'go', 60),
        )
        await go(() => store.emitEvent(Q, 'go', '{"n":1}'))
        const [woken] =
          (await go(() => store.claim(Q, 'w-ev2', { leaseSeconds: 60, limit: 1 }))) ?? []
        if (woken && woken.runId === second.runId) {
          await go(() => store.activate(Q, woken.runId, woken.claimToken, woken.claimGen))
          await go(() => store.fail(Q, woken.runId, woken.claimToken, '{"name":"X"}', null))
        }
      }
      // A full clean lifecycle: claim, activate, complete.
      await go(() => store.spawn(Q, 'd', '{}'))
      const [fin] = (await go(() => store.claim(Q, 'w1b', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (fin) {
        // The worker reads the claimed task's name before it activates.
        await go(() => store.claimedTaskName(Q, fin.runId, fin.claimToken, fin.claimGen))
        await go(() => store.activate(Q, fin.runId, fin.claimToken, fin.claimGen))
        await go(() => store.complete(Q, fin.runId, fin.claimToken, '{"ok":1}'))
        // A stale replay of that complete is refused and reads why.
        await go(() => store.complete(Q, fin.runId, fin.claimToken, '{"ok":1}'))
      }

      // A parent awaits its child (ChildTasks.tla). The child is claimed and never
      // activated, so its terminal batch has to read the run's task first, and that
      // batch writes the completion event and wakes the parent.
      const parentTask = await go(() => store.spawn(Q, 'parent', '{}'))
      const [parent] =
        (await go(() => store.claim(Q, 'w-parent', { leaseSeconds: 60, limit: 1 }))) ?? []
      const childTask = await go(() => store.spawn(Q, 'child', '{}'))
      if (parentTask && childTask && parent?.taskId === parentTask.taskId) {
        await go(() => store.activate(Q, parent.runId, parent.claimToken, parent.claimGen))
        // An await of no task at all neither registers nor hits, so it reads why.
        await go(() => awaitTaskOwned(store, Q, parent, 'w-no-child', 'no-such-task', null))
        await go(() => awaitTaskOwned(store, Q, parent, 'w-child', childTask.taskId, null))
        const [child] =
          (await go(() => store.claim(Q, 'w-child', { leaseSeconds: 60, limit: 1 }))) ?? []
        if (child?.taskId === childTask.taskId) {
          await go(() => store.complete(Q, child.runId, child.claimToken, '{"child":1}'))
        }
        const [wokenParent] =
          (await go(() => store.claim(Q, 'w-parent2', { leaseSeconds: 60, limit: 1 }))) ?? []
        if (wokenParent?.runId === parent.runId) {
          await go(() =>
            store.activate(Q, wokenParent.runId, wokenParent.claimToken, wokenParent.claimGen),
          )
          await go(() =>
            store.complete(Q, wokenParent.runId, wokenParent.claimToken, '{"parent":1}'),
          )
        }
      }

      // A child that ended with no completion event, as a build older than the event
      // leaves it. That build is this store over an executor that sends `cancel-task`
      // without its event insert, so every statement still goes through the simulated
      // port: a promise the simulator does not own breaks its determinism contract. The
      // await of the child records the outcome in a batch of its own (ChildTasks.tla's
      // AwaitMaterialize), which makes that batch a cell of this matrix.
      const olderBuild = f.storeOver({
        batch: (batchLabel, statements, control) =>
          simDb.batch(
            batchLabel,
            batchLabel !== 'cancel-task'
              ? statements
              : statements.map((statement) =>
                  /^insert into ["`]events["`]/i.test(statement.sql)
                    ? { ...statement, sql: 'SELECT 1 WHERE 1 = 0', args: [] }
                    : statement,
                ),
            control,
          ),
      })
      const endedTask = await go(() => store.spawn(Q, 'ended-child', '{}'))
      if (endedTask) {
        await go(() => olderBuild.cancelTask(Q, endedTask.taskId))
        const lateParent = await go(() => store.spawn(Q, 'late-parent', '{}'))
        const [late] =
          (await go(() => store.claim(Q, 'w-late-parent', { leaseSeconds: 60, limit: 1 }))) ?? []
        if (lateParent && late?.taskId === lateParent.taskId) {
          await go(() => store.activate(Q, late.runId, late.claimToken, late.claimGen))
          await go(() => awaitTaskOwned(store, Q, late, 'w-ended-child', endedTask.taskId, null))
          await go(() => store.complete(Q, late.runId, late.claimToken, '{"late":1}'))
        }
      }

      // A saga (Sagas.tla), as short as reaches its label, because every cell of every
      // starting state runs it: a registered step starts, the task fails for good, which
      // enters the rolling-back phase, and the rollback fails for good, which halts the
      // saga. The saga starting state runs a rollback and finishes one.
      const sagaTask = await go(() => store.spawn(Q, 'saga', '{}', { maxAttempts: 1 }))
      const [forward] =
        (await go(() => store.claim(Q, 'w-saga', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (sagaTask && forward?.taskId === sagaTask.taskId) {
        const cause = '{"name":"SagaBoom"}'
        await go(() =>
          store.setCheckpoint(
            Q,
            forward.taskId,
            forward.runId,
            forward.claimToken,
            `${SAGA_STARTED_PREFIX}a`,
            '1',
            60,
          ),
        )
        await go(() => store.fail(Q, forward.runId, forward.claimToken, cause, null))
        const [pass] =
          (await go(() => store.claim(Q, 'w-saga-pass', { leaseSeconds: 60, limit: 1 }))) ?? []
        if (pass?.taskId === sagaTask.taskId) {
          await go(() =>
            store.failRollback(Q, pass.runId, pass.claimToken, cause, null, {
              stepKey: 'a',
              errorJson: '{"name":"RollbackBoom"}',
            }),
          )
        }
      }

      // A deferral-style park (reschedule keeps its own matrix cell).
      await go(() => store.spawn(Q, 'h', '{}'))
      const [parked] = (await go(() => store.claim(Q, 'w3', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (parked) {
        await go(() => store.reschedule(Q, parked.runId, parked.claimToken, { inSeconds: 2 }))
      }

      // A launch deferral: a build without the task's handler parks its claim.
      await go(() => store.spawn(Q, 'i', '{}'))
      const [unregistered] =
        (await go(() => store.claim(Q, 'w4', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (unregistered) {
        await go(() =>
          store.claimedTaskName(
            Q,
            unregistered.runId,
            unregistered.claimToken,
            unregistered.claimGen,
          ),
        )
        await go(() =>
          store.deferLaunch(
            Q,
            unregistered.runId,
            unregistered.claimToken,
            unregistered.claimGen,
            2,
          ),
        )
      }

      // A task to cancel, a claimed-and-activated run to expire (died
      // mid-run), and a claimed-never-activated run (lost launch).
      const t5 = await go(() => store.spawn(Q, 'e', '{}'))
      if (t5) await go(() => store.cancelTask(Q, t5.taskId))
      await go(() => store.spawn(Q, 'f', '{}'))
      await go(() => store.spawn(Q, 'g', '{}'))
      const pair =
        (await go(() => store.claim(Q, 'w2', { leaseSeconds: 30, limit: CLAIM_LIMIT }))) ?? []
      const [dies] = pair
      if (dies) {
        await go(() => store.activate(Q, dies.runId, dies.claimToken, dies.claimGen))
        await go(() => store.expireLeaseNow(Q, dies.runId, dies.claimToken))
      }
      // (the second of the pair is abandoned unactivated)

      // A revival: a one-attempt task fails for good, then retryTask revives it. It
      // runs after the workload's other claims, because its revival run is due now
      // with an early id and would otherwise be what those claims take.
      const doomed = await go(() => store.spawn(Q, 'j', '{}', { maxAttempts: 1 }))
      const [dead] = (await go(() => store.claim(Q, 'w5', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (doomed && dead?.taskId === doomed.taskId) {
        await go(() => store.activate(Q, dead.runId, dead.claimToken, dead.claimGen))
        await go(() => store.fail(Q, dead.runId, dead.claimToken, '{"name":"Doomed"}', null))
        await go(() => store.retryTask(Q, doomed.taskId))
      }

      // A task with a start deadline, spawned AFTER the claims so nothing
      // activates it (activation would disarm the never-started deadline).
      await go(() => store.spawn(Q, 'c', '{}', { cancellation: { maxDelaySeconds: 5 } }))

      // Cross every deadline and lease, then sweep: cancel + lost-launch +
      // claim-timeout arms all fire in one call.
      now += 40_000
      await go(() => admin.setFakeNowEpochMs(now))
      await go(() => store.sweep(Q, 10))
      if (t2) await go(() => store.getTaskResult(Q, t2.taskId))
      await go(() => store.nextWakeAtEpochMs(Q))
    })
    await world.run()

    await assertEdgePostcondition(f.raw, preState, world.trace, cell)

    // (1) Nothing the fault did may have corrupted state, or let a saga's rows say
    // something Sagas.tla forbids.
    const violations = [
      ...(await engineInvariantViolations(f.raw)),
      ...(await sagaViolations(f.raw)),
    ]
    if (violations.length > 0) {
      throw new Error(`matrix ${cell}: ${violations.join('; ')}`)
    }
    // (2) The claim bound is a quantity invariant: state checkers cannot
    // see it, so the matrix asserts it directly.
    const [over] = await f.raw.batch('t', [
      {
        sql: `SELECT claimed_by AS v, COUNT(*) AS n FROM runs
              WHERE state = 'running' GROUP BY claimed_by HAVING COUNT(*) > ?`,
        args: [CLAIM_LIMIT],
      },
    ])
    if ((over?.rows.length ?? 0) > 0) {
      throw new Error(`matrix ${cell}: claim bound exceeded`)
    }
    // (3) Progress: whatever the fault stranded, the system must still be
    // able to drive a fresh task to completion within a few passes.
    const probe = await f.store.spawn(Q, 'probe', '{}')
    let done = false
    for (let round = 0; round < 6 && !done; round++) {
      now += 70_000
      await f.admin.setFakeNowEpochMs(now)
      await f.store.sweep(Q, 10)
      const got = await f.store.claim(Q, `probe-w${round}`, { leaseSeconds: 60, limit: 5 })
      for (const run of got) {
        const live = await f.store.activate(Q, run.runId, run.claimToken, run.claimGen)
        if (live && live.taskId === probe.taskId) {
          await f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}')
          done = true
        } else if (live) {
          await f.store.complete(Q, run.runId, run.claimToken, '{"ok":1}').catch(() => {})
        }
      }
    }
    if (!done) {
      throw new Error(`matrix ${cell}: system wedged — probe task never completed`)
    }
    const finalViolations = await engineInvariantViolations(f.raw)
    if (finalViolations.length > 0) {
      throw new Error(`matrix ${cell} final: ${finalViolations.join('; ')}`)
    }
  } finally {
    await f.close()
  }
}
