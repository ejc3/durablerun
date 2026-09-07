import { LaunchOutcome, systemClock, type Clock } from '@durablerun/core'
import { requireExpectedFailure } from '@durablerun/core/testing'
import { signBody, tick, type TickResult } from '@durablerun/driver'
import { runClaimedRun, type TaskRegistry } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlStoreAdmin } from '@durablerun/store-libsql'
import { testIdSource } from '@durablerun/store-libsql/testing'

const clock: Clock = systemClock()
const registry: TaskRegistry = new Map()
const emptyTick: Partial<TickResult> = {}
const runtimeExports = [requireExpectedFailure, tick, runClaimedRun]
for (const exported of runtimeExports) {
  if (typeof exported !== 'function') throw new Error('expected a function export')
}
if (!Number.isFinite(clock.nowEpochMs())) throw new Error('system clock is not usable')
if (!(registry instanceof Map) || Object.keys(emptyTick).length !== 0) {
  throw new Error('published SDK or driver types are unusable')
}
if (signBody('consumer-secret', 'body').length === 0) throw new Error('driver crypto is unusable')
if (!(LaunchOutcome.accepted() instanceof LaunchOutcome))
  throw new Error('core runtime is unusable')
if (testIdSource('consumer').uuidv7() !== 'consumer-id-000001') {
  throw new Error('testing subpath is unusable')
}

const raw = LibsqlExecutor.open(':memory:')
try {
  await new LibsqlStoreAdmin(raw).migrate()
} finally {
  raw.close()
}
