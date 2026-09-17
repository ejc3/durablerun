import { PARKED_CLAIM_COLUMNS } from '@durablerun/core'
import { expect, it } from 'vitest'
import { PARKED_CLAIM } from '../src/fragments.js'

/**
 * Suspend and reschedule clear a parked run's claim with this store's text, and the
 * launch deferral clears it with core's columns. Until both are trees, this holds the
 * two forms to the same columns.
 */
it('the text and tree forms of a parked claim clear the same columns', () => {
  const cleared = PARKED_CLAIM.split(',').map((assignment) => assignment.trim().split(' = '))
  expect(cleared.map(([column]) => column)).toEqual(Object.keys(PARKED_CLAIM_COLUMNS))
  expect(cleared.map(([, value]) => value)).toEqual(
    Object.values(PARKED_CLAIM_COLUMNS).map(() => 'NULL'),
  )
})
