export type ExpectedError = RegExp | ((error: unknown) => boolean)

function matches(expected: ExpectedError, error: unknown): boolean {
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
  marker: string,
  expectedError: ExpectedError,
  action: () => Promise<T>,
): Promise<T> {
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
  marker: string,
  expectedError: ExpectedError,
  action: () => Promise<unknown>,
): Promise<void> {
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
  marker: string,
  expectedError: ExpectedError,
  replacementError: ExpectedError,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (matches(expectedError, error)) return
    if (matches(replacementError, error)) throw new Error(marker)
    throw error
  }
  throw new Error('expected operation to reject')
}
