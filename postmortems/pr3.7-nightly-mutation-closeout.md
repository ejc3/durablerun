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
without dispatching its command. Subsequent closeouts followed retry and
task-code boundaries through the worker and completed two unresolved review
threads. The closing simplification pass then exposed an ambiguous poison-call
settlement representation and two compiled wake shapes hidden behind each of
two stable batch labels. The current registry has 421 declared live mutations, including
attacks on dispatch, every declared task-realm condition, collision error
attribution, compiler-bind laundering, completion-error origin, single-read
timeouts, each absolute-wake discriminant, every current task/run ownership
door, durable worker-payload admission, poison-settlement ownership, and
sole-live terminalization.

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

The closing findings threatened those proofs in two more ways. A store call
could commit its healthy transition and then reject with `undefined`, while the
poison oracle represented both that rejection and successful fulfillment with
the same absent optional fields. Separately, relative and absolute wakes sent
different SQL text and bind arities through the same `reschedule` and `suspend`
tracing/crash-injection addresses. The SQL produced the intended timestamps,
but one observed label no longer identified one compiled transition shape, so
fault and attribution evidence for one variant did not prove the other.

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
| 36 | A valid zero-base exponential retry became `NaN` after exponent overflow | Failure handling escaped before `store.fail`, so lease recovery could repeat user work without spending the attempt | Retry math, durable decode, and SDK failure conformance | Bounds were checked at individual numeric helpers, but raw policy data and the overflow product had no single total boundary | One normalizer at spawn, decode, and public math APIs; frozen nominal millisecond-canonical data; zero-base short-circuit and exact retry mutations (rungs 1 and 2) |
| 37 | Handler failure classification read or coerced arbitrary thrown objects | A revoked proxy, accessor, or coercion hook could crash classification and strand the claim | SDK task-failure boundary | The layer below was verified, but the new JavaScript throwable boundary had no total snapshot primitive or hostile-value surface | One non-throwing owned `snapshotTaskThrowable` result, data-descriptor-only diagnostics, fixed uninspectable spelling, and exact hostile-value mutations (rungs 1 and 2) |
| 38 | Public `SuspendSignal`, `LeaseLostError`, and `StoreUnavailableError` membership granted runtime authority | Task code could suspend without parking or claim an infrastructure outcome, bypassing user-failure accounting | Worker control-flow authority | Public construction and `instanceof` were proxies for provenance | A fresh per-invocation WeakMap pairs a private context issuer with a worker-retained classifier; public construction and forged prototypes are ordinary failures (rung 1) |
| 39 | The first authority repair resolved the WeakMap constructor and methods when an invocation began | Task initialization could replace those intrinsics before scope creation and mint, hide, or suppress controls | New task-control authority layer | The repair made the map private but captured its machinery after untrusted initialization | Capture the constructor and bound get/set operations at module evaluation, with hostile replacement cases (rungs 1 and 2) |
| 40 | The core throwable-classifier repair had one composite forgery verdict and only one forgery mutation | Other independently writable class-authority arms could regress while the claimed core surface stayed green | Core classifier fault surface | One example per mechanism was treated as proof of every condition | One exact mutation and attributable verdict for each public and forged error authority arm (rung 2) |
| 41 | The SDK runtime corpus had one aggregate enrollment mutation | Hostile-value or constructed-control cases could disappear while the claimed runtime surface stayed green | SDK replay-equivalence fault surface | The new layer did not receive its own per-case fault surface at birth | One exact enrollment mutation for every currently enumerated runtime throwable case (rung 2; generation remains PR3.10) |
| 42 | The hostile store-classifier fallback mutant failed before Vitest emitted its custom marker | A real kill was correctly refused as wrong-path, leaving one of 51 targeted mutations unattributable | Exact mutation verdict | The assertion delegated rejection attribution to framework rendering | `attributeExpectedFailure` owns the canonical marker after matching the exact revoked-proxy rejection (rung 2) |
| 43 | Retry normalization resolved `Reflect`, `Object`, `Number`, and `Math` operations after task code ran | A valid policy could become `none`, get a forged delay, or throw before durable failure accounting | Core retry boundary | Numeric totality did not authenticate the operations performing it | Module-time captured retry operations and one exact replacement case per operation (rungs 1 and 2) |
| 44 | Task-value parse/stringify and graph inspection resolved mutable ambient operations | A handler could forge the durable result or make deterministic bad data look retryable | Core durable task-value codec | Capturing only `JSON.stringify` still let `toJSON`, getters, prototypes, and ambient helpers decide the wire value | Snapshot the raw graph once into owned null-prototype data, reject unsupported values/cycles, and use captured parse/stringify and graph operations (rungs 1 and 2) |
| 45 | User duration, JSON, and name classifiers used mutable `String`, array, and regular-expression dispatch | Invalid durable inputs could be admitted or classified as ordinary retryable failures | Core task-input boundary | Validation logic was total over values but not over its ambient operations | One captured core intrinsic table and exact classifier replacement cases (rungs 1 and 2) |
| 46 | `ReplayContext` used ambient `Map` methods and JSON operations | A task could skip a step, lose a checkpoint, or return a value different from durable replay | SDK replay boundary | Single representation did not include the in-memory bookkeeping operations | Captured map construction/get/set/has and canonical JSON operations at every replay source (rungs 1 and 2) |
| 47 | Worker orchestration used ambient abort, promise, numeric, parsing, and string operations | Heartbeats or finalization could be disabled, forged, rejected, or left pending | SDK invocation boundary | The handler and orchestration shared one realm but the worker resolved host operations late | Captured abort accessors/methods, two-input promise adoption, parse, max, and character access (rungs 1 and 2) |
| 48 | `ReplayContext` still read `this.#leaseLost.aborted` through a mutable prototype getter | A forged false value could let work continue after lease loss | Context lease-loss boundary | The worker captured the getter, but the context retained a second read path | Route every lease-loss read through the one captured accessor (rung 1) |
| 49 | Captured `RegExp.prototype.test` still dispatched through mutable `.exec` | A replacement could admit storage-unsafe names despite the apparent capture | Core name classifier | Capturing a composite method did not capture its transitive dispatch | Invoke captured native `RegExp.prototype.exec` directly (rung 1) |
| 50 | Captured `Promise.race` still consulted mutable `Promise.resolve` and the input iterator | A completed invocation could reject or hang during finalization | Worker promise boundary | Capturing the outer method did not own adoption or iteration | A two-input helper attaches captured native `then` directly to both owned promises (rung 1) |
| 51 | Event-wake classification trusted inherited `timedOut` and `payloadJson` properties | Prototype pollution could turn a payload into timeout or supply a forged payload | SDK event boundary | `in` and ordinary property reads confused inheritance with durable discriminants | Captured own-property checks select the one durable wake representation (rung 1) |
| 52 | The first owned serializer did not define a closed JSON object model | Boxed primitives and exotic objects serialized as `{}`, while prototype `toJSON` could disguise forbidden values | Core task-value contract | “JSON-compatible” was delegated to host serialization semantics | Explicitly admit only primitives, arrays, plain objects, and authentic Dates; reject functions, symbols, bigint, cycles, and exotic objects before stringify (rung 1) |
| 53 | Registry dispatch still called mutable `Map.prototype.get` | A task could hide an existing handler and cause a claimed run to defer | SDK task registry | `ReadonlyMap` syntax did not identify authoritative native-map storage | Captured native Map lookup for authentic maps; structural resolvers are explicitly trusted host code (rung 1) |
| 54 | New task-value and classifier conditions were added without matching literal mutation ownership | The repair could claim a complete fault surface while several new arms were absent from the registry | Core mutation enrollment | Source conditions and mutation declarations remained separate lists | Literal per-condition markers plus exact registry reconciliation; generation remains PR3.10 (rung 2) |
| 55 | One SDK map-method test combined `has` and `get` and never perturbed `set` | Any one replay-map operation could regress while the umbrella verdict stayed green | SDK replay mutation surface | One scenario was treated as proof of three independently writable methods | Independent has/get/set cases and exact mutations (rung 2) |
| 56 | Captured abort signal and aborted getters had no independent mutation owners | Getter capture could disappear while adjacent abort tests stayed green | SDK worker mutation surface | Constructor and method coverage was mistaken for accessor coverage | Separate getter tests, literal markers, and mutations (rung 2) |
| 57 | Deleting the task-value cycle guard still ended in a stack overflow reclassified as `FatalTaskError` | The mutation survived semantically while the broad fatal assertion stayed green | Core serializer mutation oracle | Failure class was a proxy for single-read cycle detection | A one-read cyclic getter distinguishes the owned guard from downstream overflow (rung 2) |
| 58 | The first signal-getter replacement test threw before reaching its marker-bearing assertion | A real kill would be rejected as wrong-path rather than maintaining the capture | Exact mutation attribution | The poisoned operation, not the oracle, produced the failure | Return a distinct forged signal, restore the intrinsic, then assert identity at the canonical marker (rung 2) |
| 59 | Owned serialization passed ordinary descriptor objects to captured `Object.defineProperty` | Polluted descriptor prototypes could still derail durable serialization | New serializer repair | Captured invocation did not make its argument representation owned | Build null-prototype property descriptors before the captured call (rung 1) |
| 60 | The first captured registry lookup bypassed legitimate Map-subclass overrides | Existing custom dispatch semantics silently changed and handlers appeared missing | Registry compatibility repair | Native-map containment and arbitrary override semantics were combined without an authority policy | Make stored native Map entries authoritative; do not treat subclass overrides as grant or revocation authority (rung 1) |
| 61 | Production `systemClock` resolved promise, abort, math, timer, and event operations after handler execution | A handler could prevent sleep/yield or worker-finalization delay from settling correctly | Core production clock | SDK capture stopped at the clock port while its implementation remained ambient | Capture the production clock operations and maintain each consumer with exact mutations (rungs 1 and 2) |
| 62 | Preserving a Map-subclass override still let its `super.get` dispatch through a replaced `Map.prototype.get` | A valid stored handler could remain hidden under the combined conditions | Registry containment and compatibility review | Separate pollution and subclass tests never composed the two axes | The explicit authoritative-entry policy bypasses subclass dispatch for every authentic Map instance (rung 1) |
| 63 | The clock mutation surface covered the sleep promise constructor but not `yieldTurn`'s independent constructor | Yield could regress to ambient `Promise` while all clock mutations stayed green | Core clock mutation surface | One capture source was treated as proof of two consumers | A separate literal yield verdict and consumer-site mutation (rung 2) |
| 64 | The registry repair proved override-based revocation but not override-based grant for a missing entry | A subclass could still mint handler authority for an unregistered name | Registry authority oracle | Only the stored-entry-present direction was executable | A missing-entry denial regression and exact fallback-on-undefined mutation make authority two-sided (rungs 1 and 2) |
| 65 | The shared expected-failure matcher could accept an authentic `FencedBatch` bind-count failure and emit the requested mutation marker | A same-count source false negative plus a broad matcher could receive exact credit without exercising the intended guard | Canonical expected-failure helper | Caller matchers had authority over compiler-integrity failures | A private compiler-bind brand is propagated before caller matching at the one `matches` chokepoint used by all three helpers (rungs 1 and 2) |
| 66 | The first brand repair covered bind-count mismatch but omitted the compiler's explicit-undefined argument exit | One compiler bind failure could still be laundered by a broad matcher | `FencedBatch` compiler error factory | The repair branded one producer rather than the whole producer class | Both compiler bind exits use one authenticated factory, with independent mutations (rung 1) |
| 67 | The first brand factory used ambient `Error`, lost the compiler's `TypeError` contract, and paired the brand with an object-only predicate | Replacement could create a callable branded value that the predicate missed and a broad matcher then credited | Compiler-error authentication repair | Private membership was added without capturing construction or aligning construction, error type, and brand domain | Use the module-captured native `TypeError`, one private WeakSet factory, and a predicate aligned with the brand domain (rungs 1 and 2) |
| 68 | An ordinary rejection from `complete` was rethrown inside the outer handler catch and entered user-failure accounting | A handler that succeeded could be billed a retry or terminal failure after only finalization failed | Worker phase and error-origin boundary | An inner catch and its comment said completion was outside user classification, but the call remained lexically nested inside it | Close the handler/serialization catch before a sibling completion `try`; only the former can call `recordUserFailure`, with an exact mutation (rungs 1 and 2) |
| 69 | `awaitEvent` read `opts.timeoutSeconds` separately for presence, validation, and persistence | A changing getter could persist a timeout different from the value that passed validation | SDK durable-input boundary | Repeated optional-property expressions were treated as a value rather than user-controlled effects | Snapshot once into a lexical, validate it, and pass that same value to the store, with an exact changing-getter mutation (rungs 1 and 2) |
| 70 | Task-control wake copying used prototype-inclusive `'inSeconds' in wake` | An inherited property could turn an absolute suspension into a relative one before it reached the store | Invocation control snapshot | Owning the copied payload did not own the discriminant used to select its representation | Captured own-property classification in `isRelativeWake`, plus an exact prototype-pollution mutation (rungs 1 and 2) |
| 71 | `reschedule` used prototype-inclusive wake discrimination at its independently writable store consumer | An absolute deadline could be persisted as database-now plus an inherited delay | Store suspension input boundary | The TypeScript union supplied no runtime provenance and `in` admitted inheritance | One captured own-property decision feeds one `prepareWake` snapshot at `reschedule`, with a site-owned exact mutation (rungs 1 and 2) |
| 72 | `suspendRun` independently used the same prototype-inclusive wake discrimination | A run could park at the wrong instant while atomically writing a marker for the requested absolute instant | Atomic suspension input boundary | Sharing a type did not make the second consumer share runtime classification | The `suspendRun` call site makes its own captured own-property decision and feeds the same `prepareWake` shape, with an independent exact mutation (rungs 1 and 2) |
| 73 | The private compiler-brand predicate had producer mutations but no mutation of the WeakSet membership read itself | Deleting consumer-side authentication could leave the advertised bind-attribution surface falsely complete | Core mutation enrollment | Producer coverage was treated as coverage of the independently writable predicate consumer | `testing-helper-bind-brand-read` deletes only `weakSetHas` and owns the exact construction verdict (rung 2) |
| 74 | The session process scanner recognized only `Z` as terminal and treated Linux's terminal `X`/`x` states as live evidence failures | A process exiting during snapshot collection could falsely refuse a clean session and block final attestation | Session-state scanner self-test | One observed terminal spelling was used as a proxy for the kernel's terminal-state class, and phase-specific error branches respelled the decision | One `TERMINAL_PROCESS_STATES` definition and `process_is_gone` classifier own the initial observation, failure rechecks after owner/argv/cwd phases, and the final identity observation; a generated phase matrix exercises `Z`, `X`, and `x` transitions (rungs 1 and 2) |
| 75 | `task-value-raw-nested-symbol` reached its exact marker but also failed two unmarked generic nested-symbol cases | The full audit rejected a real serializer guard kill as wrong-path | Core task-value mutation oracle | A generic value matrix and the intrinsic-containment case were two decisive owners for one nested-symbol condition | Keep top-level symbol coverage in the generic matrix and make one combined object/array assertion the sole nested-symbol owner (rung 2) |
| 76 | The verdict classifier rejected an exact `AssertionError: <marker>` first line when Vitest emitted no trailing matcher detail | A correctly killed exotic-object mutant was reported wrong-path despite an exact diagnostic | Mutation verdict classifier | The accepted first-line grammar assumed every assertion diagnostic appended `: …` | Recognize the exact no-detail assertion form without permitting substring/source-context credit, and maintain it with a classifier self-test (rung 2) |
| 77 | The context lease-loss getter marker was attached to the persisted-result assertion after an earlier unmarked worker-outcome assertion | The captured-getter mutant failed for the intended reason but could not receive exact credit | SDK worker mutation oracle | One scenario had two sequential decisive assertions and registered the later one | The mutation marker owns the first observable `claimAndRun` outcome; the persisted result remains a healthy-path control (rung 2) |
| 78 | The mutation classifier could credit an exact owned marker while the same test also emitted a collateral failed assertion or diagnostic | A broad mutant could delete more than the advertised condition and still receive exact credit | Mutation verdict classifier | Marker identity was treated as sufficient even when the structured report proved more than one decisive failure | Require exactly one failed assertion and exactly one assertion message, with injected multi-assertion and multi-message faults (rung 2) |
| 79 | The live mutation registry no longer contained the exact non-integer-attempt attack for `suspendRun` | A durable ordinal guard could disappear while the branch still claimed exact coverage | Mutation ownership inventory | Historical marker text survived after its live source mutation was dropped | Restore the exact CAS-site mutation and require every reserved marker to have one live owner (rung 2) |
| 80 | The sweep non-integer-attempt owner had been dropped, and a naive restored mutant was masked by another attempt proof before reaching the winning CAS | Sweep could consume a corrupt attempt after discovery while an advertised mutation remained non-discriminating | Sweep scan-to-CAS mutation surface | A source-shaped deletion was mistaken for a causal attack on a guard composed in several terminal arms | One CAS-local composite mutation removes all three masking attempt proofs, paired with the post-scan corruption regression and exact verdict (rung 2) |
| 81 | Checkpoint replay and `ReplayContext` construction occurred outside the heartbeat pump's cleanup scope | A malformed checkpoint could reject construction and leave lease upkeep running after the worker returned | Worker pass lifecycle | Cleanup covered handler execution but not every fallible setup step after pump launch | One outer `try`/`finally` owns checkpoint read, context construction, handler execution, and finalization, and always stops and joins the pump (rung 1) |
| 82 | Retry accounting reread the public `ctx.attempt` property after user code ran | Task code could assign a forged attempt and suppress or accelerate durable retry exhaustion | Worker retry authority | A public context view was reused as trusted bookkeeping after crossing task code | Snapshot `attempt - infra_retries` before task code, store a private read-only context value, and use only the worker-owned lexical for retry decisions (rung 1) |
| 83 | The worker clamped every heartbeat cadence to at least one second | A legal subsecond lease could expire before its first upkeep call | Worker lease upkeep | A convenience floor silently overrode the claimed lease duration | Derive cadence from the exact lease milliseconds, with a subsecond fake-clock progress case and exact mutation (rungs 1 and 2) |
| 84 | Spawn read `opts.cancellation` and its fields repeatedly across validation, deadline construction, and JSON persistence | A changing getter could persist policy different from the value used to compute the cancellation deadline | Spawn durable-input boundary | User-owned option state was treated as a stable record rather than effects | Snapshot cancellation and each field once, canonicalize the validated milliseconds, and serialize that owned value (rung 1) |
| 85 | Claim changed durable state before decoding the selected task's retry policy and headers | A corrupt payload could acquire a lease and then make the client throw, stranding work behind a transition whose receipt could not be decoded | Claim mutation boundary | Payload admissibility was checked only on the post-CAS read path | The SQL `durableTaskRetryAdmissible` and `durableTaskHeadersAdmissible` predicates gate both ordered candidate legs and the receipt tail before mutation authority; decode then canonicalizes the admitted values (rung 1) |
| 86 | Activate latched `activated_gen` before decoding the task payload returned to the worker | Corrupt durable JSON could consume activation while returning no runnable payload | Activation mutation boundary | The generation CAS and payload decode were separately authoritative | The same split retry/header admissibility definitions gate the activation CAS and its stamped payload tail (rung 1) |
| 87 | Spawn's receipt query let a foreign-queue task-id collision outrank the same-queue idempotency winner | A successful idempotent spawn could return a task or run from another queue | Spawn receipt ownership | An `OR` plus ordering mixed globally unique task-id lookup with queue-scoped idempotency lookup | A closed two-leg receipt relation gives the inserted task priority only when it exists and otherwise selects the same-queue idempotency winner; its run subquery also composes queue ownership (rung 1) |
| 88 | `complete` could make a live task terminal while another live run still belonged to it | One sibling could terminalize the task underneath another active attempt | Terminal task/run cardinality | Sole-live ownership guarded launch doors, not the terminal CAS that changed the task book | A live owner may complete only through the canonical `soleLiveRun` relation; already-terminal owners may still be quiesced (rung 1) |
| 89 | `fail` could terminalize a live task while a lower live sibling remained | A user failure in one run could strand or invalidate a separately live attempt | Terminal task/run cardinality | Retry-accounting guards did not prove the failing run was the sole live authority | The live-task fail arm composes `soleLiveRun` before terminalization and successor bookkeeping (rung 1) |
| 90 | The sweep relaunch-cap arm could terminalize a live task while another live run remained | Infrastructure recovery could convert a corrupt multiple-live state into task-wide terminal failure | Sweep terminalization authority | Cap and generation predicates were treated as sufficient terminal authority | The relaunch-cap CAS recomposes sole-live ownership at the winning statement (rung 1) |
| 91 | Driver heartbeat wrote its beat and cleanup in two statements with independently evaluated database time | Clock movement could make cleanup disagree with the beat that supposedly authorized it | Driver observability transition | Passing through one client call was mistaken for one database instant | Migration v5 exposes a write-only ingress view whose `INSTEAD OF INSERT` trigger performs upsert and cleanup from one `NEW.last_beat_ms` in one statement (rung 1) |
| 92 | Claim joined a run to a task by `task_id` alone | A run whose immutable queue diverged from its task could be claimed through the wrong ownership relation | Claim ownership boundary | Existence was used as a proxy for full task/run ownership | One `runOwnedByTask` fragment requires both task id and queue at the claim candidate, receipt, and activation doors (rung 1) |
| 93 | Heartbeat checked task identity but not task/run queue agreement | A worker could extend a lease after its task crossed the immutable queue boundary | Heartbeat ownership boundary | Each direct door respelled only the relation fields it happened to need | `runOwnedByTask` is the sole ownership relation and gates the heartbeat CAS (rung 1) |
| 94 | `reschedule` could park a run whose task had the same id in another queue | A cross-queue corrupt relation could gain a new durable wake | Reschedule ownership boundary | Task liveness did not establish queue ownership | The shared ownership fragment gates the reschedule CAS (rung 1) |
| 95 | `suspendRun` could park and checkpoint across a task/run queue mismatch | One atomic batch could amplify cross-queue corruption into both scheduler and checkpoint state | Suspension ownership boundary | Full lease fencing did not also prove the stored run-to-task relation | The shared ownership fragment gates the suspension CAS before either follow-on can write (rung 1) |
| 96 | `setCheckpoint` could extend a lease and write through a run whose task queue diverged | Progress data could be attached through a corrupt cross-queue owner | Checkpoint ownership boundary | Caller queue/task/token equality did not prove the durable task row owned the run | The shared ownership fragment is part of the checkpoint lease CAS (rung 1) |
| 97 | `awaitEvent` could register and park after task/run queue divergence | A foreign task relation could acquire a durable wait and sleeping state | Await ownership boundary | Run arguments were checked, but the joined task relation was only by id | The event-registration existence proof joins through `runOwnedByTask` (rung 1) |
| 98 | `emitEvent` could wake a run whose task had moved to another queue | Event delivery could amplify a corrupt ownership edge into runnable work | Emit ownership boundary | Run and task liveness were checked independently of immutable queue agreement | The wake predicate joins through the shared task/run ownership fragment (rung 1) |
| 99 | `cancelTask` could terminalize a task while one of its runs carried a different queue | Cancellation could cross or strand the reverse side of a corrupt ownership relation | Cancellation ownership boundary | Forward run-to-task guards did not establish that every run named by the task remained in its queue | `taskOwnsEveryRun` refuses the task CAS unless every reverse-owned run agrees on queue (rung 1) |
| 100 | `FencedBatch`'s closed relation contract did not say which generated cross-table edges require queue equality | A generated follow-on could cross a queue boundary, while globally applying equality would strand corrupt waits that terminal cleanup must remove | Core relation primitive | Column pairing owned identity but not the distinct queue semantics of each relation direction | Each frozen relation declares `queueScoped`; task/run and wait/run ownership compose queue equality, while authoritative `runs`→`waits` cleanup deliberately follows `run_id` through a corrupt denormalized wait queue (rung 1) |
| 101 | A stored SQL NULL event payload was indistinguishable from the timeout sentinel | Emit/await could launder corrupt event storage into a legitimate timeout instead of failing closed | Event serialization boundary | Nullability was overloaded as both payload corruption and protocol branch state | Emit accepts and preserves only TEXT payloads; await returns a payload only after checking `typeof(payload) = 'text'`, and non-TEXT storage raises instead of timing out (rung 1) |
| 102 | Reserved `mutation-verdict:` markers were not checked in the reverse direction against the live registry | Historical or copied marker text could advertise exact ownership without any executable mutation | Mutation source inventory | The registry proved mutation-to-marker mapping but not marker-to-mutation ownership | A reverse inventory requires each reserved marker to have at least one live mutation owner or explicit machinery exemption, and every mutation sharing a marker must declare the same semantic verdict; non-owned regressions use the separate `regression:` namespace (rung 2) |
| 103 | The first relation-mutation surface attacked required queue scoping only by deleting it globally | The surface could stay green if authoritative `runs`→`waits` cleanup were incorrectly changed from unscoped to scoped | Relation-policy mutation surface | One example per mechanism was again treated as coverage of both policy values | Add a distinct false-to-true mutation and semantic construction verdict for authoritative cleanup (rung 2); this repair-review finding has no standalone red commit |
| 104 | The first ownership repair set `runs`→`waits` cleanup to queue-scoped | Terminal and cancellation cleanup could strand a corrupt wait whose authoritative run id was already known | Generated cleanup relation | “Every cross-table edge is queue-scoped” overgeneralized the forward ownership property to a denormalized cleanup witness | The explicit relation ledger marks this direction unscoped, and the full libSQL poison matrix proves cleanup follows the authoritative run id (rung 1); the failing repair state is the red evidence |
| 105 | The first spawn-receipt repair still admitted a task-id collision from another queue when no same-queue idempotency winner existed | A losing spawn could return a foreign task and run instead of rejecting the unexplained loss | Spawn receipt ownership | Only the idempotency leg was queue-scoped; the task-id leg remained global | Queue-scope the task-id leg and give it an independent exact mutation (rungs 1 and 2) |
| 106 | Live mutations edited frozen migration DDL directly | A mutant could die at the migration hash/frozen-history guard instead of exercising current behavior | Mutation target policy | Mutation enrollment did not distinguish current source from append-only migration history | Reject frozen migration targets and express both driver-cleanup attacks through a current source-proven seam (rung 2) |
| 107 | Spawn resolved ambient `JSON.stringify` after hostile retry getters ran | A validated retry policy could be persisted as a forged policy | Retry serialization boundary | Retry normalization owned the value but not the serializer subsequently invoked | Serialize through the core module-captured task-value codec (rung 1) |
| 108 | Canonical cancellation construction assigned into an ordinary `{}` | An inherited setter could discard a validated cancellation field while deadline arithmetic used it | Cancellation snapshot construction | “Fresh object” was treated as “owned data properties” | Construct both fields as own data properties in one object literal, then serialize the owned snapshot (rung 1) |
| 109 | Spawn resolved ambient `JSON.stringify` after the cancellation getter ran | Durable cancellation JSON could disagree with the validated deadline inputs | Cancellation serialization boundary | One-read input ownership stopped before serialization | Use the captured task-value serializer for the canonical cancellation value (rung 1) |
| 110 | Spawn resolved ambient `JSON.stringify` after the headers getter ran | A task could persist forged worker headers | Header serialization boundary | The header reference was snapshotted, but the serializer remained ambient | Use the captured task-value serializer for headers (rung 1) |
| 111 | Claimed retry decoding used ambient `JSON.parse` | A poisoned parser could replace an admitted durable retry strategy before worker launch | Retry decode boundary | SQL admission authenticated the stored bytes, not the ambient parser consuming them | Decode through the core module-captured parser (rung 1) |
| 112 | Claimed header decoding independently used ambient `JSON.parse` | A poisoned parser could forge the headers exposed to a worker | Header decode boundary | The second parser call site remained independently writable | Route it through the same captured parser, with its own exact mutation (rungs 1 and 2) |
| 113 | Claim candidate header admissibility had no independent mutation owner | The header predicate could disappear while the combined retry-payload proof still appeared enrolled | Claim candidate mutation surface | One combined payload mutation stood in for two independently writable fields | Split retry/header definitions and add a candidate-header mutation and verdict (rung 2) |
| 114 | Same-token receipt retry admissibility had no door-specific mutation owner | A receipt could decode corrupt retry JSON while candidate coverage stayed green | Claim receipt mutation surface | Candidate and receipt calls were treated as one claim property | Add an exact receipt-retry mutation and isolated receipt fixture (rung 2) |
| 115 | Same-token receipt header admissibility had no door-specific mutation owner | A receipt could expose corrupt headers while the other claim doors remained protected | Claim receipt mutation surface | Neither the receipt site nor header condition had independent ownership | Add an exact receipt-header mutation and fixture (rung 2) |
| 116 | Activate header admissibility had no independent mutation owner | Activation could latch before exposing corrupt headers while retry coverage stayed green | Activation mutation surface | One combined payload mutation represented both fields | Add an activate-header mutation; keep payload admission solely at the atomic CAS rather than duplicating it in the stamped tail (rung 2) |
| 117 | `runs-to-tasks.queueScoped` lacked an entry-local mutation | Its policy literal could flip while the global generator mutation still claimed relation coverage | Relation-policy mutation surface | Generator behavior was treated as ownership of every independently writable ledger entry | Add a compiler-owned exact true-to-false mutation for this literal (rung 2) |
| 118 | `tasks-to-runs.queueScoped` independently lacked an entry-local mutation | Generated task-to-run writes could lose queue ownership without a site-owned verdict | Relation-policy mutation surface | Another true-valued relation stood in for this entry | Add its own compiler-owned true-to-false mutation (rung 2) |
| 119 | `waits-to-runs.queueScoped` independently lacked an entry-local mutation | A wait-to-run follow-on could cross queues without invalidating another relation’s proof | Relation-policy mutation surface | The relation ledger was closed structurally but its true entries were not individually attacked | Add its own compiler-owned true-to-false mutation (rung 2) |
| 120 | The cancel queue-ownership mutation was attributed to a narrow regression instead of its generated corruption-class failure | A real guard kill could become collateral/wrong-path rather than exact evidence of invariant amplification | Cancellation mutation attribution | The first observable direct snapshot was used instead of the generated poison-matrix class owner | Attribute the exact ownership-mismatch poison failure; retain the direct case as an ordinary regression (rung 2) |
| 121 | `expireLeaseNow`’s future-expiry condition had no exact mutation owner | The advisory write could stop meaning “shorten” and rewrite an already-expired lease unnoticed by the mutation inventory | Advisory-lease mutation surface | The composite unexpired fragment’s upper-bound attack was mistaken for ownership of every constituent | Add an exact deletion of only `expiry > database-now` (rung 2) |
| 122 | `expireLeaseNow`’s integer-storage premise independently lacked an exact owner | A fractional stored expiry could be laundered into an integer instant | Advisory-lease mutation surface | Range coverage did not prove representation coverage | Add a fractional-storage fixture and exact integer-premise mutation (rung 2) |
| 123 | `expireLeaseNow`’s task/run queue-ownership premise lacked an exact owner | The ownership breadth surface could regress at this advisory door while all enrolled direct transitions stayed green | Advisory ownership mutation surface | The already-correct relation was hand-spelled and omitted from the new per-door inventory | Compose `runOwnedByTask` and add the exact queue-removal mutation (rungs 1 and 2) |
| 124 | Vitest and typecheck mutation suites had no production wall-time bound | A hung verifier could stall the complete audit indefinitely | Mutation verifier process boundary | Aggregate confinement was mistaken for a per-suite lifetime bound | One shared production deadline, authenticated child probes, and whole-process-group termination (rung 2) |
| 125 | UPDATE and INSERT follow-ons had separate owners for the same complete-provenance requirement | One omission callback could answer for another provenance mutation | `FencedBatch` follow-on construction | Repeated examples stood in for one guard | Aggregate every incomplete-provenance shape under one exact marker (rung 2) |
| 126 | The missing-positive-fence mutation was owned by only one non-authoritative spelling | Another fence rejection could kill the mutation first | Positive-fence construction guard | One example represented several parser branches | Give absence of any positive fence its exact aggregate observation and mutation (rung 2) |
| 127 | The negated `IS NOT` fence mutation shared the general positive-fence callback | A distinct polarity bug could receive collateral credit | Positive-fence polarity parser | Similar rejection text obscured an independently writable branch | Retain a condition-local mutation while aggregating its exact non-authoritative spelling (rung 2) |
| 128 | `$NOW$` token rejection shared one broad clock mutation with raw clock text | Raw-clock rejection could answer for token substitution | Follow-on clock guard | One Boolean replacement deleted two conditions | Mutate only token detection and give it an exact owner (rung 2) |
| 129 | Raw dialect-clock rejection lacked an independent mutation owner | Token rejection could conceal acceptance of the dialect expression | Follow-on clock guard | The raw and token arms were treated as one property | Add a raw-clock-only mutation and exact aggregate observation (rung 2) |
| 130 | Generated provenance-column rejection shared the ordinary allowed-column guard | A forbidden-column failure could answer for provenance competition | Generated UPDATE assignment construction | Two semantic classes passed through one conditional | Give provenance columns their own mutation and construction owner (rung 2) |
| 131 | Ordinary forbidden generated columns lacked a condition-local owner | Provenance rejection could falsely certify the public assignment allowlist | Generated UPDATE assignment construction | The guard mutation deleted both rejection classes | Add an independent forbidden-column mutation and exact owner (rung 2) |
| 132 | The generated UPDATE target mutant replaced the target with `null` | Construction failed before the claimed fence-source behavior executed | Generated UPDATE target contract | A runtime-invalid replacement attacked type shape and behavior together | Make non-null target retention compiler-owned and mutate the type boundary (rungs 1 and 2) |
| 133 | The deadline self-test passed a hidden short timeout instead of exercising production defaults | Production Vitest or typecheck dispatch could remain unbounded while the test passed | Mutation verifier deadline enrollment | A test seam was mistaken for production wiring | Inspect and exercise the shared production default through both real dispatchers (rung 2) |
| 134 | An immediate matching infrastructure error could impersonate a real verifier timeout | The timeout self-test could pass without launching or reaping a verifier | Mutation verifier self-test attribution | Error text was accepted without process evidence | Authenticate verifier-created process identities and reject the magic-error false negative (rung 2) |
| 135 | Vitest timeout handling followed only the verifier leader | A timed-out Vitest descendant could survive the worker | Vitest verifier lifetime | Leader exit was mistaken for group completion | Start a separate session and prove the complete Vitest process group is gone (rung 2) |
| 136 | Typecheck timeout handling followed only the verifier leader | A timed-out compiler descendant could survive the worker | Typecheck verifier lifetime | Typecheck did not share the complete process-group contract | Route it through the same bounded group runner and authenticated probe (rung 2) |
| 137 | A verifier leader could exit successfully while leaving descendants | The audit could accept a suite whose work was still running | Verifier completion classification | Process return code represented the group | Treat a live group after leader exit as infrastructure failure (rung 2) |
| 138 | Lingering verifier descendants were detected without guaranteed reaping | A rejected suite could still leak work into later mutations | Verifier cleanup | Detection and cleanup were separately writable | Reap the authenticated group before returning the infrastructure failure (rung 2) |
| 139 | External SIGTERM could be converted into an ordinary verifier result | The coordinator could misclassify an interrupted audit | Worker signal propagation | Cleanup obscured the initiating signal | Defer the signal through cleanup and restore its exact audit status afterward (rung 2) |
| 140 | External interruption could leave the nested verifier group alive | An interrupted worker could orphan mutation or compiler processes | Worker interruption cleanup | Worker termination did not own its independently sessioned child group | Shield cleanup, terminate the group, and verify both leader and descendant exit (rung 2) |
| 141 | Verifier TERM grace had no finite production bound | A TERM-ignoring child could block cleanup indefinitely | Verifier process reaping | Cleanup used an implicit wait rather than a declared deadline | One finite TERM grace is exercised by an ignoring descendant (rung 2) |
| 142 | Verifier KILL grace had no finite production bound | Cleanup could still hang after escalation | Verifier process reaping | Escalation did not carry its own bounded wait | Add and exercise a separate finite KILL-reap grace (rung 2) |
| 143 | Retry replay after the successor was claimed had a standalone owner | A neighboring replay callback could answer for successor ownership | Failure-replay conformance | Pre-claim and post-claim observations were split | Aggregate both replay phases and full durable progress under one marker (rung 2) |
| 144 | Immediate retry-failure replay had a separate provenance-progress owner | Successor behavior could kill the provenance mutation first | Failure-replay conformance | One transition was observed through two competing callbacks | Put rejection, task/run progress, and invariants in the shared replay owner (rung 2) |
| 145 | Self, historical-fail, and historical-sweep successor collisions declared redundant owners | Several mutations attacked the same task-and-attempt identity condition | Successor identity mutation surface | Scenario names were treated as independent source properties | Retain one condition-local mutation and aggregate all collision/control outcomes (rung 2) |
| 146 | Compiler bind arity-brand recognition had an isolated callback | Another bind producer or matcher could answer for the private brand | Testing-helper compiler-failure boundary | Producer observations were fragmented | Aggregate every authenticated producer observation under one construction marker (rung 2) |
| 147 | The private-brand read mutation shared nearby compiler-failure behavior | Constructor or matcher failure could certify the brand read | Testing-helper compiler-failure boundary | Brand existence and its consumer behavior were separately asserted | Make the brand read an explicit field of the aggregate owner (rung 2) |
| 148 | Compiler bind-count factory ownership was isolated from the resulting brand | A different producer could answer for factory correctness | Branded compiler-error construction | Factory and recognizer were separate proof paths | Observe factory output and recognition in the same exact aggregate (rung 2) |
| 149 | Explicit-undefined bind propagation had its own helper callback | A broad matcher could classify the compiler failure for the wrong reason | Testing-helper failure propagation | One producer shape was treated as a separate property | Include undefined-bind propagation with all authenticated producer controls (rung 2) |
| 150 | Captured compiler-error construction had a standalone owner | Ambient constructor poisoning could fail beside rather than at brand authentication | Branded compiler-error construction | Constructor capture and brand recognition were independently decisive | Aggregate captured-constructor identity and poisoned-constructor brand recognition (rung 2) |
| 151 | Three promise helpers separately tested propagation of the same branded compiler error | Any one helper callback could answer for another matcher mutation | Testing-helper consumer boundary | Identical guards were enrolled per helper | One matcher-propagation mutation and aggregate cover attribute, require, and replacement helpers (rung 2) |
| 152 | `generated-selection-fence` weakened every generated transition | An unrelated generated consumer could kill the selected mutation | Generated selection mutation surface | The shared builder had no selected batch identity | Inject the defect only for the selected stable batch label (rungs 2 and 3) |
| 153 | The generated narrowing-widen mutant also changed parentheses and NULL semantics | Progress or unrelated-row assertions could answer for widening | Generated narrowing mutation surface | A broad replacement crossed several Boolean properties | Change only widening semantics and own selected plus untouched rows together (rungs 2 and 3) |
| 154 | Generated narrowing-drop progress shared a callback with widening | Deleting every match could be credited to the neighboring widening owner | Generated narrowing mutation surface | Opposite failure modes reused one observation | Give total match loss its own exact callback and marker (rung 2) |
| 155 | Generated UPDATE provenance mutation changed every generated UPDATE | Another transition could answer for stale provenance | Generated UPDATE mutation surface | The shared builder lacked a selected mutation address | Scope provenance corruption to one stable batch label and observe stamp and instant (rungs 2 and 3) |
| 156 | A repeated coordinator signal could interrupt verifier reaping | The second signal could orphan an already-terminating grandchild | Verifier cleanup signal handling | Cleanup handled only the first interrupt | Shield repeated signals until group reaping completes, then propagate one deferred signal (rung 2) |
| 157 | `emit-cleanup-follows-the-wake` remained enrolled after its mutation ceased to represent an independent property | A dead or redundant entry could inflate the mutation inventory | Emit cleanup mutation surface | Historical intent outlived the live source shape | Remove the dead mutation and keep cleanup behavior as an ordinary regression (rung 2) |
| 158 | Event-correlation wake mutation was owned by one hand-built replay example | Another wake discriminant could answer for it | Generated wake-witness surface | A direct example stood in for the generated class | Route event correlation through the generated witness matrix with an exact marker (rung 2) |
| 159 | Step-correlation wake mutation was owned by one hand-built replay example | Event or legacy cardinality behavior could kill it first | Generated wake-witness surface | The single-row decisive case was not isolated in the matrix | Put the step-only corruption in its exact generated owner (rung 2) |
| 160 | Legacy ambiguous-step cardinality lived outside the generated wake surface | Modern correlation behavior could answer for legacy scalar selection | Legacy wake recovery | Legacy ambiguity was represented by a separate test | Add the legacy two-row ambiguity as a generated pair dimension (rung 2) |
| 161 | Highest-owned-ordinal claim mutation edited the shared fragment broadly | A non-claim consumer could answer for the claim property | Claim eligibility mutation surface | Helper text, not its live consumer, was the mutation address | Mutate the exact claim composition site and retain other fragment consumers (rungs 2 and 3) |
| 162 | Checkpoint owner-attempt mutation reconstructed helper output text | A refactor could make the mutation stale or affect the wrong occurrence | Checkpoint read relation | Rendered SQL duplicated the helper’s authority | Mutate the live helper call and replace only its attempt conjunct (rungs 1 and 2) |
| 163 | Generated provenance mutation still searched the pre-hoist regex expression | The mutation could fail enrollment without testing provenance rejection | Generated assignment mutation construction | Source spelling changed while the registry retained a copy | Target the authoritative `isProvenanceColumn` branch (rung 2) |
| 164 | Generated forbidden-column mutation still searched the pre-hoist allowlist expression | The intended guard could become unmutated | Generated assignment mutation construction | The replacement ignored the newly composed provenance premise | Match the complete live forbidden-column condition (rung 2) |
| 165 | Generated UPDATE target verdict named the core test after its compiler owner moved | A real compiler kill was classified wrong-path | Typecheck mutation ownership | Full test identity was copied across files | Bind the verdict to the libSQL relation-types compiler owner (rung 2) |
| 166 | Generated narrow-drop verdict retained its old widening title | Its direct callback could never receive exact credit | Mutation registry identity | The test title remained a second representation | Update the exact live full title while preserving its marker and owner file (rung 2) |
| 167 | The zero-base retry fixture retained a nonzero exponential cap | The cap boundary could answer for the zero-base mutation | Worker retry fixture | Selected input varied more than one retry dimension | Set both base and cap to zero so only zero-base behavior decides (rung 3) |
| 168 | Interrupted mutation progress lived inside the disposable worker root | Cleanup erased hours of completed exact-audit evidence | Mutation audit checkpointing | Run-root ownership was conflated with durable progress ownership | Store authenticated atomic prefixes under the Git common directory and resume only an exact prefix (rung 2) |
| 169 | SDK retry classification and core normalization shared the captured `Reflect.get` mutation | A downstream SDK callback could answer for the core capability | Retry intrinsic containment | One captured intrinsic had competing owners | Give the one captured capability a construction aggregate and remove the downstream owner (rung 2) |
| 170 | Negative-zero `maxSeconds` shared the base-duration mutation | Base canonicalization could conceal a noncanonical cap | Retry normalization | One shared conversion mutation represented two fields | Add a max-only mutation and exact serialized control (rung 2) |
| 171 | Negative-zero retry factor had no independent canonicalization owner | Duration normalization could hide a noncanonical factor | Retry normalization | Factor and duration zero handling were treated as one property | Add a factor-only mutation and exact canonical-zero owner (rung 2) |
| 172 | Decision-API invalid-strategy verdict named hostile-object behavior | The correct invalid-input kill was classified wrong-path | Retry decision boundary | Test prose drifted from the live selected inputs | Aggregate invalid strategies under the exact decision-API title and marker (rung 2) |
| 173 | Delay-API invalid-strategy verdict named hostile-object behavior | The delay boundary could not receive causal credit | Retry delay boundary | Registry identity copied an obsolete scenario description | Bind the mutation to the exact invalid-strategy callback (rung 2) |
| 174 | A worker interrupted after its final row could leave a complete prefix marked incomplete | Resume reran the final mutation or failed to publish success | Mutation checkpoint finalization | Row persistence and completion publication were separate operations | Atomically publish the completed final checkpoint without re-execution (rung 2) |
| 175 | Mutation workers did not inherit the coordinator’s audit lock | A new audit could start while an orphan worker still mutated its worktree | Audit ownership | Coordinator lifetime was mistaken for audit lifetime | Pass and authenticate the lock descriptor in every worker (rung 2) |
| 176 | Verifier children did not retain the worker’s inherited audit lock | Killing a worker could release ownership while its verifier remained live | Audit ownership | Lock inheritance stopped at the worker boundary | Pass the authenticated descriptor through Vitest and typecheck children (rung 2) |
| 177 | Verifier-lock options were validated after self-test dispatch | Invalid or ignored options could silently bypass the intended proof | Mutation-probe CLI routing | Mode-specific early returns preceded option validation | Validate every mode’s option contract before dispatch (rung 2) |
| 178 | Raw-function rejection was owned only at one task-value surface | Nested functions or hostile `toJSON` could be accepted while the mutation still appeared covered | Task-value admissibility | One example stood in for every recursive surface | Aggregate top-level, object, array, and prototype-disguise observations under one marker (rung 2) |
| 179 | Owned Date snapshot behavior competed with Date conversion ownership | A conversion mutation could fail on snapshot identity first | Task-value Date handling | Snapshot and conversion were adjacent assertions | Give owned snapshot isolation its own decisive aggregate field (rung 2) |
| 180 | Captured `Date.prototype.toISOString` had a separate competing callback | Snapshot behavior could answer for conversion capture | Task-value Date handling | One Date path carried two independently mutable capabilities | Observe captured conversion separately within the same exact aggregate (rung 2) |
| 181 | Captured JSON parse ownership was fragmented across retry, headers, params, and replay | Any consumer could answer for another parse mutation | Task-value parse boundary | Call sites were treated as separate capabilities | Aggregate every current parse consumer under the one captured parser owner (rung 2) |
| 182 | Captured JSON stringify ownership was fragmented across spawn, context, sleep, and result paths | Any serializer callback could kill an unrelated stringify mutation | Task-value serialization boundary | One capability had many competing owners | Aggregate every current stringify consumer under one exact captured capability (rung 2) |
| 183 | Final-result serialization had no selected owner inside the broad stringify aggregate | Another task serialization path could answer for result corruption | Worker completion serialization | Capability ownership did not isolate the final-result consumer | Add a final-result selected/control observation and exact marker (rungs 2 and 3) |
| 184 | Spawn retry serialization competed with the task-boundary aggregate | A different permanent-failure path could answer for retry persistence | Worker task boundary | One serializer call retained a narrow downstream owner | Move retry serialization observation into the complete boundary aggregate (rung 2) |
| 185 | Spawn cancellation serialization competed with the task-boundary aggregate | Header or failure behavior could answer for cancellation JSON | Worker task boundary | Serializer call sites remained separately decisive | Include canonical cancellation persistence in the one boundary owner (rung 2) |
| 186 | Spawn header serialization competed with the task-boundary aggregate | Another serialized field could kill the header mutation first | Worker task boundary | Header persistence retained its prior isolated callback | Include header persistence in the exact boundary aggregate (rung 2) |
| 187 | Fatal authentication and fatal-flag mutations had separate core owners | Worker permanent-failure behavior could answer before construction identity | Fatal task policy | Construction and executed policy were two proof paths | Aggregate authentic snapshot, frozen state, and permanent worker result (rung 2) |
| 188 | The core captured-stringify mutation was still owned below worker execution | SDK serialization consumers could produce the first failure | Task-boundary serialization | A shared intrinsic was attributed at a narrower layer | Make the executed worker boundary the sole owner of its current consumers (rung 2) |
| 189 | The SDK final-result stringify owner recurred after its first isolation | The new aggregate repair reintroduced competing task-boundary failures | Worker completion serialization | The first repair isolated only the previous topology | Fold final result into the authoritative boundary observation and retain its controls (rungs 2 and 3) |
| 190 | SDK context and sleep-marker stringify retained a competing owner | Another task failure could answer for durable context serialization | Worker context serialization | Context serialization was proved separately from its executed boundary | Include context and sleep-marker persistence in the task-boundary aggregate (rung 2) |
| 191 | Raw handler-throw snapshotting retained a standalone callback | Fatal or serialization paths could answer for the throwable mutation | Worker throwable boundary | Snapshot and policy execution were separately decisive | Aggregate raw throw capture with every permanent task outcome (rung 2) |
| 192 | Event, step, legacy, and combined wake mutations had fragmented generated callbacks | One wake discriminant could answer for another | Generated wake-witness surface | Single-row and pair matrices had competing owners | Use one correlated-witness aggregate across all declared cases (rung 2) |
| 193 | The first wake aggregation generated one exact case twice | Duplicate coverage could mask omission and distort ownership cardinality | Wake-witness case generation | Two subset generators overlapped | Partition single-row, pair, and legacy cases and assert exact uniqueness (rungs 1 and 2) |
| 194 | Highest-owned-ordinal mutation was answerable by either claim lifecycle profile | A generic profile callback could receive causal credit | Poison claim matrix | One property was repeated per profile | Aggregate both claim profiles under one exact marker and skip generic callbacks (rung 2) |
| 195 | Checkpoint-read mutation searched a `WHERE` occurrence after the live source used `ON` | The intended guard was no longer mutated | Checkpoint mutation construction | Registry text duplicated a refactored SQL shape | Retarget the exact live source occurrence (rung 2) |
| 196 | Preserved event instant was mutated at the replay/store level | Construction failed before replay semantics reached their owner | Event provenance | The mutation sat below the primitive that owns preserved time | Move the mutation and exact verdict to the event-upsert `FencedBatch` primitive (rungs 1 and 2) |
| 197 | Sole-live claim mutation replaced the entire predicate with `1=1` | Query-plan and correlated-probe failures could answer for sole-live ownership | Claim eligibility mutation construction | One broad replacement crossed semantic and plan boundaries | Contradict only the selected sibling condition while preserving plan shape (rungs 2 and 3) |
| 198 | Invalid activation inputs, zero SQL calls, and deadline preservation were separately decisive | An adjacent validation or deadline failure could answer for the target mutation | Activation input boundary | One callback did not own every consequence of rejection | Aggregate all invalid inputs, executor count, and unchanged cancellation deadline (rung 2) |
| 199 | Exhausted-budget ownership was fragmented across claim, receipt, lost-launch, and timeout paths | One lifecycle callback could answer for another budget guard | Counter poison matrix | The same relational witness was repeated per profile | Aggregate every claim and sweep profile under one exact marker (rung 2) |
| 200 | Checkpoint run-attempt validation used repeated per-value failure helpers | One invalid value could answer for another mutation | Checkpoint input boundary | Sequential callbacks shared the same marker and SQL guard | Aggregate every invalid input with zero executor calls (rung 2) |
| 201 | Checkpoint BigInt rejection was also owned by the generic bounded-integer test | The intended checkpoint mutation failed at a neighboring callback | Checkpoint input attribution | A cross-layer generic owner competed with the API owner | Isolate BigInt at the checkpoint boundary and keep the generic test nondecisive (rung 2) |
| 202 | Omitting `tasks.attempts` from the persisted-counter inventory was not compile-visible | Generated poison coverage could silently omit the field | Persisted integer descriptor inventory | Runtime enumeration was the only completeness proof | Require the field in a closed keyed descriptor and add an omission mutation (rungs 1 and 2) |
| 203 | Omitting `tasks.max_attempts` from the inventory was not compile-visible | Max-attempt corruption could disappear from generated coverage | Persisted integer descriptor inventory | Runtime enumeration admitted silent omission | Require the keyed descriptor and compiler-owned deletion attack (rungs 1 and 2) |
| 204 | Omitting `tasks.infra_retries` from the inventory was not compile-visible | Infrastructure-budget corruption could lose coverage | Persisted integer descriptor inventory | The field list was independently maintained at runtime | Require it in the closed record and mutate its entry (rungs 1 and 2) |
| 205 | Omitting `runs.attempt` from the inventory was not compile-visible | Run ordinal corruption could escape the poison surface | Persisted integer descriptor inventory | No type forced the field’s enrollment | Add the required keyed descriptor and omission mutation (rungs 1 and 2) |
| 206 | Omitting `runs.claim_gen` from the inventory was not compile-visible | Claim-generation corruption could become untested | Persisted integer descriptor inventory | Runtime cases were treated as exhaustive | Require the field structurally and attack its exact entry (rungs 1 and 2) |
| 207 | Omitting `runs.activated_gen` from the inventory was not compile-visible | Activation-generation corruption could disappear from coverage | Persisted integer descriptor inventory | The generated layer had no closed source inventory | Add the required keyed entry and compiler mutation (rungs 1 and 2) |
| 208 | Omitting `runs.relaunch_count` from the inventory was not compile-visible | Relaunch accounting corruption could lose its oracle | Persisted integer descriptor inventory | Runtime enumeration could shrink silently | Require the keyed descriptor and exact omission attack (rungs 1 and 2) |
| 209 | Omitting `checkpoints.owner_attempt` from the inventory was not compile-visible | Checkpoint ownership corruption could be untested | Persisted integer descriptor inventory | The checkpoint field was outside a closed type-level inventory | Require its keyed descriptor and compiler-owned deletion mutation (rungs 1 and 2) |
| 210 | Poison lifecycle-profile seeds were owned only by a runtime aggregate | A profile seed could change or disappear behind another generated case | Poison profile construction | Generated execution was mistaken for exact seed membership | Use one frozen required-profile record with compiler-owned entry mutations (rungs 1 and 2) |
| 211 | Verifier kind and `typecheck_project` were competing routing authorities | A project could be skipped, misrouted, duplicated, reordered, or omitted from the digest | Mutation verifier routing | Two representations independently selected execution | Make `typecheck_project` the sole authority and execute generated routing faults (rungs 1 and 2) |
| 212 | Terminal-owner scan and CAS mutations had competing callbacks | One terminal guard could answer for the other | Sweep terminal-timeout surface | Scan and write observations were independently decisive | Aggregate normal terminal discovery and quiescence under one exact marker (rung 2) |
| 213 | Corrupt-relaunch scan and decode mutations had competing callbacks | Unrelated corruption could answer for the wrong terminal condition | Sweep terminal-timeout surface | Corrupt discovery and decode were separately owned | Aggregate unchanged terminal behavior across both corrupt-relaunch paths (rung 2) |
| 214 | One runtime inventory represented every counter field and upper/lower targetability vector | A vector could be omitted or misclassified while the aggregate stayed green | Poison targetability construction | Runtime enumeration was a proxy for exact membership | Require a closed field-by-bound record and compiler-owned vector mutations (rungs 1 and 2) |
| 215 | Sweep target eligibility was observed only after the scan limit | Downstream exhausted-budget behavior could answer for pre-limit filtering | Sweep poison surface | The fixture did not distinguish selection order | Aggregate every target behind pre-limit eligibility before generic profile callbacks (rungs 2 and 3) |
| 216 | Lower-bound poison severity was split across persisted fields | Another field’s severity change could answer for the mutation | Poison severity oracle | Parameterized cases shared decisive assertions | Aggregate exact lower-bound severity across every field (rung 2) |
| 217 | Checkpoint poison severity had a competing composite callback | Another severity component could kill the mutation first | Poison severity oracle | Composite state carried multiple decisive deltas | Give checkpoint severity its exact aggregate observation (rung 2) |
| 218 | Relational and fractional poison target membership relied on a runtime inventory marker | Required targets could disappear while execution remained green | Poison target construction | Derived runtime enrollment was treated as authority | Use a frozen required-witness record with compiler-owned entry mutations (rungs 1 and 2) |
| 219 | Poison-owned closure rewrites shared a broad comparison callback | One targeted rewrite could answer for another | Poison closure oracle | One example represented every declared closure target | Aggregate exact observations for every required rewrite (rung 2) |
| 220 | Relational target enrollment and execution claimed the same marker | A derived projection could impersonate exact membership ownership | Poison target inventory | Construction authority and runtime use were conflated | Let the compiler-owned record prove membership and runtime prove only its derived projection (rungs 1 and 2) |
| 221 | Claim relaunch upper and lower bounds were split across pending and sleeping callbacks | Either profile could answer for the other bound mutation | Claim relaunch poison surface | Bounds and profiles were repeated independently | Aggregate both bounds across both claim profiles under one exact owner (rung 2) |
| 222 | Accounting/live-run-not-next ownership was fragmented across labels and lifecycle profiles | Any generated cell could answer for the invariant mutation | Poison and invariant surface | Generic matrix callbacks stood in for the relational class | Centralize the required witness and aggregate every ambient label/profile (rungs 1 and 2) |
| 223 | Run ordinal limits had several independently writable constants | Consumers could drift while current equal values hid the divergence | Persisted run-ordinal domain | A named constant was copied instead of field-keyed | Derive every consumer from `PERSISTED_INTEGER_BOUNDS.runs.attempt` (rung 1) |
| 224 | Maximum-ordinal sweep mutation was attributed to a downstream sweep callback | Another terminal condition could answer for numeric-domain acceptance | Run-ordinal mutation ownership | Behavioral use was mistaken for ownership of the decoder bound | Move the verdict to the canonical bounded-integer domain owner (rung 2) |
| 225 | Checkpoint owner-attempt tests reused the run-attempt bound | Equal current maxima concealed future field-domain drift | Checkpoint numeric domain | Related fields were treated as interchangeable | Reference `PERSISTED_INTEGER_BOUNDS.checkpoints.owner_attempt` explicitly (rung 1) |
| 226 | Attempt-cap fault-matrix ownership was repeated per generated cell | One label, fault, or seed could answer for another | Generated fault-matrix edge surface | Cell volume was mistaken for edge ownership | Aggregate the attempt-cap edge across every generated cell and seed (rung 2) |
| 227 | Infrastructure-cap edge ownership was split between progress and generation mutations | Either mutation could be credited by the other callback | Generated fault-matrix edge surface | Two source conditions shared per-cell verdicts | Aggregate the infra-cap edge and its generation control across the complete matrix (rung 2) |
| 228 | Relaunch-cap edge ownership was split between progress and generation mutations | Lost-launch behavior could answer for the wrong relaunch condition | Generated fault-matrix edge surface | Per-cell callbacks obscured the shared edge | Aggregate the relaunch-cap edge across all labels, faults, states, and seeds (rung 2) |
| 229 | Shared conformance membership and actual runner dispatch were separately writable | A suite could remain advertised while a dialect silently skipped it | Shared conformance registry | Exported IDs and source-loop text were proxies for executable enrollment | Return one frozen callable registry and observe every registered call through the umbrella runner (rungs 1 and 2) |
| 230 | The shared-conformance test parsed registry source and generic loop text; membership and actual dispatch remained separately writable | A surface could remain advertised while a dialect silently skipped executing it | Conformance registry execution | Exported IDs and source text were proxies for calling each registered runner | Return one frozen callable with its frozen inventory, observe every call with the same fixture, and mutate current enrollment and dispatch arms (rungs 1 and 2) |
| 231 | One global `storedInteger` mutation and one claim meta-test stood for task `max_attempts` and run `relaunch_count` at claim and sweep sites | The mutant died across unrelated consumers, so no field/door owned the rejection | Fractional poison ownership | A helper-wide mutation crossed independent fields, doors, and generated cases | Localize four claim/sweep × field mutations and aggregate each door’s ambient and targeted observations under its exact owner (rungs 2 and 3) |
| 232 | The token mutation rewrote the counter expression instead of attacking strict increase; there was no proposal seam or monotonic guard | Duplicate provenance tokens were tested only through a broad collateral implementation mutation | Token source monotonicity | One spelling of `++tokens` stood in for the property | Inject token-serial proposals, validate before assignment, and pair a duplicate rejection with successful retry control (rungs 1 through 3) |
| 233 | Injectable token proposals initially admitted `NaN`, infinity, fractional, and unsafe serials | Invalid serials could poison generator state while the new monotonic mechanism overclaimed its domain | Token serial domain | Strict increase does not imply a representable integer | Require a safe integer before committing the proposal; exercise four hostile values plus unchanged-state retry and a condition-local mutation (rungs 1 through 3) |
| 234 | The schema-absence mutant replaced typed-error checking with substring classification and simultaneously removed the legitimate fresh-database arm | A kill could come from breaking typed absence rather than accepting deceptive outage text | Schema absence classification | Selected and control behavior were not owned together | Add the deceptive substring arm alongside the typed arm and aggregate typed absence resolving to zero with deceptive text preserving its outage (rungs 2 and 3) |
| 235 | One `return 0` mutant and loop verdict represented missing/extra results and missing/extra rows | The first malformed shape could answer for four independently writable cardinality branches | Schema-version result shape | One example and marker stood in for four premises | Give missing result, extra results, missing row, and extra rows separate cases, markers, mutations, and exact verdicts (rung 2) |
| 236 | Cancellation queue ownership had a competing direct regression while the poison-class owner omitted the call result and unchanged closure | Invariant failure could receive credit without proving refusal and atomic non-change | Generated cancellation poison surface | The class oracle returned too little evidence and a second test competed for ownership | Return the result and closure state from the poison execution, require `false` plus unchanged state and invariant delta, and remove the duplicate owner (rungs 2 and 3) |
| 237 | Every exact-ceiling timestamp mutant subtracted one from all legal results | A predecessor or unrelated timestamp could answer for exact-boundary acceptance | Generated timestamp arithmetic surface | The mutation changed a broad expression while the test observed only the ceiling | Cap only the exact result with `MIN(expression, max-1)` and aggregate the exact result with its predecessor for every generated case (rungs 2 and 3) |
| 238 | The driver-cleanup mutant also weakened timestamp overflow, allowing the source heartbeat itself to change | A source write or arithmetic failure could answer for atomic cleanup | Driver-heartbeat overflow surface | Two independent conditions changed in one mutant | Preserve arithmetic validation, mutate only cleanup source existence, and compare complete source/victim rows before and after overflow (rungs 2 and 3) |
| 239 | Timestamp placeholder duplication was attributed to a fragment test although `FencedBatch` compilation could kill it first; unused arguments had no direct owner | Compiler collateral could certify a fragment property and one bind-count direction was absent | FencedBatch bind cardinality | Ownership sat below the decisive compiler and tested only missing arguments | Remove the wrong-layer mutation and add exact missing-argument and unused-argument mutations at the branded compiler boundary (rung 2) |
| 240 | Replacing the infra-cap/headroom `OR` with `AND` disabled both the at-cap bypass and ordinary below-cap progress | A below-cap failure could answer for the at-cap timestamp exception | Infra-cap terminal timestamp | Selected and control branches changed together | Delete only the cap bypass and aggregate below-cap successor progress with at-cap terminalization and durable state (rungs 2 and 3) |
| 241 | Changing retry comparison `<` to `<=` changed successor eligibility instead of isolating exhausted-budget headroom | Retry-accounting behavior could answer for terminal failure at the epoch ceiling | Exhausted-user-budget timestamp | The mutation targeted a neighboring semantic guard | Remove only the exhausted-budget bypass and aggregate exact-ceiling and predecessor outcomes with full task/run state (rungs 2 and 3) |
| 242 | The activation mutant switched headroom from persisted `first_started_at_ms` to now while also deleting validation of the persisted value | Validation or an unobserved timestamp change could answer for base selection | Existing-first-start activation | One replacement crossed validation and arithmetic-base premises | Preserve validation, change only the headroom base, and own activation plus cancellation and lease timestamps together (rungs 2 and 3) |
| 243 | The rounded-duration fixture sent its edge through spawn normalization, so activation never saw the raw durable seconds representation | The raw-seconds mutant survived behind a witness canonicalized before the target boundary | Persisted activation-duration targetability | Setup erased the decisive value while the scenario still progressed | Spawn safely, inject the hostile-but-valid durable JSON directly, snapshot it, and own activation, persistence, and timestamps under one marker (rung 3) |
| 244 | A constructor-level mutation changed all 23 temporal descriptors at once | Any descriptor or aggregate property could kill the selected nominal-identity mutant | Temporal descriptor identity | A global constructor mutation had no selected/control partition | Mutate only `tasks.enqueue_at_ms` and aggregate count, uniqueness, freezing, identity, bounds, kind, and nullability (rungs 2 and 3) |
| 245 | The invariant-snapshot mutant assigned every query result to `tasks` | Broad downstream missing-table errors answered for projection-to-table binding | Invariant snapshot projection | The mutation destroyed all bindings before the intended owner could decide | Extract the row binder, feed reordered projections/results, aggregate every binding, and mutate through a second positional table list (rungs 1 through 3) |
| 246 | Removing fake-clock validation admitted every invalid value in a parameterized family while the registry named only the negative case | Any sibling invalid input or later read could answer for the lower-bound property | Administrative fake-clock boundary | One broad mutant and repeated marker owned several decisive cases | Isolate `-1`, aggregate rejection and unchanged clock, retain other invalid values as controls, and bypass validation only for `-1` (rungs 2 and 3) |
| 247 | The nightly partition mutant made every batch repeat its whole shard | Size, identity, total-count, and uniqueness assertions all changed together | Nightly seed-plan surface | One broad replacement altered several plan dimensions | Make one batch repeat an equal-cardinality sibling while omitting its own and aggregate all plan invariants under one owner (rungs 2 and 3) |
| 248 | The nightly environment mutant removed `FUZZ_BATCH_INDEX` from all 128 commands | The first generic loop failure could answer for one process-coordinate claim | Nightly runtime environment | The mutation had no selected process or equal-cardinality control | Shift only shard 1/batch 1 to a sibling coordinate and aggregate all commands with an exact mismatch count (rungs 2 and 3) |
| 249 | Five `snapshotTaskThrowable` mutants replaced a shared name, generic-payload, trap-fallback, message, or coercion path for every throwable shape | Intended owners failed alongside neighboring core or SDK throwable owners, so real kills were correctly rejected as wrong-path | Core throwable mutation surface | Per-condition enrollment existed, but each mutant changed a shared branch rather than one distinguishing representation | Give each owner a selected observation and adjacent control, then scope the mutation to its selected value (rung 2, with witnesses at rung 3) |
| 250 | `task-control-suspend-auth` unenrolled every suspension | Driver and event scenarios failed before the mutation could prove the invocation-local enrollment boundary | Suspension-authority mutation surface | “Remove enrollment” was represented by globally bypassing the issuer rather than selecting one suspension shape | Observe a checkpointed `sleep` suspension and checkpointless absolute-wake control together; unenroll only the selected checkpoint key (rungs 2 and 3) |
| 251 | The lease-loss, store-outage, and ordinary-rejection mutations rewrote whole `trustedStoreControl` classifier arms | Ordinary worker behavior, sibling infrastructure cases, and captured-`hasInstance` owners answered for the intended store-boundary mutations | Trusted-store authority mutation surface | Typed classification and fallback behavior had markers, but no value-level discriminant separated each selected rejection from its ordinary control | Pair each own-`cause` selected value with a cause-less control and mutate only the selected value’s classification (rungs 2 and 3) |
| 252 | Three forged-control mutants granted authority by broad `instanceof`, changing genuine public constructors as well as prototype forgeries | Public-constructor assertions killed forgery mutations before forgery-specific authority could receive exact credit | Core forged-control classifier surface | One class-membership rewrite crossed the authentic-instance/forged-prototype boundary | Pair own-`cause` forged suspension, lease-loss, and store-outage objects with cause-less forgeries; grant authority only to each selected forgery (rungs 2 and 3) |
| 253 | `user-name-captured-regexp-test` replaced the complete surrogate predicate with mutable `.test` dispatch | Its intended capture owner and neighboring captured-`exec` owner both failed | Core name-classifier intrinsic mutation | The mutation changed every surrogate position, attacking both independent dispatch claims | Pair a non-leading surrogate with a leading-surrogate control and resolve mutable `.test` only for the selected non-leading case (rungs 2 and 3) |
| 254 | `sdk-captured-map-get` routed every replay-map read through mutable `map.get` | Replay-map, registry lookup, and missing-handler authority tests all answered for one mutation | SDK captured-Map mutation surface | The exported getter was a shared consumer seam and the mutation had no selected map identity | Pair an own-`cause` replay map with a cause-less control and wrap only the selected export call (rungs 2 and 3) |
| 255 | `sdk-captured-promise-race` replaced the whole two-input helper with ambient `Promise.race` | Finalization, iterator, and promise-adoption owners all failed | Worker-finalization promise surface | Replacing the shared helper simultaneously changed race dispatch, iteration, and adoption | Mark one right-hand finalization promise with own `cause`, run a cause-less control, and use ambient race only for the selected input (rungs 2 and 3) |
| 256 | `sdk-captured-abort-aborted-getter` routed every aborted read through the mutable prototype getter | The direct heartbeat-getter and context lease-loss owners both failed | SDK AbortSignal intrinsic surface | One shared captured accessor served independently attributable consumers | Pair own-`cause` and cause-less signals and resolve mutable `.aborted` only for the selected signal (rungs 2 and 3) |
| 257 | `sdk-captured-registry-get` routed every authentic Map registry through its overridable `get` | Stored-entry lookup and missing-entry authority both failed | SDK registry lookup surface | Override dispatch changed for every registry state rather than one selected stored-entry lookup | Run selected/control registries separately, distinguish the selected registry with own `cause`, and dispatch through its override only there (rungs 2 and 3) |
| 258 | `provenance-sweep-progress` excluded every replay of `prov-sweep-run`, so the intended at-cap owner and a below-cap callback both emitted the marker | A wrong replay boundary could answer for the mutation, defeating exact causal attribution | Sweep mutation discriminant and direct-marker ownership | Run identity alone did not distinguish the selected infrastructure ordinal, and the marker appeared in two reporter callbacks | Aggregate selected and below-cap control observations under one assertion, and scope the mutation to the selected maximum attempt (rungs 2 and 3) |
| 259 | `expire-lease-requires-future-expiry` and `expire-lease-requires-integer-expiry` named `transition-layer review regressions (second round)` although both markers were owned by `sweep and cancellation review regressions` | Both real kills were classified wrong-path because their registered full titles could never match | Same-file behavioral-verdict title ownership | Marker existence was checked, but its enclosing static Vitest title remained a second hand-maintained representation | Bind each same-file direct behavioral marker to its enclosing static `describe`/`it` full title; dynamic owners require a mutation-specific reason (rung 2) |
| 260 | The spawn-receipt fixture used task `A` as both the foreign task-id collision and the foreign same-key competitor | Removing queue scope survived because the composite foreign witness did not isolate idempotency-winner priority | Spawn-receipt behavioral fault surface | One row varied two authority axes, so the intended queue predicate was not independently observable | Keep foreign `A` as the task-id collision, add distinct foreign same-key `B`, and retain same-queue winner `Z` under one exact verdict (rung 3) |
| 261 | `sdk-malformed-checkpoint-stops-pump` registered “checkpoint decoding fails during context construction” while the direct owner was “checkpoint replay construction rejects” | The heartbeat-cleanup mutation reached its owner but was classified wrong-path | Same-file behavioral-verdict title ownership | A second independently copied test title drifted at a different file and repair site from finding 259 | Use the same static direct-owner title binding, while leaving cross-file/helper-generated and explicitly dynamic ownership explicit rather than weakening exact title matching (rung 2) |
| 262 | `sweep-rejects-noninteger-attempt` marked only the empty sweep result; its broad mutant changed the later unmarked durable snapshot instead | An adjacent assertion, rather than the advertised verdict, killed the mutation | Sweep observation ownership and mutation minimality | The marker did not own every decisive observation, and the mutation bypassed all three attempt proofs more broadly than its selected representation | Put `{ swept, after }` under one exact marker and scope the mutant to the selected text representation while retaining the sibling proofs for controls (rungs 2 and 3) |
| 263 | The lost-launch and claim-timeout lower-bound mutants added a broad `OR` around `runClaimExpired` | Each mutant could bypass integer, upper-bound, or expiry-time premises and fail an adjacent timestamp owner | Timestamp mutation construction | Deleting one lower-bound condition was represented by replacing the complete expiry predicate | Change only the `BETWEEN 0 AND` lower endpoint for the selected activation branch, preserving every sibling expiry premise and the `runs_lease` plan (rungs 2 and 3) |
| 264 | The shared driver-cleanup mutation generator omitted the comma between generated `sql` and `args` for both bound mutants | TypeScript parsing failed before either cleanup behavior could execute | Generated TypeScript mutation construction | Find cardinality and question-token reconciliation did not establish that the materialized mutant parsed | Batch-materialize every TypeScript mutant and parse it with the TypeScript compiler before enrollment; inject live syntax and enrollment faults (rung 2) |
| 265 | The registry-scope repair made `taskRegistryGet` consume the exported `taskMapGet`, so ordinal 390 changed both its replay-map owner and the new registry owner | A real Map-get kill again became collateral after a later repair | Captured-intrinsic topology and exact mutation dispatch | Public replay capability and private registry capability shared one mutation seam | Retain one private captured Map getter for internal registry authority, export a separately mutable alias for the replay owner, and keep both selected/control verdicts exact (rung 1 topology, rung 3 witness) |
| 266 | Both driver-cleanup behavioral mutants parsed but referenced unimported `MAX_EPOCH_MS` | Each failed wrong-path before its exact cleanup owner could execute | TypeScript behavioral-mutant preflight | Parse validity was a proxy for runtime lexical value resolvability | Resolve value bindings incrementally before enrollment and express both mutations through canonical `storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.drivers.*)` calls (rungs 1 and 2) |
| 267 | The first binding preflight classified every `ExpressionWithTypeArguments` as erased type syntax, including a class `extends` expression | A mutant could introduce an unresolved base class and fail before its exact Vitest owner | TypeScript runtime-reference classifier | A broad `TypeNode` predicate conflated runtime class heritage with erased `implements` and type arguments | Let the compiler's expression-context predicate own runtime references and exclude only computed type elements; exercise an unresolved class base explicitly (rung 2) |
| 268 | Binding rejection keyed on `verdict.kind === behavior` although `typecheck_project` alone routes mutations to Vitest or `tsc` | The 140 Vitest-routed construction verdicts could introduce an unresolved runtime name and bypass preflight | Mutation verifier routing | Attribution vocabulary became a second representation of execution routing | Gate every mutation with no `typecheck_project`, and exempt only mutations whose declared project typecheck is authoritative (rung 1) |
| 269 | TypeScript `resolveName(..., Value)` returned an alias symbol for an erased type-only import | A Vitest-routed mutant could use a type-only name at runtime and fail before its owner | TypeScript runtime value resolution | Alias existence was mistaken for an emitted value binding | Reject aliases owned by type-only import/export declarations and resolved targets without value flags; retain a type-only-import attack (rung 2) |
| 270 | The coordinator self-test proved only that preflight received the selected names, not that it ran before checkpoint or worktree creation | A future reorder could mutate durable audit state before rejecting an invalid inventory while the mechanism test stayed green | Mutation preflight ordering | Enrollment was used as a proxy for pre-mutation placement | Inject a rejected preflight and assert that no checkpoint directory or worktree exists before the coordinator returns (rung 2) |
| 271 | Poison invocation settlement used optional `result` and `error` fields, so fulfillment with `undefined` and rejection with `undefined` had the same representation; the healthy-progress oracle also did not require its responsible invocation to fulfill | A call could commit its durable transition, reject its caller, and still make the generated poison cell report green | Poison invocation outcome and healthy-progress oracle | Field absence and the value `undefined` stood in for a promise settlement discriminant, while durable change stood in for successful return | Return one frozen discriminated outcome (`fulfilled/result` or `rejected/reason`) from the sole recorder, require the normal healthy or targeted poison invocation to fulfill, and attack both ownership decisions exactly (rungs 1 and 2) |
| 272 | Relative and absolute wakes compiled different SQL text and bind arities inside the same `reschedule` and `suspend` batch labels | One tracing/crash-injection address named two executable transition shapes, so a fault or replay proof for one wake representation did not prove the other | Batch-label compiled-shape contract and generated SQL corpus | Source inventories enumerated labels and static statement counts, but did not execute the input-selected fragments hidden behind `prepareWake` | Classify the wake once, bind its mode and both value slots into one `CASE`-based SQL/arity topology, and compare the real relative/absolute batches for both labels (rung 1 for the current topology, rung 2 for the focused capture) |
| 273 | Finding 271's first settlement mutation changed the shared rejection owner broadly enough to fail the targeted settlement case and then generated poison siblings before its named assertion | The new guard could receive only wrong-path evidence, leaving its advertised exact mutation unproved | Settlement mutation construction and exact attribution | Deleting a shared condition was treated as an isolated attack even though the generated sibling surface consumed the same branch | Give the healthy and targeted paths separate replacement verdicts, then mutate only the undefined healthy rejection; the exact audit isolates and catches both entries (rungs 2 and 3) |

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
| Retry/throwable whole-boundary review, findings 36 through 38 | 3 | no |
| Retry/throwable repair review, findings 39 through 41 | 3 | no |
| Exact targeted mutation audit, finding 42 | 1 | **yes** |
| Task-realm whole-boundary review, findings 43 through 53 | 11 | no |
| Task-realm repair review, findings 54 through 64 | 11 | no |
| Bind-attribution repair review, findings 65 through 67 | 3 | no |
| Final durable-boundary and mutation-surface review, findings 68 through 73 | 6 | no |
| Session scanner self-test, finding 74 | 1 | **yes** |
| Full exact mutation audit at `cd719f1`, findings 75 through 77 | 3 | **yes** |
| Exact-head durable-boundary review, findings 78 through 92 and 101 through 102 | 17 | no |
| Ownership breadth review, findings 93 through 100 | 8 | no |
| Mandatory relation-repair review, finding 103 | 1 | no |
| Full libSQL poison matrix against the first repair, finding 104 | 1 | **yes** |
| Final tranche review, findings 105 through 123 | 19 | no |
| Mutation deadline regression, finding 124 | 1 | **yes** |
| Exact-attribution repair reviews, findings 125 through 167 | 43 | no |
| Exact mutation audits, findings 168 through 267 | 100 | **yes** |
| Binding and simplify reviews, findings 268 through 272 | 5 | no |
| Focused settlement mutation audit, finding 273 | 1 | **yes** |

Self-catch rate: **132 of 273, or 48.4%** (through finding 123: **30 of
123, or 24.4%**; previous temporal round: **1 of 43, or 2.3%**). The original
35-finding audit was **24 of 35, or 68.6%**, but the later boundary and repair
rounds were almost entirely review-caught. The long audit found 22 attribution
defects without outside review. It is not 47 self-catches:
`47987c0` reported 42 wrong-path entries and five survivors, but those 47
witnesses collapse to 21 independent causes above. Counting every generated
case as a defect would mix test volume with the site-and-mechanism counting
used by the preceding numeric and temporal postmortems.

The last checked-in cumulative trailer before this closeout was
`review-findings: 289`. The original nightly/mutation round raised it to 300;
the retry/throwable, task-realm, and bind-attribution rounds raise it to
`review-findings: 331`; the final durable-boundary review raises it to
`review-findings: 337`. The preceding closeout raised the previously recorded
30 self-catches by 29 to 59. The durable-boundary ownership round then added 45
review catches and one self-catch. All later addenda bring the current branch
catalogue to **430 review-caught plus 162 self-caught, or 592 total findings**.
The required trailer is `review-findings: 430`; the branch self-catch rate is
**27.4%** and outside review found **72.6%**.

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

Through finding 123, there were **53 fix-induced findings**. The first
34 occurred through finding 77. Thirteen were in the original
nightly/mutation round: finding 2 and findings 24 through 35. Finding 2 was
caused by the first fresh-process proof, whose text
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
cycle therefore had to be rerun before that checkpoint could merge. The five
later addenda add four, ten, two, three, and two fix-induced findings
respectively, for **34 through the 77-finding checkpoint**. The final
durable-boundary addendum adds eight: findings 78 through 80, 91, 100, and 102
through 104. The final tranche review adds eleven: 106, 108, 113 through
120, and 123. Their exact accounting and repair topology appear below.

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
the current registry has 421 declared entries, but even a complete exact audit
of those entries is not proof that declaration is complete. Two guards
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

## Addendum: retry and task-throwable boundary closeout (2026-07-31)

After the 207-mutation checkpoint above, whole-system review followed the
failure path one layer above the store. It found that legal retry data could
escape before the worker recorded a failure, arbitrary JavaScript throwables
could crash their own classifier, and public error classes were being treated
as runtime authority. Review of the repair found one authority flaw and two
missing fault surfaces. The exact mutation audit then found one wrong-path
verdict itself. This addendum records those distinct sites without rewriting
the earlier round or its evidence.

### Addendum severity

The worst consequence was duplicate user work. A zero-delay exponential retry
at a high attempt produced `NaN`, threw before `store.fail`, and left the run
claimed; lease recovery could execute the handler again without the failed
attempt having spent its user retry budget. Hostile thrown values could strand
the claim the same way. Forged suspension or infrastructure controls instead
let task code bypass normal failure accounting. The remaining findings affected
the repair's authority boundary and the evidence claiming to maintain it.

### Addendum finding detail

The canonical Findings table above owns findings 36 through 42. This addendum
keeps their focused severity, detection, recurrence, mechanism-boundary, and
evidence analysis without a second independently writable findings table.

### Addendum detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Whole-system failure-path review, findings 36 through 38 | 3 | no |
| Mandatory review of the authority repair, findings 39 through 41 | 3 | no |
| Exact targeted mutation audit, finding 42 | 1 | **yes** |

The addendum self-catch rate is **1 of 7, or 14.3%**. Across the complete
closeout recorded in this file, the rate becomes **25 of 42, or 59.5%**, down
from 68.6% before this addendum. That decline matters: the new SDK layer did
not begin with the generated fault surface the repository's own law required.

The cumulative PR trailer rises from `review-findings: 300` to
`review-findings: 306`. Self-catches rise from 54 to 55, so the branch
catalogue is now **306 review-caught plus 55 self-caught, or 361 total
findings**.

### Addendum recurrence

Finding 36 repeats the numeric-domain lesson at a new consumer. Durable
temporal fields had complete bounds, but retry policy data crossed SDK and
storage boundaries through casts, and multiplication introduced a value no
field validator had seen. The mechanism protected the lower layer, not every
entry into retry math.

Findings 37 and 38 repeat the new-layer and authority-provenance failures.
Verifying store batches said nothing about the worker's JavaScript throwable
surface, and a public class was again used where private provenance was the
property. Finding 39 shows the first repair still trusted ambient intrinsics
after task initialization.

Findings 40 through 42 repeat the exact-attribution proxy class documented
throughout this postmortem. A composite marker, one representative corpus
mutation, and a framework-rendered rejection were pictures of causal
ownership. The first two also violate the rule that every new layer receives
its own fault surface at birth.

### Addendum mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Total retry normalization at every retry entry | 1/2 | The numeric representation and zero-base arithmetic are total, but the first repair still resolved JavaScript intrinsics after task modules loaded. The next addendum records the executed `Reflect.get`, `Object.freeze`, `Number`, and `Math` replacement counterexamples and the captured-operation repair. Process termination remains outside the JavaScript failure contract. |
| Total owned throwable snapshot | 1/2 | A process-level termination such as OOM still cannot become a durable user failure; the mechanism claims totality for JavaScript thrown values, not host death. |
| Invocation-local control authority with captured intrinsics | 1 | Code deliberately handed the private issuer by a future context API would possess real authority and would pass the classifier. The present `#private` field makes that reference unavailable; a future API leak therefore needs a new construction case. Pre-import host poisoning is likewise outside the task-code threat boundary. |
| Per-condition core and SDK exact mutations | 2 | The earlier executed condition-completeness false negative still applies: a new case omitted from both its source inventory and `MUTATIONS` passes every declared mutation. PR3.10 owns source-generated enrollment. |
| Canonical expected-failure attribution | 2 | A callback that deliberately throws the accepted error can still make the helper emit its marker without exercising production. This is the same executed semantic-minimality false negative already recorded above; exact attribution proves ownership of the observed failure, not that no earlier equivalent failure exists. |

### Addendum fix-induced defects

Four findings were introduced by the repairs themselves: 39 through 42.
Findings 39 through 41 came from mandatory review of the first task-control
repair; finding 42 came from running its exact mutation surface. The combined
closeout therefore has **seventeen fix-induced findings**.

The branch preserves the actual history. Findings 36 through 38 have separate
red commits, but findings 39 through 41 were repaired inside green commit
`23f55b0`, and finding 42's audit failure at that commit was repaired directly
in `7fee34d`. That does not meet the two-commit rule for those repair findings.
Rewriting the accumulated history would hide the real sequence, so this
deviation is explicit; PR3.10 remains the mechanical prevention for red/green
topology.

### Addendum evidence

- Retry red `df9643e` demonstrated the high-attempt zero-base escape;
  `5325f69` expanded the red class surface across spawn, decode, public math,
  hostile fields, representation, and null/default behavior. Green `db07626`
  installed the single normalizer and total math.
- Hostile-throw red `35c774b` exercised revoked proxies, hostile accessors, and
  coercion. Authority red `387b263` demonstrated public constructed controls.
  Green `23f55b0` installed owned failure snapshots and per-invocation runtime
  authority.
- Whole-system review verdict: “A legal zero-delay retry became NaN only after
  exponent overflow; failure handling escaped before recording the attempt,
  leaving lease recovery to rerun user work that never spent its retry budget.”
- Throwable review verdict: “The handler catch treated arbitrary JavaScript
  values as safely inspectable; a proxy trap, accessor, or coercion hook could
  crash classification and strand the claim instead of recording a user
  failure.”
- Authority review verdict: “Public class membership was mistaken for runtime
  authority, so task code could mint suspension or infrastructure outcomes and
  bypass the user failure policy.”
- Repair review found that invocation-time WeakMap lookup remained replaceable
  and that the core classifier and SDK runtime corpus each lacked per-condition
  fault enrollment. It also narrowed the completion catch; no reachable
  serialization escape reproduced, because `serializeTaskValue` already
  converts every such failure to `FatalTaskError`, so that change is recorded
  as hardening rather than a finding.
- Confined `pnpm verify` passed at `23f55b0` and again at `7fee34d`: **77 test
  files / 3,478 tests**. The task-named targeted audit selected **51**
  mutations: 50 were exactly attributable at `23f55b0`;
  `task-control-store-total-fallback` was correctly rejected as wrong-path.
  After `7fee34d`, that repaired mutation was exactly attributable. The live
  registry contains **269 mutations**, including 14 retry and 48
  throwable/control entries added by this closeout.

### Addendum root cause and mechanisms

The common cause was trusting a lower layer's guarantees across a new
boundary. Store conformance did not make retry arithmetic total, make arbitrary
JavaScript values inspectable, or authenticate runtime control flow. The first
repair then treated a private map and one representative mutation as the
properties, when capture timing and per-condition enrollment were independently
writable.

Built here: one retry representation and parser; one total task-failure
snapshot; one fresh paired authority per invocation; module-time captured
intrinsics; private context issuance; exact core and SDK fault arms; and
canonical rejection attribution.

Deferred to PR3.10: generate mutation enrollment from semantic conditions and
machine-check red/fix commit topology. The present 269-entry registry proves
every declared mutation, not declaration completeness.

### What the addendum still would not catch

A future throwable/control arm omitted from both its executable corpus and the
mutation source can still ship. A future context API could leak its private
issuer. Host code that poisons JavaScript intrinsics before these modules load,
or a process killed below the JavaScript exception boundary, is outside the
current task-code containment claim. Exact expected-failure attribution can
still be satisfied by an earlier equivalent failure. Those are the boundaries
PR3.10 and future host-isolation work must address; this addendum does not claim
otherwise.

## Addendum: task-realm durable-boundary closeout (2026-08-09)

Review of the retry and throwable repair executed its own stated false
negative: task modules and handlers run after the durable runtime modules have
loaded, so ambient JavaScript operations can be replaced between capture and
use. The first counterexample changed `Reflect.get` after import and made a
valid fixed retry classify as `none`. The review then followed the same class
through task-value encoding, replay bookkeeping, worker finalization, event
wakes, registry dispatch, and the production clock. Repair review found both
new production gaps and gaps in the mutation surface intended to maintain the
repair.

### Task-realm severity

The highest-impact cases again stranded or mis-transitioned claimed runs.
Changed retry arithmetic could suppress or alter a scheduled retry; changed
serialization could persist a forged result; changed replay maps could skip a
step or return a value different from the checkpoint; and changed worker or
clock operations could reject, hang, or mis-time finalization. Registry lookup
had a separate authority consequence: overridable lookup could revoke a stored
handler or grant a handler for a name with no authoritative entry.

This is durable-boundary containment, not a JavaScript security sandbox. A
handler executes in the host process today and can terminate that process or
mutate operations outside the explicitly captured boundary. Such host-realm
integrity is an operational trust requirement; process/realm isolation is the
structural answer for untrusted application code. The mechanisms below claim
only the named durable operations and say so explicitly.

### Task-realm finding detail

The canonical Findings table above owns findings 43 through 64. This addendum
keeps the task-realm round's focused severity, detection, recurrence,
mechanism-boundary, and evidence analysis without a second independently
writable findings table.

### Task-realm detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Whole-boundary review, findings 43 through 53 | 11 | no |
| Mandatory review of production and mutation repairs, findings 54 through 64 | 11 | no |

This addendum's self-catch rate is **0 of 22**. Across the complete closeout to
this point, the rate is **25 of 64, or 39.1%**. The cumulative trailer rises
from `review-findings: 306` to `review-findings: 328`; self-catches remain 55,
for **383 findings** in the branch catalogue.

### Task-realm recurrence

Findings 43 through 53 and 59 through 62 repeat the same proxy exposed by the
retry repair: a function reference that looked stable at author time was not
the operation executed after task code ran. Findings 49 and 50 are the sharper
recurrence: even capturing a composite built-in did not capture the mutable
operations it dispatches through. The repair therefore owns leaf operations or
owned representations rather than trusting composite host behavior.

Findings 54 through 58, 63, and 64 repeat the per-condition fault-surface and
exact-attribution failures. An umbrella case, an adjacent case, or an exception
of the right class remained a proxy for the independently writable condition.
The review caught every finding in this addendum; the detection rate therefore
regressed again despite the added machinery.

### Task-realm mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Captured durable-boundary operations | 1/2 | A handler can still replace an operation not used through the captured core/SDK tables, or terminate the shared process directly. The mechanism owns its named retry, value, replay, worker, registry, and clock boundaries; it is not process-wide realm isolation. |
| Owned task-value snapshot | 1 | A getter can still throw while the raw graph is being read; the codec converts that to `FatalTaskError` rather than persisting a value. The mechanism guarantees one owned canonical wire value or a permanent failure, not successful serialization of every JavaScript object. |
| Native-Map registry authority | 1 | A non-Map structural `ReadonlyMap` can implement `get` with mutable ambient dependencies and still pass SDK dispatch. Structural resolvers are explicitly trusted host code; authentic Map stored entries alone receive SDK containment. |
| Captured production clock | 1/2 | An injected custom `Clock` can use ambient timers and still satisfy the type. Dependency injection intentionally transfers implementation authority; the captured mechanism owns only `systemClock`. |
| Per-condition exact mutations | 2 | A future captured operation omitted from both its test corpus and `MUTATIONS` remains invisible. The 60 new entries prove the declared conditions, not declaration completeness; PR3.10 still owns source generation. |

### Task-realm fix-induced defects

Ten findings were introduced by repairs in this round: 52, 54 through 60, 63,
and 64. The explicit JSON-model hole was exposed by the first owned serializer;
five evidence defects came from its new fault surfaces; the descriptor and
registry compatibility defects came from the first production repairs; and the
yield and registry-grant gaps came from incomplete repair coverage. Combined
with the earlier seventeen, the closeout now has **27 fix-induced findings**.

Findings 43 through 53 and 60 through 64 have honest cumulative red commits as
listed below. Findings 54 through 59 were found while the green repair was
still uncommitted and have no standalone red hash; they were fixed inside
`4220de7`. This is another disclosed deviation from the two-commit rule, not an
invented topology.

### Task-realm evidence

- Red `bd2c490` established five independent layers: retry operations, durable
  task-value encoding, core task-input classification, replay maps/JSON, and
  worker orchestration. Red follow-ups were `e2ad339` (context lease getter),
  `1bc3877` (regular-expression transitive dispatch), `1eb9c3f` (promise
  adoption/iteration), `960683d` (wake discriminants), `43f1528` (closed JSON
  model), and `a888115` (registry dispatch).
- Repair-review reds were `ebe1c00` (registry compatibility), `4ec98c0`
  (production clock), `4e07b06` (composed registry containment and independent
  yield coverage), and `8c7b74d` (missing-entry handler authority). Green
  `4220de7` closed the production and fault-surface findings and passed **80
  test files / 3,538 tests**.
- Review verdict: “A handler can replace `Reflect.get` after module import and
  make `decideRetry({kind:'fixed', baseSeconds:1}, 1, 2)` return
  `{retry:false}`.” Follow-up review reproduced forged result serialization,
  replay-map divergence, promise-finalization rejection, mutable regexp
  dispatch, inherited wake discrimination, and registry authority failures.
- The live registry grew from **269 to 329**: exactly **60** new literal
  mutation specifications, each with one owned verdict. The marker/inventory
  self-test and focused task-realm suites were green at `4220de7`; later
  collision and bind-attribution work intentionally invalidated that head as
  final merge evidence, so that checkpoint required a later clean-head
  345-entry audit rather than claiming one here.

### Task-realm root cause and mechanisms

The common cause was treating module identity as operation identity. Modules
were loaded before task code, but their functions still looked up mutable
globals and prototype methods when invoked. Composite captures such as
`RegExp.test` and `Promise.race` retained hidden second dispatch paths. The
repair uses module-time leaf-operation captures, owned graph snapshots, native
collection calls, and explicit authority policies at the durable boundaries.

Built now: one captured core operation table; an owned JSON snapshot and closed
object model; captured SDK replay, abort, promise, registry, and clock helpers;
own-property event discrimination; and 60 exact condition mutations. Deferred
to PR3.10: source-generated condition enrollment. Full isolation of untrusted
application code is a deployment boundary, not a claim of this same-process
SDK.

### What the task-realm addendum still would not catch

Same-process handlers remain trusted with host-realm integrity. They can mutate
operations outside the named capture tables, interfere with third-party driver
internals, or terminate the process; durable leases and idempotency recover
process loss, but no same-realm library can sandbox that authority. A future
boundary operation omitted from both source inventory and mutations also stays
invisible. A structural registry or injected clock owns its own dependencies.
These limits are explicit so the captured-intrinsic mechanism is not presented
as general JavaScript isolation.

## Addendum: unresolved-thread and bind-attribution closeout (2026-08-09)

A thread-aware audit of PR #12's 53 unresolved comments found that two accepted
findings had been counted but incompletely repaired. Final-remote finding 31's
historical collision sweep was exact, but the self-collision sibling still
accepted any rejection. Final-remote finding 25's runtime classifier rejected
an unmarked bind failure, but the cheap source-inventory screen claimed by its
postmortem did not exist.
Their completion does not increment the finding ledger. Review of the finding
25 repair did expose three new, independently counted attribution defects.

### Late finding detail

The canonical Findings table above owns findings 65 through 67. This addendum
keeps the unresolved-thread and bind-attribution evidence without a second
independently writable findings table.

### Late detection, recurrence, and fix-induced ledger

All three new findings were caught by mandatory adversarial review, so this
addendum is **0 of 3 self-caught**. At this bind-attribution checkpoint the
closeout was **25 of 67, or 37.3%** self-caught. The cumulative trailer then
was `review-findings: 331`; self-catches were 55, for **386 findings** in the
branch catalogue. The later durable-boundary and scanner addendum below owns
the final accounting.

Finding 65 repeats the exact-attribution proxy: an exact marker still does not
prove that the accepted error came from the intended semantic guard. Findings
66 and 67 repeat incomplete repair-surface and ambient-operation failures.
Findings 66 and 67 were introduced by the first uncommitted brand repair; 65
pre-existed it. At this checkpoint the closeout therefore had **29 fix-induced
findings**.

### Late mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Reconciled raw question-token alarm | 2, syntactic | A replacement can remove a SQL `?` and add a question token in a TypeScript comment or conditional, preserving the raw count. That cancellation case is an executed self-test and intentionally passes this cheap alarm. |
| Authenticated compiler-bind rejection | 1/2 | An unbranded driver/compiler `TypeError` with identical bind text remains caller-matchable: an executed `/.*/` probe emitted its exact mutation marker. The private brand owns only the two authenticated `FencedBatch` exits, not bind semantics elsewhere. |
| Exact collision matchers | 2 | An unrelated operation can still emit the same SQLite unique-index text. Atomic unchanged-state assertions plus three path-specific mutations narrow that false negative, but text does not authenticate the database statement that produced it. |

### Late evidence and closure

- Existing final-remote finding 31: red `5d2c30c` showed the weak collision seam
  swallowing an unrelated sentinel `TypeError`; green `8ae7fc2` added exact
  self-collision, sweep, and unrelated-error owners. Red `3f5a487` then routed
  the remaining historical worker assertion through a deliberately weak shared
  oracle; green `4e54bec` removed that seam so self-collision, historical worker
  failure, sweep, and the unrelated-error control all consume the one
  `RUN_ID_COLLISION` representation. This completion does not add a finding.
- Existing final-remote finding 25: red `acb36c1` reconstructed the missing
  `? IS NOT NULL` source alarm; green `b3fd914` added reconciled question-token
  drift declarations and the explicit equal-count cancellation boundary. Red
  `3f5a487` then proved the claimed live-inventory injection never reached the
  canonical CLI; green `4e54bec` runs that injected fault through the real
  inventory and rejects simultaneous removal of all declared question-delta
  reasons. It proves the aggregate enrollment path, not each declaration
  independently. This completion does not add a finding.
- New finding 65: red `915c1dc` made all three promise helpers demonstrate bind
  failure laundering. Findings 66 and 67: red `fd5de9c` added the omitted
  explicit-undefined producer and post-import constructor replacement cases.
  Green `b2047e8` installed the single captured factory, private brand, and
  pre-matcher rejection chokepoint.
- `pnpm verify` at `b2047e8` passed **80 files / 3,546 tests**. The mutation
  self-test enrolled **339** entries. A confined targeted audit caught all
  seven `testing-helper-bind-*` mutations and all nine `successor-*` mutations
  at their exact verdicts on that head.

The final mechanism is deliberately two-layered. Raw source reconciliation is
a fast construction alarm with a written cancellation boundary. Authentic
compiler failures are separately ineligible for expected-failure attribution,
so even a source mutation that evades the alarm cannot be credited for dying
at either bind-validation exit. The collision repair similarly uses one shared
error shape but independent path-owned mutations. At that checkpoint the merge
gate still required the complete 345-entry audit on one clean immutable head;
targeted evidence was not substituted for that cycle.

## Final durable-boundary and session-scanner addendum

Final review after the unresolved-thread repairs found six independently
writable durable-boundary or mutation-surface defects. The session scanner's
own generated self-test then found one repair-induced terminal-state refusal.
The canonical Findings table above owns findings 68 through 74; the already
counted final-remote findings 25 and 31 were completed without incrementing it.

### Final detection and accounting ledger

Findings 68 through 73 were caught by mandatory adversarial review. Finding 74
was caught by the scanner's own generated self-test before final attestation.
This addendum is therefore **1 of 7 self-caught**, and the complete closeout is
**26 of 74, or 35.1% self-caught at this checkpoint**. The cumulative trailer
at this checkpoint is
`review-findings: 337`; the branch catalogue is **337 review-caught plus 56
self-caught, or 393 total findings**, for a **14.2%** branch self-catch rate.
The clean-head mutation-attribution addendum below owns the final totals.

Finding 68 repeats classification by apparent position: an inner catch did not
make completion a different error-origin phase. Finding 69 repeats the
single-representation rule because the validated option and persisted option
were separate reads. Findings 70 through 72 repeat finding 51's inherited
event-wake discrimination at three independently writable suspension
consumers; owning one event wake did not enumerate the whole wake union.
Finding 73 repeats findings 54 and 63's per-condition mutation-enrollment gap.
Finding 74 recurs after finding 37 in
`pr3.6-final-defect-review.md` and finding 39 in
`parallel-mutation-audit.md`: a changing host object crossed several
observations, but the classifier modeled one state spelling and the repair
branches did not share one lifecycle decision.

Findings 70 and 73 were introduced by the task-control and compiler-brand
repairs respectively. Finding 74 was introduced by the session evidence
scanner repair. Findings 68, 69, 71, and 72 pre-existed this final repair set.
Together with the prior 29, this checkpoint had **32 fix-induced findings**.

### Final mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Lexically separate handler and completion phases | 1/2 | A future finalization operation placed back inside the handler/serialization catch can again enter `recordUserFailure` until that new operation receives its own origin regression and mutation. The structure owns the current `complete` call, not every future phase. |
| Single-read task options | 1/2 | `awaitEvent.timeoutSeconds` now has one lexical value, but a new option or context method can still read a getter twice if it is absent from the replay-equivalence and mutation inventories. |
| Captured own-property wake discrimination | 1/2 | Task control, libSQL `reschedule`, and libSQL `suspendRun` each have an exact owner. A future backend or wake consumer can still use prototype-inclusive `in` until central generation makes the consumer list complete. |
| Exact compiler-brand-read mutation | 2 | The registered `isFencedBatchBindError` predicate cannot stop reading its WeakSet unnoticed. A future authentication predicate or brand consumer omitted from `MUTATIONS` remains outside this literal registry. |
| `TERMINAL_PROCESS_STATES`, `process_is_gone`, and the phase matrix | 1/2 | The current Linux `Z`, `X`, and `x` terminal states are one definition used around owner, argv, cwd, and final identity observations. A future kernel/platform state or a new observation phase omitted from the matrix remains outside the classifier. |

Built now: lexical worker phases, one-read timeout persistence, captured
own-property wake classification at all three current consumers, an exact
private-brand-read mutation, and one terminal-process classifier with its phase
matrix. PR3.10 remains the recorded deferral that derives mutation enrollment
from semantic conditions; this addendum does not claim literal registration is
complete for future consumers.

### Final evidence and remaining gate

- Red `3f5a487` made the completion-origin, timeout single-read, and three wake
  discriminant regressions fail and exposed the missing private-brand-read
  mutation owner. Green `4e54bec` installed the structural fixes and six exact
  mutation/verdict pairs. The brand behavior test was green in the cumulative
  red because finding 73 was missing mutation ownership, not broken production
  behavior; that exception is disclosed rather than presented as a failing red.
- Red `8b654ff` made the scanner retain an `X`-state process. Green `4e54bec`
  installed `TERMINAL_PROCESS_STATES`, `process_is_gone`, and the nine-case
  initial/owner/argv/cwd/final phase matrix covering `Z`, `X`, and `x`.
- At `4e54bec`, focused mutation audits classified the **6 of 6** new entries,
  **4 of 4** wake-timestamp entries, **8 of 8** bind entries, and **9 of 9**
  successor entries as exact, with no wrong-path results. `pnpm verify` passed
  **80 files / 3,550 tests**, and the mutation self-test enrolled **345** live
  entries.
- Those focused results were not the final mutation gate. The first complete
  **345-entry** audit and the attribution defects it found are recorded below.

## Final clean-head mutation-attribution addendum

The first complete 345-entry audit on immutable head `cd719f1` caught 342
mutations exactly, rejected three real kills as wrong-path, and reported no
survivors. Those three failures are independently writable evidence-mechanism
defects, not three production regressions. The canonical Findings table above
owns findings 75 through 77.

### Clean-head detection and accounting ledger

All three findings were caught by the repository's full exact mutation audit,
so this addendum is **3 of 3 self-caught**. The complete closeout is **29 of
77, or 37.7% self-caught**. The cumulative trailer remains
`review-findings: 337`; the branch catalogue is **337 review-caught plus 59
self-caught, or 396 total findings**, for a **14.9%** branch self-catch rate.

Findings 75 and 77 recur after the one-condition/one-assertion ownership rule:
the nested-symbol mutation had a second generic test representation, while the
SDK marker sat after another decisive assertion. Finding 76 recurs after exact
first-line marker matching: the classifier rejected a framework diagnostic
that was exactly the marker but omitted the assumed trailing matcher detail.

Findings 75 and 77 were introduced by the task-realm attribution repair in
`4220de7`. Finding 76's no-detail classifier false negative predated that
repair and was merely reached by its exotic-object mutation. Adding the two
repair-induced findings to the prior 32 yields **34 fix-induced findings** in
the complete closeout.

### Clean-head mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| One combined nested-symbol owner | 2 | A different serializer condition can still have both a generic matrix case and a mutation-specific case; only executing its mutation exposes the collateral failure. PR3.10's generated condition ownership remains the rung-1 target. |
| Exact no-detail assertion diagnostic | 2 | A future reporter can emit a different exact prefix or move the marker off the first line. That path remains wrong-path until its structured transport is explicitly modeled; source-context substrings still receive no credit. |
| First-observable SDK mutation owner | 2 | A future setup or intermediate assertion can become decisive before an existing marker. The live mutation audit, not marker presence alone, proves the current control flow. |

Built now: the generic task-value matrix owns only the top-level symbol case;
one combined assertion owns object- and array-member symbol rejection; the
classifier recognizes exact `AssertionError: <marker>` without loosening to
substrings; and the context lease-loss mutation owns the first worker outcome.
The registry remains 345 because these repairs correct ownership rather than
add conditions.

### Clean-head evidence and remaining gate

- At `cd719f1`, `pnpm verify` passed **80 files / 3,550 tests**; confined TLC
  completed all five liveness groups and exhaustive safety with 111,832,051
  generated and 22,093,378 distinct states; the 2,000-seed x 100-step confined
  fuzz gate passed **44 files / 3,119 tests**.
- The complete audit at `cd719f1` reported **342 exact catches, three
  wrong-path results, and zero survivors**. The wrong-paths were
  `task-value-raw-nested-symbol`, `task-value-rejects-exotic-objects`, and
  `sdk-context-captured-aborted-getter`.
- Red `d87bc53` made the classifier self-test reproduce Vitest's exact
  no-detail assertion form. The other two failures were already executable in
  the complete audit. Green `5f420c0` consolidated nested-symbol ownership,
  accepted only the exact first-line diagnostic, and moved SDK ownership to
  the first observable outcome.
- At `5f420c0`, all three formerly wrong-path mutations were caught by their
  exact attributable verdicts. `pnpm verify` passed **80 files / 3,548 tests**,
  and the mutation self-test retained **345** live entries.
- Targeted repair evidence was not the final mutation gate. At that checkpoint,
  the complete **345-entry** audit, confined fuzz, TLC, and verify gates still
  had to pass together on one later clean immutable head; the following
  addendum records the superseding evidence and then-current 385-entry
  requirement.

## Final durable-boundary ownership addendum

Review of the repaired worker and every direct scheduler mutation door found
26 defects; the full libSQL poison matrix then found one defect in the first
relation repair. Final tranche review found 19 more defects in receipt
ownership, migration-target policy, durable serialization, door-specific
mutation ownership, relation-policy ownership, cancellation attribution, and
the advisory lease door. The canonical Findings table owns findings 78 through
123. This addendum does not rewrite findings 75 through 77 or their completed
345-entry audit: it begins from that checked-in 337-review / 59-self checkpoint.

### Detection ledger and recurrence

Outside review found findings 78 through 103 and 105 through 123. The repository
found finding 104 when the complete libSQL conformance run exercised the
generated poison matrix against the first repair. The round is therefore **1
of 46 self-caught, or 2.2%**. Cumulatively the branch has **382 review-caught
and 60 self-caught findings, 442 total**, for a **13.6%** self-catch rate;
outside review found **86.4%**. The required PR trailer is
`review-findings: 382`.

Findings 78 through 80, 102, and 103 recur after the exact-attribution and
per-condition mutation rules. The existing machinery proved each declared
mutation's path, but it did not require one decisive structured assertion, did
not prove the reverse marker inventory, and initially represented only the
`queueScoped: true` half of a two-valued relation policy. These are the same
proxy class as findings 24, 40 through 42, 54, 63, 73, and 75 through 77: a
named example stood in for the complete property.

Findings 81 through 84 recur after the task-realm single-representation rule.
The handler itself used captured operations, but setup fell outside the pump's
lifetime scope, retry authority crossed task code through a public view, lease
cadence silently substituted a one-second policy, and spawn reread a user-owned
option. The new outer worker scope and source-owned lexicals close the current
paths; they do not constitute a JavaScript sandbox.

Findings 85, 86, and 101 recur after the serialize-then-parse-at-source rule.
Claim and activation let the write happen before discovering an unreadable
payload, while event NULL overloaded corruption and timeout. SQL admissibility
now precedes mutation authority and TEXT is a distinct durable event premise.

Findings 107 through 112 recur at the same single-representation boundary.
Retry, cancellation, and headers had been snapshotted or admitted, but their
later serialization and parsing still resolved ambient JSON operations. The
captured task-value codec now owns both directions, and canonical cancellation
is constructed with own data properties before it crosses that codec.

Findings 87 through 100 and 104 recur after the standing total-ownership and
sole-live rules. Identity joins repeatedly proved only `task_id`, each direct
door independently omitted `queue`, terminal doors did not recheck the
cardinality they were about to collapse, and the first structural repair
overgeneralized queue scope to an authoritative cleanup edge. The explicit
relation ledger is important precisely because “all edges are scoped” is as
wrong as “no edges are scoped.”

Finding 91 also recurs after the one-statement clock rule: client-level
atomicity did not make two SQL statements share an instant. Migration v5 moves
the libSQL heartbeat and cleanup behind a one-statement ingress trigger.

Finding 105 is a second receipt-ownership defect after finding 87: the first
repair scoped the same-queue idempotency winner but left the losing task-id leg
global. Finding 106 recurs after exact mutation attribution because frozen
migration history could answer instead of current production behavior.

Findings 113 through 123 recur after the per-condition mutation rule. Combined
payload, relation, ownership, and range mechanisms stood in for independently
writable field-by-door or ledger-entry conditions, and cancellation pointed at
a narrow example rather than the generated corruption-class verdict. The new
entries declare those exact current owners; only a completed mutation audit can
establish their kills.

### Mechanism audit — written false negatives

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Exactly one failed assertion and one message | 2 | One assertion can still combine two independently writable semantic guards and emit one message. The classifier proves report cardinality, not mutation minimality; PR3.10 still owns source-generated condition attacks. |
| Reserved-marker reverse inventory | 2 | A new condition with neither a reserved marker nor a mutation is absent from both sides and passes. Requiring at least one live owner or explicit machinery exemption, plus one shared semantic verdict for mutations that reuse a marker, proves ownership of present claims—not completeness of future claims. |
| Worker-owned pass scope and retry attempt | 1 for current flow | A future fallible operation inserted after pump creation but before the outer `try`, or a new accounting decision that rereads another public context field after task code, recreates the bug. The current lexical topology owns only the enumerated setup and retry paths. |
| Exact lease-derived cadence | 1/2 | Scheduling from the real lease removes the one-second substitution, but a heartbeat call whose latency itself exceeds the lease can still lose ownership. Lease loss and recovery, not the cadence formula, own that operational boundary. |
| SQL durable-payload admissibility | 1 for retry policy and headers | A future worker-payload column omitted from both `durableTaskRetryAdmissible` and `durableTaskHeadersAdmissible` can again be decoded after the CAS. The two field-specific definitions are composed at the current candidate, receipt, and activation doors; the enrolled mutations declare those current field-by-door conditions, while contract generation remains the rung-1 destination. |
| Captured durable scheduler codec | 1 for retry, cancellation, and headers | A future durable field can still normalize through an owned snapshot and then use an ambient serializer or parser. The current spawn and claim paths route through the captured core codec; this is not automatic enrollment of future fields. |
| Canonical task/run ownership fragments | 1 for current direct doors | A newly added raw SQL door that never composes `runOwnedByTask` remains possible until door enrollment is generated. The enrolled mutations declare current consumers, but their kills and future completeness require the exact audit and generated enrollment respectively. |
| `taskOwnsEveryRun` reverse cancellation guard | 1 | A future task-wide transition can omit the reverse guard, and a run orphaned from every task is outside this task-selected predicate. The poison/invariant surfaces own those adjacent cases. |
| Closed `FENCE_RELATIONS.queueScoped` policy | 1 | The current five relations cannot omit their policy, but adding a semantically wrong Boolean still typechecks. Entry-local true-to-false mutations and the authoritative-cleanup false-to-true mutation declare the current meanings; conformance and the pending exact audit remain their semantic and execution owners. |
| Current-source mutation targets | 2 | A mutation can still target a generated or current seam whose test failure occurs before the intended behavior. Frozen migration rejection removes one known class of dead evidence; exact attributable execution remains necessary for every accepted target. |
| Exact advisory-lease composition | 1/2 | A future advisory method can hand-spell only part of the running/token/queue, future-integer-expiry, or task/run ownership contract. `expireLeaseNow` composes the shared fragments and has condition-local declarations; their current kills remain pending. |
| Sole-live terminalization | 1 for complete, fail, and relaunch cap | A future terminalizing CAS is outside the guarantee until it composes the shared fragment and receives an exact mutation. The current chokepoints are closed; the set of future doors is not generated. |
| One-statement libSQL driver-heartbeat ingress | 1 | A future dialect can implement heartbeat and cleanup as two statements while the SQLite trigger remains correct. Identical cross-dialect conformance, not migration v5 alone, owns portability. |
| TEXT event-payload premise | 1 | A TEXT value that violates a future higher-level payload encoding remains TEXT and passes this storage premise. This repair distinguishes SQL NULL corruption from timeout; it does not broaden the event wire-format contract. |

### Fix-induced defects and red/green topology

Nineteen findings were caused by repairs in this branch: 78 through 80, 91,
100, 102 through 104, 106, 108, 113 through 120, and 123. Added to the
preceding 34, that checkpoint had **53 fix-induced findings**.

Red `963e66d` exposed findings 78 through 92 and 101 through 102. Green
`643dfe7` closed classifier cardinality and the worker lifecycle, retry, and
subsecond-lease boundaries. Green `2619b64` closed the remaining store and
mutation-inventory findings. Red `e8a4558` exposed the independently writable
ownership doors in findings 93 through 99; green `2619b64` routed them through
the shared ownership definitions.

Finding 100 has no standalone failing red commit: review found that the
construction primitive had no per-relation queue policy while the cumulative
red was already open, and the explicit ledger and construction cases landed in
`2619b64`. Finding 103 likewise has no standalone red: mandatory repair review
found that the first new fault surface exercised only deletion of required
queue scope, so the false-to-true authoritative-cleanup mutation landed in the
cumulative green. These exceptions are disclosed rather than represented as
red executions that did not occur.

Finding 104 was found in the first repair state, which incorrectly set
`runs`→`waits` cleanup to `queueScoped: true`. The full libSQL run failed the
cancel/wait queue-mismatch poison cells with wait-on-dead and
wait-on-non-sleeping invariant violations. That failing repair state is the
honest red evidence; `2619b64` makes the authoritative cleanup relation
unscoped and adds the inverse construction mutation.

Red `f010a7f` exposes finding 105; green `dd61820` confines both receipt legs to
the caller's queue. Red `9a549f3` exposes finding 106; green `7671e67` rejects
frozen migration targets and rehomes the driver-cleanup mutations in current
source. Red `2e95237` exposes findings 107 through 110; green `80cafa2` routes
retry, cancellation, and headers through the captured serializer and constructs
the cancellation snapshot with own data properties. Red `83376a8` exposes
findings 111 and 112; green `80cafa2` routes claimed retry and headers through
the captured parser.

Findings 113 through 123 have no standalone red commit. Review found these
machinery and enrollment defects while the cumulative red was open, and their
exact declarations and fixtures landed in `80cafa2`. They are disclosed rather
than assigning red status to that green commit. Removing the now-unused
`trustedMax` helper, direct test, mutation, and verdict is ordinary cleanup: it
is zero findings, adds nothing to the fix-induced total, and has no invented
red.

### Evidence and remaining gate

- `pnpm verify` at `2619b64` passed **80 files / 3,570 tests**, including the
  full libSQL conformance run (**2,827 tests**) and the generated poison cells.
  The mutation self-test enrolled **369 live entries**, 20 attribution cases,
  and 37 orchestration faults. This is the historical 369-entry checkpoint,
  not evidence for the current registry.
- The registry historically grew from 345 to 369: 23 new or restored exact
  condition owners plus the inverse authoritative-cleanup relation mutation.
  Historical
  non-owned `mutation-verdict:` strings moved to `regression:`; three explicit
  machinery fixtures remain exempt.
- At `80cafa2`, the bounded focused ledger passed **80 of 80 assertions**:
  six serializer/parser, six payload-door, two relation/cancellation, six
  `expireLeaseNow`, and sixty SDK worker assertions. The store-libSQL and SDK
  package typechecks passed, and Biome accepted the nine changed TypeScript
  source/test files without fixes.
- The confined full `pnpm verify` at `80cafa2` passed all **81 files / 3,583
  tests**, all eleven lints, format-check, and typecheck. The mutation self-test
  enrolled **385 live entries** and passed 20 attribution, 19 promise-message,
  10 descriptor, two helper-binding, three helper-marker, 16 direct-marker, six
  verdict-inventory, and seven question-delta cases, plus one live-enrollment
  fault and 37 orchestration faults.
- Registry arithmetic is exact: the queue-scoped foreign-receipt owner moves
  369 to 370; frozen-migration work rehomes two existing entries without
  changing the count; `80cafa2` adds 16 exact owners and removes the dead
  `trustedMax` entry, reaching **385**.
- The shared wake-pair test timeout changed from 15 seconds to 30 seconds after
  the new durable SQL guards made isolated runs take 13.8–14.3 seconds. The
  generated case count and assertions are unchanged. This is a disclosed gate
  timing change, not a correctness finding or a reduction in coverage.
- No targeted mutation audit of the new entries and no complete 385-entry audit
  is claimed for this addendum. Current-head fuzz and TLC, the exact-final-head
  remote review, and the complete confined **385-entry** exact audit remain
  pending final-merge evidence. The completed verify and mutation self-test do
  not substitute for those gates.

Built at that checkpoint: one worker-owned lifetime scope; immutable retry authority; exact
subsecond lease cadence; one-read, own-property spawn cancellation; captured
retry/cancellation/header serialization and retry/header parsing; field-specific
pre-CAS durable payload admission; queue-scoped spawn receipts; sole-live
terminalization; one-clock driver heartbeat; shared forward and reverse
task/run ownership; an explicit per-relation queue policy with authoritative
corrupt-wait cleanup and entry-local mutation declarations; fail-closed event
payload typing; exact advisory-lease composition; frozen-migration target
rejection; classifier cardinality; reverse marker ownership; and **385 live
mutations**. Deferred to PR3.10: generate condition and consumer enrollment
from the authoritative sources rather than declaring only the then-current 385
entries.

## Final exact-attribution marathon addendum (2026-08-23)

This addendum owns findings 124 through 273. The round added **48
review-caught findings** (125 through 167 and 268 through 272) and **102
self-caught findings** (124, 168 through 267, and 273), **150 total**: this
repository's machinery found **68.0%** of the round and outside review found
**32.0%**. Cumulatively the branch has **430 review-caught plus 162 self-caught
findings, 592 total**, for a **27.4%** self-catch rate; outside review found
**72.6%**. The required PR trailer is `review-findings: 430`.

Through finding 270, all new findings except the two audit-process gaps, 124
and 168, were caused by the exact-attribution repairs themselves. Findings 271
and 272 predated their closing repairs: the ambiguous settlement value was in
the poison surface from its first red implementation, while wake SQL already
branched before `prepareWake` hoisted that choice. Finding 273 was introduced
by finding 271's first exact-mutation mechanism and caught by its own focused
audit. The expanded round therefore adds **146 fix-induced findings** to the
preceding 53, for **199 cumulative fix-induced findings**. The repair was
re-audited as new code, not merely rerun through its green regression.

Finding 266 recurs immediately after finding 264. Finding 264 proved only that
each materialized TypeScript mutant parses; finding 266 showed that parsing is
still a proxy for the runtime property that every referenced value name is
lexically resolvable. The repair incrementally resolves value bindings for
every Vitest-routed TypeScript mutant before checkpoint or worktree creation,
while both driver mutations now use the canonical
`storedIntegerWithin(PERSISTED_INTEGER_BOUNDS.drivers.*)` representation.
Every TypeScript materialization is parsed, and project-routed construction
mutations retain their typecheck as the authoritative semantic compiler check.

Findings 267 and 269 are written false negatives of that first binding
mechanism: an unresolved class base and an erased type-only import both passed
while the advertised lexical-binding property was false. Finding 268 recurs at
the repository's single-routing-authority boundary because verdict kind stood
beside `typecheck_project` as a competing proxy. Finding 270 is the ordering
form of the same mechanism gap: proving that preflight ran did not prove that
it ran before durable audit setup. The repair uses `typecheck_project` as the
only routing authority, follows type-only alias declarations, preserves class
heritage as an expression, and makes a rejected preflight prove the absence of
checkpoint and worktree artifacts.

The binding preflight has an explicit false-negative boundary. A bound
property-name mutation such as `row.known` → `row.missingColumn` passes because
property names are not lexical value references. A wrong-but-bound identifier
and a type-invalid but bound expression also pass; temporal-dead-zone ordering,
ambient runtime availability, and names introduced through dynamic `eval` are
outside this check. Those exclusions are deliberate: broadening the preflight
into a second behavioral typechecker or evaluator would compete with exact
runtime ownership. Only construction mutations with a declared
`typecheck_project` skip binding rejection; Vitest-routed construction verdicts
cross the same runtime preflight as behavioral verdicts.

Finding 271 recurs after the single-representation rule and the explicit
promise-outcome helpers. Those helpers distinguish success, expected failure,
replacement failure, and unrelated failure, but the poison layer was born
with a second optional-field settlement representation and without its own
settlement faults. The repair returns the canonical discriminated outcome at
the recorder, freezes it before publication, and makes fulfillment of the
responsible invocation part of every healthy-progress decision.

Finding 272 recurs after `batch-lint` and the standing statement that a label
is a claim about shape. The lint's “shape” was static statement count, mode,
and clock placement; label harvesting likewise enrolled the address, not every
legal input that could select a different compiled fragment. Neither mechanism
could see relative/absolute control flow inside `prepareWake`. The repair makes
wake mode data in one SQL definition, while PR3.9 owns the generated
all-label/all-declared-variant corpus needed to replace the focused witness.

Finding 273 recurs after the exact-attribution rule that one mutation changes
one named condition and leaves its generated siblings as controls. The first
deletion changed the shared responsible-rejection branch, so the targeted case
and then ordinary generated poison cases failed before or beside the healthy
settlement owner. The exact mutation audit caught the collision: `cbbb70d` and
`25f5849` were rejected as wrong-path rather than credited. At `2023def`, the
healthy mutation selects only an undefined healthy rejection, and the targeted
mutation changes only which invocation owns settlement; both focused audits
reached their exact sole verdict.

### Closing mechanism audit

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Frozen discriminated poison settlement and responsible-target check | 1 for representation, 2 for current consumers | Within the recorder there is no value that represents both rejected `undefined` and fulfilled `undefined`: `status` is required and the two frozen variants have disjoint payload keys. The literal mutation surface can still omit a future settlement consumer from both source and `MUTATIONS`; the earlier executed undeclared-condition false negative remains PR3.10's boundary. |
| One mode-bound wake SQL topology plus real-batch comparison | 1 for the current `prepareWake` consumers, 2 for enumeration | An executed temporary mutation inserted `${wakeDisposition === 'preserve' ? 'AND 1 = 1' : ''}` into `reschedule`. The current relative/absolute focused case still passed **1/1** because both calls used `consume`; an expanded consume-versus-preserve probe then failed with `{ sqlText: false, bindArity: true }`. The focused case cannot enroll a new input branch, label, statement, or dialect. PR3.9 owns the generated per-dialect label/variant corpus and signature-uniqueness gate. |
| Two exact settlement mutations | 2/3 | A mutation that changes the shared condition broadly still fails several generated siblings: that written boundary produced wrong-path receipts at both `cbbb70d` and `25f5849`. The scoped `2023def` mutations are exact for the two current conditions; a future condition omitted from the registry remains the executed PR3.10 completeness false negative. |

The full 419-entry run at `98c3dee` produced **417 caught entries**, with only
ordinals 257 and 258 wrong-path and **zero survivors or stale entries**. The
coordinator reported infrastructure status 2, rather than its ordinary nonzero
mutation verdict, because documentation changed in the root checkout; its
checkpoints remained authenticated to the audited head. Red `be917fa`
added a failing regression for a syntactically valid unresolved behavioral
mutant. Green `fafcd13` added value-binding resolution, preserved the live
poison controls, and expressed both driver mutations through the canonical
bounded-integer definition. The live binding-enrollment poison was rejected at
its exact runtime-binding diagnostic. The focused two-row audit at `fafcd13`
reached both exact owners.

The required false-negative pass then found finding 267; mandatory adversarial
review found findings 268 through 270. Red `e21ffdb` fails on the unresolved
class base, erased type-only import, and skipped Vitest-routed construction
verdict. Green `fc9171d` closes those three paths and extends the orchestration
self-test with a rejected preflight that leaves no checkpoint or worktree.
Finding 270 has no invented failing product red: production placement was
already correct, while the review finding was that the prior mechanism test
would not detect a future reorder. Its executed old-test false negative and the
new artifact-order proof are the evidence for that mechanism repair. In a
detached `e21ffdb` worktree, moving preflight after checkpoint and worktree
setup left the old confined orchestration self-test green; `fc9171d` makes that
same reorder fail before any artifact can exist.

The full-branch simplify review then found findings 271 and 272. Its decisive
verdicts were: “optional `result`/`error` cannot distinguish
`reject(undefined)` from fulfillment,” and “one `reschedule` or `suspend`
label compiles different SQL text and bind arity from the wake representation.”
Red `67a5c0d` was run against `a00fc27`; both new cases failed (2/2): the
settlement case resolved after the healthy call
committed and rejected with `undefined`, while the real-batch comparison
reported both `reschedule` and `suspend` as `{ sqlText: false, bindArity:
false }`. Green `cbbb70d` installed the closed settlement outcome and fixed
mode-bound wake SQL; the focused batch-shape case passed 1/1, the relevant
wake regressions passed 29/29, and store-libsql typecheck passed. Its first
settlement audit was correctly refused as wrong-path because the broad deletion
also failed the targeted owner. `25f5849` separated the replacement verdict,
but its next audit was still wrong-path through generated poison siblings.
That self-catch is finding 273. `2023def` restricts the mutation to the
undefined-rejection discriminant; separate one-row audits reported `caught`
for `poison-healthy-settlement` and `poison-targeted-settlement-owner`, with
their exact declared verdicts.

The checkpointless-sleep simplify report did not reproduce as a correctness
finding. Every production `ReplayContext.sleep` suspension already carried its
durable marker, `awaitEvent` parks inside its own batch, and no public issuer
could construct the worker's checkpointless sleep branch. `cbbb70d` removes
that unreachable state structurally; it does not increment either detector
ledger. The TypeScript binding simplification likewise retained an explicit
type-only namespace-import control rather than claiming a new finding.

The historical 419-entry run at `98c3dee` and its 417-plus-two follow-up remain
exactly the receipts described above. After the documentation closeout at
`a00fc27`, a clean-head confined audit reported **419/419 caught**, zero
survivors, zero wrong-path entries, and every shard complete. Finding 271's
repair then added two settlement mutations, and finding 273 refined one of
them, so a final clean-head confined **421-entry** rerun remains the final
mutation gate; the 419-entry receipt and focused two-entry receipts do not
claim that result. The pinned TLA+ launcher checksum was separately refreshed
to the official v1.8.0 prerelease asset digest
`sha256:eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`
after that asset changed on 2026-08-21. This preserves the checksum gate rather
than waiving it; the final exact-head TLC run remains pending evidence.
