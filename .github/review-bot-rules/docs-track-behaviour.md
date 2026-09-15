# Prose that describes behaviour must be true of the diff that ships

<!-- review-bot-scope:start -->
DESIGN.md
BUILD.md
CLAUDE.md
postmortems/**/*.md
specs/**/*.tla
packages/**/*.ts
scripts/**/*.py
scripts/**/*.sh
.claude/skills/pr-gate/SKILL.md
package.json
<!-- review-bot-scope:end -->

Scope: `DESIGN.md`, `BUILD.md`, `CLAUDE.md`, `postmortems/**/*.md`, `specs/**/*.tla`, comments and
docstrings in `packages/**/*.ts` and `scripts/**/*.{py,sh}`, `.claude/skills/pr-gate/SKILL.md`, and
`package.json` where a document makes claims about the `verify` chain. This rule covers one thing: a
sentence asserting something about behaviour, coverage, or completeness, and a diff that makes it
false — including by being silent where DESIGN.md was owed an edit. It does NOT cover whether the
behaviour itself is right (the fenced-batch/provenance rules own that), whether a mechanism is a
syntactic proxy for the property it claims (the prevention-ladder rule), writing style and jargon
(the plain-language rule), or a batch label missing from the spec ledger (`scripts/spec-ledger.py`
already fails the build for that).

DESIGN.md is the spec, and CLAUDE.md makes every behaviour change update it in the same diff;
BUILD.md owns every deferral under a *named, live* PR entry. Only fragments of this are mechanized:
`scripts/deferral-lint.py` checks placement (a deferral sub-bullet parked under a DONE entry), and
`scripts/review-attest.sh` checks one piece of arithmetic. The rest has no checker, and it has cost
real money. Three incidents:

**A comment that asserts a guard that does not exist.** `suspendRun`'s docblock said it was
"reschedule's exact transition PLUS the suspension marker" while the two eligibility guards had
diverged — reschedule wrote `t.state IN ${LIVE}`, suspendRun wrote `eligibleTask('t', NOW)` — so a
run whose task was past its cancellation deadline could re-park itself back into the queue the claim
path exists to keep it out of (fixed in `1814794`). Note what does NOT discriminate here: both sides
used a shared `fragments.ts` export — two different ones. The postmortem's layer analysis for finding
31 reads: *"The comment asserted they were the same, which reads as a check and is not one."*

**Counts nobody derives.** `postmortems/pr3.6-fence-provenance.md` shipped with "563 tests across 58
files", "Eleven guards, and it found three unmaintained", "found none of the 38", and "Not part of
the gate" for a probe that commit `cf6fc30` had made a required pr-gate item — four claims
contradicted by commits on the same branch, all corrected in `93624ac`.

**A hand-kept tally beside a hand-kept table.** That document's detection ledger summed to 43 against
44 findings, leaving finding 26 attributed to no detector — and an unattributed finding is precisely
the one that flatters the self-catch rate, the headline number the document exists to produce. That
half is now derived (`review-attest.sh` sums the ledger and refuses a mismatch); the other two shapes
are still pure review, which is why every finding here should name the derivation that would have
made the sentence unwritable-if-wrong.

<!-- review-bot-synopsis:start -->
Flag behaviour changes (batch guards, port signatures/error types, schema, retry arithmetic, wire forms) with no DESIGN.md hunk anywhere in the branch diff where a specific spec sentence can be quoted as falsified or missing, comments the diff makes false or orphans, comments asserting two sites are the same while the diff spells them separately (two different shared fragments still counts) with no drift test, exact counts of this repo's own artifacts (tests, guards, checkers, findings, gate membership) contradicted by the same PR or by another count of the same set, added postmortems whose narrative rate or attributions disagree with their detection ledger, and deferrals that never land as a sub-bullet under a live BUILD.md PR entry. Pass for spec/DESIGN edits landing in another commit of the same branch, fixes that make code obey a rule DESIGN.md already states, test-only diffs and oracles that deliberately restate a rule, past-tense history naming the mechanism that now holds, DESIGN.md narrating its own drafts, measured DBMS facts with sample sizes, approximate or ranged counts ("200+", "9–11"), category-level gate summaries still true, numbers inside earlier rounds' postmortems, unannotated deferral sub-bullets under live PR entries, `ABANDONED:` notes and prose about deferral under DONE entries, "deferral" as engine vocabulary (§3.8.2 dispatch deferral, deferred start), and refactors preserving every statement's semantics.
<!-- review-bot-synopsis:end -->

Report a failure when the changed code introduces or leaves standing any of these:

- **A behaviour change with no DESIGN.md hunk anywhere in the branch diff, and a spec sentence you
  can name.** Behaviour means: a guard or predicate in a store batch, a labeled batch's statement
  set, an error type or code thrown at a port, a port signature or returned shape, retry/accounting
  arithmetic, a schema column or migration, LWW/mirror semantics, or a serialization/wire form.
  Decidable, and required together: the behaviour hunk is in the diff, `DESIGN.md` is absent from the
  branch's changed-file list, AND the report quotes either the DESIGN sentence the diff makes false
  or the numbered rule that enumerates this class and now has no entry for the new behaviour. If you
  cannot quote one, there is no finding.
- **A comment the diff makes false**, including one orphaned by a deletion it survived: the changed
  lines no longer produce the condition, row set, consequence, or ordering the comment states, or the
  code it describes is gone. Two precedents: `cb72862` had to correct an emit-cleanup comment still
  saying "the delete below removed its wait anyway" after the cleanup was made to follow the wake,
  because "a comment that overstates what depends on it is how the next person decides the wrong
  thing is load-bearing"; `5551b5a` deleted the hand-copied statement a docblock had introduced as
  "structurally the same statement emitEvent builds".
- **A comment asserting two sites are the same while the diff spells them separately.** "X and Y are
  the same transition", "the same predicate", "identical to the above". Decidable because the comment
  NAMES the sibling: open it and compare the asserted-identical text. Flag when the two sides are not
  the same named constant, helper, or fragment — two DIFFERENT shared fragments is still two
  spellings, which is finding 31 exactly — and the diff adds no test that names both sites and fails
  when one drifts.
- **An exact count of this repo's own artifacts contradicted by the same PR, or disagreeing with
  another count of the same set in the same PR.** Tests, files, guards, mutations, checkers, findings
  rows, "N of M", percentages. Decidable: the diff adds a test file, a checker, a mutation, or a
  findings row while the sentence carries the old number; or two sentences count one set differently.
- **A gate-membership claim contradicted by a gate change in the same PR** — "not part of the gate",
  "run by `pnpm verify`", "all nine checkers", a named list — when `package.json`'s verify chain,
  `scripts/`, or the pr-gate skill changed in the same diff.
- **An added postmortem whose numbers do not reconcile.** The narrative self-catch sentence must
  agree with the ledger it summarizes (rate, "ours" rows, and the outside remainder summing to the
  findings-table row count), and every finding must map to a ledger row, including a jointly
  attributed one. `review-attest.sh` sums the Findings column and nothing else; the sentence, the
  "Ours?" column, and an attribution that is simply wrong are yours.
- **A deferral that never reaches a live BUILD.md PR entry.** Work described as not done —
  "deferred", "still missing", "left for", "closing it needs", a TODO — introduced only in a source
  comment, only in a postmortem's Deferred section, or only in the PR body, with no matching
  sub-bullet under a non-DONE `- **PRx.y …**` entry in BUILD.md. `deferral-lint.py` sees only
  sub-bullets already inside BUILD.md; a deferral that never lands there is invisible to it.

Allowed cases (do NOT flag these):

- **The DESIGN or spec edit lands in another commit of the same branch.** `ee3beb5` changed the emit
  guard and `266ec7d` recorded it in `specs/Scheduler.tla` several commits later; `76b7835` tightened
  the wake predicate and `f434586` carried its DESIGN.md rule-2 hunk. Judge shape 1 against the full
  branch diff — only a branch-wide absence is a finding.
- **A fix that makes the code obey a rule DESIGN.md already states.** `aec536f` brackets the caller's
  correlation so a disjunction cannot swallow the fence; §3.4 rule 1 already required every row a
  follow-on writes to be fenced, so no new spec sentence is owed and the commit touches no document.
- **A test-only diff, and an oracle that deliberately restates a rule.**
  `packages/conformance/test/wake-witness-surface.test.ts` re-states the wake predicate one row
  at a time on purpose — "a second representation that cannot express the bug". It changes no engine
  behaviour, so no DESIGN hunk is owed, and it is not a second spelling to collapse.
- **Past-tense history that names the mechanism now holding.**
  `packages/store-libsql/src/fragments.ts`, `packages/core/src/fenced-batch.ts`,
  `packages/store-libsql/src/store.ts`, and `scripts/review-attest.sh` ("a round took the
  table from 38 rows to 44") — including that count, which is quoted history rather than a live
  tally. `packages/store-libsql/src/store.ts` is the shape a sameness comment should have: it
  says reschedule uses "the same predicate suspendRun uses", and both sites call
  `eligibleTask('t', NOW)` with a test that fails if either drifts.
- **DESIGN.md narrating its own history.** `DESIGN.md` ("An earlier draft carried a second
  interface listing here; it drifted and is deliberately deleted — one normative surface") and
  `DESIGN.md` ("An earlier draft of this rule named `clock_timestamp()`, which would have made
  rule 8 unsatisfiable on Postgres"). Deleting these to "keep the spec current" destroys the record
  of why the current text is the way it is.
- **Measured facts about a DBMS, with their sample size.** `DESIGN.md` "(4000/4000 identical)"
  and `DESIGN.md` "differs about 2% of the time on local SQLite (94 of 4000 measured)" are
  measurements of SQLite, MySQL, and Postgres — not counts of our artifacts. They need re-measuring
  only when the claim about the dialect changes.
- **Approximate, lower-bound, or ranged counts.** `.claude/skills/pr-gate/SKILL.md` "200+ tests
  (~2 min)" and `BUILD.md` "repeated 9–11 times" do not become false when a test file or a call
  site is added. Only exact counts go stale.
- **A category-level summary of the gate that stays true.** CLAUDE.md's "`pnpm verify` — lint +
  format-check + typecheck + test" is not falsified by adding another `lint:*` to the chain; only
  membership and negation claims are.
- **Numbers inside an earlier round's postmortem.** `postmortems/pr11-events-review.md` records its
  own round's counts, and `review-attest.sh` deliberately requires an ADDED postmortem — touching or
  renaming an old one does not count. Asking for an old record to be brought up to date is asking for
  the record to be falsified.
- **BUILD.md deferral sub-bullets under a live PR entry that name no destination, trigger, or
  owner.** PR3.7's "A bound on many-row follow-ons" and "A generated corrupt-pre-state ('poison')
  fault surface" are correct as written; `deferral-lint.py` says why: "work listed under a live PR
  entry is owned by that PR — the containing entry IS the destination, so nothing needs to repeat
  it." Likewise `ABANDONED: <reason>` under a DONE entry, and prose *about* deferral inside a DONE
  entry (`BUILD.md`), because "a checker that fires on text ABOUT the rule is the kind that gets
  weakened until it is quiet".
- **"Deferral" as engine vocabulary.** The §3.8.2 dispatch deferral and deferred start are behaviour,
  not unfinished work: `packages/sdk/src/run-worker.ts`, `packages/core/src/ports.ts`,
  `packages/core/src/types.ts`, `packages/store-libsql/src/store.ts`.
- **A refactor that preserves every statement's semantics.** A hand-written WHERE replaced by a
  generated row selection, a shape hoisted into one helper, tests unified onto one fixture opener
  (`96d1575`, `a5f145b`): no DESIGN.md edit is owed when the row set written, the guards, the
  returned shape, and the error taxonomy are unchanged. DESIGN.md pins the contract, not the
  implementation shape.

When reporting, quote the offending sentence with its `file:line` and the exact hunk that makes it
false, and say which contract is broken: DESIGN.md-in-the-same-diff, BUILD.md-owns-the-deferral, or a
claim no checker derives. Then name the missing mechanism, because that is the part with value: for a
count, the derivation that would make it unwritable-if-wrong (the `label-inventory.test.ts` pattern —
harvest from the source with the same harvester the claim uses and compare; or `review-attest.sh`
summing the detection ledger); for a comment asserting sameness across two sites, the single
definition or the drift test that finding 31's fix shipped; for a missing DESIGN.md edit, the
sentence of the spec the diff has silently rewritten. Where no derivation is possible, say so and
recommend deleting the number rather than maintaining it — a prose count with no source is a claim
that will be false by the next commit. Treat every finding here as a mechanism gap, not a typo: this
rule is a probabilistic reviewer and therefore a detection net of last resort.
