# Postmortem: PR3.7 nightly and mutation-attribution closeout (PR #12)

The final PR3.7 closeout first bounded each hosted fuzz process and replaced a
textual workflow proof with one executable plan. The ensuing exact mutation
audit then showed that 47 registry entries did not prove their advertised
causal verdict: 42 failed on a different path and five survived. Those 47
entries collapse to 21 independent machinery defects under this repository's
site-and-cause counting rule. Repairs, mandatory re-review, and a second full
audit found ten more defects. Executing the required mechanism false negative
then found one more Unicode marker-boundary defect. Final adversarial
re-review found that the hosted loop could still credit a planned batch
without dispatching its command. The final registry has 207 live mutations,
including an executable subprocess-boundary attack on that dispatch.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The subject is why the nightly and mutation gates could say more
than they had proved, and what now makes each current claim executable.

## Severity

The worst production risk was a vacuous green nightly. The first closeout
correctly split each shard into four bounded commands, but the plan and the
actual `"${command[@]}"` dispatch remained separately writable. Replacing the
dispatch with `:` skipped every Vitest process while the script still credited
625 walks and exited green. The original topology also ran all 625 walks in
one Vitest process, allowing legal long-lived heap growth to accumulate for an
entire shard and contend with other jobs. `scripts/confine.sh` bounded the
aggregate process, but it did not provide either the fresh-process boundary or
the observed dispatch the proof claimed.

The remaining findings threatened evidence integrity. A dead shell branch,
another failed case in the same test, a generated title different from the
registry, an unrelated compiler directive, a broad `RangeError`, or a
same-spelled local helper could answer for the claimed condition. The strict
audit stopped the branch rather than crediting those paths, so none of the
wrong-path or survivor findings shipped as a green mutation result. Had the
audit or its re-reviews been skipped, the PR could have advertised exact
causal coverage while deleting guards without their named proof failing.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | One nightly shard ran all 625 fuzz walks in one Vitest process | Legal heap growth could accumulate for a whole shard and interfere with the runner | Hosted fuzz topology and resource-confinement contract | Aggregate confinement was mistaken for a fresh-process growth bound | Four deterministic batches per shard, each launched through the canonical confined command, with exact seed partition and per-process walk ceilings (rung 2) |
| 2 | Workflow enrollment was proved by YAML and shell text; a dead `if false` branch or duplicated shard coordinate still looked enrolled | Hosted nightly could execute zero work or omit a shard while local gates reported complete enrollment | Nightly plan and workflow gate | Text occurrence was a proxy for execution | One script owns plan and execution, the workflow invokes that exact script, every fuzz file derives its coordinate from its filename, and exact mutations attack invocation and enrollment (rung 1 for the command source, rung 2 for execution evidence) |
| 3 | `claim-requires-sole-live-run` named an obsolete generated poison-suite title | The intended mutant died but could not receive causal credit | Mutation registry full-test identity | Display text had a second hand-maintained representation | Registry identity was updated to the live generated title; later generated cases carry executable owners rather than reconstructed titles (rung 2) |
| 4 | The maximum-generation claim-receipt control expected the wrong outcome and did not discriminate its mutation | A mutation could survive behind a control that described a different boundary | Conformance control and exact mutation | Boundary intent was not tied to the observed receipt | The exact maximum receipt has its own positive behavior and attributable mutation result (rung 2) |
| 5 | Two whole-fragment checkpoint mutations changed placeholder arity while claiming to delete one ownership property | Bind failure could answer for an ownership regression | Mutation construction surface | A broad fragment replacement crossed several semantic and transport boundaries | Remove the invalid probes; every retained checkpoint mutation changes one condition without changing bind shape (rung 2) |
| 6 | Four spread-descriptor type probes used nearby marker text as ownership for `@ts-expect-error` | An unrelated comment or directive could certify the type boundary | Construction-verdict source analyzer | Textual proximity stood in for compiler ownership | Compiler-recognized directive ownership, exact marker multiplicity, and TS2578 on the owned source line (rung 2 using the language compiler) |
| 7 | Counter-inventory mutations threw during module initialization | A downstream load failure, not the named generated inventory assertion, killed two mutants | Generated inventory mutation surface | The mutation invalidated shared construction before the test could exercise its oracle | Mutations preserve module construction and remove one declared inventory arm at its executable consumer (rung 2) |
| 8 | Lost-launch and claim-timeout poison target-profile verdicts expected wording different from the live assertion | The right profile failed under an unattributable path | Poison targetability registry | Test names and diagnostics were copied rather than derived from the executed assertion | Each profile owns its exact live test identity and marker (rung 2) |
| 9 | Terminal timeout scan and CAS probes shared an obsolete title and marker mapping | Two different guards could not prove which boundary stopped the mutant | Sweep mutation registry | Scenario prose stood in for statement-local ownership | Scan and CAS probes retain separate mutations and exact live verdicts (rung 2) |
| 10 | Terminal timeout decode had no mutation-specific marker | Its failure could be caused by a neighboring terminal-timeout assertion | Sweep decode regression | A shared marker grouped distinct causal claims | The decode mutation owns its exact helper descriptor and canonical marker (rung 2) |
| 11 | Lower-bound and checkpoint poison-severity witnesses were not isolated | Another severity difference could kill the mutation first | Poison-oracle meta-tests | A composite scenario carried more than one decisive delta | Dedicated exact lower-bound and composite-checkpoint severity cases each own one result (rung 2) |
| 12 | Vitest `$name` expansion produced 18 checkpoint titles different from the registry's reconstructed names | Every checkpoint ownership mutation failed wrong-path despite reaching its intended scenario | Generated checkpoint matrix and registry | A template expansion and a Python reconstruction were two representations | Nine relation cases crossed with two operations carry literal executable helper closures and exact descriptors at their source (rung 1 for case ownership, rung 2 for mutation execution) |
| 13 | The zero-statement storage-corruption seam reached a downstream witness failure | A vacuous corruption attempt looked rejected for the claimed reason | Structural-rejection meta-test | The fixture continued into the generated matrix after the seam should have decided | The seam has a dedicated exact construction verdict before downstream execution (rung 2) |
| 14 | The temporal-field identity mutation cascaded into later generated inventory consumers | A broad downstream failure answered for nominal field identity | Temporal descriptor construction test | One mutation changed a source consumed by several generated surfaces | The descriptor's nominal identity has an isolated construction verdict; consumer mutations remain separate (rung 2) |
| 15 | The fake-clock exact-endpoint control had no exact failure owner | An unrelated endpoint exception could kill its mutation | Administrative time-boundary test | Bare `toThrow` behavior did not identify the required error | Exact type and `requireEpochMs` message are required by the mutation-specific helper (rung 2) |
| 16 | Nightly dimension validation bundled several cases in one helper call | A later zero-seed error killed deletion of an earlier dimension guard | Nightly plan validation | One marker covered several sequential failure opportunities | Each invalid dimension is an independent exact `RangeError` type and message case (rung 2) |
| 17 | Coordinate and empty-batch probes trusted generic Vitest missing-throw diagnostics | Framework output could answer for domain validation | Nightly plan construction verdicts | A framework message was accepted as the domain property | `requireExpectedFailure` matches the exact domain error and emits the canonical marker itself (rung 2) |
| 18 | The nightly confinement verdict expected a rendered command different from the executable plan | A correct failure was classified wrong-path | Hosted-plan mutation verdict | Expected text duplicated command rendering | The plan exposes the canonical command array used by execution, and the test compares that one representation (rung 1) |
| 19 | The sole-live claim-receipt fixture was masked by highest-owned-ordinal eligibility | The named sole-live mutation survived while another guard decided the row | Claim-receipt conformance | The fixture violated two preconditions at once | The fixture preserves current accounting and varies only the sibling live run (rung 2) |
| 20 | The sole-live activation fixture was likewise masked by highest-owned-ordinal eligibility | The named activation mutation survived | Activation conformance | The fixture made the target ineligible before sole-live ownership was consulted | The fixture preserves the ordinal relation and varies only the extra live run (rung 2) |
| 21 | The claim-timeout accounting fixture corrupted the wrong counter and selected another branch | The accounting mutation survived without reaching its CAS | Sweep conformance | Scenario state did not identify the target terminal arm | The fixture now corrupts current accounting at the intended post-scan boundary (rung 2) |
| 22 | The driver-heartbeat cleanup victim had expiry equal to the source beat, so it was not deletable | The atomic cleanup mutation survived behind an invalid control row | Driver heartbeat temporal regression | The fixture did not satisfy the strict expiry predicate | The victim's expiry is strictly before the source beat and snapshots prove both rows remain on overflow (rung 2) |
| 23 | The activation first-start-lower mutation was redundant with the coalesced-base headroom guard | Two probes claimed independent coverage for one effective condition | Mutation inventory | Textually distinct guards were treated as semantically distinct | Delete the redundant probe and retain the mutation at the effective boundary; the current inventory proves only its declared conditions (rung 2) |
| 24 | After the first repair, terminal timeout decode emitted its mutation-specific helper marker while the registry still expected a shared marker | The second full audit stopped at 205 of 206 attributable mutations | Helper-to-registry ownership | The helper and registry still supplied independent marker identities | A mutation-specific helper descriptor must own that mutation's exact canonical marker (rung 1 for source identity, rung 2 for the live audit) |
| 25 | The attempted nightly repair still accepted generic `/expected .* to throw/` framework text | A downstream or framework failure could certify a deleted dimension guard | Repair review and nightly verdict helper | Narrower-looking regex remained a proxy for the domain exception | Each case uses exact error type and message through `requireExpectedFailure` (rung 2) |
| 26 | Checkpoint and owner ordinals carried duplicate type and range guards, while split mutations changed both | Deleting one condition could be masked by its peer and receive false confidence | Checkpoint ownership relation and mutation construction | Two spellings represented one ordinal-validity property | Validate the stored checkpoint ordinal once, then compare it with the owner ordinal; all 18 cases own literal executable closures, but duplication remains writable (rung 2) |
| 27 | Typecheck ownership could be satisfied by string or comment proximity instead of a compiler-owned directive | A non-executable marker could enroll a construction verdict | Repair review of the TypeScript analyzer | Lexical presence was mistaken for compiler semantics | TypeScript `commentDirectives` owns only real `@ts-expect-error` directives and the runner requires TS2578 on that exact line (rung 2) |
| 28 | The first directive boundary accepted `not-a-mutation-verdict:...` as the expected marker | Decorated text could impersonate canonical marker ownership | Analyzer false-negative review | The right boundary was checked but the left token was not | Exact two-sided marker boundaries and hostile prefix cases (rung 2) |
| 29 | The next boundary admitted uppercase adjacency such as `Xmutation-verdict:...` | A second decorated marker still impersonated ownership | Mandatory re-review of the boundary repair | The character class modeled lowercase mutation names rather than token adjacency | Both boundaries reject ASCII letters, digits, underscore, colon, and hyphen; uppercase hostile cases are executable (rung 2) |
| 30 | The first compiler repair lost source-line and multiplicity ownership | One marker on two directives or two markers on one directive could satisfy inventory | Analyzer repair review | A set erased occurrence identity | Ordered marker-line tuples preserve multiplicity; duplicates are diagnostics and TS2578 must occur on the one owned line (rung 2) |
| 31 | Poison-oracle test seams leaked through `export *` in the public conformance barrel | Test-only snapshot and severity helpers unintentionally became supported API | Package export review | Wildcard export erased the distinction between contract and fixture seam | One explicit public allowlist and a package with only the `"."` export (rung 1 for current topology) |
| 32 | The fake-clock exact-endpoint verdict accepted any `RangeError` | A different range failure could answer for the endpoint property | Administrative mutation verdict review | Error class was used as causal identity | Match the exact `requireEpochMs` `RangeError` message (rung 2) |
| 33 | Helper ownership trusted any bare call named `requireExpectedFailure` or its siblings | A shadowed local or parameter could satisfy descriptor inventory without executing the canonical helper | Final repair review | Callee spelling stood in for symbol identity | One TypeScript `Program` and `TypeChecker` require the exact unaliased named import from the canonical testing module; shadowed cases are rejected (rung 2 using compiler symbols) |
| 34 | Marker boundaries excluded only ASCII adjacency | Unicode identifier characters could decorate a canonical construction marker and satisfy directive ownership | Required false-negative execution of the repaired analyzer | The boundary modeled current mutation-name characters rather than ECMAScript identifier adjacency | Red `956fbb9` adds Unicode prefix and suffix attacks; green `d01f4ef` uses Unicode `ID_Continue` plus the ECMAScript identifier additions (rung 2) |
| 35 | The hosted loop credited each planned batch after a separately writable `"${command[@]}"` statement; replacing that statement with `:` left every plan assertion and the nightly completion line green | A hosted nightly could report 20,000 walks while executing none, so the volume proof could silently become vacuous | Final adversarial re-review of the executable nightly mechanism | The plan proved argv shape, not external-process dispatch; walk credit was computed from the plan rather than observed execution | A generated mutation replaces the real dispatch with `:`; the focused suite sets `PATH` to a temporary directory containing a probe `env` and requires tagged stdout for shard 0's four planned batch indices (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fresh-process nightly boundary red test, finding 1 | 1 | **yes** |
| Nightly executable-enrollment review, finding 2 | 1 | no |
| Full exact mutation audit at `47987c0`, findings 3 through 23 | 21 | **yes** |
| Full exact mutation audit at `90cc034`, finding 24 | 1 | **yes** |
| Mandatory repair reviews, findings 25 through 33 | 9 | no |
| Executed mechanism false-negative probe, finding 34 | 1 | **yes** |
| Final adversarial code re-review, finding 35 | 1 | no |

Self-catch rate: **24 of 35, or 68.6%** (previous temporal round: **1 of
43, or 2.3%**). This is a material improvement because the long audit found
22 attribution defects without outside review. It is not 47 self-catches:
`47987c0` reported 42 wrong-path entries and five survivors, but those 47
witnesses collapse to 21 independent causes above. Counting every generated
case as a defect would mix test volume with the site-and-mechanism counting
used by the preceding numeric and temporal postmortems.

The last checked-in cumulative trailer was `review-findings: 289`. This round
adds the previously undocumented nightly executable-enrollment finding, nine
mutation-repair review findings, and the final dispatch finding, so PR metadata
must declare `review-findings: 300`. The previously recorded 30 self-catches
rise by 24 to 54. The branch catalogue at this checkpoint is therefore **300
review-caught plus 54 self-caught, or 354 total findings**.

## Recurrence

Finding 1 recurs after the heavy-run confinement rule: an aggregate cgroup was
mistaken for a per-process lifetime bound. Confinement prevents box death; it
does not prevent legal native-heap accumulation across 625 walks. Fresh
processes own that separate property.

Findings 2, 3, 6 through 10, 12, 14 through 18, 24 through 33, and 35 recur
after prior rounds claimed exact attribution and single representation. The
old machinery matched rendered names, marker substrings, exception classes,
callee spellings, nearby comments, or a rendered command plan. Those are
pictures of the property. The property is that one executable owner produces
one exact causal failure—or, for the nightly, that the planned command crosses
the subprocess boundary. This syntactic-proxy class has recurred in every
provenance review round so far.

Findings 4, 11, 13, and 19 through 22 recur after the progress-floor rule.
Each test did execute, but another invalid precondition, downstream assertion,
or non-eligible control decided the result. “The scenario ran” was again a
proxy for “the named edge made the named durable transition.”

Findings 5, 23, 26, and 31 recur after the single-representation rule. Broad
checkpoint fragments, duplicate ordinal guards, redundant activation guards,
and wildcard exports left two spellings for one property. The rule existed as
an aspiration. The explicit barrel makes accidental wildcard leakage
unspellable, but executed reintroduction probes showed that checkpoint and
activation duplication remain writable and undetected; PR3.10 owns that
condition-completeness gap.

Findings 27 through 30 and 33 through 35 are the most important recurrence:
each is a defect in a repair mechanism added during this same closeout. The
first marker repair used proximity, the next used an incomplete boundary, the
next erased multiplicity, the first helper-binding repair used spelling, the
first standalone-marker boundary modeled ASCII only, and the first executable
nightly mechanism proved its plan without observing dispatch. Re-review or an
executable false-negative attack found each proxy before publication. A
compiler API now owns the language facts, marker tokenization remains
explicitly syntactic, and the tagged-stdout probe paired with the exact
dispatch mutation now owns the current dispatch statement.

## Mechanism audit — the false negative of each

The scopes below are deliberately narrow. Where the mechanism is structural,
the row states the property it makes unrepresentable and then the adjacent
property it does not own. Where it is a checker, the row gives the smallest
counterexample that remains outside its claim.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Canonical hosted batch plan | 1 for the command array, 2 for plan assertions | An executed mutant inserted `exit 0 # FALSE-NEGATIVE PROBE: skip every real batch` immediately before `"${command[@]}"`. Original and mutant `--plan` output had the same SHA-256, `530f16f22d977a5bd70ead2335f435eae582f108336a983b1f3a72f675fe75d9`; all **7 then-current plan tests** passed, while real-mode output was zero bytes. Plan inspection proves the exact partition and per-process ceiling it prints, not that the runner launches them. |
| Real-mode subprocess dispatch probe | 2 | The focused test sets `PATH` to a temporary directory containing a probe `env`; executing the command makes that child emit a tagged stdout record. An executed false negative matched the probe-directory basename, ran `"${command[@]}"` only there, and used `:` under ordinary `PATH`. All **8 focused tests** and the complete **3,429-test** verify passed; ordinary real mode still printed `batches=4 walks=625 ... complete` without launching a child; and the targeted dispatch mutation remained exactly attributable at temporary probe commit `90469d2`. This mechanism owns the current unbranched dispatch, not malicious environment branching or descendant-command semantics. |
| Live mutation registry and exact audit | 2 | A same-arity mutation can alter two semantic conditions and receive the exact marker from only one. The executed shared-marker probe below is the smallest runnable false negative: declared inventory and exact attribution do not prove semantic minimality or that every condition was declared. |
| Exact file, full test name, and first-line marker classifier | 2 | Two guards can still feed the same assertion and marker. An executed synthetic `SuiteResult` containing the exact file, full name, and `mutation-verdict:behavior:shared-guard`, with diagnostic `sibling guard failed`, printed `caught`. Per-condition mutations and isolated fixtures, not the classifier alone, own causality. |
| Isolated one-axis scenarios and positive controls | 2 | A matching error from an unmodeled sibling axis can still satisfy the helper without reaching the advertised edge. The exact shared-marker probe printed `caught` with diagnostic `sibling guard failed`; isolation is maintained by the live per-condition mutations, not authenticated by the failure helper. |
| Literal executable helper closures for generated checkpoint cases | 1 for case-to-helper ownership, 2 for behavior | The executed analyzer accepted a canonically imported `requireExpectedFailure({ kind: "behavior", mutation: "probe" }, /x/, async () => { throw new Error("x") })` closure with no diagnostics and descriptor `["behavior","probe"]`; an execution counter reported `productionCalls: 0`. Literal ownership removes reconstructed case names, but the live mutation remains the causal attack. |
| Compiler-owned standalone `@ts-expect-error` marker | 2 | One executed directive suppressed two independent type errors and was accepted as exactly owned. A broad mutant fixing both produced `TS2578`, so the classifier could credit the directive even if the advertised mutation removed more than one boundary. Compiler ownership and Unicode-aware delimiters prove line, directive, multiplicity, and marker—not semantic minimality. |
| TypeChecker-resolved canonical helper and descriptor-owned marker | 2 | The same executed fabricated closure returned no analyzer diagnostics and descriptor `["behavior","probe"]` with `productionCalls: 0`. Symbol identity prevents shadowing and the descriptor prevents a second marker representation; neither proves production reachability. |
| Exact domain-error type and message | 2 | An executed earlier branch threw the same fake-clock `RangeError` before the admin operation; the helper returned `{"verdict":"accepted","adminCalls":0}`. Exact type and text exclude generic framework failures, but they do not authenticate the throwing statement. The same boundary applies to the exact nightly plan errors. |
| Canonical checkpoint ordinal relation | 2 | Re-adding `${storedIntegerWithin(RUN_INTEGER_BOUNDS.attempt, owner)}` inside `checkpointOwnerMatches` restores the duplicate peer validation. The then-current marker self-test still reported all **206 mutations** enrolled, and all **18 focused checkpoint-ownership cases** passed. The current single definition is simpler, but only condition-level mutation generation can make duplication machine-visible. |
| Canonical activation-duration condition | 2 | Re-adding `WHEN ${firstStarted} IS NOT NULL AND NOT ${storedIntegerWithin(TASK_INTEGER_BOUNDS.first_started_at_ms, task)} THEN 0` restores the redundant first-start guard. The then-current marker self-test still reported all **206 mutations** enrolled, and all **four focused activation boundary cases** passed. Deleting the duplicate simplified the current code; it did not make recurrence unwritable. |
| Explicit conformance public barrel | 1 against accidental wildcard leakage | The live explicit barrel reported `{"internalFindingSeverity":true,"publicFindingSeverity":false}`. Deliberately adding that test-only symbol to the allowlist parsed successfully and changed the result to `publicFindingSeverity:true`. Wildcard leakage is unrepresentable; intentional API widening still requires contract review. |
| Postmortem red/green prose | Process rule only | Before finding 35, an executed copy changed a finding to cite `55f797b` as both red and green; the then-current checker still printed `SEV rule satisfied: 34 findings accounted for`. The offline checker validates sections and arithmetic, not commit topology. |

The mechanism rows cover the findings as follows: hosted plan ownership covers
1, 2, and 18, while the subprocess probe covers 2 and 35; the live
mutation registry and exact classifier cover 3, 5, 7 through 10, 13 through
14, 18, 24, and 35; isolated one-axis scenarios and positive controls cover 4,
11, 13 through 15, and 19 through 22; literal generated closures cover 12 and
26; compiler-owned directive analysis covers 6, 27 through 30, and 34;
canonical helper-symbol and descriptor-marker ownership covers 10, 17, 24
through 25, and 33; exact domain-error matching covers 15 through 17, 25, and
32; the checkpoint relation covers 5 and 26; the activation-condition
simplification covers 23; and the explicit barrel covers 31. Findings 5, 23,
and 26 still depend on PR3.10 for generated condition completeness and semantic
mutation minimality.

## Fix-induced defects

There were **thirteen** in the combined closeout: finding 2 and findings 24
through 35. Finding 2 was caused by the first fresh-process proof, whose text
inventory still accepted dead execution. Finding 24 was caused by the
`47987c0`-to-`90cc034` repair adding a terminal-decode helper descriptor while
leaving its registry marker stale. Finding 25 was the generic framework
matcher introduced by `64cbefd`'s first nightly batch-ownership mechanism,
before the executable-enrollment red/green pair. Finding 26 was the attempted
checkpoint repair still changing or masking both duplicate ordinal spellings.
Findings 27 through 30 were successive ownership-analyzer repairs; finding 31
was caused by exporting new poison test seams through a wildcard barrel;
finding 32 was the broad matcher added to attribute the admin control; finding
33 was caused by the first helper-descriptor analyzer matching spelling
instead of imports; finding 34 was caused by the ASCII-only marker boundary
introduced by those repairs; and finding 35 was the unobserved dispatch left by
the shared plan/execution repair for finding 2.

All thirteen were re-reviewed as new code rather than merely re-tested. The
final long mutation audit began after the repairs through finding 33 were in
place. The required false-negative execution then found finding 34; its
standalone red and green commits and a complete `pnpm verify` followed that
audit. Final code re-review then found finding 35 and forced another red,
green, and invalidation of the earlier long evidence; the 207-entry exact
cycle must be rerun before merge.

## Evidence

- Nightly process red commit `55f797b` added the exact partition and
  per-process ceiling against the one-process implementation; green `1ce6962`
  split each shard into four fresh, confined Vitest processes.
- Executable-enrollment red commit `016f0b6` demonstrated that textual YAML and
  shell checks could accept a non-executing or duplicate plan; green `ca85071`
  introduced the shared plan/execution script and exact workflow invocation.
- Final re-review reported: “nightly execution can be skipped while every
  automated proof reports success.” Red `9714523` first made the missing
  observable execution seam fail the focused suite (**1 failed, 7 passed**).
  Decisive red `d508166` then replaced the actual shell dispatch with `:`; its
  targeted audit reported `SURVIVED`. Green `ad21db2` executes the shipped
  real-mode loop with a probe `env` subprocess, derives the expected coordinates
  from the canonical plan, and gives that mutation its own descriptor and
  marker. The focused suite passed **8 tests**, the self-test enrolled **207
  live mutations**, the targeted mutation was exactly attributable, and
  `pnpm verify` passed **74 files and 3,429 tests**.
- The executed false negative of that new probe ran `"${command[@]}"` only
  when `PATH` matched the probe-directory basename and used `:` under ordinary
  `PATH`. The fake `env` therefore emitted four tagged stdout records during
  the focused suite. The complete verify passed **74 files and 3,429 tests**,
  ordinary real mode falsely printed
  `nightly-fuzz-shard: shard=0/32 batches=4 walks=625 steps=150 complete`, and
  the exact `nightly-fuzz-batch-execution` mutation remained attributable at
  temporary probe commit `90469d2`.
- Exact audit head `47987c0` ran 209 mutations: **162 attributable, 42
  wrong-path, and five survived**. The 47 failed entries are preserved above
  as 21 causes rather than inflated into 47 defects.
- Green commit `90cc034` reduced the registry to 206 meaningful mutations,
  removed two bind-arity checkpoint probes and one redundant activation probe,
  and passed `pnpm verify`: **74 files and 3,428 tests**. Its focused 18
  checkpoint mutations were exact. Its full audit then reported **205 of 206**
  attributable and stopped on finding 24.
- Pre-dispatch repair commit `8765b33` bound the remaining helper marker, moved nightly
  validation to exact domain errors, made generated checkpoint ownership
  executable, and resolved helper symbols through one compiler program.
  `pnpm verify` again passed **74 files and 3,428 tests**. The targeted terminal
  mutation was exact, and the full audit ended:

  > every mutation was caught by its attributable verdict at 8765b33365a46d028265e75c4d8b8d9a9eb0cc35

- False-negative red commit `956fbb9` added Unicode prefix and suffix marker
  attacks. The classifier self-test failed with four exact mismatches: each
  case was harvested both as a direct marker and as expect-error ownership.
  Green `d01f4ef` changed the boundary to Unicode `ID_Continue`; the self-test
  passed with **16 direct-marker cases**, and `pnpm verify` passed **74 files
  and 3,428 tests**.
- The repair reviews reported: “Matching Vitest's ‘expected … to throw’ text
  is still a framework-message proxy”; “The split fractional-storage cases are
  still masked by equality”; “Typecheck mutations can still satisfy the
  lightweight inventory through a string/helper instead of a compiler-owned
  directive”; and “TypeScript marker analysis loses line ownership and
  multiplicity.”
- Boundary re-reviews reported: “The directive analyzer accepts decorated left
  prefixes”; “The new boundary class only includes lowercase letters”; “Two
  test-only poison-oracle exports unintentionally widen the public conformance
  API”; “The fake-clock mutation verdict accepts any `RangeError`”; and
  “Helper ownership trusts any bare call named `requireExpectedFailure`.”
- Disconfirmed: the two removed whole-fragment checkpoint probes were not
  evidence for ownership; both changed bind arity. Disconfirmed: the removed
  first-start-lower probe was not an independent activation property; the
  coalesced-base headroom condition already decided the same input.
- Process deviation: findings 25 through 33 were repaired inside `90cc034` or
  `8765b33` without one standalone committed red checkpoint per finding.
  `47987c0` is honest red evidence only for findings 3 through 23, and
  `90cc034` is honest red evidence only for finding 24. This history does not
  satisfy the two-commit rule for the repair-review findings, and this document
  does not invent hashes that do not exist. Rewriting already accumulated
  unpushed history would obscure the actual sequence; PR3.10 owns mechanical
  red/fix commit attestation in addition to condition-level mutation
  generation.

## Root cause

The mutation system had three independently writable representations of one
claim: a source mutation, a registry record containing rendered test identity,
and an assertion that happened to emit marker text. The classifier joined the
last two exactly, but exact equality between two hand-maintained strings does
not establish that either belongs to the first. Generated tests, compiler
directives, and helper calls introduced still more ways for a spelling near
the property to impersonate the property.

The nightly had the same shape. Workflow text, shell text, and a mathematical
seed partition agreed, but none was the process the hosted runner executed.
The common repair is executable ownership: one command array for plan and run
plus an observed external-process dispatch, one literal case closure for each
generated mutation, one compiler-owned directive, one imported helper symbol,
and one canonical marker derived from the mutation descriptor.

## Mechanisms

Built in this PR:

- `scripts/nightly-fuzz-shard.sh` owns both the four-process execution loop and
  its inspectable plan. Workflow invocation, environment, file coordinates,
  batch coverage, confinement, and the real external-process dispatch have
  exact mutations. The dispatch verdict executes the shipped real-mode loop
  with a probe `env` subprocess rather than inferring execution from shell text
  (rungs 1 and 2).
- Every retained mutation preserves transport shape and names one file, full
  test, and canonical first-line marker. The audit rejects survivors,
  bind/compile failures, suite errors, other assertions, and process/report
  disagreement (rung 2).
- Generated checkpoint relation-by-operation cases carry literal executable
  helper closures; no detached marker set or reconstructed mutation suffix
  exists (rung 1 for ownership, rung 2 for behavior).
- Checkpoint conflict validation has one stored-ordinal validation followed by
  one owner equality. The duplicate peer validation and broad fragment
  mutations are gone, but an executed reintroduction probe passed the current
  inventory and focused cases; PR3.10 owns condition-level completeness
  (rung 2).
- One TypeScript compiler `Program` and `TypeChecker` own promise-message
  calls, exact helper import symbols, literal descriptors, direct markers, and
  compiler-recognized directive locations. The self-test has 19
  promise-message, ten descriptor, two helper-binding, three helper-marker,
  and sixteen direct-marker cases (rung 2).
- Mutation-specific helper descriptors derive their exact marker, exact
  nightly domain errors replace framework diagnostics, the conformance barrel
  is explicit, and the fake-clock control matches its exact error (rungs 1 and
  2).

Deferred (recorded in BUILD.md):

- PR3.9 replaces remaining raw SQL and text scanners with compiled structural
  SQL. This attribution closeout does not claim semantic SQL dominance from
  source text.
- PR3.10 generates one attributable mutation per semantic branch and enum
  literal across all 109 condition IDs. It also owns mechanical verification
  that every postmortem's cited red and green commits are distinct, ordered,
  and demonstrate the named red failure before repair.

## What this round still would not catch

A new guard or generated condition omitted from `MUTATIONS` can still ship:
the registry now has 207 declared entries, but even a complete exact audit of
those entries is not proof that declaration is complete. Two guards
deliberately sharing one assertion can still let the sibling kill a mutation.
A canonical imported helper can still be given a callback that fabricates its
accepted error without exercising production.

The hosted dispatch probe proves that the current unbranched real-mode loop
crosses an external-process boundary for shard 0's four planned batch indices.
Code that detects the probe-only `PATH`, runs the command there, and skips it
under ordinary `PATH` still passes both the focused verdict and the targeted
mutation audit; that false negative was written and run above. The actual
hosted fuzz remains the proof that the descendant command performs the workload
rather than merely accepting its argv.

The compiler proves directive, line, multiplicity, symbol identity, and
Unicode-aware standalone marker boundaries, but it does not prove semantic
minimality. A line with two type errors can turn unused for a broader reason.
A deliberate new public allowlist entry can expose a test seam, and a future
validation path can reuse the exact fake-clock error.

Finally, the repository still does not machine-check red/fix commit topology.
This postmortem truthfully exposes bundled repair-review fixes, but prose is
not prevention. Until PR3.10 closes that gate, a future author can again place
a regression and its fix in one commit while every current build check passes.
