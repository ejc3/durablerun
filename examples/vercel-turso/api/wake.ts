import { handleCallback } from '@vercel/queue'
import { handleHostedWake } from '../src/production.js'
import { WAKE_HANDLER_OPTIONS } from '../src/wake.js'

export const runtime = 'nodejs'
export default { fetch: handleCallback(handleHostedWake, WAKE_HANDLER_OPTIONS) }
