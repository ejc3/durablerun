import { type HostedAuthorizationPlugin, bearerAuthorization } from '@durablerun/driver'

/**
 * This is application policy, not router policy. Replace this composition
 * with any host-owned HostedAuthorizationPlugin without changing a route or
 * scheduler primitive.
 */
export function hostedAuthorization(options: {
  readonly apiToken: string
  readonly cronToken: string
}): HostedAuthorizationPlugin {
  const apiToken = options.apiToken
  const cronToken = options.cronToken
  const api = bearerAuthorization({ token: apiToken })
  const cron = bearerAuthorization({ token: cronToken })
  if (apiToken === cronToken) {
    throw new TypeError('hosted API and cron tokens must be distinct')
  }
  return (facts) => {
    switch (facts.operation) {
      case 'task.enqueue':
      case 'event.emit':
      case 'task.inspect':
        return api(facts)
      case 'tick.run':
        return cron(facts)
    }
  }
}
