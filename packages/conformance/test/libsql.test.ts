import { storeConformance } from '../src/index.js'
import { DIALECT_FIXTURES } from './dialect-fixtures.js'

for (const { dialect, makeFixture } of DIALECT_FIXTURES) {
  storeConformance(dialect, makeFixture)
}
