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

**This document is adversarial toward the machinery and blameless toward
people.** The question throughout is what would have made each defect
unwritable or machine-caught before an outside reviewer inspected the green
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

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Final green adversarial audit (findings 1–7) | 7 | no |
| Full clean-tree mutation audit (finding 8) | 1 | **yes** |
| Mandatory simplify pass over the hosted-gating repair (finding 9) | 1 | **yes** |
| Post-fix mechanism-boundary probe (finding 10) | 1 | **yes** |
| Custom-check list totality check (finding 11) | 1 | **yes** |

Self-catch rate: **4 of 11, or 36.4%**. The immediately preceding final-remote
round recorded **0 of 43, or 0%**; the round before that recorded **10 of 51,
or 19.6%**. This is better than both, but outside review still found seven of
the eleven defects in a branch whose machinery had reported green. The red
commits written after findings 1–7 are repair evidence, not retroactive
self-detection. Findings 8–11 count as ours because the required mutation,
simplify, false-negative, and totality passes found them before outside review.

Only outside-review findings enter the PR trailer. Prior cumulative 129 +
final remote 43 + this audit's 7 external findings = **179 review findings**,
so final PR #12 attestation must declare `review-findings: 179`. Findings
8–11 are recorded here but do not increment that review count. Across the
branch, the auditable total is **200 findings: 21 self-caught + 179
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

## Mechanism audit — the false negative of each

The table now points to **executed post-fix probes**, not imagined examples.
Probes A–H ran at `d8d4a68`; the later commits changed only the review-bot
checker and its fixtures. Probe I ran at final mechanism head `fc5d710`.
Source snippets and observed outcomes are included below.

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

These executed examples delimit the claims; they are not assertions that the
remaining proxies are complete. The `CASE` residual is explicitly documented
beside `hasPositiveFence`; the hosted boundary demonstrates that a local
configuration proof is not an installation or branch-protection proof. The
other surviving shapes are recorded below.

## Fix-induced defects

**Five of eleven findings were fix-induced: findings 7–11.**

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
by the full mutation audit, which found finding 8 before outside review.

Findings 9 and 11 came from `dc10820`'s repair for final-remote finding 43.
That repair added the custom-check field allowlist, but recognized only one
field spelling and only content inside recognized entries. Finding 10 came
from finding 9's repair in `138120a`: exact eight-space fields became total
without first owning malformed indentation between fields and the literal
body.

Every repair was reviewed as new code, not merely re-tested: the green-diff
audit found finding 7, the live mutation found finding 8, the simplify pass
found finding 9, its executed false-negative probe found finding 10, and the
resulting list-totality check found finding 11. The other six findings
predated these repairs.

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
ship today. Finally, the four new mutations cannot attack a future spelling or
operation until that surface is added to the inventory. The
`successor-ownership` matcher can also attribute an unrelated failure that
emits the same SQLite constraint text; it is exact over the observed string,
not causally bound to the mutated statement. Finally,
`review-bot-lint.py` proves the checked-in hosted-review configuration shape,
not that either app is installed or that GitHub branch protection requires
its output; Probe I exhibits that external-state boundary. Those residuals are
why this round closes seven externally demonstrated blockers and four
self-caught machinery defects without claiming that the underlying proxy
classes are exhausted.
