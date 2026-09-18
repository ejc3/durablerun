import { storeConformance } from '../src/index.js'
import { SELECTED_DIALECT_FIXTURES } from './dialect-fixtures.js'

for (const { dialect, makeFixture } of SELECTED_DIALECT_FIXTURES) {
  storeConformance(dialect, makeFixture)
}
