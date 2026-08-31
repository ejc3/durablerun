# durablerun

`durablerun` is a Turso-first TypeScript durable-workflow engine. The current
dogfood task records a durable repository-ref observation journal: each
checkpoint reads a GitHub ref and records its commit SHA, tree SHA, and commit
timestamp, then sleeps without keeping a worker alive.

## Run locally

Requires a Node version satisfying `package.json`'s `engines.node` declaration
and pnpm 10.

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
An observed task, store, lease, registry, or launcher failure makes that tick
exit nonzero after the engine has performed its normal lease reconciliation.

For a quick two-pass demonstration:

```sh
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:start
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:tick
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:tick
DURABLERUN_DOGFOOD_CYCLES=2 DURABLERUN_DOGFOOD_INTERVAL_SECONDS=0 pnpm dogfood:status
```

## Run PostgreSQL conformance

The shared conformance matrix requires PostgreSQL 17 through
`DURABLERUN_POSTGRES_URL`. For a disposable local service:

```sh
podman run --rm --name durablerun-postgres-17 \
  -e POSTGRES_DB=durablerun -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1:5432:5432 -d postgres:17-alpine
DURABLERUN_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/durablerun \
  bash scripts/confine.sh pnpm verify
```

CI and nightly jobs provide the same PostgreSQL service; no repository secret
is required.

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
idempotent task. Both `start` and the receipt verifier reject a durable task
whose type or complete parameters differ from the current intent; the verifier
also rejects spans below seven days. While a journal is live, its database-clock
receipt must advance by the configured interval within two hourly scheduling
slots; a stalled ordinal therefore fails instead of producing vacuously green
evidence. Give `DURABLERUN_DOGFOOD_KEY` a new value to start a new workload.

The opt-in GitHub Actions workflow runs one tick each hour, prevents overlap,
and retains every status receipt for 30 days. Configure the repository secrets
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, and independently pin the same
dedicated URL in the repository variable `DURABLERUN_DOGFOOD_DATABASE_URL`.
The workflow refuses a missing or mismatched pin before any command can run the
migrator. Then set `DURABLERUN_DOGFOOD_ENABLED=true`; the schedule remains
skipped until that variable is set. The job has no repository-token permissions
and checks out this public repository anonymously. If authenticated GitHub API
reads are needed, add an optional read-only `DOGFOOD_GITHUB_TOKEN` secret; only
the worker steps receive it. First dispatch `start`, then enable the schedule.
`workflow_dispatch` can also run either deliberate death probe. Each probe uses
a fresh one-checkpoint journal on a key-derived isolated queue, records status
before the fault, hard-exits at the selected actor boundary, clears only the
one-shot injection hook while retaining the probe queue identity, waits through
the short test lease/backoff, runs normal recovery ticks, and records status
afterward.
