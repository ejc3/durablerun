# Postmortem: PR3.9c insert rules for statement trees, review round 1 (PR #39)

PR3.9c lets a compare-and-set be an INSERT and moves reschedule, suspend, the await-event registration, and the event emit onto shared statement trees. One Fable `/code-review` round found that the new insert rules read less than they claimed. They read a value's position in the SELECT list where the property is the column the value lands in. They checked one assignment of a conflict arm where the property is the whole preserved fact. Six of their conditions could be deleted with every test green. Two guards that moved onto the tree stayed as weak as their text had been. The review found the four shipped statements correct and equal to the SQL they replace, so nothing wrote a wrong row. All seven findings are fixed.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing shipped wrong: no statement in either store has any of these shapes. The severity is what PR3.9d inherits, because it moves spawn's INSERT … SELECT and the successor inserts onto this grammar.

- **A stamp in the wrong column (worst).** An INSERT … SELECT whose list starts with `events.*` and then the stamp and the clock passed the insert stamp rule, because the rule read selection 1 and selection 2. The star expands to many columns, so on libSQL `fence_stamp` received `events.event_name` and the real stamp landed in another column. Every follow-on fenced on that stamp then matches no row, which the caller sees as a lost compare-and-set that in fact wrote.
- **A preserved fact overwritten beside its own guard.** A conflict arm on `events` that set `fence_at_ms = events.emitted_at_ms`, as required, and also set `emitted_at_ms` to the clock and `payload` to a new value was accepted. A re-emit would then destroy the first instant and the first payload, which is the one thing first-write-wins promises. An insert binding `emitted_at_ms` to a client number was accepted too, which breaks the rule that engine time is database time. The text path accepted both shapes before this PR.
- **A conflict clause that swallows any violation.** `ON CONFLICT DO NOTHING` with no columns passed the grammar. A compare-and-set colliding on any unique index would then lose silently, where the design wants a foreign collision to fail loudly.
- **A statement SQLite cannot parse.** An INSERT … SELECT from a table with a conflict clause and no WHERE passed the grammar. SQLite reads that ON as a join constraint and raises a syntax error, which a caller sees as a store outage on the branch that runs it.
- **Rules nobody was holding.** Six conditions of the insert rules could each be deleted with `fenced-batch-tree.test.ts` still at 40 of 40, and the registry has no mutation for the tree checks yet.
- **A claim guard the store could leave out.** The await-event registration took its whole claim check as one fragment, so `1 = 1` was accepted and a stale invocation could insert an orphan wait row. The park follow-on re-checks the claim, so the run itself was safe.
- **A dialect operator nobody checked.** The emit statement took its stamp comparison as a bind typed only in TypeScript. `'='` compiled, and a re-emit would then never re-stamp the row.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The insert stamp rule read an INSERT … SELECT's provenance by index into the selection list, and the grammar admits a star, which is one selection and many columns | The stamp lands in another column, and every follow-on fenced on it matches nothing | The insert stamp rule | It read the position in the list, which is a picture of the column a value lands in | The grammar requires one plain selection for each column of an INSERT … SELECT and refuses `*` and `t.*` (rung 2) |
| 2 | Six conditions of the insert rules could each be deleted with every test green | A refactor that drops one admits the shape it refused, with unit tests and the mutation job both green | The paired tests of `fenced-batch-tree.test.ts` | They held one refusal for each rule, and a rule has several conditions. The tree checks have no registered mutations until PR3.9e | One refusal for each condition, witnessed by deleting each condition and watching a test fail (rung 3) |
| 3 | The conflict rule checked only that `fence_at_ms` copies the preserved instant, and the insert rule did not look at the preserved column | A re-emit can overwrite `emitted_at_ms` and `payload`, and an insert can bind a client instant | The conflict rule, and before it `fenceSetAt` on the text path | Both checked the one assignment they were written about and not the rest of the list | On a table with a preserved instant, the insert takes that instant from the clock token and the conflict arm may assign only the two provenance columns (rung 2) |
| 4 | The grammar's comment promised one row or one SELECT and a conflict clause that names its columns, and the grammar enforced neither | A columnless conflict clause swallows any unique violation, and an unguarded SELECT with a conflict clause does not parse on SQLite | `statementGrammarProblem` | It listed node kinds and fields, and an insert's shape is a relation between fields | `insertShapeProblem`: one row or one SELECT, a named conflict target, and a WHERE before a conflict clause (rung 2) |
| 5 | The await-event registration took its claim check as one opaque fragment | A store passing `1 = 1` registers a wait for a stale invocation | The fragment role check | A role says where a fragment stands, not what it must contain | The claim's identity is nodes in `registerWaitCas`: run, queue, task, token, and running. A store passes only its join and its task eligibility (rung 1 for those conjuncts) |
| 6 | The emit statement took its stamp comparison as a bind typed only in TypeScript | `'=' as never` compiles, and a re-emit never re-stamps | The type of the bind | A cast or a JavaScript caller defeats a type, and nothing checked the value | The bind is gone. The statement compares with IS DISTINCT FROM, which SQLite and PostgreSQL both take (rung 1) |
| 7 | The first repair of finding 1 refused a bare star only. `selectAll('events')` builds a reference whose column is a star | The shape of finding 1 stays accepted | The red test for finding 1 | It could: the test stayed red after the repair | The repair refuses both forms, and the test holds both (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The red test for finding 1, still failing after its first repair | 1 | yes |
| Fable `/code-review` round 1 over `88d7149...e5ca895` | 6 | no |

Self-catch rate: 1 of 7, or 14%. PR3.9b's was 2 of 13, or 15%, and PR3.9a's was lower. The rate is flat. The one self-catch here exists only because the review's finding had already been turned into a red test, so the review found the class and our machinery found one instance of it.

The checks added in PR3.9a and PR3.9b did hold in the way they were built to. The review tried to defeat the grammar, the fragment roles, and the placement check with the four moved statements and reported no finding for parity, bind order, NULL handling, the bridge arm, or the mutation re-aims. What it found was in the rules this PR added, which had paired tests and nothing else.

## Recurrence

Two of the seven are classes an earlier round already met.

- **Finding 2 is the class "a mechanism with one failing case was treated as proven".** AGENTS.md lists it from the wake surface round, where two conditions could be deleted with all 1728 cases green. The mechanism that round named is a registered mutation for each condition, and BUILD.md defers it for the tree checks to PR3.9e. So the class had a mechanism on paper and no mechanism in force for this code, and the paired tests were written to the older habit of one refusal for each rule. The repair here is the cheap form of the same mechanism: one refusal for each condition and a witnessed deletion of each. It does not replace the registered mutations.
- **Findings 1 and 4 are the class "a proxy where the property fits".** PR3.9b's round found fragment counts standing for fragment positions. Here a position in the selection list stood for the column a value lands in, and a list of node kinds stood for an insert's shape. The PR3.9b mechanism was specific to fragments and could not have caught these. What both rounds show is that each new rule in `addTree` was written against the statements at hand and tested against the same statements.

Finding 3 is not a recurrence of a fixed class. It was carried over: the text path's `fenceSetAt` rule accepted the same two shapes, and the tree rule was written as its copy.

## Mechanism audit — the false negative of each

Each exhibit was written and run against the fixed code.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| An insert's shape in the grammar | 2 | A WHERE that guards nothing. Run: an INSERT … SELECT with a conflict clause whose WHERE is the fragment `1 = 1` is ACCEPTED. The rule makes the statement parse. It does not make the WHERE mean anything |
| The preserved fact's closed conflict arm | 2 | A table with no preserved instant. Run: a conflict arm on `waits` that re-stamps and also overwrites `event_name` is ACCEPTED. The closed set applies only where the contract names a preserved fact, and `waits` upserts nothing today |
| The claim's identity as nodes | 1 for those conjuncts | The join a store still passes. Run: a registration whose `taskOwnsRun` fragment is `1 = 1` is ACCEPTED, so the run is joined to any task. The shipped text is held by the registered mutation `await-event-register-requires-run-task-queue-ownership` and by the corpus |
| The stamp comparison as a fixed operator | 1 | None can be written for SQLite or PostgreSQL, because the bind no longer exists. The boundary is a dialect that lacks the spelling: MySQL has no IS DISTINCT FROM, which BUILD.md now records under PR4.3 |
| One refusal for each condition | 3 | A condition added later with no refusal of its own. The deletion run is a witness made once, not a gate, so nothing fails when the next condition arrives untested. PR3.9e's registered mutations are the gate |
| One record for the registration's columns and values | 1 | None for the pairing of a column with its value. The record does not say which columns a wait needs, which the schema does |

## Fix-induced defects

One, finding 7. The first repair of finding 1 tested `SelectAllNode.is(selection)`, and the builder represents `t.*` as a reference whose column is the star. The red test for finding 1 used `selectAll('events')`, stayed red, and the repair was corrected before it was committed. A bare `*` case was added so both forms are held.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `88d7149...e5ca895`, run locally in the PR3.9c worktree. Its verdict: "None of its ten findings is a live bug in the four shipped statements", and "the review found the port matches the old SQL in both dialects, and the CI bridge arm and mutation re-aims correct". One verifier confirmed eight findings, most by reproduction.
- Quoted findings:
  - "`insertProvenance` reads an INSERT … SELECT's stamp by index into `selections`. A star selection (`SelectAllNode` is in the grammar) is one entry that expands to N columns";
  - "Deleting any one of six conditions leaves `fenced-batch-tree.test.ts` at 40/40";
  - "the conflict rule checks only that `fence_at_ms` copies `events.emitted_at_ms`";
  - "`onConflict(oc => oc.doNothing())` with no columns passes. It swallows a violation of any unique index";
  - "`claimHolds: sqlFragment('1 = 1')` is accepted, and a stale invocation inserts an orphan wait row";
  - "`stampDiffers: '=' as never` compiles to `where events.fence_stamp = ?`".
- Red test: commit `18abb78`, run and seen failing (5 of 45 tests) against `e5ca895`: the star, the overwritten fact, the client instant, the columnless conflict clause, and the unguarded SELECT.
- Fix: commit `aeca839`, after which core passes (239 tests). Thirteen condition deletions, one for each condition of the insert rules across `sql-tree.ts` and `fenced-batch.ts`, each fail at least one test of `fenced-batch-tree.test.ts`.
- Fix for findings 5 and 6: commit `58815a0`. They are removals, a bind that no longer exists, so there is no red to write against the old signature. The statement test asserts the compiled claim conjuncts whatever fragments a store passes, and the corpus records the new statements.
- The other three review findings were documentation and cost, and the PR body lists them with the simplify pass.

## Root cause

The insert rules were written by reading the two statements that needed them, and their tests were written from the same two statements. A rule built that way is true of its examples and says nothing about the grammar's other members, and the grammar had just gained several: a star, a multi-row insert, a columnless conflict target. The closed grammar makes that gap small and countable, which is why a review could enumerate it. The author's tests did not enumerate it.

## Mechanisms

- **Built now**
  - `insertShapeProblem` in the grammar: one row or one SELECT, one plain selection for each column, a named conflict target, and a WHERE before a conflict clause.
  - The preserved fact rule: the insert takes the preserved instant from the clock token, and the conflict arm assigns the two provenance columns and nothing else.
  - One reader, `assignedProvenance`, for an UPDATE's assignments and a conflict arm's, where there were two copies.
  - One refusal for each condition of the insert rules, and a witnessed deletion of each.
  - `registerWaitCas` builds the claim's identity from nodes and its columns and values from one record. `emitEventCas` fixes its operator.
  - `whereClaimedRun` holds what every worker write requires of its run, for complete, suspend, and both receipt transitions.
- **Deferred, recorded in BUILD.md**
  - Registered tree-path mutations for the insert rules, with the other tree checks, in PR3.9e.
  - One pass over the tree for the checks, with the measured per-call cost, in PR3.9e.
  - A dialect compile for upserts and the null-safe comparison, for `store-mysql`, in PR4.3.

## What this round still would not catch

- A WHERE, a join, or an eligibility fragment that is present and guards nothing. A fragment is opaque text, held by the corpus and by the registered mutations that own its shipped spelling.
- An upsert on a table with no preserved instant that overwrites columns it should keep. No such statement exists, and the closed conflict arm is scoped to preserved facts.
- A condition added to `addTree` after this PR with no refusal of its own, until PR3.9e registers mutations for the tree checks.
- A statement that is correct on SQLite and PostgreSQL and cannot be spelled on MySQL. PR4.3 owns that.
