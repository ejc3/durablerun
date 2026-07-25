# Checks must be able to fail

Scope: every checker and audit tool under `scripts/**`; every test, fixture, generated
surface and query-plan pin under `packages/*/test/**/*.ts`; the checking layer that ships
as library code (`packages/conformance/src/invariants.ts`, `fault-matrix.ts`, `fuzz.ts`);
and the construction checks in `packages/core/src/fenced-batch.ts`. This rule judges one
property: can the check REJECT anything. Whether a guard or fence is semantically right
belongs to the fence-provenance rule; whether a checker is wired into `pnpm verify` at all
is `scripts/gate-lint.py`'s job and the gate-composition rule's. **Out of scope: code that
CALLS an existing checker.** `expect(await engineInvariantViolations(f.raw)).toEqual([])`
appears about twenty-five times across `packages/driver/test/tick.test.ts`,
`packages/driver/test/e2e.test.ts`, `packages/conformance/test/legacy-rows.test.ts` and
`clock-jitter.test.ts` — those are behaviour tests using the library, not new checks, and
none of them is a finding.

Green proves a test ACCEPTS correct code. It says nothing about whether it REJECTS
incorrect code, and this repo has the receipts. Two lints shipped broken in the very PR that
introduced them: `batch-lint` harvested only single-quoted literal labels, so a hand-rolled
multi-statement write carrying two raw clock reads passed batch-lint, the spec ledger and
the label inventory *simultaneously*; `clock-lint` was case-sensitive while SQL is not, so
`UNIXEPOCH()` and `now()` both sailed through, and `now()` is the canonical Postgres
spelling (postmortems/pr3.6-fence-provenance.md, findings 9 and 10). Finding 13 states the
root: *no lint in the repo had a test proving it can fail.* The bug in each was in what the
pattern did NOT match, which is exactly what reading source is worst at. It is not only
linters. The `wait-for-fired-event` invariant named the lost-wakeup state precisely and
*could not fire*, because the only state it described was erased by the same batch that
produced it (41). The emit's query-plan pin EXPLAINed a hand-copied statement introduced as
"structurally the same", so deleting the entire index driver from the shipped SQL left the
plan suite green while every emit scanned the largest table in the engine (42). The
generated wake surface varied only the wait rows and parked every run on the event being
emitted, so deleting `AND wake_event = ?` kept it green (43). The detection ledger for that
round is the headline: 236 fault-matrix cells, 32 fuzz shards, a 111.8M-state TLC model, an
invariant library and eight linters found **0 of 44** defects.

Report a failure when the changed code introduces or materially expands any of these:

- **A new checker with a rejection case per checker instead of per RULE and per
  ALTERNATIVE.** A file added under `scripts/` that greps, parses or grades; a construction
  check in `packages/core/src/fenced-batch.ts`; a checker in
  `packages/conformance/src/invariants.ts`; an oracle in a `*.test.ts`. One bad fixture is
  not the bar — `clock-lint` would have passed a one-case-per-checker demand with a single
  lowercase `unixepoch('subsec')` while `NOW()` and `now()` sailed past. The bar is a
  rejected input for each rule the checker claims and each branch of each alternation it
  matches on. Artefacts: a `BAD_CASES` entry in `scripts/lint-selftest.py` (its own
  docstring says "at least one bad fixture per rule it claims to enforce"); a constructed
  corruption in `packages/conformance/test/invariant-checkers.test.ts`; an
  `expect(() => …).toThrow(…)` beside the nearest legitimate shape in
  `packages/core/test/fenced-batch.test.ts`.
- **A harvest with no accounting for what it did not match.** Finding 9's shape has no
  branch to inspect: `set(re.findall(…))` enumerates exactly what the pattern describes and
  is silent about everything else. The decidable test is to WRITE an input that lives inside
  the scanned tree and produces neither a record nor a violation — a computed label, a file
  one directory deeper than the glob, a call the regex does not span. Total harvest is the
  rule: every site resolves or is declared (`DYNAMIC` in `scripts/batch-lint.py`, `DYNAMIC`
  in `scripts/spec-ledger.py`). Same bullet for a check that FAILS OPEN: finding 18 handed
  placeholder lines beginning with `-` to `grep` without `-e`, `grep` exited 2, and the
  script read that as "placeholder absent" — any subprocess whose nonzero exit is not
  distinguished from "found nothing" is this.
- **A pattern widened or tightened with no case for the newly covered input.** A spelling, a
  casing, a bind form, an extra directory level, a new glob on an existing checker, with no
  fixture the OLD pattern accepted. The blind-counter check "matched only `x = x + <digit>`"
  because it was written from one example, while `x = x + ?`, `x = t.x + 1`, `x = (x + 1)`
  and `x = 1 + x` all double-spent the retry budget (24). The standard is now in the repo:
  `'catches the counter bump however it is spelled'` in
  `packages/core/test/fenced-batch.test.ts` tables six spellings, and the sibling
  `'does not mistake a derived value for a counter bump'` tables four near misses.
- **A probe mutation that changes what a statement BINDS or how it types, rather than what
  it does.** In `scripts/mutation-probe.py`, a `replace` the compiler or the argument-count
  check rejects: the probe prints `ok … caught` and the guard was never exercised.
  `emit-wake-step-correlation` is `1 = 1` for exactly this reason. Count binds AFTER
  interpolation, not `?` characters in the patch text — `successor-ownership` reads 2 -> 1
  by character count and is correct (see Allowed). Also flag a diff that edits the exact
  text an existing `find` string matches without updating that entry: the probe then reports
  `stale pattern` and the guard has quietly stopped being probed. Deleting guards is how
  three unmaintained ones were found, including the follow-on half of the provenance check
  (27) and spawn's primary-key guard (28).
- **An assertion that cannot discriminate.** A newly added check whose only test asserts the
  accept direction. A rejection discarded by `.catch(() => {})` or `try {} catch {}` around
  the call under test where *every* post-call assertion still holds when the call throws —
  name the assertion; finding 28's collision test asserted `COUNT(*) = 0` runs, which is
  equally true when spawn crashes, so deleting the guard broke nothing. An un-awaited
  `expect(…).rejects`. A guard split into two independent conditions covered by one test
  that either half alone satisfies (33). And an invariant that is true by construction:
  report this only when the diff contains BOTH the checker and the statement that erases the
  rows it selects, and name that statement — finding 41's emit deleted every registration
  naming the event, including the ones it declined to wake.
- **An oracle retyped rather than recovered from the shipped path.** SQL, a label set, a
  query plan, a schema or a statement list copied into a test and described as "the same as"
  or "structurally the same" as what ships. Recover it instead: a recording executor
  (`shippedWakeStatement` in `packages/store-libsql/test/query-plans.test.ts`), an exported
  constant (`NEXT_WAKE_SQL`), or the one harvester the other checkers already share
  (`scripts/spec-ledger.py --labels`, consumed by
  `packages/conformance/test/label-inventory.test.ts`). A second representation can only
  drift, and finding 42 is what that costs.
- **A generated surface that holds constant a field the code under test compares against a
  generated one.** A new fault-matrix axis, fuzz op or enumerated surface where one side of
  a correlation is fixed — finding 43's shape, and finding 1's, where the matrix varied the
  fault and the label but never the PRE-STATE, so the infra-retry cap where the worst defect
  lived was never visited. Name the field and the comparison.
- **A new way to turn a check off.** An env var, flag or default that can drive coverage to
  zero without refusing: `if (process.env.SKIP_*) return`, a seed or step count that may be
  `0`, an allow-list whose empty value makes every rule vacuous. The standard already exists:
  `knob()` in `packages/conformance/test/fuzz-shard-runner.ts` throws `"is not a positive
  integer — refusing a vacuous fuzz run"`, and `gate-lint.py` rule 4 fails when `pnpm verify`
  reaches fewer than two scripts, "the floor that makes them mean something".

Allowed cases (do NOT flag these):

- **`GOOD_CASES` in `scripts/lint-selftest.py`.** Entries whose whole assertion is
  `returncode == 0`, e.g. `("clock-lint.py", store("const SQL = \`UPDATE runs SET x = 1
  WHERE id = 'expire-lease-now'\`\n"), "an identifier ending in 'now' is not a clock call")`.
  Every one is a false positive a checker actually produced. A tightened pattern SHOULD
  arrive with a new good case beside its new bad case.
- **The accept half of a stated pair.** `'stays silent on the consistent seed world'` in
  `packages/conformance/test/invariant-checkers.test.ts`, after seven constructed
  corruptions each asserted to fire. Flag accept-only for a check with no reject case; never
  the accept half.
- **A differential oracle over a generated surface.** The only assertions in
  `packages/conformance/test/wake-witness-surface.test.ts` are
  `expect(await disagreements(cases)).toEqual([])`, twice. It discriminates: `shouldWake` is
  written one row at a time, all properties at once — the shape the SQL is not — and every
  park is crossed with every subset of corruptions.
- **The counter-example kept beside a pin.** `'degrades to a full scan if the waiter
  subquery is correlated'` in `packages/store-libsql/test/query-plans.test.ts` hand-writes a
  deliberately wrong statement and asserts `SCAN runs`, so the sibling pin is *known* to
  discriminate. Flag a copy that stands IN FOR the shipped statement, never a
  counter-example kept next to one recovered from it.
- **A fault-injection workload that swallows every call.** `go()` in
  `packages/conformance/src/fault-matrix.ts` is `try { return await op() } catch { return
  null }` on all twenty-odd store calls, and line 332 is `.complete(…).catch(() => {})`.
  Correct: crash injection rejects calls by design, and the oracle is what runs afterwards —
  invariants clean, the claim bound, and a probe task driven to completion.
- **Arrange-phase catches and preconditions.** `.catch(() => {})` on setup calls in
  `packages/sdk/test/review-regressions.test.ts` (lines 96, 102) and on calls whose
  post-assertion FAILS in the throw direction — `packages/conformance/test/regressions.test.ts`
  line 160 asserts the task is still `'cancelled'`, which a deleted terminal guard would
  break. `expect(run).toBeDefined()` at `packages/sdk/test/user-boundary.test.ts:70` is a
  precondition on `claim`, followed by the discriminating assertions.
- **A catch that records and is asserted.** `packages/conformance/test/fuzz-shard-runner.ts`
  pushes into `failures` and asserts `expect(failures).toEqual([])`;
  `fence-provenance-regressions.test.ts` uses `.catch(e => { rejection = e })` then
  `expect(rejection).toBeNull()`; `expectLeaseLoss` in `packages/conformance/src/fuzz.ts`
  rethrows anything that is not `LeaseLostError`. Flag a catch that discards or narrows.
- **`successor-ownership` in `scripts/mutation-probe.py`.** Its `find` contains two `?`
  characters and its `replace` one, so a character count reads as an arity change. It is not:
  `fenced('runs', BY_RUN, …)` interpolates `BY_RUN = \`f.run_id = ?\``, and the trailing
  `AND ? IS NOT NULL` pads to the same two binds. Count binds after interpolation.
- **A non-matching branch that fails closed.** `scripts/batch-lint.py`'s `else:` appends a
  violation and then `continue`s — that IS the total-harvest fix, not the hole. So is
  `next((ln … ), "")` in `scripts/spec-ledger.py`: an empty line carries zero tags, so the
  label lands in `untagged` and the script exits 1.
- **Reasoned exemptions in the sanctioned lists.** `NOT_IN_GATE` in `scripts/gate-lint.py`
  (`"mutation-probe.py": "edits sources and runs the suite once per mutation; a deliberate
  audit, not a gate"`), `EXEMPT` in `scripts/lint-selftest.py`, `MULTI_CLOCK` /
  `TOKEN_FENCED` / `DYNAMIC` in `scripts/batch-lint.py`, `MATRIX_EXEMPT_LABELS` in
  `packages/conformance/src/fault-matrix.ts`. Each is the declared, checked way to keep
  something out, and `gate-lint` rule 2 fails on a stale or self-contradicting entry. Flag an
  exemption with no written reason, or one added in the same diff as the code it exempts.
- **A conditional skip whose both branches are fixtured.** `declarations_apply = any(n in
  on_disk for n in NOT_IN_GATE)` in `scripts/gate-lint.py` switches the staleness rule off in
  a tree those names do not describe; the comment states which two situations it
  distinguishes and the `gate(...)` fixtures pin both sides. Flag a conditional skip with
  nothing pinning both directions.
- **The deliberately weak half of a two-part floor.** `if (steps >= 50 && progress === 0)` in
  `packages/conformance/src/fuzz.ts` is nearly vacuous alone; its strong half is the per-op
  aggregate floor in `fuzz-shard-runner.ts`, and the comment says why per-walk floors would
  be flaky. Flag a floor with no strong half.

When reporting, do three things. **Write out the concrete input the check must reject and
does not** — the exact SQL, spelling, corrupt row or mutated line, not a description of one.
If you cannot write it, you have not established the finding, and that requirement is what
keeps every bullet above decidable from the diff. **Name the mechanism that structurally
should have demanded it and its rung**: a `BAD_CASES` entry in `scripts/lint-selftest.py`
(rung 2), a corruption case in `invariant-checkers.test.ts` (rung 3), a `MUTATIONS` entry in
`scripts/mutation-probe.py` (rung 3), the missing axis in a generator (rung 2), the recording
executor that recovers the shipped statement (rung 2) — and say whether it exists and was
skipped, or does not exist and must be built. **Do not accept "review more carefully" as the
outcome.** This comment is a detection net of last resort; the finding is closed when a
machine demands the rejection case, and if the class cannot be expressed as an input some
checker must refuse, say so plainly — a missing seam is the more valuable finding, and
building the seam comes before the fix.
