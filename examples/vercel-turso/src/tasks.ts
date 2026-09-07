import { parseTaskValueJson } from '@durablerun/core'
import type { TaskHandler, TaskRegistry } from '@durablerun/sdk'

export const WAIT_FOR_READY_TASK = 'wait-for-ready'
export const ATTEMPT_RECEIPT_TASK = 'attempt-receipt'

function eventNameFrom(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new TypeError('wait-for-ready params must be an object')
  }
  const eventName = Reflect.get(params, 'eventName')
  if (typeof eventName !== 'string' || eventName.length === 0) {
    throw new TypeError('wait-for-ready eventName must be a non-empty string')
  }
  return eventName
}

export const taskRegistry: TaskRegistry = new Map<string, TaskHandler>([
  [
    WAIT_FOR_READY_TASK,
    async (ctx, params) => {
      const eventName = eventNameFrom(params)
      const payload = parseTaskValueJson(await ctx.awaitEvent(eventName))
      return { eventName, payload }
    },
  ],
  [ATTEMPT_RECEIPT_TASK, async (ctx) => ({ attempt: ctx.attempt })],
])
