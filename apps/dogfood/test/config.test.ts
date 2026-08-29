import { describe, expect, it } from 'vitest'
import { dogfoodConfigFromEnv } from '../src/config.js'

describe('dogfood configuration', () => {
  it('has a safe local default and the seven-day journal shape', () => {
    expect(dogfoodConfigFromEnv({})).toEqual({
      databaseUrl: 'file:dogfood.db',
      queue: 'dogfood',
      idempotencyKey: 'ref-journal-v1',
      repository: 'ejc3/durablerun',
      ref: 'main',
      cycles: 15,
      intervalSeconds: 43_200,
      leaseSeconds: 30,
      fault: 'none',
    })
    const config = dogfoodConfigFromEnv({})
    expect((config.cycles - 1) * config.intervalSeconds).toBeGreaterThanOrEqual(7 * 24 * 60 * 60)
  })

  it('uses the shared Turso credential names without requiring a local token', () => {
    expect(
      dogfoodConfigFromEnv({
        TURSO_DATABASE_URL: 'libsql://dogfood.example',
        TURSO_AUTH_TOKEN: 'secret',
      }),
    ).toMatchObject({
      databaseUrl: 'libsql://dogfood.example',
      authToken: 'secret',
    })
    expect(dogfoodConfigFromEnv({ TURSO_AUTH_TOKEN: '  ' })).not.toHaveProperty('authToken')
  })

  it('rejects vacuous or noncanonical cycle settings', () => {
    expect(() => dogfoodConfigFromEnv({ DURABLERUN_DOGFOOD_CYCLES: '0' })).toThrow(/at least 1/)
    expect(() => dogfoodConfigFromEnv({ DURABLERUN_DOGFOOD_CYCLES: '01' })).toThrow(/canonical/)
    expect(() => dogfoodConfigFromEnv({ DURABLERUN_DOGFOOD_FAULT: 'maybe' })).toThrow(
      /supported fault/,
    )
  })
})
