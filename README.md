# durablerun

`durablerun` is a Turso-first TypeScript durable-workflow engine. The current
dogfood task records a durable repository-ref observation journal: each
checkpoint reads a GitHub ref and records its commit SHA, tree SHA, and commit
timestamp, then sleeps without keeping a worker alive.

The minimal hosted-alpha deployment is in
[`examples/vercel-turso`](examples/vercel-turso/README.md): four authenticated
Web Request endpoints, a one-slot inline tick, Turso storage, Vercel cron
recovery, and a bounded end-to-end receipt.

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
  -e POSTGRES_INITDB_ARGS="--locale-provider=icu --icu-locale=en-US" \
  -p 127.0.0.1:5432:5432 -d postgres:17-alpine
DURABLERUN_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/durablerun \
  bash scripts/confine.sh pnpm verify
```

CI and nightly jobs provide the same PostgreSQL service; no repository secret
is required. The ICU arguments give the database a linguistic collation. Without
them this image sorts text by its bytes, which hides any statement that orders by
the database's collation, as a managed PostgreSQL server may.

## Run MySQL conformance

The same matrix requires MySQL 8 through `DURABLERUN_MYSQL_URL`. The suite
creates a database for every case, so the disposable service keeps its data on
a tmpfs with the binary log and durable flushes off:

```sh
podman run --name durablerun-mysql-8 \
  -e MYSQL_ROOT_PASSWORD=durablerun -e MYSQL_DATABASE=durablerun \
  -p 127.0.0.1:3306:3306 --tmpfs /var/lib/mysql:rw,size=4g -d docker.io/library/mysql:8.4 \
  --skip-log-bin --innodb-flush-log-at-trx-commit=0 --innodb-doublewrite=0 \
  --sync-binlog=0 --max-connections=500
DURABLERUN_MYSQL_URL=mysql://root:durablerun@127.0.0.1:3306/durablerun \
  bash scripts/confine.sh bash packages/conformance/bin/dialect-conformance.sh mysql
```

`packages/conformance/bin/dialect-conformance.sh` runs one dialect's conformance, its store's
own tests and the six test files of the CLI that run on each selected dialect, and fails a
run that exercised nothing. `pnpm verify` runs every
enrolled dialect, so it needs all three servers unless
`DURABLERUN_CONFORMANCE_DIALECTS` names the ones it has, as a comma list such
as `libsql,postgres`. CI runs MySQL in its own job, `conformance-mysql`, beside
`verify`.

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

## Operating a deployment

The operator CLI reads and drives a deployment's database directly. It is in
this repository and is not published: run it from a checkout, as `pnpm cli
<command>`. `pnpm cli help` lists every command, flag and exit code, and
DESIGN.md section 3.11 says what each one does.

**The environment.** `DURABLERUN_STORE_URL` names the database, and
`DURABLERUN_STORE_TOKEN` holds the token of a libSQL server. No other variable
is read for the store. A database credential is full admin, so the CLI never
prints the token or a credential of the URL. Of the URL it prints the host or
the file path, which `--target` names, and the scheme, in every answer of a
command that opened a store. Every command that writes names its store a second
time with `--target`: the host of the URL, or the path of a `file:` URL. A
`--target` that names another store changes nothing and exits 2. A command
exits 4 when the store refuses the credential, or what the credential may do,
and it fails the same way until the credential changes. Exit 6 is an outage,
which is safe to repeat. In the lines
below, `<host>` stands for that host and `example-queue` for the queue.

**The schema window.** A build reads the schema versions its store package
names. On libSQL they run from 5, the release alpha.1, to the build's own. On
PostgreSQL and MySQL a build reads only its own version. A database outside
that window is refused with exit 5 before anything is sent. `pnpm cli doctor --queue
example-queue` prints the build's version and the version the database records.
`purge` and `selftest` take only the build's own version.

**The order, for a database the release alpha.1 serves.** Each step is one
command, and each is safe to stop after.

1. Take a snapshot or a branch of the database. Everything up to step 4 runs on
   the branch, with `DURABLERUN_STORE_URL` and `--target` naming the branch.
2. Migrate the branch. Without `--yes` the command prints the versions it would
   apply and changes nothing.

   ```sh
   pnpm cli migrate --target <branch-host>
   pnpm cli migrate --target <branch-host> --yes
   ```

3. Run the self-test on the branch, on a queue of its own that holds nothing.
   It sends the batches the other commands send and says what each call
   answered. It spawns two tasks and emits one event there and deletes nothing. Keep
   its `--json` report: the week's receipt holds it.

   ```sh
   pnpm cli selftest --queue selftest-example --target <branch-host> --json
   ```

4. Migrate the database itself, with the alpha.1 host left running. The release
   alpha.1 runs on a database at the build's version: the compatibility harness
   of `pnpm verify:packages` holds that, at every version from 5 to the build's.
5. Never run the example's `pnpm migrate` or `pnpm receipt` from an alpha.1
   checkout against that database again. alpha.1's own `migrate()` refuses a
   database recorded above version 5. The example's scripts in this repository
   check the recorded version first and leave such a database alone.
6. Read a dry run of the purge, under the windows of your retention policy. It
   lists what a purge would take and what the barrier keeps, with the reason,
   and writes nothing.

   ```sh
   pnpm cli purge --queue example-queue --target <host> --completed-after 7d --cancelled-after 7d
   ```

7. Purge. One run takes at most `--limit` units, 100 by default, from the
   oldest. Run the same command again until its report says `more: false`. A
   purge with no `--failed-after` keeps every failed task.

   ```sh
   pnpm cli purge --queue example-queue --target <host> --completed-after 7d --cancelled-after 7d --execute
   ```

**Find, explain, act.** `stuck` lists what the driver owes a queue, and with
`--older-than` every live task older than a duration. `explain` names one cause
for a task, from a closed table, with a verdict and the next command to read.
`cancel`, `retry` and `emit` change nothing without `--yes`. No command line
`explain` suggests carries `--yes`: the operator adds it.

```sh
pnpm cli stuck --queue example-queue --older-than 1d
pnpm cli explain <task-id> --queue example-queue
pnpm cli inspect <task-id> --queue example-queue
pnpm cli cancel <task-id> --queue example-queue --target <host> --yes
```

`stats` prints a queue's gauges and `sizes` its row counts. `sweep` makes the
moves a driver's sweep makes, once. `enqueue` spawns a task under an
idempotency key, so the same line after a lost answer finds the task it made.

### A week on a deployment, and its receipt

The recurring workflow of the hosted example is one task for each period:
`periodic-digest` reads one GitHub ref and sleeps once. An external scheduler
enqueues it each hour under the key `digest-<period>`, where the period is the
hour in UTC, as `date -u +%Y-%m-%dT%H` prints it:

```sh
pnpm cli enqueue periodic-digest --key digest-2026-01-05T09 --params '{"repository":"example-owner/example-repository","ref":"main"}' --queue example-queue --target <host>
```

`.github/workflows/operable-week.yml` is that scheduler and the daily purge.
It is off: its one job runs only while the repository variable
`DURABLERUN_WEEK_ENABLED` is `true`. Turned on, it writes one task to
the pinned database each hour, and once a day it records `stats` and `sizes`
and then runs `purge --execute` until the verb says no more remain. It holds a
database credential, so it first requires the secret URL to equal the URL a
repository variable pins. The enqueue and the purge, which write, name their
`--target` from the pinned URL. `stats` and `sizes` are reads and take no
`--target`, so that first check alone holds them to the pinned database. Its
reports are files in the run's artifact, and no report goes to the log. The
file's first comment lists the secrets and variables it needs.

GitHub can start a scheduled run late, or drop it. The checker refuses a week
in which one sample is more than 25 hours after the one before it, as
`missing-daily-snapshot`, and no later sample repairs that. So when a day's
scheduled run has not started within an hour of its time, start it by hand
before the 25 hours are up: run the workflow from the repository's Actions
page with the operation `daily`, or run `gh workflow run operable-week.yml -f
operation=daily`. A late or dropped hourly run costs one period, and the
checker allows eight of the 168 to be missing.

**The commit the week runs.** The workflow runs the CLI of one commit, and
the repository variable `DURABLERUN_WEEK_COMMIT` names it by its full id, 40
hexadecimal digits. The job fetches and checks out that commit and no other.
A value that is no full id, a branch or a short id among them, stops the job
before any command opens the store. So does a commit that is not in main's
history, a commit of a branch that was never merged among them, and a commit
that tracks a file named `week-*`, the name the job keeps a report under.
GitHub reads the workflow file itself
from the default branch, so the steps are main's and the CLI they run is the
pinned commit's: a pull request that merges during the week changes no member
of a report. The receipt's other reports come from the same build. Run the
selftest before the week, and the lookups and the dry run after it, from a
checkout of the commit the variable names.

**A refused token.** A command the store refuses the token for exits 4, with
the kind `store-access-refused`: the token is missing, or is one the server
does not accept. Those are the two refusals measured against a hosted server,
which answered 401 to each. What a server answers a token that has expired or
was revoked was not measured, and a status other than 401 or 403 does not
exit 4. The job stops at that command and does not run it again, and
a later run fails the same way until the secret `DURABLERUN_WEEK_STORE_TOKEN`
holds a token the store accepts. Replace the secret, then start the day's run
by hand, as above, before the 25 hours are up. An hourly enqueue that was
refused costs its period, as a dropped run does. A purge that exited 4 was a
run the store failed. Its report goes into that day's purge reports as
printed, beside the reports of the run that finished.

A week receipt is one JSON document that holds what the CLI printed with
`--json` during a week of at least 168 hours:

- `kind`, which is `week`, and `queue`, the week's queue;
- `selftest`: the report of step 3;
- `start` and `end`: a `stats` report and a `sizes` report of the queue;
- `days`: for each day, a `stats` report, a `sizes` report, and the day's
  `purge --execute` reports, every run's as printed, a run the store failed
  (exit 4, 6 or 7) beside the one that finished. A purge the command refused was
  no run and its report is left out, but for one: a purge refused because the
  database's test clock was set goes in, and the checker refuses the week for
  the clock, as `test-clock-set`;
- `failedDryRun`: a dry run of `purge` with `--failed-after 1h`, taken after
  the end sample beside the windows the week's purges ran under. An hour is
  the shortest window the verb takes, so the dry run lists every failed task
  the week's purges kept. The checker refuses a longer failed window;
- `lookups`: an `inspect --key` report for each period no purge report names;
- `seal`, `injection`, `explanation` and `attestation`: the sealed injection,
  below.

**The end of the week.** Take the end sample, then turn the workflow off, and
only then take the lookups and the dry run. The workflow is off once
`DURABLERUN_WEEK_ENABLED` is no longer `true`. A daily purge that runs after
the end sample deletes units whose lookups the receipt needs: a lookup is the
`inspect --key` report of a period that no purge report in the receipt names,
and a purge the receipt does not hold would leave that period with neither.

`pnpm week-receipt <receipt.json>` checks a receipt. It exits 0 when it accepts the
receipt, and 1 when it refuses it, with a line for each cause. DESIGN.md
section 3.11, "The week receipt", holds the members it reads, the causes it
refuses for, and the bound it holds each table's row count to.

**The sealed injection.** It shows that an operator who holds only the CLI and
the store URL finds a stuck task nobody told them about. The checker can prove
only the hash, so the order of the steps is the maintainer's to attest.

1. Before the start sample, a second person enqueues one task that will not
   end by itself, into the week's queue: a task name the deployment has no
   handler for, or a task that awaits an event nobody emits. The checker
   reads the start sample and the operator's explanation of that queue, so a
   task in another queue is not the injected one.
2. The same person waits until the deployment has taken the task, and only
   then notes the task's id and the cause `pnpm cli explain` names for it.
   Right after the enqueue `explain` names `pending-due-unclaimed` for either
   kind, which is not the cause the operator will be shown. Once the deployed
   alpha has taken the task, at its next tick, a task of a name with no
   handler is `never-started-alpha1-form`, a task that awaits an event nobody
   emits is `awaiting-an-untimed-event`, and each stays so until the operator
   clears it. A hash made over an earlier cause refuses the week's receipt,
   as `explanation-differs-from-the-seal`. It cannot be made again once the
   start sample is taken, because the hash is published before that sample.
   With the cause noted, the person picks a nonce and publishes the sha256 of
   the three, each followed by a line feed, telling the operator nothing else:

   ```sh
   printf '%s\n%s\n%s\n' "$TASK_ID" "$CAUSE" "$NONCE" | sha256sum
   ```

3. The maintainer records when the hash was published. The receipt's
   `attestation` holds that instant and who attests it, and the checker
   refuses an instant after the start sample.
4. During the week the operator finds the task with `stuck --older-than`,
   names its cause with `explain`, keeps that report as the receipt's
   `explanation`, and clears the task with `cancel --yes`. The bound allows
   the rows a cancel adds to the task. A task cleared another way is over it:
   an awaiting task whose event is emitted completes, and holds a checkpoint
   the bound does not allow.
5. After the week the second person reveals the task id, the cause and the
   nonce, which are the receipt's `injection`. The checker computes the hash
   again and requires the explanation to be of that task and to name that
   cause.
