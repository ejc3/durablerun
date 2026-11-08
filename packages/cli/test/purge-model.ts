import { isDeepStrictEqual } from 'node:util'
import type { RetentionPolicy } from '@durablerun/core'
import type { ProtocolSnapshot } from '../../conformance/src/poison-matrix.js'
import { dumpDifferences, purgeOracle } from '../../conformance/src/retention-oracle.js'
import type { JsonAnswer } from './support.js'

/**
 * One `purge` command held to the model of the barrier. The oracle of the retention
 * surface is written from the model and not from the code. Applied to a dump of every
 * table taken before the command, in the order the command printed its units, it must let
 * each go with the rows the command printed for it, and what it leaves must be the dump
 * taken after. The verb's own test and the week on the release alpha.1 both hold their
 * commands to it through this one function.
 */

/** What a command line asks of a purge: its policy, and the most units it takes. */
export interface ModelledPurge {
  readonly policy: RetentionPolicy
  /** The most units it purges, or null for a dry run, which purges none. */
  readonly limit: number | null
}

export interface PurgeUnit {
  readonly taskId: string
  readonly state: string
  readonly rows?: Readonly<Record<string, number>>
  readonly reasons?: readonly string[]
}

export type PurgeAnswer = JsonAnswer & {
  readonly purged?: readonly PurgeUnit[]
  readonly wouldPurge?: readonly PurgeUnit[]
  readonly kept?: readonly PurgeUnit[]
  readonly gone?: readonly unknown[]
  readonly more?: boolean
  readonly finished?: boolean
}

export const idsOf = (units: readonly PurgeUnit[] | undefined): string[] =>
  (units ?? []).map(({ taskId }) => taskId)

/** What names a task's unit to the model: its id, and the key its row holds in the dump. */
function unitIn(dump: ProtocolSnapshot, queue: string, taskId: string) {
  const key = dump.tasks.find(
    (row) => row.task_id === taskId && row.queue === queue,
  )?.idempotency_key
  return key === null || key === undefined ? { taskId } : { taskId, idempotencyKey: String(key) }
}

/**
 * One command against the model: the dump before it, the dump after it, and what it
 * printed. Each list is empty when the command did what the model says.
 */
export function againstTheModel(
  queue: string,
  before: ProtocolSnapshot,
  after: ProtocolSnapshot,
  nowMs: number,
  command: ModelledPurge,
  answer: PurgeAnswer,
) {
  let dump = before
  const notLetGo: string[] = []
  const rows: unknown[] = []
  const modelRows: unknown[] = []
  for (const unit of answer.purged ?? []) {
    const said = purgeOracle(dump, nowMs, queue, unitIn(dump, queue, unit.taskId), command.policy)
    if (said.keptBy.length > 0) notLetGo.push(`${unit.taskId}: ${said.keptBy.join(', ')}`)
    rows.push([unit.taskId, unit.rows])
    modelRows.push([unit.taskId, { ...said.rows }])
    dump = said.after
  }
  const letsGoNow = (taskId: string): boolean =>
    purgeOracle(after, nowMs, queue, unitIn(after, queue, taskId), command.policy).keptBy.length ===
    0
  // A run that says no more remain reached its end. A dry run deletes nothing, so what the
  // model lets go still stands after one, and a run its limit stopped left work behind.
  const reachedItsEnd = command.limit !== null && answer.more === false
  return {
    /** Units printed as purged that the model keeps. */
    notLetGo,
    /** What differs between what the model leaves and the dump taken after. */
    otherChanges: dumpDifferences(dump, after),
    overTheLimit: Math.max(0, (answer.purged ?? []).length - (command.limit ?? 0)),
    /** Units that stand, though the run said no more remain and the model lets them go. */
    leftBehind: reachedItsEnd
      ? after.tasks
          .filter((row) => row.queue === queue)
          .map((row) => String(row.task_id))
          .filter(letsGoNow)
      : [],
    /** Units printed as kept that the model lets go as the database stands. */
    keptButFree: reachedItsEnd ? idsOf(answer.kept).filter(letsGoNow) : [],
    rows,
    modelRows,
  }
}

/** What a command did otherwise than the model says, each in a line, or nothing. */
export function modelDifferences(model: ReturnType<typeof againstTheModel>): string[] {
  const lists: Record<string, readonly string[]> = {
    'a unit printed as kept is one the model lets go': model.keptButFree,
    'a unit printed as purged is one the model keeps': model.notLetGo,
    'the dump is not what the model leaves': model.otherChanges,
    'a unit the model lets go stands, though no more remain': model.leftBehind,
  }
  return [
    ...Object.entries(lists)
      .filter(([, list]) => list.length > 0)
      .map(([what, list]) => `${what}: ${list.slice(0, 3).join('; ')}`),
    ...(model.overTheLimit > 0 ? ['more went than the limit'] : []),
    ...(isDeepStrictEqual(model.rows, model.modelRows)
      ? []
      : ['the rows printed are not the rows the model says went']),
  ]
}
