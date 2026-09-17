import { storeConformance } from '../src/index.js'
import { DIALECT_FIXTURES } from './dialect-fixtures.js'
import { yieldToTimersAfterEachTest } from './yield-to-timers.js'

yieldToTimersAfterEachTest()

for (const { dialect, makeFixture } of DIALECT_FIXTURES) {
  storeConformance(dialect, makeFixture)
}
