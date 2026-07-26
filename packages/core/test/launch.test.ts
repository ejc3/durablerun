import { describe, expect, it, vi } from 'vitest'
import { LaunchOutcome, type SchedulerStore } from '../src/index.js'

function store() {
  const expireLeaseNow = vi.fn(async () => true)
  return {
    expireLeaseNow,
    value: { expireLeaseNow } as unknown as SchedulerStore,
  }
}

describe('LaunchOutcome runtime authentication', () => {
  it('turns a throwing ending getter into a failed launch without throwing', async () => {
    const ending = new Proxy(
      {},
      {
        get(): never {
          throw new Error('hostile getter')
        },
      },
    )

    let outcome: LaunchOutcome | undefined
    expect(() => {
      outcome = LaunchOutcome.ended(ending as never)
    }).not.toThrow()

    const fake = store()
    expect(
      await LaunchOutcome.reconcile(
        fake.value,
        'q',
        { runId: 'run', claimToken: 'token' },
        outcome,
      ),
    ).toBe('launch-failed')
    expect(fake.expireLeaseNow).toHaveBeenCalledOnce()
  })

  it('snapshots every ending field exactly once before authentication', () => {
    const reads = { runId: 0, claimToken: 0, kind: 0 }
    const ending = {
      get runId() {
        reads.runId++
        return 'run'
      },
      get claimToken() {
        reads.claimToken++
        return 'token'
      },
      get kind() {
        reads.kind++
        return 'crashed' as const
      },
    }

    expect(() => LaunchOutcome.ended(ending)).not.toThrow()
    expect(reads).toEqual({ runId: 1, claimToken: 1, kind: 1 })
  })

  it('does not expose the authentication registry as a class property', () => {
    expect(Object.hasOwn(LaunchOutcome, 'payloads')).toBe(false)
    expect((LaunchOutcome as unknown as { payloads?: unknown }).payloads).toBeUndefined()
  })
})
