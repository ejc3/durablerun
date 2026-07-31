# Postmortem: PR3.7 nightly and mutation-attribution closeout (PR #12)

The final PR3.7 closeout first bounded each hosted fuzz process and replaced a
textual workflow proof with one executable plan. The ensuing exact mutation
audit then showed that 47 registry entries did not prove their advertised
causal verdict: 42 failed on a different path and five survived. Those 47
entries collapse to 21 independent machinery defects under this repository's
site-and-cause counting rule. Repairs, mandatory re-review, and a second full
audit found eleven more defects. The final code head `8765b33` has 206 live
mutations, and all 206 reach their exact attributable verdict.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The subject is why the nightly and mutation gates could say more
than they had proved, and what now makes each current claim executable.

## Severity

The worst production risk was the original nightly topology. One logical fuzz
shard ran all 625 walks in a single Vitest process. A legal long-lived heap
could therefore grow for an entire shard, contend with other jobs, and turn the
nightly from a detector into box-level interference. `scripts/confine.sh`
bounded the aggregate process, but it did not provide the fresh-process
boundary the plan claimed.

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
| 14 | The temporal-field identity mutation cascaded into later generated inventory consumers | A broad downstream failure answered for nominal field identity | Temporal descriptor construction test | One mutation changed a source consumed by several generated surfaces | The descriptor's nominal identity has an isolated construction verdict; consumer mutations remain separate (rung 1 identity, rung 2 attribution) |
| 15 | The fake-clock exact-endpoint control had no exact failure owner | An unrelated endpoint exception could kill its mutation | Administrative time-boundary test | Bare `toThrow` behavior did not identify the required error | Exact type and `requireEpochMs` message are required by the mutation-specific helper (rung 2) |
| 16 | Nightly dimension validation bundled several cases in one helper call | A later zero-seed error killed deletion of an earlier dimension guard | Nightly plan validation | One marker covered several sequential failure opportunities | Each invalid dimension is an independent exact `RangeError` type and message case (rung 2) |
| 17 | Coordinate and empty-batch probes trusted generic Vitest missing-throw diagnostics | Framework output could answer for domain validation | Nightly plan construction verdicts | A framework message was accepted as the domain property | `requireExpectedFailure` matches the exact domain error and emits the canonical marker itself (rung 2) |
| 18 | The nightly confinement verdict expected a rendered command different from the executable plan | A correct failure was classified wrong-path | Hosted-plan mutation verdict | Expected text duplicated command rendering | The plan exposes the canonical command array used by execution, and the test compares that one representation (rung 1) |
| 19 | The sole-live claim-receipt fixture was masked by highest-owned-ordinal eligibility | The named sole-live mutation survived while another guard decided the row | Claim-receipt conformance | The fixture violated two preconditions at once | The fixture preserves current accounting and varies only the sibling live run (rung 2) |
| 20 | The sole-live activation fixture was likewise masked by highest-owned-ordinal eligibility | The named activation mutation survived | Activation conformance | The fixture made the target ineligible before sole-live ownership was consulted | The fixture preserves the ordinal relation and varies only the extra live run (rung 2) |
| 21 | The claim-timeout accounting fixture corrupted the wrong counter and selected another branch | The accounting mutation survived without reaching its CAS | Sweep conformance | Scenario state did not identify the target terminal arm | The fixture now corrupts current accounting at the intended post-scan boundary (rung 2) |
| 22 | The driver-heartbeat cleanup victim had expiry equal to the source beat, so it was not deletable | The atomic cleanup mutation survived behind an invalid control row | Driver heartbeat temporal regression | The fixture did not satisfy the strict expiry predicate | The victim's expiry is strictly before the source beat and snapshots prove both rows remain on overflow (rung 2) |
| 23 | The activation first-start-lower mutation was redundant with the coalesced-base headroom guard | Two probes claimed independent coverage for one effective condition | Mutation inventory | Textually distinct guards were treated as semantically distinct | Delete the redundant probe and retain the mutation at the canonical effective boundary (rung 1 single condition, rung 2 inventory) |
| 24 | After the first repair, terminal timeout decode emitted its mutation-specific helper marker while the registry still expected a shared marker | The second full audit stopped at 205 of 206 attributable mutations | Helper-to-registry ownership | The helper and registry still supplied independent marker identities | A mutation-specific helper descriptor must own that mutation's exact canonical marker (rung 1 for source identity, rung 2 for the live audit) |
| 25 | The attempted nightly repair still accepted generic `/expected .* to throw/` framework text | A downstream or framework failure could certify a deleted dimension guard | Repair review and nightly verdict helper | Narrower-looking regex remained a proxy for the domain exception | Each case uses exact error type and message through `requireExpectedFailure` (rung 2) |
| 26 | Checkpoint and owner ordinals carried duplicate type and range guards, while split mutations changed both | Deleting one condition could be masked by its peer and receive false confidence | Checkpoint ownership relation and mutation construction | Two spellings represented one ordinal-validity property | Validate the stored checkpoint ordinal once, then compare it with the owner ordinal; all 18 cases own literal executable closures (rung 1, with rung-2 mutations) |
| 27 | Typecheck ownership could be satisfied by string or comment proximity instead of a compiler-owned directive | A non-executable marker could enroll a construction verdict | Repair review of the TypeScript analyzer | Lexical presence was mistaken for compiler semantics | TypeScript `commentDirectives` owns only real `@ts-expect-error` directives and the runner requires TS2578 on that exact line (rung 2) |
| 28 | The first directive boundary accepted `not-a-mutation-verdict:...` as the expected marker | Decorated text could impersonate canonical marker ownership | Analyzer false-negative review | The right boundary was checked but the left token was not | Exact two-sided marker boundaries and hostile prefix cases (rung 2) |
| 29 | The next boundary admitted uppercase adjacency such as `Xmutation-verdict:...` | A second decorated marker still impersonated ownership | Mandatory re-review of the boundary repair | The character class modeled lowercase mutation names rather than token adjacency | Both boundaries reject ASCII letters, digits, underscore, colon, and hyphen; uppercase hostile cases are executable (rung 2) |
| 30 | The first compiler repair lost source-line and multiplicity ownership | One marker on two directives or two markers on one directive could satisfy inventory | Analyzer repair review | A set erased occurrence identity | Ordered marker-line tuples preserve multiplicity; duplicates are diagnostics and TS2578 must occur on the one owned line (rung 2) |
| 31 | Poison-oracle test seams leaked through `export *` in the public conformance barrel | Test-only snapshot and severity helpers unintentionally became supported API | Package export review | Wildcard export erased the distinction between contract and fixture seam | One explicit public allowlist and a package with only the `"."` export (rung 1 for current topology) |
| 32 | The fake-clock exact-endpoint verdict accepted any `RangeError` | A different range failure could answer for the endpoint property | Administrative mutation verdict review | Error class was used as causal identity | Match the exact `requireEpochMs` `RangeError` message (rung 2) |
| 33 | Helper ownership trusted any bare call named `requireExpectedFailure` or its siblings | A shadowed local or parameter could satisfy descriptor inventory without executing the canonical helper | Final repair review | Callee spelling stood in for symbol identity | One TypeScript `Program` and `TypeChecker` require the exact unaliased named import from the canonical testing module; shadowed cases are rejected (rung 2 using compiler symbols) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fresh-process nightly boundary red test, finding 1 | 1 | **yes** |
| Nightly executable-enrollment review, finding 2 | 1 | no |
| Full exact mutation audit at `47987c0`, findings 3 through 23 | 21 | **yes** |
| Full exact mutation audit at `90cc034`, finding 24 | 1 | **yes** |
| Mandatory repair reviews, findings 25 through 33 | 9 | no |

Self-catch rate: **23 of 33, or 69.7%** (previous temporal round: **1 of
43, or 2.3%**). This is a material improvement because the long audit found
22 attribution defects without outside review. It is not 47 self-catches:
`47987c0` reported 42 wrong-path entries and five survivors, but those 47
witnesses collapse to 21 independent causes above. Counting every generated
case as a defect would mix test volume with the site-and-mechanism counting
used by the preceding numeric and temporal postmortems.

The last checked-in cumulative trailer was `review-findings: 289`. This round
adds the previously undocumented nightly executable-enrollment finding and
nine mutation-repair review findings, so PR metadata must declare
`review-findings: 299`. The previously recorded 30 self-catches rise by 23 to
53. The branch catalogue at this checkpoint is therefore **299 review-caught
plus 53 self-caught, or 352 total findings**.

## Recurrence

Findings 2, 3, 6, 8 through 10, 12, 14 through 18, and 24 through 33 recur
after prior rounds claimed exact attribution and single representation. The
old machinery matched rendered names, marker substrings, exception classes,
callee spellings, or nearby comments. Those are pictures of the property. The
property is that one executable owner produces one exact causal failure. This
syntactic-proxy class has recurred in every provenance review round so far.

Findings 4, 11, 13, and 19 through 22 recur after the progress-floor rule.
Each test did execute, but another invalid precondition, downstream assertion,
or non-eligible control decided the result. “The scenario ran” was again a
proxy for “the named edge made the named durable transition.”

Findings 5, 23, 26, and 31 recur after the single-representation rule. Broad
checkpoint fragments, duplicate ordinal guards, redundant activation guards,
and wildcard exports left two spellings for one property. The rule existed as
an aspiration; the repaired shapes make the current duplicate unspellable.

Findings 27 through 30 and 33 are the most important recurrence: each is a
defect in a repair mechanism added during this same closeout. The first marker
repair used proximity, the next used an incomplete boundary, the next erased
multiplicity, and the first helper-binding repair used spelling. Re-review
found each proxy before the final audit. A compiler API is now used for the
language facts, while the remaining marker-token boundary is explicitly
classified as syntactic.

## Mechanism audit — the false negative of each

The scopes below are deliberately narrow. Where the mechanism is structural,
the row states the property it makes unrepresentable and then the adjacent
property it does not own. Where it is a checker, the row gives the smallest
counterexample that remains outside its claim.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Shared nightly plan and execution command | 1 for the command array, 2 for hosted execution | A future line after the `plan_only` exit can make the real branch return before `"${command[@]}"` while `--plan` still prints all four commands. The focused plan suite would remain green because it executes only `--plan`; the hosted nightly itself remains the final execution proof. |
| Exact file, full test name, and first-line marker classifier | 2 | Two guards can still feed the same assertion and marker. An executed synthetic `SuiteResult` containing the exact file, full name, and `mutation-verdict:behavior:shared-guard`, with diagnostic `sibling guard failed`, printed `caught`. Per-condition mutations and isolated fixtures, not the classifier alone, own causality. |
| Literal executable helper closures for generated checkpoint cases | 1 for case-to-helper ownership, 2 for behavior | A closure can deliberately throw the helper's accepted error before it calls the store. Its descriptor and marker remain exact, so the source inventory and classifier pass while the checkpoint condition is untouched. The live mutation is the causal attack. |
| Compiler-owned `@ts-expect-error` marker | 2 | One directive line can contain two independent type errors. A broad mutation that removes both makes TS2578 appear on the exact owned line even if the advertised type boundary was only one of them. Compiler ownership proves the line and directive, not semantic minimality of the mutation. |
| TypeChecker-resolved canonical helper import | 2 | The executed analyzer accepted `requireExpectedFailure({ kind: "behavior", mutation: "probe" }, /x/, async () => { throw new Error("x") })` from the canonical import with no diagnostics and returned descriptor `["behavior","probe"]`, although the callback exercised no production code. Symbol identity prevents shadowing; it does not prove reachability. |
| Canonical checkpoint ordinal relation | 1 where composed | A future checkpoint-writing operation can omit `checkpointOwnerMatches` entirely. The existing two operations cannot spell a second peer range guard, but completeness of future consumers remains a generated mutation-inventory property. |
| Explicit conformance public barrel | 1 for the current exported set | Adding a new test-only symbol to the explicit allowlist is syntactically valid and widens the API. Wildcard leakage is unrepresentable; whether a deliberately named export is supported API still requires contract review. |
| Exact fake-clock error type and message | 2 | An earlier validation can throw the same `RangeError` message before `setFakeNowEpochMs` reaches the intended endpoint check. Exact text excludes generic range failures but still does not authenticate the throwing statement. |
| ASCII marker-token boundaries | 2, syntactic | The executed analyzer accepted `// @ts-expect-error Ωmutation-verdict:construction:probe` with no diagnostics and returned the canonical direct marker plus expect-error ownership on line 1. Current mutation names are ASCII; semantic token ownership would require deriving the marker from a parsed descriptor rather than scanning comment text. |
| Postmortem red/green prose | Process rule only | The offline postmortem checker validates sections and arithmetic, not that every cited red hash is distinct, earlier than its fix, and test-only. A document can cite the same commit as red and green and still pass shape attestation. This closeout therefore cannot claim commit-topology enforcement. |

## Fix-induced defects

There were **seven** in the combined closeout. Finding 2 was exposed after the
fresh-process repair: the workflow had become bounded, but its first enrollment
proof still accepted dead execution. In the mutation repair, findings 28
through 33 were introduced by or exposed through the first repairs for marker
ownership, analyzer identity, package seams, admin attribution, and helper
inventory.

All seven were re-reviewed as new code rather than merely re-tested. That
re-review is why the final long audit began only after the compiler-owned
directive, explicit barrel, exact admin error, literal checkpoint helpers, and
TypeChecker symbol resolution were in place.

## Evidence

- Nightly process red commit `55f797b` added the exact partition and
  per-process ceiling against the one-process implementation; green `1ce6962`
  split each shard into four fresh, confined Vitest processes.
- Executable-enrollment red commit `016f0b6` demonstrated that textual YAML and
  shell checks could accept a non-executing or duplicate plan; green `ca85071`
  introduced the shared plan/execution script and exact workflow invocation.
- Exact audit head `47987c0` ran 209 mutations: **162 attributable, 42
  wrong-path, and five survived**. The 47 failed entries are preserved above
  as 21 causes rather than inflated into 47 defects.
- Green commit `90cc034` reduced the registry to 206 meaningful mutations,
  removed two bind-arity checkpoint probes and one redundant activation probe,
  and passed `pnpm verify`: **74 files and 3,428 tests**. Its focused 18
  checkpoint mutations were exact. Its full audit then reported **205 of 206**
  attributable and stopped on finding 24.
- Final code commit `8765b33` bound the remaining helper marker, moved nightly
  validation to exact domain errors, made generated checkpoint ownership
  executable, and resolved helper symbols through one compiler program.
  `pnpm verify` again passed **74 files and 3,428 tests**. The targeted terminal
  mutation was exact, and the full audit ended:

  > every mutation was caught by its attributable verdict at 8765b33365a46d028265e75c4d8b8d9a9eb0cc35

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
The common repair is executable ownership: one command array for plan and run,
one literal case closure for each generated mutation, one compiler-owned
directive, one imported helper symbol, and one canonical marker derived from
the mutation descriptor.

## Mechanisms

Built in this PR:

- `scripts/nightly-fuzz-shard.sh` owns both the four-process execution loop and
  its inspectable plan. Workflow invocation, environment, file coordinates,
  batch coverage, and confinement have exact mutations (rungs 1 and 2).
- Every retained mutation preserves transport shape and names one file, full
  test, and canonical first-line marker. The audit rejects survivors,
  bind/compile failures, suite errors, other assertions, and process/report
  disagreement (rung 2).
- Generated checkpoint relation-by-operation cases carry literal executable
  helper closures; no detached marker set or reconstructed mutation suffix
  exists (rung 1 for ownership, rung 2 for behavior).
- Checkpoint conflict validation has one stored-ordinal validation followed by
  one owner equality. The duplicate peer validation and broad fragment
  mutations are gone (rung 1).
- One TypeScript compiler `Program` and `TypeChecker` own promise-message
  calls, exact helper import symbols, literal descriptors, direct markers, and
  compiler-recognized directive locations. The self-test has 19
  promise-message, ten descriptor, two helper-binding, three helper-marker,
  and fourteen direct-marker cases (rung 2).
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
the audit is exact for all 206 declared entries, not proof that declaration is
complete. Two guards deliberately sharing one assertion can still let the
sibling kill a mutation. A canonical imported helper can still be given a
callback that fabricates its accepted error without exercising production.

The compiler proves directive, line, multiplicity, and symbol identity, but it
does not prove semantic minimality. A line with two type errors can turn unused
for a broader reason, and comment marker boundaries remain an ASCII lexical
check. A deliberate new public allowlist entry can expose a test seam, and a
future validation path can reuse the exact fake-clock error.

Finally, the repository still does not machine-check red/fix commit topology.
This postmortem truthfully exposes bundled repair-review fixes, but prose is
not prevention. Until PR3.10 closes that gate, a future author can again place
a regression and its fix in one commit while every current build check passes.
