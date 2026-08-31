# Postmortem: PostgreSQL conformance review (PR #16)

PR #16 makes PostgreSQL 17 the second real scheduler dialect and enrolls it in
the same six conformance surfaces as libSQL. Adversarial and release-gate
review found nine defects before merge: same-token claim retries could select
several runs, the first locking repair retained one durable sentinel per fresh
token, libSQL could persist header strings PostgreSQL could not later interpret,
PostgreSQL could abort a bounded claim on JSON that passed its preliminary
syntax predicate but overflowed `jsonb`, and privately owned pools plus
checked-out clients left PostgreSQL `error` events without an owner. A final
conversion review then found that the exponential retry-factor check still
put a raising `::numeric` cast beside its type predicate in an `AND`
expression instead of behind a selected `CASE` arm. CodeRabbit then found that
fresh-catalog bootstrap did not share the migration loop's concurrent-winner
recovery, so simultaneous cold starts could reject after another process had
already brought the schema current. The final release-gate audit found that
PostgreSQL migrations v1-v5 had no frozen content hashes, leaving shipped
history editable without a build failure. The exact-head whole-system review
then found that the header repair still trusted the compile-time
`Record<string, string>` shape at runtime: non-object roots and non-string
values could be persisted and then refused by claim admission, while an
undefined-valued entry silently disappeared. The repairs close seven
reproduced product failures, one construction-level conversion hazard, and one
release-safety gap, and add native
concurrency, conversion, and connection-lifecycle evidence; the honest
verdict is that review, not the branch's original machinery, found every one.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The implementation defects are smaller than the assurance failure:
logical conformance and simulated interleavings were treated as proof of a new
dialect boundary whose native locking, storage lifetime, header runtime domain,
and conversion and connection-ownership behavior they did not execute.

## Severity

The worst finding violated one-logical-request claim idempotency. Sixteen
concurrent `limit: 1` deliveries carrying the same claim token created ten
durable running rows before the repair. A transport retry could therefore
multiply one scheduler request into several worker launches while every row
remained individually well formed.

The first concurrency repair used a durable row keyed by queue and claim
token. Claim tokens are fresh per tick, so correct sustained use would append
permanent lock state at scheduler cadence. It fixed the immediate safety race
by turning operation-scoped synchronization into unbounded database state,
eventually imposing storage, backup, vacuum, and diagnosis costs on healthy
workloads.

Headers exposed a portability failure. libSQL accepted escaped NUL and lone
UTF-16 surrogates in TEXT JSON, while PostgreSQL's later `jsonb` inspection
could not represent them. A task accepted by the first dialect could become
unclaimable after moving the same durable wire value to the second. The first
repair widened the restriction to every opaque JSON value and thereby caused
one fix-induced compatibility defect: valid result and event strings were
rejected even though their protocol paths never require `jsonb` object
inspection.

The narrower header repair still did not enforce the header container and
value shape at runtime. TypeScript callers saw `Record<string, string>`, but
JavaScript and values crossing `unknown` or `any` could supply null, arrays,
primitive roots, nested values, or undefined-valued fields. The generic JSON
snapshot admitted those values before either store wrote them. A persisted
non-object or non-string-valued header is then deliberately refused by the
claim, same-token receipt, and activation guards, stranding a task whose spawn
reported success; an undefined-valued field instead disappeared during JSON
serialization. Source admission and durable admission therefore described two
different header domains.

Finally, PostgreSQL's `IS JSON` predicate accepted a numeric literal such as
`1e1000000`, but converting that value to `jsonb` or `numeric` raised SQLSTATE
`22003`. A corrupt retry policy at the front of a bounded candidate set aborted
the whole claim rather than being skipped, so one poison task could starve
healthy work behind it. The same conversion boundary affected persisted
headers and cancellation policy reads.

The first conversion repair still left one nested conversion dependent on
unspecified Boolean-expression evaluation order. The exponential factor arm
said, in effect, “the JSON value is numeric AND its text casts to `numeric`
inside the allowed range.” PostgreSQL 17 happened to short-circuit every
malformed factor exercised at candidate selection, same-token receipt, and
activation: string, overflow-looking string, empty string, null, Boolean,
object, and array shapes all produced the intended inert refusal. No runtime
incident or failing PostgreSQL 17 plan was reproduced for this finding. That
does not make the SQL safe: the contract cannot depend on an optimizer
evaluating the non-raising operand first. A different legal plan or backend
version could turn durable corruption into a claim or activation abort. The
red proof is therefore construction-level: the generated SQL did not contain
the cast inside the typed `CASE` arm that guarantees its evaluation domain.

PostgreSQL also reports some backend and socket failures through EventEmitter
`error` events rather than only through rejected `connect` or `query`
promises. The pools privately created by the executor and fixture had no
pool-level owner for an idle-client error. While a client was checked out,
`pg-pool` removed its idle listener and the executor installed no replacement.
Node treats an unhandled `error` event as process-fatal, so an ordinary
database disconnect could terminate every scheduler or worker sharing that
process instead of failing one store operation. An active errored client also
had no recorded reason forcing its removal from the pool.

Concurrent cold start was a separate availability failure. In each of five red
runs, eight PostgreSQL migrators against one empty schema produced one
fulfillment and seven SQLSTATE `23505` rejections, even though the winner
brought the schema current. A fan-out deployment could therefore fail seven
otherwise healthy processes and depend on caller or orchestrator retry. No
partial schema or durable-state corruption reproduced—the losing DDL
transactions rolled back—but `migrate()` did not uphold convergence.

PostgreSQL migration history was also unfrozen. The tests pinned version labels
and selected present-day DDL properties, but not the complete body of each
migration. After release, an unasserted edit to v1-v5 could pass the build: a
fresh database would execute the edited history, while an upgraded database
would skip it because its stored version already claimed the migration. Both
would report the same current version while carrying different schemas.
PostgreSQL has not yet shipped, so no deployed database was stranded; this is a
pre-release safety failure whose impact begins with the first release.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | PostgreSQL `SKIP LOCKED` serialized candidate rows but not concurrent deliveries of the same claim token before selection | One logical `limit: 1` request durably selected ten runs and could launch duplicate logical work | Native backend concurrency conformance for the same-token receipt contract | SimWorld schedules a batch as one suspension and existing native cases used distinct tokens, so neither could expose two transactions selecting disjoint rows before either token became visible | Closed `FencedBatch.lockClaim` coordinates plus a transaction-scoped PostgreSQL advisory lock, exercised by a warmed sixteen-client same-token case (rung 1 for the closed call shape, rung 3 for native semantics) |
| 2 | The first claim-lock repair persisted a sentinel row for each queue and fresh claim token | Healthy scheduler use accumulated operation-scoped lock garbage without bound | Schema lifecycle and storage-shape review of every new coordination primitive | The concurrency oracle checked exclusion only; a row lock and an advisory lock have the same safety outcome while radically different lifetimes | PostgreSQL now computes a transaction advisory key and writes no claim-lock row; the schema test rejects the provisional `claim_locks` representation (rung 1 in the current executor, rung 2 for future schema drift) |
| 3 | Generic header serialization admitted NUL and lone-surrogate strings that libSQL stored but PostgreSQL could not later inspect as JSON | Cross-dialect durable state could be accepted at ingress and then remain permanently unclaimable | Single portable ingress representation plus shared conformance on every dialect | The existing string round-trip rule protected protocol names, while generic JSON serialization treated opaque payloads and SQL-inspected headers as one domain | One `serializeTaskHeaders` boundary is used by both stores and shared conformance rejects every invalid key and value before SQL; generic opaque JSON remains unchanged (rung 1 for current ingress, rung 2 and 3 for regression evidence) |
| 4 | PostgreSQL used JSON syntax as a proxy for successful `jsonb` conversion and then performed raising casts inside claim and activation guards | One `1e1000000` durable value aborted an atomic claim and starved a healthy bounded candidate | Dialect-native corrupt-storage conformance and a mutation at the conversion guard | The shared cases covered malformed and out-of-domain JSON, but not syntactically valid values outside PostgreSQL `jsonb` and `numeric` range | `pg_input_is_valid(value, 'jsonb')` gates the current PostgreSQL TEXT-to-`jsonb` retry, header, and cancellation conversions; exact overflow cases and the `postgres-jsonb-input-validity` mutation attack that authority (rung 1 within the current fragment inventory, rung 2 and 3 at its boundary) |
| 5 | Privately created pools and directly checked-out clients had no EventEmitter `error` owner | An idle disconnect or active socket failure could terminate the Node process; an errored checked-out client could also be returned without the event forcing its discard | The PostgreSQL adapter's generated connection-lifecycle fault surface | Existing executor cases modeled transport failures as rejected promises, so every `try`/`catch` and error-classification assertion could pass while the driver's second failure channel remained unowned | `createOwnedPostgresPool` inseparably installs the private pool listener, and `PgExecutor.batch` owns active-client errors from checkout through release and discards an errored client; direct idle and active emission cases exercise both intervals (rung 1 for the current ownership shapes, rung 3 for driver semantics) |
| 6 | The exponential retry-factor guard placed `jsonb_typeof(...) = 'number'` beside a raising `::numeric` cast in an `AND` expression | Correct inert refusal at candidate, receipt, and activation depended on PostgreSQL choosing a short-circuit order; another legal evaluation order could abort the transition on corrupt durable JSON | Generated-SQL construction coverage for each raising conversion, backed by adversarial values at every worker-authority door | Runtime cases exercised outcomes under the current PostgreSQL 17 plan, and `jsonbInputValid` proved only the outer TEXT-to-`jsonb` conversion; neither required the nested scalar cast to be subordinate to its type test | The factor cast now exists only in the `ELSE` arm of its type-rejecting `CASE`; `postgres-retry-factor-type-guard` reverts it to the unsafe sibling-`AND` shape and has an exact construction owner, while shared conformance exercises candidate, receipt, and activation (rung 1 for the current expression, rung 2 for construction, rung 3 for runtime outcomes) |
| 7 | Fresh PostgreSQL bootstrap relied on `CREATE TABLE IF NOT EXISTS` without the version-authoritative concurrent-write recovery used by later migration batches | Simultaneous first-start processes could fail after another process completed the schema; every observed eight-way run produced seven SQLSTATE `23505` failures requiring retry | Native schema-admin concurrency conformance plus one recovery primitive for every schema-version write | Fresh-schema conformance used one caller, while concurrent-winner recovery was scoped only to the post-bootstrap migration loop; `IF NOT EXISTS` suppresses an already-visible object but does not serialize simultaneous PostgreSQL catalog insertion | `applyVersionedWrite` is the single current bootstrap-and-migration recovery boundary: after an error it re-reads the authoritative version and succeeds only when metadata exists at or beyond that write's target; shared conformance runs eight cold-start migrators against the real backend (rung 1 for current write shape, rung 3 for native semantics) |
| 8 | PostgreSQL migrations v1-v5 lacked the frozen content hashes required for append-only history | A later edit to an already-shipped migration could pass the build and split fresh from upgraded schemas while both reported the same current version | Per-dialect `schema.test.ts` content-hash freeze required by `/pr-gate` | PostgreSQL tests pinned `[1, 2, 3, 4, 5]` and selected columns, types, and sentinels; those are proxies for complete historical identity, and the existing libSQL freezer did not enroll the new dialect | PostgreSQL schema tests compare every `statements.join('\n')` SHA-256 digest with an independent frozen literal and reconcile frozen-entry cardinality with `MIGRATIONS` (rung 2) |
| 9 | `serializeTaskHeaders` enforced portable characters but reused the generic JSON-value domain, so runtime values outside an object of strings survived ingress | Spawn could report success for durable work that claim admission would never return; an undefined-valued header was silently omitted instead | Exact runtime header-domain validation plus shared pre-SQL conformance on every dialect | The compile-time `Record<string, string>` was treated as runtime evidence, and finding 3's cases attacked string encoding without attacking root/value shapes or proving that rejection preceded executor I/O | `serializeTaskHeaders` now owns one snapshot that accepts only a plain or null-prototype object with portable string keys and own enumerable string-keyed values; shared conformance attacks invalid roots and values through both stores and proves zero executor calls and rows (rung 1 for current ingress, rung 3 for cross-dialect semantics) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial native-claim review | 1 | No |
| Re-review of the first claim-lock repair for lifecycle and operability | 1 | No |
| Cross-dialect serialization review, including review of its first repair | 1 | No |
| PostgreSQL conversion and bounded-progress review | 1 | No |
| PostgreSQL pool and checked-out-client lifecycle review | 1 | No |
| Final PostgreSQL nested-conversion review | 1 | No |
| CodeRabbit PostgreSQL bootstrap-concurrency review | 1 | No |
| Final `/pr-gate` migration-history audit | 1 | No |
| Exact-head adversarial Codex header-domain review | 1 | No |

Self-catch rate: **0 of 9, or 0%** (previous round: **100% after merge, but
0% before merge**). There is no pre-merge improvement over PR #15. The red
tests in this branch were written after the reviewers named these failures, so
they are reproductions, not self-catches. Existing shared conformance did catch
the separate safe-`int8` representation mismatch before review; that is the
machinery working, but it is not one of these nine escaped findings and does
not improve this ledger.

## Recurrence

Finding 1 is a recurrence of a contract already written into DESIGN: a
same-token claim is one idempotent receipt. The existing SQL guarded the write
with `NOT EXISTS` and the receipt read with the token, but both checks occurred
after PostgreSQL had selected and row-locked disjoint candidates. The mechanism
proved that a visible prior receipt prevented another write; it did not prove
that two initially invisible receipts could not be created concurrently. That
is a timing proxy for the property, not the property.

Finding 2 recurs at the lifecycle class. Durable sentinels are appropriate for
long-lived event coordinates, so the first repair reused that established
shape for fresh per-invocation claim tokens. Exclusion was treated as the whole
property and the primitive's lifetime and key cardinality were omitted. This is
the same outcome-before-machinery lesson at storage altitude: a mechanism that
prevents duplicate work is still defective if correct operation consumes
unbounded state.

Finding 3 recurs in the repository's single-representation and portability
class. Protocol names already rejected values that do not round-trip through
storage, but that authority was scoped by type name rather than by every value
later interpreted by dialect SQL. The first repair then recurred inside the
same round in the opposite direction: it made the generic JSON serializer a
proxy for the narrower header domain and rejected opaque values that never
cross that boundary.

Finding 4 is another explicit proxy-for-property recurrence. `value IS JSON`
answered whether PostgreSQL recognized JSON syntax; the required property was
whether all later `jsonb` and numeric operations on that exact stored value
were non-raising. Earlier corruption guards and mutations attacked malformed
shape and semantic bounds, so they could all pass while conversion itself
aborted the statement.

Finding 5 recurs at the new-layer fault-surface class. Executor tests already
injected failed connects, queries, and rollbacks, but every injection used a
rejected promise. That mechanism checked the adapter's handling after a
failure entered `await`/`catch`; it did not check that every failure channel
the driver can use had an owner in every resource-lifecycle interval.
EventEmitter delivery therefore remained a proxy-blind second channel. The
standing rule that every new layer gets a generated fault surface named the
right property, but this PostgreSQL adapter had not instantiated that rule for
pool-idle and client-checked-out states.

Finding 6 is a direct recurrence of finding 4 in the same review round and of
the earlier durable-payload admission class. `jsonbInputValid` closed the
outer TEXT-to-`jsonb` conversion but was described as if it made every nested
conversion non-raising. It did not own JSON-scalar-to-`numeric` evaluation.
The duration fields already put their casts behind `CASE`; factor re-derived
the same property as sibling `AND` operands. The mechanism therefore guarded
one conversion boundary while proxying the next one, and the existing runtime
tests could remain green precisely because the current PostgreSQL 17 plan
chose the favorable operand order.

Finding 7 recurs in both the native-concurrency and single-definition classes.
The migration loop already re-read the authoritative schema version after a
concurrent writer won, but bootstrap reimplemented the write without that
recovery. `CREATE TABLE IF NOT EXISTS` was treated as a concurrency mechanism
even though it only suppresses an object visible to that statement; it does
not prevent simultaneous catalog uniqueness conflicts. The mechanism was
scoped to the `migrate:v*` loop rather than to the property “a schema write is
complete when the authoritative version has reached its target.”

Finding 8 is a direct recurrence of the migration-history class that created
the libSQL freezer: editing an old migration can strand databases that already
recorded its version. The repository already had both the mechanism and an
explicit `/pr-gate` rule, but they were scoped to the existing dialect rather
than structurally enrolled with every new migration-bearing store.
PostgreSQL's version-list assertion proved only labels, and its selected DDL
assertions proved only sampled properties of the fresh schema; both stayed
green while unasserted historical content remained writable. This is the
new-layer mechanism-travel failure in its simplest form.

Finding 9 is a direct recurrence of finding 3 in the same review round. The
repair gave headers their own serializer, but that serializer enforced only a
property of strings it happened to encounter, not the complete runtime header
value. The compile-time `Record<string, string>` and generic JSON normalization
were proxies for the actual object-of-strings contract; an undefined value was
even erased before any check could reject it. The database admission guards
correctly enforced the narrower domain, so source and consumer retained two
representations of what a valid header was. The mechanism for finding 3 did not
close the class because its tests enumerated encoding hazards without asking
whether every successful spawn was claim-admissible.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Closed `lockClaim` control | 1 for caller-supplied data shape, not executor behavior | An executor can accept `transactionLock` and deliberately discard it before running the statements. The core type and closed-coordinate tests still pass because no caller supplied SQL; the native same-token test is the separate semantic net that fails this specimen. |
| Warmed sixteen-client same-token case | 3 | Configure the fixture pool with `max: 1` and remove `acquireTransactionLock`; the pool serializes the sixteen promises and the receipt assertions pass. The production fixture explicitly warms independent clients, but the test proves the configured concurrency path, not every deployment pool. |
| Advisory lock with no durable claim representation | 1 in the current PostgreSQL executor | A future executor can acquire the advisory lock and also insert every token into `receipt_gates`; exclusion remains correct and all claim outcomes pass while storage again grows without bound. The executor's current source has no such write, but that absence is not a cross-dialect type property. |
| Exact `claim_locks` schema rejection | 2, syntactic | `CREATE TABLE receipt_gates (queue TEXT, token TEXT, PRIMARY KEY (queue, token))` plus an insert in the lock prelude still passes `expect(ddl).not.toContain('claim_locks')`; the checker pins the reviewed representation, not the lifetime property. |
| Shared `serializeTaskHeaders` ingress | 1 for the two current store implementations | A future import or alternate spawn path can persist `JSON.stringify({trace: 1})` or `JSON.stringify({trace: '\u0000'})` directly. Existing spawn conformance remains green because it exercises the centralized public ingress, not arbitrary administrative writes. The durable read guards keep such raw corruption inert rather than making it portable. |
| Shared runtime header-domain conformance | 3 | Add a header-only special case that accepts a `Date` root before the exact object-domain check. The eight named invalid inputs and zero-I/O assertion still pass while that unlisted runtime value is silently normalized or persisted outside the claimed header domain. The source predicate owns the class; the vector proves the current store ingresses and representative shapes. |
| Opaque-value preservation regression | 2 | A new checkpoint path can call `serializeTaskHeaders('task headers', state)` while the current result and event payload preservation assertions remain green. The test protects the audited opaque paths, not a type-level distinction between inspectable objects and opaque JSON. |
| `jsonbInputValid` shared fragment plus exact mutation | 1 for current callers, rung 3 for semantics | Add a future `t.params::jsonb` projection outside `durableTaskRetryAdmissible`, `durableTaskHeadersAdmissible`, and cancellation admission. Replacing the current helper with `TRUE` is still caught, but the new unregistered cast is outside that mutation and the current overflow cases pass. |
| Factor `CASE` plus `postgres-retry-factor-type-guard` | 1 for the current factor expression, 2 for the exact construction owner | Add a future numeric retry field whose guard is `jsonb_typeof(value) = 'number' AND value::numeric > 0`. The factor-specific `CASE` and mutation still pass while the new field again depends on unspecified operand evaluation. |
| Candidate/receipt/activation malformed-factor vector | 3 | Restore the old sibling-`AND` factor expression on PostgreSQL 17. Every observed malformed shape still refuses inertly under the current plan, so all three runtime doors pass; the separate construction owner is what rejects that unsafe SQL. |
| `createOwnedPostgresPool` | 1 for pools constructed through the factory | Add another private adapter pool with `new Pool(config)` instead of the factory. Both current lifecycle cases still pass because they attack `PgExecutor.open` and an active client, not every future construction site; the new idle pool can still emit a process-fatal unowned `error`. |
| Checked-out-client error ownership and discard | 1 for the current `batch` checkout interval, rung 3 for the emitted-event probe | Add a new executor method that calls `pool.connect()` and uses the client directly without the scoped listener. Existing `batch` lifecycle coverage remains green while that new active client has the original fatal event gap. Also, the listener owns the event but does not independently settle a driver query that emits and then hangs forever; connection timeout/progress remains a separate operability property. |
| Idle and active pool-lifecycle regressions | 3 | Replace a future private control pool with raw `new Pool()` or add a direct checkout outside `PgExecutor.batch`; the two existing emit probes still pass because their enumerated sites retain owners. These tests prove the two current intervals, not structural enrollment of every future pool use. |
| Shared `applyVersionedWrite` target check | 1 for the current PostgreSQL `migrate()` write inventory | Add a future schema-admin entry point that calls `db.batch` directly for a catalog write. Current bootstrap and `MIGRATIONS` remain protected and the cold-start case stays green, while concurrent use of that new entry point can repeat the lost-winner failure. The helper closes the current inventory; its use is not type-enforced for every future schema write. |
| Eight-way concurrent cold-start conformance | 3 | Configure the PostgreSQL fixture pool with `max: 1` and restore the old bootstrap. The eight promises serialize and pass despite the missing recovery. The current fixture exercises real parallel connections, but the assertion alone does not prove that future fixture configuration preserves concurrency. |
| PostgreSQL version-list and selected-DDL assertions | 2, incomplete proxy | Append `CREATE INDEX drivers_expiry ON drivers (queue, expires_at_ms)` to PostgreSQL v2. The old three schema tests pass, a fresh database receives the index, and an already-v2 database never does. These checks describe parts of today's schema, not historical identity. |
| Frozen PostgreSQL migration hashes | 2 | Edit a shipped migration and update its expected digest in the same commit. The hash test passes while upgraded databases still skip the edit. The mechanism catches unpaired history rewrites and makes a paired refresh review-visible; it does not make old history unwritable. |

Findings 1-5, 7, and 9 were also executed, not inferred. Removing the
same-token prelude produced ten running rows from sixteen concurrent
`limit: 1` calls. The provisional sentinel representation inserted one new
key for each fresh token. The first broad serializer repair made the opaque
NUL and lone-surrogate preservation test fail. Passing
`{"kind":"fixed","baseSeconds":1e1000000}` through the old PostgreSQL guard
raised SQLSTATE `22003` and returned no healthy bounded receipt. Against the
unrepaired pool lifecycle, both `pool.emit('error', idleError)` and
`client.emit('error', activeError)` synchronously threw the emitted error
because neither interval had a listener.

Against the unrepaired bootstrap, five independent eight-way cold-start rounds
each produced one fulfillment and seven SQLSTATE `23505` rejections while
still leaving the schema at the current version.

Against the unrepaired runtime header boundary, both dialect instances resolved
the null-root spawn with created task and run identifiers instead of rejecting
before SQL. The persisted `null` header is outside both dialects' durable
object-of-strings admission predicate, so the successful spawn created work its
claim path would refuse.

Finding 6 is deliberately not represented as a reproduced runtime incident.
On buggy parent `26f7861`, the data-driven candidate, same-token receipt, and
activation cases all passed with a nonnumeric string factor. Additional
PostgreSQL 17 probes using string, overflow-looking string, empty string, null,
Boolean, object, and array factor shapes were also green at all three doors.
The failing evidence was the generated-SQL construction assertion: the cast
was a sibling `AND` operand rather than part of the selected typed `CASE` arm.

## Fix-induced defects

One finding was caused by a repair in this review round. The first response to
the header portability finding put the NUL and lone-surrogate restriction in
generic `serializeTaskValue`. That rejected valid opaque result and event JSON
and widened the public contract beyond the failing boundary. Red commit
`3953e60f25f106671cb6788228635ac5699728d7` captured the regression before the
repair was accepted. The replacement was re-reviewed as new code and splits
`serializeTaskHeaders` from the unchanged opaque serializer; it was not merely
declared safe because the original header tests turned green. Findings 6-9 did
not increase the fix-induced count. The unsafe factor expression predated the
finding 4 repair, and both the bootstrap asymmetry and missing PostgreSQL
history freeze existed in the original dialect implementation rather than
being introduced by an earlier repair in this round. Runtime-invalid header
shapes were also admitted before finding 3 and remained admitted after its
narrow repair: finding 9 is a failed class closure, not a defect caused by that
repair.

## Evidence

- Red commit `df8424bc67989d3270a9cb4b43e4bd39adc1a36e`, run against buggy parent `ab6f67a5a1e391d099a908cc26294a5c2805c141`, adds both the portable-header ingress cases and real same-token concurrency. Before repair, sixteen `limit: 1` calls with token `one-logical-request` left ten running rows instead of one; the invalid-header cases reached SQL instead of failing at ingress.
- Red commit `3953e60f25f106671cb6788228635ac5699728d7`, run against the first broad serializer repair, proves that opaque NUL and lone-surrogate result/event JSON must remain canonical JSON rather than inherit the header restriction.
- Red commit `6a01730770d9f8b7805b3fbdf2f16f5ecbe74065`, run against buggy parent `f631ccfeb853b48a59b97f73ae8249b9f8b14492`, adds the shared runtime header-domain case and requires rejection before executor I/O. The confined command `pnpm exec vitest run packages/conformance/test/libsql.test.ts --maxWorkers=1 -t 'rejects runtime header shapes outside an object of strings before persistence'` reported one failed file, 2 failed and 5,148 skipped; both dialect promises resolved with created task and run identifiers instead of rejecting.
- Green commit `bde74f54fb23e50604dd5247c51615e4d35c0725` gives `serializeTaskHeaders` an exact object-of-portable-strings snapshot while preserving the opaque JSON path. The same confined targeted command reported one passed file, 2 passed and 5,148 skipped. Confined `pnpm verify` then passed 99 files and 5,884 tests; the shared conformance file ran 5,150 tests in 402.4 seconds.
- Red commit `34956e565a0afcbabfdc69a026ae93099326696d`, run against buggy parent `3953e60f25f106671cb6788228635ac5699728d7`, adds PostgreSQL `jsonb` overflow candidates. The retry probe raised SQLSTATE `22003` and starved the healthy row behind the poison candidate.
- Red commit `73a88a22b1d0182ac42dfbd2687d1b21ec160c34`, run against buggy parent `34956e565a0afcbabfdc69a026ae93099326696d`, adds two direct EventEmitter probes. Before repair, both the private pool's idle-client emission and the checked-out client's active emission threw synchronously instead of remaining owned; the active case also requires the emitted error to be passed to `release` and its temporary listener removed.
- Red commit `90e1d13`, run against buggy parent `26f7861`, adds the three shared malformed-factor door cases and the generated-SQL construction assertion. The three PostgreSQL 17 runtime cases were green; the construction assertion was observed red because the numeric cast was not inside a typed `CASE` arm.
- Red commit `2baf3f7c54225af13fcd768c277d0682ee94069a`, run against buggy parent `b6ec4db`, adds the shared eight-way cold-start case. A separate five-round PostgreSQL probe produced one fulfilled migration and seven SQLSTATE `23505` rejections in every round, even though the schema reached its current version. The confined targeted command `bash scripts/confine.sh pnpm exec vitest run packages/conformance/test/libsql.test.ts --maxWorkers=1 -t 'lets concurrent cold-start migrators converge on the current schema'` then passed the libSQL case and reproduced the PostgreSQL failure with one fulfillment and seven rejections.
- Green commit `390da296cf5ac24e12644a9059194dacb0a4b5e1` routes both bootstrap target zero and every versioned migration through `applyVersionedWrite`. The same confined targeted command completed with 2 passed and 5,146 skipped.
- Red commit `8e786a0ee720c50bc88dbe63cee10d72b5cd1075`, run against buggy parent `390da296cf5ac24e12644a9059194dacb0a4b5e1`, adds the independent append-only PostgreSQL hash assertion with an empty frozen inventory. The targeted PostgreSQL schema test was observed red with 1 failed and 3 passed: `migration v1 is not frozen`.
- Green commit `3663053b399069ab9fed2fe0d3b4c0ddf5400497` freezes the exact SHA-256 digest of `statements.join('\n')` for PostgreSQL v1-v5 and reconciles the frozen inventory with `MIGRATIONS`; the targeted schema suite passed 4 of 4.
- The migration-freeze negative control appended `CREATE INDEX drivers_expiry ON drivers (queue, expires_at_ms)` to PostgreSQL v2 at `390da296cf5ac24e12644a9059194dacb0a4b5e1`. The old schema suite passed 3 of 3 while fresh and already-v2 schemas would diverge. Under the new guard, the same edit produced 1 failed and 3 passed at v2: the frozen digest was `74b6c407aff872af263b439a96147a7a542931434b381f8950058ea77770f183`, while the edited history produced `7079ac510a30bceea349691116d6072ad70ef61e30a060eff0cf0b4ba8d5c49b`. Restoring the original migration returned all 4 tests to green.
- Earlier fixes culminate in commit `e68cf6d`. Green commit `f41999a` moves the factor cast into the selected `CASE` arm and enrolls `postgres-retry-factor-type-guard` as live mutation 423. Focused green evidence before that final factor fix was 31 of 31 PostgreSQL package tests, 2 native same-token dialect cases, 2 header-ingress dialect cases, 8 of 8 PostgreSQL JSON hazard cases, 13 of 13 task-value cases, and 2 of 2 PostgreSQL pool-lifecycle cases. The final-head full verify, TLC, fuzz, and mutation results belong to the PR gate record and are not pre-claimed by this draft.
- Finder, native-claim review, quoted verdict: "Sixteen concurrent limit-one calls with one token created ten running rows; candidate row locks do not serialize the logical receipt."
- Finder, lifecycle re-review, quoted verdict: "Claim tokens are fresh, so a durable lock row turns correct scheduler traffic into an unbounded sentinel table."
- Finder, portability review, quoted verdict: "SQLite can accept a header string that PostgreSQL later cannot convert; restricting every opaque JSON value is a second contract bug, not the fix."
- Finder, conversion review, quoted verdict: "`IS JSON` accepts the payload, then `::jsonb` raises before the guard can refuse it, aborting the bounded claim."
- Finder, connection-lifecycle review, quoted verdict: "Privately owned `pg` pools and directly checked-out clients have no EventEmitter error owner; a backend or socket failure can terminate Node."
- Finder, final conversion review, quoted verdict: "PostgreSQL retry factor guard can still raise inside claim/activate."
- Finder, final conversion review, quoted verdict: "one PostgreSQL JSON conversion guard remains raising instead of inert."
- Finder, CodeRabbit PostgreSQL admin review, quoted verdict: "`migrate()` then throws on a cold start even though the database reached the correct state. Callers must retry."
- Finder, final `/pr-gate` migration-history audit, quoted rule: "Migrations are APPEND-ONLY, machine-enforced: schema.test.ts freezes every migration's content hash."
- Finder, exact-head adversarial Codex header review, quoted verdict: "spawn can persist headers that PostgreSQL later refuses to claim." Release triage accepted it as finding 9 because a successful spawn followed by an admission-inert task violates the PostgreSQL outcome regardless of when the gap originated.
- The sixth finding did not reproduce as a PostgreSQL 17 runtime failure: candidate, same-token receipt, and activation all refused the corrupt value without changing durable state, and the broader malformed-factor probes listed above were also green. This disconfirmation is why the red and mutation owners are construction-level rather than a claimed runtime counterexample.
- No deployed fresh/upgraded divergence was reproduced for finding 8 because PostgreSQL is being enrolled before its first release. The controlled v2 historical edit demonstrates the release-gate false negative rather than claiming a production incident.
- Event loss did not reproduce in the repaired implementation: the native await/emit race lost 0 of 24 wakeups, while the deliberately stripped control lost 47 of 48. This establishes the harness's sensitivity but is not counted as an additional product finding.
- Distinct-token overlap did not reproduce: the native `SKIP LOCKED` case returned eight unique runs across four bounded claimers. Advisory-key collisions cannot allow overlap; PostgreSQL serializes equal 64-bit keys, so a collision can only reduce concurrency.
- The safe-`int8` mismatch did not survive to review: existing shared conformance rejected bigint values inside JavaScript's safe range, and the executor now canonicalizes those to numbers while preserving unsafe exact values as bigint.

## Root cause

The common machinery failure was treating dialect-neutral logical outcomes as
proof of dialect-native boundary behavior. The original suite was strong at
fenced state transitions once one batch executed, but it did not own what
happened before the batch on two real clients, how a lock primitive's state
aged after commit, which runtime values satisfied the complete header wire
domain, which JSON strings a second backend could represent, or whether a
preliminary PostgreSQL predicate and each nested scalar-type check structurally
owned the later cast that could raise. It also modeled driver
failures only as Promise rejections, not as `error` events whose ownership
changes when a client moves between idle and checked-out states. SimWorld made
batch scheduling deterministic by treating the batch as one suspension point;
that strength also made native transaction races invisible. Fresh-schema
conformance had only one actor, and the implementation treated `IF NOT EXISTS`
as proof of concurrent convergence while authoritative-version recovery lived
only around batches executed after metadata already existed. The new dialect
also copied logical migration numbers and sampled schema assertions without
carrying over the existing history freezer. A new backend therefore arrived
without a generated fault surface for the adapter behaviors unique to its
birth or structural enrollment in an existing release-safety mechanism.

The deeper recurrence is scope by implementation artifact instead of property.
The SQL contained a token guard, the lock used a row, the value was valid JSON,
header serialization was centralized and statically typed, the factor had a
type predicate, Promise failures were caught, bootstrap said `IF NOT EXISTS`,
and the migration list was `[1, 2, 3, 4, 5]`; each statement was true while the
required property was false. The header type was compile-time only and the
serializer checked characters rather than the complete runtime shape. The
version list and sampled DDL properties said nothing about complete historical
identity. In the factor case, even the observed runtime result was correct
while the construction depended on unspecified evaluation order. The repairs
move current paths toward the properties and add real-backend counterexamples
or an exact construction owner where the current backend plan masks the hazard,
but the mechanism audit records where those guarantees still end.

## Mechanisms

Built in this PR:

- `FencedBatch.lockClaim({ queue, claimToken })` carries a closed coordinate, must
  precede the first fenced CAS, and cannot carry caller SQL. `PgExecutor` maps
  it to a namespaced transaction advisory lock on the same client and
  transaction as the claim batch (rung 1 for the current path).
- Shared conformance warms independent PostgreSQL connections and executes
  distinct-token, same-token, and await/emit races against the native backend
  rather than SimWorld (rung 3 with demonstrated negative controls).
- PostgreSQL schema tests pin the absence of the reviewed `claim_locks`
  representation, while the executor contains no durable claim-lock write
  (rung 2 supporting a rung 1 current implementation).
- `serializeTaskHeaders` is the single narrow source boundary for headers in
  both stores. It snapshots the raw runtime value once and accepts only a plain
  or null-prototype object whose keys and own enumerable string-keyed values
  are portable strings, before JSON omission can normalize an invalid field.
  `serializeTaskValue` continues to preserve opaque JSON strings. Shared
  conformance proves representative invalid roots and values make no executor
  call and leave no row (rung 1 for current ingresses, with shared conformance
  at rung 3).
- `jsonbInputValid` is the single outer TEXT-to-`jsonb` conversion predicate
  used before current retry, header, and cancellation `jsonb` operations.
  Corrupt-storage cases cover candidate and same-token receipt paths, and the
  `postgres-jsonb-input-validity` mutation replaces the authority with `TRUE`
  to prove attributable failure (rung 1 inventory plus rung 3 semantic
  attacks).
- Nested retry-number conversions are field-local selected `CASE` expressions:
  duration and factor casts execute only after their JSON type arm admits them.
  `postgres-retry-factor-type-guard` restores the unsafe sibling-`AND` factor
  shape and is owned by an exact generated-SQL assertion, while shared
  conformance exercises candidate, same-token receipt, and activation outcomes
  (rung 1 for the current expressions, rung 2 for construction, and rung 3 for
  runtime behavior).
- `createOwnedPostgresPool` constructs a private pool and installs its idle
  `error` owner as one operation; both `PgExecutor.open` and the private fixture
  control pool use that factory. `PgExecutor.batch` installs an active-client
  listener immediately after checkout, records the first error so `release`
  discards the client, and removes its listener only after release restores
  pool ownership. Direct idle and active emission cases prove the two current
  lifecycle intervals (rung 1 for the current resource shapes, rung 3 for the
  driver's EventEmitter behavior).
- `PostgresStoreAdmin.applyVersionedWrite` is the single current recovery
  boundary for bootstrap target zero and every versioned migration target.
  After any write error it re-reads the canonical schema version and absorbs
  the error only when the target is already complete. DESIGN records the same
  rule, and shared schema/admin conformance launches eight migrators against
  one genuinely fresh backend (rung 1 for the current write inventory, rung 3
  for the PostgreSQL race).
- PostgreSQL's append-only schema test independently freezes the SHA-256
  content of migrations v1-v5 and requires exact one-for-one enrollment with
  `MIGRATIONS`. Any unpaired edit to shipped history now fails the build, so a
  schema change must append a new version and hash (rung 2).

Deferred (recorded in BUILD.md):

- PR3.9's all-operation SQL-tree work remains outside this milestone. It could
  discover future unregistered PostgreSQL casts more generally, but the current
  named conversion sites have one outer helper, field-local typed `CASE`
  guards, exact native and construction regressions, and two live conversion
  mutations; a new SQL framework would delay the PostgreSQL outcome.
- PR3.10's per-condition mutation expansion remains deferred. This PR adds the
  two mutations at the changed outer and nested JSON conversion authorities.
  This PR records the exact affected closure; the unfiltered audit is deferred
  under the explicit PR-body gate change to its scheduled/pre-release owner.
  Broader attribution machinery is not needed to close these nine findings.
- No finding-specific product correction is deferred. MySQL conformance and
  PostgreSQL oracle parity remain milestone non-goals rather than evidence for
  the PostgreSQL 17 exit test.

## What this round still would not catch

A future dialect executor can accept the closed lock coordinate but ignore it,
and a fixture that serializes all requests through one connection can let its
native same-token case pass. A new durable sentinel under another table name
can also restore unbounded lock state while the exact `claim_locks` schema test
stays green. Those are the explicit boundaries of the current lock mechanisms.

A new ingress can bypass `serializeTaskHeaders`, or a new opaque field can be
mistakenly routed through it; the present tests cover the current public stores
and audited opaque result/event paths, not an uninhabitable type distinction.
Likewise, a future PostgreSQL `::jsonb` operation outside the three registered
admission fragments can raise without being attacked by the current helper
mutation. Those defects would ship today if their new paths were not enrolled
in conformance at birth.

A future nested numeric JSON field can repeat finding 6 by placing a type
predicate beside its cast in an `AND` expression. The factor-specific mutation
would remain green, and the runtime matrix could also remain green under a
favorable PostgreSQL plan. That defect would ship unless the new conversion
received its own construction owner or the deferred SQL-tree work closed the
shape structurally.

A future private `new Pool()` call that bypasses `createOwnedPostgresPool`, or
a new direct `connect()` path outside `PgExecutor.batch`, can restore the
process-fatal EventEmitter gap while today's two lifecycle cases stay green.
Caller-supplied pools passed to `fromPool` also retain caller ownership of idle
pool errors; the executor owns only clients during its checkout interval. The
current active listener prevents an unhandled event and forces client discard,
but it does not itself impose a deadline on a driver call that emits and then
never settles. The next backend must therefore add its native concurrency,
conversion, connection ownership, and lifecycle surface with its first
implementation, not after a reviewer demonstrates the missing property again.

A future PostgreSQL schema-admin write can bypass `applyVersionedWrite`; no
closed type currently makes such an unenrolled write impossible. The native
regression can also become a false green if its fixture is changed to serialize
all eight calls through one connection. Either shape could restore failed
cold-start convergence while today's current-path evidence remains green.

A coordinated edit to an old migration and its expected digest can still pass;
the literal hash makes that change conspicuous in review but does not make it
unwritable. Schema-changing SQL introduced outside `MIGRATIONS` also lies
outside the freezer. Either shape could split fresh and upgraded databases, so
the mechanism's honest boundary is accidental or unpaired mutation of the
enrolled migration bodies.
