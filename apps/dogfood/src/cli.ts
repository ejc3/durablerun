import { dogfoodConfigFromEnv } from './config.js'
import { requireDogfoodReceipt } from './receipt.js'
import { DogfoodRuntime } from './runtime.js'

const command = process.argv[2]
if (command !== 'start' && command !== 'tick' && command !== 'status' && command !== 'verify') {
  throw new Error('usage: pnpm dogfood:{start|tick|status|verify}')
}

const config = dogfoodConfigFromEnv()
const runtime = await DogfoodRuntime.open(config)
try {
  const result =
    command === 'start'
      ? await runtime.start()
      : command === 'tick'
        ? await runtime.tick()
        : await runtime.status()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (command === 'verify') requireDogfoodReceipt(result, config.fault)
} finally {
  runtime.close()
}
