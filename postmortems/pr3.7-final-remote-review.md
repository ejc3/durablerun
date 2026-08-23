# Postmortem: final remote review of the PR3.7 closeout

The final remote review of PR3.7 found forty-three accepted defects: thirty-five
on PR #12 and eight fresh findings on PR #11. They ranged from a stale
read-derived successor ordinal and invariant crashes on corrupt counters to
conformance surfaces that ran on one dialect, vacuous tests, incomplete source
harvesters, review evidence that could attest a different commit, and a README
that described a CodeRabbit status-check field its custom-check schema does not
expose. Five red commits made those gaps executable; `eafd0d0` repaired most of
findings 1–42 and `dc10820` repaired finding 43. A later unresolved-thread audit
proved that findings 25 and 31 had each been only partially closed; their
eventual red/green completion is recorded below without counting either
finding a second time. None was found by the project's machinery before the
outside review.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question throughout is what would have made each defect
unwritable or caught it without another review.

## Severity

The worst production defect derived a sweep successor's attempt from the
earlier advisory scan instead of the row fenced by the mutating batch. If the
scan and fenced row diverged, the sweep could attempt the wrong durable
identity and reject the whole tick on a uniqueness conflict. The invariant
library then had a second severe escape: a corrupt non-integer counter threw
out of the checker instead of becoming a finding, so the tool intended to
report corruption could lose its entire report on exactly that input.

The largest assurance failures were systemic. The fault, poison, wake, and
cancellation surfaces were not all enrolled through the shared dialect
fixture; several tests could pass without their named transition occurring;
and clock, fragment, deferral, review-rule, and mutation harvesters had
fail-open inputs. Finally, a review log could contain a completion marker
before a terminal 429, an abandonment trailer could have no reason, and both
review artifacts could describe a different head. Those gaps could publish a
green review status for incomplete or stale evidence. The README then made a
separate gating claim that was not true of CodeRabbit's published custom-check
shape: it said `statusCheck: true` was already set, when the supported fields
are `name`, `mode`, and `instructions`, and
`reviews.request_changes_workflow: true` is what turns a failed error-mode
check into a requested-changes review. The remaining findings either weakened
deterministic replay, portability, diagnostic authority, or the documentation
and query-plan evidence on which the gate relies.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `seededIdSource()` had no regression proving token draws cannot perturb UUID draws | A future stream merge could change replay identities merely because token call order changed | Deterministic harness tests | Nearby tests used a hand-built source and never interleaved the real source's two methods | Compare UUID sequences from equal seeds with and without intervening token draws (rung 2) |
| 2 | The shared source lexer treated backslash as a SQL quote escape | Executable SQL after a backslash-terminated literal, including a raw clock, could disappear from every source lint | Shared lexical scanner and lint self-test | It modeled a language escape rather than the target dialects' doubled-quote rule | One SQL quote scanner uses doubled quotes only, with the concrete hidden-`NOW()` fixture (rung 2) |
| 3 | Review rules cited unstable numeric line anchors that no checker validated | Unrelated insertions could make an allowed precedent point at different code while the rule gate stayed green | Review-rule corpus lint | It proved only that the referenced file existed | Rules cite stable symbols or headings rather than unverified line numbers (rung 2) |
| 4 | A dialect-neutral review rule scoped itself to `store-libsql` | The next store dialect could reproduce a load-bearing guard gap outside hosted review scope | Review-rule scope lint and pluggability gate | Literal store-package scopes were legal text | Portable rules use `packages/store-*`, and literal dialect scopes require an explicit narrow rationale (rung 2) |
| 5 | `.greptile/rules.md` was an unreconciled third index of the review corpus | A rule could be active but absent from the index, or a deleted rule could remain advertised | Review-rule inventory lint | Only the corpus README was reconciled in both directions | Reconcile both generated-consumer indexes against the rule files, with missing and dangling fixtures (rung 2) |
| 6 | Non-integer task or run counters made the invariant evaluator throw | One corrupt value could suppress every invariant finding and turn poison/fault failures into unattributed crashes | Invariant library and corrupt-state surface | The counter decoder threw while temporal decoders returned a condition | Exact-integer decoding returns absence and emits seven storage-class condition IDs before dependent checks (rungs 1 and 2) |
| 7 | Live/terminal state sets and fence-stamp parsing were respelled in the poison oracle | A lifecycle or stamp-format change could make the oracle and the invariant it graded silently disagree | Language-neutral contract and single-representation gate | Each file owned a plausible local copy | Core owns `isLiveState`, `isTerminalState`, and `parseFenceStamp`; both layers import them (rung 1) |
| 8 | The generated fault matrix's pre-state axis ran only through the libSQL fixture | MySQL or Postgres could violate replay and cap boundaries without running the same cells | Shared `StoreFixtureFactory` conformance | A dialect-neutral generator lived in a dialect-bound test entrypoint | One `storeConformance` registry enrolls every dialect in scheduler, fault, poison, and wake surfaces (rung 1, with rung-2 enrollment mutation) |
| 9 | A provenance replay regression did not prove the failed run and successor transition committed | Rejecting both deliveries as lease-lost could pass without failing the run or creating attempt two | Replay progress oracle | It asserted only no unexpected rejection and clean invariants | Pin the exact failed parent and one attempt-two successor; mutations make a no-op fail that marker (rung 2) |
| 10 | The generated poison matrix was a libSQL-only guarantee | A future dialect could amplify every poisoned state without executing the oracle | Shared conformance enrollment | The harness accepted a factory, but its only caller selected libSQL | The same indivisible `storeConformance` registry runs poison for every registered dialect (rung 1, with rung-2 enrollment mutation) |
| 11 | Two independent poison-authority failures used the same broad error matcher | One guard could regress while the other guard's error kept both tests green | Poison-oracle meta-tests | Error class text stood in for the specific offending owner or key | Each attack matches its distinguishing row key or owner evidence (rung 2) |
| 12 | Generated wake behavior lived in a libSQL-only conformance test | The highest-risk atomic wake predicate was not required of future dialects | Shared scheduler conformance | Behavioral and compiled-statement probes were mixed in one store-local file | Shared-schema wake cases run through every fixture; only SQL-text mutations remain dialect-local (rungs 1 and 2) |
| 13 | `FencedBatch` recognized spaced parenthesized `NOT` but not `NOT(` or a bare negated predicate | A negated fence could be misclassified as a positive write gate | `FencedBatch` construction validation | Its text parser recognized one spelling of negation | The scanner covers both near-miss spellings and construction tests reject them; PR3.9 owns the AST replacement (rung 2) |
| 14 | User JSON validation respelled the existing value classifier | Arrays and null could receive weaker diagnostics, and later classification changes had two read paths | Core user-boundary classifier | An inline `typeof` branch looked equivalent for the current case | `userJsonValue` delegates to the one `describe()` classifier (rung 1) |
| 15 | Provenance construction tests covered `ON CONFLICT DO UPDATE` but not MySQL's upsert form | A MySQL upsert could leave fence provenance stale without a construction failure | All-dialect `FencedBatch` tests | The recognizer was proven only against SQLite/Postgres syntax | Accept/reject tests cover `ON DUPLICATE KEY UPDATE` as the equivalent protected write shape (rung 2) |
| 16 | A cancellation-deadline suspension regression was libSQL-only, beside a redundant store-local claim regression | Other dialects could accept a forbidden reschedule or suspend while shared conformance stayed green | Scheduler conformance | Shared behavior was implemented in a dialect test file | Move the deadline case behind `StoreFixtureFactory` and delete the duplicate already owned by shared conformance (rungs 1 and 2) |
| 17 | A generated narrowing test passed when its follow-on wrote nothing | Removing the follow-on or narrowing every row away looked identical to success | Generated-selection progress oracle | The expected state was the pre-state | Pair the refusal case with an intersecting narrow that must durably write, plus an exact no-op mutation (rung 2) |
| 18 | The schema-advancement regression failed at canonical input parsing before reaching its claimed postcondition | A zero-row schema-version bump could report success while the named regression remained green for another reason | Migration postcondition test | Broad schema-error matching allowed an earlier guard to answer | Intercept the actual bump to affect zero rows and require the exact failed-advancement `SchemaMismatchError` and mutation marker (rung 2) |
| 19 | A historical postmortem still described bind-arity attribution as an open residual after it had landed | Readers and later reviews could act on a false live risk | Prevention ledger and postmortem reconciliation | Closure and residual status had separate prose owners | Remove the stale residual and bind live status to the canonical audit/BUILD record (rung 1 for representation) |
| 20 | The PR3.7 postmortem claimed two incompatible mutation-audit totals | The branch could overstate which mechanisms had actually been proved | Review evidence and mutation inventory | Counts were copied into prose rather than derived | Reconcile the text to the live registry and treat the registry/audit output as the count owner (rungs 1 and 2) |
| 21 | `clock-lint` omitted MySQL `CURDATE()` and `CURTIME()` | A future MySQL store could read a second database clock without a gate failure | All-dialect clock lint | Its function vocabulary was incomplete | Add both calls case-insensitively with injected bad fixtures (rung 2) |
| 22 | `clock-lint` did not recognize direct `meta` or `fake_now_ms` reads | Code could create a second engine-time definition without calling a known clock function | Clock lint and source harvester | It scanned clock-call spellings only | Detect direct override-table reads while preserving the one canonical clock source exemption (rung 2) |
| 23 | `deferral-lint` ignored deferred bullets outside a recognized PR entry | Deferred work could belong to no owner and silently disappear from the plan | BUILD ownership lint | Harvest began only at exact PR bullets and skipped unmatched text | Every deferral-bearing bullet resolves to one live owner or fails, with orphan and alternate-marker fixtures (rung 2) |
| 24 | `fragment-lint` hand-rolled root parsing and could scan zero files successfully | A bad staged root or option typo could produce a clean gate without grading store code | Shared checker root and harvest library | It duplicated weaker argument and glob logic | Route through `validated_root` and total store-source harvesting; invalid roots and options fail closed (rung 1, with rung-2 invocation fixtures) |
| 25 | Mutation inventory self-test did not compare bind arity | A mutant could die during argument validation and be credited without exercising its intended guard | Mutation construction audit | Unique source text and marker presence did not constrain placeholder shape | Reconcile source-level question-token drift as a cheap alarm, and make authentic compiler bind failures ineligible for expected-failure attribution at the shared helper chokepoint (rungs 1 and 2) |
| 26 | Review attestation accepted a completion marker before a terminal unprefixed 429 | An aborted external review could post a successful status | Review artifact classifier | Whole-file marker presence and a narrow error prefix stood in for completed execution | Offline log classification checks exact completion evidence and terminal 429/stream-error shapes (rung 2) |
| 27 | A malformed red-test synopsis crashed `review-bot-lint` before its intended refusal | The gate could emit a traceback instead of an attributable policy verdict | Review-rule parser self-test | Semantic parsing ran whenever the malformed body was nonempty | Run downstream policy checks only on a well-formed synopsis and pin the missing-arm rejection (rung 2) |
| 28 | Every fault-matrix boundary seed used `claim_gen = 1` | A hard-coded or transposed generation guard could cross the advertised axis green | Generated boundary matrix | Only `activated_gen` varied | Seed reclaimed generation three and exercise both sides of the generation relation; exact mutations restore the literal-one bug (rung 2) |
| 29 | Fault-matrix cells did not prove their seeded edge transitioned | Ordinary workload could satisfy label coverage after the edge silently no-oped | Fault-matrix progress floor | A trace label was used as a proxy for the targeted durable effect | Assert exact task/run post-state for each crossed edge and mutate each edge into a no-op (rung 2) |
| 30 | Clock-jitter differential scenarios omitted both sweep arms | A later-statement clock read in the largest deadline batches could evade the one-instant oracle | Generated clock-jitter inventory | The scenario set covered retry, event, suspend, and cancellation only | Add an expired-lease sweep schedule and compare complete traces and protocol tables (rung 2) |
| 31 | Two replay collision cases asserted only that something threw | Bind, lease, or schema failures could answer for refusal on successor identity | Replay error-attribution helper | Bare promise rejection discarded the cause | Each collision path owns an exact unique-identity matcher and mutation; an oracle test proves unrelated rejection propagates (rung 2) |
| 32 | `cancelDue` returned an unparenthesized compound fragment while its complement was splice-safe | The first future OR call site could widen cancellation eligibility past the due deadline | Eligibility-fragment single representation | Current AND-only call sites made the asymmetry harmless and invisible | Both halves are self-parenthesized fragments, with a composition test (rung 1) |
| 33 | Sweep derived a successor attempt from the advisory scan rather than the fenced row | A stale scan could produce the wrong durable successor identity and abort the tick on a uniqueness conflict | Fenced-batch successor construction | Two transition sites answered the ordinal from different sources | Generate both the insert value and `successorOwned` check as `f.attempt + 1` from the stamped row (rung 1, with rung-2 stale-scan conformance) |
| 34 | A query-plan assertion only rejected text containing the current sibling alias | Renaming the alias or deleting the guard made the negative assertion vacuously pass | Query-plan discrimination surface | Absence of one rendered string stood in for use of the correlated index probe | Require the positive indexed sibling-search shape and execute a scanning counterexample (rung 2) |
| 35 | Nightly checkout retained credentials under the workflow's default token scope | Later fuzz or TLC steps unnecessarily retained a write-capable credential | Workflow security gate | Checkout defaults and workflow permissions were implicit | Declare `contents: read`, disable credential persistence on both checkouts, and pin the YAML shape in lint self-test (rung 2) |
| 36 | A shared event-suite test discarded the second wait-count result | A dangling wait could survive while the intended zero-count assertion never examined it | Scheduler conformance assertion | Destructuring named only the first batch result | Decode both results and assert the second result's exact zero count (rung 2) |
| 37 | A portable SDK regression compared a stored integer directly with the JavaScript number `1` | A correct adapter returning bigint could fail the shared test solely because of representation | Dialect-normalized test boundary | The assertion assumed libSQL's current runtime representation | Normalize the raw integer with `Number(...)` before the fixed small-value comparison, matching the other SDK assertions (rung 2) |
| 38 | Historical PR #11 incident records no longer satisfied the current postmortem contract | Required recurrence, mechanism-boundary, and detection evidence could be absent while the branch claimed the SEV rule | Postmortem attestation | The gate validated only newly added incident files | Retrofit the three historical records to the current topology and validate their tables and evidence (rung 2) |
| 39 | `FENCED_DEBT` remained as an editable empty bypass set | A later unfenced batch could be legalized by adding one label to the exception list | Batch lint structure | Empty debt looked closed while the extension point remained writable | Delete the set and all lookup logic; lint self-test rejects its reappearance (rung 1, with rung-2 ratchet) |
| 40 | Clock source harvesting was case-sensitive and skipped nested TypeScript and standalone `.sql` files | A lowercase or asset-contained raw clock in a future dialect could bypass a clean lint | Shared source harvester and clock lint | The vocabulary and traversal modeled only top-level TypeScript spellings | Match all clock forms case-insensitively and recursively harvest store TypeScript and SQL sources, with fixtures for every path and spelling (rung 2) |
| 41 | `reviews-abandoned:` with an empty reason bypassed artifact checks | A branch could excuse missing reviews without an auditable explanation | PR-body attestation | Prefix presence stood in for a valid declaration | Allow at most one exact trailer and require a non-whitespace reason; offline fixtures pin both cases (rung 2) |
| 42 | Codex and workflow review artifacts were not bound to the exact PR head | A completed review of an older snapshot could attest newer code | Review provenance attestation | Completion was checked independently of artifact identity | Require exactly one matching `review-head` in both artifacts and compare both to the current SHA (rung 2) |
| 43 | The review-rule README said CodeRabbit custom checks already set `statusCheck: true` and would become GitHub status gates when those names were required | Maintainers could require contexts the app never publishes and believe custom checks were blocking when the actual request-changes workflow was disabled or drifted | Hosted-review configuration/documentation lint | Gating prose was free text, custom-check keys had no schema allowlist, and nothing required `reviews.request_changes_workflow: true` | One canonical marked gating block states the verified service model; the parser allows only `name`, `mode`, and `instructions`, requires `request_changes_workflow: true`, and three self-tests independently attack the prose, invented field, and workflow switch (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| CodeRabbit final remote review on PR #12 (findings 1–34 and 43) | 35 | no |
| CodeRabbit fresh remote review on PR #11 (findings 35–42) | 8 | no |
| Existing conformance, fault, poison, jitter, mutation, lint, and attestation machinery before review | 0 | **yes** |

Self-catch rate: **0 of 43, or 0%** (previous round: **10 of 51, or
20%**). The rate regressed by twenty percentage points. The red tests are
valuable reproductions, but they were written after the outside detector and
therefore do not count as self-catches.

The prior cumulative `review-findings` total was 129; this remote round added
43, so the branch stood at **172** before the later green audit's fourteen
review-caught findings brought the review total to **186**.

## Recurrence

Findings 2–5, 13, 15, 21–27, 34, 35, and 39–43 recur after earlier rounds
claimed source lints, review reconciliation, fence validation, and
attestation. Those mechanisms recognized enumerated text: one quote escape,
one negation spelling, one dialect scope, one file extension, one completion
marker, one index, or one undocumented hosted-service field. The property was
total interpretation of every input and exact authority for the result. This
syntactic-proxy class has recurred in every provenance review round so far.

Findings 8–12, 16–18, 28–31, 34, and 36 recur after the standing progress-floor
rule. Executing a label, observing no change, receiving any rejection, or
checking the absence of one plan string was again accepted as evidence for a
specific transition. The earlier machinery measured activity near the
property; it did not require the named durable outcome and an independently
discriminating counterexample.

Findings 1, 6, 7, 14, 19, 20, 23, 24, 32, 33, 37, and 38 recur after the
single-representation rule. Random streams, lifecycle sets, stamp parsing,
value classification, audit totals, root ownership, eligibility fragments,
successor ordinals, and stored integers each had a second read path. The
earlier rule was a review instruction where these values remained
independently spellable; the repairs move the highest-value cases to one
definition or one construction source.

Findings 26, 38, and 41–43 are the attestation/configuration recurrence. File
existence, marker presence, nonzero-looking prose, and a plausible field name
were proxies for the property that the exact reviewed head completed, every
declared exception is attributable, and the hosted service can enforce the
documented policy. This is the same provenance problem as the engine fence,
expressed in review evidence.

No recurring class was found by the mechanism previously claimed for it. That
is why this round's self-catch rate is zero, and why the fixes include attacks
on the mechanisms rather than only positive regressions.

## Mechanism audit — the false negative of each

The following are post-fix boundary probes, not imagined residuals. Each probe
ran against the repaired implementation (or an immutable copy of it), and the
quoted outcome is the observed result. A pass here means the counterexample is
outside the mechanism's stated authority; it is not evidence that the defect is
acceptable.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| SQL/source lexical lints | 2, syntactic | A temporary store SQL file containing PostgreSQL's quoted function call `SELECT "now"()` ran through `python3 scripts/clock-lint.py <fixture>` and printed `clock-lint: database time confined to NOW_MS (time.ts)` with exit 0. The scanner treats double quotes as data literals, while PostgreSQL can resolve a quoted function identifier. The earlier red `SELECT 'c:\\' AS p, NOW() AS t` is closed; semantic SQL remains deferred to PR3.9. |
| Review-rule corpus and hosted-gating lint | 2, syntactic | A temporary copy changed the fence rule's canonical and Greptile scope from `packages/store-*` to `packages/store-libsql`, then added `<!-- review-bot-dialect-scope-exemption: this rule is dialect-local because this sentence says so -->`. `python3 scripts/review-bot-lint.py <fixture>` still exited 0 with `clean — 11 rules`. The checker reconciles active files, fields, bodies, scopes, the canonical gating block, and `request_changes_workflow`; it cannot establish the truth of an exemption or detect a provider-side semantic change with no repository diff. |
| Shared conformance registry and curated matrix inventories | 1 for registered dispatch; 2 for completeness | A temporary copy exported a new `sagaConformance()` helper without adding it to `STORE_CONFORMANCE_SURFACES`; `vitest ... enrollment.test.ts` passed **4/4**. The one registry prevents a registered dialect from selecting a weaker suite, but a new behavioral surface never declared there—and a new cap never added to curated `MATRIX_PRE_STATES`—is invisible by definition. |
| Canonical core values, invariant counter inventory, and exact progress markers | 1 at each selected source; 2 for inventory/postconditions | A fake invariant snapshot carried a valid terminal task plus `future_counter: 1.5`; `engineInvariantFindings()` returned `{"future_counter":1.5,"findings":[]}` because the new field was not projected. Separately, a temporary `derived()` generator correctly changed task state and provenance but also wrote `failure_reason = 'corrupt'`; `generated-selection.test.ts` still passed **5/5**. Canonical helpers remove the selected second representations; they do not enumerate future values or make a partial postcondition transition-equivalent. |
| Raw `FencedBatch` negation/upsert/reach scanner | 2, syntactic | The executed statement `WHERE CASE WHEN run_id = ? THEN 1 ELSE fence_stamp = $FENCE:win$ END` compiled and printed `accepted CASE fence that can be true without the fence`. The repaired `NOT(`, bare `NOT`, `IS NOT`, and MySQL-upsert spellings are proved; raw SQL dominance is not. Generated `derived()` selection is the structural door, and PR3.9 owns the remaining parser replacement. |
| Clock-jitter differential oracle | 2 | The already-executed post-fix boundary probe added a jitter-only `INSERT INTO clock_audit`, a table outside `SNAPSHOT_TABLES`; all **5/5** clock-jitter tests passed. The sweep scenarios close the reviewed branch omissions, but a future side effect outside the enumerated trace/table snapshot still survives. |
| Mutation source alarm and authenticated bind attribution | 1/2 | An equal raw-question-count mutation can delete a SQL placeholder and add `?` in a TypeScript comment or conditional; the source alarm deliberately does not claim bind proof. A canonical-CLI injected fault withholds all live question-delta reasons in one traversal and requires an aggregate refusal, proving the live enrollment call is not removable but not each declaration independently. Runtime attribution closes only errors produced by the authenticated `FencedBatch` bind factory. An unbranded driver/compiler `TypeError` with identical text remains caller-matchable: an executed `/.*/` probe emitted its exact mutation marker. The private brand owns the two local compiler exits, not bind semantics elsewhere. |
| Review artifact and incident attestation | 2 | A three-line fabricated log—`review-head: d8d4a68`, `tokens used`, `fabricated external verdict`—ran through `--check-codex-log` and printed `codex log complete and bound to review head d8d4a68`. Likewise, the postmortem checker accepts factual prose changes that preserve its required sections and arithmetic. These gates bind shape, head, topology, and accounting; they do not authenticate the producer or historical truth. |
| Nightly workflow lint | 2, syntactic | A temporary nightly workflow retained read-only permissions and nonpersistent checkout, then added `uses: example/cache-credential@v1` with `token: ${{ secrets.DEPLOY_TOKEN }}`. `python3 scripts/gate-lint.py <fixture>` exited 0 and reported all **11** gate checkers clean. The lint owns checkout credentials, not arbitrary action semantics; organization policy remains the authority boundary. |
| Removal of `FENCED_DEBT` and batch classification | 1 for the named bypass; 2 for classifications | A temporary raw `driver-heartbeat` batch performed an arbitrary `UPDATE tasks` and `DELETE runs` with no token predicate; `batch-lint.py` exited 0 with `every batch call site is classified and matches its declared shape`. `FENCED_DEBT` itself is gone, but an existing reason-bearing class can still be used dishonestly because the lint does not parse token reach. |
| Positive query-plan probes | 2, SQLite-specific | A temporary claim predicate retained both indexed sibling searches but added `(SELECT count(*) FROM tasks) >= 0`. The printed plan contained **two `SCAN tasks` nodes**, yet the focused shipped-claim plan test passed **1/1** (9 skipped). The probe discriminates the sibling access it names; it is not a whole-plan cost bound. |

## Fix-induced defects

**Zero of forty-three.** Findings 1–42 were accepted against the snapshot
before `a714ce4..eafd0d0`; findings 25 and 31 were incompletely repaired but
were not caused by that repair. Finding 43 was the already-open PR #12 thread
`PRRT_kwDOTchRjc6T1Oak`, accepted before its `cb280cb`/`dc10820` repair pair.
No remote finding was introduced by a repair for another finding in this same
remote round. The green changes were re-reviewed as code, not merely re-tested.

Later local green-diff and mandatory mechanism audits did find residual or
fix-induced gaps: the conformance inventory/dispatch split recorded as F2; the
successor-ownership oracle issue recorded as self-caught F8; three successive
custom-check parser boundaries recorded as F9–F11; and the promise
attribution, matcher-state, clean-import, canonical-marker, TypeScript lexer,
and compiler-AST gaps recorded as F12–F21. Those belong to the subsequent
audit's detection and fix-induced ledgers; they are not retroactively counted
among these 43 remote findings. The final one-definition registry, fully owned
custom-check-list grammar, canonical verdict helpers, and compiler-backed
source inventory are the ratchets those audits produced.

## Evidence

- Red tests: `a714ce4` added the main conformance, progress, fence-parser,
  schema-postcondition, invariant, and mutation counterexamples against
  `c7fdb1b`; they were run and seen failing before repair. An immutable replay
  of that commit's cumulative lint self-test exited 1 with exactly **20**
  failure blocks: 16 accepted bad inputs, two wrong-reason refusals, one
  crash, and one rejected good invocation.
- Red tests: `bbb90aa` added the workflow, nested-SQL, abandonment, debt-set,
  and historical-evidence attacks against the same buggy base; they were run
  and seen failing. Its cumulative lint self-test exited 1 with exactly **26**
  failure blocks: 18 accepted bad inputs, five wrong-reason refusals, one
  crash, one rejected good invocation, and the direct `FENCED_DEBT` failure.
- Red tests and portable boundary: `67fd394` moved the generated fault, poison,
  wake, and scheduler surfaces behind `StoreFixtureFactory`, added the real
  `seededIdSource` interleaving regression and exact-integer contract cases,
  and exposed the remaining portable-boundary failures before the green fix.
  Its cumulative lint self-test retained the same exact **26** failure blocks,
  while the newly portable TypeScript cases supplied the additional red
  evidence.
- Red test: `10dcdd1` proved that a syntactically complete review journal for a
  different head still attested. Its cumulative lint self-test exited 1 with
  exactly **29** failure blocks: 18 accepted bad inputs, seven wrong-reason
  refusals, one crash, two rejected good invocations, and the direct debt-set
  failure.
- Red test for finding 43: `cb280cb` exited 1 with exactly **three** failures,
  all `ACCEPTED a bad input`: “README claiming CodeRabbit has a
  per-custom-check status field its schema does not expose,” “an invented
  CodeRabbit custom-check field is rejected instead of silently ignored,” and
  “error-mode custom checks with the request-changes workflow disabled cannot
  block a PR.”
- Fixes: `eafd0d0` repaired findings 1–24, 26–30, and 32–42, but the later
  unresolved-thread audit showed that 25 and 31 remained only partially
  closed. Its full `pnpm verify` passed **69 files and 1,645 tests**.
  `dc10820` closed finding 43; its immutable
  post-fix lint self-test printed `105 bad inputs, 3 Git-state inputs, 1
  environment inputs, and 27 bad invocations rejected, 18 good inputs
  accepted`. The later `138120a`, `a2422a8`, and `fc5d710` parser follow-ups
  raised that executed surface to **109** bad inputs without changing this
  remote round's count.
  The current offline incident gate,
  `bash scripts/review-attest.sh --check-postmortem
  postmortems/pr3.7-final-remote-review.md`, reports `SEV rule satisfied: 43
  findings accounted for in postmortems/pr3.7-final-remote-review.md`.
- Finding 31 completion: red `5d2c30c` routed two collision assertions through
  the existing weak seam and proved that it swallowed an unrelated sentinel
  `TypeError`. Green `8ae7fc2` gave self-collision and claim-timeout sweep exact
  collision verdicts and mutations, but the historical worker assertion still
  owned an inline second regex. Red `3f5a487` routed that remaining assertion
  through a deliberately weak shared oracle; green `4e54bec` removed the seam
  so self-collision, historical worker failure, sweep, and the unrelated-error
  control all consume the single `RUN_ID_COLLISION` representation. This
  completes the already-counted finding without incrementing the ledger.
- Finding 25 completion: red `acb36c1` reconstructed the historical
  `? IS NOT NULL` mutation and proved the cheap registry check was absent.
  Green `b3fd914` added a reconciled raw-question-token alarm and its explicit
  equal-count cancellation false negative. Review then showed that a broad
  expected-failure matcher could still launder an authentic compiler bind
  failure; the separate findings and `915c1dc`/`fd5de9c`/`b2047e8` repair are
  recorded as findings 65–67 in the nightly closeout postmortem. Red `3f5a487`
  then proved the claimed live-inventory fault did not execute through the
  canonical CLI: the synthetic question-delta cases alone were insufficient.
  Green `4e54bec` makes that recursive fault run the real 345-entry inventory
  and reject simultaneous removal of all declared question-delta reasons. It
  proves the aggregate enrollment path, not each declaration independently,
  and completes the already-counted finding without incrementing the ledger.
- Finder: CodeRabbit's PR #12 review reported “Actionable comments posted:
  47.” Thread-aware reconciliation found 53 unresolved, non-outdated threads;
  35 reproduced as defects and are findings 1–34 plus 43. Finding 43's thread
  said, “`statusCheck` is claimed by the README but set nowhere in the
  config.” Its proposed field was disconfirmed against the published schema,
  but the reported documentation/configuration drift reproduced: custom
  checks expose `name`, `mode`, and `instructions`, while
  `request_changes_workflow: true` controls requested-changes blocking. The
  review is auditable at <https://github.com/ejc3/durablerun/pull/12>.
- In the live unresolved/non-outdated PR #12 ordering, the accepted source
  threads were exactly **1, 6, 7, 8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 28, 29, 30, 31, 33, 35, 36, 37, 38, 43, 44, 45, 47, 48, 49, 50,
  51, 52, and 53**. Thread #7 is
  `PRRT_kwDOTchRjc6T1Oak` and maps to finding 43; the other descriptions map
  in their prior order to findings 1–34.
- Finder: the fresh PR #11 review produced ten unresolved, non-outdated
  threads; eight reproduced as findings 35–42. The review is auditable at
  <https://github.com/ejc3/durablerun/pull/11>.
- The accepted PR #11 thread IDs, in findings order, were
  `PRRT_kwDOTchRjc6T1YI7`, `PRRT_kwDOTchRjc6T1YI-`,
  `PRRT_kwDOTchRjc6T1YJB`, `PRRT_kwDOTchRjc6T1YJC`,
  `PRRT_kwDOTchRjc6T1YJD`, `PRRT_kwDOTchRjc6T1YJG`,
  `PRRT_kwDOTchRjc6T1YJI`, and `PRRT_kwDOTchRjc6T1YJJ`.
- The eighteen PR #12 comments that did not become findings were recorded,
  not silently dropped: #2 (`PRRT_kwDOTchRjc6Twzc-`) was historical plan text
  already superseded by the authoritative wake set; #3 (`…TwzdK`) was Ruff
  style only; #4 (`…TxrL4`) was optional README-read simplification; #5
  (`…TyN7b`) was a Markdown import-shim nit; #9 (`…T1Oan`) and #11 (`…T1Oat`)
  were optional historical count wording; #13 (`…T1Oaw`) proposed a TLA
  activation guard not justified by the modeled transition; #15 (`…T1Oaz`)
  was a constant-hoist simplification; #25 (`…T1ObN`) and #27 (`…T1ObW`) were
  fixture/`IdSource` refactors with no reproduced semantic defect; #26
  (`…T1ObP`) would weaken the exact fresh-schema classifier; #32 (`…T1Obb`)
  misread contextual verification history; #34 (`…T1Obd`) proposed an
  unrepresentable template guarantee; #39 (`…T1Obj`) duplicated the already
  closed shared CLI boundary; #40 (`…T1Obl`) described a fail-closed exact-body
  check; #41 (`…T1Obo`) objected to deliberate inline exemptions; #42
  (`…T1Obr`) was Ruff style only; and #46 (`…T1Obw`) was optional metadata
  wording.
- The two disconfirmed PR #11 comments were also retained: the nested and
  double-quoted raw-batch claim was already covered by the shared lexer and
  batch lint, and the template-placeholder claim was already covered by
  template-derived marker validation. They were duplicate or invalid attacks,
  not findings.
- Disconfirmation was based on current-code probes and thread-level state,
  not severity labels: accepted comment #51, for example, was a currently safe
  but structurally unsafe fragment pair and therefore remained a finding,
  while style-only comments did not.

## Root cause

The common failure was treating enrollment or textual resemblance as evidence
of the property. A function accepting a fixture was treated as shared
conformance even when only libSQL called it. A test executing a label was
treated as transition coverage even when its target row did not change. A
string containing a fence, completion marker, scope, clock spelling, or plan
alias was treated as semantic authority. The hosted-review README made the
same mistake at one level higher: a plausible `statusCheck` field name was
treated as service capability without binding the prose to the supported
custom-check fields or to `request_changes_workflow`. A value produced by an
earlier scan was treated as the row fenced later.

The repository already named the right laws—pluggability, progress floors,
single representation, and exact provenance—but too many implementations
were writable exceptions to those laws. The repairs therefore centralize
the declared enrollment and contract facts, require exact named post-states,
and make checkers refuse the unharvested inputs their inventories enumerate.
Where the implementation still scans text, the mechanism audit labels it as a
rung-2 proxy rather than claiming the class is closed.

## Mechanisms

Built in this PR:

- A single shared conformance enrollment door for the declared scheduler,
  fault, poison, and wake surfaces, with every present `store-*` package
  registered centrally; later local audit raised its IDs and dispatch to one
  `STORE_CONFORMANCE_SURFACES` definition (rung 1 plus rung-2 mutations).
- Core-owned lifecycle predicates, fence-stamp parsing, JSON value
  classification, and stored-integer normalization replace duplicated
  representations (rung 1).
- Exact named durable postconditions and targeted no-op mutations cover the
  reviewed provenance replay, generated narrowing, reclaimed-generation fault
  edges, collision rejection, migration advancement, and query-plan cases
  (rung 2); they do not claim transition equivalence.
- Fail-closed source/root handling covers the enumerated nested SQL paths,
  dialect clock vocabulary, direct fake-time reads, orphan deferrals, review
  corpus indexes, malformed synopses, and invalid checker invocations (rung 2,
  with shared parsing at rung 1).
- The review-rule README now carries one canonical marked hosted-gating block.
  `review-bot-lint.py` requires CodeRabbit
  `reviews.request_changes_workflow: true`, accepts only the verified
  custom-check fields `name`, `mode`, and `instructions`, and the self-test
  independently attacks prose drift, invented fields, and a disabled workflow
  (rung 2). The later `4e22e73`/`138120a`, `8915e8c`/`a2422a8`, and
  `e54b2ae`/`fc5d710` pairs made the full list harvest total over significant
  entry lines, malformed indentation, and the list prelude.
- Review attestation requires exact head bindings in both artifact forms,
  rejects terminal aborts, and requires a nonempty abandonment reason (rung
  2).
- The owned nightly checkout credentials are read-only and nonpersistent, and
  the specifically named editable `FENCED_DEBT` escape hatch no longer exists
  (rung 2 workflow enforcement; rung 1 removal of that representation).

Deferred (recorded in BUILD.md):

- **PR3.9** replaces semantic SQL text scanning with a compiled operation tree.
  The current negation, clock, and upsert scanners remain explicitly syntactic
  until that lands.
- **PR0.2** moves hosted-review policy out of the pull request's editable
  source branch and makes it an externally owned required check. Exact local
  SHA binding cannot authenticate a source-branch-owned remote policy.
- **PR4.1** supplies native MySQL and PostgreSQL fixture implementations. The
  central enrollment door means those packages cannot select a weaker shared
  suite when they land.

## What this round still would not catch

A semantically equivalent SQL spelling outside the hand-written scanners can
still hide a negated fence, raw clock, or protected upsert until PR3.9 replaces
text with structure. A generated transition can satisfy its asserted
postcondition while corrupting a field the oracle did not include. A new
protocol surface never declared in the central registry, a new matrix boundary
never added to its typed inventory, or a credential introduced by an
unmodeled workflow action still needs a new enumerated surface.

Review evidence with the right SHA and completion shape can still be forged,
because repository code classifies artifacts but cannot authenticate their
external producer. A persuasive but false review-scope exemption can pass, and
the hosted provider can change semantics without a repository diff; the
canonical gating block describes and locks the locally verified model, not the
remote service. Finally, the postmortem gate proves section topology and
arithmetic, not the truth of its prose. These are the boundaries of the
mechanisms built here, not reasons to weaken them.
