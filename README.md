# durablerun

`durablerun` is a Turso-first TypeScript durable-workflow engine. The current
dogfood task records a durable repository-ref observation journal: each
checkpoint reads a GitHub ref and records its commit SHA, tree SHA, and commit
timestamp, then sleeps without keeping a worker alive.

## Run locally

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm dogfood:start
pnpm dogfood:tick
pnpm dogfood:status
```

The default database is the ignored local file `dogfood.db`. `start` is
idempotent: rerunning it returns the task selected by
`DURABLERUN_DOGFOOD_KEY`. `tick` performs one bounded scheduler pass, runs a
claimed worker inline, and exits. Run it from cron or another scheduler; an
idle tick launches no worker process and retains no idle compute.

For a quick two-pass demonstration:

```sh
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:start
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:tick
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:tick
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:status
```

## Run against remote Turso

Copy `.env.example` to `.env` and set `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN` to a **dedicated empty database**. Never point the dogfood
migrator at another application's database. The optional `GITHUB_TOKEN` is
used for authenticated GitHub reads when present; it is never stored in the
workflow.

Run `pnpm dogfood:start` once, schedule `pnpm dogfood:tick` at least as often
as the configured interval, and use `pnpm dogfood:status` to inspect task
state, terminal failure reason, checkpoint ordinals and owners, retry
accounting, relaunches, and the first-to-last checkpoint span. The default 15
cycles contain 14 12-hour intervals, so that span is at least seven days.

Changing repository, ref, cycles, or interval does not mutate an existing
idempotent task. Give `DURABLERUN_DOGFOOD_KEY` a new value to start a new run.

The opt-in GitHub Actions workflow runs one tick each hour, prevents overlap,
and retains every status receipt for 30 days. Configure the repository secrets
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, then set the repository variable
`DURABLERUN_DOGFOOD_ENABLED=true`. It remains skipped until that variable is
set. First dispatch `start`, then enable the schedule. `workflow_dispatch` can
also run either deliberate death probe. Each probe uses a fresh one-checkpoint
journal, records status before the fault, hard-exits at the selected actor
boundary, waits through the short test lease/backoff, runs normal recovery
ticks, and records status afterward.
