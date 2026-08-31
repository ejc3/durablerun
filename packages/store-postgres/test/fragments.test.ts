import { describe, expect, it } from 'vitest'
import { durableTaskRetryAdmissible } from '../src/fragments.js'

describe('PostgreSQL SQL fragments', () => {
  it('puts the exponential factor cast behind a typed CASE arm', () => {
    const sql = durableTaskRetryAdmissible('t').replace(/\s+/g, ' ')

    expect(sql, 'mutation-verdict:construction:postgres-retry-factor-type-guard').toContain(
      "WHEN jsonb_typeof(t.retry_strategy::jsonb -> 'factor') <> 'number' THEN FALSE ELSE ((t.retry_strategy::jsonb ->> 'factor')::numeric) BETWEEN 0 AND 1.7976931348623157e308 END",
    )
  })
})
