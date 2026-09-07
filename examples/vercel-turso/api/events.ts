import { handleHostedRequest } from '../src/production.js'

export const runtime = 'nodejs'
export const maxDuration = 60
export default { fetch: handleHostedRequest }
