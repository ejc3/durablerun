import { createHash, timingSafeEqual } from 'node:crypto'

/** The complete hosted route authority surface. Route adapters map onto it exactly once. */
export const HOSTED_AUTHORIZATION_OPERATIONS = [
  'task.enqueue',
  'event.emit',
  'tick.run',
  'task.inspect',
] as const

export type HostedAuthorizationOperation = (typeof HOSTED_AUTHORIZATION_OPERATIONS)[number]

/**
 * The read-only part of Web `Headers`. The implementation owns a cloned
 * `Headers` instance in a closure, so a plugin cannot mutate either these
 * facts or the router's request through a cast to the mutable Web API.
 */
export interface HostedAuthorizationHeaders extends Iterable<[string, string]> {
  readonly get: (name: string) => string | null
  readonly has: (name: string) => boolean
  readonly entries: () => IterableIterator<[string, string]>
  readonly keys: () => IterableIterator<string>
  readonly values: () => IterableIterator<string>
  readonly forEach: (
    callback: (value: string, name: string, headers: HostedAuthorizationHeaders) => void,
    thisArg?: unknown,
  ) => void
  readonly [Symbol.iterator]: () => IterableIterator<[string, string]>
}

/**
 * An immutable, read-once snapshot passed to hosted authorization plugins.
 * `bodyText` is the exact bounded text the router supplies and will later
 * parse. The router owns that binding; plugins never re-read a stream or lose
 * whitespace/Unicode through this port.
 */
export interface HostedAuthorizationFacts {
  readonly operation: HostedAuthorizationOperation
  readonly method: string
  readonly url: string
  readonly headers: HostedAuthorizationHeaders
  readonly bodyText: string
}

export type HostedAuthorizationDecision =
  | Readonly<{ kind: 'allow'; principal?: string }>
  | Readonly<{ kind: 'deny'; reason: 'unauthenticated' | 'forbidden' }>

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

const UNAUTHENTICATED = Object.freeze({
  kind: 'deny',
  reason: 'unauthenticated',
} as const)
const FORBIDDEN = Object.freeze({ kind: 'deny', reason: 'forbidden' } as const)
const ALLOW_WITHOUT_PRINCIPAL = Object.freeze({ kind: 'allow' } as const)

export function allowAuthorization(principal?: string): HostedAuthorizationDecision {
  return principal === undefined
    ? ALLOW_WITHOUT_PRINCIPAL
    : Object.freeze({ kind: 'allow', principal })
}

export function denyAuthorization(
  reason: 'unauthenticated' | 'forbidden' = 'unauthenticated',
): HostedAuthorizationDecision {
  return reason === 'forbidden' ? FORBIDDEN : UNAUTHENTICATED
}

function readOnlyHeaders(source: Headers): HostedAuthorizationHeaders {
  const snapshot = new Headers(source)
  const view: HostedAuthorizationHeaders = Object.freeze({
    get: (name: string) => snapshot.get(name),
    has: (name: string) => snapshot.has(name),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (
      callback: (value: string, name: string, headers: HostedAuthorizationHeaders) => void,
      thisArg?: unknown,
    ) => {
      for (const [name, value] of snapshot) callback.call(thisArg, value, name, view)
    },
    [Symbol.iterator]: () => snapshot.entries(),
  })
  return view
}

function isOperation(value: unknown): value is HostedAuthorizationOperation {
  return (
    typeof value === 'string' &&
    (HOSTED_AUTHORIZATION_OPERATIONS as readonly string[]).includes(value)
  )
}

function snapshotFacts(
  operation: HostedAuthorizationOperation,
  request: Request,
  bodyText: string,
): HostedAuthorizationFacts {
  if (!isOperation(operation)) {
    throw new HostedAuthorizationError(
      'invalid-operation',
      500,
      'hosted route has no authorization operation',
    )
  }
  return Object.freeze({
    operation,
    method: request.method,
    url: request.url,
    headers: readOnlyHeaders(request.headers),
    bodyText,
  })
}

class InvalidDecisionError extends Error {}

/** Snapshot a structural plugin result once; getters cannot change its later meaning. */
function normalizeDecision(value: unknown): HostedAuthorizationDecision {
  try {
    if (typeof value !== 'object' || value === null) throw new InvalidDecisionError()
    const kind = Reflect.get(value, 'kind')
    if (kind === 'allow') {
      const principal = Reflect.get(value, 'principal')
      if (principal !== undefined && typeof principal !== 'string') {
        throw new InvalidDecisionError()
      }
      return allowAuthorization(principal)
    }
    if (kind === 'deny') {
      const reason = Reflect.get(value, 'reason')
      if (reason !== 'unauthenticated' && reason !== 'forbidden') {
        throw new InvalidDecisionError()
      }
      return denyAuthorization(reason)
    }
  } catch (cause) {
    if (cause instanceof InvalidDecisionError) throw cause
    throw new InvalidDecisionError('authorization decision could not be read', { cause })
  }
  throw new InvalidDecisionError()
}

/**
 * The sole router authorization boundary. Denials become 401/403, plugin
 * failures become 503, and malformed decisions become 500. Every path throws
 * closed; only the returned immutable grant authorizes route work.
 */
export async function authorizeHostedRequest(
  plugin: HostedAuthorizationPlugin,
  operation: HostedAuthorizationOperation,
  request: Request,
  bodyText: string,
): Promise<HostedAuthorizationGrant> {
  const facts = snapshotFacts(operation, request, bodyText)
  let raw: unknown
  try {
    raw = await plugin(facts)
  } catch (cause) {
    if (cause instanceof InvalidDecisionError) {
      throw new HostedAuthorizationError(
        'invalid-decision',
        500,
        'hosted authorization plugin returned an invalid decision',
        { cause },
      )
    }
    throw new HostedAuthorizationError(
      'plugin-failure',
      503,
      'hosted authorization plugin failed',
      { cause },
    )
  }

  let decision: HostedAuthorizationDecision
  try {
    decision = normalizeDecision(raw)
  } catch (cause) {
    throw new HostedAuthorizationError(
      'invalid-decision',
      500,
      'hosted authorization plugin returned an invalid decision',
      { cause },
    )
  }

  if (decision.kind === 'deny') {
    if (decision.reason === 'forbidden') {
      throw new HostedAuthorizationError('forbidden', 403, 'hosted operation is forbidden')
    }
    throw new HostedAuthorizationError('unauthenticated', 401, 'hosted authorization required')
  }
  return decision.principal === undefined
    ? Object.freeze({})
    : Object.freeze({ principal: decision.principal })
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
      return UNAUTHENTICATED
    }
    const actual = fixedDigest(header.slice(7))
    return timingSafeEqual(expected, actual) ? allowed : UNAUTHENTICATED
  }
}

/**
 * Logical OR for independent schemes. An explicit allow wins; if none allow,
 * a plugin failure is preserved instead of being mistaken for a denial;
 * otherwise any forbidden decision wins over unauthenticated.
 */
export function anyOfAuthorization(
  ...alternatives: readonly HostedAuthorizationPlugin[]
): HostedAuthorizationPlugin {
  const plugins = Object.freeze([...alternatives])
  for (const plugin of plugins) {
    if (typeof plugin !== 'function') {
      throw new TypeError('authorization alternative must be a plugin function')
    }
  }
  return async (facts) => {
    let firstFailure: unknown
    let sawFailure = false
    let sawForbidden = false
    for (const plugin of plugins) {
      try {
        const decision = normalizeDecision(await plugin(facts))
        if (decision.kind === 'allow') return decision
        if (decision.reason === 'forbidden') sawForbidden = true
      } catch (cause) {
        if (!sawFailure) firstFailure = cause
        sawFailure = true
      }
    }
    if (sawFailure) throw firstFailure
    return sawForbidden ? FORBIDDEN : UNAUTHENTICATED
  }
}

export type HostedAuthorizationByOperation = {
  readonly [Operation in HostedAuthorizationOperation]: HostedAuthorizationPlugin
}

/** Snapshot an exhaustive route-to-policy map; there is no fallback policy. */
export function authorizationByOperation(
  mapping: HostedAuthorizationByOperation,
): HostedAuthorizationPlugin {
  const snapshot = Object.freeze({
    'task.enqueue': mapping['task.enqueue'],
    'event.emit': mapping['event.emit'],
    'tick.run': mapping['tick.run'],
    'task.inspect': mapping['task.inspect'],
  } satisfies HostedAuthorizationByOperation)
  for (const operation of HOSTED_AUTHORIZATION_OPERATIONS) {
    if (typeof snapshot[operation] !== 'function') {
      throw new TypeError(`authorization plugin missing for ${operation}`)
    }
  }
  return (facts) => snapshot[facts.operation](facts)
}
