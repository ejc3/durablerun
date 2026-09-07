# Hosted alpha: Vercel + Turso

This is the smallest deployable durablerun host: one Turso database, one queue,
four Web Request endpoints, one inline worker slot, and a once-per-minute
recovery tick. It intentionally has no UI, detached worker, alarm service, or
framework.

## Deploy

Use Node 22.12 or newer and a dedicated empty Turso database. Do not point the
migrator or receipt at another application's database.

1. Copy `.env.example` to `.env` and fill every value. Keep
   `DURABLERUN_API_TOKEN` and `CRON_SECRET` distinct. The latter is the Bearer
   credential Vercel adds to cron requests.
2. Run `npm install`, then `npm run typecheck`, `npm test`, and `npm run migrate`.
3. Create a Vercel project from this directory, add the five runtime variables
   (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DURABLERUN_QUEUE`,
   `DURABLERUN_API_TOKEN`, and `CRON_SECRET`), and deploy it. `api/*.ts` pins
   the Node.js runtime and `vercel.json` gives each invocation 60 seconds.
4. Set `DURABLERUN_BASE_URL` locally to the production URL and run
   `npm run receipt`.

The four durablerun dependencies are immutable `v0.1.0-alpha.0` GitHub release
tarballs—there are no workspace links, source imports, registry credentials, or
mutable branch references. A later npm release can replace only those four URLs
with package versions.

The receipt has a 45-second total deadline. It proves all four operations deny
anonymous requests, then drives enqueue → event suspension → emit → resume →
inspect. Finally it claims a fresh task directly from the same Turso database
and intentionally drops the launch; hosted ticks must record one lost-launch
reopen and complete it with `ctx.attempt === 1`. Run it against an otherwise
idle dedicated queue so its deliberate claim cannot select someone else's
work.

## Authorization is host-owned

`src/auth.ts` is a tiny example plugin composition. The API Bearer token grants
enqueue, emit, and inspect; the separate cron Bearer token grants tick. To use
OIDC, a signed webhook, tenant policy, or another scheme, supply your own
`HostedAuthorizationPlugin` to `createHostedExample`. The router still binds the
decision to the exact operation, method, URL, headers, and body it will use and
fails closed before parsing or touching storage.

The enqueue and emit handlers ask Vercel `waitUntil` to run one inline tick as
a lossy latency hint. Durable state is committed before that hint, and the cron
tick remains the recovery path if the hint or an invocation is lost.
