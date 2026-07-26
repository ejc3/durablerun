# Postmortem: PR3.7 final green audit

An independent whole-system green-diff audit of exact head `eafd0d0` found
**seven confirmed blockers**. Two could corrupt run-attempt bookkeeping or
make a suspension non-atomic, one let a negated fence satisfy the construction
guard, one let a dialect omit a shared conformance surface, and three let
safety checkers accept inputs they claimed to reject. After those seven were
fixed in `27e1ad8`, the project's full mutation audit found an eighth defect in
its own attribution machinery at the `dc10820` head: the
`successor-ownership` mutation reached the intended unique-key collision, but
the expected-error regex named the wrong unique constraint. That self-caught
finding was corrected in `d8d4a68`.

The mandatory simplify and mechanism-boundary passes then found three more
defects in the new CodeRabbit custom-check validator. Quoted and YAML-merge
fields escaped the first allowlist (finding 9), a nine-space invalid field
escaped its first total-field repair (finding 10), and invalid mapping content
before the first list entry remained unowned (finding 11). These three
self-catches were fixed in `138120a`, `a2422a8`, and `fc5d710`.

The closing 50-mutation audit attempt then found finding 12: after 49
attributable mutations, the migration postcondition mutant reached the exact
named test, but Vitest discarded the test's custom promise message when the
mutant unexpectedly resolved. The audit failed closed at `c11d162`. Its
`3a47f2c`/`2d1a481` repair was itself reviewed as new code and produced
findings 13–15: a duplicate TypeScript lexer and literal-marker proxy,
replacement errors attributed at the wrong outcome altitude, and stateful
reusable regular expressions. Red `2c0318e` and green `c1ceca2` closed those
three.

The two exact mutation replays then caught findings 16 and 17. Importing the
shared lexer created an untracked bytecode cache before the clean-tree runner
checked its precondition; `c4e2a83`/`1940b48` made the import side-effect an
executable fixture. The schema-fault mutant then emitted a caller-decorated
marker rather than the registry's canonical marker;
`4fd2876`/`a0bfb80` moved marker construction into the helper.

A final adversarial review of those repairs found findings 18–20 before the
long audit: TypeScript's postfix non-null assertion could hide a batch call
inside a misclassified regex, generic/optional/parenthesized `expect` forms
escaped or falsely tripped the promise checker, and a same-named object method
could satisfy helper inventory. Red `5692690` and green `491b4d7` made all
three counterexamples executable.

The required re-review of `491b4d7` then found finding 21: optional generics,
nested transparent parentheses, relational syntax, private methods, and
constructors demonstrated that the new hand parser was still a picture of
TypeScript grammar. Red `597dcd1` exposed six mismatches. Compiler validation
corrected two fixture formulations, and both corrected valid forms still
failed against buggy `491b4d7`. Green `035c443` deleted the parser and
delegates the complete source set to one TypeScript-compiler AST pass.

**This document is adversarial toward the machinery and blameless toward
people.** The question throughout is what would have made each defect
unwritable or machine-caught before any reviewer inspected the green
branch.

## Severity

Finding 7 was the worst escaped behavior. An expired activated claim whose
stored `attempt` was corrupt text could still be swept: SQLite coerced the text
during `f.attempt + 1`, failed the old run, and inserted a successor with a
laundered ordinal. That damages the durable attempt identity and the retry
accounting that depends on it.

Finding 1 was another atomicity failure at the same representation boundary.
With a non-integer stored attempt, `suspendRun` resolved successfully and moved
the run out of `running` instead of rejecting the entire operation and leaving
both the run and its checkpoint unchanged. A worker could therefore observe a
successful suspension whose durable bookkeeping was not valid.

Finding 3 let a losing invocation's follow-on be constructed with its only
fence under `IS NOT`; the text contained a fence equality, but that equality
did not authorize the write. Finding 2 allowed a store dialect to appear
enrolled while silently omitting an entire shared conformance surface.
Findings 4–6 weakened the preventive gate itself: forbidden eligibility SQL,
raw fake-clock reads, or deletion of the nightly workflow could all pass the
checker that claimed to exclude them.

Finding 8 did not corrupt production state: the mutation audit stopped the
branch. Its impact was evidence integrity and merge safety. Commit `eafd0d0`
had narrowed the expected `successor-ownership` collision from either
`(task_id, attempt)` or `run_id` to `run_id`, but the mutation actually proves
ownership by colliding on `(task_id, attempt)`. The audit therefore reported a
WRONG-PATH failure instead of attributable success. Shipping that attribution
would make the project's claim that each mutation reaches its named causal
verdict false, and would block every honest full audit at that mutation.

Findings 9–11 threatened the hosted review layer. CodeRabbit custom checks
support only the owned `name`, `mode`, and `instructions` shape. A quoted
unsupported key, YAML merge, malformed-indentation key, or invalid mapping in
the list prelude could make the hosted configuration invalid while
`review-bot-lint.py` reported clean. The hosted reviewer could therefore ignore
the configuration precisely when the repository claimed its adversarial rules
were active. Local self-tests and totality probes stopped all three shapes
before push.

Findings 12–17 threatened mutation evidence rather than production state. In
each case the strict classifier or clean-tree precondition stopped the branch:
the intended behavior failed, but the reporter lost the marker; a helper
credited success or an unrelated error; mutable matcher state changed the
second verdict; importing the checker invalidated its own starting state; or a
decorated marker failed exact classification.

Finding 18 threatened the total batch harvest. Valid TypeScript
`value! / Number(this.db.batch(...)) / 2` was lexed as if the division opened a
regular expression, blanking the load-bearing call from `batch-lint.py`.
Finding 19 let valid Vitest generic, optional-call, and parenthesized promise
forms evade the custom-message ban, while a generic nested action with no
message was rejected. Finding 20 let `fake.requireExpectedFailure(...)`
impersonate the actual helper in the cheap inventory. All three weakened gates
that the branch was about to rely on, so the final audit remained frozen until
their red/green pair landed.

Finding 21 proved the repair mechanism itself was below the claimed property.
Continuing to add angle-bracket and parenthesis cases would leave another
syntax proxy in the gate. The branch therefore did not begin its long audit
until compiler parsing replaced that code and all nineteen promise-message and
ten descriptor counterexamples passed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `suspendRun` accepted a non-integer stored `runs.attempt` and completed the transition | A corrupt ordinal could produce a non-atomic successful suspension instead of leaving the running row and checkpoint untouched | Shared transition conformance and the stored-ordinal contract | The suspension CAS did not require the native stored representation even though later bookkeeping relies on that ordinal | `storedInteger('runs.attempt')` on the ownership CAS, the DESIGN rule for ordinal-authoring batches, shared regression, and exact mutation (rungs 1, 2, and 3) |
| 2 | Shared conformance surface IDs and umbrella dispatch were maintained as two independent lists | A new dialect could omit fault, poison, wake, or scheduler behavior while its enrollment inventory still looked complete | Conformance enrollment construction test | The test compared two representations instead of making a second representation impossible | One frozen executable `STORE_CONFORMANCE_SURFACES` registry derives both IDs and dispatch; direct selectable runner exports were removed; an exact construction mutation pins the relationship (rungs 1 and 2) |
| 3 | `FencedBatch` accepted a fence equality in the negated right-hand side of `IS NOT` | A losing batch could construct a follow-on whose fence does not gate the affected rows | Positive-fence construction guard | The restricted SQL scanner recognized `NOT` operands but treated this SQL spelling as if the equality were positive | `negatedSpans` includes the right-hand operand of `IS NOT`, with a focused builder regression and exact construction mutation (rung 2; still syntactic) |
| 4 | `fragment-lint.py` exempted any store source named `fragments.ts`, including nested or unrelated files | Eligibility predicates could acquire a second definition and drift from the canonical dialect fragment | Eligibility-fragment lint and its self-test | Basename was used as a proxy for ownership by the canonical package path | Exemption requires the exact top-level `packages/store-*/src/fragments.ts` shape, and the self-test attacks a nested same-name file (rung 2) |
| 5 | `clock-lint.py` missed reversed fake-clock equality and positive `IN` predicates | Store SQL could read `meta.fake_now_ms` outside `time.ts`, creating a second engine clock | Clock-source lint and its self-test | One equality spelling stood in for the semantic operation of selecting the fake-clock row | The matcher covers equality in both directions and positive `IN`; self-tests pin both spellings (rung 2; still syntactic) |
| 6 | `gate-lint.py` treated a missing `.github/workflows/nightly.yml` as an empty safe workflow | Deleting the long-running verification workflow made every check of its permissions and checkout credentials vacuously pass | Gate self-description lint and its self-test | Absence was not represented as an error before the workflow's contents were checked | Missing nightly configuration is itself a gate error, with a deletion fixture in `lint-selftest.py` (rung 2) |
| 7 | Claim-timeout sweep derived a successor ordinal from corrupt text without first proving the stored attempt was an integer | SQLite could fail the expired run and create a successor whose attempt had been coerced from corrupt storage, laundering the ordinal and changing state partially | Sweep conformance, ordinal provenance rule, and the repair's green-diff review | The successor-provenance repair moved arithmetic to the fenced row but did not guard the representation on the ownership CAS | `storedInteger('runs.attempt')` on the claim-timeout CAS, the same DESIGN rule, shared atomicity regression, and exact mutation (rungs 1, 2, and 3) |
| 8 | `successor-ownership` expected a `runs.run_id` collision although its mutant actually collides on `runs.task_id, runs.attempt` | The full mutation audit rejected a correctly killed mutant as WRONG-PATH, so its causal-evidence claim could not be attested and the branch could not pass the review gate | Exact-verdict mutation audit | The expected-failure string was tightened by repair intuition rather than bound to the constraint the mutated statement actually violates | The test now expects exactly `UNIQUE constraint failed: runs.task_id, runs.attempt`; the targeted mutation rerun proves that exact attribution (rung 3; still an error-text proxy) |
| 9 | The CodeRabbit custom-check allowlist recognized only unquoted identifier keys, so `"statusCheck": true` and `<<: *custom-check-defaults` escaped it | Unsupported fields could invalidate or alter the hosted review configuration while the local checker reported clean | Review-bot lint self-test and simplify pass over the `dc10820` repair | The allowlist inspected only lines that matched the spelling it already understood; unrecognized same-level syntax was ignored instead of rejected | Every significant eight-space entry line must be a literal `mode` or `instructions` field; quoted and merge hostile fixtures pin the refusal (rung 2, syntactic) |
| 10 | The first total-field repair still ignored a significant custom-check line indented nine spaces | Invalid YAML could sit between the owned field and body shapes while the local checker reported clean | The new total-field mechanism's own false-negative boundary probe | “Not exactly eight spaces” was treated as body or irrelevant content without first proving the line was inside the literal instructions body | The parser identifies the unique literal body first, permits only its lines at ten or more spaces, and rejects every other non-eight-space entry line; a nine-space hostile fixture pins it (rung 2, syntactic) |
| 11 | Content between `custom_checks:` and the first `- name` entry was outside every entry-level check | Invalid mapping content could invalidate the custom-check list before the first recognized entry while every recognized entry remained clean | Totality check over the repaired custom-check list | Entry bodies were classified, but the list prelude had no owner | Every significant pre-entry line is rejected; together with findings 9–10, the list prelude and every significant entry line are classified (rung 2, syntactic) |
| 12 | `migration-postcondition-old-version` entrusted its marker to Vitest's `.rejects` custom-message channel | The exact mutant was killed, but the full audit could not attribute the generic unexpected-resolution diagnostic | Full clean-tree mutation audit | Fabricated classifier cases assumed the source marker would be present in the reporter output | Package-neutral inverse-verdict helpers emit the marker themselves on unexpected success and propagate unrelated failures (rung 1 for the verdict shape, rung 3 for the live mutation) |
| 13 | The first promise-message guard duplicated the TypeScript lexer and searched only for a literal mutation marker | Variables and executable template interpolations escaped; regex literals produced false positives | Mutation-verdict source self-test and repair review | A second partial lexer and one marker spelling stood in for the operation of supplying any promise custom message | One TypeScript-compiler AST pass, a ban on every second direct promise-`expect` argument, nineteen source counterexamples, and exact string-literal inventory (rung 2 using the language's parser) |
| 14 | Nested schema helpers credited unexpected success as a replacement failure, while migration accepted any `SchemaMismatchError` | A mutant could earn the named marker through a different outcome or an unrelated schema mismatch | Promise-helper outcome tests and exact live mutation | Nested inverse helpers composed two broader stories instead of one causal replacement shape | `attributeReplacedFailure` owns expected/replacement/unrelated/success arms; the migration predicate matches the exact postcondition type and message (rungs 1 and 3) |
| 15 | Reusing a global or sticky `RegExp` carried `lastIndex` between verdict checks | Identical repeated failures could alternate between accepted and unrelated based on matcher history | Direct helper tests | The helper treated a mutable regular expression as a value | Every match clones the expression before testing; a two-run global-regex regression pins stateless behavior (rung 1) |
| 16 | Importing `source_lex.py` created `scripts/__pycache__` before the mutation runner checked for a clean tree | A clean exact mutation replay refused its own generated artifact before running | Clean-tree mutation runner and executable lint self-test | A new repository-local import added an unmodeled write before the precondition | The final compiler-AST repair deletes the repository-local Python import entirely; a throwaway clean fixture rejects any analyzer import artifact (rungs 1 and 2) |
| 17 | Schema-fault verdicts appended `: <SQL>` to a caller-built marker | The live mutant reached the right test and helper but failed exact marker classification | Exact schema mutation replay | Marker formatting remained independently spellable at every helper call | Helpers accept validated `{kind, mutation}` descriptors and alone construct the canonical undecorated marker; ten compiler-AST descriptor counterexamples pin the source inventory (rung 1, with rung-2 inventory) |
| 18 | The shared TypeScript lexer treated postfix non-null `!` as a prefix/binary operator | Division after `value!` could blank a real `this.db.batch(...)` call as regex contents, defeating total batch harvest | `batch-lint.py` self-test and shared lexer | Prefix and postfix `!` shared one state transition despite opposite left-context semantics | The lexer preserves expression state across lone `!`, handles `!=`/`!==` separately, and a hostile batch fixture pins the call's visibility (rung 2, syntactic) |
| 19 | Promise-message parsing understood only literal `expect(` and treated generic commas as call separators | Valid generic, optional, or parenthesized promise assertions escaped; a valid generic nested action was rejected | Promise-message source surface | Call syntax and argument syntax were approximated by one regex plus delimiter splitting | The compiler AST supplies call and argument identity; nineteen hostile cases cover direct Vitest forms without a second grammar (rung 2) |
| 20 | Helper inventory matched the right method spelling anywhere in a marker file | A same-named object method or unrelated site could satisfy the cheap inventory after the real verdict was removed | Canonical helper-descriptor inventory | File-level spelling was a proxy for a call to the imported helper | Compiler `CallExpression` and object-literal nodes exclude methods, private methods, constructors, comments, and malformed descriptors; ten cases pin the boundary (rung 2; runtime audit remains causal authority) |
| 21 | The hand-written TypeScript call parser still misread optional generics, nested parentheses, relational expressions, private methods, and constructors | Promise messages could escape or false-positive, and non-helper calls could satisfy descriptor inventory | Mandatory re-review of the findings 19–20 repair | Delimiter heuristics remained a proxy for the TypeScript grammar they claimed to interpret | Delete the hand parser; one TypeScript-compiler AST pass owns all sources, exact string literals, direct calls, and object descriptors, with nineteen promise and ten descriptor cases (rung 2 using the language's parser) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Final green adversarial audit (findings 1–7) | 7 | no |
| Full clean-tree mutation audit (finding 8) | 1 | **yes** |
| Mandatory simplify pass over the hosted-gating repair (finding 9) | 1 | **yes** |
| Post-fix mechanism-boundary probe (finding 10) | 1 | **yes** |
| Custom-check list totality check (finding 11) | 1 | **yes** |
| Full clean-tree mutation audit (finding 12) | 1 | **yes** |
| Parallel repair review and mechanism-boundary probes (findings 13–15) | 3 | no |
| Executable clean-import fixture and exact mutation replays (findings 16–17) | 2 | **yes** |
| Final adversarial review of the attribution repair (findings 18–20) | 3 | no |
| Mandatory re-review of the parser repair (finding 21) | 1 | no |

Self-catch rate: **7 of 21, or 33.3%**. The immediately preceding final-remote
round recorded **0 of 43, or 0%**; the round before that recorded **10 of 51,
or 19.6%**. This is better than both, but review still found fourteen of the
twenty-one defects in a branch whose machinery had reported green. The red
commits written after findings 1–7, 13–15, and 18–21 are repair evidence, not
retroactive self-detection. Findings 8–12 and 16–17 count as ours because
required mutation, simplify, false-negative, clean-import, and exact replay
passes found them before review or push.

Every review-caught finding enters the PR trailer, including findings first
reported by local adversarial agents. Prior cumulative 129 + final remote 43 +
this audit's 14 review findings = **186 review findings**, so final PR #12
attestation must declare `review-findings: 186`. Findings 8–12 and 16–17 are
recorded here but do not increment that review count. Across the branch, the
auditable total is **210 findings: 24 self-caught + 186
review-caught**.

## Recurrence

Findings 1 and 7 recur after the single-representation and native-integer
lessons. The project already had a canonical `storedInteger` fragment and
corrupt-storage seams, but the fragment was opt-in at each CAS. The mechanism
therefore protected the operations that happened to compose it, not the
property that every CAS authoring an ordinal from stored state must prove the
source representation first. Finding 7 is the sharper recurrence because it
was introduced by the successor-ordinal repair in this same round.

Finding 2 repeats both the single-representation lesson and the law that every
new layer needs its own generated fault surface. Shared conformance had a list
of advertised surfaces and separate hand-written calls that ran those
surfaces. Both could be correct today while still permitting tomorrow's list
and execution to drift. The property is one executable enrollment door, not
agreement between two lists.

Finding 3 is another recurrence of the positive-fence proxy class. Prior rounds
closed `OR`, `NOT`, and parenthesized spellings, but `hasPositiveFence` still
asked whether qualifying text occurred in an accepted region. The property is
that the fence semantically dominates every affected row. This class has
recurred in every fence-parser round because text is a picture of that
property, not the property itself.

Findings 4 and 5 repeat the spelling-as-property class: a basename stood in for
the unique canonical file, and one predicate spelling stood in for the
operation of selecting the fake-clock row. Finding 6 repeats the vacuous-green
class: content checks were treated as meaningful without first requiring the
artifact to exist. The self-test had examples for earlier spellings and
present files, but no generated negative space requiring every claimed
condition to be attacked.

Finding 8 recurs at the mutation-attribution boundary paid for by earlier
rounds. The exact-verdict classifier itself worked: it refused to count a
failure whose file, test name, marker, or causal error did not match. The
proxy was the test's error-string regex, which named what the repair author
expected rather than the constraint the mutant reaches. This recurrence did
not escape the project's machinery; it is evidence that exact attribution is
only as sound as each expected marker. The full audit converted that bad
expectation into a hard failure before review or merge.

Findings 9–11 are the same spelling-as-property recurrence in one repair
sequence. Finding 9 was introduced by `dc10820`'s repair for final-remote
finding 43: a regex recognized unsupported fields only when they used an
unquoted identifier key. Finding 10 was introduced by finding 9's first repair:
it classified exact eight-space fields but left malformed indentation outside
the owned grammar. Finding 11 was also residual in the `dc10820` repair:
entry-level totality said nothing about content before the first entry.

The progression is the prevention lesson in miniature. “Reject this known
field spelling” was a proxy. The stronger property is that the complete
custom-check list has no unclassified significant line: the prelude is empty,
each entry has exactly the owned literal fields, and only the unique literal
instructions body may contain deeper text. The self-catches moved the
mechanism toward that property before another reviewer had to rediscover the
class.

Findings 12 and 17 recur after the promise/provenance attribution residuals
from earlier rounds. First, helper availability was mistaken for structural
enrollment: a test outside the original package still used Vitest's lossy
message channel. Then helper enrollment was mistaken for canonical evidence:
the caller could decorate the marker. Outcome classification and marker
construction now have one helper owner, while the live mutation—not source
spelling—remains the final causal proof.

Finding 13 repeats the duplicate-parser and spelling-as-property classes.
Finding 19 then recurred inside its repair: even the shared lexer did not own
generic, optional, and parenthesized call grammar. Finding 21 was the decisive
recurrence: optional generics, nested parentheses, relational syntax, private
methods, and constructors all escaped the hand parser added for finding 19.
That is evidence the mechanism was a proxy for TypeScript syntax. The final
repair deletes it and asks the TypeScript compiler AST.

Finding 14 repeats finding 8's error-shape proxy at a higher altitude: an
error class or nested outcome described what happened nearby, not the specific
replacement the mutant makes. Finding 15 repeats the single-representation
rule at matcher state: the same regular expression was not the same predicate
after `lastIndex` changed. Finding 16 repeats the self-defeating-gate class:
the checker altered the state whose cleanliness it was about to attest.

Finding 18 directly recurs after the lexer ambiguity previously repaired for
postfix `++`: another postfix operator preserved a completed expression while
the lexer changed it to “expects an expression.” The earlier mechanism covered
one spelling rather than the prefix/postfix property. Finding 20 is the
inventory-proxy recurrence: the right descriptor somewhere in the right file
stood in for the real helper call that produces the runtime verdict. Compiler
syntax closes method/constructor/comment impersonation; dead or shadowed bare
calls remain outside the cheap inventory and are bounded by the live audit.

## Mechanism audit — the false negative of each

The table now points to **executed post-fix probes**, not imagined examples.
Probes A–H ran at `d8d4a68`; the later commits through Probe I changed only
the review-bot checker and its fixtures. Probe I ran at `fc5d710`. Probes J–M
ran against the final attribution mechanism at `035c443`. Source snippets and
observed outcomes are included below.

| Mechanism | Rung | Executed false-negative boundary |
|-----------|------|-----------------------------------|
| `storedInteger` on the repaired ownership CASes; targeted suspend/sweep regressions | 1 for those transitions; 3 for the tests | Probe A constructed a third ordinal-authoring CAS without `storedInteger`; `FencedBatch` accepted it. The two named regression tests still passed. |
| Frozen executable conformance registry | 1 for inventory/dispatch identity; 2 for its mutation | Probe B replaced the poison runner body in memory with a no-op under the same registered name; TypeScript transpilation and the exact registry-binding comparison still passed. |
| `hasPositiveFence` plus `negatedSpans` | 2, syntactic | Probe C constructed the documented truth-preserving `CASE`; raw `followOn()` accepted it. |
| Canonical fragment-path check | 2, syntactic | Probe D put the cancellation column and comparison operator on separate lines in a noncanonical store file; `fragment-lint.py` accepted it. |
| Expanded fake-clock predicate matcher | 2, syntactic | Probe E selected the fake-clock row with `BETWEEN`; `clock-lint.py` accepted it. |
| Required nightly file and credential-shape checks | 2 | Probe F supplied an otherwise-valid workflow with only `workflow_dispatch`; `gate-lint.py` accepted it. |
| Exact mutation inventory | 2 for construction mutations; 3 for behavioral mutations | Probe G confirmed a closed inventory of 50 live mutations while Probe A's new unguarded ordinal shape remained outside it. Exactness does not imply completeness. |
| Exact successor-ownership error regex | 3, error-text proxy | Probe H threw the same unique-constraint text from an unrelated operation; the regex attributed it. It identifies an error spelling, not the statement that caused it. |
| Owned CodeRabbit custom-check list grammar | 2, syntactic | Probe I showed the checker can prove only the checked-in configuration shape: it reported clean while GitHub main protection had no required hosted-review status or review rule. Installation and enforcement remain external state. |
| Canonical promise helpers, exact schema predicates, and stateless regex matching | 1 for representation; 3 for causal tests | Probe J's temporary Vitest file passed while an unrelated branch threw the replacement-shaped error and earned the canonical marker; another unrelated error containing `expected` satisfied a broad expected-error regex. The helper owns transport and outcome shape, not causal origin. |
| TypeScript-compiler AST promise/helper inventory | 2 | Probe K showed an aliased `expect` produced no promise-message line, while a shadowed bare helper and a dead exact marker literal satisfied their inventories. Compiler syntax removes grammar guesses; binding identity, reachability, and causal test ownership remain runtime-audit properties. |
| Mutation runner with no repository-local Python parser/import | 1 for removing the self-dirty path; 2 for the fixture | Probe L observed that a preceding full `pnpm verify` can still create `scripts/__pycache__/source_lex...` through other Python checkers. The mutation runner's clean-tree guard refuses that external artifact; this mechanism claims only that the runner does not create it before checking. |
| Shared TypeScript lexer postfix-state repair and total batch harvest | 2, syntactic | Probe M invoked a raw write through `this.db['batch'](...)`; `batch-lint.py` still printed clean. The repaired `value! / this.db.batch(...)` spelling is visible, but computed property access remains outside the harvester. |

Executed probe excerpts and outcomes:

```text
Probe A
b.cas('win', 'runs',
  `UPDATE runs SET attempt = attempt + 1, ${FENCE_SET} WHERE run_id = ?`, ['r'])
=> unguarded-ordinal-cas: accepted

pnpm exec vitest run packages/conformance/test/libsql.test.ts \
  -t "sweep classification refuses a corrupt stored attempt|suspendRun rejects a non-integer stored attempt"
=> 1 file passed; 2 tests passed; 1,214 skipped
```

```text
Probe B
rename poisonMatrixConformance -> poisonMatrixConformanceBody;
insert function poisonMatrixConformance(_dialect, _makeFixture) {}
run TypeScript transpilation and enrollment.test.ts's exact binding extraction
=> {"transpileDiagnostics":0,"registryStillMatches":true}
```

```text
Probe C
DELETE FROM waits
WHERE CASE WHEN fence_stamp = ${b.fence('win')} THEN 1 ELSE 1 END = 1
=> case-fence-residual: accepted
```

The repository's `lint-selftest.run()` throwaway-tree harness executed Probes
D–F against the real checker sources:

```text
Probe D: cancel_at_ms
           <= ${NOW_MS}
=> rc=0; fragment-lint: eligibility predicates confined to fragments.ts

Probe E: SELECT value FROM meta
         WHERE key BETWEEN 'fake_now_ms' AND 'fake_now_ms'
=> rc=0; clock-lint: database time confined to NOW_MS (time.ts)

Probe F: on: workflow_dispatch
         permissions: { contents: read }
         checkout persist-credentials: false
=> rc=0; gate-lint: clean
```

```text
Probe G
python3 scripts/mutation-probe.py --self-test
=> mutation-probe self-test: 17 attribution cases, 50 live mutations

Probe H
expected = /UNIQUE constraint failed: runs\.task_id, runs\.attempt/
expected.test(String(new Error(
  'UNIQUE constraint failed: runs.task_id, runs.attempt'
)))
=> successor-attribution-boundary: unrelated same-text failure attributed=true

Probe I
python3 scripts/review-bot-lint.py
=> review-bot-lint: clean — 11 rules, each active in CodeRabbit and Greptile

gh api repos/ejc3/durablerun/branches/main/protection
=> {"checks":["verify","tla","adversarial-review"],"reviews":null}
```

```text
Probe J
pnpm exec vitest run packages/core/test/zz-attribution-boundary.test.ts
=> 1 file passed; 2 tests passed

unrelated replacement-shaped error
=> Error: mutation-verdict:behavior:boundary-probe

unrelated error text containing "expected"
=> requireExpectedFailure resolved
```

```text
Probe K
const check = expect
await check(action(), 'lossy').rejects.toThrow()
=> promiseMessageLines: []

shadowed requireExpectedFailure({kind:'behavior', mutation:'dead-path'}, ...)
=> helperVerdictDescriptors: [["behavior","dead-path"]]

if (false) throw new Error('mutation-verdict:behavior:dead-path')
=> directVerdictMarkers: ["mutation-verdict:behavior:dead-path"]
```

```text
Probe L
pnpm verify
=> scripts/__pycache__/source_lex.cpython-312.pyc created by another checker

python3 scripts/mutation-probe.py -k ...
=> refuses the externally dirtied tree before mutation
```

```text
Probe M
this.db['batch']('brand-new-write', statements)
python3 scripts/batch-lint.py tmp-repro
=> batch-lint: clean — every batch call site is classified and matches its declared shape
```

These executed examples delimit the claims; they are not assertions that the
remaining proxies are complete. The `CASE` residual is explicitly documented
beside `hasPositiveFence`; the hosted boundary demonstrates that a local
configuration proof is not an installation or branch-protection proof. The
other surviving shapes are recorded below.

## Fix-induced defects

**Fourteen of twenty-one findings were fix-induced: findings 7–17 and
19–21.**

Finding 7 was a production defect. The commit correctly stopped deriving a
successor attempt from an advisory pre-sweep scan and instead used the fenced
row's `f.attempt + 1`, but omitted the native-integer guard on the
claim-timeout ownership CAS. SQLite could therefore coerce corrupt text and
create a successor.

Finding 8 was an attribution defect. The same commit narrowed
`successor-ownership` to a `runs.run_id` error although that mutation reaches
the `(runs.task_id, runs.attempt)` constraint. The production repair was
re-reviewed as new code by the external green-diff audit, which found finding
7 and produced red commit `01ee66c`; the attribution repair was re-exercised
by the full mutation audit, which found finding 8 before review.

Findings 9 and 11 came from `dc10820`'s repair for final-remote finding 43.
That repair added the custom-check field allowlist, but recognized only one
field spelling and only content inside recognized entries. Finding 10 came
from finding 9's repair in `138120a`: exact eight-space fields became total
without first owning malformed indentation between fields and the literal
body.

Finding 12 came from the `a714ce4`/`eafd0d0` migration-postcondition repair
for final-remote finding 18: it reached the real zero-row version bump but
attached its mutation marker through Vitest's lossy promise-message adapter.
Findings 13–15 came from finding 12's first
`3a47f2c`/`2d1a481` repair: it added a second lexer and literal-marker proxy,
composed overly broad helper outcomes, and reused mutable regex state.

Finding 16 came from finding 13's `c1ceca2` repair importing the shared Python
lexer into a clean-tree runner. Finding 17 came from the same repair sequence:
the replacement helper centralized outcome transport but left marker
construction caller-spellable. Finding 18 was not fix-induced; its non-null
assertion ambiguity already existed in the shared lexer and was exposed by the
repair review.

Findings 19 and 20 came from the `c1ceca2` and `a0bfb80` attribution repairs:
the first shared parser still approximated TypeScript call grammar, and the
first descriptor inventory accepted same-named methods. Finding 21 came from
their `491b4d7` repair, whose expanded hand parser still approximated optional
generics, nested parentheses, relational syntax, private methods, and
constructors. `035c443` removes that repair layer rather than adding another
syntax exception.

Every repair was reviewed as new code, not merely re-tested: the green-diff
audit found finding 7, the live mutation found finding 8, the simplify pass
found finding 9, its executed false-negative probe found finding 10, and the
resulting list-totality check found finding 11. The final mutation, targeted
replays, and three repair reviews found findings 12–21. Findings 1–6 and 18
predated the repair that exposed them.

## Evidence

- Red tests for findings 1–6 landed in `c68ee97`. The targeted libSQL
  `suspendRun` probe failed one test with 1,214 skipped:
  `AssertionError: promise resolved "undefined" instead of rejecting`.
- The enrollment probe at `c68ee97` failed one of four tests with eight soft
  assertion failures. Its primary attributable diagnostic was
  `mutation-verdict:construction:shared-conformance-runner-registry`; the
  inventory and dispatch still omitted a registry, no generic runner
  invocation existed, and all four direct runner calls remained.
- The focused `FencedBatch` probe at `c68ee97` failed one test with 64 passed
  under `mutation-verdict:construction:positive-fence-is-not`.
- `PYTHONDONTWRITEBYTECODE=1 python3 scripts/lint-selftest.py` at `c68ee97`
  reported four accepted bad inputs: a nested same-name `fragments.ts`, the
  reversed equality `'fake_now_ms' = key`, `key IN ('fake_now_ms')`, and
  deletion of the long-running nightly workflow.
- Red test for finding 7 landed in `01ee66c`. Its targeted libSQL sweep probe
  failed one test with 1,215 skipped: it expected `[]` but received one
  `claim-timeout` result containing `runId`, `successorRunId`, and `taskId`,
  under `mutation-verdict:behavior:sweep-rejects-noninteger-attempt`.
- The green fix is `27e1ad8`. `pnpm verify` then passed all lint, formatting,
  type, and Vitest gates with **1,649 tests green**.
- The four new live mutations each reached its exact attributable verdict and
  ended with `every mutation was caught by its attributable verdict`:
  `positive-fence-is-not` (construction),
  `suspend-rejects-noninteger-attempt` (behavior),
  `shared-conformance-runner-registry` (construction), and
  `sweep-rejects-noninteger-attempt` (behavior).
- Finder for findings 1–7: an independent green-diff whole-system audit of
  exact `eafd0d0`, whose quoted verdict was **“seven confirmed blockers.”**
  All seven claims reproduced. No candidate claim was discarded in this
  scoped round; the targeted red probes above settled every claim presented.
- Finder for finding 8: the project's full mutation audit at `dc10820`
  reported `successor-ownership: WRONG-PATH failure`; it expected the named
  behavior marker through `UNIQUE constraint failed: runs.run_id` but observed
  `UNIQUE constraint failed: runs.task_id, runs.attempt`. The targeted red
  rerun after `dc10820` exited 1.
- Fix for finding 8: `d8d4a68` changed only the expected regex to the observed
  `(task_id, attempt)` ownership collision. The targeted rerun then printed
  `baseline green`, `ok successor-ownership:
  mutation-verdict:behavior:successor-ownership`, and
  `every mutation was caught by its attributable verdict`.
- Red commit `4e22e73` added finding 9's quoted-key and YAML-merge fixtures.
  Focused self-test and full `pnpm verify` both exited 1 with exactly two
  diagnostics: `ACCEPTED a bad input — a quoted unsupported field cannot fall
  outside the custom-check allowlist` and `ACCEPTED a bad input — a YAML merge
  cannot inject custom-check fields outside the owned literal shape`.
  Green commit `138120a` made every significant eight-space entry line either
  a literal `mode`/`instructions` field or an error. The focused self-test
  reported **107 bad inputs rejected and 18 good inputs accepted**; full
  verify passed **69 files / 1,649 tests**.
- Red commit `8915e8c` added finding 10's nine-space field fixture. Focused
  self-test and full verify exited 1 with exactly `ACCEPTED a bad input — an
  invalid nine-space field cannot sit between the owned field and body
  shapes`. Green commit `a2422a8` made body membership precede indentation
  acceptance. The focused self-test reported **108 bad inputs rejected and 18
  good inputs accepted**; full verify passed **69 files / 1,649 tests**.
- A tab-indented candidate did **not** reproduce and is not a finding: the old
  parser already rejected it because it truncated the literal instructions
  block and reported no valid body.
- Red commit `e54b2ae` added finding 11's invalid mapping between
  `custom_checks:` and the first entry. Focused self-test and full verify
  exited 1 with exactly `ACCEPTED a bad input — invalid mapping content cannot
  hide in the custom-check list prelude`. Green commit `fc5d710` rejected every
  significant pre-entry line. The focused self-test reported **109 bad inputs
  rejected and 18 good inputs accepted**; full verify passed **69 files /
  1,649 tests**.
- Finder for finding 12: the full clean-tree audit at exact head `c11d162`
  had a green baseline and **49 attributable mutations**. Its sole failure was
  `migration-postcondition-old-version: WRONG-PATH`: the exact named test
  reported `Error: promise resolved "undefined" instead of rejecting` without
  the source marker. The audit exited 1.
- Red `3a47f2c` made direct Vitest promise-message verdicts a build failure;
  green `2d1a481` moved all inverse outcome transport to
  `@durablerun/core/testing`. The targeted migration mutation then printed
  `baseline green`, its exact `ok` verdict, and `every mutation was caught by
  its attributable verdict`.
- Red `2c0318e` pinned findings 13–15: four source counterexamples failed the
  promise checker, the replacement helper was absent, a global regex changed
  its second result, and an unrelated schema mismatch was accepted. Green
  `c1ceca2` made the focused mutation/lint self-tests and **19 helper/schema
  tests** green.
- Review artifact for findings 13–15: the local repair review at `2d1a481`
  (2026-07-26 11:45 UTC) reported that
  “`_code_mask` duplicates the canonical TypeScript lexer,” that “the nested
  schema-fault helpers also attribute unexpected resolution,” and that the new
  regular-expression path lacked a repeated-match proof. The root fix review
  then recorded the executable result: “reusable global regex matchers were
  stateful.” Red `2c0318e` followed those reports.
- Red `c4e2a83` observed `created forbidden artifact: scripts/__pycache__`;
  green `1940b48` made the executable clean-import fixture pass. The later
  compiler repair `035c443` removes the local Python import entirely.
- Red `4fd2876` failed the canonical-marker helper test with received
  `"[object Object]"`. Green `a0bfb80` passed **68 files / 1,652 tests**.
  Exact clean-tree replays of both `schema-fault-is-permanent` and
  `migration-postcondition-old-version` printed green baselines, exact `ok`
  verdicts, and complete attribution.
- Red `5692690` produced finding 18's accepted bad batch plus four
  promise-syntax mismatches and one same-named-method descriptor mismatch.
  Green `491b4d7` passed **68 files / 1,652 tests**, **110** bad lint inputs,
  fifteen promise cases, and eight descriptor cases.
- Review artifact for findings 18–20: the read-only attribution review at
  `a0bfb80` reported “High:
  `source_lex.py` misclassifies division after a TypeScript non-null assertion
  as a regex,” “High/medium: promise-message checking is syntactic and
  unsound,” and “Medium: verdict descriptor inventory is file-level and
  spelling-based.” Red `5692690` followed that verdict.
- Review artifact for finding 21: the same reviewer re-ran against `491b4d7`
  and returned “Not safe for final audit yet,” listing optional generics,
  nested transparent parentheses, relational expressions, private methods,
  and constructors. Red `597dcd1` then printed six self-test mismatches. Four
  fixtures were valid as committed: an optional-generic custom message and a
  nested-parenthesized custom message were missed, an optional-generic
  no-message call was falsely flagged, and
  `new requireExpectedFailure(...)` was accepted as the helper. Compiler
  validation disconfirmed two initial fixture formulations: the
  unparenthesized relational source is one generic-looking AST argument, and
  the top-level private-name source is semantically invalid (`TS18016`).
  Green validation corrected them to a parenthesized first relational
  argument and a private method inside its declaring class; both corrected
  sources still fail buggy `491b4d7`, then pass `035c443`.
- Green `035c443` deleted the hand parser and added one compiler-AST analyzer.
  `pnpm verify` passed **68 files / 1,652 tests**; the analyzer self-test passed
  **17 classifier, 19 promise-message, 10 descriptor, and 50 live-mutation
  cases**. The final read-only repair review reported **no code blockers**.

## Root cause

The common failure was scope substitution. Existing machinery proved that
known operations contained known tokens, that known predicate spellings were
rejected, that a present file had safe contents, and that two independently
maintained conformance lists currently agreed. Those are useful local facts,
but each was narrower than the property its green result was taken to mean.
Equivalent SQL syntax, an absent artifact, a new ordinal consumer, or drift
between representations sat outside the declared surface.

The second failure was that repair code inherited trust from the defect it
fixed. Moving successor ordinal derivation onto the fenced source was correct,
but it created a new arithmetic boundary and therefore required a fresh
corrupt-representation audit. Narrowing an attribution regex looked like
making a test more exact, but it changed the evidence contract and therefore
required the mutation itself to be rerun. The external green-diff audit caught
the production boundary; the full mutation audit caught the evidence boundary.

The third failure was partial grammar ownership. The hosted-review repair
asked whether known field spellings were legal, then whether known entry lines
were legal, while leaving alternative spellings, malformed indentation, and
the list prelude unclassified. Each green result described a region the parser
recognized, not the complete configuration surface. The simplify,
false-negative, and totality passes found the successive complements; the
final shape assigns every significant custom-check-list line to the prelude,
an owned field, or the one literal body.

The fourth failure was rebuilding authorities the project already had.
Vitest, JavaScript regular expressions, and TypeScript each define precise
runtime or grammar behavior, but the first repairs substituted custom-message
intuition, mutable matcher reuse, and hand-written lexers. The successive
F13/F19/F21 recurrence ended only when marker transport moved into one helper
and TypeScript source interpretation moved to the TypeScript compiler.

## Mechanisms

Built in this PR:

- DESIGN now requires any CAS whose follow-ons copy or derive a stored attempt
  to require its native integer representation before the CAS can win.
  `suspendRun` and claim-timeout sweep compose that guard, and shared
  conformance pins atomic refusal (rung 1 locally, rung 3 behaviorally).
- `STORE_CONFORMANCE_SURFACES` is the single frozen definition from which both
  public IDs and umbrella execution derive; dialects receive only the umbrella
  enrollment door (rung 1), with an exact construction mutation (rung 2).
- `FencedBatch` treats the right-hand side of `IS NOT` as negated, while its
  regression and mutation state the accepted boundary precisely (rung 2,
  syntactic).
- Fragment exemption is tied to the exact canonical package path, clock
  matching covers both equality directions and positive `IN`, and missing
  nightly configuration fails closed. Each checker has a hostile self-test
  fixture (rung 2).
- Four exact mutation entries connect each production repair to the
  construction or behavioral verdict that must kill its removal (rungs 2 and
  3).
- `successor-ownership` now names the exact `(task_id, attempt)` collision its
  mutant reaches, and the targeted live mutation proves that attribution
  (rung 3). It is intentionally described as an error-text proxy, not causal
  proof.
- The CodeRabbit custom-check parser now rejects every significant pre-entry
  line, permits only literal `mode` and `instructions` fields at exact owned
  indentation, and treats deeper lines as content only after locating the one
  literal instructions body. Quoted keys, YAML merges, malformed indentation,
  and prelude mappings are hostile self-test fixtures (rung 2, syntactic).
- `@durablerun/core/testing` owns all three promise-verdict outcome shapes,
  clones regular expressions before matching, validates structured mutation
  descriptors, and alone constructs canonical markers. Direct tests pin
  expected, replacement, unrelated, success, and reusable-regex arms (rung 1,
  with rung-3 live mutations).
- `typescript-verdict-analyzer.cjs` parses every relevant TypeScript source
  once with the installed compiler, identifies direct promise `expect` calls,
  exact marker literals, bare helper calls, and object descriptors, and
  returns a shape-validated exact file inventory to the Python classifier.
  Nineteen promise and ten descriptor counterexamples prevent regression
  (rung 2 using the language parser rather than a second grammar).
- The lightweight source lexer preserves lone `!` expression state and treats
  `!=`/`!==` separately, so a non-null assertion cannot turn following
  division into a regex and hide a batch. The hostile batch fixture is part of
  every lint self-test run (rung 2, syntactic).
- The mutation runner no longer imports the repository-local Python lexer
  before its clean-tree precondition. Its throwaway fixture rejects any
  analyzer artifact, and the live runner still refuses any pre-existing dirty
  tree (rungs 1 and 2).

Deferred (recorded in `BUILD.md`):

- PR3.9 replaces raw SQL scanning with a compiled tree so fence position and
  boolean dominance become structurally answerable. That is the owned
  replacement for the documented `CASE` false negative; expanding the regex
  again would repeat the failed proxy.

## What this round still would not catch

A new transition can consume or increment a stored attempt without composing
`storedInteger`, because ordinal consumers are not yet generated from a closed
typed operation contract. A registered conformance runner can be left empty
while its ID and call remain correctly enrolled. Raw `followOn()` SQL can hide
a fence inside a truth-preserving `CASE` until PR3.9 replaces text scanning
with a tree.

The lints also retain explicit syntactic boundaries: a multiline eligibility
comparison, a semantically exact fake-clock predicate other than equality or
positive `IN`, and a safe-looking but never-scheduled nightly workflow would
ship today. Bracket or aliased access such as `this.db['batch'](...)` remains
outside total batch harvest. The exact mutation inventory cannot attack a
future spelling or operation until that surface is added. The
`successor-ownership` matcher can also attribute an unrelated failure that
emits the same SQLite constraint text; it is exact over the observed string,
not causally bound to the mutated statement.

The compiler AST proves syntax, not binding or reachability: an aliased
`expect`, a shadowed bare helper, or an exact marker in dead code remains
outside the cheap inventory. The runtime mutation audit is the causal
authority for those cases. Type assertions can bypass the descriptor's
compile-time `kind` union, and broad error predicates can still accept an
unrelated same-shaped error. Other Python checkers may create ignored or
untracked bytecode before an audit; the clean-tree guard refuses that state
rather than attesting it.

Finally, `review-bot-lint.py` proves the checked-in hosted-review
configuration shape, not that either app is installed or that GitHub branch
protection requires its output; Probe I exhibits that external-state boundary.
Those residuals are why this round closes fourteen review-caught blockers and
seven self-caught machinery defects without claiming that the underlying
proxy classes are exhausted.
