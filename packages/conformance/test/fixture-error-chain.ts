/**
 * The first value of the wanted kind under `key` along an error's chain of causes. Every
 * executor wraps the driver's error, and a fixture classifies a refusal by the driver's own
 * code, which is a string on SQLite and PostgreSQL and a number on MySQL.
 */
export function firstInCauseChain<Value>(
  error: unknown,
  key: string,
  wanted: (value: unknown) => value is Value,
): Value | undefined {
  let current = error
  for (let depth = 0; depth < 6; depth++) {
    if (typeof current !== 'object' || current === null) return undefined
    const candidate = current as { readonly [name: string]: unknown; readonly cause?: unknown }
    const value = candidate[key]
    if (wanted(value)) return value
    current = candidate.cause
  }
  return undefined
}

export const isString = (value: unknown): value is string => typeof value === 'string'
export const isNumber = (value: unknown): value is number => typeof value === 'number'
