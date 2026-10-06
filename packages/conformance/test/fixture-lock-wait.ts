/**
 * How long a batch is given to reach a held row, or the lock in front of it. A server does
 * not say which sessions of a shared database have blocked, so this is real time, and it
 * is many times what a batch needs to begin and take its first lock.
 */
const arrivedAtALock = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 750))

/**
 * A server fixture's `holdBatchesAtTheRow`, over its own hold of a task row's write lock:
 * a batch `during` starts waits at the row, or at a lock an earlier one of them took.
 */
export const holdingBatchesAtTheRow =
  (holdTaskRowLock: (taskId: string, during: () => Promise<void>) => Promise<void>) =>
  (taskId: string, during: (arrived: () => Promise<void>) => Promise<void>): Promise<void> =>
    holdTaskRowLock(taskId, () => during(arrivedAtALock))
