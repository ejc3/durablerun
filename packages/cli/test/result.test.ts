import { MAX_RUN_ORDINAL } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { QUEUE, openCliDb, runCli, seedTasks } from './support.js'

describe('result and checkpoints on libSQL', () => {
  it("shows a row the store's decoders refuse as unreadable, and prints what refused it", async () => {
    const db = await openCliDb('libsql', 'unreadable')
    try {
      const seeded = await seedTasks(db)
      await db.raw.batch('fixture:contradiction', [
        {
          sql: 'UPDATE tasks SET completed_payload = NULL WHERE task_id = ?',
          args: [seeded.completed],
        },
      ])
      const run = await runCli(['result', seeded.completed, '--queue', QUEUE, '--json'], db.env)
      expect(run.exit).toBe(0)
      expect(JSON.parse(run.stdout)).toMatchObject({
        state: 'unreadable',
        reason: `task ${seeded.completed} is completed but has no completed payload`,
      })
      const listed = await runCli(
        ['checkpoints', seeded.completed, '--queue', QUEUE, '--json'],
        db.env,
      )
      expect(listed.exit).toBe(0)
      expect(JSON.parse(listed.stdout)).toMatchObject({ checkpoints: [{ name: 'fetch-page' }] })
    } finally {
      await db.close()
    }
  })

  it('checkpoints --attempt takes a whole number from 1 to the largest run ordinal', async () => {
    const db = await openCliDb('libsql', 'attempts')
    try {
      const seeded = await seedTasks(db)
      for (const attempt of ['0', '-1', '1.5', 'one', String(MAX_RUN_ORDINAL + 1)]) {
        const run = await runCli(
          ['checkpoints', seeded.completed, '--queue', QUEUE, '--attempt', attempt],
          db.env,
        )
        expect({ attempt, exit: run.exit }).toEqual({ attempt, exit: 2 })
      }
      const last = await runCli(
        ['checkpoints', seeded.completed, '--queue', QUEUE, '--attempt', String(MAX_RUN_ORDINAL)],
        db.env,
      )
      expect(last.exit).toBe(0)
    } finally {
      await db.close()
    }
  })
})
