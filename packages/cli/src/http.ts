import type { Clock } from '@durablerun/core'

/**
 * The CLI's one use of HTTP: `tick`, one bounded pass of a hosted deployment. Every other
 * command opens a store. The token is a credential for the deployment, so it is sent in
 * the Authorization header and nowhere else, only to the origin the environment names,
 * only over https or to a loopback address, and no redirect is followed.
 */

/** The route of a hosted deployment that runs one tick (DESIGN.md section 3.5). */
export const TICK_PATH = '/api/tick'

/** The most of an answer's body that is read as JSON. A tick's body is a few hundred bytes. */
const BODY_MAX_CHARACTERS = 64 * 1024

/** The hosts a token may be sent to over http: the machine the command runs on. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * A deployment's URL as its origin, or undefined for one a token is never sent to: text
 * that does not parse, a URL that carries a user name or a password, a scheme that is not
 * https, and http to anything but a loopback address.
 */
export function deploymentOrigin(url: string | undefined): string | undefined {
  if (url === undefined || url === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.username !== '' || parsed.password !== '') return undefined
  const secure = parsed.protocol === 'https:'
  const loopback = parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)
  return secure || loopback ? parsed.origin : undefined
}

export interface TickRequest {
  /** Where the request goes: the tick route of the origin the environment names. */
  readonly endpoint: string
  readonly token: string
}

export interface TickRefusal {
  readonly kind: 'usage' | 'origin-mismatch'
  /** Why nothing was sent. It quotes neither URL as given, and never the token. */
  readonly refused: string
}

const WHAT_A_URL_IS =
  'an https URL, or an http URL of a loopback address, with no user name or password. It is not printed, because a URL can hold a credential'

/**
 * The request `tick --url` sends, or why it sends none. `--url` is to `tick` what
 * `--target` is to a write: the deployment named again, held to the origin of
 * DURABLERUN_BASE_URL before anything is sent, so a token is never sent to a URL that was
 * only typed. The request goes to the tick route of that origin, whatever path either URL
 * holds.
 */
export function tickRequest({
  url,
  baseUrl,
  token,
}: {
  /** What `--url` named. */
  readonly url: string
  /** DURABLERUN_BASE_URL. */
  readonly baseUrl: string | undefined
  /** DURABLERUN_TICK_TOKEN. */
  readonly token: string | undefined
}): TickRequest | TickRefusal {
  const usage = (refused: string): TickRefusal => ({ kind: 'usage', refused })
  if (baseUrl === undefined || baseUrl === '') {
    return usage('set DURABLERUN_BASE_URL to the deployment tick --url names; nothing was sent')
  }
  const origin = deploymentOrigin(baseUrl)
  if (origin === undefined) {
    return usage(`DURABLERUN_BASE_URL must be ${WHAT_A_URL_IS}. Nothing was sent`)
  }
  const named = deploymentOrigin(url)
  if (named === undefined) return usage(`--url must be ${WHAT_A_URL_IS}. Nothing was sent`)
  if (named !== origin) {
    return {
      kind: 'origin-mismatch',
      refused: `--url must name the origin DURABLERUN_BASE_URL names, ${origin}; nothing was sent`,
    }
  }
  if (token === undefined || token === '') {
    return usage(
      "set DURABLERUN_TICK_TOKEN to the bearer token the deployment's tick route takes; nothing was sent",
    )
  }
  // A header's value holds visible ASCII. A token with anything else is refused here, so a
  // client's own refusal of the header never prints it.
  if (!/^[\x21-\x7e]+$/.test(token)) {
    return usage(
      'DURABLERUN_TICK_TOKEN holds a character a header cannot carry. It is not printed. Nothing was sent',
    )
  }
  return { endpoint: `${origin}${TICK_PATH}`, token }
}

export type TickOutcome =
  /** The deployment answered. `body` is its JSON when the body is one JSON object, and undefined otherwise. */
  | {
      readonly kind: 'answered'
      readonly status: number
      readonly body: Record<string, unknown> | undefined
    }
  /** No answer came within the time allowed. The pass may still have run. */
  | { readonly kind: 'timed-out' }
  /** The request failed before an answer: no connection, or one that broke. */
  | { readonly kind: 'unreachable' }

/**
 * Send one tick and wait for its answer, for at most `timeoutMs` by the clock handed in.
 * One signal ends both halves: the deadline ends the request, and the request's end ends
 * the deadline's sleep. The token is in the Authorization header and nowhere else, and a
 * redirect is answered as the status it is and never followed, so the token goes to no
 * second URL.
 */
export async function postTick(
  request: TickRequest,
  timeoutMs: number,
  clock: Clock,
): Promise<TickOutcome> {
  const over = new AbortController()
  let settled = false
  let timedOut = false
  const deadline = clock.sleep(timeoutMs, over.signal).then(() => {
    if (settled) return
    timedOut = true
    over.abort()
  })
  try {
    const response = await fetch(request.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${request.token}` },
      redirect: 'manual',
      signal: over.signal,
    })
    const body = jsonObject(await response.text())
    return { kind: 'answered', status: response.status, body }
  } catch {
    return timedOut ? { kind: 'timed-out' } : { kind: 'unreachable' }
  } finally {
    settled = true
    over.abort()
    await deadline
  }
}

/** A body as the JSON object it is, or undefined for any other text. */
function jsonObject(text: string): Record<string, unknown> | undefined {
  if (text.length > BODY_MAX_CHARACTERS) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/** The error code of a hosted route's refusal, `{ "error": "<code>" }`, when the body holds one. */
export function routerErrorCode(body: Record<string, unknown> | undefined): string | undefined {
  const code = body?.error
  return typeof code === 'string' && /^[a-z_]{1,64}$/.test(code) ? code : undefined
}
