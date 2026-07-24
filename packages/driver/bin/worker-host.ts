/**
 * Worker process entry (composition root: the one place the REAL clock and
 * ids are wired). Args: dbPath port secret [driverUrl]. Registers the
 * chaos/dogfood task set and serves signed launches until killed.
 */
import { systemClock, systemIdSource } from '@durablerun/core'
import { createWorkerServer } from '@durablerun/driver'
import type { TaskRegistry } from '@durablerun/sdk'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'

const [dbPath, portArg, secret, driverUrl] = process.argv.slice(2)
if (!dbPath || !portArg || !secret) throw new Error('usage: worker-host db port secret [driverUrl]')

const raw = LibsqlExecutor.open(`file:${dbPath}`)
const admin = new LibsqlStoreAdmin(raw)
await admin.migrate()
const store = new LibsqlSchedulerStore(raw, systemIdSource())

const registry: TaskRegistry = new Map([
  [
    'chaos-steps',
    async (ctx, params) => {
      const p = params as { steps: number; stepMs: number }
      const out: number[] = []
      for (let i = 0; i < p.steps; i++) {
        out.push(
          await ctx.step('work', async () => {
            await new Promise((r) => setTimeout(r, p.stepMs))
            return i
          }),
        )
      }
      return { done: out.length }
    },
  ],
  [
    'dogfood-backup',
    async (ctx, params) => {
      const p = params as { cycles: number; intervalSeconds: number }
      for (let i = 0; i < p.cycles; i++) {
        await ctx.step('backup', () => ({ cycle: i, note: 'repo backed up' }))
        await ctx.sleepFor(p.intervalSeconds)
      }
      return { cycles: p.cycles }
    },
  ],
  [
    'napper',
    async (ctx, params) => {
      await ctx.step('before', () => 'a')
      await ctx.sleepFor((params as { seconds: number }).seconds)
      await ctx.step('after', () => 'b')
      return 'rested'
    },
  ],
])

const server = createWorkerServer({
  store,
  clock: systemClock(),
  registry,
  secret,
  ...(driverUrl ? { driverUrl } : {}),
})
await server.listen(Number(portArg))
process.send?.('ready')
