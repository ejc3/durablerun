import {
  type HostedAuthorizationPlugin,
  authorizationByOperation,
  bearerAuthorization,
} from '@durablerun/driver'

/**
 * This is application policy, not router policy. Replace this composition
 * with any host-owned HostedAuthorizationPlugin without changing a route or
 * scheduler primitive.
 */
export function hostedAuthorization(
  apiToken: string,
  cronToken: string,
): HostedAuthorizationPlugin {
  const api = bearerAuthorization({ token: apiToken, principal: 'hosted-api' })
  const cron = bearerAuthorization({ token: cronToken, principal: 'vercel-cron' })
  return authorizationByOperation({
    'task.enqueue': api,
    'event.emit': api,
    'tick.run': cron,
    'task.inspect': api,
  })
}
