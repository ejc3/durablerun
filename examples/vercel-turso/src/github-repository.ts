/**
 * Whether a string is a GitHub repository written `owner/name`: an owner as GitHub forms
 * one, and a name that is neither `.` nor `..`, so the string is safe to put into the path
 * of an API URL part by part.
 */
export function isGitHubRepository(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value) &&
    !['.', '..'].includes(value.split('/')[1] ?? '')
  )
}
