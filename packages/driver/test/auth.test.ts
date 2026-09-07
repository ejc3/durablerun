import { describe, expect, it } from 'vitest'
import {
  HostedAuthorizationError,
  type HostedAuthorizationFacts,
  type HostedAuthorizationPlugin,
  allowAuthorization,
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
  it('passes a detached native request snapshot with the exact raw body text', async () => {
    const bodyText = '{\n  "snow": "☃", "spaces":  true\n}\n'
    const source = new Request('https://alpha.example/api/tasks?view=full', {
      method: 'POST',
      headers: { 'x-test': 'before' },
      body: bodyText,
    })
    let facts: HostedAuthorizationFacts | undefined
    const grant = await authorizeHostedRequest(
      (snapshot) => {
        facts = snapshot
        return allowAuthorization('custom-signer')
      },
      'task.enqueue',
      source,
      bodyText,
    )

    expect(grant).toEqual({ principal: 'custom-signer' })
    expect(source.bodyUsed).toBe(false)
    await expect(source.clone().text()).resolves.toBe(bodyText)
    if (facts === undefined) throw new Error('facts were not captured')
    expect(facts).toMatchObject({
      operation: 'task.enqueue',
      method: 'POST',
      url: 'https://alpha.example/api/tasks?view=full',
      bodyText,
    })
    expect(facts.headers).toBeInstanceOf(Headers)
    expect(facts.headers.get('x-test')).toBe('before')
    facts.headers.set('x-test', 'plugin-local')
    expect(source.headers.get('x-test')).toBe('before')
  })

  it('maps denials, failures, malformed decisions, and unknown operations closed', async () => {
    const unauthenticated = await expectAuthorizationError(
      authorizeHostedRequest(() => denyAuthorization(), 'event.emit', request(), '{}'),
    )
    expect(unauthenticated).toMatchObject({ code: 'unauthenticated', httpStatus: 401 })

    const forbidden = await expectAuthorizationError(
      authorizeHostedRequest(() => denyAuthorization('forbidden'), 'task.inspect', request(), ''),
    )
    expect(forbidden).toMatchObject({ code: 'forbidden', httpStatus: 403 })

    const pluginCause = new Error('private backend detail')
    const unavailable = await expectAuthorizationError(
      authorizeHostedRequest(
        () => {
          throw pluginCause
        },
        'tick.run',
        request(),
        '',
      ),
    )
    expect(unavailable).toMatchObject({ code: 'plugin-failure', httpStatus: 503 })
    expect(unavailable.message).not.toContain(pluginCause.message)
    expect(unavailable.cause).toBe(pluginCause)

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

  it('accepts each route-owned operation through one plugin shape', async () => {
    const seen: string[] = []
    const plugin: HostedAuthorizationPlugin = (facts) => {
      seen.push(facts.operation)
      return allowAuthorization()
    }
    for (const operation of ['task.enqueue', 'event.emit', 'tick.run', 'task.inspect'] as const) {
      await expect(authorizeHostedRequest(plugin, operation, request(), '')).resolves.toEqual({})
    }
    expect(seen).toEqual(['task.enqueue', 'event.emit', 'tick.run', 'task.inspect'])
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
})
