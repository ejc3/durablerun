import { dogfoodConfigFromEnv } from './config.js'
import { DogfoodRuntime } from './runtime.js'

const command = process.argv[2]
if (command !== 'start' && command !== 'tick' && command !== 'status') {
  throw new Error('usage: pnpm dogfood:{start|tick|status}')
}

const runtime = await DogfoodRuntime.open(dogfoodConfigFromEnv())
try {
  const result =
    command === 'start'
      ? await runtime.start()
      : command === 'tick'
        ? await runtime.tick()
        : await runtime.status()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  runtime.close()
}
