# PR3.6 — Build proposal 3's spine (`fence_stamp`), with per-statement stamps grafted in

## 0. What I verified first (all four proposals make claims that are wrong)

| Claim | Verdict |
|---|---|
| `ALTER TABLE … ADD COLUMN` on `WITHOUT ROWID` | **Works**, metadata-only |
| `UPDATE … WHERE fence_stamp = ?` vs pre-v4 NULL rows | **0 rows** — old rows structurally unmatchable |
| `unixepoch('subsec')` statement-stable, incl. inside a scalar subquery | **Yes** |
| Value-identical UPDATE `rowsAffected` on SQLite | **1** (so MySQL's changed-rows semantics is an invisible trap) |
| Today's spawn under a `task_id` collision | **Raises `SQLITE_CONSTRAINT_PRIMARYKEY`** — the targeted `ON CONFLICT` does *not* swallow a PK conflict. Adding `WHERE NOT EXISTS (…task_id…)` turns it into `rowsAffected 0` |
| `ORDER BY (t.fence_stamp = ?) DESC` puts the stamped row first on SQLite | Yes — but PG defaults NULLS FIRST. **Shape banned.** |
| **"loser writes nothing" postcondition (proposals 3 & 4's flagship)** | **UNSOUND — measured.** I ran `reschedule` under `world.injectDuplicate`: pass 1 `[cas=1, task-mirror=1]`, pass 2 `[cas=0, task-mirror=1]`. `injectDuplicate` replays `call.statements` — the *same compiled batch, same bound stamp* — so the follow-on re-matches its own stamped row while the CAS loses. An always-on `won===null ⇒ follow-ons wrote 0` throws on every duplicate cell of the fault matrix. **Rejected.** |
| Proposal 1's emit `wake-tasks` (correlated `EXISTS` on runs) | **`SCAN tasks`** — full table scan per emit |
| Proposal 1's variant B (`task_id IN (SELECT … FROM runs WHERE fence_stamp=?)`) | **`SCAN r`** — full scan of runs |
| Proposal 4's emit `wake-runs` (`queue=? AND wake_event=?` driver) | **`runs_poll (queue=?, state=?)`** — walks every sleeping run in the queue |
| The shape I chose (waits-driven, then runs by PK) | **`SEARCH tasks PK` + `COVERING INDEX waits_event` + `runs PK`** — clean |
| The existing plan-pin harness can EXPLAIN writes | **No** — `EXPLAIN QUERY PLAN UPDATE …` through `LibsqlExecutor.batch` throws `SQLITE_BUSY` in both modes. New plumbing required. |
| Spawn RED test at `fence-provenance-regressions.test.ts:242` | **Unsatisfiable** — asserts `SELECT run_id FROM runs` is `[]` *and* that `result.runId` exists in `runs`. Must be rewritten. |
| `spec-ledger` cross-check `minted⇒[cas-fenced]` (proposals 3 & 4) | **Would fail the build**: `Scheduler.tla:221` tags `'spawn' -> Spawn [receipt]` and `'claim' -> [receipt]`. Constructor mode and duplicate-semantics class are different axes. **Rejected.** |

---

## 1. The decision

**Spine: proposal 3** (`fence_stamp` — one provenance column, one fence expression). It is the only proposal whose central move is *forced*: I re-derived it per op and four of five ops independently demand a stamp home, and `fanOut` becomes dead code, which is the signal a design is right rather than additive.

**Four grafts, each fixing something the spine gets wrong:**

1. **`fence_at_ms` (proposal 1)** — the second column. Unanimous across all twelve judge verdicts, and it is the only thing that makes "a follow-on may not read the clock" satisfiable with **zero exemptions**. Concretely: `suspend`'s `marker` needs the batch instant and its CAS writes *no* NOW column (it NULLs `heartbeat_at_ms`, and `available_at_ms` is `NOW+?` or a bare `?`). Without a uniform instant column, `suspend` is an exemption and the rule becomes "holds by luck".

2. **Per-statement stamps (proposal 2's brand-the-stamp idea, generalized)** — the graft that fixes the spine's worst flaw. One stamp per batch **aliases across statements**: `fail` discriminates retry vs terminal on `EXISTS (runs WHERE run_id = :successorId AND claimed_by = $STAMP$)`, and when the successor id collides with the parent's, the stamped *parent* answers yes — the terminal arm (the only writer of the failure reason) is skipped. That is RED test `:181`, and renaming the column reproduces it verbatim. Fix: the batch mints a **seed**; each stamp-writing statement writes `seed:<statementName>`; a follow-on names the statement it fences on. **The primitive generates the fence value**, so `fence('typo')` and `fence('a-later-statement')` are construction errors — genuinely unwritable, not regex-checked.

3. **Constructor rejections (proposal 2's degenerate-CAS instinct, re-aimed)** — I keep the *pressure*, not the machinery: no `carried()`/`receipt()` mode, no `FenceHome` union. Per-statement stamps make claim's CAS honestly fresh, so the receipt collapses to **one unfenced tail with a mandatory reason string**.

4. **StampAudit as a data-level checker (unanimous best runtime graft)** — with the stamp in `claimed_by` and inside `json_object('name','$Cancelled','stamp',…)`, "did this batch fence its writes?" is a property of *source text*. With a real column it is a property of *data*, checkable over every write from every path — including paths that never touch `FencedBatch`.

**Rejected outright:** proposal 2 (zero-DDL). Its own verdict concedes it would spend three columns if allowed, its `{clock:'fresh'}` flag is a rubber stamp required on ~90% of statements, and its activate fix **introduces a new class-A bug** (re-evaluating `cancel_at_ms > NOW` in the mirror, so a CAS that wins at T−0.4ms is followed by a mirror that skips at T+0.6ms, leaving `cancel_at_ms` armed on a task that started). Buying zero bytes at that price is the wrong trade against eleven findings in six rounds.

**Rejected knobs:** `mustFire` (correct value is a per-site judgment nothing checks; its absence is silent — the audit covers the class better), `casMany`'s weakened `won` (per-statement stamps restore per-row provenance, so the count is irrelevant to the fence), and the always-on loser-writes-nothing postcondition (measured unsound above).

---

## 2. Migration v4 — exact DDL

`packages/store-libsql/src/schema.ts`, appended (v1–v3 byte-frozen; `schema.test.ts`'s `FROZEN` gets **one new entry in the same commit** — the test asserts `Object.keys(FROZEN).length === MIGRATIONS.length`):

```ts
  {
    // Write provenance (DESIGN.md §3.4 rule 8). A CAS stamps the rows it
    // transitions with `<batch seed>:<statement name>` and records the ONE
    // instant the batch read; every later statement filters on that stamp and
    // derives every instant from fence_at_ms — never from a second clock read.
    // Nullable, no default, no index: rows written before v4 read NULL, and
    // NULL never equals a stamp, so pre-v4 rows are unmatchable by any fence
    // (verified). A stamp is a FILTER, never a lookup key — every fenced
    // statement is anchored by a primary key or an existing index.
    version: 4,
    statements: [
      `ALTER TABLE tasks  ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE tasks  ADD COLUMN fence_at_ms INTEGER`,
      `ALTER TABLE runs   ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE runs   ADD COLUMN fence_at_ms INTEGER`,
      `ALTER TABLE waits  ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE waits  ADD COLUMN fence_at_ms INTEGER`,
      `ALTER TABLE events ADD COLUMN fence_stamp TEXT`,
      `ALTER TABLE events ADD COLUMN fence_at_ms INTEGER`,
    ],
  },
```

Per-dialect equivalents (each store owns its list): MySQL 8 `ADD COLUMN fence_stamp VARCHAR(96) NULL, ALGORITHM=INSTANT`; Postgres `ADD COLUMN fence_stamp text` (catalog-only on 11+).

**`checkpoints`, `drivers`, `meta` get no columns** — and this is not a maintained exemption list. The StampAudit's table set is **derived from the schema** (`PRAGMA table_info` → tables having `fence_stamp`), and `batch-lint` gains the arm *"any table named as a `cas`/`casMany` target must declare `fence_stamp` in MIGRATIONS"*. A new CAS on `checkpoints` fails the build until v5 adds the column. The exemption is a schema fact, not a list.

---

## 3. `FencedBatch` — exact API

`packages/core/src/fenced-batch.ts`:

```ts
export const STAMP = '$STAMP$'     // this statement's own stamp: `<seed>:<name>`
export const NOW   = '$NOW$'       // the batch's clock expression, spliced as SQL

/** The single definition of the provenance write. Shared by every dialect. */
export const FENCE_SET  = `fence_stamp = ${STAMP}, fence_at_ms = ${NOW}`
export const FENCE_COLS = `fence_stamp, fence_at_ms`
export const FENCE_VALS = `${STAMP}, ${NOW}`

export type FenceTable = 'tasks' | 'runs' | 'waits' | 'events'
export type RowBound   = 'one' | { many: string }   // 'many' costs a written reason

export class FencedBatch {
  constructor(label: string, seed: string, opts: { now: string })

  /** Exactly-one-row CAS. Wins iff rowsAffected === 1. Writes `<seed>:<name>`. */
  cas(name: string, target: FenceTable, sql: string, args?: Args): this

  /** Up-to-`max`-row CAS (claim). Wins iff rowsAffected >= 1; asserts <= max
   *  after commit. Every row it touches carries `<seed>:<name>`, so per-row
   *  provenance is UNCHANGED by the relaxed win rule. */
  casMany(name: string, target: FenceTable, max: number, sql: string, args?: Args): this

  /** The fence VALUE for a named earlier stamp-writing statement. Compiles to
   *  a bind of `<seed>:<casName>`. Throws if `casName` is unknown or is added
   *  LATER — you cannot fence on provenance that does not exist yet. */
  fence(casName: string): string          // returns `$FENCE:casName$`

  followOn(name: string, sql: string, args: Args, rows: RowBound): this
  followOn(name: string, target: FenceTable, sql: string, args: Args, rows: RowBound): this
  //  ^ the 2nd overload STAMPS the rows it writes (required when the follow-on
  //    writes a fenced table); the 1st is for DELETEs and non-fenced targets.

  /** Trailing SELECT that may only see rows this batch stamped. */
  tail(name: string, sql: string, args?: Args): this
  /** A read of rows this batch did NOT write. `reason` is mandatory, non-empty,
   *  and printed in the batch trace. Exactly two call sites in the store. */
  openTail(name: string, reason: string, sql: string, args?: Args): this

  run(db: SqlExecutor, mode?: SqlBatchMode):
    Promise<{ won: string | null; count: number; results: Record<string, SqlResult> }>
}
```

`fanOut()` and its `via` escape (`sql.includes(STAMP) || sql.includes(via)` — satisfiable by merely *naming* a table) are **DELETED**. It has zero callers today; once `events` and `runs` carry stamps, an emit fan-out is an ordinary `followOn` with `rows: {many: …}`. The API gets smaller while getting stricter.

### Construction-time checks (throw)

Let `whereSuffix(sql)` = the text from the **first `WHERE` at paren-depth 0** to the end (so a `WHERE` inside a SET-clause subquery does not count), and let a fence occurrence be **positive** if it is not inside a `NOT EXISTS (…)` / `NOT IN (…)` group.

1. **`cas`/`casMany` must WRITE the stamp into `target`.** UPDATE form: `FENCE_SET` appears *before* `whereSuffix`. INSERT form: the column list contains `FENCE_COLS` and the VALUES/SELECT contains `FENCE_VALS`. `INSERT … ON CONFLICT … DO UPDATE` must additionally set `fence_stamp = $STAMP$, fence_at_ms = $NOW$` in the DO UPDATE. Anything else throws. *(Today's check is `sql.includes(STAMP)` — satisfied by a CAS that merely READS the stamp. That hole closes.)*
2. **`followOn`/`tail` must FILTER on a fence, in the WHERE side, positively.** `whereSuffix` must contain ≥1 **positive** `fence_stamp = $FENCE:x$`. A SET-clause occurrence alone does not satisfy it — this is the self-defeat the mandated `fence_at_ms = (SELECT … WHERE … fence_stamp = …)` copy would otherwise create. A follow-on whose *only* fence is negative (`fail`'s `task-terminal`) must carry a positive one too — it does (`task_id = (SELECT … fence_stamp = fence('fail'))`).
3. **`fence(name)` must name an already-added stamp-writing statement.** Unwritable, not textual.
4. **No `$NOW$` in `followOn`/`tail`/`openTail`.** Class A dies in follow-on position — comparisons included, because a re-evaluated deadline in a follow-on is exactly how proposal 2's activate fix reintroduced the bug.
5. **A `followOn` that writes a `FenceTable` must declare the target and stamp it** (`FENCE_SET` / `FENCE_COLS+FENCE_VALS`). Without this the StampAudit and the constructor disagree.
6. `openTail` requires a non-empty reason; `tail`/`openTail` must be SELECT.
7. `rows` is **required** on every follow-on. `{many: reason}` costs a written justification.
8. Retained: `BLIND_COUNTER` on follow-ons (now also on `casMany`), duplicate statement names, ≥1 CAS, ≤1 CAS wins.
9. `opts.now` must not contain `?` (it is spliced as raw SQL; a bind inside it would desynchronize the arg list).

`compile()`'s token regex becomes `/\?|\$STAMP\$|\$NOW\$|\$FENCE:[a-zA-Z0-9_-]+\$/g`. `$STAMP$` binds `` `${seed}:${statement.name}` ``, `$FENCE:x$` binds `` `${seed}:${x}` ``, `$NOW$` splices `opts.now` as text.

### Runtime checks in `run()`
- `rows: 'one'` ⇒ `rowsAffected <= 1`, else throw. Free (counts already in hand).
- `casMany` ⇒ `rowsAffected <= max`, else throw.
- ≤1 CAS wins (existing).
- **No loser-writes-nothing postcondition** — measured unsound under exact replay.

### The contract requirement this places on every dialect
`opts.now` must be **statement-stable** (one value for all occurrences within one statement). SQLite `unixepoch('subsec')` is (verified). MySQL `NOW(6)` is; `SYSDATE()` is not. **Postgres must use `statement_timestamp()`, not `clock_timestamp()`** — and `DESIGN.md:517` currently names `clock_timestamp()`, which is per-call. That is a live spec bug; fix it in increment 1.

---

## 4. Per-op decomposition

Shorthand: `F('x')` = `batch.fence('x')` → `fence_stamp = $FENCE:x$`. `eligibleTaskAt(t, i)` is `fragments.ts` parameterized on an instant (default `NOW`).

### spawn — `new FencedBatch('spawn', ids.token(), {now: NOW_MS})`

```sql
-- cas('task', 'tasks', …)
INSERT INTO tasks (task_id, queue, task_name, params, headers, retry_strategy,
        max_attempts, cancellation, idempotency_key, state, enqueue_at_ms,
        cancel_at_ms, created_at_ms, fence_stamp, fence_at_ms)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', $NOW$ + ?,
       CASE WHEN ? IS NOT NULL THEN $NOW$ + ? + ? ELSE NULL END,
       $NOW$, $STAMP$, $NOW$
WHERE NOT EXISTS (SELECT 1 FROM tasks x WHERE x.task_id = ?)     -- (A)
ON CONFLICT (queue, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING

-- followOn('run', 'runs', …, rows: 'one')
INSERT INTO runs (run_id, queue, task_id, attempt, state,
                  available_at_ms, created_at_ms, fence_stamp, fence_at_ms)
SELECT ?, t.queue, t.task_id, 1, 'pending', t.enqueue_at_ms, t.fence_at_ms,
       $STAMP$, t.fence_at_ms
FROM tasks t WHERE t.task_id = ? AND t.fence_stamp = $FENCE:task$

-- openTail('receipt', 'the idempotency winner is a task some OTHER batch
--   created; it is fenced by the unique (queue, idempotency_key) index, not
--   by this batch's stamp', …)
SELECT t.task_id AS task_id,
       (SELECT r.run_id FROM runs r WHERE r.task_id = t.task_id
          ORDER BY r.attempt DESC, r.run_id DESC LIMIT 1) AS run_id
FROM tasks t WHERE ? IS NOT NULL AND t.queue = ? AND t.idempotency_key = ?
```

Guard **(A)** is new and load-bearing: I verified the targeted upsert **raises** `SQLITE_CONSTRAINT_PRIMARYKEY` on a `task_id` collision today (so spawn currently *crashes*); (A) converts it to `rowsAffected 0`, which the primitive can reason about. Two guards **delete themselves**: `AND state IN LIVE` (a row we just inserted is 'pending') and `AND NOT EXISTS (SELECT 1 FROM runs WHERE task_id=?)` (a task one statement old has no runs). `created_at_ms` copies `t.fence_at_ms` — one clock read for the batch, down from four.

TS: `if (won === 'task') return { taskId, runId, created: true }`; else read the receipt; `runId: row.run_id === null ? null : String(row.run_id)`. **`SpawnResult.runId` becomes `string | null`** — on an idempotency hit against a task with no runs there is no honest answer, and the current code fabricates the never-inserted local id. The `ORDER BY (t.task_id = ?) DESC` shape is gone (it is also the PG NULLS-FIRST trap). Plan measured: `COVERING INDEX tasks_idem` + `COVERING INDEX runs_task_attempt`.

### claim — `casMany`, no receipt mode

```sql
-- casMany('claim', 'runs', effectiveLimit, …)
UPDATE runs SET
  state = 'running',
  claimed_by = ?,                         -- the LEASE (survives the batch)
  fence_stamp = $STAMP$, fence_at_ms = $NOW$,   -- the PROVENANCE (dies with it)
  claim_gen = claim_gen + 1, lease_ms = ?,
  claim_expires_at_ms = $NOW$ + ?, heartbeat_at_ms = $NOW$
WHERE run_id IN ( …the UNCHANGED bounded per-state UNION candidate subselect… )
  AND NOT EXISTS (SELECT 1 FROM runs held
                  WHERE held.queue = ? AND held.state = 'running' AND held.claimed_by = ?)

-- followOn('task-book', 'tasks', …, rows: 'one')
UPDATE tasks SET state = 'running',
  last_attempt_run = (SELECT r.run_id FROM runs r
                      WHERE r.task_id = tasks.task_id AND r.fence_stamp = $FENCE:claim$),
  fence_stamp = $STAMP$,
  fence_at_ms = (SELECT r.fence_at_ms FROM runs r
                 WHERE r.task_id = tasks.task_id AND r.fence_stamp = $FENCE:claim$)
WHERE state IN ${LIVE}
  AND task_id IN (SELECT task_id FROM runs
                  WHERE queue = ? AND state = 'running' AND fence_stamp = $FENCE:claim$)

-- followOn('waits-timeout', …, rows: {many: 'a run may hold several timed waits'})
DELETE FROM waits
WHERE run_id IN (SELECT run_id FROM runs
                 WHERE queue = ? AND state = 'running' AND fence_stamp = $FENCE:claim$)
  AND status = 'waiting' AND timeout_at_ms IS NOT NULL
  AND timeout_at_ms <= (SELECT r.fence_at_ms FROM runs r
                        WHERE r.run_id = waits.run_id AND r.fence_stamp = $FENCE:claim$)

-- openTail('picked', '§3.4 rule 4: the same-token receipt is defined by the
--   LEASE token, which by contract survives the batch — a replay must return
--   the ORIGINAL selection, i.e. rows a PREVIOUS batch stamped', …)
SELECT ${CLAIMED_RUN_COLUMNS} FROM runs r JOIN tasks t ON t.task_id = r.task_id
WHERE r.queue = ? AND r.claimed_by = ? AND r.state = 'running'
  AND t.state IN ${LIVE} ORDER BY r.run_id
```

`queue = ? AND state = 'running'` is retained purely as the **access path**; plans measured identical to today (`runs_poll (queue=?, state=?)`). This closes a bug nobody listed: today the follow-ons key on `claimed_by = token`, so a **duplicate claim delivery** — whose CAS correctly matches zero on the `NOT EXISTS held` guard — still runs the wait DELETE against the *first* delivery's rows with a **fresh clock read**, deleting waits that became due between the two deliveries. With a fresh per-invocation stamp the duplicate writes nothing, and the tail still returns the original selection. `rows: 'one'` on `task-book` is the amplification bound; per-row stamps mean `casMany`'s relaxed win rule costs nothing.

**`DESIGN.md §3.4 rule 4 must be amended in the same diff** — it currently says follow-ons "key strictly on the fresh `claimed_by = :claim_token`"; they now key on the stamp and only the receipt keys on the token.

### activate — the op the column exists for

```sql
-- cas('activate', 'runs', …)
UPDATE runs SET
  activated_gen = ?, fence_stamp = $STAMP$, fence_at_ms = $NOW$,
  started_at_ms = COALESCE(started_at_ms, $NOW$),
  claim_expires_at_ms = $NOW$ + lease_ms, heartbeat_at_ms = $NOW$
WHERE run_id = ? AND queue = ? AND claimed_by = ? AND state = 'running'
  AND claim_gen = ? AND activated_gen < ?
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = runs.task_id AND ${eligibleTask('t')})

-- followOn('task-start', 'tasks', …, rows: 'one')
UPDATE tasks SET
  first_started_at_ms = COALESCE(first_started_at_ms,
    (SELECT r.fence_at_ms FROM runs r WHERE r.run_id = ? AND r.fence_stamp = $FENCE:activate$)),
  cancel_at_ms = CASE
    WHEN json_extract(cancellation, '$.maxDurationSeconds') IS NOT NULL THEN
      CAST(COALESCE(first_started_at_ms,
        (SELECT r.fence_at_ms FROM runs r WHERE r.run_id = ? AND r.fence_stamp = $FENCE:activate$))
        + json_extract(cancellation, '$.maxDurationSeconds') * 1000 AS INTEGER)
    ELSE NULL END,
  fence_stamp = $STAMP$,
  fence_at_ms = (SELECT r.fence_at_ms FROM runs r WHERE r.run_id = ? AND r.fence_stamp = $FENCE:activate$)
WHERE state IN ${LIVE}
  AND task_id = (SELECT r2.task_id FROM runs r2
                 WHERE r2.run_id = ? AND r2.fence_stamp = $FENCE:activate$)

-- tail('payload')
SELECT ${CLAIMED_RUN_COLUMNS} FROM runs r JOIN tasks t ON t.task_id = r.task_id
WHERE r.run_id = ? AND r.fence_stamp = $FENCE:activate$ AND r.state = 'running'
```

The CAS preserves `claimed_by` untouched — the exact degree of freedom that was missing. The live bug (RED `:210`): today the follow-on fences on `(claimed_by, activated_gen)`, which the **winner** wrote, so a losing duplicate re-runs `cancel_at_ms = CASE … ELSE NULL END` and clears an armed `maxDelay` deadline — a task past its deadline is never cancelled. With a per-delivery stamp the loser's every subselect returns zero rows. The six-line comment at `store.ts:399-405` explaining why `cas.rowsAffected` is the discriminator is **deleted along with the problem**: `won` is the discriminator and the tail is fenced. Plan: `tasks PK` + two `runs PK`.

### awaitEvent — the `parkStamp` becomes the batch's stamp

```sql
-- cas('register', 'waits', …)
INSERT INTO waits (run_id, step_name, queue, task_id, event_name, status,
                   timeout_at_ms, created_at_ms, fence_stamp, fence_at_ms)
SELECT ?, ?, ?, ?, ?, 'waiting',
       CASE WHEN ? IS NOT NULL THEN $NOW$ + ? ELSE NULL END, $NOW$, $STAMP$, $NOW$
WHERE NOT EXISTS (SELECT 1 FROM events WHERE queue = ? AND event_name = ?)
  AND EXISTS (SELECT 1 FROM runs r WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                AND r.claimed_by = ? AND r.state = 'running')
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = ? AND ${eligibleTask('t')})
ON CONFLICT (run_id, step_name) DO NOTHING

-- followOn('park', 'runs', …, rows: 'one')
UPDATE runs SET
  state = 'sleeping',
  available_at_ms = (SELECT w.timeout_at_ms FROM waits w
                     WHERE w.run_id = ? AND w.step_name = ? AND w.fence_stamp = $FENCE:register$),
  wake_event = ?, event_payload = NULL, wake_step = ?,
  claimed_by = NULL, claim_expires_at_ms = NULL, heartbeat_at_ms = NULL,
  fence_stamp = $STAMP$,
  fence_at_ms = (SELECT w.fence_at_ms FROM waits w
                 WHERE w.run_id = ? AND w.step_name = ? AND w.fence_stamp = $FENCE:register$)
WHERE run_id = ? AND queue = ? AND task_id = ? AND claimed_by = ? AND state = 'running'
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})
  AND EXISTS (SELECT 1 FROM waits w WHERE w.run_id = ? AND w.step_name = ?
                AND w.status = 'waiting' AND w.fence_stamp = $FENCE:register$)

-- followOn('task-mirror', 'tasks', …, rows: 'one')
UPDATE tasks SET state = 'sleeping', fence_stamp = $STAMP$,
  fence_at_ms = (SELECT r.fence_at_ms FROM runs r WHERE r.run_id = ? AND r.fence_stamp = $FENCE:park$)
WHERE task_id = ? AND state IN ${LIVE}
  AND EXISTS (SELECT 1 FROM runs r WHERE r.run_id = ? AND r.state = 'sleeping'
                AND r.fence_stamp = $FENCE:park$)

-- openTail('hit', 'the event row was written by some OTHER batch; this read is
--   fenced on the LIVE claim token instead, so a zombie falls through to the
--   park discriminator and gets the lease error', …)
SELECT payload FROM events WHERE queue = ? AND event_name = ?
  AND EXISTS (SELECT 1 FROM runs r WHERE r.run_id = ? AND r.queue = ? AND r.task_id = ?
                AND r.claimed_by = ? AND r.state = 'running')
```

`const parkStamp = this.ids.token()` — which the postmortem calls "a verbatim reimplementation of `FencedBatch`'s stamp, proving the primitive was the right shape" — is **deleted**. `claimed_by = NULL` is now honest (a parked run holds no lease). The park keys on a wait *this batch inserted*, so RED `:270` (borrowing a stale untimed wait and inheriting its NULL timeout → parked forever) becomes a clean `LeaseLostError`; that branch is unreachable in legal states (a committed wait implies a parked run implies `claimed_by IS NULL`, so the CAS's guard was already failing). The `timeout_at_ms`/`available_at_ms` split is now structural — the park physically cannot name the clock.

**I keep the hit branch as an unfenced read**, rejecting proposals 3/4's `delivered`-row write: that turns `AwaitEventHit` from a read into a write, which under the spec-first rule requires a TLA change + TLC re-run before the SQL is written, and it adds unbounded `waits` growth inside a long run with no GC rung. Not worth it for this PR.

### emitEvent — the fan-out, with the measured plan

```sql
-- cas('event', 'events', …)
INSERT INTO events (queue, event_name, payload, emitted_at_ms, fence_stamp, fence_at_ms)
VALUES (?, ?, ?, $NOW$, $STAMP$, $NOW$)
ON CONFLICT (queue, event_name) DO UPDATE SET
  fence_stamp = $STAMP$, fence_at_ms = $NOW$      -- payload/emitted_at_ms UNTOUCHED

-- followOn('wake-runs', 'runs', …, rows: {many: 'an emit wakes every waiter'})
UPDATE runs SET
  state = 'pending',
  available_at_ms = (SELECT e.fence_at_ms FROM events e
                     WHERE e.queue = runs.queue AND e.event_name = ? AND e.fence_stamp = $FENCE:event$),
  wake_event = ?,
  event_payload = (SELECT e.payload FROM events e
                   WHERE e.queue = runs.queue AND e.event_name = ? AND e.fence_stamp = $FENCE:event$),
  fence_stamp = $STAMP$,
  fence_at_ms = (SELECT e.fence_at_ms FROM events e
                 WHERE e.queue = runs.queue AND e.event_name = ? AND e.fence_stamp = $FENCE:event$)
WHERE state = 'sleeping'
  AND run_id IN (SELECT w.run_id FROM waits w                     -- THE ACCESS PATH
                 WHERE w.queue = ? AND w.event_name = ? AND w.status = 'waiting')
  AND EXISTS (SELECT 1 FROM events e                              -- THE FENCE
              WHERE e.queue = runs.queue AND e.event_name = ? AND e.fence_stamp = $FENCE:event$)
  AND EXISTS (SELECT 1 FROM tasks t WHERE t.task_id = runs.task_id AND t.state IN ${LIVE})

-- followOn('wake-tasks', 'tasks', …, rows: {many: 'one task per woken run'})
UPDATE tasks SET state = 'pending', fence_stamp = $STAMP$,
  fence_at_ms = (SELECT e.fence_at_ms FROM events e
                 WHERE e.queue = tasks.queue AND e.event_name = ? AND e.fence_stamp = $FENCE:event$)
WHERE state IN ${LIVE}
  AND task_id IN (SELECT r.task_id FROM waits w JOIN runs r ON r.run_id = w.run_id
                  WHERE w.queue = ? AND w.event_name = ? AND r.fence_stamp = $FENCE:wake-runs$)

-- followOn('waits-gone', …, rows: {many: 'every waiter for a fired event'})
DELETE FROM waits WHERE queue = ? AND event_name = ? AND status = 'waiting'
  AND EXISTS (SELECT 1 FROM events e WHERE e.queue = waits.queue
                AND e.event_name = waits.event_name AND e.fence_stamp = $FENCE:event$)
```

Three deliberate calls, each against at least one proposal:

- **`wake-tasks` is waits-driven, then `runs` by PK.** Proposal 1's correlated `EXISTS` measured `SCAN tasks`; proposal 1's IN-list variant measured `SCAN r`. This shape measured `SEARCH tasks PK` + `COVERING INDEX waits_event` + `runs PK`. It still never reads `waits.task_id` — the target is the woken **run's** own task — so RED `:304` (a wait belonging to run rA but naming healthy task B flips B to pending) closes, and rA is still woken (no stranding).
- **`wake-runs` keeps the `run_id IN (waits …)` driver.** Proposal 4's `queue=? AND wake_event=?` driver measured `runs_poll (queue=?, state=?)` — a queue-wide walk of the sleeping set, the largest set in a durable-execution engine.
- **`ON CONFLICT DO UPDATE` on the fence only.** `EventImmutable` holds (payload and `emitted_at_ms` untouched). This preserves today's re-emit-re-delivers behavior, so no straggler wait becomes permanently undeliverable — which matters because `wait-for-fired-event` (invariants.ts:139) treats a surviving pair as a lost wakeup, and because on PG/MySQL READ COMMITTED there is a real registration window. `Scheduler.tla`'s re-emit stutter-step argument is unchanged; only the ledger parenthetical needs rewording. **No TLC re-run required.** I do NOT write `wake_step` here (emit does not today; adding it would strand pre-v3 rows whose `wake_step` is NULL).

---

## 5. Ordered increments — each independently `pnpm verify` green

| # | Change | Blast radius |
|---|---|---|
| **1** | Migration v4 + `FROZEN[4]` + **minimum-schema-version gate** (verify: `schemaVersion()` is currently read only inside `migrate()`; nothing refuses to serve below `CURRENT_SCHEMA_VERSION`, and with `fence_stamp` on every CAS a v3 DB under a v4 binary fails *every* op). Fix `DESIGN.md:517` `clock_timestamp()` → `statement_timestamp()`; add the statement-stability rule. | Inert — no readers. `suite.ts`'s `SELECT *` snapshots gain a key. |
| **2** | `fragments.ts`: `cancelDue/cancelNotDue/eligibleTask` take an instant expression, default `NOW`. | Pure refactor, no call-site change. |
| **3** | New `FencedBatch` surface added **permissively** (old checks still accepted). Per-statement stamps, `fence()`, `$NOW$`, `rows`, `openTail`. Plus the two pre-migration insurance tests: **construct every labeled batch** (enumerated from the ledger — rare branches like `fail`-without-retry would otherwise ship unconstructible) and a **golden compiled-SQL + bound-args snapshot per label** (the left-to-right compiler now mixes four token kinds; the existing arg-*count* assertion cannot catch an arg-*order* bug). | Additive. |
| **4** | Retrofit the 8 already-fenced ops onto `fence_stamp`/`fence_at_ms`; `claimed_by = NULL` on every terminalizing/reviving CAS (preserves the zombie defense that `suite.ts:236` asserts); delete `json_object('name','$Cancelled','stamp',…)` and its two `json_extract` fences → constant `REASON_CANCELLED`; re-key `USER_ATTEMPTS_FROM`/`INFRA_RETRIES_FROM`; the three follow-ons that read `NOW_MS` (`fail`/`sweep:claim-timeout` successors, `suspend`'s marker) derive from `fence_at_ms`. **Turns RED `:181` green** (per-statement stamps). | 8 working ops. Gate = conformance + fault matrix, not inspection. |
| **5** | Flip construction checks to **strict**; delete `fanOut`. | Build-time only, over already-green code. |
| **6** | **StampAudit executor** + **write-plan pin harness** (needs a raw `libsql` client — the current harness `SQLITE_BUSY`s on `EXPLAIN QUERY PLAN UPDATE`) + pins for every statement increments 7–11 rewrite, asserting **index terms**, not the absence of `SCAN`. | Test-only. |
| **7** | **spawn** → FencedBatch. `SpawnResult.runId: string \| null`. **Rewrite the unsatisfiable RED test** at `:242`. | One op + one type. |
| **8** | **activate** → FencedBatch. RED `:210` green. | One op. |
| **9** | **claim** → `casMany`. Amend §3.4 rule 4. | One op + spec text. |
| **10** | **awaitEvent** → FencedBatch. RED `:270` green. `parkStamp` deleted. | One op. |
| **11** | **emitEvent** → FencedBatch. RED `:304` green. Ledger parenthetical reworded. | One op. |
| **12** | **Delete `FENCED_DEBT` and the set itself**; `batch-lint` arms (CAS target must declare `fence_stamp`; any `INSERT/UPDATE` of a fenced table outside a `FencedBatch` chain fails; `fence_stamp = ?` banned); `clock-lint` arm (`NOW_MS` only in `cas`/`casMany`); reclassify `set-checkpoint` (it is a genuine **two-write** batch currently sitting in `READ_OR_SINGLE`); postmortem under `postmortems/`. | Build gates. |

Increment 4 must precede 5, and 12 must be last. 7–11 are independently orderable.

---

## 6. What each rung actually holds

**Unwritable (rung 1 — construction throws):**
- A CAS that does not write `fence_stamp`+`fence_at_ms` into its declared target table.
- A follow-on/tail with no **positive** fence in its **WHERE side** (a SET-clause subquery no longer satisfies the check).
- `fence('x')` where `x` is not an already-added stamp-writing statement. **Genuinely structural** — this is what kills the `fail` id-collision class, and it is not a text check.
- Any `$NOW$` in follow-on or tail position. **Class A dead in follow-on position, with zero exemptions**, only because `fence_at_ms` exists.
- `claimed_by`-as-fence and `failure_reason`-JSON-as-fence: both stop compiling.
- `fanOut`'s "name the provenance table" escape: deleted.
- An unfenced read without a written reason.

**Build-caught (rung 2):** the `FENCED_DEBT` set is gone, so there is no place to record new debt; a CAS on a table lacking `fence_stamp`; a fenced-table write outside a `FencedBatch` chain; `NOW_MS` outside CAS position; a rewritten statement whose query plan loses an index term.

**Runtime/test-caught only (rung 3):** the **StampAudit** (every inserted-or-changed row carries a `<seed>:*` stamp from its batch; deleted PKs diffed against the fenced set) — always-on in conformance, fault matrix and the poison surface; sampled in the fuzz volume legs, off in `verify:fuzz:deep` (measured `SELECT COUNT(*) … WHERE fence_stamp=?` is a `SCAN`, ~1.5ms at 20k rows — a per-batch check would make the deep leg infeasible). Plus `rows`/`max` bounds, the clock-jitter executor (now a **differential proof**: with `$NOW$` banned in follow-ons, jitter must produce zero behavioral change), and the new invariant `state <> 'running' AND claimed_by IS NOT NULL`, which is only expressible once the stamp leaves that column.

**Loser-writes-nothing** is a *harness* assertion, not a primitive one: `SimWorld` knows when it injected a duplicate, so it asserts "no CAS won and a follow-on wrote ⇒ this call was a duplicate injection". That is sound; the always-on version is not.

---

## 7. Cannot be made structural — documented deferrals (BUILD.md)

1. **The fence proves the batch stamped a row; it does not prove a follow-on's target *set* is derived from stamped rows.** `UPDATE tasks SET state='pending', fence_stamp=$STAMP$ WHERE queue=? AND EXISTS (SELECT 1 FROM runs WHERE fence_stamp=$FENCE:x$)` passes every check and passes the audit. `rows:'one'` catches that instance; emit's fan-outs are necessarily `{many:…}` and have no bound. The true rung-1 answer is a typed target-expression API where a follow-on cannot name a raw identifier and the primitive generates the join — which fights pluggability, since join shapes differ per dialect. **Deferred, explicitly.** Class B moves from *writable by default* to *writable only by disconnecting a fence you were forced to type*. Anyone reading this as "class B is now impossible" is reading it wrong.
2. **Postgres double-claim** on `UPDATE … WHERE id IN (subselect)` — `casMany` guarantees a win rule, not a concurrency semantics. store-pg must use `FOR UPDATE SKIP LOCKED`; a conformance scenario must exist before PG is DONE.
3. **§3.4 rule 2's PG/MySQL lock prelude** — `FencedBatch` has no statement kind for a lock acquisition, and check 2 rejects any non-tail statement without a fence. Needed only when store-pg lands; a `lock()` kind with mandated CAS-after-lock ordering is the shape.
4. **MySQL `won` cannot come from `rowsAffected` alone** — no targeted `ON CONFLICT`; ODKU reports 2 for an updated row and fires on any unique key; changed-vs-matched rows flips with `CLIENT_FOUND_ROWS`. The `SqlResult` normalization contract must state matched-not-changed semantics, and spawn's MySQL CAS must be the `NOT EXISTS` form with ER_DUP_ENTRY mapped to "lost".
5. **The whole scheme is exactly as strong as `IdSource.token()` uniqueness**, and the test harness deliberately hands out colliding ids. Add a sim assertion that a seed is never issued twice per run.
6. **Zombie emit** — emit is global and has no run identity; already an SDK-side lease check (commit `a33470b`), not closable in the store.

**Cost, stated:** ~45 bytes/row across four tables (a 32-hex seed + `:name` + a varint), ~+13–18% on `runs`. No index anywhere — deliberately, and it is a contract rule, not an omission. Zero marginal page cost (every CAS already dirties the row it stamps). Read cost: emit's `wake-runs` goes from 3 correlated legs to 6; claim's `task-book` from 1 to 2. Turso bills rows, not bytes, and no plan loses an index term — verified statement by statement.",
