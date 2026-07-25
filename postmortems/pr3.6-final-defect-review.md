# Postmortem: final write-provenance branch review (PR3.6)

The final adversarial review of the write-provenance branch reported ten
findings. Nine reproduced: three engine failures and six failures in the
tests, checkers, and review controls that were meant to keep the engine
honest. One report, the CodeRabbit check-name limit, had already been repaired
on this worktree's base and was disconfirmed before any new change. The
verdict on the reviewed snapshot was correct: it was not safe to merge.

This document is adversarial toward the machinery and blameless toward
people. The subject is what would have made each defect unwritable or caught
it automatically.

## Severity

The worst escapes stranded tasks while reporting success. A successor ID
collision with an older attempt could commit the current run's failure,
suppress both its successor and terminal bookkeeping, and leave a running
task with no live run. A legacy timed wait could be claimed and consumed
while its timeout wake was discarded during decoding, so the SDK re-armed
the same timeout forever. A delayed exact replay of `emitEvent` could reuse
one provenance seed at two database instants and delete a registration that
the replay did not wake.

The verification escapes made those engine failures more likely to ship.
The clock-jitter test compared no state, the generated wake surface omitted
both positive timeout and task-liveness axes, and a routine fixture reused
provenance seeds in a way the named invariant could not observe. The
review-bot checker accepted a missing or inactive corpus, while the base gate
could run zero base-owned checks and still pass. Finally, the hosted-review
documentation asserted a base-branch trust boundary that neither service
provides, leaving a pull request able to weaken the rules that review it.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 3 | Successor ownership used only run ID, task ID, and “not parent,” so an older attempt of the same task looked like the intended successor | Failure and claim-timeout sweep could commit a half-transition and permanently strand a task | Existing self-collision and foreign-task collision regressions; the live-run invariant | The ownership predicate omitted the one immutable discriminator that separates attempts, and the generated scenarios did not include a same-task historical collision | One `successorOwned` predicate requiring ID, task, and intended attempt, backed by the unique task-attempt key and attacked by a mutation that removes the attempt arm (rung 1) |
| 2 | Claiming a pre-v3 timed wait deleted its registration and then discarded the carried wake because `wake_step` was null | A real `EventTimeoutError` could be postponed forever by repeated re-registration | The migration-derived legacy-row surface and claimed-run decoder | The surface emitted into legacy rows but never claimed an expired one; the decoder assumed every delivered event already had a step despite the migration history | A shared registration witness recovers the step before claim or emit consumes the wait, and the legacy surface varies every post-v1 nullable column through claim and decode (rungs 1 and 2) |
| 1 | Delayed exact replay of `emitEvent` re-stamped an event while later statements borrowed the old wake-run stamp | One execution could write a task or delete a restored wait despite waking no run, leaving one seed at two instants | `FencedBatch`, `assertWritesStamp`, delayed-replay conformance, and `one-batch-two-instants` | Generated fenced-table updates could omit stamping, `wake-tasks` hand-wrote provenance, and no emit case replayed a compiled batch after time and state moved | Generated updates must stamp by type; dependent fences are sealed after their last consumer; wake-task provenance is generated; and the dialect-neutral `PRESERVED_FENCE_INSTANTS` enumeration permits only an events conflict restamp that copies immutable `emitted_at_ms`, including after an interposed fresh token. Delayed replay and construction rejections attack each property (rungs 1 and 2) |
| 6 | The clock-jitter “differential” returned only invariant violations and compared two empty arrays | A second database-clock read could strand retries at an unrelated epoch while the advertised defense stayed green | The per-statement jitter executor | Its oracle observed only invariant violations, not scenario progress, operation results, timestamps, or stored state | Every jittered scenario now compares its complete progress trace and every protocol table with a control execution; a later-clock retry mutation is invariant-clean but differential-red (rung 2) |
| 7 | Every generated healthy wait was untimed and every owning task was running | Removing timeout equality or the live-task guard left all 1,728 cases green | The generated wake-witness surface | It crossed corrupt wait fields but held two load-bearing positive dimensions constant | The surface is the Cartesian product of timed/untimed waits, live/terminal tasks, every park shape, and every one- and two-field corruption; dedicated mutations remove each arm (rung 2) |
| 10 | `review-bot-lint.py` returned success when the corpus was absent and counted textual IDs and paths instead of active error rules | Custom review could disappear, become warning-only, or be countermanded by another path instruction while its gate remained green | `review-bot-lint.py` and `lint-selftest.py` | An early return skipped both configs, the accepted fixture contained no active CodeRabbit checks or related Greptile bodies, and path instructions were not parsed | Fail-closed corpus discovery; one canonical marked synopsis per rule; exactly one matching error-mode CodeRabbit check and Greptile rule; and exactly one corpus-owned global CodeRabbit path instruction, attacked by eleven negative fixtures (rung 2) |
| 5 | `base-gate` accepted zero executed base checks, while textual path occurrences satisfied its inventories | A weakened head checker could self-grade because no base-owned code had actually graded the branch | `gate-lint.py`, its self-test, and the `base-gate` workflow | Regex inventory treated `echo` and post-`exit` text as execution; the base loop skipped unavailable or root-insensitive checks and treated `ran = 0` as success | A restricted command parser inventories reachable command positions, the workflow exposes one exact runner, and `--run-base` materializes the head under the base's complete checker corpus and requires a nonzero execution count (rung 2) |
| 8 | A migrated fixture's token source returned one seed forever, and `one-batch-two-instants` did not detect same-instant or overwritten reuse | A no-work claim could borrow an earlier claim's fence and mutate unrelated bookkeeping | The shared test fixture and provenance invariant | The fixture centralized setup but not issuance; the invariant observes surviving cross-instant evidence, not the act of issuing a seed | One monotonic, independently counted ID/token source returned once by `openTestDb` and shared by the converted routine fixture stores; comments now state the invariant's narrower property and a mutation freezes issuance (rung 1 within one source instance) |
| 9 | Review documentation claimed CodeRabbit and Greptile used base/default-branch configuration | A source branch could remove the instruction that claimed its edits were ignored, while reviewers trusted a boundary that did not exist | Review-bot documentation and repository administration | Both hosted services choose configuration from the pull request source branch; repository prose has no authority over that choice | The checker prevents this known false provenance claim from recurring in repository text (rung 2); externally managed, required configuration is recorded as the structural prevention in `BUILD.md` (deferred rung 1) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| External final-branch review | 9 | no |
| Existing tests, invariants, fuzz surfaces, and checkers before that review | 0 | yes |

Self-catch rate: **0%**. The preceding PR3.6 postmortem recorded **16%**
overall and **50%** in its six-finding final sub-round. This round therefore
regressed on both comparisons: every applicable finding arrived from outside
the standing machinery.

The red tests written after the report are evidence that the findings
reproduce; they are not credited as finders. Crediting repair-time tests would
turn every externally found defect into a self-catch and make the ledger
meaningless.

## Recurrence

“A stamp is not authorship” recurred in findings 1 and 8 after the branch
introduced per-statement provenance and `one-batch-two-instants`. The
primitive made a fresh stamp available, but still allowed one generated
update to decline it; the invariant checked surviving rows at different
instants, not issuance uniqueness. Both were proxies for “this execution
alone authorized this write.” Finding 1 closes the production escape by
making an unstamped generated update unrepresentable. Finding 8 moves routine
test issuance to one source and narrows the invariant's documented claim.

An incomplete generated surface recurred in findings 6 and 7 after the prior
round had specifically added clock jitter and wake-witness generation. The
clock surface varied the executor but compared only a lossy summary. The wake
surface varied corrupt rows but not the healthy positive axes. In both cases,
generation created volume without creating discrimination. The new mutation
tests ask the mechanism itself to reject one invariant-clean wrong
implementation per missing dimension.

Checker false negatives recurred in findings 5 and 10 after
`lint-selftest.py` was introduced to end that class. The inventory proved that
checker processes returned success or failure for fixtures; it did not prove
that a workflow executed a checker, or that a configuration reference was an
active rule. The correction raises both inventories from text occurrence to
reachable command or active configuration structure, while retaining
explicit residuals because both parsers are still syntactic.

Finding 3 is the third collision shape after self-collision and foreign-task
collision. Those tests enumerated examples instead of deriving successor
identity from the schema's immutable task-attempt key. Finding 2 is the same
positive-axis failure in migration form: legacy rows were generated, but the
only behavior driven through them was emit, not timed claim and decode.

Finding 9 is not another parsing bug. It is a trust-boundary error:
repository-owned instructions described an external enforcement boundary that
the repository cannot create. Correct prose prevents the false assurance;
only service- or organization-owned configuration can prevent source-branch
edits.

## Mechanism audit — the false negative of each

The probes in this table were written and run. Temporary probes were removed
after their results were recorded. “No passing counterexample” is used only
where the exact property is rung 1; the rejected mutation or construction is
shown instead, followed by the adjacent property that remains outside it.

| Mechanism | Rung | Executed false negative, or rejection at an exact rung-1 boundary |
|-----------|------|-------------------------------------------------------------------|
| `successorOwned(id, task, attempt)` plus unique `(task_id, attempt)` | 1 for historical-attempt identity | Replacing `s.attempt = ${attempt}` with the arity-preserving tautology `${attempt} IS NOT NULL` made both historical-collision cases fail with “promise resolved 'undefined' instead of rejecting” and “promise resolved '[]' instead of rejecting.” No passing counterexample exists inside the stated identity property: the schema also rejects two runs of one task at the intended attempt. A caller supplying the wrong intended attempt remains outside the primitive. |
| `registeredWaitStep(run)` before wait consumption, plus the legacy nullable-column surface | 1 for a surviving registration; 2 overall | The temporary case `UPDATE runs SET wake_step = NULL; DELETE FROM waits; advance 30000; claim` passed with `wake === undefined` (`1 passed, 28 skipped`). Once both durable witnesses are already gone, no decoder can recover the historical step. The repaired claim path prevents itself from creating that shape; it cannot repair a database that arrived in it. |
| Mandatory stamps on generated `derived` updates | 1 inside the typed generator | Removing generated provenance makes the mutation suite red, and a caller can no longer construct a generated update without the required stamp policy. The executable bypass `f.raw.batch('raw-bypass', [{ sql: "UPDATE tasks SET state = 'cancelled' ..." }])` still reported `{"rowsAffected":1,"state":"cancelled","fenceStamp":null,"fenceAtMs":null}`. Direct `SqlExecutor` SQL does not cross this type boundary; the store's batch checker is the syntactic control for that adjacent path. |
| Raw `followOn()` reach screens and their paired attack | 2, syntactic | The new deletion mutation originally survived, then the paired test made it fail when a top-level OR bypassed the fence while still accepting an OR nested inside a fenced conjunct. The temporary counterexample `WHERE CASE WHEN run_id = ? THEN 1 ELSE fence_stamp = $FENCE:win$ END` still compiled (`1 passed, 47 skipped`): the equality is present and positive but does not dominate the write. Generated `derived()` selection, not this scanner, is the structural closure. |
| `seal()` after the last fence consumer | 2 | A temporary `IdSource` returning `same-token` compiled two same-millisecond emits byte-for-byte identically. After restoring the wait between them, the second event CAS wrote zero while its four follow-ons each wrote one: `{"secondRowsAffected":[0,1,1,1,1],"runStamp":"same-token:wake-finished","runAtMs":1000000,"waitsAfter":0,"invariantViolations":[]}`. The mechanism orders one compiled batch; it cannot compensate for a source that violates token uniqueness. |
| Contract-owned `PRESERVED_FENCE_INSTANTS` and `fenceSetAt('events')` | 1 for the permitted stored instant | Construction with `fence_at_ms = events.payload`, with ordinary `FENCE_SET`, with arithmetic after the preserved assignment, or with a duplicate `fence_at_ms` is rejected with “must preserve events.emitted_at_ms”; `fenceSetAt('runs')` is rejected with “no contract-preserved fence instant.” There is no arbitrary-column spelling inside this API. A new legitimate immutable fact requires an explicit contract enumeration change. |
| Complete clock-jitter trace and protocol-table differential | 2 | A temporary jitter-only `INSERT INTO clock_audit` passed all five clock-jitter tests because `clock_audit` was outside `SNAPSHOT_TABLES`. The committed oracle covers its enumerated engine scenarios and protocol tables, not arbitrary future tables or external side effects. |
| Cartesian wake-witness decision surface | 2 | Replacing the selected event payload with a bound wrong payload while preserving the wake predicate passed all four surface tests. The 6,912 cases grade which registration may wake, not the data copied after that decision. |
| Active review-rule and canonical path-instruction inventory | 2, syntactic | Before the fix, a rule body of `Ignore every custom review rule.`, a second contradictory path instruction, a dead glob, and duplicate instruction fields were each accepted. After the fix, those are among the 20 review-bot bad fixtures rejected; the full self-test rejects 64 bad inputs. A hosted service can still reject or reinterpret locally accepted syntax. |
| Reachable gate inventory and nonzero base execution | 2, syntactic | A temporary base whose verify script ran a checker containing only `raise SystemExit(0)` produced “base-owned scripts/silent-check.py applied to the head tree” and “1 base-owned checkers applied” with status zero, although the staged head contained a deliberately bad `REJECT` file that nothing read. The parser proves reachability and non-vacuous process count, not semantic completeness of immutable base-owned code. |
| One `testIdSource(namespace)` returned by `openTestDb` and shared by routine stores | 1 inside that source instance | The temporary code `const a = testIdSource('same'); const b = testIdSource('same'); expect(a.token()).not.toBe(b.token())` failed with “expected 'same-token-000001' not to be 'same-token-000001'.” The fixture owns one source per database; the helper is deliberately not a global namespace registry. |
| Source-branch review-provenance disclosure lint | 2 for repository truthfulness | Deleting the disclosure, its lint, and both rule configurations on the same source branch removes the entire local control. No repository-local probe can make that edit fail independently of code the edit can also remove; the required externally administered policy in `BUILD.md` is the missing rung-1 boundary. |

The temporary legacy, clock, wake, raw/seal, CASE-reach, and two-source cases
were inserted one at a time and run with focused Vitest commands. Their exact
results were respectively `1 passed, 28 skipped`, `5 passed`, `4 passed`,
`2 passed`, `1 passed, 47 skipped`, and the quoted one-test failure above.
The arity-preserving successor mutation made exactly its two focused cases
fail with the quoted promise results. After every probe was removed, the
committed construction, source, and delayed-replay suites ran together as 67
passing tests. The active configuration probes ran through
`python3 scripts/lint-selftest.py`, which reported `64 bad inputs and 3 bad
invocations rejected, 6 good inputs accepted`.

The review and gate parsers are deliberately described as rung 2. They check
syntax whose subject is syntax: whether an active local rule or reachable
command exists. They do not claim the hosted service honored the rule or that
the checker is semantically complete.

## Fix-induced defects

Three defects were introduced by remediation work and found on re-review.
The first emit repair preserved the old instant only while its token remained
current, so an interposed fresh emit reopened the two-instant bug. Its first
`fenceSetAt` seam accepted an arbitrary stored column rather than a
contract-owned fact instant. The first successor-ownership mutation changed
bind arity, so argument validation killed the mutation before the ownership
predicate ran and falsely made the test look discriminating.

These repairs were re-reviewed as new code, not merely re-tested. The
interposed-emit counterexample was moved into finding 1's red surface; the
preserved-instant seam was replaced with the typed, dialect-neutral
enumeration and exact assignment-count rejections; and the successor mutation
was made arity-preserving before it was rerun. Documentation drift found in
that same branch-diff audit was corrected, but it is not counted as a fourth
fix-induced defect.

The same audit found a pre-existing mechanism overclaim rather than a defect
introduced by these repairs: `hasTopLevelOr` had neither the rejection test nor
the mutation its review rule said maintained it. Red commit `ca2ae3b` made the
new deletion mutation report “top-level-or-reach: SURVIVED — nothing failed.”
Green commit `1cf8259` added the paired top-level rejection and nested
alternation acceptance; the same mutation was then caught. This is recorded
separately from both the original nine-finding ledger and the three
fix-induced defects.

## Evidence

- Finding 3: red `a97c94a` failed with “promise resolved 'undefined' instead
  of rejecting” and “promise resolved '[]' instead of rejecting”; green
  `3416209`.
- Finding 2: red `13a9758` failed with “expected undefined to deeply equal
  { event: 'go', step: '$await:go#2', timedOut: true }”; green `25af9bc`.
- Finding 1: red `345049d` failed with “one-batch-two-instants: tok-5 saw
  1000000 and 1100000”; its interposed-token case failed with
  “one-batch-two-instants: tok-5 saw 1000000 and 1200000”; the
  restored-registration and generated-provenance regressions failed with
  “expected +0 to be 1” and “expected null to be 'seed:spread'.” Green:
  `5896a9e`.
- Finding 6: red `735cd1d` failed with “expected [] to not deeply equal []”
  after an invariant-clean later clock read; green `ae81bd5`.
- Finding 7: red `ccb851b` produced that same expected-not-equal failure for
  both the timeout-equality and live-task mutations; green `c604300`.
- Finding 10: red `da962d9` produced eleven
  “review-bot-lint.py ACCEPTED a bad input” failures; green `c5b26f9`.
- Finding 5: red `09466fb` produced three
  “gate-lint.py ACCEPTED a bad input” and three “ACCEPTED a bad invocation”
  failures; green `b3dbb3e`. Against the actual `origin/pr3.1`, the green
  runner executed all six available base-owned checkers and skipped zero.
- Finding 8: red `8f564b5` failed with “expected 'id-same-seed' to be
  'world-moved'” after a no-work claim borrowed old evidence; green
  `939b4f6`.
- Finding 9: red `c490536` produced two
  “review-bot-lint.py ACCEPTED a bad input” failures for false base-branch
  provenance claims; green `37f7cb9`.
- The remediation audit's additional mechanism gap: red `ca2ae3b` survived
  with “top-level-or-reach: SURVIVED — nothing failed”; green `1cf8259`
  made the mutation report “every mutation was caught.”
- The finding artifact's verdict was: “I do not think the branch is correct. I
  found three engine defects and several verification defects.”
- Finding 4 did not reproduce on the reviewed worktree. Base commit `4196b6e`
  derives every custom-check name from its rule filename,
  `review-bot-lint.py` rejects names of 50 characters or more, the longest
  configured name is 42 characters, and both the checker and its self-test
  pass. No compensating change was made.
- Focused regression suites, both package typechecks, all checker self-tests,
  and the six-check actual-base exercise were green after their respective
  fixes. The final exact `pnpm verify` made lint, all ten checkers, formatting,
  and typecheck green; its test leg passed 621 tests and failed only the 11
  cases in four files that this sandbox forbids from spawning Python, binding
  localhost, or starting child hosts (`EPERM`). Excluding exactly those four
  environment-dependent files made all 621 runnable tests green. The exact
  `pnpm verify:fuzz` wrapper could not connect to the sandbox's systemd bus;
  its underlying `FUZZ_SEEDS=2000 FUZZ_STEPS=100` conformance run, excluding
  only the same forbidden label-inventory spawn, passed all 417 tests.

## Root cause

The common failure was measuring a convenient representation one level below
the property being claimed. A provenance invariant measured surviving stamps,
not token issuance or authorization. A differential measured violation
strings, not executions. A generated matrix counted combinations without
varying the positive facts that distinguish its predicates. Two checkers
found filenames and path text, not active rules or executed commands.
Documentation described desired configuration ownership, not actual service
ownership.

That pattern explains why the branch could accumulate sophisticated machinery
and still self-catch none of these findings. The machinery was not absent; its
oracle discarded precisely the dimension on which the defect differed. The
repair principle for this round is therefore not “add more cases.” It is to
bind identity to immutable schema facts, compare complete observable state,
derive positive axes and active inventories from their sources, and state
external trust boundaries without pretending repository text can enforce
them.

## Mechanisms

Built in this PR:

- Immutable successor identity from task plus intended attempt, centralized
  in `successorOwned`, with failure and timeout-sweep mutation coverage
  (rung 1).
- One full wait-registration witness shared by claim and emit, used to recover
  a legacy step before the witness is consumed (rung 1), plus a migration-axis
  claim/decode surface (rung 2).
- A typed `derived` update that cannot omit its stamp, generated wake-task
  provenance, and explicit fence consumption with `seal` (rung 1 inside a
  constructed `FencedBatch`), attacked by delayed compiled replay (rung 2).
- A deletion mutation and paired reject/nearest-accept case maintain the
  common top-level-OR reach guard; its CASE-expression false negative is
  documented rather than presented as semantic dominance (rung 2).
- A dialect-neutral `PRESERVED_FENCE_INSTANTS` contract whose only member maps
  events to immutable `emitted_at_ms`, exposed through typed
  `fenceSetAt('events')` with exact assignment validation (rung 1), attacked
  by replay after an interposed fresh emit (rung 2).
- Complete clock-jitter trace and database comparison, with an
  invariant-clean mutation as the non-vacuity control (rung 2).
- A wake-decision Cartesian surface over timeout, task liveness, park, and
  corrupt-registration axes, with one mutation per new axis (rung 2).
- Fail-closed active review-rule reconciliation, canonical corpus-derived
  rule bodies, exactly one canonical global path instruction, and reachable
  base-check execution inventories, each exercised in both directions by
  `lint-selftest.py` (rung 2).
- A monotonic ID/token source returned once by `openTestDb` and shared by every
  converted routine fixture store, plus honest documentation of the narrower
  cross-instant provenance invariant (rung 1 within one source instance).
- Source-branch provenance assertions in the lint and all hosted-review
  documentation, preventing the known false ownership claim from recurring in
  repository text (rung 2).

Deferred (recorded in BUILD.md):

- Move CodeRabbit and Greptile rules to organization- or service-managed
  configuration that a pull request source branch cannot edit, and require
  that external policy. This needs repository-administrator authority and
  cannot be implemented or verified by a commit on the branch it is meant to
  constrain.

## What this round still would not catch

A production `IdSource` that repeats a token twice at one instant can still
ship: routine tests now make that mistake difficult, but the protocol has no
durable issuance ledger and the surviving-row invariant cannot prove
uniqueness. The clock differential can miss writes to an unlisted future table
and external side effects outside its captured trace. The wake surface can
miss a corrupted payload whose wake decision remains correct. Both Python
configuration checkers can miss semantics their restricted parsers do not
model, and neither can prove a hosted service executed anything. Raw
`followOn()` SQL can make a textual positive fence conditional through a CASE
expression even though the generated `derived()` path cannot. Finally, until
the BUILD follow-up is administered, a pull request can remove every
hosted-review disclosure and rule that this round added.

Those are bounded residuals, not claims of completeness. They identify where
the next adversarial review should start.
