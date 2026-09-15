import { type SqlBatchControl, type SqlExecutor, sqlBatchMode } from '@durablerun/core'
import { describe, expect, it } from 'vitest'
import { readOne } from '../src/scenario.js'

describe('conformance scenario helpers', () => {
  it('readOne runs its statement in read mode', async () => {
    const modes: string[] = []
    const recording: SqlExecutor = {
      async batch(_label, _statements, control?: SqlBatchControl) {
        modes.push(sqlBatchMode(control))
        return [{ rows: [{ n: 1 }], rowsAffected: 1 }]
      },
    }
    expect(await readOne(recording, 'SELECT 1 AS n', [])).toEqual({ n: 1 })
    expect(modes).toEqual(['read'])
  })
})
