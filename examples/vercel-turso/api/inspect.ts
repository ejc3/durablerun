import { handleHostedRequest } from '../src/production.js'

export const runtime = 'nodejs'
export default { fetch: handleHostedRequest }
