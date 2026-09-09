# Hosted alpha: Vercel + Turso

This is the smallest deployable durablerun host: one Turso database, one queue,
four public Web Request endpoints, one private delayed-queue consumer, one
inline worker slot, and a minutely recovery tick. It intentionally has no UI,
detached worker, resident process, or framework.

## Deploy

Use Node 22.12 or newer, a Vercel Pro project, and a dedicated empty Turso
database. Do not point the migrator or receipt at another application's database.

1. Copy `.env.example` to `.env` and fill every value. Keep
   `DURABLERUN_API_TOKEN` and `CRON_SECRET` distinct. The latter is the Bearer
   credential Vercel adds to cron requests.
2. Run `npm install`, then `npm run typecheck`, `npm test`, and `npm run migrate`.
3. Create a Vercel project from this directory, add the five runtime variables
   (`TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `DURABLERUN_QUEUE`,
   `DURABLERUN_API_TOKEN`, and `CRON_SECRET`), and deploy it. `api/*.ts` pins
   the Node.js runtime, while `vercel.json` forces npm to install this external
   example instead of selecting the enclosing repository's pnpm workspace. It
   gives each invocation 60 seconds and configures a minutely recovery cron.
   The queue SDK uses Vercel's automatic OIDC credentials when deployed; there
   is no additional service token. Queue operations and invocations use the
   project's existing Vercel billing.
4. Set `DURABLERUN_BASE_URL` locally to the HTTPS production URL and run
   `npm run receipt`. The receipt rejects a non-HTTPS destination before it
   constructs an authenticated request.
5. Run `npm run receipt:unattended` against an otherwise idle dedicated queue.
   It never sends a tick request: it commits a task without its producer hint,
   observes cron/queue recovery, then enqueues another through the public API.
   Both tasks must visibly sleep for ten seconds and complete within 60 seconds
   of their database wake time, on user attempt one. Dropped-hint recovery must
   finish within 120 seconds of enqueue. The full receipt has a 240-second
   deadline and also checks that anonymous HTTP cannot invoke the private
   queue consumer. These are measured receipt criteria, not provider SLAs.

The unattended JSON must be paired with provider request logs: a minutely cron
could meet the 60-second threshold even if delayed queue delivery were broken.
For the exact deployment and receipt window, collect `vercel logs --project
durablerun-alpha --deployment <deployment-id> --since <start-ISO> --until
<end-ISO> --limit 1000 --json`. Keep only `id`, `timestamp`, `deploymentId`,
`requestMethod`, `requestPath`, and `responseStatusCode`; do not publish raw log
messages or headers. Ensure the result covers the whole window without hitting
the requested limit.

For both receipt tasks, require a successful private `/api/wake` invocation
during the durable-sleep-to-completion interval and no public `/api/tick`
invocation in that interval. The sleep begins at `dueAtEpochMs - 10000`; its end
is `completedAtEpochMs`, both from database state. The dropped-hint task should
have a cron `/api/tick` before that interval to start its first pass. Run no
other producers against the dedicated queue. If a cron overlaps either resume,
the source is ambiguous: rerun the bounded receipt once and retain a trace that
distinguishes queue delivery from cron. If attribution remains ambiguous, report
that the automatic-progress check passed but queue-delivery proof is incomplete;
do not call queue configuration or message counts a substitute for execution.

The four durablerun dependencies are immutable `v0.1.0-alpha.1` GitHub release
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
fails closed before parsing or touching storage. The example composition also
refuses construction when the API and cron credentials are equal.

The enqueue and emit handlers ask Vercel `waitUntil` to run one inline tick as
a lossy latency hint. Durable state is committed before that hint. Every tick
then publishes an immediate follow-up when its bounded pass may have left work,
or a delayed wake for the next database transition. An idle queue publishes
nothing. A tick only acknowledges its queue delivery after this rearm succeeds;
the private consumer retries failures after five seconds, with a 30-second
visibility timeout. Duplicate wake messages are safe because database claims
remain fenced.

`HostedExampleConfig.scheduleWake` is optional and host-owned, just like auth.
`src/wake.ts` implements it with Vercel Queues; another host can supply its own
alarm provider without changing the driver or stores. Queue payloads identify
the one configured queue, and the private receiver refuses other queues. The
public tick endpoint still uses the authorization plugin. The provider callback
uses a separate, private Vercel trigger—not a public auth bypass.

Wake messages live for 24 hours. A single delay is capped at 23 hours, leaving
an hour for retries; longer sleeps wake early and rearm from database state.
There is no timestamp deduplication key because provider deduplication lasts
past delivery and could suppress a later legitimate tick. Vercel delivers queue
messages to the deployment that published them, so retain old deployments while
their messages drain. The independent minutely cron recovers a completely lost
producer hint or alarm publish; Vercel cron itself is best-effort and does not
retry missed invocations. Hobby users can restore `0 0 * * *` for a daily
backstop, but then the dropped-hint receipt's recovery bound does not apply.

The original `npm run receipt` still drives authorized ticks explicitly for
the earlier event and lost-launch checks; only `receipt:unattended` proves the
new automatic wake path.

Provider contracts: [queue setup and OIDC](https://vercel.com/docs/queues/quickstart),
[delays and retries](https://vercel.com/docs/queues/sdk),
[TTL and billing](https://vercel.com/docs/queues/pricing), and
[cron limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Watch a pull request's checks

The `watch-pr-checks` task is a useful consumer of the same released packages,
authorization plugin, and automatic wake path. Enqueue it through `/api/tasks`:

```json
{
  "taskName": "watch-pr-checks",
  "params": {
    "repository": "owner/repository",
    "pullNumber": 24,
    "headSha": "replace-with-the-exact-40-character-PR-head-SHA",
    "checks": [
      { "kind": "check-run", "name": "verify", "appId": 15368 },
      { "kind": "status", "name": "adversarial-review" }
    ],
    "maxPolls": 10,
    "intervalSeconds": 60
  }
}
```

Choose the actual check names and GitHub App IDs reported for that repository;
the example IDs and names are not a universal CI policy. Check-run selectors
bind both name and app, while status selectors bind their context name.
Status contexts are case-insensitive and do not authenticate a publisher. Supply
at least one selector. Missing or unfinished selected checks remain pending.
Only successful selected checks produce `ready`; a selected failure produces
`failed`. The result also distinguishes a changed head (`superseded`), a closed
PR, an exhausted polling budget (`timed-out`), and unavailable GitHub data.
These are successful durable task results, available as `result` from
`GET /api/inspect?taskId=...`; inspect the result's `status`, not merely the
task's `completed` state.

This is a snapshot of the selected checks on one exact PR head, not a claim
that GitHub permits merging. It does not infer branch protection, reviews, or
other required checks, and it never merges, comments, or sends notifications.
Every GitHub observation is a checkpointed step; pending observations lead
to durable sleep, so no invocation stays resident while CI runs. Polling defaults
to ten observations, one minute apart. Set `maxPolls` from 1 to 30 and
`intervalSeconds` from 60 to 3600; these are explicit work bounds, not an
unattended multi-day soak.

Public repositories work without GitHub credentials, subject to GitHub's
unauthenticated API limit. Private repositories or larger usage can supply an
optional host-owned `GITHUB_TOKEN` with read access to the relevant repository's
pull requests, checks, and commit statuses. Never put that token in task params
or results. Rate-limit and service failures cannot turn an unknown check green.
Consecutive transient errors back off to at most one hour, respecting a server
retry delay within that bound. A longer requested delay ends this watch as
unavailable. Public access permits only 60 requests per hour per IP; a poll
normally needs three or four requests. Use a scoped token for sustained use.
The observer limits each endpoint to five pages of 100 rows and never treats
truncated or changing pagination as success.

GitHub contracts: [check runs and latest filtering](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference),
[newest-first commit statuses](https://docs.github.com/en/rest/commits/statuses#list-commit-statuses-for-a-reference),
and [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

### Interruption recovery receipt

Run `npm run receipt:pr-watcher` from a clean external copy of this directory
installed with `npm install`; the four package URLs remain the immutable alpha
release tarballs. Set `PR_WATCHER_INPUT` to the JSON **params** object above,
using a real open PR whose selected checks are still pending. Use at least two
polls and a polling budget that fits the receipt's 15-minute deadline. The
receipt also needs the existing local Turso credentials, dedicated queue,
HTTPS `DURABLERUN_BASE_URL`, and API token; it does not need `CRON_SECRET`.
Run no other producers against that queue during the receipt.

The receipt creates and claims exactly one new watcher task, runs the real
handler in a local child process, and kills that process immediately after its
first pending GitHub observation has committed. This interruption wrapper lives
only in the local receipt script: the deployed handler has no crash parameter
or fault endpoint. A PR that races to terminal before the checkpoint cannot
satisfy the receipt; use the next real CI run, not a fabricated pending value.

After that interruption the parent sends only inspect requests. The deployment
must recover the expired, activated lease through its cron/queue wake path,
reuse the original checkpoint unchanged, and eventually expose an exact-head
`ready` or `failed` result. The JSON requires at least two observations, exactly
one infrastructure successor (run attempt two), zero user failures, and user
attempt one. It records the original pending observation, both run IDs, lease
expiry, completion time, and the final inspectable result, with zero manual
ticks. This proves unattended recovery; unlike the separate sleep receipt, it
does not attribute a particular resume to queue delivery versus cron.
