import { describe, expect, it } from 'vitest'
import {
  HOSTED_AUTHORIZATION_OPERATIONS,
  HostedAuthorizationError,
  type HostedAuthorizationFacts,
  type HostedAuthorizationPlugin,
  allowAuthorization,
  anyOfAuthorization,
  authorizationByOperation,
  authorizeHostedRequest,
  bearerAuthorization,
  denyAuthorization,
} from '../src/index.js'

function request(authorization?: string): Request {
  const headers = new Headers({ 'x-test': 'before' })
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('https://alpha.example/api/tasks?view=full', {
    method: 'POST',
    headers,
  })
}

async function expectAuthorizationError(
  promise: Promise<unknown>,
): Promise<HostedAuthorizationError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(HostedAuthorizationError)
    if (error instanceof HostedAuthorizationError) return error
  }
  throw new Error('expected HostedAuthorizationError')
}

describe('hosted authorization', () => {
  it('gives plugins an immutable Web request snapshot with the exact raw body text', async () => {
    const bodyText = '{\n  "snow": "☃", "spaces":  true\n}\n'
    const source = new Request('https://alpha.example/api/tasks?view=full', {
      method: 'POST',
      headers: { 'x-test': 'before' },
      body: bodyText,
    })
    let facts: HostedAuthorizationFacts | undefined
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = authorizeHostedRequest(
      async (snapshot) => {
        facts = snapshot
        await blocked
        return allowAuthorization('custom-signer')
      },
      'task.enqueue',
      source,
      bodyText,
    )

    source.headers.set('x-test', 'after')
    expect(source.bodyUsed).toBe(false)
    await expect(source.clone().text()).resolves.toBe(bodyText)
    if (release === undefined) throw new Error('plugin did not start')
    release()
    await expect(pending).resolves.toEqual({ principal: 'custom-signer' })
    if (facts === undefined) throw new Error('facts were not captured')

    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts.headers)).toBe(true)
    expect('set' in facts.headers).toBe(false)
    expect(facts).toMatchObject({
      operation: 'task.enqueue',
      method: 'POST',
      url: 'https://alpha.example/api/tasks?view=full',
      bodyText,
    })
    expect(facts.headers.get('x-test')).toBe('before')
    const visits: string[] = []
    facts.headers.forEach((value, name, parent) => {
      expect(parent).toBe(facts?.headers)
      visits.push(`${name}:${value}`)
    })
    expect(visits).toContain('x-test:before')
  })

  it('maps explicit denials and plugin failures to stable fail-closed router errors', async () => {
    const unauthenticated = await expectAuthorizationError(
      authorizeHostedRequest(() => denyAuthorization(), 'event.emit', request(), '{}'),
    )
    expect(unauthenticated).toMatchObject({ code: 'unauthenticated', httpStatus: 401 })

    const forbidden = await expectAuthorizationError(
      authorizeHostedRequest(() => denyAuthorization('forbidden'), 'task.inspect', request(), ''),
    )
    expect(forbidden).toMatchObject({ code: 'forbidden', httpStatus: 403 })

    const pluginCause = new Error('private backend detail')
    const failed = await expectAuthorizationError(
      authorizeHostedRequest(
        () => {
          throw pluginCause
        },
        'tick.run',
        request(),
        '',
      ),
    )
    expect(failed).toMatchObject({ code: 'plugin-failure', httpStatus: 503 })
    expect(failed.message).not.toContain(pluginCause.message)
    expect(failed.cause).toBe(pluginCause)
  })

  it('rejects malformed decisions and unknown runtime operations', async () => {
    const malformed = (() => ({
      kind: 'allow',
      principal: 42,
    })) as unknown as HostedAuthorizationPlugin
    const invalidDecision = await expectAuthorizationError(
      authorizeHostedRequest(malformed, 'task.enqueue', request(), '{}'),
    )
    expect(invalidDecision).toMatchObject({ code: 'invalid-decision', httpStatus: 500 })

    const invalidOperation = await expectAuthorizationError(
      authorizeHostedRequest(() => allowAuthorization(), 'task.delete' as never, request(), ''),
    )
    expect(invalidOperation).toMatchObject({ code: 'invalid-operation', httpStatus: 500 })
  })

  it('cannot widen the runtime operation authority through its exported list', async () => {
    const operations = HOSTED_AUTHORIZATION_OPERATIONS as unknown as string[]
    let widened = false
    try {
      try {
        operations.push('task.delete')
        widened = true
      } catch {
        // The intended frozen representation rejects the mutation here.
      }

      const error = await expectAuthorizationError(
        authorizeHostedRequest(
          () => allowAuthorization('admin'),
          'task.delete' as never,
          request(),
          '',
        ),
      )
      expect(error).toMatchObject({ code: 'invalid-operation', httpStatus: 500 })
      expect(Object.isFrozen(HOSTED_AUTHORIZATION_OPERATIONS)).toBe(true)
    } finally {
      // Keep the deliberately buggy red run from contaminating later cases.
      if (widened) operations.pop()
    }
  })

  it('accepts only the exact bearer token through a fixed-length timing-safe comparison', async () => {
    const plugin = bearerAuthorization({ token: 'short-secret', principal: 'cron' })
    await expect(
      authorizeHostedRequest(plugin, 'tick.run', request('bEaReR short-secret'), ''),
    ).resolves.toEqual({ principal: 'cron' })

    for (const authorization of [
      undefined,
      'Basic short-secret',
      'Bearer ',
      'Bearer short',
      'Bearer short-secret-extra',
      'Bearer short-secret,Bearer short-secret',
    ]) {
      const error = await expectAuthorizationError(
        authorizeHostedRequest(plugin, 'tick.run', request(authorization), ''),
      )
      expect(error).toMatchObject({ code: 'unauthenticated', httpStatus: 401 })
    }
    expect(() => bearerAuthorization({ token: '' })).toThrow('non-empty string')
  })

  it('anyOf authorizes an explicit success but never turns errors into implicit success', async () => {
    const backendFailure = new Error('identity service unavailable')
    const allowed = anyOfAuthorization(
      () => {
        throw backendFailure
      },
      () => denyAuthorization('forbidden'),
      () => allowAuthorization('fallback-identity'),
    )
    await expect(authorizeHostedRequest(allowed, 'event.emit', request(), '{}')).resolves.toEqual({
      principal: 'fallback-identity',
    })

    const unavailable = await expectAuthorizationError(
      authorizeHostedRequest(
        anyOfAuthorization(
          () => denyAuthorization(),
          () => {
            throw backendFailure
          },
        ),
        'event.emit',
        request(),
        '{}',
      ),
    )
    expect(unavailable).toMatchObject({ code: 'plugin-failure', httpStatus: 503 })

    const allDenied = await expectAuthorizationError(
      authorizeHostedRequest(
        anyOfAuthorization(
          () => denyAuthorization(),
          () => denyAuthorization('forbidden'),
        ),
        'event.emit',
        request(),
        '{}',
      ),
    )
    expect(allDenied).toMatchObject({ code: 'forbidden', httpStatus: 403 })

    const empty = await expectAuthorizationError(
      authorizeHostedRequest(anyOfAuthorization(), 'event.emit', request(), '{}'),
    )
    expect(empty).toMatchObject({ code: 'unauthenticated', httpStatus: 401 })
  })

  it('routes every semantic operation through an exhaustive snapshotted map', async () => {
    const calls: string[] = []
    const plugin =
      (label: string): HostedAuthorizationPlugin =>
      (facts) => {
        calls.push(`${label}:${facts.operation}`)
        return allowAuthorization(label)
      }
    const mapping = {
      'task.enqueue': plugin('enqueue'),
      'event.emit': plugin('emit'),
      'tick.run': plugin('tick'),
      'task.inspect': plugin('inspect'),
    }
    const byOperation = authorizationByOperation(mapping)

    for (const operation of HOSTED_AUTHORIZATION_OPERATIONS) {
      await authorizeHostedRequest(byOperation, operation, request(), '')
    }
    expect(calls).toEqual([
      'enqueue:task.enqueue',
      'emit:event.emit',
      'tick:tick.run',
      'inspect:task.inspect',
    ])

    mapping['tick.run'] = () => denyAuthorization()
    await expect(authorizeHostedRequest(byOperation, 'tick.run', request(), '')).resolves.toEqual({
      principal: 'tick',
    })

    expect(() =>
      authorizationByOperation({
        'task.enqueue': plugin('enqueue'),
      } as never),
    ).toThrow('authorization plugin missing for event.emit')
  })
})
