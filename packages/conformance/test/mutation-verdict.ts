/**
 * Attribute a mutant to behavior only when it reaches the expected dialect
 * failure. Any other exception propagates unchanged and the mutation probe
 * reports a wrong-path catch.
 */
export async function attributeBehaviorFailure<T>(
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
