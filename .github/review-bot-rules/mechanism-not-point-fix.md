# Mechanism, not point fix — every correctness fix lands at a rung of the prevention ladder

Scope: any diff over `packages/*/src/**`, `packages/*/test/**`, `scripts/**`, `specs/**`,
`postmortems/**`, `BUILD.md`, `CLAUDE.md`, `DESIGN.md`, and `.claude/skills/pr-gate/SKILL.md`
that removes a defect, or that adds a checker, invariant, generated surface, lint, or
postmortem. This rule never judges whether the fix is *correct* — whether a follow-on keys on
the post-state, whether the fence reaches the rows, whether two statements read the clock,
whether the SQL is dialect-safe. Those belong to the sibling rules on DESIGN.md §3.4 rules 1/8
and on time-and-identity; duplication belongs to the simplify rule; modelling a new protocol
area before writing its SQL belongs to the spec-first rule. This rule fires only on the SHAPE
OF THE PREVENTION that accompanies a fix, and on whether the claim made about it is honest.

CLAUDE.md's ladder: (1) unwritable — types, structure, single definitions; (2) machine-caught
at build — lints, generated enumeration, TLC; (3) machine-caught at runtime/test — invariants,
fault matrix, fuzz floors. "Humans inspect more carefully" is not a rung.

Two incidents fix why this is the project's central rule. **Prose:** CLAUDE.md already said
hand-rolled batches were how the losing-sweeper race shipped, and `FencedBatch` was built as
the cure; five operations never moved onto it and "nothing failed the build to force it". Six
adversarial rounds later produced eleven correctness bugs, one of which hand-wrote its own
`parkStamp` — a verbatim reimplementation of the primitive nobody reached for
(`postmortems/pr11-store-batch-classes.md`). What ended the class was `scripts/batch-lint.py`,
a build failure. **Proxies:** the commit that introduced `FencedBatch` (`7997cda`) enforced the
rule with `if (!sql.includes(STAMP))` while its docstring said "'loser executes a follow-on'
becomes inexpressible" and it shipped with no test of its own. A statement that merely READ the
stamp satisfied it. That class — a statement acting on rows it cannot justify — then recurred
in every subsequent round, fourteen of PR3.6's forty-four findings, the last inside the
generator built to make it unwritable. Worst user-visible instance: a task reported permanently
failed while a run for it is still queued and will execute. Detection ledger for that round: of
44 findings, the fault matrix, 32 fuzz shards, a 111.8M-state TLC model, the invariant library
and every lint found **zero** (`postmortems/pr3.6-fence-provenance.md`). A probabilistic
reviewer is the last net, never the mechanism; a finding under this rule must terminate in
something a machine runs.

<!-- review-bot-synopsis:start -->
Flag a correctness fix that defends only the instance with no mechanism at any rung (no type/structure change, no lint, no generated case or axis, no invariant, no class-altitude test file, no TLA guard, and no BUILD.md sub-bullet under a live entry naming the missing one), a prevention that is only prose (a comment asserting two sites agree with nothing enforcing it, a comment naming a mechanism that resolves to nothing in the tree, a CLAUDE.md or pr-gate line as the diff's sole response to a defect), a text-deciding check whose same diff claims the runtime property ("unwritable", "inexpressible", "by construction", "rung 1") without exhibiting a false negative, a new guard/invariant/surface with no attack at all (no MUTATIONS entry, rejection test, BAD_CASES entry, constructed corruption, or differential control) including a mutation that changes bind arity or a surface varying only one side of a correlation, a positive plan pin over SQL hand-copied from src, or an added postmortem whose Mechanism-audit table skips a mechanism the diff adds. Pass for text bans whose subject is the text (clock-lint, determinism-lint, fragment-lint, batch-lint, the executor's error-string classifier), checks that state their own residual and where it is closed (hasPositiveFence, gate-lint, review-bot-lint), guards attacked by rejection tests rather than probe mutations, full observable-state differentials whose invariant-clean mutation changes a trace or protocol table (clock-jitter), deliberate counter-example or differently-shaped second representations (query-plans' degraded shape, the wake-witness oracle), pr-gate case-law prose, deferrals under live BUILD.md entries with reasons, mechanisms measured unsound and rejected with the measurement, extensions of an existing class layer, refuted claims kept as guard tests, and diffs with no defect behind them or defects the author's own machinery caught.
<!-- review-bot-synopsis:end -->

Report a failure when the changed code introduces or materially expands any of these:

- **A defect is removed and only the instance is defended.** The diff narrows a guard,
  predicate, validator, WHERE clause, bound, or ordering in `packages/*/src/**` in response to a
  bug — identified by an added regression test, a RED/GREEN commit pair, a postmortem row, or a
  comment describing the failure — and adds *none* of: a type or structural change that makes
  the shape unspellable (single definition, opaque type, generated construction); a new or
  widened checker under `scripts/`; a new enumerated case, axis, or op in a generated surface
  (`packages/conformance/src/fault-matrix.ts`, `packages/conformance/src/fuzz.ts`,
  `packages/conformance/test/wake-witness-surface.test.ts`,
  `packages/sdk/test/replay-equivalence.test.ts`); a checker in
  `packages/conformance/src/invariants.ts`; a test file or axis covering the class of worlds the
  bug needed rather than the one that produced it (the shape of
  `packages/conformance/test/replay-after-the-world-moved.test.ts` and `legacy-rows.test.ts`); a
  TLA action or guard in `specs/`; or a BUILD.md sub-bullet under a live (non-DONE) PR entry
  naming the missing mechanism and why it is deferred.
- **The only new prevention is prose aimed at a person.** Three decidable forms: a source
  comment asserting that two sites agree ("both successor sites share this shape", "keep these
  in sync") where the diff adds no shared definition, no construction that derives one from the
  other, and no test that fails when they drift — precedent, finding 31: `reschedule` and
  `suspendRun` drifted while "the comment asserted they were the same, which reads as a check
  and is not one"; a comment or doc citing a mechanism BY NAME that resolves to nothing in the
  tree; or a CLAUDE.md / `pr-gate` line added as the diff's only response to a defect the same
  diff fixes.
- **A syntactic check carrying a semantic claim.** The diff adds or widens a check that decides
  by inspecting TEXT — `sql.includes(...)`, a regex over SQL or source, a filename or naming
  convention, a marker string — while the same diff asserts the runtime property in an error
  message, docstring, DESIGN.md/CLAUDE.md wording, commit message, or a postmortem rung column:
  "unwritable", "inexpressible", "by construction", "rung 1", "so a losing invocation matches
  nothing". The obligation is the one `postmortems/pr3.6-fence-provenance.md` institutes:
  **exhibit the false negative** — code that still has the bug and still passes, written and
  run, not imagined. Also here: a set derived from a proxy rather than from the thing itself
  (`scripts/gate-lint.py` exists because the self-test found its subjects by filename — "A
  naming convention is not structure"), unless the diff also lands the check that closes it.
- **A new mechanism lands with nothing attacking it.** A new guard, invariant, checker, or
  generated surface where the diff adds none of: a `MUTATIONS` entry in
  `scripts/mutation-probe.py`; a rejection test pairing a refused shape with the nearest shape
  that must still be accepted (the `packages/core/test/fenced-batch.test.ts` form); a
  `BAD_CASES` entry in `scripts/lint-selftest.py`; a constructed corrupt state
  (`packages/conformance/test/invariant-checkers.test.ts`); or a differential run whose control
  fails without the property (the `packages/conformance/test/clock-jitter.test.ts` form). Two
  sub-shapes are findings on their own: a `MUTATIONS` entry whose replacement changes the number
  of `?` binds relative to the text it replaces — the batch then dies on the argument-count
  check and the probe reports "caught" without the guard ever running (recorded on
  `emit-wake-step-correlation`); and a generated surface whose inputs vary only ONE side of a
  correlation the checked predicate spans, the other side fixed in the fixture constants
  (finding 43: every run in the new wake surface was parked on the event being emitted, so
  deleting the condition asking whether it was kept the surface green on the day it was built).
- **A positive pin over a hand-copied statement.** A test that `EXPLAIN`s or asserts over SQL
  transcribed into the test while `src/` builds the same statement, and the assertion is the
  positive one — "this is what production does". Finding 42: deleting the entire index driver
  from the shipped emit left the plan suite green, because the suite pinned a copy introduced as
  "structurally the same".
- **A postmortem that names mechanisms it does not audit.** The diff adds a `postmortems/*.md`
  whose *Mechanism audit — the false negative of each* table has no row for a mechanism the same
  diff adds, or a row reading "none found" for a check that decides on text.
  `scripts/review-attest.sh` already refuses a missing or unfilled postmortem, a findings table
  shorter than the declared count, and a detection ledger that does not sum — it never reads
  this table's contents, which is the part worth a finding.

Allowed cases (do NOT flag these):

- **Text bans whose subject genuinely IS the text.** `scripts/clock-lint.py` (raw clock
  spellings in store SQL), `scripts/determinism-lint.sh` (ambient `Date.now()`),
  `scripts/fragment-lint.py` ("A predicate that can only be spelled in one place cannot drift"),
  `scripts/batch-lint.py` (call-site harvest: "THE HARVEST IS TOTAL, AND IT IS ABOUT SHAPE, NOT
  NAMES"), and `SCHEMA_FAULT.test(String(error))` in `packages/store-libsql/src/executor.ts`,
  which classifies a driver's error string because that string is all there is. Adding a
  spelling plus its `BAD_CASES` entry is a complete rung-2 fix; do not demand a runtime oracle.
- **A syntactic check that states its own residual and where it is closed.** `hasPositiveFence`
  in `packages/core/src/fenced-batch.ts`: "the check verified the fence's PRESENCE and the
  property needed is the fence's REACH … it converts a proxy with four demonstrated false
  negatives into one with none". `scripts/gate-lint.py` uses a restricted, fail-closed shell
  grammar to inventory reachable checker commands; in CI its `--run-base` path semantically
  enumerates the base package's verify script, stages the head tree with the base's complete
  `scripts/` directory, and refuses a zero-check run. Its residual is the semantics of a
  base-owned checker that executes and returns zero, not whether a textual path appeared.
  `scripts/lint-selftest.py`'s filename filter, backstopped by gate-lint's check 3.
  `scripts/review-bot-lint.py`: "What it deliberately does NOT do is judge the rules." Flag the
  overclaim, never the technique.
- **A guard attacked by a rejection test instead of a probe mutation.** `hasTopLevelOr` and the
  upsert re-stamp branch have no `MUTATIONS` entry and are fully attacked by
  `packages/core/test/fenced-batch.test.ts` — 'rejects a fence that appears ONLY in the SET
  clause' beside 'accepts a statement carrying both a positive and a negative fence'. A per-guard
  probe entry is not this repo's convention; deleting the guard turns those tests red.
- **A dynamic mechanism with its own discriminating control.** The delayed compiled-emit
  regression drives `one-batch-two-instants` red by reusing one seed at two database instants.
  Separately, `clock-jitter.test.ts` injects a later-clock retry that leaves both invariant
  arrays empty and proves its full progress-trace and table-state differential still rejects
  the run. Neither mechanism borrows the other's oracle.
- **Deliberate second representations.** `packages/store-libsql/test/query-plans.test.ts`,
  'degrades to a full scan if the waiter subquery is correlated' — a hand-written copy asserted
  to be WRONG, "kept as the counter-example so the assertion above is known to be discriminating
  rather than vacuous". `packages/conformance/test/wake-witness-surface.test.ts` — "it is not an
  independent specification; what it is, is a second representation that cannot express the
  bug, which is enough to catch it."
- **Case-law prose in the pr-gate.** Most of `.claude/skills/pr-gate/SKILL.md` Parts 2–5 records
  traps in ordinary sentences with a pointer — "`LIMIT -1` means UNLIMITED on SQLite — clamp
  every limit (`clampLimit`)" — and only 5 of its 320 lines carry a `MECHANIZED:` pointer.
  Adding such a line is documentation, not a claimed prevention. The same goes for a comment
  that explains a mechanism the diff also adds.
- **A lower rung with the reason the higher one is unreachable, parked under a live entry.**
  BUILD.md's PR3.7 remainder ("A bound on many-row follow-ons", "A generated corrupt-pre-state
  (poison) fault surface") and PR4.1's "From PR3.6, because each is only decidable with a second
  dialect in hand". A deferral under a live entry with a reason is a landing, not a gap.
- **A mechanism measured and rejected as unsound.** The always-on "a losing batch writes
  nothing" postcondition, run against `reschedule` under duplicate injection — pass 1 `[cas=1,
  task-mirror=1]`, pass 2 `[cas=0, task-mirror=1]` — would throw on every duplicate cell of the
  fault matrix; the proposed spec-ledger cross-check would have failed the build on two correct
  entries (`postmortems/pr3.6-batch-fence-plan.md`). Omitting the obvious mechanism and
  recording the measurement is finished work.
- **Extending the existing class layer.** One more conjunct on an invariant, one more starting
  state on the fault matrix's boundary axis, one more `MUTATIONS` entry, one more corrupt-row
  shape. CLAUDE.md asks for "an extension of the layer that should have caught the class".
- **A claim that did not reproduce.** `postmortems/pr11-codex-final-review.md` findings 7 and 8
  were refuted with the exact reason and got a residual plus a BUILD.md deferral; PR3.6 kept a
  non-reproducing spawn claim "as a guard inside the spawn test".
- **Diffs with no defect behind them**, and defects the author's own machinery caught. Features,
  plumbing, simplification, query-plan work, docs, renames carry no mechanism obligation. A bug
  found by a TLC counterexample at spec time, by the fuzz, or by a red test written first is
  "the system working, not SEVs".

When reporting, name the CLASS rather than the instance, then: the rung this diff landed at and
the rung the class can be expressed at, with the file that should carry it (`packages/core/src/`
for a type or primitive, `scripts/` for a build check, `packages/conformance/src/fault-matrix.ts`
or `invariants.ts` for enumeration and runtime); for an overclaimed proxy, the false negative
written as code that could be pasted into this repo and would pass; and if the higher rung is
genuinely out of reach, the missing BUILD.md sub-bullet with its destination entry named and
live rather than DONE. Do not spend a finding on what the gate already refuses —
`review-attest.sh` on postmortem sections, placeholders and ledger arithmetic, `gate-lint.py`
plus `lint-selftest.py` on checkers that cannot fail or that nothing runs, `deferral-lint.py` on
deferrals parked under a DONE entry — say which gate covers it instead. Never let the remedy be
"review more carefully": by this project's own ledger the reviewer caught 37 of 44 and the
machinery caught 0, which is the measurement that makes human attention the last net and never
the fix.
