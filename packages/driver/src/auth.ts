import { createHash, timingSafeEqual } from 'node:crypto'

// The vocabulary is module-private: routes select one of these operations,
// while plugins receive a value but no mutable authority collection.
const hostedAuthorizationOperations = [
  'task.enqueue',
  'event.emit',
  'tick.run',
  'task.inspect',
] as const

export type HostedAuthorizationOperation = (typeof hostedAuthorizationOperations)[number]

/** The exact request snapshot supplied to a host's authorization function. */
export interface HostedAuthorizationFacts {
  readonly operation: HostedAuthorizationOperation
  readonly method: string
  readonly url: string
  /** A detached native clone; mutations cannot change the router's request. */
  readonly headers: Headers
  /** The bounded body text the router will parse after authorization. */
  readonly bodyText: string
}

export type HostedAuthorizationDecision =
  | Readonly<{ kind: 'allow'; principal?: string }>
  | Readonly<{ kind: 'deny'; reason: 'unauthenticated' | 'forbidden' }>

/** A host supplies one function and owns any scheme or policy composition. */
export type HostedAuthorizationPlugin = (
  facts: HostedAuthorizationFacts,
) => HostedAuthorizationDecision | Promise<HostedAuthorizationDecision>

export interface HostedAuthorizationGrant {
  readonly principal?: string
}

export type HostedAuthorizationErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'plugin-failure'
  | 'invalid-decision'
  | 'invalid-operation'

/** Stable router-facing classification; messages never expose plugin failures. */
export class HostedAuthorizationError extends Error {
  override readonly name = 'HostedAuthorizationError'

  constructor(
    readonly code: HostedAuthorizationErrorCode,
    readonly httpStatus: 401 | 403 | 500 | 503,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function allowAuthorization(principal?: string): HostedAuthorizationDecision {
  return principal === undefined ? { kind: 'allow' } : { kind: 'allow', principal }
}

export function denyAuthorization(
  reason: 'unauthenticated' | 'forbidden' = 'unauthenticated',
): HostedAuthorizationDecision {
  return { kind: 'deny', reason }
}

function isOperation(value: unknown): value is HostedAuthorizationOperation {
  return (
    typeof value === 'string' &&
    (hostedAuthorizationOperations as readonly string[]).includes(value)
  )
}

function invalidDecision(cause?: unknown): HostedAuthorizationError {
  return new HostedAuthorizationError(
    'invalid-decision',
    500,
    'hosted authorization plugin returned an invalid decision',
    cause === undefined ? undefined : { cause },
  )
}

function grantFrom(value: unknown): HostedAuthorizationGrant {
  if (typeof value !== 'object' || value === null) throw invalidDecision()
  try {
    const decision = value as Record<string, unknown>
    if (decision.kind === 'allow') {
      if (decision.principal !== undefined && typeof decision.principal !== 'string') {
        throw invalidDecision()
      }
      return decision.principal === undefined ? {} : { principal: decision.principal }
    }
    if (decision.kind === 'deny') {
      if (decision.reason === 'forbidden') {
        throw new HostedAuthorizationError('forbidden', 403, 'hosted operation is forbidden')
      }
      if (decision.reason === 'unauthenticated') {
        throw new HostedAuthorizationError('unauthenticated', 401, 'hosted authorization required')
      }
    }
  } catch (cause) {
    if (cause instanceof HostedAuthorizationError) throw cause
    throw invalidDecision(cause)
  }
  throw invalidDecision()
}

/** The sole fail-closed call from a matched hosted route to host policy. */
export async function authorizeHostedRequest(
  plugin: HostedAuthorizationPlugin,
  operation: HostedAuthorizationOperation,
  request: Request,
  bodyText: string,
): Promise<HostedAuthorizationGrant> {
  if (!isOperation(operation)) {
    throw new HostedAuthorizationError(
      'invalid-operation',
      500,
      'hosted route has no authorization operation',
    )
  }

  let decision: unknown
  try {
    decision = await plugin({
      operation,
      method: request.method,
      url: request.url,
      headers: new Headers(request.headers),
      bodyText,
    })
  } catch (cause) {
    throw new HostedAuthorizationError(
      'plugin-failure',
      503,
      'hosted authorization plugin failed',
      { cause },
    )
  }
  return grantFrom(decision)
}

function fixedDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

/** A strict Bearer adapter whose secret comparison always uses equal-length digests. */
export function bearerAuthorization(options: {
  readonly token: string
  readonly principal?: string
}): HostedAuthorizationPlugin {
  const token: unknown = options.token
  const principal: unknown = options.principal
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('bearer authorization token must be a non-empty string')
  }
  if (principal !== undefined && typeof principal !== 'string') {
    throw new TypeError('bearer authorization principal must be a string')
  }
  const expected = fixedDigest(token)
  const allowed = allowAuthorization(principal)
  return (facts) => {
    const header = facts.headers.get('authorization')
    if (header === null || header.length <= 7 || header.slice(0, 7).toLowerCase() !== 'bearer ') {
      return denyAuthorization()
    }
    return timingSafeEqual(expected, fixedDigest(header.slice(7))) ? allowed : denyAuthorization()
  }
}
