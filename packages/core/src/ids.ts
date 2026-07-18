import { randomBytes } from 'node:crypto'
import type { IdSource } from './primitives.js'

/**
 * Production IdSource: real UUIDv7 (time-ordered — run ordering ties break on
 * id, DESIGN.md §1.2) and 128-bit hex tokens. Simulations inject a seeded
 * IdSource instead; engine code never touches crypto/time directly.
 */
export function systemIdSource(): IdSource {
  return {
    uuidv7(): string {
      const ms = BigInt(Date.now())
      const bytes = randomBytes(16)
      bytes[0] = Number((ms >> 40n) & 0xffn)
      bytes[1] = Number((ms >> 32n) & 0xffn)
      bytes[2] = Number((ms >> 24n) & 0xffn)
      bytes[3] = Number((ms >> 16n) & 0xffn)
      bytes[4] = Number((ms >> 8n) & 0xffn)
      bytes[5] = Number(ms & 0xffn)
      bytes[6] = (0x70 | ((bytes[6] ?? 0) & 0x0f)) & 0xff
      bytes[8] = (0x80 | ((bytes[8] ?? 0) & 0x3f)) & 0xff
      const hex = bytes.toString('hex')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    },
    token(): string {
      return randomBytes(16).toString('hex')
    },
  }
}
