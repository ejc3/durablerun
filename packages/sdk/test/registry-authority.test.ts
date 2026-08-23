import { expect, it } from 'vitest'
import type { TaskHandler } from '../src/index.js'
import { taskRegistryGet } from '../src/intrinsics.js'

it('a Map subclass override cannot grant missing handler authority', () => {
  class AliasedRegistry extends Map<string, TaskHandler> {
    override get(name: string): TaskHandler | undefined {
      return super.get(name === 'alias' ? 'job' : name)
    }
  }
  const handler: TaskHandler = async () => 'done'
  const registry = new AliasedRegistry([['job', handler]])

  expect(
    taskRegistryGet(registry, 'alias'),
    'mutation-verdict:construction:sdk-registry-map-entry-authority',
  ).toBeUndefined()
})
