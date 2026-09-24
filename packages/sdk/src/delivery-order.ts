import {
  TaskMap,
  TaskPromise,
  taskMapDelete,
  taskMapGet,
  taskMapHas,
  taskMapSet,
} from './intrinsics.js'

/** How many numbers the queue keeps behind its head before it drops them. */
const COMPACT_AT = 1024

/**
 * The order in which a pass hands the results of durable calls to the task function
 * (DESIGN.md section 3.2). Two calls that are pending together can be answered in either
 * order, and the order decides which call the task makes next. A replay answers a memoized
 * call as soon as it is made, so it can answer the same two calls in the other order, and a
 * repeated name (`rec`, `rec#2`) then goes to the other flow. The order the first pass
 * answered them in is recorded, and a replay answers in that order.
 *
 * Each result that reaches the task has a sequence number. A result that a previous pass
 * recorded has the number that pass gave it; a result this pass produces takes the next
 * number. A result is handed over only when every lower number has been handed over, so the
 * numbers are a queue, and this class is that queue and nothing else. It holds no store
 * calls and no names.
 *
 * A result that was recorded is followed by a turn of the event loop before the next one is
 * handed over. What the task does with a result, up to its next durable call, is a chain of
 * promise turns, and a first pass gave every chain the time a store call takes before the next
 * result arrived. A replay that handed the next result over in the same turn would let a chain
 * that is one turn shorter make its call first.
 */
export class DeliveryOrder {
  /** Every number, in ascending order, from some that were handed over to the first that was not. */
  #queue: number[] = []
  #head = 0
  /** Every number below this was handed over or given up, and the queue no longer holds it. */
  #floor = 0
  /** A number at or above the floor that was handed over or given up. */
  readonly #done = new TaskMap<number, true>()
  /** The call waiting for its number's turn. */
  readonly #waiting = new TaskMap<number, () => void>()
  /** Every call that waits, for `open`. */
  #resolvers: (() => void)[] = []
  /** How many calls wait for a number that is not their turn. */
  #waitingCount = 0
  #open = false
  #endedBy: object | undefined
  #next: number
  /** The first number this pass gave: every number below it was recorded by an earlier pass. */
  readonly #firstLive: number
  /** A result was handed over and the event loop has not turned since. */
  #settling = false
  /** A real turn of the event loop, once the worker has said how (the clock's `yieldTurn`). */
  #turn: (() => Promise<void>) | undefined
  /** How many results have been handed over or given up: the stall watchdog's sign of life. */
  #progress = 0
  #beatProgress = 0

  /**
   * `recorded` holds the numbers of the results the store has, in ascending order, and
   * `highest` the highest number any order marker names, so a number is never used twice.
   */
  constructor(recorded: readonly number[], highest: number) {
    for (let at = 0; at < recorded.length; at++) {
      const seq = recorded[at]
      if (seq !== undefined) this.#queue[this.#queue.length] = seq
    }
    this.#next = highest + 1
    this.#firstLive = highest + 1
  }

  /** The next number: for a result this pass produces, queued behind every result before it. */
  assign(): number {
    const seq = this.#next++
    this.#queue[this.#queue.length] = seq
    return seq
  }

  /** The next number, for a result that is never queued: a sleep, which ends the pass. */
  reserve(): number {
    return this.#next++
  }

  private advance(): void {
    while (this.#head < this.#queue.length) {
      const seq = this.#queue[this.#head]
      if (seq === undefined || !taskMapHas(this.#done, seq)) break
      taskMapDelete(this.#done, seq)
      this.#floor = seq + 1
      this.#head++
    }
    // A task that makes one call at a time queues every number and hands each over, so
    // what has been handed over is dropped, and the queue is as long as the calls pending.
    if (this.#head >= COMPACT_AT) {
      const rest: number[] = []
      for (let at = this.#head; at < this.#queue.length; at++) {
        const seq = this.#queue[at]
        if (seq !== undefined) rest[rest.length] = seq
      }
      this.#queue = rest
      this.#head = 0
    }
  }

  /** Whether `seq` has been handed over or given up. */
  private isDone(seq: number): boolean {
    return seq < this.#floor || taskMapHas(this.#done, seq)
  }

  /** Whether it is `seq`'s turn: every lower number is done, and the event loop has turned since the last. */
  private isTurn(seq: number): boolean {
    this.advance()
    return this.#queue[this.#head] === seq && !this.#settling
  }

  /** Resolves when it is `seq`'s turn, and is undefined when it is already. */
  wait(seq: number): Promise<void> | undefined {
    if (this.#open || this.isDone(seq) || this.isTurn(seq)) return undefined
    this.#waitingCount++
    return new TaskPromise<void>((resolve) => {
      let woken = false
      const wake = () => {
        if (woken) return
        woken = true
        this.#waitingCount--
        resolve()
      }
      taskMapSet(this.#waiting, seq, wake)
      this.#resolvers[this.#resolvers.length] = wake
    })
  }

  /**
   * `seq` is handed over. When it was recorded (`settle`), the next number's call waits for
   * a turn of the event loop first.
   */
  release(seq: number, settle: boolean): void {
    taskMapSet(this.#done, seq, true)
    this.#progress++
    const turn = this.#turn
    if (settle && turn !== undefined) {
      this.#settling = true
      void this.settleAfter(turn)
      return
    }
    this.wake()
  }

  private async settleAfter(turn: () => Promise<void>): Promise<void> {
    await turn()
    this.#settling = false
    this.wake()
  }

  /** How this order takes a real turn of the event loop. Without it a result is followed by none. */
  useTurn(turn: () => Promise<void>): void {
    this.#turn = turn
  }

  /** The turn the order takes between two results, when it takes one. */
  get turn(): (() => Promise<void>) | undefined {
    return this.#turn
  }

  /** The infrastructure error that ended the pass for the flows of its task, if one did. */
  get endedBy(): object | undefined {
    return this.#endedBy
  }

  /** The pass is over for its flows: `error` is the first that said so, and every call goes. */
  end(error: object): void {
    this.#endedBy ??= error
    this.open()
  }

  /**
   * Let every call go, now and from here on, in no order. The pass cannot go on, so what it
   * hands its task is followed by the error that ended it, at the task's next durable call.
   */
  open(): void {
    this.#open = true
    const resolvers = this.#resolvers
    this.#resolvers = []
    for (let at = 0; at < resolvers.length; at++) resolvers[at]?.()
  }

  /** `seq` will not be handed over: its call failed. The calls behind it must not wait for it. */
  abandon(seq: number): void {
    this.release(seq, false)
  }

  private wake(): void {
    this.advance()
    if (this.#settling) return
    const seq = this.#queue[this.#head]
    if (seq === undefined) return
    const resolve = taskMapGet(this.#waiting, seq)
    if (resolve === undefined) return
    taskMapDelete(this.#waiting, seq)
    resolve()
  }

  /** Whether a call waits for a number that is not its turn. */
  get stalled(): boolean {
    return this.#waitingCount > 0
  }

  /** How many numbers the queue holds: the calls pending, and some that were handed over and not yet dropped. */
  get size(): number {
    return this.#queue.length
  }

  /** Whether a result is waiting to be handed over, or one was handed over in this turn of the event loop. */
  get busy(): boolean {
    return this.#settling || this.stalled
  }

  /**
   * One beat of the pass's heartbeat. A pass that has handed over nothing since the last
   * beat, and has a call waiting for a number nobody has made the call for, gives up on that
   * number. A task function that is a function of its parameters and its attempt makes every
   * call a first pass recorded, so this fires for a task that is not (a step named after
   * something a first pass read from the clock) and for one that does not repeat a call
   * because its attempt differs (a step named after `ctx.attempt`), and it lets the pass go on.
   */
  beat(): void {
    const stuck = this.stalled && this.#progress === this.#beatProgress
    this.#beatProgress = this.#progress
    if (stuck) this.giveUpOnHead()
  }

  /**
   * Give up on the lowest number nobody is waiting for, and wake the call behind it. The
   * task never made the call that number was recorded for, and a pass that waited for it
   * would wait for ever. A number this pass gave is a call that is running, and it hands
   * its result over or fails, so it is never given up. Answers whether a number was given up.
   */
  giveUpOnHead(): boolean {
    this.advance()
    const seq = this.#queue[this.#head]
    if (seq === undefined || seq >= this.#firstLive || taskMapHas(this.#waiting, seq)) return false
    this.abandon(seq)
    return true
  }
}

const orders = new WeakMap<object, DeliveryOrder>()

/** Let the worker that runs a context reach the context's order without the context's interface holding it. */
export function bindOrder(owner: object, order: DeliveryOrder): void {
  orders.set(owner, order)
}

/** The error that ended the pass for the flows of `owner`'s task, or undefined. */
export function endedBy(owner: object): object | undefined {
  return orders.get(owner)?.endedBy
}

/** The worker says how a real turn of the event loop is taken: the clock's `yieldTurn`. */
export function bindTurn(owner: object, turn: () => Promise<void>): void {
  orders.get(owner)?.useTurn(turn)
}

/** One beat of the heartbeat, for the order of `owner`, when it has one. */
export function beatOrder(owner: object): void {
  orders.get(owner)?.beat()
}

/** The pass cannot go on: no call waits for another, from here on. */
export function openOrder(owner: object): void {
  orders.get(owner)?.open()
}

/** Resolves when no result of `owner`'s replay waits for its turn, so what the replay registered is all it will. */
export async function replaySettled(owner: object): Promise<void> {
  const order = orders.get(owner)
  const turn = order?.turn
  while (order?.busy === true && turn !== undefined) await turn()
}
