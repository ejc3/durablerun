/**
 * Whether a part of a path is a dot segment. A URL parser drops `.` and resolves `..`
 * away, so a path built with one names another resource than the one written.
 */
export const isDotSegment = (part: string): boolean => part === '.' || part === '..'

/**
 * Whether a string is a GitHub repository written `owner/name`: an owner as GitHub forms
 * one, and a name that is no dot segment, so the string is safe to put into the path of
 * an API URL part by part.
 */
export function isGitHubRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
    !isDotSegment(value.split('/')[1] ?? '')
  )
}
