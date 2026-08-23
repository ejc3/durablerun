# Postmortem: final write-provenance branch review (PR3.6)

The final review sequence produced sixty-eight reports. The first adversarial
review reported ten: nine reproduced and one was disconfirmed. CodeRabbit then
reported fifty-one: thirty-five were new accepted findings, nine described
defects round-7 work had already repaired, and seven were rejected as wrong or
not worth changing. A continuation review found that a sealed fence remained
consumable by later builder statements. The initial review of the shared
lexical/root repair reported four distinct defects, and a late review of its
green implementation found two more.

This table therefore has fifty-one rows: the original nine, thirty-five new
CodeRabbit findings, the seal-lifecycle finding, four findings from the first
lexical/root review, and two from the late lexer review. The nine already
covered CodeRabbit reports are evidence about generalisation, not new rows;
the seven rejected reports and the original disconfirmed report are also not
rows. The verdict on each reviewed snapshot was correct: the branch was not
safe to merge.

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

The follow-up engine failures were narrower but still capable of losing work.
`seal()` rewrote a source fence but left it available to a later statement, so
the builder could authorize a dependent write from evidence the batch had
already declared dead. Legacy step recovery chose one of several matching
registrations, so claim or emit could wake the wrong step; immutable
active-wait identity remains PR3.8's structural closure.

The verification escapes made those failures more likely to ship. Portable
invariants used dialect-specific string SQL, migration enrollment parsed one
DDL spelling, assertions accepted throws or null pairs, and FencedBatch audits
trusted comments and short result arrays. Checker surfaces confused filenames,
any nonzero exit, opaque source text, or an existing directory with the
property they claimed. Documentation and attestation then drifted from their
own tables and deferred mechanisms.

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
| 11 | CodeRabbit 1: the red-test policy allowed a combined repair and regression commit when its message quoted a failure | A repair could satisfy review without ever observing the regression against broken code | Canonical review-rule reconciliation | The source rule and both generated bodies agreed on the wrong exception | A rule-specific semantic check and one strict synopsis copied to both hosted reviewers (rung 2) |
| 12 | CodeRabbit 5: `derived()` accepts a source `task_id` paired with a target `run_id` key | A follow-on silently selects nothing and omits required bookkeeping | The typed FencedBatch generator boundary | Related identifiers remain independently spellable strings | PR3.7 owns contract-derived key pairs or construction rejection, naming this exact residual (deferred rung 1) |
| 13 | CodeRabbit 6: a mutation can be reported caught solely because it changes bind arity and fails compilation | Probe output can claim a guard is maintained without exercising it | Mutation-probe verdict classification | Any nonzero suite result is accepted as the intended behavioral catch | PR3.7 owns per-entry behavioral or construction verdict attribution (deferred rung 2) |
| 14 | CodeRabbit 7: invariant comments headed the wrong checks | Maintainers received false executable-twin and Rule-8 ownership information | Invariant-library source | An insertion moved checks without moving their prose | Comments now sit beside the exact evaluator branch in the common evidence representation (rung 1 for representation) |
| 15 | CodeRabbit 8: dialect-neutral invariants used `instr`, integer concatenation, and dialect string semantics | PostgreSQL or MySQL conformance could crash instead of report a violation | Shared invariant library | Evidence parsing was encoded in SQLite-flavored SQL | One portable raw evidence projection evaluated in TypeScript (rung 1) |
| 16 | CodeRabbit 9: new accounting, pair, malformed-stamp, and two-instant branches lacked corrupt-state cases | Invariant branches could disappear or misparse opaque seeds while the suite stayed green | Invariant rejection surface | Only normal-state callers exercised the new checks | A raw-SQL branch matrix covers accounting bounds, half pairs, malformed tails, opaque-colon seeds, and distinct instants (rung 2) |
| 17 | CodeRabbit 10: an await-event regression swallowed every error and accepted untouched running state | Arbitrary validation or SQL failure looked like a correct park or fence refusal | Conformance oracle | Rejection type and post-state were unobserved | A typed refusal with exact unchanged state, or the exact owned deadline on success (rung 2) |
| 18 | CodeRabbit 11: legacy-column enrollment parsed one `ALTER TABLE` spelling and silently dropped others | A new nullable migration column could ship with no legacy behavior case | Migration-derived legacy surface | A syntax regex stood in for the applied schema change | Apply each shipped migration and diff the actual schema against its predecessor (rung 1) |
| 19 | CodeRabbit 12: a missing parked wait defaulted its timeout to null, turning a timed replay into an untimed case | The deadline disagreement could disappear while the regression stayed green | Replay oracle | A fallback and cast erased the case's precondition | Require the row and its numeric parked deadline before constructing the disagreement (rung 2) |
| 20 | CodeRabbit 13: dead `generated` state claimed an exemption no code used | A future edit could target a phantom second validation path | FencedBatch representation | A flag and comment survived the generator refactor without behavior | Delete the second representation so generated and hand-written statements use one validation path (rung 1) |
| 21 | CodeRabbit 14: a comment containing `WHERE` truncated SQL before the blind-counter check | A non-idempotent counter bump could bypass construction rejection | FencedBatch construction scanner | Some checks used comment-blanked SQL while one used raw SQL | Blank comments once and feed every construction check the same statement view (rung 1 representation, rung 2 enforcement) |
| 22 | CodeRabbit 15: a short executor result array skipped post-commit audits and reported a lost CAS | A committed transition could return `won: null` with no bounds or exclusivity audit | FencedBatch executor contract | Missing results were ignored one item at a time | Require exact result-to-statement cardinality before mapping any outcome (rung 1 contract) |
| 23 | CodeRabbit 16: username rejection examples omitted whole JavaScript runtime kinds | Boolean, bigint, or function inputs could regress through the user boundary unnoticed | User-boundary class test | Representative values stood in for the runtime type partition | A deterministic every-non-string-kind matrix plus the nearby string acceptance case (rung 2) |
| 24 | CodeRabbit 18: equivalent JSON payload strings crossed the store boundary in different wire forms | Replay and idempotency could observe formatting rather than value | Shared user JSON boundary | Validation returned the caller's original bytes | Parse then serialize once at the shared source (rung 1) |
| 25 | CodeRabbit 20: obsolete pre-fence SQL locals remained as unread second representations | Maintainers could edit dead SQL while believing it was shipped behavior | Typecheck and single-representation rule | Workspace unused-local checking was disabled | Enable `noUnusedLocals` and delete every stale spelling (rungs 1 and 2) |
| 26 | CodeRabbit 22: a generated-selection test asserted two timestamps only agreed, allowing both to be null | Loss of both provenance instants stayed green | Provenance oracle | Agreement was used as a proxy for the pinned instant | Assert that both values equal fake NOW (rung 2) |
| 27 | CodeRabbit 23: query-plan tests hand-built a migration schema different from production | Plans could be pinned against a database production never creates | Query-plan fixture | Raw meta DDL and a migration loop duplicated the shipped admin | Adapt the raw client to `SqlExecutor` and invoke `LibsqlStoreAdmin.migrate()` (rung 1) |
| 28 | CodeRabbit 24: the schema-gate test accepted any non-outage error and covered one classifier spelling | Permanent schema faults could lose typed classification unnoticed | Port error contract | Message inequality was the oracle | Assert `SchemaMismatchError` across every classifier branch, with closed-client outage as the control (rung 2) |
| 29 | CodeRabbit 27: the earlier postmortem's checker and gate count disagreed with its table | Detection-rate and recurrence claims were based on contradictory totals | Postmortem attestation | Prose counts and table rows were independently maintained | One canonical table parser derives the finding total and ledger sum, and the prose now names the rows (rung 2) |
| 30 | CodeRabbit 29: the earlier postmortem still deferred a provenance audit that had landed | Work could be repeated or the actual remaining boundary ignored | Deferred-work ledger | Mechanism status had two owners that drifted | Remove the stale deferral and leave only live BUILD-owned residuals (rung 1 for representation) |
| 31 | CodeRabbit 30: batch delimiter counting treated brackets inside strings as source structure | Ordinary SQL could hide a second statement or clock read from the checker | Batch source checker | Character counting had no lexical model | One shared stateful source lexer separates executable delimiters from quoted and commented spans (rung 2) |
| 32 | CodeRabbit 31: clock comment stripping lost block state and confused comments, strings, and multiplication lines | Real clocks could pass while commented clocks failed | Clock source checker | Per-line regexes approximated lexical context | The shared stateful lexer drives both positive and negative clock cases (rung 2) |
| 33 | CodeRabbit 32: every nested file named `time.ts` was exempt | A raw clock in generated or nested source could bypass the gate | Clock checker scope | Basename stood in for the sanctioned contract path | Exempt only each package's exact top-level source time file (rung 2) |
| 34 | CodeRabbit 33: deferral lint did not recognize TODO or requiring-closure forms | Unfinished work could remain under a DONE heading and disappear from planning | Deferred-work checker | Its vocabulary covered only selected prose spellings | One unfinished-work classifier with rejection fixtures for every mandated form (rung 2) |
| 35 | CodeRabbit 36: self-test inventory used checker-looking filenames and gate lint counted any mention | A gate-wired checker present only in a good case had no proof it could reject | Gate and checker self-test inventories | Filename and text occurrence were proxies for executed gate members and refusal cases | Derive members from the executable verify graph and harvest only structured refusal tables (rung 2) |
| 36 | CodeRabbit 37: a checker crash counted as a valid refusal | A missing file or traceback could prove a rule that never ran | Checker self-test verdict | Only nonzero exit status was observed | Every case names its expected diagnostic and rejects tracebacks and wrong-path failures (rung 2) |
| 37 | CodeRabbit 39: session-state treated failed root, process, or Git evidence as an empty clean scan | An unfinished process or dirty tree could be reported absent because the script did not look | Session completion audit | Ground-truth commands were optional and their status was discarded | Capture and status-check every evidence source before trusting empty output (rung 2) |
| 38 | CodeRabbit 40: the TLA comment described active-wait identity as closed | Readers could infer a stronger model and implementation guarantee than exists | Specification and deferred-work ledger | Event and step correlation was confused with immutable registration identity | State the residual beside the predicate and retain PR3.8 ownership of `wait_id` and `active_wait_id` (deferred rung 1) |
| 39 | CodeRabbit 41: batch lint accepted a flag as its root and graded an empty tree | A base-gate invocation could silently inspect no packages | Checker root contract | Unlike sibling checkers, any first argument became a path | One validated root parser shared by source checkers, rejecting unknown and empty roots (rung 2) |
| 40 | CodeRabbit 42: review attestation skipped ledger reconciliation whenever its parser returned no rows | A prose-only or malformed ledger could attest with findings attributed to nobody | Postmortem attestation | Empty parse output was treated as absence rather than failure | One fail-closed canonical parser derives both totals from validated rows (rung 2) |
| 41 | CodeRabbit 46: legacy wait-step recovery selected one of several matching registrations | Claim or emit could wake the wrong step or a foreign task's wait | Shared wait-registration witness | Ordering and limiting hid cardinality, and ownership was checked by a second predicate | One full witness supplies ownership, unique step, and ambiguity refusal to both claim and emit (rung 1 within the legacy schema) |
| 42 | CodeRabbit 47: absent and inactive CodeRabbit fixtures were byte-identical | Either rule branch could be deleted while both claimed tests remained green | Review-bot rejection surface | Two knobs produced the same configuration and only exit status was checked | Structurally distinct absent and mode-off fixtures with exact diagnostics (rung 2) |
| 43 | CodeRabbit 48: one provenance mutation changed both the stamp assignment and source metadata | An unrelated construction failure could be credited to the stale-provenance guard | Mutation probe | One replacement attacked independent properties | Separate one-change mutations identify the maintained runtime and construction guards (rung 2) |
| 44 | CodeRabbit 49: the seal mutation short-circuited a call site instead of deleting the seal guard | The probe no longer demonstrated that intermediate-fence replay was prevented | Mutation probe | Refactoring moved the protected predicate but the mutation stayed at its old proxy | Mutate the sealed-source predicate and lifecycle transition directly (rung 2) |
| 45 | CodeRabbit 50: tracked-file inventory failure and empty output had no rejection fixtures | Scope validation could regress to a vacuous clean result unnoticed | Review-bot rejection surface | Only valid indexed repositories reached the checker in self-test | Separate unavailable, empty, and tracked Git states with exact verdicts (rung 2) |
| 46 | Continuation review: `seal()` rewrote a source fence but left later builder statements able to consume it | A dependent write could be authorized by evidence the batch had already declared dead | FencedBatch fence lifecycle | Sealing changed SQL but not the canonical availability state consulted by later statements | Each statement owns one fence state whose sealed transition makes every later source lookup reject (rung 1) |
| 47 | Lexical repair review: package/source harvesting accepted an empty inventory as clean | Batch and clock gates could pass while inspecting no production source | Shared root and source inventory | Root existence stood in for proof that the expected package and source population had been harvested | One canonical inventory rejects zero packages or source files before any source checker evaluates it (rung 2) |
| 48 | Lexical repair review: ordinary TypeScript strings and interpolated executable SQL templates were hidden from SQL scanning | A real batch statement or raw clock could disappear from the checker's executable view | Shared executable-string view | The scanner erased every quoted or template span even when that span supplied executable SQL | One position-preserving lexical pass records ordinary, template, and interpolation literal spans for SQL-aware consumers (rung 2) |
| 49 | Lexical repair review: regex literal contents were treated as delimiters and SQL-key structure | Valid TypeScript could be rejected for source structure that existed only inside a regex | Shared lexical scanner | Slash-delimited regex bodies had no lexical state distinct from executable code | The same lexical pass identifies regex literals in expression context and position-preservingly hides their contents from structural consumers (rung 2) |
| 50 | Lexical repair review: raw call harvesting scanned non-code, missed calls separated by trivia, and accepted an indirect batch list as empty work | Comments or strings could invent calls, formatting could hide real calls, and opaque statement lists could bypass the audit | Batch call and statement harvest | A raw-text regex stood in for executable call syntax, while an unparsed list silently became no statements | Harvest calls from executable structure across trivia and reject opaque statement lists except the one exact, reason-bearing migration generator (rung 2) |
| 51 | Late lexer review: a literal-label prefix was accepted when the first argument continued as a computed concatenation | A dynamic batch label could satisfy a checker that promised one complete static literal | Batch call-shape checker | The label regex stopped after a valid literal prefix instead of proving the whole first-argument expression | Delimit the complete first argument structurally and require its raw text to match exactly one declared literal form (rung 2) |
| 52 | Late lexer review: postfix `++` or `--` left the scanner in expression-start state, so following division looked like a regex and hid a call | Executable batch calls after a division expression could disappear from the audit | Lexical slash classification | Operator state did not distinguish postfix expression completion from prefix expression start | Derive slash context from token roles, including postfix increment and decrement, before harvesting calls (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| External final-branch review | 9 | no |
| CodeRabbit follow-up review | 35 | no |
| Continuation review of the seal lifecycle | 1 | no |
| Initial review of the lexical and root repair | 4 | no |
| Late review of the lexical green implementation | 2 | no |
| Existing tests, invariants, fuzz surfaces, and checkers before that review | 0 | yes |

Self-catch rate: **0 of 51, or 0%**. The preceding PR3.6 postmortem recorded
**16%** overall and **50%** in its six-finding final sub-round. This round
therefore regressed on both comparisons: every tabled finding arrived from
outside the standing machinery.

The red tests written after the report are evidence that the findings
reproduce; they are not credited as finders. Crediting repair-time tests would
turn every externally found defect into a self-catch and make the ledger
meaningless.

## Was the previous conclusion wrong?

Yes. The previous postmortem's factual observation that three of round 6's six
findings were self-caught was correct. Its inference that self-catch capability
was improving was not earned. It warned that six findings were not a trend and
then treated them as one anyway by crediting "mutate every mechanism the day
it is written." The expanded round is the disconfirming sample: zero of
fifty-one self-caught, including new mechanisms whose false negatives an
outside reviewer wrote immediately.

CodeRabbit's full denominator adds one useful qualification. Nine of its
fifty-one reports, **17.6%**, described defects that round-7 work had already
covered: reports 2, 3, 17, 19, 26, 35, 38, 43, and 45. Excluding the seven
rejected reports, that is nine of forty-four actionable reports, **20.5%**.
The rejected reports were 4, 21, 25, 28, 34, 44, and 51; none received a
compensating change.
This is real evidence that some mechanisms generalized beyond the exact case
that introduced them, especially the base-gate execution inventory, active
review-corpus checks, shared test identity, and authoritative wake witness.
It is not evidence of adequate coverage: thirty-five actionable reports were
still new, and several of the nine were documentation or already-corrected
instances rather than an independent semantic kill. The honest conclusion is
therefore "some generalization, dominated by misses," not either "none of the
mechanisms worked" or "the mechanisms now generalize."

This was not simply a right practice that nobody applied. The wake surface was
mutated on the day it was written and found one missing run-side axis. The
clock oracle was mutated and made `one-batch-two-instants` fire. Those attacks
happened. The failure is that an author-selected mutation proves only that the
selected mutation is killed. It does not prove that the oracle compares the
things its comment says it compares, that every positive axis varies, or that
the failure came from the intended property. The clock mutation flattered the
test by triggering the invariant it already returned; no differential
comparison existed. The wake mutations covered listed conjuncts while timeout
positivity and task state were absent from the generator. The same pattern
holds for textual gate inventory, same-instant seed reuse, and active hosted
rules.

The metric is not wrong for its stated headline question. It accurately says
how dependent this branch is on outside review, and its answer is worse now.
It was used to measure the wrong thing when it was offered as evidence that a
particular mechanism or mutation habit had semantic coverage. Detector
attribution among discovered defects cannot establish why a detector worked,
what axes it omitted, or whether it will generalize. The previous conclusion
was therefore too generous: a new detector existed, but improvement was not
demonstrated.

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

CodeRabbit 46 and the seal continuation are direct recurrences inside the
repairs for findings 2 and 1. Legacy recovery replaced a missing step with an
ordered guess instead of proving a unique full registration witness. Sealing
rewrote the compiled SQL but did not transition the source object's
availability, so a later builder call could still name dead evidence. Both are
the same proxy error at a structural boundary: a value looked narrowed in one
representation while another representation still admitted it.

The checker findings repeat that pattern at larger scale. CodeRabbit 36 and 37
showed that filenames and nonzero exits were proxies for executed checker
members and intended refusals. Findings 30 through 32 and 41 replaced several
lexical approximations with one scanner, but the first review of that repair
then found four distinct failures: empty source harvests passed, executable
strings disappeared, regex bodies became source structure, and raw call
harvesting both crossed non-code and accepted opaque lists. The late review of
the green mechanism found two more: a literal prefix disguised a computed
label, and postfix increment or decrement made following division look like a
regex. Sharing a proxy prevents drift; it does not turn the proxy into the
property. All six findings are repaired through one position-preserving
lexical pass and fail-closed harvest, but remain six rows because they were six
separately reported false negatives.

The test-only findings recur for the same reason. Equality without a pinned
value, a swallowed rejection, a null fallback, one representative runtime
kind, and one classifier message all counted the presence of an assertion
instead of proving the condition named by the test. Exact expected values,
types, states, and diagnostics replace those accept-any-failure shapes.

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
| `registeredWait(run)` before wait consumption, plus the legacy nullable-column surface | 1 for a surviving registration; 2 overall | The temporary case `UPDATE runs SET wake_step = NULL; DELETE FROM waits; advance 30000; claim` passed with `wake === undefined` (`1 passed, 28 skipped`). Once both durable witnesses are already gone, no decoder can recover the historical step. The repaired claim path prevents itself from creating that shape; it cannot repair a database that arrived in it. Direct mutations now delete the backfill assignment, let the unique-step scalar choose among several rows, and let claim consume a two-row ambiguity; each makes the focused legacy suite red. |
| Mandatory stamps on generated `derived` updates | 1 inside the typed generator | Removing generated provenance makes the mutation suite red, and a caller can no longer construct a generated update without the required stamp policy. The executable bypass `f.raw.batch('raw-bypass', [{ sql: "UPDATE tasks SET state = 'cancelled' ..." }])` still reported `{"rowsAffected":1,"state":"cancelled","fenceStamp":null,"fenceAtMs":null}`. Direct `SqlExecutor` SQL does not cross this type boundary; the store's batch checker is the syntactic control for that adjacent path. |
| Portable cardinality for generated provenance instants | 1 for scalar cardinality | Declaring a many-row source produced `SELECT f.fence_at_ms`, and the construction regression failed with “expected UPDATE tasks ... to contain 'SELECT MIN(f.fence_at_ms)'.” The generator now reduces the source rows—which one statement stamped at one instant—to one aggregate row, so SQLite, PostgreSQL, and MySQL receive the same scalar shape. Mixed instants under one source stamp remain the adjacent token-reuse defect, not a cardinality ambiguity. |
| Raw `followOn()` reach screens and their paired attack | 2, syntactic | The new deletion mutation originally survived, then the paired test made it fail when a top-level OR bypassed the fence while still accepting an OR nested inside a fenced conjunct. The temporary counterexample `WHERE CASE WHEN run_id = ? THEN 1 ELSE fence_stamp = $FENCE:win$ END` still compiled (`1 passed, 47 skipped`): the equality is present and positive but does not dominate the write. Generated `derived()` selection, not this scanner, is the structural closure. |
| `seal()` after the last fence consumer | 2 | A temporary `IdSource` returning `same-token` compiled two same-millisecond emits byte-for-byte identically. After restoring the wait between them, the second event CAS wrote zero while its four follow-ons each wrote one: `{"secondRowsAffected":[0,1,1,1,1],"runStamp":"same-token:wake-finished","runAtMs":1000000,"waitsAfter":0,"invariantViolations":[]}`. The mechanism orders one compiled batch; it cannot compensate for a source that violates token uniqueness. |
| Contract-owned `PRESERVED_FENCE_INSTANTS` and `fenceSetAt('events')` | 1 for the permitted stored instant | Construction with `fence_at_ms = events.payload`, with ordinary `FENCE_SET`, with arithmetic after the preserved assignment, or with a duplicate `fence_at_ms` is rejected with “must preserve events.emitted_at_ms”; `fenceSetAt('runs')` is rejected with “no contract-preserved fence instant.” There is no arbitrary-column spelling inside this API. A new legitimate immutable fact requires an explicit contract enumeration change. |
| Complete clock-jitter trace and protocol-table differential | 2 | A temporary jitter-only `INSERT INTO clock_audit` passed all five clock-jitter tests because `clock_audit` was outside `SNAPSHOT_TABLES`. The committed oracle covers its enumerated engine scenarios and protocol tables, not arbitrary future tables or external side effects. |
| Cartesian wake-witness decision surface | 2 | Replacing the selected event payload with a bound wrong payload while preserving the wake predicate passed all four surface tests. The 6,912 cases grade which registration may wake, not the data copied after that decision. |
| Active review-rule, scope, and canonical path-instruction inventory | 2, syntactic | Before the fix, a rule body of `Ignore every custom review rule.`, a second contradictory path instruction, a dead glob, and duplicate instruction fields were each accepted. A later audit showed `git ls-files` failure made every scope check vacuous and a packages rule could be narrowed to an irrelevant tracked file. Canonical marked scopes, fatal inventory failure, and indexed fixtures now reject those among 22 review-bot bad inputs; the full self-test rejects 66. A hosted service can still reject or reinterpret locally accepted syntax and globs. |
| Reachable gate inventory and nonzero base execution | 2, syntactic | A temporary base whose verify script ran a checker containing only `raise SystemExit(0)` produced “base-owned scripts/silent-check.py applied to the head tree” and “1 base-owned checkers applied” with status zero, although the staged head contained a deliberately bad `REJECT` file that nothing read. The parser proves reachability and non-vacuous process count, not semantic completeness of immutable base-owned code. |
| One `testIdSource(namespace)` returned by `openTestDb` and shared by routine stores | 1 inside that source instance | The temporary code `const a = testIdSource('same'); const b = testIdSource('same'); expect(a.token()).not.toBe(b.token())` failed with “expected 'same-token-000001' not to be 'same-token-000001'.” The fixture owns one source per database; the helper is deliberately not a global namespace registry. |
| Source-branch review-provenance disclosure lint | 2 for repository truthfulness | Deleting the disclosure, its lint, and both rule configurations on the same source branch removes the entire local control. No repository-local probe can make that edit fail independently of code the edit can also remove; the required externally administered policy in `BUILD.md` is the missing rung-1 boundary. |
| Portable invariant evidence view and TypeScript evaluator | 1 for one representation, 2 for semantic checks | Before repair, seeds `tenant:one` and `tenant:two` at different instants were grouped as `tenant`, while malformed half-pairs and accounting bounds had no rejecting cases. The red suite produced both a missing expected violation and a spurious `one-batch-two-instants: tenant` violation. The evaluator still observes only surviving protocol rows, not issuance. |
| Applied-schema legacy enrollment | 1 for the test inventory | A lower-case, multiline `alter table` added `wake_kind`, but the old harvester returned `[]`; the red case expected the new column and failed. Applying migrations discovers syntax-independent schema changes. A migration that succeeds while hiding a semantic compatibility issue remains outside this inventory. |
| One FencedBatch statement view and exact executor cardinality | 1 for representation and contract | A comment containing `WHERE` hid a counter bump and produced only an unrelated stale-stamp error; a short result array resolved with an empty outcome. Both red cases now reach exact refusals. Raw SQL outside FencedBatch remains outside this boundary. |
| Canonical user JSON, shipped migration fixture, and unused-local typecheck | 1 at each source boundary | Equivalent payloads failed with “expected { \"a\": 1 } to be {\"a\":1}”; the plan database exposed versions `[]` instead of `[1, 4]`; enabling unused-local checking named five stale SQL spellings. These boundaries do not canonicalize arbitrary bytes, third-party fixtures, or dynamically referenced source. |
| Exact-value and exact-type regression oracles | 2 | The prior assertions accepted arbitrary throws, missing timed waits, two null instants, representative non-string values, and unrelated schema errors. The strengthened cases pin refusal type and state, numeric deadline, both NOW values, every runtime kind, and every classifier branch. They still cover only the enumerated public contract. |
| Executable checker inventory and diagnostic-bearing refusals | 2 | A gate-wired `fence-audit.py` mentioned only in `GOOD_CASES` was reported self-tested, and a missing self-test source produced a traceback that counted as rejection. The new inventory and exact markers refuse both. A checker can still print its expected marker before failing for a later unrelated reason; fixtures therefore keep one named defect each. |
| Shared lexical pass and non-vacuous source inventory | 2 | The first review reported four blockers: empty package/source harvests looked clean; ordinary and interpolated strings hid executable SQL; regex bodies became delimiter or SQL-key structure; and raw call harvest crossed non-code, missed trivia, and accepted opaque indirect lists. The late green review separately showed that a literal-label prefix could hide concatenation and postfix `++` or `--` could make following division look like a regex. One position-preserving pass, complete-argument classifier, executable call harvest, one declared migration-list exception, and fail-closed inventory cover all six reports. Full TypeScript parsing remains outside this deliberately restricted checker. |
| Fail-closed session evidence | 2 | With Git evidence unavailable or `ps` rejecting its query, the old script reached its ordinary found-state report. The red environment cases require explicit diagnostics. A kernel or process API that returns a plausible but incomplete snapshot remains an operating-system trust boundary. |
| Canonical findings and detection-ledger parser | 2 | A postmortem containing two findings and only the prose line “External review: 2” attested; the red self-test reported that `review-attest.sh` accepted it. One exact table grammar now derives both counts and rejects zero, malformed, duplicate, or prose-only ledgers. It checks accounting, not the truth of row narratives. |
| Full legacy wait witness with unique cardinality | 1 within the legacy schema | Two matching legacy waits made claim return a stale wake, emit choose the wrong step, and the generated pair surface disagree. A foreign-owned registration also woke the run. The shared witness refuses ambiguity and owns step recovery. It still cannot prove current-registration identity without PR3.8's immutable wait id. |
| Canonical sealed-fence lifecycle | 1 inside FencedBatch construction | After `seal('finished', fence: 'win')`, a later `derived()` consumer of `win` compiled; the red case failed with “expected Function to throw.” Sealing now transitions the one source record. Compiled SQL replay and direct executor SQL remain outside future builder-state checks. |
| Canonically addressed provenance, seal, and wait mutations | 2 | The old provenance mutation changed two independent guards, and the old seal mutation short-circuited a call site that refactoring had made irrelevant. Later source-view and shared-witness refactors made five verbatim addresses stale; the probe reported every one rather than silently dropping it. The replacements delete one exact predicate or transition at the canonical lexical view or wait witness, and two independent attacks cover unique-step selection and claim cardinality. The final runnable audit caught all 26 mutations. A suite failure after any deletion still proves only the named observable asserted by its target tests. |

The temporary legacy, clock, wake, raw/seal, CASE-reach, and two-source cases
were inserted one at a time and run with focused Vitest commands. Their exact
results were respectively `1 passed, 28 skipped`, `5 passed`, `4 passed`,
`2 passed`, `1 passed, 47 skipped`, and the quoted one-test failure above.
The arity-preserving successor mutation made exactly its two focused cases
fail with the quoted promise results. After every probe was removed, the
committed construction, source, and delayed-replay suites ran together as 67
passing tests. The active configuration probes ran through
`python3 scripts/lint-selftest.py`; the final run rejected every bad,
Git-state, environment, and invocation fixture and accepted every named good
case.

The review and gate parsers are deliberately described as rung 2. They check
syntax whose subject is syntax: whether an active local rule or reachable
command exists. They do not claim the hosted service honored the rule or that
the checker is semantically complete.

The simplification audit also proposed discovering every SQLite table
dynamically for the clock differential. That was rejected: the oracle's
declared subject is the cross-dialect protocol-table contract, while arbitrary
fixture or extension tables are not stable engine observables. The executed
`clock_audit` counterexample remains in the table above as the explicit
boundary; dynamic discovery would hide that boundary by silently broadening
the property rather than deriving the protocol inventory from a shared
cross-dialect schema contract.

## Fix-induced defects

Sixteen findings were introduced by fixes for earlier findings in this same
round. Four were already recorded here. The first emit repair preserved the
old instant only while its token remained current, so an interposed fresh emit
reopened the two-instant bug. Its first `fenceSetAt` seam accepted an arbitrary
stored column rather than a contract-owned fact instant. The first
successor-ownership mutation changed bind arity, so argument validation killed
the mutation before the ownership predicate ran and falsely made the test look
discriminating. Finally, making generated provenance mandatory exposed its
uncorrelated scalar instant subquery to new many-row emit follow-ons; SQLite
silently chose a row while PostgreSQL and MySQL would reject the same
statement.

These repairs were re-reviewed as new code, not merely re-tested. The
interposed-emit counterexample was moved into finding 1's red surface; the
preserved-instant seam was replaced with the typed, dialect-neutral
enumeration and exact assignment-count rejections; and the successor mutation
was made arity-preserving before it was rerun. The generated provenance
chokepoint now reduces every statement-stamped source to one portable scalar,
with a construction regression that declares a many-row bound. Documentation
drift found in that same branch-diff audit was corrected, but it is not counted
as a fifth fix-induced defect.

Six later non-lexical rows brought that subtotal to ten. CodeRabbit 46 found
that the legacy backfill introduced for finding 2 selected one of several
matching waits. CodeRabbit 47 found that finding 10's absent and inactive
review-rule fixtures were the same fixture. CodeRabbit 48 and 49 found that
finding 1's new provenance and seal mutations attacked multiple or obsolete
sites. CodeRabbit 50 found no rejection surface for the tracked-file inventory
added during the review-scope repair. The continuation review then found that
finding 1's `seal()` fix left its dead source consumable by later builder
statements.

The two reviews of the shared lexical/root fix for CodeRabbit 30, 31, 32, and
41 reported six further defects: empty harvest vacuity, hidden executable
strings, regex contents read as structure, unsound raw-call and indirect-list
harvest, computed labels accepted by a literal prefix, and postfix operator
state that hid code after division. One shared lexical mechanism repairs that
class, but mechanism consolidation does not collapse six independently
reported defects into one row. They bring the fix-induced total from ten to
sixteen.

The same audit found a pre-existing mechanism overclaim rather than a defect
introduced by these repairs: `hasTopLevelOr` had neither the rejection test nor
the mutation its review rule said maintained it. Red commit `ca2ae3b` made the
new deletion mutation report “top-level-or-reach: SURVIVED — nothing failed.”
Green commit `1cf8259` added the paired top-level rejection and nested
alternation acceptance; the same mutation was then caught. This is recorded
separately from both the original nine-finding ledger and the sixteen
fix-induced defects. The final simplification audit also found the
pre-existing scope-inventory false negative described in the mechanism table;
it received its own red `a1c36c7` / green `b3617d8` pair rather than being
folded silently into finding 10.

The final mutation audit then self-reported five stale verbatim addresses
after the guarded code moved to the common statement view or full wait
witness: `followon-provenance-check`, `top-level-or-reach`,
`emit-wake-one-witness`, `emit-wake-step-correlation`, and
`legacy-wait-step-backfill`. Commit `950760f` re-aimed rather than deleted
them and added direct attacks on both legacy cardinality decisions. This is
the mutation mechanism detecting its own maintenance need, not an externally
reported correctness finding, so it is not one of the sixteen fix-induced
rows and does not change the detection ledger.

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
- The portability defect induced by mandatory generated provenance: red
  `2c28ebf` failed with “expected UPDATE tasks ... to contain 'SELECT
  MIN(f.fence_at_ms)'”; green `ec84b05` reduces every many-row source to one
  portable statement instant.
- The pre-existing review-scope false negative: red `a1c36c7` produced two
  “review-bot-lint.py ACCEPTED a bad input” failures for dead and irrelevant
  Greptile scopes; green `b3617d8` derives active scopes from marked corpus
  blocks and fails closed when the tracked-file inventory is unavailable.
- CodeRabbit 1: red `33129b7` made the current corpus fail because its
  synopsis did not unconditionally reject one-commit repair, and both its
  Pass and Allowed arms permitted one; green `2f2843c`.
- CodeRabbit 5 and 6: documentation-only ownership commit `1506219` records
  typed source-to-target key pairing and attributable mutation verdicts under
  live PR3.7 work. These are deferred prevention destinations, not behavior
  fixes with artificial red tests.
- CodeRabbit 7, 8, and 9: red `2d70932` failed with a missing
  `tenant:one` violation and a spurious `one-batch-two-instants: tenant`
  violation; green `19d57e7` installs one portable evidence evaluator and
  restores each comment to its check.
- CodeRabbit 10, 12, 16, 22, and 24: assertion-strengthening commit `65038f7`
  pins typed refusal and state, the numeric parked deadline, every non-string
  runtime kind, both NOW values, and every schema classifier arm. Production
  behavior is unchanged.
- CodeRabbit 11: red `0189287` failed with “expected [] to deeply equal
  [ { table: runs, column: wake_kind, version: 2 } ]”; green `cabe8c5`.
- CodeRabbit 13, 14, and 15: red `36c3a4d` showed the hidden counter reach only
  an unrelated stale-stamp error and the short result array resolve with an
  empty outcome; green `92e3c72`.
- CodeRabbit 18: red `2e7be75` failed with “expected { \"a\": 1 } to be
  {\"a\":1}”; green `da5d34e`.
- CodeRabbit 20: red `fd5d278` made typecheck name the five unread SQL
  representations; green `4a91317`.
- CodeRabbit 23: red `d8a1807` failed with “expected [] to deeply equal
  [ 1, 4 ]”; green `b0882f3`.
- CodeRabbit 27, 29, and 42: red `874c84d` reported
  “review-attest.sh ACCEPTED a bad input — a prose ledger must not let a
  postmortem's finding count pass unaccounted”; green `766a189` installs the
  canonical parser, reconciles the earlier count, and removes the stale
  provenance-audit deferral.
- CodeRabbit 30, 31, 32, and 41: red `2739596` exposed eight hidden-span,
  false-positive, and empty-root failures; green `4ec1132`.
- CodeRabbit 33: red `7608205` reported accepted TODO and
  requiring-closure forms below DONE; green `b25f722`.
- CodeRabbit 36: red `9760015` showed a gate-wired `fence-audit.py` listed
  only in `GOOD_CASES` pass and a missing self-test source throw
  `FileNotFoundError`; green `c37c958`.
- CodeRabbit 37, 47, and 50: red `f3f2cf7` exposed wrong-path clock, ledger,
  and inactive-rule diagnostics while pinning unavailable and empty Git
  inventories; green `9d2b83a`.
- CodeRabbit 39: red `c2f10c5` showed missing Git evidence and a rejected
  process query reach the ordinary report; green `8da9c7f`.
- CodeRabbit 40 is the residual comment corrected by green `936d539`, backed
  by the ambiguous-legacy red surface in `487eda8`.
- CodeRabbit 46: red `487eda8` made timeout claim return a stale wake, event
  delivery select the wrong step, and the pair surface disagree; green
  `936d539`. Foreign ownership then failed red in `1006e73` and was folded
  into the one full witness by green `8728cde`.
- CodeRabbit 48 and 49: probe-maintenance commit `c92be6f` separates the
  provenance mutations and aims seal mutations at the predicate and lifecycle
  transition they claim. Final maintenance commit `950760f` re-aims the five
  addresses later moved by the common source view and full wait witness, and
  adds separate unique-step and claim-cardinality attacks. Focused runs caught
  all seven maintained or new attacks; the complete runnable audit reported
  “every mutation was caught” for all 26 entries.
- The sealed-fence continuation: red `d8517ba` failed with “expected
  [Function] to throw an error”; green `8f05ade`.
- Lexical/root findings 47 through 50: red `a338330` reported seven accepted
  bad inputs and two rejected good inputs, covering empty harvests, hidden
  batch-call tokens, executable SQL hidden by ordinary and interpolated
  strings, regex text read as source structure, and opaque indirect lists;
  green `54a42c7` installed the shared lexical and inventory mechanism.
- Late lexer findings 51 and 52: red `35c3721` reported that
  `batch-lint.py` accepted “literal prefix must not disguise a computed runtime
  label” and “division after postfix increment must not turn executable code
  into a regex”; green `0b98d39` makes label classification consume the whole
  argument and preserves completed-expression state across postfix `++` and
  `--`.
- The finding artifact's verdict was: “I do not think the branch is correct. I
  found three engine defects and several verification defects.”
- Finding 4 did not reproduce on the reviewed worktree. Base commit `4196b6e`
  derives every custom-check name from its rule filename,
  `review-bot-lint.py` rejects names of 50 characters or more, the longest
  configured name is 42 characters, and both the checker and its self-test
  pass. No compensating change was made.
- Focused regression suites, both package typechecks, and every checker
  self-test were green after their respective fixes. The final exact
  `pnpm verify` made lint, all ten checkers, formatting, and typecheck green;
  its test leg passed 640 tests and failed only the 11 cases in four files
  that this sandbox forbids from spawning Python, binding localhost, or
  starting child hosts (`EPERM`). Excluding exactly those four
  environment-dependent files made all 640 runnable tests green across 59
  files. Exact `python3 scripts/mutation-probe.py` could not pass its baseline
  in that same restricted environment because it includes those process and
  listener tests. Running the unchanged 26-mutation loop with its standard
  fuzz and chaos exclusions, plus the three remaining environment-dependent
  files, produced zero stale entries and zero survivors: “every mutation was
  caught.”

## Root cause

The common failure was measuring a convenient representation one level below
the property being claimed. A provenance invariant measured surviving stamps,
not token issuance or authorization. A differential measured violation
strings, not executions. A generated matrix counted combinations without
varying the positive facts that distinguish its predicates. Tests measured
equality, truthiness, or any throw instead of exact value, state, and error
type. Checkers found filenames, nonzero exits, plausible source characters, or
an existing root instead of active rules, intended refusals, executable syntax,
and nonempty harvested work. Documentation described desired configuration or
mechanism ownership, not actual service ownership or landed state.

That pattern explains why the branch could accumulate sophisticated machinery
and still self-catch none of these findings. The machinery was not absent; its
oracle discarded precisely the dimension on which the defect differed. The
lexical repairs are the sharpest demonstration: putting four checkers on one
representation removed drift but did not make that representation a
non-vacuity proof, semantic batch harvest, complete argument classifier, or
correct expression-context model. Six independently observed holes shared one
root mechanism without becoming one finding. The repair principle for this
round is therefore not “add more cases” or merely “share the helper.” It is to
bind identity to immutable schema facts, compare exact observable state,
derive schema and gate inventories from their sources, refuse opaque or empty
evidence, and state external trust boundaries without pretending repository
text can enforce them.

## Mechanisms

Built in this PR:

- Immutable successor identity from task plus intended attempt, centralized
  in `successorOwned`, with failure and timeout-sweep mutation coverage
  (rung 1).
- One full wait-registration witness shared by claim and emit, used to recover
  a legacy step before the witness is consumed (rung 1), plus a migration-axis
  claim/decode surface and independent backfill, unique-step, and ambiguity
  mutations (rung 2).
- A typed `derived` update that cannot omit its stamp, generated wake-task
  provenance, and explicit fence consumption with `seal` (rung 1 inside a
  constructed `FencedBatch`), attacked by delayed compiled replay (rung 2).
- One aggregate scalar generated at the `derived()` chokepoint for any
  statement-stamped source cardinality, with a many-row construction
  regression and the provenance mutation kept current (rung 1).
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
  rule bodies and scopes, exactly one canonical global path instruction, and
  reachable base-check execution inventories, each exercised in both
  directions by `lint-selftest.py` (rung 2).
- A monotonic ID/token source returned once by `openTestDb` and shared by every
  converted routine fixture store, plus honest documentation of the narrower
  cross-instant provenance invariant (rung 1 within one source instance).
- Source-branch provenance assertions in the lint and all hosted-review
  documentation, preventing the known false ownership claim from recurring in
  repository text (rung 2).
- A canonical fence lifecycle in which sealing transitions the source record
  and every later consumer consults that same record (rung 1).
- One full legacy wait witness supplying ownership, unique recovered step, and
  ambiguity refusal to both claim and emit, with the active-identity residual
  kept explicit (rung 1 within the legacy schema).
- One dialect-portable provenance evidence projection with TypeScript
  evaluation, and an applied-schema migration differential that enrolls
  legacy columns without parsing DDL spelling (rung 1 representations).
- Canonical JSON at the user boundary, production-admin migration for plan
  fixtures, and unused-local typechecking that deletes dead SQL spellings
  (rung 1 boundaries backed by rung 2 gates).
- Exact-value oracle matrices for refusal type and state, timed deadlines,
  runtime kinds, provenance instants, and schema classification (rung 2).
- Executable checker inventory, diagnostic-bearing refusal cases, explicit
  unavailable and empty evidence states, and one canonical postmortem table
  parser deriving both ledger totals (rung 2).
- One position-preserving lexical pass shared by batch and clock checks, with
  recorded executable string and template spans, regex and division context
  across postfix operators, trivia-insensitive code-only call harvest,
  complete literal-argument classification, one declared migration-list
  exception, and explicit rejection of other opaque batch lists, invalid
  roots, and zero-source harvests. This one mechanism closes the six
  separately reported lexical findings (rung 2).
- Canonically addressed mutation entries for generated provenance metadata,
  the stamp assignment, the sealed-source predicate, the seal lifecycle
  transition, the common statement view, the full wait witness, and both
  legacy cardinality decisions (rung 2).

Deferred (recorded in BUILD.md):

- Replace independently spellable source columns and target keys in
  `FencedBatch.derived()` with contract-owned typed relations or construction
  rejection (PR3.7, rung 1).
- Make mutation-probe catches attributable to a named behavioral or
  construction verdict rather than any compile or suite failure (PR3.7,
  rung 2).
- Give waits immutable registration identity through `wait_id` and
  `active_wait_id`; the full legacy witness refuses ambiguity but cannot prove
  which otherwise matching row is current (PR3.8, rung 1).
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
expression even though the generated `derived()` path cannot. The shared
source lexer is still a deliberately restricted TypeScript model rather
than a compiler parser; an unmodeled operator context, argument shape, or
opaque syntax must fail closed or gain a paired rejecting fixture. `derived()`
still accepts a semantically mismatched source column and
target key, and mutation-probe still cannot distinguish every incidental
compile failure from its intended behavioral verdict. The full legacy wait
witness refuses multiple matches but cannot identify the current one without
immutable wait identity. Finally, until the external-policy BUILD follow-up is
administered, a pull request can remove every hosted-review disclosure and rule
that this round added.

Those are bounded residuals, not claims of completeness. They identify where
the next adversarial review should start.
