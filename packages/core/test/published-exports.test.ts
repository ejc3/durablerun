import { expectTypeOf, it } from 'vitest'
import type { WakeSignals } from '../src/index.js'

// Type-only exports have no runtime presence, so only typecheck can see one
// disappear from the published barrel.
it('keeps the published WakeSignals port importable from the core barrel', () => {
  expectTypeOf<WakeSignals>().toHaveProperty('ping')
})
