import { isFencedBatchBindError } from './fenced-batch.js'
import type { IdSource } from './primitives.js'

export type ExpectedError = RegExp | ((error: unknown) => boolean)
export interface ReplacedFailureExpectation {
  readonly expectedError: ExpectedError
  readonly replacementError: ExpectedError
}
export type MutationVerdictKind = 'behavior' | 'construction'
export interface MutationVerdict {
  readonly kind: MutationVerdictKind
  readonly mutation: string
}

const MUTATION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function markerFor(verdict: MutationVerdict): string {
  if (!MUTATION_NAME.test(verdict.mutation)) {
    throw new Error(`invalid mutation verdict name: ${verdict.mutation}`)
  }
  return `mutation-verdict:${verdict.kind}:${verdict.mutation}`
}

function matches(expected: ExpectedError, error: unknown): boolean {
  if (isFencedBatchBindError(error)) throw error
  return expected instanceof RegExp
    ? new RegExp(expected.source, expected.flags).test(String(error))
    : expected(error)
}

/**
 * Attribute a mutant only when an operation that normally succeeds reaches
 * the expected failure. Any other exception propagates unchanged and the
 * mutation probe reports a wrong-path catch.
 */
export async function attributeExpectedFailure<T>(
  verdict: MutationVerdict,
  expectedError: ExpectedError,
  action: () => Promise<T>,
): Promise<T> {
  const marker = markerFor(verdict)
  try {
    return await action()
  } catch (error) {
    if (matches(expectedError, error)) throw new Error(marker)
    throw error
  }
}

/**
 * The inverse shape: correct code must reject with `expectedError`, while a
 * mutant that unexpectedly succeeds fails this test with the exact marker.
 * An unrelated rejection propagates unchanged and earns no mutation credit.
 */
export async function requireExpectedFailure(
  verdict: MutationVerdict,
  expectedError: ExpectedError,
  action: () => Promise<unknown>,
): Promise<void> {
  const marker = markerFor(verdict)
  try {
    await action()
  } catch (error) {
    if (matches(expectedError, error)) return
    throw error
  }
  throw new Error(marker)
}

/**
 * Correct code must reject with `expectedError`. A mutant that replaces that
 * rejection with the specifically attributable `replacementError` emits the
 * marker. Success and unrelated rejections fail without attribution.
 */
export async function attributeReplacedFailure(
  verdict: MutationVerdict,
  expectation: ReplacedFailureExpectation,
  action: () => Promise<unknown>,
): Promise<void> {
  const marker = markerFor(verdict)
  try {
    await action()
  } catch (error) {
    if (matches(expectation.expectedError, error)) return
    if (matches(expectation.replacementError, error)) throw new Error(marker)
    throw error
  }
  throw new Error('expected operation to reject')
}

const nextMonotoneSerial = (previous: number): number => previous + 1

/**
 * A deterministic source for routine database tests.
 *
 * IDs and tokens have independent monotone counters: an operation that mints
 * no UUID still receives a fresh provenance token. Zero padding preserves the
 * ordering contract of UUIDv7 stand-ins once a fixture reaches two digits.
 */
export function testIdSource(
  namespace = 'test',
  options: { readonly nextTokenSerial?: (previous: number) => number } = {},
): IdSource {
  if (!/^[a-zA-Z0-9_-]+$/.test(namespace)) {
    throw new Error(
      `test id namespace must contain only letters, digits, underscores, or hyphens: ${namespace}`,
    )
  }
  let ids = 0
  let tokens = 0
  const proposeTokenSerial = options.nextTokenSerial ?? nextMonotoneSerial
  const serial = (value: number) => String(value).padStart(6, '0')
  return {
    uuidv7: () => `${namespace}-id-${serial(++ids)}`,
    token: () => {
      const proposed = proposeTokenSerial(tokens)
      if (!Number.isSafeInteger(proposed)) {
        throw new RangeError(`test token serial must be a safe integer: ${proposed}`)
      }
      if (proposed <= tokens) {
        throw new RangeError(
          `test token serial must strictly increase: proposed ${proposed} after ${tokens}`,
        )
      }
      tokens = proposed
      return `${namespace}-token-${serial(tokens)}`
    },
  }
}
