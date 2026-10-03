import { systemClock, systemIdSource } from '@durablerun/core'
import { lastCatch, main, reportCrash } from '../src/main.js'

const io = {
  out: (text: string) => process.stdout.write(text),
  err: (text: string) => process.stderr.write(text),
}
// An error thrown outside main's own promise, by a driver's timer or event, reaches the
// process's last handlers, which print it as the last catch does.
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (error: unknown) => process.exit(reportCrash(io, error)))
}
process.exitCode = await lastCatch(io, () =>
  main(process.argv.slice(2), process.env, io, systemIdSource(), systemClock()),
)
