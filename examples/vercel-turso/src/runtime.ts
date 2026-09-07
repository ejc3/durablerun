import { systemClock, systemIdSource } from '@durablerun/core'
import {
  type HostedAuthorizationPlugin,
  type HostedRouter,
  createHostedRouter,
} from '@durablerun/driver'
import { LibsqlExecutor, LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { taskRegistry } from './tasks.js'

export interface HostedExampleConfig {
  readonly databaseUrl: string
  readonly databaseAuthToken: string
  readonly queue: string
  readonly authorization: HostedAuthorizationPlugin
  /** Host-owned lifetime extension. Vercel supplies waitUntil. */
  readonly defer?: (work: Promise<void>) => void
}

export interface HostedExampleRuntime {
  readonly router: HostedRouter
  readonly close: () => void
}

/** Create one reusable process-local connection and one one-slot hosted router. */
export function createHostedExample(config: HostedExampleConfig): HostedExampleRuntime {
  const raw = LibsqlExecutor.open(config.databaseUrl, config.databaseAuthToken)
  try {
    const ids = systemIdSource()
    const base = {
      store: new LibsqlSchedulerStore(raw, ids),
      ids,
      clock: systemClock(),
      registry: taskRegistry,
      authorization: config.authorization,
      queue: config.queue,
      sweepLimit: 10,
      leaseSeconds: 30,
    }
    const defer = config.defer
    const router: HostedRouter = createHostedRouter(
      defer === undefined
        ? base
        : {
            ...base,
            onWorkAvailable() {
              const work = router.runTick().then(() => undefined)
              try {
                defer(work)
              } catch {
                // Returning the work still lets the router observe and ignore
                // its rejection; cron remains recovery when deferral fails.
              }
              return work
            },
          },
    )
    return Object.freeze({ router, close: () => raw.close() })
  } catch (error) {
    raw.close()
    throw error
  }
}
