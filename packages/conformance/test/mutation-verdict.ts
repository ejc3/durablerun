/**
 * Attribute a mutant only when an operation that normally succeeds reaches
 * the expected failure. Any other exception propagates unchanged and the
 * mutation probe reports a wrong-path catch.
 */
export async function attributeExpectedFailure<T>(
  marker: string,
  expectedError: RegExp,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (expectedError.test(String(error))) throw new Error(marker)
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
  expectedError: RegExp,
  action: () => Promise<unknown>,
): Promise<void> {
  try {
    await action()
  } catch (error) {
    if (expectedError.test(String(error))) return
    throw error
  }
  throw new Error(marker)
}
