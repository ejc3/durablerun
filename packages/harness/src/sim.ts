import type { SqlBatchMode, SqlExecutor, SqlResult, SqlStatement } from '@absurd-lite/core'
import { Rng } from './rng.js'

/**
 * Deterministic simulation world (BUILD.md PR1.3).
 *
 * Actors are async functions whose ONLY awaits are `batch()` calls on the
 * SqlExecutor this world hands them. The world serializes those calls —
 * a seeded scheduler picks which pending batch executes next against the
 * real database — so every interleaving of N concurrent actors is (a)
 * reachable and (b) exactly replayable from the seed.
 *
 * Fault injection:
 * - Crashes kill an actor before or after a chosen labeled batch, modeling
 *   PROCESS death: the actor's other in-flight calls are purged unexecuted
 *   and all its future calls reject — a dead process has no further effects.
 * - Duplicates execute a labeled batch twice (sequentially) and resolve with
 *   the second result — the retry-after-lost-response shape of an
 *   at-least-once channel, the exact fault class the engine's fenced-batch
 *   idempotence rules exist for.
 *
 * Determinism contract: actor code between port calls must be synchronous
 * and deterministic (no timers, no Date.now/Math.random, no other I/O).
 * Violations are detected and thrown, never silently hung: if the scheduler
 * reaches quiescence while an actor is neither finished nor blocked on a
 * port call, that actor awaited something the world does not control.
 */

export class SimCrash extends Error {
  override readonly name = 'SimCrash'
  constructor(
    readonly actor: string,
    readonly label: string,
    readonly when: 'before' | 'after' | 'orphan',
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

export interface DuplicateSpec {
  actor?: string
  label: string | RegExp
  occurrence?: number
}

export interface TraceEntry {
  seq: number
  actor: string
  label: string
  outcome: 'ok' | 'dup' | 'crash-before' | 'crash-after' | 'crash-orphan' | 'error'
}

export type ActorResult =
  | { status: 'done' }
  | { status: 'crashed'; crash: SimCrash }
  | { status: 'failed'; error: unknown }

interface PendingCall {
  actor: ActorState
  label: string
  statements: readonly SqlStatement[]
  mode: SqlBatchMode
  resolve: (r: SqlResult[]) => void
  reject: (e: unknown) => void
}

interface ActorState {
  name: string
  crashed: boolean
  /** Set on a determinism-contract violation; future calls reject loudly. */
  condemned: boolean
  settled: boolean
  finished: Promise<ActorResult>
}

interface ArmedSpec<S extends CrashSpec | DuplicateSpec> {
  spec: S
  remaining: number
  consumed: boolean
}

export interface SimWorldOptions {
  /**
   * Throw at quiescence if any injected spec never fired (default true) — a
   * typo'd label must not let a scenario pass vacuously green.
   */
  strictSpecs?: boolean
}

export class SimWorld {
  private readonly rng: Rng
  private readonly pending: PendingCall[] = []
  private readonly actors: ActorState[] = []
  private readonly crashes: ArmedSpec<CrashSpec>[] = []
  private readonly duplicates: ArmedSpec<DuplicateSpec>[] = []
  private readonly strictSpecs: boolean
  private active = false
  readonly trace: TraceEntry[] = []

  constructor(
    private readonly real: SqlExecutor,
    seed: number | string,
    options: SimWorldOptions = {},
  ) {
    this.rng = new Rng(seed)
    this.strictSpecs = options.strictSpecs ?? true
  }

  injectCrash(spec: CrashSpec): void {
    this.crashes.push({
      spec: { ...spec, label: neutralize(spec.label) },
      remaining: spec.occurrence ?? 1,
      consumed: false,
    })
  }

  injectDuplicate(spec: DuplicateSpec): void {
    this.duplicates.push({
      spec: { ...spec, label: neutralize(spec.label) },
      remaining: spec.occurrence ?? 1,
      consumed: false,
    })
  }

  actor(name: string, fn: (db: SqlExecutor) => Promise<void>): void {
    const state: ActorState = {
      name,
      crashed: false,
      condemned: false,
      settled: false,
      finished: Promise.resolve({ status: 'done' }),
    }
    const db: SqlExecutor = {
      batch: (label, statements, mode = 'write') => {
        if (state.crashed) return handledRejection(new SimCrash(name, label, 'before'))
        if (state.condemned) {
          return handledRejection(
            new Error(
              `batch '${label}' from condemned actor '${name}' — it previously violated the determinism contract`,
            ),
          )
        }
        return new Promise<SqlResult[]>((resolve, reject) => {
          this.pending.push({ actor: state, label, statements, mode, resolve, reject })
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
    state.finished.then(() => {
      state.settled = true
    })
    this.actors.push(state)
  }

  /**
   * Run until quiescent: no pending batch and no actor able to produce one.
   * Throws on: actor FAILURE (non-crash error), determinism-contract
   * violations, ambiguous injections, and (strict mode) specs that never
   * fired. Crashes are expected outcomes, never throws.
   */
  async run(): Promise<Map<string, ActorResult>> {
    if (this.active) throw new Error('SimWorld.run() is already active')
    this.active = true
    try {
      for (;;) {
        await settle()
        if (this.pending.length === 0) break
        const idx = this.rng.int(this.pending.length)
        const call = this.pending.splice(idx, 1)[0]
        if (!call) continue
        await this.executeCall(call)
      }

      // Determinism-contract check: an actor that is neither settled nor
      // blocked on a pending call awaited something outside the world.
      await settle()
      const stuck = this.actors.filter(
        (a) => !a.settled && !this.pending.some((c) => c.actor === a),
      )
      if (stuck.length > 0) {
        for (const a of stuck) a.condemned = true
        throw new Error(
          `determinism contract violation: actor(s) ${stuck
            .map((a) => `'${a.name}'`)
            .join(
              ', ',
            )} reached quiescence neither finished nor blocked on a port call (they awaited a timer or other non-port promise)`,
        )
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

      if (this.strictSpecs) {
        const unfired = [
          ...this.crashes.filter((c) => !c.consumed).map((c) => `crash ${describe(c.spec)}`),
          ...this.duplicates.filter((d) => !d.consumed).map((d) => `duplicate ${describe(d.spec)}`),
        ]
        if (unfired.length > 0) {
          throw new Error(
            `injected spec(s) never fired (typo'd label or unreachable transition?): ${unfired.join('; ')}`,
          )
        }
      }
      return results
    } finally {
      this.active = false
    }
  }

  private async executeCall(call: PendingCall): Promise<void> {
    if (call.actor.crashed) {
      this.record(call, 'crash-orphan')
      call.reject(new SimCrash(call.actor.name, call.label, 'orphan'))
      return
    }
    const crash = this.matchSpec(this.crashes, call)
    if (crash?.when === 'before') {
      this.crashActor(call, 'crash-before')
      return
    }
    const duplicate = crash ? undefined : this.matchSpec(this.duplicates, call)
    let results: SqlResult[]
    try {
      if (duplicate) {
        await this.real.batch(call.label, call.statements, call.mode)
        this.record(call, 'dup')
      }
      results = await this.real.batch(call.label, call.statements, call.mode)
    } catch (error) {
      this.record(call, 'error')
      call.reject(error)
      return
    }
    if (crash?.when === 'after') {
      this.crashActor(call, 'crash-after')
      return
    }
    this.record(call, 'ok')
    call.resolve(results)
  }

  /** Process death: reject this call AND purge the actor's other pending calls. */
  private crashActor(call: PendingCall, outcome: 'crash-before' | 'crash-after'): void {
    call.actor.crashed = true
    this.record(call, outcome)
    call.reject(
      new SimCrash(call.actor.name, call.label, outcome === 'crash-before' ? 'before' : 'after'),
    )
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const orphan = this.pending[i]
      if (!orphan || orphan.actor !== call.actor) continue
      this.pending.splice(i, 1)
      this.record(orphan, 'crash-orphan')
      orphan.reject(new SimCrash(orphan.actor.name, orphan.label, 'orphan'))
    }
  }

  /**
   * Uniform occurrence accounting: EVERY armed matching spec counts this
   * call as an occurrence; specs reaching zero fire. Two specs firing on the
   * same call is an authoring error and throws.
   */
  private matchSpec<S extends CrashSpec | DuplicateSpec>(
    specs: ArmedSpec<S>[],
    call: PendingCall,
  ): S | undefined {
    const winners: ArmedSpec<S>[] = []
    for (const armed of specs) {
      if (armed.consumed) continue
      if (armed.spec.actor !== undefined && armed.spec.actor !== call.actor.name) continue
      const matches =
        typeof armed.spec.label === 'string'
          ? armed.spec.label === call.label
          : armed.spec.label.test(call.label)
      if (!matches) continue
      armed.remaining -= 1
      if (armed.remaining <= 0) winners.push(armed)
    }
    if (winners.length > 1) {
      throw new Error(
        `ambiguous injection: ${winners.length} specs fire on the same call ('${call.actor.name}' / '${call.label}'): ${winners
          .map((w) => describe(w.spec))
          .join('; ')}`,
      )
    }
    const winner = winners[0]
    if (!winner) return undefined
    winner.consumed = true
    return winner.spec
  }

  private record(call: PendingCall, outcome: TraceEntry['outcome']): void {
    this.trace.push({ seq: this.trace.length, actor: call.actor.name, label: call.label, outcome })
  }
}

/** Strip stateful regex flags — a g/y regex alternates matches across calls. */
function neutralize(label: string | RegExp): string | RegExp {
  if (typeof label === 'string') return label
  return new RegExp(label.source, label.flags.replace(/[gy]/g, ''))
}

function describe(spec: CrashSpec | DuplicateSpec): string {
  const parts = [
    spec.actor !== undefined ? `actor=${spec.actor}` : null,
    `label=${String(spec.label)}`,
    spec.occurrence !== undefined ? `occurrence=${spec.occurrence}` : null,
    'when' in spec ? `when=${(spec as CrashSpec).when}` : null,
  ]
  return `{${parts.filter(Boolean).join(', ')}}`
}

/**
 * A rejection nobody may be awaiting (fire-and-forget chains) must not trip
 * the process unhandled-rejection handler; a real awaiter still observes it.
 */
function handledRejection(error: Error): Promise<never> {
  const p = Promise.reject(error)
  p.catch(() => {})
  return p
}

/** Drain microtasks so every runnable actor reaches its next port call. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
