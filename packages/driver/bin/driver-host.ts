/**
 * Driver process entry. Args: dbPath queue workerUrl secret [wakePort]. Given a
 * wakePort it serves wakes there, and 0 asks the OS for a free port. The ready
 * message a parent process receives carries the port that was bound, or null
 * when no wakePort was given.
 */
import { systemClock, systemIdSource } from '@durablerun/core'
import { DriverLoop, createWakeServer, httpLauncher } from '@durablerun/driver'
import { LibsqlExecutor, LibsqlSchedulerStore, LibsqlStoreAdmin } from '@durablerun/store-libsql'

const [dbPath, queue, workerUrl, secret, wakePortArg] = process.argv.slice(2)
if (!dbPath || !queue || !workerUrl || !secret)
  throw new Error('usage: driver-host db queue workerUrl secret [wakePort]')

const raw = LibsqlExecutor.open(`file:${dbPath}`)
const admin = new LibsqlStoreAdmin(raw)
await admin.migrate()
const store = new LibsqlSchedulerStore(raw, systemIdSource())
const loop = new DriverLoop(
  {
    store,
    launcher: httpLauncher({ url: workerUrl, secret }),
    ids: systemIdSource(),
    clock: systemClock(),
  },
  {
    queue,
    claimLimit: 5,
    sweepLimit: 10,
    leaseSeconds: 5,
    busyCeilingMs: 50,
    idleCeilingMs: 250,
    launchTimeoutSeconds: 2,
  },
)
const wake = createWakeServer(loop)
const port = wakePortArg ? await wake.listen(Number(wakePortArg)) : null
process.send?.({ ready: true, port })
process.on('SIGTERM', () => {
  void loop.stop().then(() => process.exit(0))
})
await loop.run()
