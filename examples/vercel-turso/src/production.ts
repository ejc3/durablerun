import { waitUntil } from '@vercel/functions'
import { hostedAuthorization } from './auth.js'
import { createHostedExample, type HostedExampleRuntime } from './runtime.js'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} must be set`)
  return value
}

let runtime: HostedExampleRuntime | undefined

function getRuntime(): HostedExampleRuntime {
  runtime ??= createHostedExample({
    databaseUrl: requiredEnv('TURSO_DATABASE_URL'),
    databaseAuthToken: requiredEnv('TURSO_AUTH_TOKEN'),
    queue: requiredEnv('DURABLERUN_QUEUE'),
    authorization: hostedAuthorization(
      requiredEnv('DURABLERUN_API_TOKEN'),
      requiredEnv('CRON_SECRET'),
    ),
    defer: waitUntil,
  })
  return runtime
}

export function handleHostedRequest(request: Request): Promise<Response> {
  return getRuntime().router.handle(request)
}
