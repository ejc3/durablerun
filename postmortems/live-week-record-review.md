# Postmortem: the record of the live week milestone, one review

The pull request changes one file, BUILD.md. It names the milestone that follows the operable alpha, the live week on the deployed alpha, with three exit test lines, two pull requests outside them, and the decisions made on 2026-11-08 under the maintainer's delegation. Nothing it describes was built when it was reviewed. One review, which ran as a subagent invoking the built-in code review skill, read the first commit and found 13 things, none HIGH, six MEDIUM and seven LOW. No product code is involved. Every finding is a sentence of a plan: an exit test line that could be marked met with half of it unbuilt, or a step of the week that, followed as written, would have cost the week.

**This document is adversarial toward the MACHINERY and blameless toward people.** Never "who wrote it", "should have noticed", "was careless" — those explain nothing and are not actionable. Always "what would have made this unwritable, or caught it without a human looking". Every section below asks a question whose comfortable answer is the wrong one; if a section is easy to fill in, it has not been answered yet.

## Severity

Nothing would have shipped to a user. What the record governs is a week of at least 168 hours on a deployed database, and three of the findings would have lost that week or accepted a wrong one. Finding 5 is the worst: the record let two pull requests merge while the week ran, the week's workflow runs the CLI of main's newest commit, and a renamed member of a report makes the checker refuse every day printed before the rename. Finding 13 is the same loss by another road: with the workflow left on after the end sample, the next purge deletes units whose lookups the receipt still needs, and the checker refuses the week for missing periods. Finding 4 is the other direction: the line settled the purge windows and named a run that accepts a week purged under any windows. Findings 1, 2 and 3 are an exit test line that a pull request could meet while leaving half of what it says unbuilt.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Line 45 promised that a store's refusal of what a credential may do is typed, and its cases and its red covered a wrong credential alone. On PostgreSQL and MySQL that refusal is a permanent answer and exit 7 today, so the stated red could not be written for it. | The line could read met with the refusal of a statement left as it is. | The author's read of the line against the executors. | Nothing reads an exit test line against the code it speaks of. | The line now states both refusals as they are today and gives each its own case and its own red. None for prose. |
| 2 | Line 45 named two places that act on the type of a store's failure. The code branches on it in the SDK's control of a pass, the hosted handler, the CLI's failure answer and its read after a write. | A new type could pass the named cases and be billed to a task's attempts, or move a hosted answer from 503 to 500. | The same read. | The same. | The line now requires one definition of the kinds in core, which each consumer switches on, so a kind with no arm fails typecheck. Rung 1, built by PR5.6, not here. |
| 3 | Line 45 asked for a conformance case on each dialect. A libSQL file takes no credential, and the libSQL driver gives one code for every HTTP status. | The libSQL case could not be written as worded. | The same read. | The same. | The line now names a case of the store package against a loopback server, and says what is not typed. None for prose. |
| 4 | Line 47 settled the purge windows and named `pnpm week-receipt` as its run. The checker reads the completed window only to size its bound, so it accepts a week purged under other windows, and nothing runs the checker on a committed receipt. | A week under 30 day windows would be accepted as the week the line describes. | The checker's cases. | The windows are repository variables, typed by hand, and no case holds them. | The line now requires a case in PR5.8 that reads the windows from the committed receipt and runs the checker on it in CI. Rung 2, deferred to PR5.8. |
| 5 | The order let pull requests merge while the week ran, and the workflow runs the CLI of main's newest commit. | A renamed member of a report refuses the days before it, and the week is lost. | Nothing. | No check holds what main may take while a workflow of this kind runs. | The order puts all four pull requests before the week, and line 47 says main changes no document the receipt holds. None beyond the rule. |
| 6 | PR5.6 gives the CLI a new kind of store failure, and the checker, the README and DESIGN.md each hold a closed list of the two kinds printed today. | A purge refused for an expired token, kept as printed, would refuse the week as malformed. | A case that holds the checker's kinds to the CLI's. | The checker's permanent kind is tested with a document written by hand. | PR5.6 is required to hold every kind the CLI prints to the checker's reader, from core's one definition. Rung 2, built by PR5.6. |
| 7 | The record said three last folds had no review after them. BUILD.md says so of seven. | The record undercounted what was left unread. | A count of the sentences. | A count in prose has no marker. | The record now names the seven, and the other four are read. None for prose. |
| 8 | The non-goals took in every non-goal of the milestone below, the first of which is the live week itself. | The week read as both the exit test and a non-goal. | The author's read. | Prose. | Two exceptions named. None. |
| 9 | The Held paragraph left out the branch for the selftest and four of the six settings, and stated the second deployment as fact with no decision. | An operator following the paragraph would start the week without a selftest record. | The author's read against receipt M1's paragraph. | Prose held in two places. | The paragraph lists them, and the decision is recorded. None. |
| 10 | Sentences of the completed milestone still called the decisions the maintainer's to make. | Two paragraphs of one file disagreed on who decides. | The author's search. | The search was for the words that changed, not for what they say. | Three sentences corrected. DESIGN.md's is PR5.6's. None. |
| 11 | PR5.7 was scoped to a suspension. The model differs from the code at a chain and a completion too. | A pull request that met its entry would leave two actions differing. | The author's read of the model. | The entry was written from the backlog's words. | The entry names the three. None. |
| 12 | The section put two pull requests with no milestone evidence into the milestone and gave no order by distance from the exit test. | The record contradicted two rules of AGENTS.md without saying so. | Nothing. | No check reads the section against AGENTS.md. | The section says why both are there and that neither is on the path, and the order is stated. None. |
| 13 | The record left open whether the workflow stays on after the end sample. Under a one day window the next purge deletes units whose lookups the receipt needs. | The checker refuses the week for missing periods. | The checker's cases. | The well-formed receipt holds its lookups, and no case takes them late. | Line 47 turns the workflow off at the end sample. None beyond the rule. |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review, by reading and by probes of the checker and of the libSQL driver | 13 | No |
| This project's machinery | 0 | Yes |

Self-catch rate: 0 of 13, or 0% (previous round, PR5.5's: 0 of 18, or 0%). The rate is not improving. The document cases and the two lints that read BUILD.md passed before the review and pass after it.

## Recurrence

An exit test line that says more than its named cases hold recurred, in findings 1 to 4. The record of the operable alpha, written by PR5.0, met it in 21 findings, and every later round corrected lines after they were built. The answer each time was to reword the line. Nothing reads a line's promise against its cases, so the class will recur in the next record.

A second copy of one list recurred, in finding 6: the checker's kinds beside the CLI's. PR5.4's findings 9 and 14 and PR5.5's finding 8 name the class. This time the copy is given a mechanism, in PR5.6, because the list is about to change.

A plan that does not hold main still under a long run, findings 5 and 13, is new. No earlier milestone had a step that lasts a week.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A reworded exit test line (findings 1, 3, 7 to 12) | None: prose | Any sentence. The document cases read headings and a few quoted strings, and a line that names a case that does not exist passes them. Written and run: the line as first worded passed every case that reads BUILD.md. |
| One definition of the kinds of a store's failure, switched on by each consumer (finding 2) | 1, when PR5.6 builds it | A consumer written after it that tests `instanceof` and does not switch. Typecheck does not refuse it. Not built here, so not run. |
| A case that reads the windows from the committed receipt (finding 4) | 2, when PR5.8 builds it | A week whose variables were changed between two purges and changed back, if the case reads one report. The line asks for every report. Not built here, so not run. |
| Main changes no document the receipt holds (finding 5) | None: a rule | A merge that renames a member. CI passes it, because the case that hands the checker what the CLI prints is updated in the same merge. |

## Fix-induced defects

None is known, and nobody has looked: the fold that answers the 13 was read by its author and by no review. It is a document, it was tested by the cases that read BUILD.md, and those cases held none of the 13.

## Evidence

- Red tests: none of its own. The change is one document, and no case reads the sentences that changed.
- Fixes: commit `aaa2d89`; gate after fix: the cases that read BUILD.md, the deferral lint and the gate lint pass.
- Finder: the one review of the branch's first commit, quoted verdict: "13 findings: none HIGH, six MEDIUM, seven LOW."
- What the review ran: a probe of the checker over the well-formed receipt printed ACCEPTED for a week purged under 30 day windows, for a failed window on every daily purge, and for a cancelled window of 100 years. The same receipt without the lookups of periods 120 to 143 printed `REFUSED periods-missing (144 of the 168 periods ...)`. A loopback HTTP responder answering 401, 403 and 503 gave the libSQL driver's error one code, `SERVER_ERROR`, for all three, with the status on the error's cause.
- Claims that did not reproduce: none. The review listed six sentences it checked and found true, among them that the workflow enqueues only the current hour's key and that `purge` takes `1d`.

## Root cause

A plan is written before its code, so nothing can run it. The record's sentences were checked by the one who wrote them against the documents, and the review checked them against the code and the checker. Every finding came from reading a sentence beside the file it speaks of: an executor, the workflow, the checker. The project has cases that read documents, and each holds a string or a count to a value. None holds a promise.

## Mechanisms

Built in this PR:

- None that is a check. The record's lines now name the cases that will hold them.

Deferred (recorded in BUILD.md):

- One definition of the kinds of a store's failure in core, with each consumer switching on it, and a case that holds the checker's kinds to the CLI's. Exit test line 45 requires both of PR5.6.
- A case that runs the checker on the committed receipt and reads every purge report's windows. Exit test line 47 requires it of PR5.8.

## What this round still would not catch

An exit test line that promises more than its cases hold would be merged today, as this one nearly was. A step of a long run that depends on main standing still would be written into a plan with no check. And the fold of this round is unread: a sentence it added that is false of the code would ship in this record.
