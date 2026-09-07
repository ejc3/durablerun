import {
  type Clock,
  type IdSource,
  InvalidDurableStringError,
  type SchedulerStore,
  StoreUnavailableError,
  UserName,
  durationToMs,
  parseTaskValueJson,
  requirePositiveInt,
  serializeTaskValue,
} from '@durablerun/core'
import type { TaskRegistry } from '@durablerun/sdk'
import {
  HostedAuthorizationError,
  type HostedAuthorizationOperation,
  type HostedAuthorizationPlugin,
  authorizeHostedRequest,
} from './auth.js'
import { type InlineTickResult, inlineTick } from './inline.js'
import { type WakeScheduler, WakeSchedulingError, scheduleTickWake } from './wake.js'

/** The hosted-alpha API accepts at most 64 KiB before authorization runs. */
export const HOSTED_REQUEST_BODY_MAX_BYTES = 64 * 1024

export interface HostedRouterDependencies {
  readonly store: SchedulerStore
  readonly ids: IdSource
  readonly clock: Clock
  readonly registry: TaskRegistry
  readonly authorization: HostedAuthorizationPlugin
  /** One router instance is permanently bound to one queue. */
  readonly queue: string
  /** The sweep budget for each bounded tick. Claim concurrency is always one. */
  readonly sweepLimit: number
  readonly leaseSeconds: number
  /**
   * Host-owned acceleration after a durable enqueue or emit. A Vercel adapter
   * can call `waitUntil` here; cron remains the recovery path if it is lost.
   * Throws and rejected promises are deliberately ignored.
   */
  readonly onWorkAvailable?: () => void | Promise<void>
  /** Optional host-owned continuation after each bounded tick; errors retry the tick. */
  readonly scheduleWake?: WakeScheduler
}

export interface HostedRouter {
  readonly handle: (request: Request) => Promise<Response>
  /** Host-trusted acceleration; unlike `/api/tick`, this has no HTTP/auth boundary. */
  readonly runTick: () => Promise<InlineTickResult>
}

type Route = Readonly<{
  operation: HostedAuthorizationOperation
  methods: readonly string[]
  run: (request: Request, bodyText: string) => Promise<Response>
}>

type ErrorCode =
  | 'authorization_invalid'
  | 'authorization_unavailable'
  | 'body_read_failed'
  | 'body_too_large'
  | 'forbidden'
  | 'internal_error'
  | 'invalid_json'
  | 'invalid_request'
  | 'method_not_allowed'
  | 'not_found'
  | 'service_unavailable'
  | 'task_not_found'
  | 'unauthenticated'

class HostedRequestError extends Error {
  constructor(
    readonly status: 400 | 413,
    readonly code: ErrorCode,
  ) {
    super(code)
  }
}

class BodyTooLargeError extends Error {}

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders?: Readonly<Record<string, string>>,
): Response {
  return new Response(serializeTaskValue('hosted response', value), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  })
}

function errorResponse(status: number, code: ErrorCode, extraHeaders?: Record<string, string>) {
  return jsonResponse({ error: code }, status, extraHeaders)
}

async function readBoundedBody(request: Request): Promise<string> {
  if (request.body === null) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > HOSTED_REQUEST_BODY_MAX_BYTES) throw new BodyTooLargeError()
      chunks.push(item.value)
    }
  } catch (error) {
    try {
      await reader.cancel()
    } catch {
      // The request stream is already broken; classification below is enough.
    }
    throw error
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function requestObject(bodyText: string): Record<string, unknown> {
  let value: unknown
  try {
    value = parseTaskValueJson(bodyText)
  } catch {
    throw new HostedRequestError(400, 'invalid_json')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HostedRequestError(400, 'invalid_request')
  }
  return value as Record<string, unknown>
}

function requiredNonemptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostedRequestError(400, 'invalid_request')
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new HostedRequestError(400, 'invalid_request')
  return value
}

function authorizationFailure(error: HostedAuthorizationError): Response {
  switch (error.httpStatus) {
    case 401:
      return errorResponse(401, 'unauthenticated')
    case 403:
      return errorResponse(403, 'forbidden')
    case 503:
      return errorResponse(503, 'authorization_unavailable')
    case 500:
      return errorResponse(500, 'authorization_invalid')
  }
}

function bestEffortWake(hook: (() => void | Promise<void>) | undefined): void {
  if (hook === undefined) return
  try {
    Promise.resolve(hook()).catch(() => {})
  } catch {
    // The mutation is already durable. Cron/tick recovery owns a lost hint.
  }
}

/**
 * Build the complete host-neutral HTTP surface for the one-queue hosted alpha.
 * Route selection and method rejection happen before body consumption. Every
 * matched route then reads one bounded body snapshot and authorizes that exact
 * text before parsing, store I/O, or worker execution.
 */
export function createHostedRouter(deps: HostedRouterDependencies): HostedRouter {
  if (typeof deps.authorization !== 'function') {
    throw new TypeError('hosted router requires an authorization plugin')
  }
  if (typeof deps.queue !== 'string' || deps.queue.length === 0) {
    throw new TypeError('hosted router queue must be a non-empty string')
  }
  requirePositiveInt('hosted sweepLimit', deps.sweepLimit)
  durationToMs('hosted leaseSeconds', deps.leaseSeconds, { positive: true })
  if (deps.onWorkAvailable !== undefined && typeof deps.onWorkAvailable !== 'function') {
    throw new TypeError('hosted router onWorkAvailable must be a function')
  }
  if (deps.scheduleWake !== undefined && typeof deps.scheduleWake !== 'function') {
    throw new TypeError('hosted router scheduleWake must be a function')
  }

  const store = deps.store
  const ids = deps.ids
  const clock = deps.clock
  const registry = deps.registry
  const authorization = deps.authorization
  const queue = deps.queue
  const sweepLimit = deps.sweepLimit
  const leaseSeconds = deps.leaseSeconds
  const onWorkAvailable = deps.onWorkAvailable
  const scheduleWake = deps.scheduleWake
  const runTick = async (): Promise<InlineTickResult> => {
    const result = await inlineTick(
      { store, ids, clock, registry },
      { queue, sweepLimit, leaseSeconds },
    )
    if (scheduleWake !== undefined) await scheduleTickWake(scheduleWake, queue, result)
    return result
  }

  const routes: Readonly<Record<string, Route>> = Object.freeze({
    '/api/tasks': Object.freeze({
      operation: 'task.enqueue',
      methods: Object.freeze(['POST']),
      async run(_request: Request, bodyText: string) {
        const body = requestObject(bodyText)
        const taskName = requiredNonemptyString(body.taskName)
        const idempotencyKey = optionalString(body.idempotencyKey)
        const paramsJson = serializeTaskValue('task parameters', body.params ?? null)
        const spawned = await store.spawn(
          queue,
          taskName,
          paramsJson,
          idempotencyKey === undefined ? {} : { idempotencyKey },
        )
        bestEffortWake(onWorkAvailable)
        return jsonResponse(
          { taskId: spawned.taskId, runId: spawned.runId, created: spawned.created },
          spawned.created ? 201 : 200,
        )
      },
    }),
    '/api/events': Object.freeze({
      operation: 'event.emit',
      methods: Object.freeze(['POST']),
      async run(_request: Request, bodyText: string) {
        const body = requestObject(bodyText)
        let eventName: string
        try {
          eventName = UserName.parse('event name', requiredNonemptyString(body.eventName)).value
        } catch (error) {
          if (error instanceof HostedRequestError) throw error
          throw new HostedRequestError(400, 'invalid_request')
        }
        const payloadJson = serializeTaskValue('event payload', body.payload ?? null)
        await store.emitEvent(queue, eventName, payloadJson)
        bestEffortWake(onWorkAvailable)
        return jsonResponse({ emitted: true })
      },
    }),
    '/api/tick': Object.freeze({
      operation: 'tick.run',
      methods: Object.freeze(['GET', 'POST']),
      async run() {
        const result = await runTick()
        return jsonResponse({
          swept: result.swept,
          claimed: result.claimed,
          launched: result.launched,
          launchFailed: result.launchFailed,
          ended: result.ended,
          nextWakeAtEpochMs: result.nextWakeAtEpochMs,
          backlog: result.backlog,
          workerOutcome: result.workerOutcome,
        })
      },
    }),
    '/api/inspect': Object.freeze({
      operation: 'task.inspect',
      methods: Object.freeze(['GET']),
      async run(request: Request) {
        const taskId = new URL(request.url).searchParams.get('taskId')
        if (taskId === null || taskId.length === 0) {
          throw new HostedRequestError(400, 'invalid_request')
        }
        const result = await store.getTaskResult(queue, taskId)
        if (result === null) return errorResponse(404, 'task_not_found')
        const response: Record<string, unknown> = { taskId, state: result.state }
        if (result.state === 'completed' && result.completedPayloadJson !== undefined) {
          response.result = parseTaskValueJson(result.completedPayloadJson)
        }
        if (result.failureReasonJson !== undefined) {
          response.failure = parseTaskValueJson(result.failureReasonJson)
        }
        return jsonResponse(response)
      },
    }),
  })

  const handle = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname
    const route = routes[pathname]
    if (route === undefined) return errorResponse(404, 'not_found')
    if (!route.methods.includes(request.method)) {
      return errorResponse(405, 'method_not_allowed', { allow: route.methods.join(', ') })
    }

    let bodyText: string
    try {
      bodyText = await readBoundedBody(request)
    } catch (error) {
      return error instanceof BodyTooLargeError
        ? errorResponse(413, 'body_too_large')
        : errorResponse(400, 'body_read_failed')
    }

    try {
      await authorizeHostedRequest(authorization, route.operation, request, bodyText)
    } catch (error) {
      return error instanceof HostedAuthorizationError
        ? authorizationFailure(error)
        : errorResponse(500, 'authorization_invalid')
    }

    try {
      return await route.run(request, bodyText)
    } catch (error) {
      if (error instanceof HostedRequestError) return errorResponse(error.status, error.code)
      if (error instanceof InvalidDurableStringError) return errorResponse(400, 'invalid_request')
      if (error instanceof StoreUnavailableError || error instanceof WakeSchedulingError) {
        return errorResponse(503, 'service_unavailable')
      }
      return errorResponse(500, 'internal_error')
    }
  }

  return Object.freeze({ handle, runTick })
}
