import { describe, expect, it } from 'vitest'
import { systemClock } from '../src/index.js'

async function replaceMethodAndCount(
  target: object,
  key: PropertyKey,
  action: () => Promise<unknown> | unknown,
): Promise<number> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor === undefined || typeof descriptor.value !== 'function') {
    throw new Error(`expected method ${String(key)}`)
  }
  const original = descriptor.value as CallableFunction
  let calls = 0
  Object.defineProperty(target, key, {
    ...descriptor,
    value: function (this: unknown, ...args: unknown[]) {
      calls++
      if (new.target !== undefined) return Reflect.construct(original, args, original)
      return Reflect.apply(original, this, args)
    },
  })
  try {
    await action()
  } finally {
    Object.defineProperty(target, key, descriptor)
  }
  return calls
}

async function replaceGetterAndCount(
  target: object,
  key: PropertyKey,
  action: () => Promise<unknown> | unknown,
): Promise<number> {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor?.get === undefined) throw new Error(`expected getter ${String(key)}`)
  const original = descriptor.get
  let calls = 0
  Object.defineProperty(target, key, {
    ...descriptor,
    get: function (this: unknown) {
      calls++
      return Reflect.apply(original, this, [])
    },
  })
  try {
    await action()
  } finally {
    Object.defineProperty(target, key, descriptor)
  }
  return calls
}

describe('systemClock captured intrinsics', () => {
  const clock = systemClock()

  it('captures Date.now', async () => {
    const calls = await replaceMethodAndCount(Date, 'now', () => clock.nowEpochMs())
    expect(calls, 'mutation-verdict:construction:system-clock-captured-date-now').toBe(0)
  })

  it('captures the Promise constructor', async () => {
    const calls = await replaceMethodAndCount(globalThis, 'Promise', () => clock.sleep(0))
    expect(calls, 'mutation-verdict:construction:system-clock-captured-promise').toBe(0)
  })

  it('captures the Promise constructor for yieldTurn', async () => {
    const calls = await replaceMethodAndCount(globalThis, 'Promise', () => clock.yieldTurn())
    expect(calls, 'mutation-verdict:construction:system-clock-captured-yield-promise').toBe(0)
  })

  it('captures setImmediate', async () => {
    const calls = await replaceMethodAndCount(globalThis, 'setImmediate', () => clock.yieldTurn())
    expect(calls, 'mutation-verdict:construction:system-clock-captured-set-immediate').toBe(0)
  })

  it('captures Math.max', async () => {
    const calls = await replaceMethodAndCount(Math, 'max', () => clock.sleep(0))
    expect(calls, 'mutation-verdict:construction:system-clock-captured-math-max').toBe(0)
  })

  it('captures setTimeout', async () => {
    const calls = await replaceMethodAndCount(globalThis, 'setTimeout', () => clock.sleep(0))
    expect(calls, 'mutation-verdict:construction:system-clock-captured-set-timeout').toBe(0)
  })

  it('captures clearTimeout', async () => {
    const calls = await replaceMethodAndCount(globalThis, 'clearTimeout', () => clock.sleep(0))
    expect(calls, 'mutation-verdict:construction:system-clock-captured-clear-timeout').toBe(0)
  })

  it('captures AbortSignal.aborted', async () => {
    const controller = new AbortController()
    const calls = await replaceGetterAndCount(AbortSignal.prototype, 'aborted', () =>
      clock.sleep(0, controller.signal),
    )
    expect(calls, 'mutation-verdict:construction:system-clock-captured-aborted-getter').toBe(0)
  })

  it('captures abort listener registration', async () => {
    const controller = new AbortController()
    const calls = await replaceMethodAndCount(EventTarget.prototype, 'addEventListener', () =>
      clock.sleep(0, controller.signal),
    )
    expect(calls, 'mutation-verdict:construction:system-clock-captured-add-listener').toBe(0)
  })

  it('captures abort listener cleanup', async () => {
    const controller = new AbortController()
    const calls = await replaceMethodAndCount(EventTarget.prototype, 'removeEventListener', () =>
      clock.sleep(0, controller.signal),
    )
    expect(calls, 'mutation-verdict:construction:system-clock-captured-remove-listener').toBe(0)
  })
})
