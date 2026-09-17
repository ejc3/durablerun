import {
  LAUNCH_IDENTITY_FIELDS,
  type LaunchInvocation,
  LaunchOutcome,
  systemClock,
} from '@durablerun/core'
import { Rng, seededIdSource } from '@durablerun/harness'
import { LibsqlSchedulerStore } from '@durablerun/store-libsql'
import { openTestDb } from '@durablerun/store-libsql/testing'
import { describe, expect, it } from 'vitest'
import { createWorkerServer, signBody, tick } from '../src/index.js'

const Q = 'q'
const SECRET = 'cross-version-secret'

/**
 * The launch payload crosses driver and worker builds of different versions, so
 * every `LaunchInvocation` field is classified here, and `satisfies` makes a new
 * field a type error until it is. An identity field names the claim: every driver
 * build has sent it, and the worker needs it. An advisory field is a hint the
 * worker ignores, so an older driver may omit it and a newer driver may change it.
 */
const LAUNCH_FIELD_ROLES = {
  queue: 'identity',
  runId: 'identity',
  claimToken: 'identity',
  claimGen: 'identity',
  attempt: 'advisory',
  deadlineHintEpochMs: 'advisory',
} as const satisfies Record<keyof LaunchInvocation, 'identity' | 'advisory'>

type Payload = Record<string, unknown>

async function fixture(seed: string) {
  const { raw } = await openTestDb()
  const ids = seededIdSource(new Rng(seed))
  const store = new LibsqlSchedulerStore(raw, ids)
  const worker = createWorkerServer({
    store,
    clock: systemClock(),
    registry: new Map([['job', async () => 'ok']]),
    secret: SECRET,
  })
  const port = await worker.listen()
  return {
    store,
    ids,
    port,
    close: async () => {
      await worker.close()
      raw.close()
    },
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** The wire payload a current driver sends for one freshly spawned task. */
async function driverPayload(f: Fixture): Promise<{ taskId: string; payload: Payload }> {
  const { taskId } = await f.store.spawn(Q, 'job', '{}')
  const sent: LaunchInvocation[] = []
  await tick(
    {
      store: f.store,
      ids: f.ids,
      launcher: {
        launch: async (invocation) => {
          sent.push(invocation)
          return LaunchOutcome.accepted()
        },
      },
    },
    { queue: Q, claimLimit: 1, sweepLimit: 1, leaseSeconds: 60 },
  )
  const [invocation] = sent
  if (invocation === undefined) throw new Error('the tick launched nothing')
  // httpLauncher sends JSON.stringify(invocation), so the wire payload is its JSON round trip.
  return { taskId, payload: JSON.parse(JSON.stringify(invocation)) as Payload }
}

async function post(f: Fixture, payload: Payload): Promise<number> {
  const body = JSON.stringify(payload)
  const response = await fetch(`http://127.0.0.1:${f.port}/launch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-durablerun-signature': signBody(SECRET, body),
    },
    body,
  })
  return response.status
}

async function completes(f: Fixture, taskId: string): Promise<boolean> {
  for (let i = 0; i < 300; i++) {
    if ((await f.store.getTaskResult(Q, taskId))?.state === 'completed') return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

interface Variant {
  name: string
  change: (payload: Payload) => Payload
  accepted: boolean
}

/** Wrong types and values for each identity field, which no driver build sends. */
const INVALID_IDENTITY_VALUES: Record<string, readonly (readonly [string, unknown])[]> = {
  queue: [
    ['a number', 7],
    ['empty', ''],
  ],
  runId: [
    ['a number', 7],
    ['empty', ''],
  ],
  claimToken: [
    ['null', null],
    ['empty', ''],
  ],
  claimGen: [
    ['1.5', 1.5],
    ['zero', 0],
    ['negative', -1],
    ['a string', '1'],
  ],
}

/** Every older and newer driver payload the classification implies. */
function variants(): Variant[] {
  const generated: Variant[] = [
    { name: 'the current driver', change: (payload) => payload, accepted: true },
    {
      name: 'a newer driver that adds a field',
      change: (payload) => ({ ...payload, laterField: { nested: true } }),
      accepted: true,
    },
  ]
  for (const [field, role] of Object.entries(LAUNCH_FIELD_ROLES)) {
    generated.push({
      name: `an older driver without ${field}`,
      change: ({ [field]: _omitted, ...rest }) => rest,
      accepted: role === 'advisory',
    })
    if (role === 'advisory') {
      generated.push({
        name: `a newer driver that sends ${field} as a string`,
        change: (payload) => ({ ...payload, [field]: String(payload[field]) }),
        accepted: true,
      })
    } else {
      for (const [description, value] of INVALID_IDENTITY_VALUES[field] ?? []) {
        generated.push({
          name: `a payload whose ${field} is ${description}`,
          change: (payload) => ({ ...payload, [field]: value }),
          accepted: false,
        })
      }
    }
  }
  return generated
}

describe('launch payload across driver and worker versions', () => {
  it('classifies every field a current driver sends', async () => {
    const f = await fixture('launch-payload-fields')
    try {
      const { payload } = await driverPayload(f)
      expect(Object.keys(payload).sort()).toEqual(Object.keys(LAUNCH_FIELD_ROLES).sort())
      // The worker validates exactly the fields classified as identity here.
      expect([...LAUNCH_IDENTITY_FIELDS].sort()).toEqual(
        Object.entries(LAUNCH_FIELD_ROLES)
          .filter(([, role]) => role === 'identity')
          .map(([field]) => field)
          .sort(),
      )
    } finally {
      await f.close()
    }
  })

  it('a worker runs every payload that names its claim and refuses one that does not', async () => {
    const f = await fixture('launch-payload-cross-version')
    const observed: { variant: string; status: number; completed: boolean }[] = []
    const expected: typeof observed = []
    try {
      for (const variant of variants()) {
        const { taskId, payload } = await driverPayload(f)
        const status = await post(f, variant.change(payload))
        observed.push({
          variant: variant.name,
          status,
          completed: status === 202 && (await completes(f, taskId)),
        })
        expected.push({
          variant: variant.name,
          status: variant.accepted ? 202 : 400,
          completed: variant.accepted,
        })
      }
    } finally {
      await f.close()
    }
    expect(observed).toEqual(expected)
  }, 120_000)
})
