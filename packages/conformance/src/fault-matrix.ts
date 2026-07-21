import { SimWorld } from '@durablerun/harness'
import type { StoreFixtureFactory } from './fixture.js'
import { engineInvariantViolations } from './invariants.js'

const Q = 'q'

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
  'spawn',
  'claim',
  'activate',
  'heartbeat',
  'reschedule',
  'complete',
  'fail',
  'cancel-task',
  'expire-lease-now',
  'set-checkpoint',
  'sweep:cancel',
  'sweep:lost-launch',
  'sweep:claim-timeout',
] as const

export const MATRIX_READ_LABELS = [
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
): Promise<void> {
  const f = await makeFixture(`matrix-${label}-${fault}-${seed}`)
  try {
    let now = 1_000_000
    await f.admin.setFakeNowEpochMs(now)
    const world = new SimWorld(f.raw, `matrix-${label}-${fault}-${seed}`)
    if (fault === 'duplicate') {
      world.injectDuplicate({ label })
    } else {
      world.injectCrash({
        actor: 'driver',
        label,
        when: fault === 'crash-before' ? 'before' : 'after',
      })
    }

    const CLAIM_LIMIT = 2
    world.actor('driver', async (simDb) => {
      const store = f.storeOver(simDb)
      // Every call is fault-tolerant: a crash rejection means "this call's
      // process died" — the workload carries on, like real traffic would.
      const go = async <T>(op: () => Promise<T>): Promise<T | null> => {
        try {
          return await op()
        } catch {
          return null
        }
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
        await go(() => store.reschedule(Q, first.runId, first.claimToken, { inSeconds: 1 }))
      }
      if (second) {
        await go(() => store.fail(Q, second.runId, second.claimToken, '{"name":"X"}', null))
      }
      // A full clean lifecycle: claim, activate, complete.
      await go(() => store.spawn(Q, 'd', '{}'))
      const [fin] = (await go(() => store.claim(Q, 'w1b', { leaseSeconds: 60, limit: 1 }))) ?? []
      if (fin) {
        await go(() => store.activate(Q, fin.runId, fin.claimToken, fin.claimGen))
        await go(() => store.complete(Q, fin.runId, fin.claimToken, '{"ok":1}'))
      }

      // A task to cancel, a claimed-and-activated run to expire (died
      // mid-run), and a claimed-never-activated run (lost launch).
      const t5 = await go(() => store.spawn(Q, 'e', '{}'))
      if (t5) await go(() => store.cancelTask(Q, t5.taskId))
      await go(() => store.spawn(Q, 'f', '{}'))
      await go(() => store.spawn(Q, 'g', '{}'))
      const pair = (await go(() => store.claim(Q, 'w2', { leaseSeconds: 30, limit: 2 }))) ?? []
      const [dies] = pair
      if (dies) {
        await go(() => store.activate(Q, dies.runId, dies.claimToken, dies.claimGen))
        await go(() => store.expireLeaseNow(Q, dies.runId, dies.claimToken))
      }
      // (the second of the pair is abandoned unactivated)

      // A task with a start deadline, spawned AFTER the claims so nothing
      // activates it (activation would disarm the never-started deadline).
      await go(() => store.spawn(Q, 'c', '{}', { cancellation: { maxDelaySeconds: 5 } }))

      // Cross every deadline and lease, then sweep: cancel + lost-launch +
      // claim-timeout arms all fire in one call.
      now += 40_000
      await go(() => f.admin.setFakeNowEpochMs(now))
      await go(() => store.sweep(Q, 10))
      if (t2) await go(() => store.getTaskResult(Q, t2.taskId))
      await go(() => store.nextWakeAtEpochMs(Q))
    })
    await world.run()

    // (1) Nothing the fault did may have corrupted state.
    const violations = await engineInvariantViolations(f.raw)
    if (violations.length > 0) {
      throw new Error(`matrix ${label}/${fault}/${seed}: ${violations.join('; ')}`)
    }
    // (2) The claim bound is a quantity invariant: state checkers cannot
    // see it, so the matrix asserts it directly.
    const [over] = await f.raw.batch('t', [
      {
        sql: `SELECT claimed_by AS v, COUNT(*) AS n FROM runs
              WHERE state = 'running' GROUP BY claimed_by HAVING COUNT(*) > 2`,
        args: [],
      },
    ])
    if ((over?.rows.length ?? 0) > 0) {
      throw new Error(`matrix ${label}/${fault}/${seed}: claim bound exceeded`)
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
      throw new Error(
        `matrix ${label}/${fault}/${seed}: system wedged — probe task never completed`,
      )
    }
    const finalViolations = await engineInvariantViolations(f.raw)
    if (finalViolations.length > 0) {
      throw new Error(`matrix ${label}/${fault}/${seed} final: ${finalViolations.join('; ')}`)
    }
  } finally {
    f.close()
  }
}
