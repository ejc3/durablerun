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
threads. The final registry has 345 live mutations, including executable
attacks on dispatch, every declared task-realm condition, collision error
attribution, compiler-bind laundering, completion-error origin, single-read
timeouts, and each absolute-wake discriminant.

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

Self-catch rate: **29 of 77, or 37.7%** (previous temporal round: **1 of
43, or 2.3%**). The original 35-finding audit was **24 of 35, or 68.6%**,
but the later boundary and repair rounds were almost entirely review-caught.
The long audit found 22 attribution defects without outside review. It is not
47 self-catches:
`47987c0` reported 42 wrong-path entries and five survivors, but those 47
witnesses collapse to 21 independent causes above. Counting every generated
case as a defect would mix test volume with the site-and-mechanism counting
used by the preceding numeric and temporal postmortems.

The last checked-in cumulative trailer before this closeout was
`review-findings: 289`. The original nightly/mutation round raised it to 300;
the retry/throwable, task-realm, and bind-attribution rounds raise it to
`review-findings: 331`; the final durable-boundary review raises it to
`review-findings: 337`. The previously recorded 30 self-catches rise by 29 to
59. The branch catalogue at final closeout is therefore **337 review-caught
plus 59 self-caught, or 396 total findings**.

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

There were **34 fix-induced findings across the complete closeout**. Thirteen
were in the original nightly/mutation round: finding 2 and findings 24 through
35. Finding 2 was caused by the first fresh-process proof, whose text
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
respectively, for **34 across the complete 77-finding closeout**; their exact
accounting and repair topology appear below.

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
the registry now has 345 declared entries, but even a complete exact audit of
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
  final merge evidence, so the final clean-head 345-entry audit is required
  separately rather than being claimed here.

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
error shape but independent path-owned mutations. The final merge gate must run
the complete 345-entry audit on one clean immutable head; targeted evidence is
not substituted for that cycle.

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
- Targeted repair evidence is not the final mutation gate. The complete
  **345-entry** audit, confined fuzz, TLC, and verify gates must still pass
  together on one later clean immutable head before merge.
