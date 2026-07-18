import type { SqlExecutor, SqlResult, SqlStatement } from '@absurd-lite/core'
import { Rng } from './rng.js'

/**
 * Deterministic simulation world (BUILD.md PR1.3).
 *
 * Actors are async functions whose ONLY awaits are `batch()` calls on the
 * SqlExecutor this world hands them. The world serializes those calls —
 * a seeded scheduler picks which pending batch executes next against the
 * real database — so every interleaving of N concurrent actors is (a)
 * reachable and (b) exactly replayable from the seed. Crash injection kills
 * an actor before or after a chosen labeled batch, modeling process death at
 * any transition boundary; a crashed actor's later calls reject immediately.
 *
 * Determinism contract: actor code between port calls must be synchronous
 * and deterministic (no timers, no Date.now/Math.random, no other I/O).
 */

export class SimCrash extends Error {
  override readonly name = 'SimCrash'
  constructor(
    readonly actor: string,
    readonly label: string,
    readonly when: 'before' | 'after',
  ) {
    super(`simulated crash: ${actor} ${when} '${label}'`)
  }
}

export interface CrashSpec {
  /** Restrict to one actor; matches any actor when omitted. */
  actor?: string
  label: string | RegExp
  /** 1-based occurrence of a matching batch (per spec), default 1. */
  occurrence?: number
  when: 'before' | 'after'
}

export interface TraceEntry {
  seq: number
  actor: string
  label: string
  outcome: 'ok' | 'crash-before' | 'crash-after' | 'error'
}

export type ActorResult =
  | { status: 'done' }
  | { status: 'crashed'; crash: SimCrash }
  | { status: 'failed'; error: unknown }

interface PendingCall {
  actor: ActorState
  label: string
  statements: readonly SqlStatement[]
  resolve: (r: SqlResult[]) => void
  reject: (e: unknown) => void
}

interface ActorState {
  name: string
  crashed: boolean
  finished: Promise<ActorResult>
}

interface ArmedCrash extends CrashSpec {
  remaining: number
  consumed: boolean
}

export class SimWorld {
  private readonly rng: Rng
  private readonly pending: PendingCall[] = []
  private readonly actors: ActorState[] = []
  private readonly crashes: ArmedCrash[] = []
  readonly trace: TraceEntry[] = []

  constructor(
    private readonly real: SqlExecutor,
    seed: number | string,
  ) {
    this.rng = new Rng(seed)
  }

  injectCrash(spec: CrashSpec): void {
    this.crashes.push({ ...spec, remaining: spec.occurrence ?? 1, consumed: false })
  }

  actor(name: string, fn: (db: SqlExecutor) => Promise<void>): void {
    const state: ActorState = {
      name,
      crashed: false,
      finished: Promise.resolve({ status: 'done' }),
    }
    const db: SqlExecutor = {
      batch: (label, statements) => {
        if (state.crashed) return Promise.reject(new SimCrash(name, label, 'before'))
        return new Promise<SqlResult[]>((resolve, reject) => {
          this.pending.push({ actor: state, label, statements, resolve, reject })
        })
      },
    }
    state.finished = fn(db).then(
      (): ActorResult => ({ status: 'done' }),
      (error: unknown): ActorResult =>
        error instanceof SimCrash
          ? { status: 'crashed', crash: error }
          : { status: 'failed', error },
    )
    this.actors.push(state)
  }

  /**
   * Run until quiescent: no pending batch and no actor able to produce one.
   * Throws if any actor FAILED (non-crash error) — crashes are expected
   * outcomes, failures are bugs (in the engine or the scenario).
   */
  async run(): Promise<Map<string, ActorResult>> {
    for (;;) {
      await settle()
      if (this.pending.length === 0) break
      const idx = this.rng.int(this.pending.length)
      const call = this.pending.splice(idx, 1)[0]
      if (!call) continue
      await this.executeCall(call)
    }
    const results = new Map<string, ActorResult>()
    for (const actor of this.actors) {
      const result = await actor.finished
      results.set(actor.name, result)
      if (result.status === 'failed') {
        throw new Error(`actor '${actor.name}' failed: ${String(result.error)}`, {
          cause: result.error,
        })
      }
    }
    return results
  }

  private async executeCall(call: PendingCall): Promise<void> {
    const crash = this.matchCrash(call)
    if (crash?.when === 'before') {
      call.actor.crashed = true
      this.record(call, 'crash-before')
      call.reject(new SimCrash(call.actor.name, call.label, 'before'))
      return
    }
    let results: SqlResult[]
    try {
      results = await this.real.batch(call.label, call.statements)
    } catch (error) {
      this.record(call, 'error')
      call.reject(error)
      return
    }
    if (crash?.when === 'after') {
      call.actor.crashed = true
      this.record(call, 'crash-after')
      call.reject(new SimCrash(call.actor.name, call.label, 'after'))
      return
    }
    this.record(call, 'ok')
    call.resolve(results)
  }

  private matchCrash(call: PendingCall): ArmedCrash | undefined {
    for (const crash of this.crashes) {
      if (crash.consumed) continue
      if (crash.actor !== undefined && crash.actor !== call.actor.name) continue
      const matches =
        typeof crash.label === 'string' ? crash.label === call.label : crash.label.test(call.label)
      if (!matches) continue
      crash.remaining -= 1
      if (crash.remaining > 0) continue
      crash.consumed = true
      return crash
    }
    return undefined
  }

  private record(call: PendingCall, outcome: TraceEntry['outcome']): void {
    this.trace.push({ seq: this.trace.length, actor: call.actor.name, label: call.label, outcome })
  }
}

/** Drain microtasks so every runnable actor reaches its next port call. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
