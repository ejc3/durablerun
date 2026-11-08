import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * What the compatibility harness uses of the release alpha.1, as scripts/alpha1-compat.sh
 * installs it into a consumer directory: the store's calls the cycle and the week make,
 * typed here once for both.
 */

export interface Alpha1Result {
  state: string
  completedPayloadJson?: string
  failureReasonJson?: string
}
export interface Alpha1Claimed {
  runId: string
  taskId: string
  claimToken: string
  claimGen: number
  wake?: { event: string; step: string; payloadJson?: string }
}
export interface Alpha1Executor {
  close(): void
}
export interface Alpha1Store {
  spawn(
    queue: string,
    name: string,
    params: string,
    opts?: object,
  ): Promise<{ taskId: string; created: boolean }>
  claim(
    queue: string,
    token: string,
    opts: { leaseSeconds: number; limit: number },
  ): Promise<Alpha1Claimed[]>
  activate(queue: string, runId: string, token: string, gen: number): Promise<unknown>
  complete(queue: string, runId: string, token: string, result: string): Promise<void>
  fail(queue: string, runId: string, token: string, failure: string, retry: null): Promise<void>
  awaitEvent(
    queue: string,
    taskId: string,
    runId: string,
    token: string,
    step: string,
    event: string,
    timeout: number | null,
  ): Promise<{ emitted: boolean }>
  emitEvent(queue: string, event: string, payload: string): Promise<void>
  getTaskResult(queue: string, taskId: string): Promise<Alpha1Result | null>
}

/** The URL of a file of a package the consumer directory installed. */
export const installedIn = (consumer: string, path: string): string =>
  pathToFileURL(join(consumer, 'node_modules', path)).href

/** alpha.1's core and its libSQL store, loaded from the consumer directory. */
export async function loadAlpha1(consumer: string) {
  const core = (await import(installedIn(consumer, '@durablerun/core/dist/index.js'))) as {
    systemIdSource(): { token(): string }
  }
  const store = (await import(installedIn(consumer, '@durablerun/store-libsql/dist/index.js'))) as {
    LibsqlExecutor: { open(url: string): Alpha1Executor }
    LibsqlSchedulerStore: new (db: Alpha1Executor, ids: object) => Alpha1Store
    LibsqlStoreAdmin: new (
      db: Alpha1Executor,
    ) => {
      migrate(): Promise<void>
      setFakeNowEpochMs(epochMs: number | null): Promise<void>
    }
  }
  return { core, store }
}
