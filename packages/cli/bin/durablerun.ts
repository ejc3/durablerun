import { systemClock, systemIdSource } from '@durablerun/core'
import { main } from '../src/main.js'

const io = {
  out: (text: string) => process.stdout.write(text),
  err: (text: string) => process.stderr.write(text),
}
process.exitCode = await main(
  process.argv.slice(2),
  process.env,
  io,
  systemIdSource(),
  systemClock(),
)
