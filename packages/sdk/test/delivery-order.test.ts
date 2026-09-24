import { describe, expect, it } from 'vitest'
import { DeliveryOrder } from '../src/delivery-order.js'

/** A turn of the event loop, after every promise callback that is queued now. */
const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('the order results reach the task in (DeliveryOrder)', () => {
  it('hands recorded results over in ascending order whatever order their calls come in', async () => {
    const order = new DeliveryOrder([1, 2, 3], 3)
    const handed: number[] = []
    const take = async (seq: number) => {
      const turn = order.wait(seq)
      if (turn !== undefined) await turn
      handed.push(seq)
      order.release(seq, false)
    }
    await Promise.all([take(3), take(1), take(2)])
    expect(handed).toEqual([1, 2, 3])
  })

  it('queues a result the pass produces behind every recorded one, with the next number', async () => {
    const order = new DeliveryOrder([2, 5], 5)
    const live = order.assign()
    expect(live).toBe(6)
    expect(order.wait(live)).toBeInstanceOf(Promise)
    order.release(2, false)
    order.release(5, false)
    expect(order.wait(live)).toBeUndefined()
  })

  it('makes the next result wait for a turn of the event loop after a recorded one, and not after another', async () => {
    const order = new DeliveryOrder([1, 2, 3], 3)
    order.useTurn(macrotask)
    order.release(1, true)
    const settling = order.wait(2)
    expect(settling).toBeInstanceOf(Promise)
    let woke = false
    void settling?.then(() => {
      woke = true
    })
    await Promise.resolve()
    expect(woke, 'the same turn').toBe(false)
    await macrotask()
    await macrotask()
    expect(woke, 'a later turn').toBe(true)
    order.release(2, false)
    expect(order.wait(3), 'no turn is owed after a result that was not recorded').toBeUndefined()
  })

  it('takes no turn of the event loop where the worker gave it none', async () => {
    const order = new DeliveryOrder([1, 2], 2)
    order.release(1, true)
    expect(order.wait(2)).toBeUndefined()
  })

  it('does not make a call that failed hold up the calls behind it, and answers at once for a number given up', async () => {
    const order = new DeliveryOrder([1, 2], 2)
    const behind = order.wait(2)
    expect(behind).toBeInstanceOf(Promise)
    order.abandon(1)
    await behind
    expect(
      order.wait(1),
      'mutation-verdict:behavior:a-number-given-up-is-answered-at-once',
    ).toBeUndefined()
  })

  it('gives up on a recorded number nobody asks for when a beat finds nothing handed over since the last', async () => {
    const order = new DeliveryOrder([1, 2, 3], 3)
    const behind = order.wait(3)
    let woke = false
    void behind?.then(() => {
      woke = true
    })
    // The call for 1 comes and is handed over in its turn: a sign of life.
    order.release(1, false)
    order.beat()
    await macrotask()
    expect(woke, 'mutation-verdict:behavior:a-beat-that-saw-results-handed-over-is-not-stuck').toBe(
      false,
    )
    order.beat()
    await macrotask()
    expect(woke, 'a beat that sees none finds the pass stuck, and 2 is given up').toBe(true)
  })

  it('never gives up on a number that has a call waiting, or when no call waits', async () => {
    const idle = new DeliveryOrder([1, 2], 2)
    idle.beat()
    idle.beat()
    expect(idle.giveUpOnHead(), 'no call waits, so a beat gave up on nothing').toBe(true)
    const settling = new DeliveryOrder([1, 2], 2)
    settling.useTurn(macrotask)
    settling.release(1, true)
    void settling.wait(2)
    expect(
      settling.giveUpOnHead(),
      'mutation-verdict:behavior:a-number-a-call-waits-for-is-not-given-up',
    ).toBe(false)
  })

  it('never gives up on a number the pass gave, which is a call that is running', async () => {
    const order = new DeliveryOrder([1], 1)
    const running = order.assign()
    const behind = order.assign()
    void order.wait(behind)
    order.release(1, false)
    order.beat()
    order.beat()
    expect(running).toBe(2)
    expect(
      order.giveUpOnHead(),
      'mutation-verdict:behavior:a-number-the-pass-gave-is-never-given-up',
    ).toBe(false)
  })

  it('lets every call go, now and after, once the pass cannot go on', async () => {
    const order = new DeliveryOrder([1, 2, 3], 3)
    const behind = order.wait(3)
    expect(behind).toBeInstanceOf(Promise)
    order.open()
    await behind
    expect(
      order.wait(2),
      'mutation-verdict:behavior:an-open-order-lets-every-call-go',
    ).toBeUndefined()
  })

  it('keeps its queue as long as the calls that are pending when a task makes one call at a time', async () => {
    const order = new DeliveryOrder([], 0)
    for (let call = 0; call < 5000; call++) {
      const seq = order.assign()
      expect(order.wait(seq)).toBeUndefined()
      order.release(seq, false)
    }
    const last = order.assign()
    expect(order.wait(last)).toBeUndefined()
    expect(
      order.size,
      'mutation-verdict:behavior:the-order-queue-drops-what-it-handed-over',
    ).toBeLessThan(2000)
  })
})
