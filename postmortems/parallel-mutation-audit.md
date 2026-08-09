# Postmortem: parallel mutation audit and closeout review (PR #12)

The mutation audit was made safe to run in parallel: one confined coordinator
owns exact-head worker worktrees, proves a baseline barrier, launches
deterministic shards, and reconciles structured reports. Adversarial review
found 40 correctness and mechanism defects while the runner and its repairs
were being built; the branch's own generated checks, required pbox run, and
full gate found five. The resulting design makes process authority explicit, raises
suite transport failures at their source, routes production launch plans
through the same generated fault surface used by self-test, and generates the
process-fixture isolation surface from structural case and control obligations.

**This document is adversarial toward the machinery and blameless toward
people.** The question throughout is what would have made each defect
unwritable or caught it without another review.

## Severity

This is a SEV because the unsafe forms could have mutated the source checkout,
declared a damaged or unconfined audit successful, leaked worker descendants,
or credited an infrastructure failure as evidence that an engine mutation was
caught. The pbox run also proved that host-sized native thread pools could
prevent every worker from reporting, while a host-local pnpm store assumption
could prevent isolated workers from installing. The documentation and checker
defects were correctness defects too: they allowed the gate to claim
protections and commands that were not operative. The worst outcome was a
green mutation audit whose evidence did not come from the exact committed
source under the advertised resource boundary.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Hidden worker mode was not bound to a coordinator-owned worktree and report path | A worker could mutate the primary checkout or publish an arbitrary report | Worker authority boundary | Worker CLI fields were treated as authority | Manifest nonce plus exact root, phase, head, shard, and report binding (rungs 1 and 2) |
| 2 | An environment marker alone impersonated confinement | A heavy audit could run outside a protective cgroup | Process launch boundary | The marker was a proxy for live kernel state | Live cgroup-v2 scope inspection and an unconfined fault (rungs 2 and 3) |
| 3 | Generated tests exercised validators but not coordinator baseline and workspace wiring | Removing re-exec, the baseline barrier, or worktree isolation remained green | Orchestration fault surface | The new layer inherited tests from the layer below it | One canonical coordinator fault inventory executed through the real CLI and launch plans (rungs 1 and 2) |
| 4 | Python equality allowed booleans and floats to impersonate integer report identities | Worker and result attribution could accept malformed identities | Report decoder | Equality was used instead of canonical type decoding | Exact integer type checks plus hostile-value faults (rungs 1 and 2) |
| 5 | Repeat signals could interrupt cleanup after handlers were restored | Worktrees or mutants could leak after interruption | Process lifecycle | Cleanup was not one shielded critical section | `CleanupSignalShield` defers signals through cleanup (rungs 1 and 2) |
| 6 | Cleanup ignored a process group after its leader exited | Live descendants could outlast the audit | Process lifecycle | Leader state stood in for group liveness | Every launched process group is tracked and reaped independently (rungs 1 and 2) |
| 7 | Merely finite memory and CPU limits could still consume essentially the whole host | The supposedly safe audit could starve or crash the machine | Confinement contract | Finite was a proxy for protective | Memory is at most 75 percent of the host, swap is zero, and CPU preserves a host reserve (rungs 1, 2, and 3) |
| 8 | Missing or signaled Vitest output became a completed domain result | Infrastructure damage could receive a mutation verdict | Suite transport boundary | Transport and domain outcomes shared one representation | Source-level `SuiteInfrastructureError` before domain classification (rung 1) |
| 9 | Transport tests bypassed the producer and the first signal fixture actually failed through missing output | Deleting producer checks in `run_suite` or `parse_report` stayed green | Suite producer tests | Tests entered below the behavior they claimed to cover | Real missing, malformed, valid-then-signal, and coherent-report subprocesses exercise the producer (rungs 1 and 2) |
| 10 | AGENTS copied obsolete fixed resource limits | Operators could trust policy that no longer matched `confine.sh` | Process documentation gate | Quantitative policy had two representations | One confinement contract delegates all numbers to `confine.sh` (rung 2) |
| 11 | BUILD still called malformed transport a domain wrong-path result | Plan and runtime disagreed about admissible evidence | Process documentation gate | The transport repair did not update its second representation | One normative top-of-file suite transport contract (rung 2) |
| 12 | The process-doc lint failed open when an owned source was missing | Deleting AGENTS or BUILD could remove policy while the check stayed green | Process documentation gate | Existing files were scanned but required files were not an inventory | Mandatory owned-source inventory with deletion fixtures (rung 2) |
| 13 | The process-doc lint recognized copied numeric spellings rather than the resource-cap property | Equivalent prose could restate obsolete caps without matching | Process documentation gate | Text examples were a syntactic proxy for policy ownership | Exact unique contract prefixes and a single numeric owner (rung 2) |
| 14 | Orchestration faults were duplicated between the runner and lint self-test | A declared condition could remain unexercised | Generated orchestration surface | Two lists had to be maintained together | One canonical fault inventory recursively executes every declared member (rungs 1 and 2) |
| 15 | Structurally incoherent but valid JSON did not attack the final report guard | Deleting count-coherence validation left every fault green | Suite transport fault surface | One malformed example stood in for every malformed condition | A real subprocess emits contradictory valid JSON and must fail at the producer (rungs 1 and 2) |
| 16 | Wrong-registry report rejection was absent from the canonical fault inventory | Removing registry binding was undetected | Worker report fault surface | The documented condition had no mutation | Dedicated wrong-registry injected fault (rung 2) |
| 17 | Incomplete-worker report rejection was absent from the canonical fault inventory | Removing completion binding was undetected | Worker report fault surface | The independently removable guard had no mutation | Dedicated incomplete-worker injected fault (rung 2) |
| 18 | The package `verify:mutations` route was outside process ownership | The command could be deleted or changed to inert text while docs still claimed it ran | Gate composition | Naming a command stood in for executable routing | Parse package JSON and require the exact mutation command; deletion and inert-command fixtures (rung 2) |
| 19 | Canonical process text inside fences or enclosing comments satisfied the lint | An example could impersonate an operative rule | Process documentation gate | Raw occurrence stood in for rendered ownership | Unique byte-zero contract prefixes (rung 2) |
| 20 | An over-indented pseudo fence closer was treated as a real close | Content still rendered as code was accepted as policy | Markdown filter | The filter implemented a spelling proxy for CommonMark | Delete Markdown interpretation and require fixed top-of-file placement (rung 2) |
| 21 | BUILD list-relative indented code was normalized into an operative contract | Code examples could own transport policy | Markdown filter | Whitespace stripping erased ownership | Exact byte-zero prefix without normalization (rung 2) |
| 22 | Raw HTML containers hid contracts while their contents were counted | Raw HTML examples could own process policy | Markdown filter | The hand parser did not model HTML blocks | Exact top-of-file placement eliminates the parser (rung 2) |
| 23 | List-prefixed fences, tag variants, same-line blocks, and incomplete type-one tags escaped the attempted repair | More inert CommonMark forms passed after the first parser fix | Markdown filter | A partial renderer remained a proxy for the property | Delete the renderer; title and contract begin at byte zero (rung 2) |
| 24 | BUILD ownership used stripped prefixes and ignored deindent or a different list parent | A block outside the claimed item looked owned | BUILD section parser | Indentation text stood in for tree ownership | Normative contract moved out of the list; the old item only references it (rung 2) |
| 25 | The exact AGENTS prefix did not terminate the confinement section | A second numeric paragraph extended the rule while the prefix still matched | Process contract boundary | Prefix presence did not prove section extent | Exact unique Overview sentinel immediately closes the section (rung 2) |
| 26 | Hidden-contract negative fixtures could omit unrelated controls | A test could reject for the wrong reason and survive loss of its claimed mechanism | Lint self-test | Fixture validity had no independent oracle | Inventory validator plus generated missing-control mutations; the first repair lacked a preceding standalone red commit (rung 2) |
| 27 | The repaired div fixture swallowed Overview and the nested-comment description overstated its proof | The regression suite told a stronger story than its rendered input | Lint fixture semantics | Gate diagnostics alone could not detect semantic collateral | Blank-line raw-HTML boundary, exact inventory checks, and property-accurate fixture wording (rung 2) |
| 28 | One dropped-control mutation stood in for every fixture-isolation condition | Independently deleting another inventory check remained green | Lint fixture fault surface | One example was treated as coverage of a class | Generated fault-at-every-declared-condition fixtures (rung 2) |
| 29 | An inherited `TOKIO_WORKER_THREADS=1` neutralized the omission fault | The self-test passed after the production cap was removed | Native-thread fault surface | The weakness relied on the ambient environment not already being safe | Fault injection actively removes the inherited cap before exercising the real launch (rung 2) |
| 30 | Pnpm resolver rejection guards were absent from generated faults | Failed, multiline, relative, or missing store results could be accepted undetected | Dependency fault surface | Only a valid resolver result was exercised | Four hostile resolver-result faults through the real decoder (rung 2) |
| 31 | The exact offline frozen install command and resolve-to-install wiring were untested | Workers could perform networked or unlocked installs or ignore the canonical store | Dependency launch surface | Helper output stood in for the production launch plan | One exact `worker_install_launch` used by production and self-test, with command mutations (rungs 1 and 2) |
| 32 | Eleven process-lint BAD_CASE container enrollments were hand-enumerated | A new or removed negative fixture could drift from isolation checks | Lint fixture registry | Enrollment and isolation were separate representations | One declared process-fixture condition registry derives enrollment and fault obligations (rungs 1 and 2) |
| 33 | Exact-one inventory guards had no duplicate mutations | A check that rejected missing controls but accepted duplicates still passed | Lint fixture fault surface | Missing stood in for exact cardinality | Generated missing and duplicate faults for every exact-one control (rung 2) |
| 34 | The guarded-control inventory and injected-fault inventory were separate | A new guard could ship without a fault, or a fault without a guard | Lint fixture fault surface | Two definitions represented one condition set | Conditions own their guard, mutation, and expected attribution in one registry (rung 1) |
| 35 | Mutation-target uniqueness was guarded but not mutated | An ambiguous text replacement could silently attack the wrong fixture location | Lint fixture mutator | The mutator's precondition was trusted rather than attacked | An ambiguous-target fault must fail at the unique-target chokepoint (rung 2) |
| 36 | Preserving-body metadata was exercised only for the fence container | Comment, pre, and div fixtures could corrupt transport text without detection | Lint fixture semantics | One container stood in for every metadata arm | Generated transport-body faults for every preserving container (rung 2) |
| 37 | The Tokio environment helper was tested while production `worker_launch` could bypass it | The self-test could stay green after production stopped applying the cap | Production launch surface | A lower helper stood in for its caller's behavior | Self-test and production both traverse `worker_launch` (rungs 1 and 2) |
| 38 | Coordinator success could be published after a nonzero infrastructure exit when nominal caught rows existed | A damaged audit could finish green | Final reconciliation | Success lacked a process-status and non-vacuity chokepoint | Ordinal reconciliation proves the exact aggregate separately; `may_publish_success` then requires exit zero, nonempty rows, and every outcome caught (rungs 1 and 2) |
| 39 | A zombie leader impersonated a live process group during cleanup | Cleanup failed while already-dead worker leaders remained unreaped | Process lifecycle | `killpg` liveness could not distinguish an unreaped direct child | Poll and reap every tracked `Popen` before process-group probes, then recompute survivors (rungs 1 and 2) |
| 40 | Source and isolated worktrees could resolve different pnpm stores | Offline worker installs failed despite a populated source store | Dependency authority | Each worktree independently chose an implicit store | Resolve one absolute source store once and pass it to every exact worker install (rung 1) |
| 41 | Each Vitest worker could create a host-sized Tokio pool | Parallel baselines exhausted native threads and produced no reports | Worker resource surface | Process concurrency was bounded but native thread pools inside each process were not | Coordinator launch environment caps Tokio workers to one per mutation worker (rungs 1 and 3) |
| 42 | A case could self-disable its own semantic obligations | A new hidden container could omit transport preservation or raw-HTML boundary checks while the generated graph stayed green | Process-fixture obligation graph | Required IDs were projected from the same optional metadata or classifier that generated the obligations | Closed placement types plus an independent total obligation inventory, with every obligation mutated at cardinality zero and two (rungs 1 and 2) |
| 43 | BAD_CASE enrollment proved membership for only one case and ignored duplicates | A generated negative case could be absent or enrolled twice without attributable failure | Gate self-test enrollment surface | One dropped-first probe and membership stood in for exact cardinality across the corpus | All 13 canonical cases are independently mutated at enrollment counts zero and two, and production requires exactly one (rung 2) |
| 44 | Duplicate control identities or generated fault IDs silently overwrote dictionary entries | A declared control or mutation could disappear while the graph appeared complete | Process-fixture registry | Dictionary construction made collision loss valid by construction | Tuple construction, unique control validation, and a collision-rejecting fault index with eight hostile probes (rungs 1 and 2) |
| 45 | Generated BAD_CASE star expansion was not statically enumerable by gate-lint | The repair made the full gate red and hid the generated checker subject from gate composition | Gate composition | Runtime expansion had no literal checker identity in gate-lint's owned AST shape | A generated list comprehension exposes the literal checker identity to the static inventory; full `pnpm verify` exercises it (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial review, findings 1 through 37 and 42 through 44 | 37 + 3 | no |
| Generated coordinator self-test, finding 38 | 1 | yes |
| Required pbox and mechanism audit, findings 39 through 41 | 3 | yes |
| Full `pnpm verify`, finding 45 | 1 | yes |

Self-catch rate: **5 of 45, or 11.1%** (previous round: **7 of 21, or
33.3%**). This remains a material regression. The runner gained stronger
machinery, but most defects in that machinery were still found from outside
it. Before this round the PR recorded 186 review findings and 24 self-catches.
The cumulative ledger is now **226 review findings, 29 self-catches, and 255
total findings**; the PR trailer must therefore declare
`review-findings: 226`.

## Recurrence

The dominant recurrence was a proxy standing in for a property. Environment
text stood in for a cgroup, finite stood in for protective, leader exit stood
in for process-group death, preclassified results stood in for producer
behavior, and raw Markdown text stood in for an operative contract. This is
the same class documented in the earlier SQL-fence and gate-composition
rounds. It recurred again because each repair strengthened the picture of the
property instead of owning the property at one chokepoint.

The second recurrence was scoped-review inheritance. A new coordinator layer
relied on validator tests from below it; later the Tokio helper, pnpm command
builder, and fixture inventory were tested without proving their production
callers. That repeats the SDK lesson that every new layer needs its own
generated fault surface at birth.

The third recurrence was wrong-reason testing. Findings 9, 15, 26 through 29,
32 through 37, and 42 through 44 all passed while bypassing or damaging the
behavior their names claimed. The Markdown sequence made the pattern especially visible:
occurrence filtering, then fence and comment filtering, then a larger
CommonMark lexer. The recurrence stopped only when the parser was deleted and
the contracts were moved to fixed byte-zero prefixes. The fixture sequence
then repeated it at a smaller scale: declared cases shared optional metadata,
membership stood in for exact cardinality, and dictionaries silently erased
collisions. It stopped only when placement shapes owned the possible
obligations and independent zero/two mutations attacked every graph edge.

Finding 45 is gate-integration recurrence. The generated cases were correct at
runtime, but their star expansion was outside the static syntax that
`gate-lint` recognizes. The full gate did its job and caught this
fix-induced mismatch before another review; the repair made the generated
shape statically enumerable instead of weakening the inventory.

## Mechanism audit — the false negative of each

Every executed case below was written and run. “Still passes” is the honest
boundary: it names a defect that the mechanism does not claim to prevent.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Worker authority manifest and exact-head worktrees | 1 and 2 | Executed: wrong root, head, phase, nonce, shard, report, and non-worktree faults. Still passes: a compromised Git executable or kernel can lie about identity; that is outside this process model. |
| Live protective cgroup proof and job derivation | 2 and 3 | Executed: unconfined, swap-enabled, over-memory, over-CPU, and excessive-job scopes. Still passes: a kernel that reports false cgroup values; within the supported cgroup-v2 interface every claimed cap is read live. |
| Canonical orchestration fault registry | 1 and 2 | Executed: every one of the current 34 declared coordinator faults through the CLI. Still passes: a future guard that is never declared. PR3.10 owns the ratchet from declared-fault completeness toward condition completeness. |
| Canonical integer and report decoding | 1 and 2 | Executed: boolean, float, missing, wrong-registry, incomplete, contradictory-count, and wrong-ordinal reports. Still passes: structurally coherent values produced by malicious exact-head worker code; authority and source isolation are separate mechanisms. |
| Source-level suite transport exception | 1 | Executed: missing output, malformed output, coherent output followed by a signal, and incoherent valid JSON. Still passes: coherent JSON and exit status that both lie about whether Vitest executed; the boundary is transport coherence, not Vitest internals. |
| Cleanup signal shield and tracked process groups | 1 and 2 | Executed: repeat signal, exited leader with a live descendant, and unreaped zombie leader. Still passes: a descendant that creates a new session and leaves the tracked process group; that escape is outside the supported worker contract. |
| Exact aggregate reconciliation and publication guard | 1 and 2 | Executed: missing, duplicate, wrong-registry, incomplete, empty, nominal-caught-with-nonzero-status, and uncaught result sets. Still passes: an exact complete all-caught set fabricated by malicious exact-head worker code; worker authority excludes that producer separately. |
| Canonical pnpm store and exact install launch | 1 and 2 | Executed: failed, empty, multiline, relative, missing, worker-local, online, unfrozen, and replaced-command faults. Still passes: a valid absolute store whose contents are corrupt; install failure is transport failure rather than store-path validation. |
| Exact byte-zero process contracts and package route | 2 | Executed: missing source, inert package command, copied cap spellings, fences, comments, HTML, indentation, duplicate sentinels, and extended-section fixtures. Still passes: confusing non-normative prose after the owned section; the checker proves ownership, not prose quality. |
| Structural process-fixture obligation graph | 1 and 2 | Executed: 25 ordinary isolation faults, 26 BAD_CASE enrollment cardinality mutations, 20 semantic-obligation cardinality mutations, 28 control-fault cardinality mutations, and eight collision probes. During construction, projecting required IDs from generated obligations and sharing the same preservation classifier were both written and run; each still passed after the obligation was deleted, proving the same self-disable finding before the independent classifier repair. Still passes: a semantic rule omitted from both `hidden_process_case_obligations` and the independent `hidden_process_case_fault_ids` oracle, or a case omitted entirely from `hidden_process_cases`; PR3.10 owns declaration pressure. |
| Static gate self-test inventory | 2 | Executed: the generated star expansion made full `pnpm verify` fail because BAD_CASES had no literal checker name; the list-comprehension repair is statically enumerable and still generates all cases. Still passes: a literal checker name paired with a runtime payload generator that returns the wrong files; the BAD_CASE executions and graph attribution catch that separately. |
| Production launch-plan ownership | 1 and 2 | Executed: exact install-command and missing Tokio-cap faults through `worker_install_launch` and `worker_launch`. Still passes: a future independent child-process launcher that is not a worker launch; its layer must receive its own generated surface. |
| Per-worker Tokio cap | 1 and 3 | Executed: sixteen pbox workers completed with `TOKIO_WORKER_THREADS=1`; removing the cap reproduced native-thread exhaustion, including with a safe inherited value deliberately removed by fault injection. Still passes: non-Tokio libraries can create their own host-sized pools. |

## Fix-induced defects

**32 of the 40 review findings were induced by fixes earlier in this round:**
findings 7, 9, 11 through 37, and 42 through 44. The first confinement repair accepted
oversized finite scopes; the first transport repair tested below its producer
and left documentation stale; the first doc checker introduced another
textual proxy; the first canonical inventory omitted independent guards; and
each Markdown and fixture repair created the next parser or duplicated
inventory surface. The dependency and Tokio fixes were initially tested below
their production launchers, and the first per-fixture mutation was another
single-example proxy.

The eight review findings not induced by same-round repairs were findings 1
through 6, 8, and 10. Self-caught finding 45 was also induced by the fixture
repair, so **33 of all 45 findings** were fix-induced. Every subsequent repair
was re-reviewed as new code, not merely re-tested. That is why the sequence is
long: retesting confirmed the examples, while re-review kept finding that the
mechanism's boundary was wider than the example.

## Evidence

- Finding 1, adversarial review: “hidden worker mode is not bound to the
  coordinator-owned worktree or report.” Red `eadbef6`; green `dc60f57`.
- Finding 2, adversarial review: “an environment variable alone can bypass
  confinement.” Red `eadbef6`; green `dc60f57`.
- Finding 3, adversarial review: “generated tests stop below coordinator
  baseline and workspace wiring.” Red `eadbef6`; green `dc60f57`.
- Finding 4, adversarial review: “report validation accepts booleans and
  floats as integer identity fields.” Red `eadbef6`; green `dc60f57`.
- Finding 5, adversarial review: “signal handlers are restored before cleanup
  is protected from a repeat signal.” Red `eadbef6`; green `dc60f57`.
- Finding 6, adversarial review: “an exited process-group leader hides live
  descendants.” Red `eadbef6`; green `dc60f57`.
- Finding 7, adversarial re-review: “finite does not mean protective; these
  caps can still consume the host.” Red `26c34f6` and `71ac008`; green
  `dc60f57`.
- Finding 8, adversarial review: “missing or signaled suite output is being
  classified as a mutation outcome.” Red `eadbef6` and `26c34f6`; green
  `dc60f57`.
- Finding 9, adversarial re-review: “transport fault tests manually construct
  already-tagged results.” Red `5bf2686` and `95f136f`; green `ad55440`.
- Finding 10, adversarial review: “AGENTS duplicates fixed limits owned by
  confine.sh.” Red `9b04b02`; green `ad55440`.
- Finding 11, adversarial re-review: “BUILD still describes malformed
  transport as a domain wrong-path result.” Red `9b04b02`; green `ad55440`.
- Finding 12, adversarial re-review: “the process-doc check fails open when an
  owned source is absent.” Red `1ec37e4`; green `ad55440`.
- Finding 13, adversarial re-review: “the cap lint matches spellings, not the
  single-owner property.” Red `1ec37e4`; green `ad55440`.
- Finding 14, adversarial re-review: “the orchestration fault inventory has
  two definitions.” Red `7785023`; green `ad55440`.
- Finding 15, adversarial re-review: “valid JSON with incoherent counts does
  not exercise the structural guard.” Red `26d764e`; green `c5b8a17`.
- Finding 16, adversarial re-review: “wrong-registry rejection is documented
  but has no mutation.” Red `26d764e`; green `c5b8a17`.
- Finding 17, adversarial re-review: “incomplete-worker rejection is
  documented but has no mutation.” Red `26d764e`; green `c5b8a17`.
- Finding 18, adversarial re-review: “package routing is outside the executable
  process contract.” Red `16a0204`; green `c5b8a17`.
- Finding 19, adversarial re-review: “a fence or comment can own supposedly
  operative process text.” Red `14355ff`; green `c5b8a17`.
- Finding 20, adversarial re-review: “the pseudo fence closer is not a
  CommonMark close.” Red `66aa0a4`; green `47e17ab`.
- Finding 21, adversarial re-review: “list-relative indented code is treated
  as operative.” Red `66aa0a4`; green `47e17ab`.
- Finding 22, adversarial re-review: “raw HTML containers are treated as
  operative.” Red `66aa0a4`; green `47e17ab`.
- Finding 23, adversarial re-review: “the hand lexer is still a proxy for
  CommonMark.” Red `b42aefd`; green `47e17ab`.
- Finding 24, adversarial re-review: “BUILD ownership survives deindent or a
  different list parent.” Red `b42aefd`; green `47e17ab`.
- Finding 25, adversarial re-review: “the confinement prefix does not prove
  where its section ends.” Red `bc5bfd1`; green `44a9547`.
- Finding 26, adversarial re-review: “negative fixtures can reject because an
  unrelated control is absent.” The first correction was bundled into
  `44a9547` before a standalone red was committed. That is a process failure,
  not evidence to relabel: the later `6273ffc` red and `e50ca0d` green prove an
  adjacent dropped-control case but do not retroactively supply this finding's
  missing red checkpoint.
- Finding 27, adversarial re-review: “the div swallows Overview, and the nested
  comment fixture claims more than it proves.” Red `1f44c32`; green `6430b6b`.
- Finding 28, adversarial re-review: “one dropped control does not prove every
  fixture isolation condition.” The initial proxy was red `6273ffc`, green
  `e50ca0d`; the class-level red was `e875099`, green `828563d`.
- Finding 29, adversarial re-review: “an inherited Tokio cap makes the omission
  fault inert.” Red `cd59355`; green `f62d7ad`.
- Finding 30, adversarial re-review: “pnpm fault injection does not exercise
  resolver rejection guards.” Red `2552af2`; green `c1b518b`.
- Finding 31, adversarial re-review: “the exact command and production
  resolve-to-install wiring remain untested.” Red `2552af2`; green `c1b518b`.
- Finding 32, adversarial re-review: “eleven gate-lint BAD_CASE container
  enrollments are hand-enumerated.” Red `445e2b4`; the green fixture-registry
  repair is `5bda8d2`.
- Finding 33, adversarial re-review: “exact-one duplicate arms are not
  mutated.” Red `445e2b4`; green `5bda8d2`.
- Finding 34, adversarial re-review: “the guarded-control inventory and fault
  inventory are separate definitions.” Red `445e2b4`; green `5bda8d2`.
- Finding 35, adversarial re-review: “the mutation-target uniqueness guard is
  unmutated.” Red `445e2b4`; green `5bda8d2`.
- Finding 36, adversarial re-review: “preserving-body metadata is exercised
  only for the fence container.” Red `445e2b4`; green `5bda8d2`. The red
  checkpoint reported 22 missing fault obligations; that initial graph was
  subsequently strengthened by findings 42 through 44.
- Finding 37, adversarial re-review: “the Tokio helper is tested, but
  `worker_launch` can bypass it.” Red `2552af2`; green `c1b518b`.
- Finding 38, generated coordinator self-test: “infrastructure success can be
  published after nonzero status when nominal caught rows exist.” Red
  `eadbef6`; green `dc60f57`. The executed surface includes empty inventory,
  nominal caught rows with nonzero status, and a normal all-caught success.
- Finding 39, required pbox cleanup probe: “process cleanup: a zombie leader
  impersonated a live group.” Red `5733a8f`; green `cfff8be`. The preliminary
  high-core run left 15 fake process groups reported as unreapable.
- Finding 40, required pbox dependency probe: “worker install did not use the
  coordinator's canonical pnpm store.” Red `3b4be64`; green `212d6c5`. The
  reproduced failure was `ERR_PNPM_NO_OFFLINE_TARBALL` after source and
  temporary worktrees selected different stores.
- Finding 41, required pbox resource probe: “worker suites can create
  host-sized Tokio pools.” Red `b392213`; green `b5fb2d9`. Eight concurrent
  baselines all exited without reports after native-thread spawn failures;
  with one Tokio worker, all eight passed.
- Finding 42, adversarial re-review: “case obligations can self-disable.”
  Red `d0f0b8e`; green `6104033`. Adding `section` cases with false
  preservation metadata omitted their boundary and transport obligations.
  The red run reported missing `agents-section-boundary` and
  `build-section-transport-body` faults.
  During construction, a required-ID projection from the generated graph and
  then a required-ID classifier shared with the generator were each mutated;
  both stayed green when the obligation was deleted. Those are executed
  false-negative boundaries and repair evidence for this same finding, not
  additional product findings. The final closed placement shapes drive
  generation while an independent total classifier supplies the cardinality
  oracle.
- Finding 43, adversarial re-review: “BAD_CASE enrollment checks only the
  first loss and membership.” Red `d0f0b8e`; green `6104033`. The final
  surface mutates all 13 cases at counts zero and two, for 26 independently
  attributed enrollment faults; the red run emitted 13 duplicate-case
  diagnostics because count two was accepted.
- Finding 44, adversarial re-review: “duplicate control keys and fault IDs
  overwrite silently.” Red `d0f0b8e`; green `6104033`. Seven duplicate
  control-identity probes and one cross-document fault-ID collision now fail
  before a tuple can be indexed; all eight were accepted in the red run.
- Finding 45, full-gate self-catch: generated `BAD_CASES` star expansion was
  invisible to `gate-lint`'s static inventory. Full `pnpm verify` at
  `5bda8d2` failed with “BAD_CASES contains an entry with no literal checker
  name.” Green `d823086` expresses the generated corpus as a list
  comprehension whose tuple has a literal checker name. This finding was
  induced by the fixture repair and caught by the branch's gate before review.
- At exact head `b5fb2d9`, the pbox audit ran with 16 jobs and at most 11
  Vitest workers per job. All 16 installs and all 16 baselines passed, all 50
  registry mutations were attributable and caught, and the audit exited zero.
  That historical head exercised the then-current 27 coordinator faults;
  later review repairs expanded the canonical inventory to 34.
- At code head `6104033`, full `pnpm verify` passed 68 test files and 1,652
  tests. `pnpm verify:fuzz` passed 2,000 seeds of 100 steps over 32 shards,
  followed by 43 files and 1,395 tests, in 42.96 seconds. The final fixture
  surface executes 25 ordinary isolation faults: 14 control faults, six BUILD
  transport-body faults, four raw-HTML boundary faults, and one ambiguous
  mutation-target fault. It additionally executes 26 BAD_CASE, 20 semantic
  obligation, and 28 control-fault cardinality mutations, plus eight collision
  probes. These local results do not relabel the earlier pbox run as
  exact-final-head evidence. The proposed pbox rerun was later superseded by
  the repository's confined local clean-head audit; pbox is not part of the
  final evidence path.
- Disconfirmed: wrong-registry and incomplete-worker weakness switches are not
  reachable from normal audit mode; CLI routing confines them to generated
  self-test mode.
- Disconfirmed: the fixed byte-zero prefix needs no CommonMark parser. No
  earlier byte can open a fence, list, comment, or raw HTML block, and the
  exact Overview sentinel closes the AGENTS section.
- Disconfirmed: `may_publish_success` alone proves aggregate completeness. It
  does not; ordinal reconciliation first requires exactly the expected
  ordinals and reorders them, after which publication checks status,
  non-vacuity, and caught outcomes.

## Root cause

The coordinator was initially treated as plumbing around a verified
classifier. It is actually a protocol layer with independent authority,
resource, dependency, process-lifecycle, transport, and reconciliation
invariants. Without its own generated fault surface, each invariant was
represented by an assumption or a test helper.

The repair cycle then repeatedly substituted a broader syntactic model or a
single example for the missing structure. The process-doc sequence is the
clearest example: search text, filter examples, approximate CommonMark, then
finally make ownership a fixed location. The fixture, dependency, and launch
sequences repeated the same error by testing one container or helper while
the property lived across every declared condition or in its production
caller. Even after the fixture cases were generated, optional per-case
metadata could delete both a semantic obligation and the evidence expected to
prove it; projecting the oracle from the generated graph repeated that
self-disable. The repair needed independent total views over a closed
placement shape, not a larger shared list.

The pbox failures exposed a second root cause: the coordinator bounded its
own process count but did not initially own resources and dependencies
created below that boundary. Native runtimes derived thread counts from the
host, and isolated worktrees derived stores from their own filesystem
location. Both choices had to become explicit coordinator-owned inputs.

## Mechanisms

Built in this PR:

- A coordinator-owned `WorkerAuthority` shape binds exact head, isolated
  worktree, phase, nonce, shard, and report (rung 1).
- One outer live cgroup proof bounds aggregate memory, swap, CPU, tasks, and
  worker concurrency (rungs 2 and 3).
- A canonical generated orchestration surface covers all 34 currently
  declared faults and executes them through the real CLI and launch plans
  (rung 2, with single-definition portions at rung 1).
- Suite infrastructure failures become an exception at `parse_report` and
  `run_suite`; only valid `SuiteResult` values reach domain classification
  (rung 1).
- Cleanup shields signals, owns process groups independently of leader state,
  and reaps tracked direct children before probing survivors (rungs 1 and 2).
- Exact aggregate ordinal reconciliation precedes a publication chokepoint
  requiring zero infrastructure status, nonempty rows, and all outcomes
  caught (rungs 1 and 2).
- The coordinator resolves one absolute pnpm store, and one production-owned
  install plan applies the exact offline frozen command to every worktree
  (rung 1).
- The production worker launch owns a one-thread Tokio environment, and its
  omission fault actively removes a safe inherited value (rungs 1 and 2).
- AGENTS and BUILD contracts have exact unique byte-zero prefixes, AGENTS has
  an exact Overview boundary, and package JSON binds the executable route
  (rung 2).
- Closed process-fixture placement types derive 25 ordinary isolation faults,
  while independent exact-cardinality surfaces execute 26 BAD_CASE, 20
  semantic-obligation, and 28 control-fault mutations. Unique control
  validation and a collision-rejecting fault index add eight hostile collision
  probes (rungs 1 and 2).
- The generated BAD_CASE corpus keeps a literal checker identity in the AST
  shape owned by `gate-lint`, so runtime generation and static gate
  composition agree (rung 2).

Deferred (recorded in BUILD.md):

- **PR3.10 condition-mutation ratchet** will require one attributable mutation
  per claimed branch and enum literal. The current registries are complete for
  their 34 declared coordinator faults and the final declared fixture graph,
  but a future condition can still fail to register itself. The deferral is
  explicit because the cardinality mechanisms prove declared semantic
  obligations, not that every future semantic guard has been declared.

## What this round still would not catch

A future coordinator condition or fixture semantic can still ship without a
fault if it is omitted from both its generator and independent oracle; total
matches reject unknown runtime placement shapes, while PR3.10 owns broader
declaration pressure. A literal checker name can still front a payload
generator that returns the wrong files; runtime BAD_CASE execution and graph
attribution are the separate protection.
A structurally coherent but dishonest Vitest report is outside the transport
checker. A worker descendant that escapes into a new session leaves the
supported process-group model. Valid but corrupt contents at an otherwise
canonical pnpm store surface as an install failure rather than a
store-authority violation. Non-Tokio libraries can still derive host-sized
internal pools. Finally, byte-zero contracts establish normative ownership but
cannot prevent later non-normative prose from being confusing. These are the
executed boundaries above, not claims of stronger completeness.
