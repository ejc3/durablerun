# Postmortem: persisted numeric-domain containment review (PR #12)

The PR3.7 closeout had one total decoder for dialect-returned integers and a
generated poison surface for corrupt durable state, but those mechanisms did
not bind a value to its exact persisted field or prove that every transition
consuming that field refused corruption at its authoritative CAS. The first
adversarial round found twenty-one counter-domain defects across the type
surface, generated fault surface, claim and sweep doors, terminal quiescence,
and checkpoint ownership. The temporal addendum records the adjacent audit:
forty-two further review-caught findings (six induced by the first repair) and
one additional consumer defect caught by the generated poison matrix before
the repair was committed. The reviewed branch was not
safe to land: corrupt counters or timestamps could consume bounded selection
budgets, same-token receipts could return ineligible work, derived arithmetic
could cross a protocol ceiling, terminalizing transitions could remain stuck,
and checkpoint operations could extend a lease or park a run before discovering
that their authority was invalid.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question throughout is what would have made each defect
unwritable or caught it without another review.

## Severity

The worst safety finding was checkpoint LWW ownership. A conflicting
checkpoint row could carry a fractional, out-of-range, missing, or mismatched
owner relation. The leading CAS still extended the worker lease or parked the
run, then the LWW upsert silently dropped the incoming checkpoint. For
`suspendRun`, that is the forbidden split outcome: the run can sleep without
the marker that makes its state resumable.

The worst progress findings were at bounded selection and terminal
reconciliation. Claim and sweep could let a corrupt earlier row consume the
per-call limit and starve healthy work. Conversely, a terminal task could keep
a claimed run alive forever because a terminalizing fail or sweep CAS reused
live-owner accounting guards. A later repair put the right numeric predicates
on the advisory sweep scan but not on the terminal lost-launch cap CAS; a
post-scan change from `activated_gen = 0` to the exact integer `-1` could
therefore be consumed by numeric comparison after the scan had proved a
different value.

The mechanism findings are SEV-level too. Equal numeric endpoints were allowed
to stand in for semantic field identity, a nominal descriptor could be forged
by object spread, and generated poison volume did not prove that the corrupt
subject reached the branch it named. Those are false assurances in the
machinery intended to prevent exactly these production escapes.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Persisted integer bounds were anonymous endpoint pairs, so equal-looking field domains were interchangeable | A caller could validate one durable field with another field's semantic contract and receive a plausible result | Core numeric type boundary | Numeric interval stood in for durable field identity | Canonical field-keyed descriptors with nominal private identity (rung 1) |
| 2 | SQL predicates and row decoders accepted the column or value separately from the chosen bounds | A union, cast, or adjacent same-shaped argument could restore a mismatched field and interval even after branding | Store numeric construction boundary | The two halves of one property remained independently spellable | Descriptor-owned field selection for SQL and persisted-row decoding (rung 1) |
| 3 | Persisted fields, derived SQL results, positive claim generations, and incrementable claim generations shared a generic bounds menu | A valid maximum claim receipt could be rejected, or a derived duration could be decoded as a persisted counter | Numeric consumer API | Refinement intent lived at each caller instead of in fixed entry points | Separate persisted, derived, run-ordinal, positive-claim, and incrementable-claim APIs (rung 1) |
| 4 | The first nominal descriptor repair used a spreadable plain object whose endpoints could be replaced while its apparent domain survived | A forged descriptor could widen a durable field to `Number.MAX_SAFE_INTEGER` and compile | Core descriptor construction | A symbol brand on data was a proxy for unforgeable canonical identity | Frozen class instances with private domain state and a prototype field getter; spread loses the type (rung 1) |
| 5 | Persisted counter fields, invariant conditions, storage corruptions, and witness IDs were maintained in separate inventories | A field such as `max_attempts` or `owner_attempt` could be absent from one surface while completeness still reported green | Invariant and poison inventory | Each list proved only itself | One `PERSISTED_COUNTER_FIELDS` contract generates field identity, bounds, condition IDs, and witnesses (rung 1, with rung-2 cardinality pins) |
| 6 | Counter poison covered representative upper failures but not every lower boundary or worsening magnitude on the same structured subject | A transition could move an already-invalid counter farther out of range while the oracle saw only the same categorical finding | Poison severity oracle | Finding presence stood in for numeric severity and one side stood in for the interval | Generated upper and lower witnesses plus exact distance-from-bound severity (rung 2) |
| 7 | Branch-targeted poison did not prove that its corrupt subject was due, ordered before the healthy trigger, otherwise eligible, and classified into the named claim or sweep arm | The target could be decorative while another refusal or later healthy row made the case pass | Generated consumer fault surface | Label execution and after-state cleanliness stood in for branch reachability | Generated lifecycle profiles, companion counters, ordering checks, and explicit unreachable reasons (rung 2) |
| 8 | Claim candidate selection did not compose activation order, incrementable claim generation, relaunch bounds, current accounting, user-attempt budget, or highest-owned ordinal before each limit | A corrupt early candidate could spend the bounded claim budget, starve healthy work, or be launched under a stale ordinal | Claim candidate CAS | Existing guards covered liveness and sole ownership, not the complete numeric eligibility property | One current-accounting and highest-owned composition inside both ordered claim legs (rung 1 for the shared shape, rung 2 for exact mutations) |
| 9 | The same-token claim receipt bypassed the candidate CAS's numeric eligibility and could return an exhausted, activated-ahead, obsolete, or out-of-range run | A retry after a lost response could hand corrupt work to a worker even though a fresh claim would refuse it | Claim receipt boundary | Durable token identity was treated as sufficient authority for returned contents | Receipt recomposes the persisted bounds and ownership relations while allowing the legal maximum positive claim generation (rungs 1 and 2) |
| 10 | Activation did not revalidate relaunch bounds, current accounting, or highest ownership after claim | Corruption introduced between claim and activation could turn an issued launch into executable stale work | Activation CAS | Claim-time validation was treated as authority for a later CAS | Activation composes the same canonical persisted accounting and ownership fragments (rung 1, with rung-2 interleaving regressions) |
| 11 | The expired-run advisory scan did not reject every branch-relevant corrupt counter before its limit | A corrupt expired row could consume the sweep budget and hide healthy reconciliation work | Sweep discovery | A bounded advisory read was treated as harmless even though its ordering decides progress | Branch-specific sweep admissibility in the production scan and generated target profiles (rungs 1 and 2) |
| 12 | Lost-launch and claim-timeout CASes did not recheck current accounting after the advisory scan | A concurrent corruption between scan and CAS could be amplified into reopen, failure, or a successor | Sweep winning CASes | Discovery evidence was mistaken for mutation authority | The same current-accounting property gates discovery and each live-owner CAS (rung 1, with a post-scan interposition test at rung 2) |
| 13 | Successor and cap branches accepted invalid source ordinals or counters and used broad cap comparisons | Overflowed arithmetic could create an out-of-contract run, while a poisoned value above a cap could be laundered as legitimate exhaustion | Successor construction and cap terminalization | Native integer storage and a threshold comparison stood in for exact domain membership and one-step headroom | Canonical incrementable-ordinal guards and exact cap equality before successor or terminal writes (rung 1) |
| 14 | The first containment repair applied live-owner accounting and highest-ordinal guards to terminalizing fail and sweep branches | A terminal task's claimed run could remain running forever instead of being quiesced | TerminalStability contract and consumer review | One shared admissibility predicate erased the distinction between reviving and terminalizing writes | Explicit live-owner versus terminal-owner branch shapes; terminalizing CASes leave task state inert and still close the run (rungs 1 and 2) |
| 15 | Sweep decoded and guarded `relaunch_count` for an activated claim-timeout branch that does not consume it | Unrelated relaunch corruption could prevent a terminal owner's expired activated run from quiescing | Branch-local numeric contract | A convenient sweep-wide counter bundle stood in for the fields each branch actually consumes | Generation-only terminal timeout admissibility and relaunch validation only on lost-launch arms (rung 1, with exact corruption regression at rung 2) |
| 16 | The terminal lost-launch cap CAS did not recompose the scan's native lower bound for `activated_gen` | Changing `activated_gen` from `0` to exact INTEGER `-1` after scan could pass `activated_gen < claim_gen` and be consumed as a valid cap exhaustion | Sweep scan-to-CAS authority boundary | The repair guarded the advisory classifier but not every numeric predicate at the winning terminal CAS | Recompose terminal generation and cap predicates at the CAS and add an exact post-scan mutation (rungs 1 and 2) |
| 17 | Checkpoint-producing CASes checked only that the incoming run attempt had native integer storage, not that it was fractional-free and within the run-ordinal domain | The lease could extend before the checkpoint follow-on rejected or persisted an invalid owner ordinal | Checkpoint and suspension leading CASes | SQLite storage class stood in for the semantic run ordinal | Canonical `runs.attempt` predicate on the leading CAS and fenced source row (rung 1, with fractional and overflow regressions at rung 2) |
| 18 | `getCheckpoints(attempt)` used checkpoint-owner bounds for a caller-supplied run ordinal and admitted non-number values such as bigint | A hostile JavaScript caller crossed the port through the wrong semantic domain; equal endpoints hid the swap | Public store port boundary | Equal intervals were treated as interchangeable and the generic decoder accepted dialect bigint on a client input | `requireRunOrdinal` closes over `runs.attempt` and requires a JavaScript number before SQL (rung 1) |
| 19 | Checkpoint reads trusted `owner_run_id`, task, queue, and owner attempt without proving one exact owning run row | A forged checkpoint could become visible at a plausible ordinal | Checkpoint visibility query and invariant relation | An owner-attempt comparison stood in for complete ownership identity | One exact checkpoint-owner relation joins the checkpoint to its run and is shared with write validation (rung 1, with rung-2 forged-owner cases) |
| 20 | The existing row consumed by checkpoint LWW was not validated before the leading lease-extension or suspension CAS | A malformed conflict could silently drop the checkpoint after extending the lease or parking the run | Atomic checkpoint protocol | Incoming ownership was validated, but the pre-existing conflict row was treated as inert data | Conflict-key validation proves queue plus exact owner identity and ordinal before the CAS; a valid higher owner remains a legal silent LWW drop (rungs 1 and 2) |
| 21 | `activate` did not validate the caller-supplied claim generation at the port | String and bigint values could be coerced by libSQL affinity into a winning generation CAS | Public activation port boundary | Fixed persisted descriptors protected stored rows but not the untyped caller value compared with them | A fixed positive claim-generation input validator runs before SQL and hostile non-number probes pin it (rung 1, with rung-2 regression) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Numeric-domain adversarial review and mandatory repair re-reviews, findings 1 through 15 and 17 through 20 | 19 | no |
| Final independent numeric review plus reproducer analysis, findings 16 and 21 | 2 | no |

Self-catch rate: **0 of 21, or 0%** (previous round: **5 of 45, or
11.1%**). Every red test in this round was written after an outside review
identified the defect, so none is retroactive self-detection. This is an
eleven-point regression and means the existing invariant and poison machinery
was still much better at classifying durable corruption than at proving every
consumer contained it.

The canonical round count is **21 review-caught findings**: nineteen from the
numeric-domain review and its mandatory repair re-reviews, plus the two
independent final-pass findings. There is no aggregate mismatch between the
Findings table and the detection ledger. The previously recorded cumulative
PR trailer was 226 review findings; this round raises it to
`review-findings: 247`. The branch-wide total at this checkpoint is therefore
247 review-caught plus the previously recorded 29 self-catches, or 276
findings.

## Recurrence

Findings 1 through 4 recur after the single-representation rule and the prior
portable integer decoder. The decoder made number and bigint comparison exact,
but callers still chose a value, a field, an interval, and a refinement
independently. The old mechanism checked “this value is inside these
endpoints.” The property is “this exact durable field crossed its one canonical
domain through an entry point whose lifecycle meaning is fixed.” Finding 4 is
especially direct evidence that the first repair remained a proxy: nominal
data copied by spread was not nominal authority.

Findings 5 through 7 recur after the generated poison surface. Enumeration
again created volume without proving causality. A witness inventory generated
from its own declarations cannot prove that every durable field was declared;
a finding ID cannot prove numeric worsening; and executing a label cannot
prove the corrupt subject reached the named branch before the limit. This is
the same progress-floor and self-owned-inventory class recorded in the PR3.7
provenance and mutation-audit rounds.

Findings 8 through 13 recur after claim's canonical eligibility work. Liveness,
sole-live ownership, and wait unambiguity were structurally composed, but the
numeric accounting property stayed spread across consumers. Claim selection,
receipt, activation, sweep discovery, and the post-scan CASes are separate
doors. Protecting one did not protect the others, and protecting an advisory
scan did not authorize the later write.

Findings 14 through 16 recur after the standing terminal-stability rule.
“Validate more counters” was applied without preserving the rule's two
different obligations: reviving writes require a valid live owner;
terminalizing writes must still quiesce a run beneath an inert terminal task.
The first repair then grouped branch-unrelated counters, and the next repair
left the winning terminal CAS weaker than the advisory scan. This class
recurred during the same round because the mechanisms described convenient
shared SQL rather than each branch's consumed property.

Findings 17 through 20 recur after checkpoint lease fencing and LWW were
documented. The fence proved the incoming worker token, while ordinal checks
proved only a storage class or a scalar comparison. Neither proved the exact
incoming run domain, the read row's owner relation, nor the pre-existing
conflict row that decides whether the checkpoint follow-on writes. The
property spans both sides of the upsert and therefore has to gate the leading
CAS, not merely the insert.

Finding 21 recurs after the port-boundary numeric rule and repeats the
new-layer-scoping failure. The stored field received a fixed positive-domain
decoder, but the caller value used by activation remained trusted because its
TypeScript signature said `number`. Values crossing from untyped JavaScript
must be classified before reaching SQL; a type annotation is not a runtime
boundary.

The proxy class has recurred in every provenance review round so far. Here the
proxy was usually an interval, a scan result, a shared guard bundle, or an LWW
comparison standing in for field identity and mutation authority.

## Mechanism audit — the false negative of each

The examples below are the tested boundary of each mechanism. “Still passes”
is not a claim that the mechanism is useless; it names the adjacent shape the
mechanism does not own.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Nominal canonical integer descriptors | 1 inside the field-specific APIs | The red descriptor-forgery probe spread `runs.attempt`, replaced `min` with `0` and `max` with `Number.MAX_SAFE_INTEGER`, and compiled under the first symbol-brand repair. The class/private-state repair makes that probe a compile error. Direct use of generic `decodeBoundedInteger(value, { min: 0, max: Number.MAX_SAFE_INTEGER })` still accepts the widened value; that generic API deliberately does not claim persisted-field authority. |
| Descriptor-owned SQL and row decoding | 1 | The red type probes passed `t.infra_retries` beside `tasks.attempts` bounds and restored the mismatch through a union. The new API derives the column from the descriptor, so that pair is not expressible. Hand-written SQL outside these helpers can still say `typeof(t.infra_retries) = 'integer'`; the mutation and poison surfaces, not the type, own that adjacent bypass. |
| Fixed derived, run-ordinal, and claim-generation entry points | 1 | The red probes passed a persisted attempt descriptor to the derived decoder, a checkpoint-owner interval to `getCheckpoints`, and a generic incrementable bound to a maximum claim receipt. Those calls no longer type-check or pass the port. The final activation probe then passed string and bigint claim generations, showing that a stored-field helper does not protect an independently supplied port value; finding 21 must add the fixed input boundary. |
| Generated persisted-counter contract and poison witnesses | 1 for one current definition; 2 for generated execution | Removing a declared witness or one side of a declared counter boundary fails the pinned inventory. Adding a new schema counter but omitting it from `PERSISTED_COUNTER_FIELDS` still passes this self-owned list. PR3.10's condition-mutation ratchet must move schema-to-condition completeness above declaration. |
| Branch-reachable poison profiles | 2 | The executed meta-probes make a corrupt target sort after the healthy trigger, add an unrelated generation refusal, or seed the wrong activation history; each now fails before receiving behavioral credit. The profiles cover claim-pending, claim-sleeping, lost-launch, and claim-timeout. A new consumer branch not declared as a profile still receives only the ambient non-amplification matrix. |
| Canonical current-accounting and highest-owned SQL fragments | 1 for the shared shape; 2 for site mutations | The focused red mutations removed these guards from claim candidate, receipt, activation, lost-launch, and claim-timeout paths and reached their exact markers. A newly added consumer that never composes either fragment can still ship until the mutation registry and PR3.10 inventory name the site. |
| Branch-local terminal sweep admissibility | 1 for the SQL composition; 2 for interposition tests | The first shared repair still passed while an activated terminal timeout was blocked by unrelated relaunch corruption. Splitting generation-only timeout from lost-launch counters closes that case. The post-scan `activated_gen = -1` red then proved that scan-only composition remained a false negative; the green repair now recomposes terminal admissibility at the CAS. A newly added scan predicate can still recur if no exact CAS-site mutation is registered. |
| Incrementable ordinal and exact-cap guards | 1 | The red probes use `MAX_RUN_ORDINAL + 1`, a fractional run attempt, and `cap + 1`; the repaired statements refuse them while accepting the exact maximum terminal infra-cap case. Arithmetic in a future raw SQL follow-on can still bypass the helper; exact site mutations are the remaining detector. |
| Exact checkpoint-owner relation | 1 in reads and conflict validation | The red cases forge owner id, task, queue, attempt, range, storage representation, and existence. The shared relation rejects each. A corrupt checkpoint under a different, nonconflicting name does not block an unrelated checkpoint write; reads still filter it, and global corruption remains the invariant surface's responsibility. |
| Atomic checkpoint conflict validation plus LWW control | 1 and 2 | The corrupt-conflict set and suspend cases previously extended or parked before their follow-ons dropped. The repaired leading CAS refuses without any state delta. The valid-higher-owner control still parks and silently preserves the higher checkpoint, proving that “reject every higher ordinal” would be an overcorrection rather than the property. |
| Attributable mutation registry for numeric consumers | 2 | Every currently registered numeric guard must fail through its exact construction or behavior marker. The self-test inventories 127 live mutations, 17 attribution cases, 19 promise cases, 10 descriptor cases, and 37 injected faults. A semantically equivalent bug that produces the same marker through another cause, or a new consumer absent from the registry, can still pass; the full exact-head audit result is pending. |

## Fix-induced defects

Four findings were caused by repairs made earlier in this same round:

- Finding 4 was induced by the first nominal-brand repair. It closed direct
  field swaps but left a spreadable branded data object whose endpoints could
  be replaced.
- Finding 14 was induced by applying the new live-owner accounting guard to
  terminalizing fail and sweep branches without preserving terminal
  quiescence.
- Finding 15 was induced by grouping relaunch validation into a sweep-wide
  helper, even though activated claim timeout does not consume that field.
- Finding 16 was induced by placing the terminal generation and cap predicates
  on discovery without recomposing them at the winning terminal cap CAS.

All four repairs were treated as new code and re-reviewed. Findings 4, 14, and
15 have committed red tests. Finding 16's exact-integer interleaving is commit
`3a47caf`, and its repair is included in green commit `6a134e4`. The
valid-higher checkpoint control and maximum-claim-generation receipt were
added explicitly to catch fix-induced overrestriction; neither overrestriction
reproduced in the current repair.

## Evidence

- Red prevention tests: commit `c5134cb` against `62827a7` exposed the missing
  field-specific bound contract, lower-bound witness inventory, and
  same-subject numeric-worsening oracle.
- Red containment tests and seams: commits `9013bfd` and `197ea26` added the
  exact claim, receipt, activation, checkpoint-read, invariant, generated
  counter inventory, and branch-target profiles. These commits were left red
  against the production consumers they described.
- Residual red replay: commit `6b6d5af` against `197ea26` produced the five
  expected failures: activation accounting, lost-launch post-scan accounting,
  claim-timeout post-scan accounting, checkpoint owner-attempt overflow, and
  the newly reachable lost-launch relaunch-upper poison case.
- Port-domain red replay: commit `d668e7d` failed because the attempted
  `getCheckpoints` repair reported the `checkpoints.owner_attempt` domain
  instead of the required `runs.attempt` domain; no SQL executor call was
  allowed for the invalid input.
- Terminal and checkpoint red replay: commit `74ee725` killed the three
  terminal-owner quiescence markers and both corrupt-LWW markers. The
  valid-higher-LWW control stayed green, showing that the defect was malformed
  ownership rather than the existence of a higher owner.
- Repair-boundary red replay: commit `ec38848` exposes the spread-forged
  descriptor and the activated terminal timeout that was incorrectly coupled
  to unrelated relaunch corruption.
- Finder excerpts retained in the review handoff included:
  “getCheckpoints(attempt) wrongly used checkpoint owner bounds (same endpoints
  hide swap)”; “unconditional accounting/highest guards on terminalizing
  fail/claim-timeout violate DESIGN §3.4 rule 6”; and “checkpoint LWW existing
  checkpoint metadata was not validated.”
- The final independent review found that the terminal lost-launch cap CAS did
  not recompose the terminal scan's numeric domain. Reproducer analysis
  narrowed the reachable case to an exact integer transition from
  `activated_gen = 0` to `-1` between scan and CAS.
- Red scan-to-CAS replay: commit `3a47caf` failed through
  `sweep-terminal-cap-rechecks-generation-lower-bound`; the buggy store
  returned a relaunch-cap outcome after the post-scan
  `activated_gen = -1` corruption instead of refusing the CAS.
- The final activation-port probe made both `'1' as number` and
  `1n as number` activate successfully through libSQL affinity. The finder
  verdict was: “The fixed stored claim-generation descriptor protected rows
  but left the activate input unvalidated; SQLite coerces non-number token
  representations into a winning generation CAS.”
- Red activation-port replay: commit `353ac78` failed all seven hostile input
  classes—string, bigint, fractional, unsafe integer, zero, negative, and
  `MAX_COUNT + 1`. Each reached SQL instead of throwing `RangeError`, through
  the exact marker `activate-validates-claim-generation-input`.
- Fixes: commit `6a134e4`. On pbox, the exact green head passed
  `pnpm verify` with **72 files and 2,415 tests**, and the complete libSQL
  conformance run passed **1,877 cases**.
- The first unconstrained pbox verify attempt inherited host-scale concurrency
  from the 192-core machine and hit the protective task limit. That was an
  infrastructure-capacity result, not a test failure and not correctness
  evidence. The rerun stayed inside `scripts/confine.sh`, bounded execution to
  32 cores, and produced the green totals above.
- Mutation self-test on the repaired registry passed with **127 live
  mutations, 17 attribution cases, 19 promise-message cases, 10 descriptor
  cases, and 37 injected faults**.
- **PENDING FINAL EVIDENCE — full mutation audit:** record the exact-head
  clean-tree attributable total and current-head binding. The self-test proves
  registry and classifier mechanics, not that every production mutation is
  killed.
- **PENDING FINAL GATE EVIDENCE:** record `pnpm verify:fuzz` and
  `pnpm verify:tla` results. `pnpm verify` and the libSQL conformance suite are
  complete; fuzz and TLC are not claimed here.
- Disconfirmed: the proposed integral-REAL claim-timeout case is not reachable
  through ordinary SQLite storage because INTEGER affinity canonicalizes
  same-value `1.0` to INTEGER. It is not counted as a finding.
- Disconfirmed: valid higher-owner LWW is not corruption. The control proves
  suspension still succeeds while preserving the newer checkpoint.
- Disconfirmed: maximum legal `claim_gen` is valid in a same-token receipt even
  though it is not incrementable. The positive-claim helper accepts it while
  the claim candidate helper refuses a further increment.
- Dialect note: a strict store may reject a requested storage corruption
  structurally. At this numeric checkpoint the fixture reported that stronger
  `structurally-rejected` outcome. Temporal repair review later demonstrated
  that fixture-owned reporting was unauditable; T13 moves execution and
  disposition authority into the shared runner while preserving strict
  rejection as a legal result.

## Root cause

The common machinery failure was that numeric validity had four separate
representations: a row field, a pair of endpoints, a transition-local
refinement, and a checker witness. The total decoder made each selected pair
safe to convert, but it could not prove that the caller selected the right
pair, that every consumer selected one at all, or that the guard remained at
the statement that acquired mutation authority.

The generated machinery inherited the same separation. It knew every
condition it had been told about, but not every schema field; it knew a label
ran, but not that the poisoned row reached the bounded branch; and it knew an
advisory scan rejected corruption, but not that a later CAS recomposed the
same property. Completeness of declarations was mistaken for completeness of
consumers.

Finally, guard reuse erased protocol distinctions. Current accounting is
load-bearing for any operation that revives work or derives a successor. It is
not authority to leave an already-terminal owner's claimed run alive.
`relaunch_count` is load-bearing for a lost launch and irrelevant to an
activated timeout. A shared bundle was shorter SQL but a weaker model of the
transition.

## Mechanisms

Built in this PR:

- A canonical `IntegerBoundsDescriptor` owns durable field identity and
  endpoints in private frozen state. Persisted descriptor unions, derived
  descriptor unions, and fixed lifecycle helpers make wrong-domain selection
  unrepresentable at the public construction sites (rung 1).
- Fixed port validators close over the semantic domain for client-supplied run
  ordinals and claim generations, reject non-number JavaScript values before
  SQL, and share no generic bounds menu with persisted-row decoding (rung 1).
- Store fragments derive their column from the persisted descriptor. One
  `storedCurrentRunAccounting` definition owns bounded counters, attempt
  budget, and the exact next-accounted ordinal; one
  `storedHighestOwnedOrdinal` definition owns historical-ordinal refusal
  (rung 1).
- `PERSISTED_COUNTER_FIELDS` generates the eight durable counter conditions,
  upper and lower witnesses, native-storage corruptions, and exact numeric
  severity. Generated branch profiles prove target reachability and ordering
  for both claim states and both sweep classifications (rungs 1 and 2).
- Claim candidate, same-token receipt, activation, sweep discovery, sweep
  CASes, fail, successor construction, checkpoint reads, checkpoint writes,
  and suspension each compose the exact field and relation guards they consume
  (rung 1), with exact attributable mutations and interposition regressions
  (rung 2).
- Terminal-owner SQL is branch-local: reviving paths require the full live
  accounting property, terminalizing paths quiesce without rewriting the task,
  and only lost-launch arms inspect relaunch counters (rung 1).
- One checkpoint-owner relation proves native bounded owner attempt plus exact
  run id, task, queue, and ordinal. Reads join through it, while both
  checkpoint-producing leading CASes validate the exact conflicting row before
  lease extension or park. Positive valid-higher LWW remains pinned (rungs 1
  and 2).

Deferred (recorded in BUILD.md):

- PR3.10 remains responsible for the condition-mutation ratchet: every
  independently claimed field, relation arm, consumer site, and enum member
  needs its own generated attributable mutation. The present registry is exact
  for declared sites but cannot prove a future consumer was declared.
- PR3.9 remains responsible for replacing textual SQL inspection with a
  compiled tree. The new field descriptors close TypeScript construction
  surfaces; they do not make raw SQL predicates semantic objects.
- The adjacent temporal-domain omission described by the numeric round is
  closed by the addendum below. The remaining cross-dialect schema-enrollment
  work is recorded under PR4.1 in BUILD.md; it cannot run before those dialect
  migrations exist.

## What this round still would not catch

A new durable counter added to schema but omitted from
`PERSISTED_COUNTER_FIELDS` would ship today unless a schema-to-domain inventory
is added. A new transition that consumes an existing counter without composing
the canonical fragment would ship unless its site is entered in the mutation
registry. Those are the exact false negatives PR3.10 must attack.

Raw hand-written SQL can still reproduce a wrong field comparison outside the
typed fragments. The poison oracle can catch many resulting state changes, but
it cannot make the comparison unwritable; PR3.9 owns that structural move.

The current generated target profiles prove the two claim lifecycle shapes and
the two sweep classifications. A new branch or a different ordered budget can
remain decorative until it receives its own profile, ordering control, and
exact mutation.

Finally, any field validated only by an advisory read can still regress if a
later CAS consumes it without recomposing the same property. Finding 16
demonstrated that class and now has both its CAS repair and exact mutation, but
a future scan predicate remains outside the guarantee until it receives the
same CAS-site enrollment. The temporal-field pass below repeated that
scan-to-CAS audit; a future consumer still needs explicit mutation enrollment.

## Temporal-domain addendum

The counter repair made exact integer domains field-specific, but it left the
adjacent timestamp property only partly enrolled. Eight timestamps had
invariant checks, database-time arithmetic had no uniform epoch-headroom proof,
and consumers could compare or propagate corrupted persisted instants before a
bounded limit or after an advisory scan. This addendum treats that as a
separate review round so its defects, detection ratio, repair regressions, and
residuals do not disappear into the counter totals above.

### Temporal severity

The worst safety shape was a partial multi-statement transition. A legal
database instant plus a legal duration could exceed `MAX_EPOCH_MS`; a leading
statement could write or authorize work while a later consumer encountered an
out-of-contract deadline. The first driver-heartbeat repair had the converse
split: it refused the overflowing heartbeat but still deleted rows during the
cleanup statement. After the review repair, the newly complete poison matrix
separately showed cleanup consuming an invalid stored expiry as deletion
authority.

The worst progress shape was corrupted time consuming a bounded discovery
budget. Negative availability, wait timeout, cancellation, or claim-expiry
values could sort before healthy rows and occupy a claim, sweep, or cancellation
limit. An advisory scan was not authority: corruption inserted after discovery
could still win the later CAS. The same class affected `nextWakeAt`, direct
lease expiry, event re-emission, wait delivery, and activation's persisted
first-start/max-duration inputs.

The machinery gaps were severity findings too. Fifteen persisted temporal
fields were absent from the invariant/poison declaration, the migrated schema
had no exact inventory/nullability comparison, and the timestamp conformance
suite was nested inside another suite rather than enrolled in the central
registry. Those mechanisms could report green while never observing the
property they claimed.

### Temporal findings catalogue

The `Count` column is normative for this addendum. A row may describe several
sites when they share one mechanism, but its count is the number of independent
production or machinery omissions, not the number of prose bullets.

| ID | Count | Defect and impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|----|------:|-------------------|----------------------------------|------------------|-------------------------|
| T1 | 14 | Each derived-deadline site accepted legal inputs whose sum exceeded `MAX_EPOCH_MS`: spawn availability, spawn cancellation, claim lease, activation lease, activation max-duration, heartbeat, lost-launch reopen, claim-timeout successor, driver heartbeat, reschedule, suspend, user retry, checkpoint extension, and event timeout. Each site could persist an epoch outside the protocol domain. | Numeric construction boundary | Port validation proved each operand separately; no statement proved the result representable | One `epochAdditionFits` headroom shape at every authoritative write, with exact-ceiling and overflow-by-one cases (rung 1 composition, rung 2 site mutations) |
| T2 | 6 | Corrupt temporal subjects could enter bounded discovery before `LIMIT`: pending availability, sleeping wait timeout, claim cancellation deadline, both sweep expiry classifications, and cancellation discovery. Earlier corrupt rows could starve healthy work. | Eligibility/discovery fragments and progress floor | Due-ness comparisons treated any SQLite-comparable value as a timestamp | Fixed-field bounded predicates inside every ordered leg, plus corrupt-first/healthy-second controls (rungs 1 and 2) |
| T3 | 3 | Lost-launch, claim-timeout, and cancellation CASes did not recheck the exact timestamp domain after discovery. A post-scan corruption could become mutation authority. | Winning CAS | Advisory classification was mistaken for durable evidence | Recompose the exact fixed-field bound and due predicate at each CAS, with post-scan interposition tests (rungs 1 and 2) |
| T4 | 4 | The four `nextWakeAt` sources admitted corrupt pending availability, sleeping availability, running claim expiry, or cancellation deadline. A negative value could force perpetual immediate wakes; an over-ceiling value could escape the port decoder. | Read-side derived-result boundary | Aggregate ordering/filtering proved neither source storage nor field range | Each aggregate arm filters its own canonical field before `MIN`, while the result still crosses the total decoder (rung 1 composition, rung 2 source cases) |
| T5 | 5 | Direct consumers trusted corrupt stored time in `expireLeaseNow`, timed-wait emit, activation first-start, activation max-duration JSON, and event re-emission. They could launder invalid time, wake the wrong subject, or make activation/re-emission partially succeed. | Direct compare/copy boundary | Native affinity, JSON coercion, or a prior write was treated as continuing authority | Fixed persisted-field guards; exact JSON type/range/rounded conversion; atomic refusal before propagation (rung 1, with lower/upper/storage cases at rung 2) |
| T6 | 1 | Only eight of 23 persisted temporal fields were inventoried, with no schema/nullability enrollment. Fifteen fields and the `drivers` table could be absent from invariant evidence while completeness stayed green. | Invariant and poison inventory | Hand-maintained evaluator calls proved only their own list | One frozen 23-field/six-table inventory generates 46 conditions, snapshot columns, and 69 storage/lower/upper witnesses; libSQL enrolls the exact union of all 31 native integer fields and nullability (rung 1 generation, rung 2 schema/cardinality pins) |
| T7 | 1 | Timestamp conformance was nested inside scheduler conformance and absent from the central surface registry. A dialect could satisfy registry enrollment without the timestamp contract being independently visible. | Conformance enrollment gate | Call nesting was a proxy for first-class mandatory enrollment | A `timestamp-boundaries` registry entry and exact registry mutation (rung 1 registry, rung 2 deletion attack) |
| T8 | 1 | `setFakeNowEpochMs` wrote an administrative clock without `requireEpochMs`; hostile JavaScript values could enter metadata before engine SQL cast them. | Store admin port | The seam was treated as trusted test plumbing rather than an untyped port | Validate through `requireEpochMs` before SQL and preserve the prior clock on refusal (rung 1) |
| T9 | 1 | The first headroom helper repeated anonymous `?` placeholders while callers supplied each delta once. This repair-induced bind/argument drift was caught by timestamp-store audit before the repair committed. | Repair construction review | A textual expression was assumed referentially reusable even though positional placeholders are consumable | Render every delta expression exactly once; fragment construction pins placeholder count (rung 1 for the helper shape, rung 2 test) |
| T10 | 1 | The first activation repair rejected a stored seconds value just above the quotient ceiling even when port-equivalent rounding produced exactly `MAX_DURATION_MS`. Timestamp-store audit found this repair-induced overrestriction, which could refuse a previously legal task. | Port/SQL representation parity | A raw seconds comparison stood in for the canonical rounded-millisecond value | One rounded SQL duration expression is shared by validation and write; exact parity control at the ceiling (rung 1 single representation, rung 2 control) |
| T11 | 1 | The first driver repair made the heartbeat upsert conditional but left cleanup independently executable against the old heartbeat. Timestamp-store audit found that overflow could still delete an expired row after the requested beat was refused. | Atomic batch repair review | Statement-local refusal was mistaken for batch-level temporal authority | Cleanup is causally gated by the same representable heartbeat transition; a full snapshot proves overflow causes no partial delta (rung 1 composition, rung 2 red case) |
| T12 | 1 | The first 23-field inventory accepted an independently supplied semantic ID beside each nominal `table.column` descriptor. Swapping two unique IDs preserved all cardinality, uniqueness, schema, condition, and witness checks while relabeling the evidence. | Canonical temporal inventory repair review | Two synchronized representations were mistaken for one identity | Derive the public ID from `bounds.field`; there is no second label to swap (rung 1, with a construction pin) |
| T13 | 1 | A dialect fixture could return `structurally-rejected` without attempting any invalid-storage write; the shared runner then skipped finding and progress evidence. A backend could opt out of all 23 storage witnesses while reporting the stronger result. | Portable corruption seam | A fixture-supplied disposition was trusted as evidence of native enforcement | The fixture prepares a nonempty dialect statement and narrow error classifier; only the shared runner executes it and may credit observed rejection (rung 1 authority move, rung 2 meta-test) |
| T14 | 1 | The first libSQL schema enrollment discovered temporal columns by the `_ms` suffix. A future temporal `INTEGER` with another name could be omitted while the 23-field count and exact current vector remained green. | Schema-to-domain enrollment repair review | A naming convention was a syntactic proxy for semantic numeric meaning | Discover every native `INTEGER` and require the exact union of eight counter plus 23 temporal field/nullability descriptors (rung 1 inventory, rung 2 schema proof) |
| T15 | 1 | The new six-table snapshot projection carried table names but rebound executor results through hard-coded numeric indices. Projection order and evidence ownership could drift independently. | Invariant evidence assembly repair review | Positional coincidence stood in for the declared table key | Build the `ProtocolRows` map from each projection's own table key; there is no second positional table list (rung 1) |
| T16 | 1 | The full generated poison matrix found driver cleanup deleting a row whose persisted expiry was outside the temporal domain. Cleanup amplified corruption by consuming it as deletion authority. | Generated temporal poison surface | This was the first complete 23-field storage/lower/upper run, so the prior partial inventory could not inject the subject | Validate cleanup-candidate expiry before comparison/deletion; generated storage/lower/upper cells and a direct invalid-input regression pin refusal (rung 1 consumer guard, rung 2 generated detection) |

T1 through T15 are **42 review-caught findings**. T9 through T12, T14, and T15
are six fix-induced findings, but review found all six, so they receive no
self-catch credit. T13 is a pre-existing machinery escape exposed by repair
re-review. T16 is the sole author-machinery self-catch: the newly complete
generated poison surface found it before review.

### Detection ledger (aggregate question 1)

| Detector | Findings | Ours? |
|----------|---------:|-------|
| Timestamp-domain adversarial review and mandatory re-review: T1–T8 | 35 | no |
| Timestamp-store repair audit: T9–T11 | 3 | no |
| Independent inventory/repair re-review: T12–T15 | 4 | no |
| Full generated temporal poison matrix: T16 | 1 | yes |

Temporal self-catch rate: **1 of 43, or 2.3%** (immediately preceding numeric
round: **0 of 21, or 0%**). This is an improvement from zero, but it is not a
healthy ratio: outside review found 42 of 43 defects, while the complete
generated surface found only one.

The count is intentionally conservative. It counts one finding per independent
write site, bounded door, post-scan CAS, aggregate source, direct consumer, or
mechanism gap. Multiple hostile values at one consumer—negative, upper-bound,
coercible string, fractional—are evidence for that one omission, not extra
findings. Exact-MAX and terminal-arm cases are controls, not findings.
The production/site method yields
`14 + 6 + 3 + 4 + 5 + 1 + 1 + 1 = 35`; timestamp-store audit adds T9–T11 and
independent repair review adds T12–T15, for 42 review findings. T16 is one
generated consumer finding, not an extra count for every invalid expiry value.

The prior cumulative trailer was `review-findings: 247`; this addendum proposes
`review-findings: 289`. The previously recorded branch-wide self-catch count
was 29; T16 raises it to 30. The resulting branch catalogue is therefore
**289 review-caught plus 30 self-caught, or 319 total findings**. Final PR
metadata must use the review-caught number, not the combined total.

### Recurrence (aggregate question 2)

T1 recurs after the numeric port rule. That mechanism established operand
validity and banned client-side multiplication in SQL, but it never stated or
checked closure of `epoch + duration` inside the epoch domain. “Both operands
are valid” was a proxy for “the result is valid.”

T2 through T5 recur after the persisted-counter containment round. That round
made counter consumers field-specific, yet timestamp consumers remained
method-local comparisons. The same defect class therefore reappeared at every
door: a declaration or advisory read stood in for authority at the bounded
selection or winning statement. This is also another instance of the recurring
scan-versus-CAS class from numeric finding 16.

T6 recurs after the generated poison inventory. The previous temporal list
declared eight fields and then proved all eight were covered. It did not derive
the list from migrated schema or from one canonical temporal contract.
Completeness of a declaration again stood in for completeness of the property.

T7 recurs after central conformance enrollment was introduced. The registry
proved its listed top-level surfaces, while a nested timestamp call remained
invisible to the registry's exact set. “Some path happens to call this suite”
was a proxy for “every dialect is structurally enrolled.”

T8 recurs after the rule that every client number is validated at the port.
The fake-clock seam was scoped as testing machinery and therefore escaped the
port audit, even though it accepts untyped JavaScript and persists a value the
engine consumes. The new-layer scoped-review failure has recurred in every
machinery round: a boundary is safe only for the surfaces it actually owns.

T9 through T12, T14, and T15 demonstrate recurrence during the repair itself.
The fix knew the old representation: independently repeated SQL text, a
seconds-domain comparison, a two-statement batch whose first statement wrote
the bad value, independently maintained condition identity, suffix discovery,
and positional evidence binding. Each repair changed that shape, creating an
adjacent failure the original red test did not describe. Store audit and
independent repair re-review—not confidence in the repair—found all six.

T13 recurs after the portable corruption seam introduced
`structurally-rejected`. The intended property was “the native schema rejected
an attempted invalid write.” The implemented proxy was “the fixture returned
the string that names rejection.” Authority to claim evidence remained with
the component being graded.

T16 is the mechanism working. Once all 23 temporal fields generated storage,
lower, and upper poison witnesses, the complete matrix constructed an invalid
driver expiry and observed cleanup consume it. The direct regression was added
after generated detection; it is prevention evidence, not the detector.

### Mechanism audit — temporal false negatives (aggregate question 3)

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Frozen 23-field temporal inventory plus 31-field libSQL schema enrollment | 1 for declared identities, 2 for physical schema proof | LibSQL now enrolls every native `INTEGER`, so neither a renamed temporal integer nor a counter can hide. A future PostgreSQL/MySQL physical time type is not an `INTEGER`; its adapter needs an explicit canonical field/type mapping and cannot reuse the libSQL metadata predicate. PR4.1 owns that dialect proof. |
| Generated 46 conditions and 69 witnesses | 1 for generation, 2 for execution | A transition can consume an enrolled field through new raw SQL without composing its bound. All storage/lower/upper poison witnesses still run; ambient non-amplification may catch a resulting write, but no generated witness proves the new consumer was enrolled. PR3.10 owns that declaration ratchet. |
| `epochAdditionFits` | 1 at composed sites | A caller can hand-write `NOW + ?`, or pass a negative/unvalidated delta to the helper; base validity and headroom alone do not establish the delta's duration domain. Port or stored-duration validation remains a separate required premise, and exact site mutations catch current omissions. |
| Fixed-field due/unexpired fragments | 1 | A future comparison written directly as `x <= NOW` bypasses the fragment. The fragment prevents field/bounds swaps where used; until SQL becomes a typed tree, source lint and mutation enrollment remain lower-rung detectors. |
| Timestamp conformance registry | 1 for top-level enrollment, 2 for deletion | A registered suite whose cases are emptied or whose controls no longer discriminate remains present in the registry. Exact case and mutation inventories, rather than the registry alone, own that adjacent failure. |
| Rounded max-duration expression | 1 for this serialized field | A future JSON duration field can implement truncation or a raw seconds ceiling unless it reuses the canonical conversion. Single representation is complete for `cancellation.maxDurationSeconds`, not for serialized fields not yet designed. |
| Fake-clock port validation | 1 at `StoreAdmin` | Raw fixture SQL can still corrupt `meta.fake_now_ms` without calling the admin port. That is an explicit corruption seam, not a supported port; the invariant inventory covers persisted protocol tables, not administrative metadata. |
| Atomic driver-heartbeat cleanup | 1 for this batch | A future multi-statement transition can condition only its first statement and still mutate in a follow-on. FencedBatch proves provenance for protocol tables, but `drivers` is observability-only and this cleanup needs its own full-snapshot control. |
| Shared execution of structural-rejection attempts | 1 for observed execution, 2 for classification | A dialect can provide an overbroad `isStructuralRejection` classifier that labels an unrelated executor error as native type enforcement. The runner now owns the nonempty attempted write; dialect-specific typed-error classifier tests must still own classification precision. |
| Table-keyed invariant projection | 1 inside assembly | A dialect executor that violates the ordered-result port contract can still return another statement's rows at an index. Required-column validation usually rejects that shape, but the local projection cannot authenticate an executor result; the executor conformance surface owns ordering. |

The rung-1 claims above are deliberately scoped. None claims that adding a new
consumer is automatically enrolled; claiming that would confuse a canonical
construction with a complete call-site inventory.

### Fix-induced defects (aggregate question 4)

There were **six**:

- T9: the first shared headroom helper duplicated positional placeholders.
- T10: the first max-duration guard compared raw seconds and rejected a value
  whose canonical rounded milliseconds were legal.
- T11: the first driver guard refused the upsert but allowed cleanup to mutate
  independently after overflow.
- T12: the first temporal inventory kept a swappable semantic ID beside the
  nominal durable-field identity.
- T14: the new schema proof inferred semantic time from an `_ms` suffix.
- T15: the new six-table projection declared table keys but rebound rows by a
  second positional representation.

All six were found while the repairs were treated as new code, and all six
were review-caught: timestamp-store audit found T9–T11; independent inventory
review found T12, T14, and T15. T12 has red construction commit `46b79d8`;
the final repair removes all six proxies rather than deferring them. T16 is
not fix-induced and appears only in the detection ledger above as the generated
poison self-catch. **PENDING FINAL EVIDENCE:** record the green commit that
closes T9–T15 and the exact focused results on that commit.

### Temporal evidence

- Derived-addition red commit `7576ed1` introduced fourteen exact-ceiling /
  overflow-by-one pairs. The overflow arms failed against the pre-repair store;
  exact `MAX_EPOCH_MS` controls described the required non-overcorrection.
- Consumer red commit `5bb2a88`, structural-enrollment red commit `db88db4`,
  and complete consumer red commit `f577b24` expanded the surface across
  bounded selection, scan-to-CAS interposition, next-wake sources, and direct
  consumers. On pbox the committed red suite reported **1,933 total cases,
  35 intended failures, 21 active controls passing, and 1,877 skipped**.
  That test-failure total is not the review-finding count: several hostile
  probes collapse into one site finding, while inventory, enrollment, and
  fake-clock mechanism findings are counted separately.
- Enrollment green commit `b6d1d20` moved timestamp boundaries into the central
  store-conformance registry rather than relying on nesting.
- Fake-clock red commit `73f0ef7` proved seven hostile values reached the admin
  seam; green commit `77e9c3d` validates before SQL and pins both legal epoch
  endpoints.
- Driver atomicity red commit `5b400c3` snapshots the requested heartbeat and
  an expired cleanup victim, then proves the review-caught overflow split
  changes neither. After the generated poison matrix found T16, corrupt-input
  red commit `1e62f12` proved cleanup refuses an invalid stored expiry instead
  of deleting it; the invalid-last-beat case is an adjacent control, not an
  additional finding.
- Temporal-identity red commit `46b79d8` proves every public descriptor ID must
  equal its nominal `table.column` bounds identity; the green construction
  removes the independently supplied ID argument.
- Independent inventory re-review found that a fixture could claim structural
  rejection without an attempted write, `_ms` discovery was not semantic
  schema completeness, and six declared table projections were rebound through
  a second positional list. The shared runner now executes nonempty attempts
  before narrow typed rejection, libSQL enrolls all 31 native integer fields,
  and invariant assembly binds each result through its projection's table key.
- The attributable registry adds 64 timestamp, admin, and enrollment mutations,
  bringing the current live inventory from 127 to 191. Its confined
  `lint:mutation-verdicts` classifier/self-test is green; this is mechanism
  evidence, not a substitute for the pending clean-head full audit.
- Finder verdict: “All fourteen database-time additions validate their delta
  at the client port but none proves that database now plus that delta remains
  inside the epoch domain.”
- Inventory verdict: “The invariant names eight temporal fields while the
  migrated scheduler schema contains 23 across six tables; its completeness
  test proves only the hand-maintained subset.”
- Enrollment verdict: “Timestamp boundaries are called from scheduler
  conformance but absent from the central surface registry, so exact enrollment
  cannot see or require them.”
- Timestamp-store audit verdicts included: “The shared headroom expression
  repeats anonymous placeholders while callers bind each delta once”; “the
  conditional driver upsert does not make its cleanup conditional”; and “the
  activation guard compares raw seconds even though the port contract is
  rounded milliseconds.”
- Inventory repair verdicts included: “structural rejection is an unaudited
  opt-out”; “semantic field identity can silently drift”; “schema completeness
  still relies on the `_ms` naming proxy”; and “snapshot projections are
  declared with table ownership but rebound positionally.”
- Disconfirmed: the exact epoch ceiling is not itself invalid. Every derived
  site has a legal exact-MAX control.
- Disconfirmed: terminal lost-launch, terminal claim-timeout, and exhausted
  user-failure arms do not derive successors and must remain able to quiesce at
  the ceiling. Their positive controls prevent applying a live-successor guard
  to terminalization.
- Disconfirmed: three malformed representations of stored max-duration are
  three witnesses for one consumer omission, not three findings.
- **PENDING TEMPORAL GREEN COMMIT:** record the commit SHA containing the
  production consumers, 23-field inventory, 46 conditions, 69 witnesses,
  31-field schema/nullability enrollment, observable corruption seam,
  table-keyed snapshots, placeholder repair, rounded parity, and driver-cleanup
  repair.
- **PENDING FINAL CLEAN-HEAD EVIDENCE:** record the bound SHA and exact totals
  for the focused timestamp suite, `pnpm verify`, the full attributable
  mutation audit, fuzz, all six TLC targets, and the hosted branch nightly.
- **PENDING POST-MERGE EVIDENCE:** record the main merge SHA and hosted nightly
  result for that exact SHA.

### Temporal root cause

Time had three representations that were never joined: port-validated relative
durations, database-produced absolute instants, and persisted timestamp fields
used by transition-local SQL. The first representation proved an operand, the
second was trusted because the database owned it, and the third was partially
listed in invariant code. No mechanism stated the closure property for derived
epochs or bound a consumer to one exact persisted temporal descriptor.

The machinery reflected the same split. The poison surface generated from a
partial list, schema knew its columns but not their semantic descriptors, and
conformance nesting ran cases without making their enrollment independently
visible. Each layer proved what it had been told, not that it had been told
about the whole property.

### Temporal mechanisms

Built in this PR:

- `PERSISTED_TEMPORAL_FIELDS` is the canonical 23-field contract across tasks,
  runs, checkpoints, events, waits, and drivers. Field identity, bounds,
  epoch/duration kind, and nullability travel together, and the public ID is
  derived from the nominal bounds identity rather than separately spellable
  (rung 1).
- The inventory generates 46 exact invariant conditions, six-table projections,
  and 69 invalid-storage/lower/upper witnesses. Exact temporal severity rejects
  same-subject worsening; cardinality pins produce 109 total conditions, 139
  witnesses, and 2,363 ambient cells (rungs 1 and 2).
- LibSQL migration conformance discovers every native `INTEGER` column and
  requires the exact union of eight counter plus 23 temporal descriptors and
  their nullability. The fixture corruption seam reaches all six tables; the
  shared runner executes every nonempty attempt and alone may classify an
  observed native error as structural rejection (rungs 1 and 2).
- `epochAdditionFits` owns base validity and result headroom at all fourteen
  derived writes, with each delta rendered exactly once. Fixed-field helpers
  own availability, expiry, cancellation, and timed-wait consumers (rung 1).
- The mandatory timestamp conformance surface pins exact/overflow behavior,
  bounded progress, post-scan authority, next-wake sources, direct propagation,
  terminal controls, rounded JSON parity, fake-clock inputs, and driver
  atomicity/corrupt-input refusal. Central registry enrollment makes a backend
  unable to select only the older scheduler surface (rungs 1 and 2).
- Sixty-four exact temporal/admin/enrollment mutations bind each current guard,
  control, schema inventory, and registry entry to an attributable verdict.
  Together with the prior 127 they form a 191-entry registry; the complete
  exact-head audit is final evidence rather than assumed from enumeration
  (rung 2).
- The six invariant projections assemble `ProtocolRows` from their own declared
  table keys rather than a second positional mapping (rung 1).

Deferred (recorded in BUILD.md):

- PR3.9 still replaces raw SQL/text lint with a compiled tree. Current fixed
  fragments make the right predicate single-source where composed; they do not
  make a future raw comparison unspellable.
- PR3.10 still generates an attributable mutation for every claimed condition
  arm and consumer site. The temporal inventory is complete for the current
  libSQL schema, but a future consumer can be absent from the mutation registry.
- PR4.1 requires each future PostgreSQL/MySQL migration to prove its native
  temporal types and nullability against the shared inventory. The present
  schema query is correctly libSQL-specific because those migrations do not
  yet exist.

### What the temporal round still would not catch

A new libSQL `INTEGER` field omitted from both inventories now fails schema
enrollment regardless of its name. That proof does not automatically describe a
future dialect's native `DATETIME(6)` or `timestamptz` encoding; a backend could
mis-map such a field until PR4.1 gives its migration an explicit canonical
field/type/nullability vector. A new raw SQL consumer of an enrolled field can
still ship until it is registered in the exact mutation surface; the ambient
poison matrix may detect amplification but does not prove reachability of every
new door.

The headroom helper assumes every delta has already crossed its duration
boundary. A future caller that supplies a stored or computed negative delta
without that premise can satisfy headroom while violating the duration
contract. Typed SQL construction and a consumer-mutation ratchet are the two
remaining ways to close that gap.

Finally, administrative metadata remains outside the six protocol-table
invariant snapshot. Supported fake-clock writes are now port-safe, but direct
raw corruption of `meta.fake_now_ms` is not classified as a temporal invariant
finding. Extending invariant scope to admin metadata should be done only with a
dialect-neutral admin-state contract, not by pretending the scheduler snapshot
already owns it.

The shared runner now observes every claimed structural rejection, but a future
dialect can still write an overbroad native-error classifier. Its adapter tests
must prove that malformed-value/type enforcement is accepted while unrelated
executor failures propagate; observed execution alone is not semantic error
classification.
