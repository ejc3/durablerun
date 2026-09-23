# Postmortem: the migration lock as a lock coordinate, its review (PR4.4b)

The change moved the migration lock out of a match on the batch label and into core's batch control, made the MySQL executor refuse a migration write that names no lock, replaced PostgreSQL's lock statement by the control, and made MySQL's `migrate()` send everything pending as one batch. One review read the thirteen commits. It found nothing high and nothing medium, and twelve low points, of which six count as findings under the rule this repository counts by: a product defect counts, a hold that could not fail counts, and a false claim counts. The fold is six commits, two of them red tests. None of it changes what the runner sends.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Without the review, two guards would have shipped with a hole each, under an exit test marked met.

The worst is the PostgreSQL one, because it made the branch weaker than the commit it stood on. There the lock that makes a second migrator wait was a statement of every version's batch, which no wrapper could drop. The branch made it the batch's control, and nothing refused a version's batch whose control was gone: the executor sent BEGIN, the statements and COMMIT with no lock on meta. A wrapper that rebuilds a control from a mode would have brought back the deadlock between racing migrators that the lock exists to stop, which PostgreSQL ends only after its deadlock timeout and the executor then hides by running the victim again. No wrapper in the repository does that today.

The second is MySQL's refusal, which this branch built and which exit test 5 was marked met on: "a new `migrate:` label cannot run DDL unlocked". It looked only at write mode. A `migrate:` batch sent as a read ran its DDL with no lock, because a read-only transaction refuses DML and does not refuse DDL: the statement's own commit ends the transaction first. MySQL commits each DDL statement on its own, so nothing could undo what such a batch did beside another migrator.

The other four are a rule that was nowhere, a dead line under a sentence that denied it, a sentence true only sometimes, and measurements written as constants. A version's author or an operator would have read each as fact.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A stale MySQL plan replays every version that was pending when it read the version, where a batch for each version replayed only the one in flight, and nothing said what that means for a version's author | A later version that undoes what an earlier version's repeatable statement creates would be undone again by an older build's stale batch, under a recorded version that says otherwise. Not reachable with today's versions | The stale-plan server cases, which stop a migrator between its read and its batch | They hold the result to the schema of a clean migration of TODAY's versions, where no version undoes another, so the consequence has no state to show itself in | None built. The rule is written in DESIGN.md, and a written rule is not a rung. The form that makes it unwritable, a guard statement for each version so that a stale batch sends nothing, is recorded as an option with its trigger, because it changes what the runner sends while another pull request stands on it |
| 2 | The PostgreSQL executor ran a version's batch that names no migration lock | A dropped control runs a version with no lock on meta, and racing migrators deadlock again. The branch was weaker here than its base | The rolling deploy case and the two registered mutants on the admin's argument and the executor's send | They pin that the admin passes the control and that the executor sends the lock for it. Neither asks what the executor does when the control is NOT there, which is the state a wrapper makes | A refusal before a connection is taken, every `migrate:` write but the bootstrap (rung 3), red first, with a registered mutation |
| 3 | MySQL's refusal looked only at write mode, so a `migrate:` batch sent as a read ran its DDL with no lock | DDL beside another migrator, which MySQL cannot undo. The exit test's sentence was false for a read | The refusal's own red test | The refusal decides from two inputs, the label and the mode, and the red varied one. A case that fails once was taken for a guard that holds | Under a `migrate:` label the executor admits a write that names the lock, or the canonical version read known by its whole text, and nothing else (rung 3), red first, with a registered mutation |
| 4 | A second decision on the lock's kind in the PostgreSQL executor that nothing could reach, under a body sentence that said one exhaustive switch | None at runtime. A reader is told the kind is decided once, and a line that could be wrong has no case | The mutation audit, which exists to show that a line is held by a test | It audits registered mutations, and no mutation named that line. Deleted or inverted, all 28 cases stayed green | The line is deleted (rung 1: what is not there cannot be wrong) |
| 5 | "An advance sent after it commits at once" is true only where the guarded index form really creates its index | A reader derives the wrong durable state for a batch that recovers from an earlier crash, where that form does nothing and commits nothing | The generated crash cuts, which hold the version the server left to that rule | Every plan they cut starts from a database where what the plan creates is not there yet, so the rule's other branch is never entered | None built. The sentence and the test's rule now say they cover a first crash, and why the state a recovery leaves is one the first crash already makes |
| 6 | Counts true at seven versions were written as constants: 132 protocol messages, 58 cuts, nine reads and eight locked batches | Main already holds an eighth version. Each figure would have been false the day this merged | The pass over the prose before publishing | Nothing ties a figure in a document to the list it was counted from | None built. Each figure says at how many versions it was measured, and the merge measures again |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review: a Fable subagent with the built-in code review skill and probes of its own on servers of its own | 6 | No |
| This project's machinery | 0 | Yes |

Self-catch rate: 0 of 6, or 0% (previous round in this line of work, the keyed write locks: 2 of 5, or 40%).

The machinery did catch one defect of this branch before the review, and it is not counted because it is the system working: the base gate refused the first form of MySQL's statement-list call, which had passed this branch's own copy of the batch lint after the branch changed that copy to match. What the rate says is plain. The branch added eleven mutations, 58 generated cuts, two rolling deploy cases and a byte comparison of the PostgreSQL wire, and every one of them held what it was built to hold. All six findings sat where no mechanism had been pointed: at the input a guard does not vary, at the state a control leaves when it is absent, and at prose.

## Recurrence

Finding 3 is a recurrence, and the class is in this repository's standing rules by name: a mechanism with one failing case was treated as proven, where the property is that it fails for EVERY condition it claims. The earlier instance was a wake surface whose conditions could be deleted with every case green. The mechanism instituted then was the registered mutation: a guard is held when a mutant of it is caught. It did not work here because a mutation is aimed at a line, and the hole was an input. The refusal's one line had one mutant, the mutant was caught, and the audit was green, while the predicate's second input was never varied by any case. What the mechanism checks is "this line, changed, fails a test". What it was supposed to check is "this guard refuses everything it claims to". Those meet only when a case exists for each input of the guard, and nothing asks for that.

Finding 2 is the same class seen from the other side: the cases held the path where the control is present, and none the path where it is absent.

Finding 6 is a recurrence of a figure stated without the conditions it was measured under. The earlier instance was a timing quoted in two documents with no log behind it, in the keyed write locks round, and the lesson recorded then was to keep the log and name the measure. This branch kept its logs and named its measures, and still wrote counts that depend on the number of versions as if they did not. The earlier lesson was about where a figure comes from. It said nothing about what a figure depends on.

Findings 1, 4 and 5 are not recurrences of a class with a mechanism.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| PostgreSQL's refusal of a `migrate:` write that names no lock | 3, and a SYNTACTIC check: it reads the label's prefix | Written and run over the executor's unit fake at the registry commit of the fold: `batch('backfill:add-table', [{ sql: 'ALTER TABLE runs ADD COLUMN note TEXT', args: [] }])` is accepted and sends `BEGIN`, the `ALTER TABLE`, `COMMIT`, with no lock. DDL under a label of another family is invisible to it |
| MySQL's refusal of a `migrate:` batch that is neither a locked write nor the version read | 3, and a SYNTACTIC check: it reads the label's prefix | Written and run the same way. `batch('Migrate:v1', ddl)` with a capital letter, `batch('backfill:add-table', ddl)` as a write, and `batch('backfill:add-table', ddl, 'read')` each send the `CREATE TABLE` with no `GET_LOCK`, the last one inside a read-only transaction. The property is "DDL runs only under the migration lock". The check is "a label that starts with `migrate:`" |
| The rule for a MySQL version's author (finding 1) | none: prose | The reviewer's own reproduction, with the base as the control: a version sent by hand that drops `runs_woken` passes every gate, and a stale batch of an older build then puts the index back. No check reads a version for what it undoes |
| Deleting the dead decision (finding 4) | 1 for that line | None for the line. For the class, an unreachable line under a claim: any other unreachable line passes today, because the audit looks only where a mutation is registered |
| The corrected sentences and qualified counts (findings 5 and 6) | none: prose | Any sentence in DESIGN.md. No checker reads a sentence against the code, and a test that pinned a document's figure would be a proxy of its own |

The two refusals are proxies, and this document says so because the repository's standing rules ask for exactly that admission. BUILD.md records the property-shaped form as an option with its trigger: recognising the statements that commit by themselves, whatever the label and the mode.

## Fix-induced defects

One of the six. Finding 4, the unreachable second decision, was not in the first nine commits. The simplify pass had found that PostgreSQL's executor reached the claim lock by elimination, and its fold answered with an explicit check inside the event and claim path, behind a switch that had already refused every other kind. The check was tested by running the suite, which stayed green, and was not re-read as new code: a line added to make a decision explicit was never asked whether anything could reach it.

No finding was introduced by the fixes of this review's own fold. Those fixes were not reviewed again. Each refusal only refuses more, mirrors logic the review had read, and came with its red.

## Evidence

- Red tests: commit `1a9f2b7`, probe `packages/store-postgres/test/executor.test.ts` `refuses a migration write that names no migration lock, the bootstrap excepted, and sends nothing`, run and seen failing (1 test) against `813c637`: a version's label and `migrate:backfill` were both accepted.
- Fixes: commit `401f364`, which turns `1a9f2b7` green and deletes the dead decision of finding 4; gate after fix: the PostgreSQL store's suite, 65 of 65, and the shared schema and admin surface on PostgreSQL, 9 of 9.
- Red tests: commit `1bae085`, probe `packages/store-mysql/test/executor.test.ts` `refuses a migration batch sent as a read, and sends nothing`, run and seen failing (1 test) against `401f364`: accepted, with the `CREATE TABLE` sent inside the read-only transaction.
- Fixes: commit `0f739d8`, which turns `1bae085` green; gate after fix: the MySQL store's suite, 78 of 78, and the shared schema and admin surface on MySQL, 9 of 9.
- Fixes: commit `7f29ee8` registers a mutation for each refusal, and commit `b356274` holds the documents for findings 1, 5 and 6 and the options with their triggers; gate after fix: the registry's self-test, 965 entries with every find exactly once, the bridge run on a fresh copy of the base's registry, and the base's own copies of six checkers on this tree.
- Finder: the one review of the pull request, a Fable subagent that invoked the built-in code review skill and ran probes of its own on servers of its own, quoted verdict: "I found no HIGH and no MEDIUM. Every finding below is LOW." and, first of all, "Nothing I found requires a change" to what a version's author writes, what the runner sends, or what a rerun after a crash does.
- What the review reproduced, so that an outside reader can audit the round: both of the branch's earlier reds failing by name at their commits; the PostgreSQL wire recorded with its own recorder, 153 frontend messages for each build of which 132 are Query, Parse or Bind, byte identical; 192 jittered races of real migrators of both builds and 120 rounds of racing bootstraps, every one finishing with a clean schema; a real 35 second hold of the migration lock, with the same outcome on both builds; all 58 cuts on a server of its own; fourteen mutations applied by hand, each failing by name.
- Claims that did NOT reproduce, and what settled each. The review's question assumed that the old text-match mutation on MySQL's repeatable statements had been re-owned to the generated cuts. It had not, and the body had said so: the base gate runs the base's registry, which binds that verdict to the text match's marker, and the bridge never moves a verdict. The reviewer's own words: "The body is accurate here. Your question's premise was not." The test spells the released build's lock as one expression with literals, which is not the text of the statement that build sends. The reviewer settled that it is equal in effect by running the case against the base's real `migrate()`, which waited on exactly that name with no table written.

## Root cause

The branch's machinery was aimed at what the branch ADDED, and every finding sat in what it left unsaid or untried. A guard was shown to fail once, and its other input was never turned. A control was shown to arrive, and its absence was never sent. A rule changed for whoever writes the next version, and the change had no state to show itself in, because today's versions never undo one another. A figure was counted correctly and written down without the number it depends on.

The common cause is that a red test, a mutation and a generated case all answer "does this hold?" for the thing they are pointed at, and none of them answers "what else can reach this?". The review asked that second question six times. The registered mutation, which is this repository's answer to a guard that cannot fail, is a statement about a line, and a guard's inputs are not lines.

## Mechanisms

Built in this PR:

- PostgreSQL's executor refuses every `migrate:` write but the bootstrap that names no migration lock, before a connection is taken (rung 3), with a registered mutation. It lives in `packages/store-postgres/src/executor.ts`.
- MySQL's executor admits, under a `migrate:` label, a write that names the lock or the canonical version read, and refuses the rest, a batch sent as a read included (rung 3), with a registered mutation. It lives in `packages/store-mysql/src/executor.ts`.
- The unreachable second decision on the lock's kind is deleted (rung 1 for that line).

Deferred (recorded in BUILD.md):

- A guard statement for each MySQL version, so that a stale batch sends nothing and the rule for a version's author is lifted. It changes what the runner sends while another pull request stands on this one. The trigger is the first version that needs to undo or reshape what an earlier one creates.
- Recognising the statements that commit by themselves, whatever the label and the mode, which is the property the label prefix stands in for. The trigger is the first such statement sent under a label that does not start with `migrate:`.
- A conformance case for the refusal of an unknown lock kind, which needs the fixture contract to say whether a dialect implements locks.
- Which version's statement failed in a MySQL batch, which needs the executor to report a statement's index. The trigger is the first failed migration an operator has to read.

## What this round still would not catch

A guard with two inputs whose cases vary one would ship today. Nothing asks that every input of a refusal be turned by some case, and a mutation on the guard's line is caught all the same.

DDL under a label that does not start with `migrate:`, or that spells it with a capital letter, would run with no lock on both server executors, in either mode. Both refusals read a label's prefix, and the exhibits above show it.

A MySQL version that undoes what an earlier version's repeatable statement creates would pass every gate, and an older build's stale batch would undo it in turn. The rule is prose.

An unreachable line under a claim that denies it would ship wherever no mutation is registered.

A sentence in DESIGN.md that is true only in the cases a test happens to make, and a figure that depends on a number the sentence does not name, would both ship. No checker reads prose against code.
