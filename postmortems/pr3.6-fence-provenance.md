# Postmortem: write provenance — forty-four ways a batch statement acted without proof (PR3.6)

The engine executes each store operation as one atomic batch of SQL
statements. Later statements in a batch see the effects of earlier ones, and
the design depends on that: a batch's first statement does the guarded
compare-and-set, and the rest are supposed to fire only when it won. The rule
(DESIGN.md §3.4 rule 1) is that a later statement must key on state *this
batch just wrote*, never on state that could already have been there.

Seven review passes against this branch found forty-four defects. Six were
later statements firing on state that could pre-exist. Findings 7–10, 13, and
17–19 were in the checkers and gates this same PR had just built; three could
not fail at all. Twelve more came from a re-review. A fourth pass and a
mutation probe found nine more, five of them introduced by the rewrite itself;
a fifth pass, run in an isolated worktree after two earlier attempts died on
an upstream content filter, found four more -- three of them the same "a stamp
is not authorship" class in operations the earlier rounds had not reached, and
one a lost wakeup created by the fix for a spurious one. A sixth pass, asked
for a design opinion rather than a review, found three more — one of them
inside the generator this round built to make the recurring class unwritable —
while the mutation probe and one tooling accident found three others. The
verdict of the first round was "do not merge"; the second round's was "snapshot
`3ff14bf` is not correct"; the sixth's was "the current state is not
acceptable".

The common shape is one sentence: **the engine had nowhere to write down who
made a write, so every operation borrowed a column that already meant
something else** — `runs.claimed_by` (a worker's lease) and
`tasks.failure_reason` (a user-visible string). A borrowed column can be
written by something other than the batch reading it, so a statement keyed on
one fires for a stale or duplicated caller. That is not a coding mistake to be
avoided; it is the direct consequence of having no correct place to record the
fact. The fix is migration v4: two columns, `fence_stamp` and `fence_at_ms`,
on every table a compare-and-set targets.

## Severity

Every one of the six provenance defects is silent. None throws, none logs, and
each leaves the database in a state the engine's own invariants forbid while
every subsequent read looks ordinary.

Worst first: **a task reported permanently failed while a run for it is still
queued and will execute.** The caller sees a failure that never happened; the
work then runs anyway under a task nobody is watching. Next: **a task that was
never started is never cancelled**, because a duplicate activation that was
correctly refused still cleared the deadline the cancellation depended on —
the one mechanism that bounds a stuck task, disarmed by a delivery the engine
had already rejected. Then: **a workflow that should time out parks forever**,
because an await inherited a stale wait row's absent deadline. Then **a caller
polling a run id that does not exist**, forever, indistinguishable from a run
that has not started. Then **corrupt state amplified into a healthy task**,
which rule 6 forbids outright.

Those checker and gate defects are their own severity: a checker that cannot
fail is worse than no checker, because it is believed. Three could not fail at
all. One of them — the attestation gate — **refused to attest the very branch
that introduced it**, so the only ways forward were to mangle good documents
or to bypass branch protection. A gate that can only be satisfied by defeating
it teaches people to defeat it.

## Findings

Rounds: **P** = provenance review, **G** = gate/simplify review, **R** =
re-review after the rewrite, **S** = independent simplification review,
**M** = the mutation probe (this PR's own new audit), **X** = found by
re-reading my own diff.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | P: replaying the claim-timeout sweep at the infra-retry cap terminalizes the task while the successor the first pass created is still pending | A task is reported permanently failed while a run for it is queued and will execute — work runs under a task nobody is watching | The generated fault matrix, which already injects a duplicate at exactly this batch label | The matrix varies the FAULT but not the PRE-STATE. Its canonical workload never reaches 19 infra retries, so the cap boundary where the bug lives is never visited | Boundary-state dimension crossed with the existing label x fault grid (rung 2, generated) |
| 2 | P: when a failing run's minted successor id collides with its own, the stamped parent is mistaken for the successor | The task ends failed with no failure reason recorded, so the caller cannot see why | Seeded id collision is an established seam here, with case law for a successor collision in `fail` | The existing case pinned a different symptom. Nothing generalized "a stamp names a BATCH, not a ROW", so every discriminator asking "does row X carry my stamp" was unguarded whenever the batch stamped more than one row | Per-STATEMENT stamps, generated by the primitive (rung 1) |
| 3 | P: an activate carrying a stale generation correctly fails its compare-and-set and returns null, but its task follow-on still matches and clears the task's armed cancellation deadline | A task that was never started is never cancelled: its start deadline is silently disarmed and the sweep has nothing left to fire on | The batch primitive, which exists to make this shape unwritable | `activate` hand-rolled its batch, because the primitive could not express an operation whose compare-and-set must PRESERVE the row's owner token and so had nowhere to write a stamp | A provenance column, so the stamp stops competing with the lease (rung 1) |
| 4 | P: spawn reports the run id it minted even when it never inserted it | The caller polls a run id that does not exist and never will; the task looks stuck forever | The batch primitive | Same root cause: `tasks` had no column to write a stamp into, so the run insert could not key on "our task insert won" | Route through the primitive; `SpawnResult.runId` typed nullable (rung 1) |
| 5 | P: awaitEvent's wait registration silently does nothing when a wait already exists for the same run, step and event; the park then borrows that stale row and inherits ITS timeout | An old untimed wait plus a new 30-second await parks the run forever — a workflow that should time out never wakes | The batch primitive | Same root cause: `waits` carried no stamp, so registration could not be distinguished from a conflict. The operation hand-minted its own stamp — a verbatim reimplementation of the primitive | Route through the primitive; the park keys on the wait THIS batch inserted (rung 1) |
| 6 | P: emitEvent reads task ids from the waits table instead of from the runs it woke | A corrupt wait row naming an unrelated healthy task flips it to pending while its own run keeps running — corrupt state amplified, which rule 6 forbids | The batch primitive | Same root cause: its follow-ons fan out over every waiter, and the primitive only knew how to key on a single stamped row | Fan-out driven by the batch's own woken rows (rung 1) |
| 7 | G: the attestation gate refused to attest its own branch — it demanded every added `postmortems/*.md` be a full postmortem, and the branch adds design notes | Merge blocked; the only ways forward were mangling good documents or bypassing branch protection | Nothing — the gate was one commit old | A gate is code, and this one had never been run against a realistic branch | Identify a postmortem the way the template defines one, by its heading (rung 2) |
| 8 | G: the same gate named 2 of about 12 template placeholders | A verbatim copy of the template attests as a filled-in postmortem | Nothing | The placeholder list was hand-written beside the template instead of derived from it | Derive every requirement from TEMPLATE.md itself (rung 2) |
| 9 | G: `batch-lint` read only quoted-literal labels | A multi-statement write with two raw clock reads passed batch-lint, the spec ledger and the label inventory simultaneously — and a real computed label had been shipping unseen | Nothing | The checker skipped silently what it could not parse | Total harvest: every call site must resolve or be declared (rung 2) |
| 10 | G: `clock-lint` was case-sensitive while SQL is not | `UNIXEPOCH()` and `now()` both passed; `now()` is the canonical Postgres spelling | Nothing | Never run against the spellings it claims to cover | Case-insensitive, call-shaped, with self-test fixtures (rung 2) |
| 11 | G: the successor insert re-fired on an exact replay | Threw a unique-constraint error; the driver awaits the sweep bare, so one duplicated item discarded an entire tick | The fault matrix's duplicate injection | It injected at a different label first, and the race resolved before the boundary was reached | Replay guard on the statement's own provenance (rung 1) |
| 12 | G: `ctx.emitEvent`'s payload bypassed the user boundary | `JSON.stringify(obj.missing)` type-checks and returns undefined; the driver rejected the bind, the store wrapped it as an outage, and the handler body re-ran 20 times before the task died with no user-visible reason | The user-boundary lint | It covered names and durations. A serialized VALUE was a third kind of user input with no validator to bypass | `userJsonValue`, plus a structural undefined-bind check at the executor (rung 1) |
| 13 | G: no lint in the repo had a test proving it can fail | Two checkers shipped broken in the PR that introduced them | Nothing | The bug in each was in what the pattern did NOT match, which reading source is worst at | `scripts/lint-selftest.py`: fixtures each checker must reject, plus ones it must accept (rung 2) |
| 14 | R: a replay after its successor has been claimed no longer recognises the successor | Insert re-fires and dies on the unique (task_id, attempt) index, discarding a tick; where the insert is refused first, the terminal arm fails a task whose retry is running under a live worker | The duplicate-injection tests | They replay a batch back to back, so every row still looks as the batch left it. A stamp proves CURRENT provenance, and claiming a run re-stamps it | Successor identity keyed on ownership, which does not decay (rung 1); a test file for replays after the world moved on (rung 3) |
| 15 | R: emitEvent wakes a run that is not parked on the event | A run asleep on a durable timer, plus a leftover wait row naming it, resumes up to its whole remaining sleep early — and the wait row that proved the mismatch is deleted in the same batch, so nothing afterwards looks wrong | Rule 6 coverage | Finding 6's fix corrected which TASK was woken and left which RUN untouched | Require `wake_event`/`wake_step` to match the wait (rung 1) |
| 16 | R: `clock-lint` accepts any number of `${NOW_MS}` across separate statements | The class-A bug itself passes the checker built to prevent it: a run due at one instant and its wait expiring at another lets a claim deliver an early timeout while leaving the wait registered | `clock-lint` | It bans raw clock FUNCTIONS; the sanctioned expression used twice is the actual bug | Clock reads counted per statement in `batch-lint`, which parses batch shapes (rung 2) |
| 17 | R: `review-attest.sh` accepts its own source as both review artifacts | A green `adversarial-review` status with no review at all | Nothing | Substring matching on marker strings the script itself contains | Reject any git-tracked file as an artifact; require the terminal marker as a whole line and no error at the end (rung 2) |
| 18 | R: six template placeholder lines begin with a dash, so grep parsed them as options and exited 2 — read as "placeholder absent" | A postmortem left verbatim from the template passes on exactly those six lines | Finding 8's fix | It derived the placeholders correctly and then passed them to grep unsafely. A checker that fails OPEN is worse than none | Pass every pattern with an explicit -e (rung 2) |
| 19 | R: a declared count of eight findings was satisfied by a postmortem documenting one | The SEV rule met in form and skipped in substance | Nothing | The check was "at least one row" | Sum rows across added postmortems; must cover the declared count (rung 2) |
| 20 | R: spawn could create a run under the wrong pre-existing task when a task-id collision and an idempotency conflict coincided | The caller receives the wrong task; a later claim executes a different task's name and parameters | Nothing | The targeted `ON CONFLICT` covered only the idempotency index | Fixed by the rewrite: the insert guards on its own primary key, so a colliding id is an ordinary lost compare-and-set |
| 21 | R: the successor discriminator returned true for a foreign run at a colliding id | The task is stranded — pending, with no live run of its own, while an unrelated run executes | Case law existed for the loud-failure direction | The discriminator checked id, stamp and state but never OWNERSHIP | Fixed by the rewrite: the ownership predicate distinguishes mine from foreign |
| 22 | R: the retry cap tested `attempts + 1 < max_attempts` while the counter derived `attempt - infra_retries` | A counter drifted one ahead — reachable from the historical blind-increment bug, and inside the accounting band — makes the task fail permanently one attempt early | The accounting invariant | Its band legitimately admits both values; the two spellings disagree only off the healthy path | One definition of the user ordinal at both sites (rung 1) |
| 23 | R: `UserName.parse` assumed a string | A non-string throws a plain TypeError, which the worker treats as an ordinary user failure and RETRIES — one deterministic bad call runs `maxAttempts` times, repeating whatever the handler did before it | The user-boundary lint | It governs which validator is called, not what the validator accepts | Type check inside the validator, classified as a permanent failure (rung 1) |
| 24 | R: the blind-counter check matched only `x = x + <digit>` | `x = x + ?`, `x = t.x + 1`, `x = (x + 1)`, `x = 1 + x`, `x = x - 1` all double-count a failure on replay; the retry budget is spent twice. It also rejected a string literal merely containing the words | The checker itself | Written from one example | Every spelling, tested in both directions, against the write clause with literals blanked (rung 2) |
| 25 | R: `requirePositiveInt` accepted `MAX_SAFE_INTEGER` | A successor written at an ordinal SQLite stores and JavaScript cannot represent; every later claim decoding it throws and the task sits pending with no worker able to take it | The numeric port contract (rule 7) | It bounded durations and epochs, not counts, and a count bounds a run ordinal | `MAX_COUNT` at the port (rung 1) |
| 26 | R/S: the token `fence()` returns is ordinary text, so `$FENCE:typo$` can be typed straight into the SQL | A typo, a name added later, or a name that writes no stamp all build and compile to a filter matching nothing — the statement never runs, silently and forever, while the batch reports success. A follow-on that never runs looks exactly like one with nothing to do | `fence()` itself | It checked the caller and then handed back a string; the check lived at the convenient API rather than at the boundary — the same shape as the primitive's original `sql.includes(STAMP)` | Every fence token in a statement's text is validated where all statements pass (rung 1) |
| 27 | M: deleting the follow-on half of the provenance check broke nothing | A follow-on could write a provenance table and leave the provenance alone, producing rows whose stamp still names whatever batch touched them last | The primitive's own unit tests | The compare-and-set half had tests; the follow-on half had none. Direction of evidence again: green proves the checks accept correct SQL | Rejection tests for both halves; the probe that found it (rung 2) |
| 28 | M: deleting spawn's primary-key guard broke nothing | A task-id collision raises a constraint error out of spawn at a caller who did nothing wrong | The collision regression test | It collides on the id AND the key, so the targeted `ON CONFLICT` absorbs it and the guard is never reached — and the call was wrapped in `.catch()`, so it passed either way | A case that collides on the id alone, and the rejection no longer swallowed (rung 3) |
| 29 | S: the emit fan-out scanned the whole runs table | Every emit walks every run in the engine. Introduced BY the fix for finding 15: adding the step match to the waiter subquery correlated it to `runs`, demoting it from the query's driver to a filter — measured, `SEARCH runs USING PRIMARY KEY` became `SCAN runs USING INDEX runs_poll` | The query-plan suite | It could not pin a WRITE at all: `EXPLAIN QUERY PLAN UPDATE` through the executor takes the writer lock and fails, so only reads had pins | A raw-client path for write plans, with the emit fan-out pinned and the correlated shape kept as a counter-example (rung 2) |
| 30 | S: the batch compiler coerced an undefined bind to null | Defeats finding 12's fix across the entire protocol surface: every operation goes through this compiler, so the executor's undefined check never saw one. Instead of the loud error, a valid statement was sent carrying a value the caller never meant | The executor's chokepoint | It guards the port; the compiler sits above it and had already substituted | The compiler refuses, and only when the argument slot exists so a short list still gets the count error (rung 1) |
| 31 | S: `reschedule` and `suspendRun` are documented as one transition and used different eligibility guards | A run whose task is past its cancellation deadline could re-park itself, putting it back into the queue the claim path refuses to launch from | Nothing | The comment asserted they were the same, which reads as a check and is not one | One predicate for both, with a test that fails if either drifts (rung 3) |
| 32 | S: the SDK sent the raw event name on await and the parsed one on emit | Identical today, since parsing only validates. The moment it normalizes anything, a wait registers under one spelling while the emit fires the other and never matches — a silently lost wakeup | The user-boundary lint | It governs which validator is called, not which of its two outputs is used afterwards | The validated value is the only one passed downstream (rung 3) |
| 33 | M: each half of the event correlation was untested | One regression test was satisfied by either half, so deleting either kept the suite green | The test added with finding 15 | It exercised one state, and the guard had become two independent conditions | A state that only `wake_event` rules out, and one that only `wake_step` does (rung 3) |
| 35 | R2: an exact replay of spawn dies on the run's primary key instead of returning a receipt | A caller retrying after a lost response gets an error for a spawn that fully succeeded; a retry without an idempotency key then creates duplicate work | The duplicate-injection fault matrix | It replays a batch back to back and spawn's label was covered, but the run insert's guard had been REMOVED as self-evidently unnecessary when the task became "one statement old" — true within one execution, false across two | The "no run yet" guard restored in ownership form (rung 1) |
| 36 | R2: a successor id colliding with the run being replaced commits a half-transition | In the sweep, a failed run under a task still marked running that no later claim or sweep rediscovers. In a worker failure with budget left, a permanently failed task the caller asked to retry | Finding 14's own fix | It made the parent satisfy "a run of my task already sits there", which is right for a replay and wrong for a collision | The parent is excluded, so a self-collision raises like a foreign one (rung 1) |
| 37 | R2: a run parked before `wake_step` existed can never be woken again | Waits and events predate that column and the migration backfills nothing, so such a run compares its step against NULL and is never woken — while the delete removes its wait anyway. The event is immutable and the wait is gone, so re-emitting cannot recover it: an untimed await strands forever on any upgraded database, and on any rolling deploy where an older process parks a run after a newer one migrated | Nothing | Introduced by finding 15's fix, two commits earlier: a lost wakeup created by the fix for a spurious one. No test covered a row written by an older schema | A NULL step matches any step of the event (rung 3) |
| 38 | R2: the max-duration deadline truncated where the port rounds | The port validates the duration promising nearest-millisecond rounding and then stores raw seconds; at 0.0005s the port says 1ms and the CAST said 0, making the deadline the start instant and cancelling the task on the spot | The numeric port contract (rule 7) | It governs what crosses the boundary, not what SQL does with it afterwards | ROUND, so the two agree (rung 3) |
| 34 | X: the claim-timeout sweep reported an exhausted infrastructure cap for two other reasons | An operator sees a cap exhaustion that did not happen, when the successor id already belongs to a run of this task or the task stopped being live partway | Nothing | It inferred the outcome from "the successor insert wrote nothing", which had one cause when written and gained two more | Each arm keys on the statement that actually fired (rung 3) |
| 39 | C6: the generated selection splices the caller's correlation in unparenthesised, so `a OR b` binds as `a OR (b AND fence)` | Every row matching the first disjunct joins the selection carrying no stamp. This is the fence-does-not-gate-the-write class, occurring INSIDE the generator built to make it unwritable, and introduced by this round's own rewrite | The generator, which is that class's mechanism | It builds the selection but splices caller TEXT into a boolean position, and `generated: true` also exempted it from both clause scanners — granted on the reasoning that generated SQL does not need scanning, true until the generator started interpolating | Bracket the correlation, as `narrow` already was (rung 1); mutation `generated-where-parens` |
| 40 | C6: the wake predicate's index driver and its witness can be satisfied by two DIFFERENT wait rows — one in this queue at the wrong step, one in another queue at the right step | A run wakes on a registration that does not exist, and the cleanup then removes only the first row, leaving a waiting row beneath a pending run. Introduced by finding 29's fix, which SPLIT the step match out of the driver subquery to keep the query plan indexed | Nothing. Three rounds had each added one condition to this predicate and each was right about its own counterexample | Every condition was checked; no one asked which ROW satisfied which condition, and reading the list cannot answer that | One witness carrying every condition (rung 1); a generated surface over corrupt wait rows in ones and PAIRS, crossed with every shape of park (rung 2) |
| 41 | C6: the emit deletes every registration naming the event, including those of runs it declined to wake | The event row is immutable, so a registration deleted without its run being woken can never be delivered — an untimed await strands with nothing left describing what it asked for. Each of the three conditions added to the wake predicate widened this silently | The `wait-for-fired-event` invariant, which names exactly this state | It could not fire. The only state it described was erased by the same batch that produced it, so it was true by construction rather than by the engine being right | The cleanup derives from the runs `wake-runs` stamped, so a declined registration survives and the invariant becomes reachable (rung 1) |
| 42 | M: the emit's query-plan pin EXPLAINed a hand-copied statement introduced as "structurally the same" | Deleting the entire index driver from the shipped statement left the plan suite green while every emit fell back to scanning the runs table. None of the conditions added over three rounds ever reached the copy | The query-plan suite itself | It pinned a second representation of the SQL — the shape this repo has a standing rule against — so it could only ever drift | Recover the statement by running the real operation through a recording executor (rung 2) |
| 43 | M: the wake surface generated only the wait rows, not the run's park | Deleting the `wake_event` condition kept it green: a mechanism with a hole on the day it was built, over the predicate it was built for | The surface itself | It varied one side of a two-sided correlation. Every run in it was parked on the event being emitted, so the condition asking whether it was had nothing to distinguish | Generate the park and the run state too; the probe of the surface is what found it (rung 2) |
| 44 | X: the mutation probe reverts work that arrives while it runs | An uncommitted fix vanished mid-session under a restore holding a snapshot from before it existed. The symptom was a test failing as though the edit had never been made, which is the most expensive way to learn it | The probe's own dirty-tree guard | It checks the START of a run; a run is minutes long and rewrites sources between every mutation | Restore only over the text the probe itself wrote, keeping anything else beside it (rung 1, for the tool) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| codex re-review (round 3) | 12 | no |
| the re-review and the simplification review jointly (finding 26) | 1 | no |
| gate/simplify review (round 2) | 7 | no |
| provenance review (round 1) | 6 | no |
| independent simplification review | 4 | no |
| codex round 5 | 4 | no |
| codex round 6 (a design opinion, not a review) | 3 | no |
| the mutation probe, built during round 4 | 3 + 2 | **yes** |
| re-reading my own diff | 1 | **yes** |
| the probe destroying my own uncommitted work | 1 | **yes** |
| the fault matrix, the fuzz, TLC, the invariant library, every lint | **0** | — |

Self-catch rate: **16%** (37 of 44 found by outside review). No previous round
recorded this number, which is itself part of the finding.

Round 6 on its own is **50%** — three of six ours. That is the first movement
in the number this document exists to track, and it is worth being precise
about where it came from, because it is not from better reviewing. Both of the
probe's two came from mutating code the round had just written: the plan pin
that tested a copy, and the wake surface that generated only one side of a
two-sided correlation. The mechanism that moved the rate is the habit of
attacking a mechanism the moment it is built, and both of its catches were
mechanisms that had a hole ON THE DAY THEY WERE WRITTEN. Six findings is a
small sample and 50% of six is not a trend; the claim here is only that the
detector which produced it now exists and did not before.

The zero on the last row is the headline. This project's automated machinery —
236 fault-matrix cells, 32 fuzz shards, a TLC model of 111.8M states, an
invariant library, eight linters — found **none** of the 44. Everything it
does catch, it caught before this round started. The two detectors that did
work are a probe written in the middle of the round and a person reading a
diff, and neither existed as a standing mechanism when the round began.

## Recurrence

One class recurred in every round: **a statement acts on rows it cannot
justify** — findings 1–6, 14, 21, 26, 35, 36, and now 39, 40 and 41. Fourteen
of forty-four, found in rounds 1, 3, 5 and 6, after round 1 instituted a
rung-1 mechanism against it. No other class recurred at all: the checker class
stopped once `lint-selftest` took an inventory, the clock class stopped once
`batch-lint` counted per statement, the port class stopped once the validators
were typed.

Finding 39 is the sharpest instance available: the class recurred INSIDE the
mechanism built to end it. That deserves a precise reading rather than a
despairing one, because the failure mode changed. Rounds 1–5 were a scanner
missing a spelling — a proxy leaking once per call site, which is a leak that
scales with the codebase and never closes. Finding 39 is a string-composition
bug in a generator: one defect, at one place, reachable from every call site
but fixed for all of them by four characters. A mechanism that concentrates a
whole class into a single point of failure has done most of its job even when
that point fails, and the evidence is that findings 40 and 41 are in the ONE
statement the generator cannot build, which is exactly where the theory
predicts the remaining bugs would be.

What the theory did not predict, and what is the real content of round 6:
having concentrated the class into one hand-written statement, we then went on
adding conditions to it for three rounds without ever asking what shape the
statement as a whole had to have. Findings 40 and 41 are both that — 40 is two
conditions answered by two rows, 41 is two statements disagreeing about which
registrations count. Neither is a missing condition, so no amount of the
per-condition scrutiny that closed the earlier rounds would have reached
either.

The reason is in the next section and it is the whole lesson of this document:
that mechanism checks a SYNTACTIC property (the statement's text contains a
positive fence token in its WHERE side) as a proxy for a SEMANTIC one (the
fence gates every row the statement writes). The proxy was called rung 1 —
"unwritable" — in round 1's postmortem. It is not. A proxy leaks forever, and
this one leaked in every round that followed.

## Mechanism audit — the false negative of each

Each row below was written as code, run against the current primitive, and
recorded from its output.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| a follow-on must carry a positive fence | claimed 1, actually 2 | `WHERE run_id = ? OR EXISTS (… fence_stamp = $FENCE:win$)` — the fence is present, positive, in the WHERE, and joined by OR, so it gates nothing |
| a fence under NOT does not count | 2 | `WHERE NOT (EXISTS (… fence …))` — only the exact spellings `NOT EXISTS (` and `NOT IN (` are recognised, so the parenthesised form reads as a positive fence |
| a follow-on may not read the clock | claimed 1, actually 2 | interpolating the clock expression's TEXT rather than the `$NOW$` token; the check looks for the token |
| the WHERE clause boundary | 2 | `SET -- WHERE⏎ x = (SELECT … fence …) WHERE task_id = ?` — the comment's WHERE is the first at depth zero, so a SET-clause fence counts as being in the WHERE side while the real WHERE has none |
| `rows: { many }` bounds a fan-out | 3 | nothing; `{ many: 'any reason at all' }` has no upper bound, so an unbounded write needs only a sentence |
| per-statement stamps | **1** | none found. The stamp value is generated by the primitive and bound by position; a statement cannot name provenance that does not exist |
| `FENCED_TABLES` as the CAS target type | **1** | none found. A compare-and-set against a table with nowhere to record provenance does not typecheck |
| `lint-selftest` inventory | 2 | a checker whose filename contains neither "lint" nor "ledger" is not enumerated |
| the mutation probe | 3 | a guard with no mutation written for it; the probe reports a stale pattern but cannot invent a new one |
| the generated selection | **1** for the fence, nothing above it | `key: 'run_id'` against `column: 'task_id'` — built and run: it compiles to `run_id IN (SELECT f.task_id FROM runs f …)`, fenced and generated and matching nothing, ever. The primitive proves the source rows were stamped and says nothing about whether the two sides are the same kind of identifier, so a mismatch is a statement that silently does nothing — the same class as finding 26 |
| the generated wake surface | 2 | corrupting the delivered payload (`f.payload \|\| 'X'`, chosen to keep the bind count identical). The surface passes 2/2 while 175 tests elsewhere fail: it decides WHETHER a run is woken and never WHAT it is woken with, because its whole oracle is "did the wake statement write this row" |
| the shipped query-plan pin | 2 | any semantically wrong statement whose access path is still indexed. It also explains exactly one write, asserted explicitly — a second write in the same batch would be unpinned rather than noticed |
| the probe's restore guard | **1** for what it writes | an edit to a file the probe never mutates, or one that happens to reproduce the mutated text byte for byte |
| the mutation probe's own mutations | 3 | a mutation that changes ARITY rather than behaviour. `s.step_name = runs.wake_step` -> `? IS NOT NULL` adds a bind the statement does not have, so the batch dies on the argument-count check and reports "caught" without the guard ever being exercised. One of the fourteen was this; it is now a tautology |

Three mechanisms are genuinely rung 1. Four of the seven claimed at rung 1 or 2
against the recurring class are syntactic proxies, and all four have a
demonstrated false negative.

The last row is the uncomfortable one. The probe is the detector that produced
both of our round-6 catches, and it had been certifying a guard it never
reached — the mutation compiled to a statement with the wrong number of binds,
so what failed was the compiler. A detector can be wrong in the direction that
FLATTERS it, and the only reason this surfaced is that the same mutation went
stale on an unrelated trailing paren. Nothing was looking for it.

## Fix-induced defects

Eight of the forty-four — findings 29, 30, 33, 36, 37, 39, 40, and the sweep's
misreported outcome — were introduced by the fixes for earlier findings in
this same round.

The two new ones sharpen the pattern rather than repeating it. Finding 39 was
introduced by the rewrite that was itself the answer to this whole class: the
generator removed the caller-authored WHERE from twenty-two statements and
then reintroduced the same defect once, in its own string composition. Finding
40 is more pointed still — it was introduced by the FIX FOR FINDING 29, which
split the step match out of the driver subquery to keep the query plan
indexed. That repair was correct about the plan, it was measured, and the
measurement is why nobody asked what splitting one predicate into two does to
the question of which row answers which half. A fix made under a performance
constraint changed a correctness property, and the performance evidence was
exactly what made it look finished.

The sharpest is 37: the fix for a spurious wake (waking a run not parked on
the event) created a lost wake (a run parked before `wake_step` existed can
never be woken again). A lost wake is strictly worse than a spurious one, so
that repair was net negative until the fifth round caught it. Finding 29 is
the same shape in performance: the identical fix turned an indexed lookup into
a full scan of the largest table in the engine.

None of these fixes were re-reviewed as new code. They were re-tested — the
suite passed after each — which is exactly the confidence the detection ledger
above says is unwarranted. A fix is new code written by someone whose mental
model is of the old shape, and this round provides six data points that it is
more dangerous than average code, not less.

## Evidence

- Red tests, each run and seen failing before its fix:
  - `c2f199e` — six provenance tests against `9654002`.
  - `c1ce4f2` — the fault matrix's starting-state axis.
  - `957628c` — two schema-version tests.
  - the replay-after-the-world-moved tests (findings 14, 15), which failed
    with `UNIQUE constraint failed: runs.task_id, runs.attempt` and with a
    timer sleep woken about a thousand seconds early.
  - the port and primitive tests for findings 23, 24 and 25.
  - round 6, each verified failing at the stated assertion before its fix:
    `b55032f` (finding 39, "expected 'cancelled' to be 'running'" — the task
    in the unstamped queue was written), `d166c65` (finding 40, "expected
    'pending' to be 'sleeping'"), `fcc7cfa` (finding 41, B's registration
    gone after an emit that did not wake B). Fixes: `aec536f`, `76b7835`,
    `f434586`. Mechanisms: `29d95fe` (the generated wake surface), `5551b5a`
    (the plan pin recovered from the shipped statement), `805b84e` (the
    probe's restore guard, verified in both directions).
- Fixes: the migration and eight-op retrofit; then activate, spawn,
  awaitEvent/emitEvent and claim in turn; then the ownership fix and the
  checker rewrites. Gate after the round-6 fixes: `pnpm verify` green — 620
  tests across 64 files, including 236 fault-matrix cells, 32 fuzz shards, the
  replay equivalence harness and the multi-process chaos legs; all nine
  checkers clean; the self-test rejects 41 bad inputs and accepts 5 good ones.
- Finders. The provenance round: *"Eight concrete correctness bugs remain. ...
  The full clock sweep found no remaining 'two NOWs that must agree' bug. No
  retained class finding exists in `claim`, `heartbeat`, `complete`,
  `reschedule`, `suspendRun`, `cancelTask`, or `setCheckpoint`. **Verdict: DO
  NOT MERGE.**"* The re-review: *"Review result: snapshot `3ff14bf` is not
  correct. I found 7 runtime correctness defects and 5 enforcement defects
  beyond the four regressions already recorded."*
- Claims that did NOT reproduce were tested and dropped rather than encoded:
  a losing spawn does not attach a run to a pre-existing task (the run insert
  selects by the caller's own task id, which does not exist when the insert
  lost) — kept as a guard inside the spawn test; and a symmetric max-attempt
  replay in `fail`, probed empirically and found clean (`attempts=1`, no
  invariant violations). One reported claim about the accounting formulas was
  checked and confirmed correct: *"On valid accounting state, both formulas
  are arithmetically correct ... The normal max-attempt and infra-cap edges
  are not off by one."*
- Two proposals were rejected as **measured unsound**, not on taste. An
  always-on "a losing batch writes nothing" postcondition was run against
  `reschedule` under duplicate injection: pass 1 `[cas=1, task-mirror=1]`,
  pass 2 `[cas=0, task-mirror=1]` — a replayed batch carries the same stamps,
  so its follow-on legitimately re-matches its own row, and the postcondition
  would throw on every duplicate cell of the fault matrix. A proposed
  spec-ledger cross-check would have failed the build on two correct entries.

## Root cause

Every layer that should have caught these was aimed at the layer below it,
and each defect lived in the gap.

The batch primitive made "a follow-on must reference the stamp" structural,
and five operations could not use it — not through neglect, but because the
primitive had nowhere to put a stamp for an operation that must preserve the
row's existing owner. Those five are exactly where findings 3, 4, 5 and 6
live. The primitive's own check was `sql.includes(STAMP)`, which a statement
that merely READ the stamp satisfied, and the primitive had no test of its own
at all: every check in it was believed because the engine on top of it passed.
That is the wrong direction of evidence — the engine passing shows the checks
accept correct SQL and says nothing about whether they reject anything.

The generated fault matrix varied the fault and the label but not the starting
state, so boundaries — the infra cap, the relaunch cap, the attempt cap —
were never visited. Its duplicate injection replays a batch back to back, so
every row still looks exactly as the batch left it; findings 14 and 15 need
the world to move on in between, which nothing generated.

The checkers were written, reviewed, wired into the gate and believed without
a single test proving any of them can fail. The bug in each was in what its
pattern did NOT match, and absence is what reading source is worst at.

Underneath all of it: the engine could not record who made a write, so the
question "did my batch do this?" was answered with proxies. Every proxy is
approximately right and wrong in a specific case, and this PR is a catalogue
of those cases.

Findings 26 to 34 add a second, sharper version of the same lesson: **five of
them were introduced by the fixes for earlier findings in this round.** The
emit fan-out's full scan came from the fix for the wrong-run wake. The
undefined-bind coercion covered the surface an earlier fix in this same branch
had just protected. Each half of a guard split in two lost its test. A repair
is a change, and a change made under the confidence of having just understood
something is not safer than any other change — it is less safe, because the
understanding is about the old shape.

Two lessons have their own shape.

Finding 17's obvious fix was **exactly backwards**: requiring the `tokens used`
marker near the END of a review log would have rejected the completed round and
attested the one killed by a content filter, because a finished round keeps
printing its verdict afterwards while an aborted one stops right there. Caught
only by running the check against both real logs. A checker reasoned about is a
checker untested.

And the mutation probe is the general form of all of it. Every mechanism here
was believed because the suite was green, which is evidence in the wrong
direction. Deleting the guards one at a time found three that nothing was
maintaining — including, twice, a guard added earlier in this very round.

## Mechanisms

Built in this PR:

- **Migration v4 and rule 8** — `fence_stamp`/`fence_at_ms` on every
  compare-and-set target. The table list is the contract's (core's
  `FENCED_TABLES`), and each dialect generates its own DDL from it, so a
  compare-and-set against a table with nowhere to record provenance does not
  compile. (rung 1)
- **Per-statement stamps** — `<seed>:<statement name>`, so no row can answer
  for another. The primitive GENERATES the fence value, making `fence('typo')`
  and a fence on a not-yet-added statement construction errors. (rung 1)
- **The clock ban outside a compare-and-set** — follow-ons derive instants
  from `fence_at_ms`, so class A has no legal instance left to hide in. This
  is satisfiable with zero exemptions only because `fence_at_ms` exists;
  `suspend`'s marker would otherwise be a standing exception. (rung 1)
- **Real construction checks** — a compare-and-set must WRITE provenance into
  its declared table; a follow-on must FILTER on a fence, positively, in the
  WHERE side; an upsert must re-stamp its conflict branch; a token inside a
  string literal is refused. 40 unit tests, each pairing a shape that must be
  refused with the nearest one that must still be accepted. (rung 1)
- **Ownership predicates for successor identity** — a stamp proves current
  provenance, not authorship, and any later transition overwrites it. (rung 1)
- **A boundary-state axis on the fault matrix** — label x fault x starting
  state, 236 cells. (rung 2, generated)
- **A replay-after-the-world-moved test file** — replays with real operations
  in between, the interleaving the immediate-duplicate injection cannot
  produce. (rung 3)
- **`batch-lint` checks shapes, not labels** — statement counts, read mode,
  and clock reads per statement, recursing into nested directories. A label is
  a claim about shape, and the claim is now checked. (rung 2)
- **`lint-selftest` takes an inventory** — every checker in `scripts/` must
  have at least one input it must reject. Adding that requirement immediately
  found four checkers with none. (rung 2)
- **Schema faults are permanent, not transient** — a missing column raises its
  own error type rather than being retried until the infrastructure budget is
  gone; `migrate()` asserts its own post-condition. (rung 1)
- **Separate random streams for ids and tokens** — so a test predicting a
  minted id does not break when unrelated code takes a token. (rung 3)
- **`scripts/mutation-probe.py`** — deletes one guard at a time and requires
  something to fail. Fifteen guards; it found three unmaintained on its first
  run and one mutation that was only ever caught by the compiler. Not part of
  `pnpm verify` (it edits sources and runs the suite once per mutation), but
  the pr-gate skill requires it, so "run it after adding a mechanism" is an
  obligation rather than advice. A stale mutation pattern
  reports itself, so a guard that is rewritten cannot quietly stop being
  probed. (rung 3)
- **Write query plans can be pinned** — the suite could only `EXPLAIN` reads,
  which is how a full table scan shipped inside a correctness fix. Writes now
  go through a raw client, and the emit fan-out is pinned with its degraded
  shape kept alongside so the assertion is known to discriminate. (rung 2)
- **Review artifacts cannot be committed, and reviewers get their own tree** —
  see below; a process failure, but the fix is mechanical. (rung 2)

Process failures this round, and their mechanisms:

- **An adversarial reviewer ran against the live working tree.** It wrote
  probe files, mutated sources, created a `.bak`, and stashed my uncommitted
  work under a name of its own. Twice its scratch was swept into a commit by
  `git add -A`, and once its mutation of `store.ts` nearly shipped. Every
  minute spent untangling that was a minute not spent reviewing. Mechanisms:
  the scratch names are in `.gitignore` AND in the formatter's ignore list
  (a probe file otherwise turns the whole gate red while a review runs), and
  the reviewer now runs in a `git worktree` — a separate checkout it cannot
  reach out of.
- **The multi-process chaos tests used fixed ports.** A run that fails partway
  strands its children, and the next run dies on "address in use" — which
  surfaces as the host exiting early, indistinguishable from the engine bug
  those tests exist to catch. It cost a real detour: two tests failed, looked
  exactly like a regression from the commit in hand, and were a leftover
  process. The ports now derive from the process id.

Deferred (recorded in BUILD.md):

- **The fence proves a batch stamped a row; it does not prove a follow-on's
  target SET derives from stamped rows.** `rows: 'one'` bounds the
  single-target case; emit's fan-outs are necessarily many-row and have no
  bound. The rung-1 answer is a typed target-expression API where the
  primitive generates the join, which fights pluggability because join shapes
  differ per dialect. Class B moves from *writable by default* to *writable
  only by disconnecting a fence you were forced to type*. Reading this as
  "class B is now impossible" is reading it wrong.
- **Postgres double-claim** — `casMany` guarantees a win rule, not a
  concurrency semantics; store-pg needs `FOR UPDATE SKIP LOCKED` and a
  conformance scenario before it is done.
- **Rule 2's Postgres/MySQL lock prelude** — the primitive has no statement
  kind for acquiring a lock, and every non-tail statement must carry a fence.
  Needed only when store-pg lands.
- **MySQL cannot derive the winner from row counts alone** — no targeted
  `ON CONFLICT`; the normalization contract must state matched-not-changed
  semantics.
- **The scheme is exactly as strong as `IdSource.token()` uniqueness**, and
  the harness deliberately hands out colliding ids. A simulation assertion
  that a seed is never issued twice is still missing.
- **The rolling-deploy deferral disarms the start deadline** — pre-existing,
  identical on main, and modelled nowhere in `specs/Scheduler.tla`. The
  spec-first rule applies: model it before fixing it.

## What this round still would not catch

Written from the mechanism audit, then REVISED after the audit was acted on:
four of the false negatives recorded above were closed, and the class that
produced them was removed rather than patched.

Closed since the audit:

- The fence-does-not-gate-the-write class. Twenty-two of the twenty-three
  statements that can over-write rows no longer contain a caller-authored
  WHERE at all — the primitive generates the selection from the fence and the
  caller's `narrow` is ANDed, so it can only shrink the set. `OR`, `NOT (…)`
  and a WHERE-in-a-comment are not "now rejected"; they have nowhere to appear.
- A follow-on reading the clock. Banned for the token AND the spliced
  expression, and the `one-batch-two-instants` invariant now checks it in the
  DATA, where a raw read no construction check could see still shows up.

Still true:

- **emitEvent's `wake-runs` is not generated**, because it selects from
  `waits` — rows the batch never stamped — and uses the event fence as a gate.
  It keeps the hand-written WHERE and the scanning that guards it. It is now
  genuinely the only one: the cleanup beside it used to select waits by event
  name and is generated from the runs the emit woke. What guards it is no
  longer scanning but a generated surface — every corruption of a wait row in
  ones and pairs, crossed with every shape of park, against a row-at-a-time
  statement of what a legitimate registration is — and eight of the
  predicate's nine conditions fail it when deleted. The ninth is a pure access
  path and fails the query-plan pin instead.
- **A wait row still cannot prove it is CURRENT.** Everything above makes
  misuse hard; none of it makes it impossible, because the predicate infers
  currency from five fields agreeing. The structural answer is an explicit
  active-wait identity, and it is deferred to PR3.8 with reasons rather than
  silence: it is a migration plus a new field in six transitions, the
  spec-first rule says a protocol change is TLC-verified before its SQL
  exists, and this branch has already produced eight fix-induced defects.
- **A fan-out has no upper bound.** `{ many: reason }` costs a sentence.
  The generated selection makes the bound derivable, so this is now a missing
  runtime assertion rather than a design gap.
- **The automated machinery still enumerates states and faults, not SQL
  shape.** The new oracles are the exceptions, and they cover one class each.
  The detection ledger is the measurement: 11% was the baseline, round 6 came
  in at 50% of six, and the overall figure is now 16%. Six findings is a small
  sample and the honest claim is narrow — the detector that produced the
  movement now exists, and it is not "review more carefully". It is: mutate
  every mechanism the day it is written, because both of round 6's catches
  were mechanisms that had a hole from birth.
- **Nothing checks a mechanism's own mutations for arity.** The audit found
  one mutation that could only ever be caught by the compiler, so it certified
  a guard it never reached. It was found by accident. A probe that ran each
  mutation and asserted the FAILING TEST NAMES differ from the compile-error
  ones would close this; it is not written.

The honest summary of the round is that the mechanism audit was worth more
than any individual fix in it. It is the section that turned "we added
mechanisms" into "four of them have a demonstrated false negative, here is
the code" — and everything above under "closed" happened because of that,
not because of another review.
