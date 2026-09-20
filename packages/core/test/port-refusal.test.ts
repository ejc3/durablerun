import { describe, expect, it } from 'vitest'
import {
  ChildAwaitRefusedError,
  InvalidDurableStringError,
  PortRefusalError,
  isPortRefusal,
  refuseReservedEventName,
  refuseReservedIdempotencyKey,
  spawnIdempotencyKey,
} from '../src/index.js'

function thrownBy(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  throw new Error('the call was not refused')
}

describe("a port's refusal of what its caller passed", () => {
  it('is a RangeError with a name of its own, wherever core refuses a name, a key, or a pair of options', () => {
    const childOf = {
      parentQueue: 'q',
      parentTaskId: 'parent',
      runId: 'r1',
      claimToken: 'tok',
      replayKey: '$spawn:child',
    }
    const refusals = {
      'a reserved event name': thrownBy(() =>
        refuseReservedEventName('emitEvent', '$task-done:t1'),
      ),
      'an event name that is not a string': thrownBy(() =>
        refuseReservedEventName('emitEvent', 7 as unknown as string),
      ),
      'a reserved idempotency key': thrownBy(() => refuseReservedIdempotencyKey('spawn', '$mine')),
      'a key together with childOf': thrownBy(() =>
        spawnIdempotencyKey({ idempotencyKey: 'mine', childOf }),
      ),
    }
    expect(
      Object.fromEntries(
        Object.entries(refusals).map(([kind, error]) => [
          kind,
          {
            name: error instanceof Error ? error.name : String(error),
            isARangeError: error instanceof RangeError,
            isTheClass: error instanceof PortRefusalError,
          },
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.keys(refusals).map((kind) => [
          kind,
          { name: 'PortRefusalError', isARangeError: true, isTheClass: true },
        ]),
      ),
    )
  })

  it('names its whole family in one predicate, and no other error', () => {
    expect({
      refusal: isPortRefusal(new PortRefusalError('a reserved key')),
      durableString: isPortRefusal(new InvalidDurableStringError('a NUL')),
      childAwait: isPortRefusal(new ChildAwaitRefusedError('child', 'other-queue')),
      bareRangeError: isPortRefusal(new RangeError('a stored row that cannot be read')),
      bareTypeError: isPortRefusal(new TypeError('a defect')),
      plainError: isPortRefusal(new Error('anything')),
      notAnError: isPortRefusal({ name: 'PortRefusalError' }),
    }).toEqual({
      refusal: true,
      durableString: true,
      childAwait: true,
      bareRangeError: false,
      bareTypeError: false,
      plainError: false,
      notAnError: false,
    })
  })
})
