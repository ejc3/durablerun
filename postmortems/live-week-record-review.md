# Postmortem: the record of the live week milestone, two reviews

The pull request changes one file, BUILD.md. It names the milestone that follows the operable alpha, the live week on the deployed alpha, with three exit test lines, two pull requests outside them, and the decisions made on 2026-11-08 under the maintainer's delegation. Nothing it describes was built when it was reviewed. Two reviews read it, each as a subagent invoking the built-in code review skill. The first read the first commit and found 13 things, none HIGH, six MEDIUM and seven LOW. The second read the fold that answered them, and nothing else, and found 15 more, none HIGH, five MEDIUM and ten LOW. No product code is involved. Every finding is a sentence of a plan: an exit test line that could be marked met with half of it unbuilt, a case that could not be written as worded, or a step of the week that, followed as written, would have cost the week. No review follows the second fold.

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
| 9 | The Held paragraph left out the branch for the selftest and three of the six settings, and stated the second deployment as fact with no decision. | An operator following the paragraph would start the week without a selftest record. | The author's read against receipt M1's paragraph. | Prose held in two places. | The paragraph lists them, and the decision is recorded. None. |
| 10 | Sentences of the completed milestone still called the decisions the maintainer's to make. | Two paragraphs of one file disagreed on who decides. | The author's search. | The search was for the words that changed, not for what they say. | Three sentences corrected. DESIGN.md's is PR5.6's. None. |
| 11 | PR5.7 was scoped to a suspension. The model differs from the code at a chain and a completion too. | A pull request that met its entry would leave two actions differing. | The author's read of the model. | The entry was written from the backlog's words. | The entry names the three. None. |
| 12 | The section put two pull requests with no milestone evidence into the milestone and gave no order by distance from the exit test. | The record contradicted two rules of AGENTS.md without saying so. | Nothing. | No check reads the section against AGENTS.md. | The section says why both are there and that neither is on the path, and the order is stated. None. |
| 13 | The record left open whether the workflow stays on after the end sample. Under a one day window the next purge deletes units whose lookups the receipt needs. | The checker refuses the week for missing periods. | The checker's cases. | The well-formed receipt holds its lookups, and no case takes them late. | Line 47 turns the workflow off at the end sample. None beyond the rule. |
| 14 | Second review. Line 47's case of the windows required a null failed window in every purge report. The dry run after the end sample must have a failed window, and a purge the store failed prints none. | The case as worded fails on every receipt the checker accepts. | A run of the case's rule over the well-formed receipt. | The case does not exist yet, and its rule was written from one report. | The line names the reports the case reads and the two it leaves out. None for prose. |
| 15 | Line 46 stated the lost timeout's numbers for one way of joining the two calls, and did not say that which suspension the first pass takes is a race between two store calls. | A red case written from the line could read another instant on a server dialect, and a fix could meet the line and leave the race. | The author's run, which was on libSQL in memory alone. | One run on one dialect showed one outcome of the race. | The line says which joining loses the timeout and that the case fixes the first pass. None for prose. |
| 16 | The fold counted seven last folds with no review after them. By their postmortems all twelve pull requests had one. | Five folds would have stayed unread under the record's own rule. | A search of the postmortems. | The count was taken from the entries of BUILD.md that use the words. | The record says twelve, and every fold but the first record's is read. None for prose. |
| 17 | The section said the week does not need two pull requests and made the week wait for both, one of them with no bound. | Work the record calls evidence-free held the only line bound to the calendar. | Nothing. | The freeze was a rule, and a rule has no cost until it is read against the order. | The workflow runs a pinned commit, which PR5.6 builds, so only PR5.6 comes before the week. Rung 1 for the property that one commit prints every document, when built. |
| 18 | The postmortem said line 45 requires a case that holds the checker's kinds to the CLI's. The line said nothing of the checker. | A pull request built to the line could leave the checker's list as it is. | The author's read of the postmortem against the line. | Nothing reads a postmortem's claim against the line it cites. | The line now requires the case. None for prose. |
| 19 | Line 46 put its check in a harness every test of the SDK runs through. The SDK's tests have no one harness: ten files call the worker directly. | A check in one helper would meet the words and run in a part of the tests. | The author's read of the SDK's tests. | The line was written before the tests were read. | The line names the SDK's generated surface. None for prose. |
| 20 | The two steps the fold added to save the week were in BUILD.md alone. | An operator who follows the README takes the lookups with the workflow on. | Nothing. | No check holds the README's steps to line 47. | PR5.6 is required to put the step in the README. None here. |
| 21 | The freeze of main ran from the start sample to the end sample, and the receipt holds documents printed before and after. | A merge after the end sample could refuse the receipt. | Nothing. | The same as 17. | The pinned commit covers every document. |
| 22 | The postmortem called the class new because no earlier milestone had a step that lasts a week. The first milestone ran seven days under hourly ticks, with a workflow that fetches the same commit. | The answer to the recurrence question was wrong. | The author's read of BUILD.md's first section. | Prose. | Corrected below. None. |
| 23 | The worst finding of the first round was answered by a rule, where the workflow could pin its commit. | AGENTS.md says a rule that asks people to be careful is not a rung. | The prevention ladder, applied to the fold. | The fold was written to the finding, not to the ladder. | The pin. The same as 17. |
| 24 | Line 45 said every command that opens a store exits 4. The command table declares 0 for a read that follows an answered write. | The line contradicted DESIGN.md. | The author's read of the first review's own finding 2, whose third part said so. | The fold answered two parts of three. | The line names the exception. None for prose. |
| 25 | The libSQL case rested on a stand-in server with nothing recorded of what a hosted server answers, and the cases were split by dialect. | A typed status the hosted server never gives. | A measurement. | It had been taken on the same day and was not written into the line. | The line records what was measured, and one conformance case runs through a member of the fixture. None for prose. |
| 26 | The Held paragraph left out what the second deployment needs of the maintainer, and the non-goals misnamed that deployment. | The paragraph understated what is held. | The author's read of the example's README. | Prose in two places. | Both corrected. None. |
| 27 | Two details of the postmortem did not match the branch: a count of settings, and the commits its fixes line cites. | The attestation's check passed a line that named one of two commits. | The attestation script. | It requires that a fix is cited, not that every fix is. | Corrected below. None. |
| 28 | Three entries the fold did not touch disagreed with it: an option's trigger, and the entries of PR5.6 and PR5.8. | A pull request built to its entry would miss what its line requires. | A search for every place that names the pull request. | The fold changed the lines and not the entries that repeat them. | The three corrected. None for prose. |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The first review, by reading and by probes of the checker and of the libSQL driver | 13 | No |
| The second review, of the fold alone, by reading and by probes of the checker, the SDK and the CLI | 15 | No |
| This project's machinery | 0 | Yes |

Self-catch rate: 0 of 28, or 0%: 0 of 13 in the first round and 0 of 15 in the second (previous round, PR5.5's: 0 of 18, or 0%). The rate is not improving. The document cases and the two lints that read BUILD.md passed before each review and pass after it.

## Recurrence

An exit test line that says more than its named cases hold recurred, in findings 1 to 4. The record of the operable alpha, written by PR5.0, met it in 21 findings, and every later round corrected lines after they were built. The answer each time was to reword the line. Nothing reads a line's promise against its cases, so the class will recur in the next record.

A second copy of one list recurred, in finding 6: the checker's kinds beside the CLI's. PR5.4's findings 9 and 14 and PR5.5's finding 8 name the class. This time the copy is given a mechanism, in PR5.6, because the list is about to change.

A plan that does not hold main still under a long run, findings 5 and 13, is not new, though the first version of this section said it was. The first milestone BUILD.md records ran for seven days under hourly ticks, and its workflow fetches the commit of the run as the week's does. No round named the class then, because nothing was merged that changed what that run printed. The mechanism it gets now is the pinned commit.

The second round is recurrence inside one pull request, as it was in every pull request of the operable alpha that had a second round. All 15 findings are in sentences the fold wrote or in sentences the fold left disagreeing with what it wrote. Findings 14, 18, 24 and 27 are a correction held to the thing the finding named and not to everything the sentence says. Finding 23 is the prevention ladder not applied to the fold's own answers: the worst finding got a rule.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A reworded exit test line (findings 1, 3, 7 to 12) | None: prose | Any sentence. The document cases read headings and a few quoted strings, and a line that names a case that does not exist passes them. Written and run: the line as first worded passed every case that reads BUILD.md. |
| One definition of the kinds of a store's failure, switched on by each consumer (finding 2) | 1, when PR5.6 builds it | A consumer written after it that tests `instanceof` and does not switch. Typecheck does not refuse it. Not built here, so not run. |
| A case that reads the windows from the committed receipt (finding 4) | 2, when PR5.8 builds it | A week whose variables were changed between two purges and changed back, if the case reads one report. The line asks for every report. Not built here, so not run. |
| Main changes no document the receipt holds (finding 5), as the first fold answered it | None: a rule | A merge that renames a member. CI passes it, because the case that hands the checker what the CLI prints is updated in the same merge. The second fold withdrew the rule for this reason. |
| A repository variable that pins the commit the week's workflow runs (findings 17, 21 and 23) | 1, when PR5.6 builds it | A variable changed in the middle of the week. Nothing in the receipt names the commit that printed a document, so the checker accepts a week printed by two commits. Not built here, so not run. |

## Fix-induced defects

All 15 findings of the second round are in the first fold: sentences it wrote, or sentences it left disagreeing with what it wrote. The first fold was read as new text by the second review, which is how they were found. The second fold, which answers the 15, was read by its author and by no review. It is a document, it was tested by the cases that read BUILD.md, and those cases held none of the 28.

## Evidence

- Red tests: none of its own. The change is one document, and no case reads the sentences that changed.
- Fixes: commit `aaa2d89` for the first round, with `9f21925` before it, which holds the sentence on the checker that answers finding 6, and commit `cc16dc6` for the second round; gate after each: the cases that read BUILD.md, the deferral lint and the gate lint pass.
- Finder: the review of the branch's first commit, quoted verdict: "13 findings: none HIGH, six MEDIUM, seven LOW." The review of the fold, quoted verdict: "15 findings: none HIGH, five MEDIUM, ten LOW."
- What the review ran: a probe of the checker over the well-formed receipt printed ACCEPTED for a week purged under 30 day windows, for a failed window on every daily purge, and for a cancelled window of 100 years. The same receipt without the lookups of periods 120 to 143 printed `REFUSED periods-missing (144 of the 168 periods ...)`. A loopback HTTP responder answering 401, 403 and 503 gave the libSQL driver's error one code, `SERVER_ERROR`, for all three, with the status on the error's cause.
- What the second review ran: the rule of line 47's case over the well-formed receipt failed on the dry run (`failedSeconds 3600`), and the same receipt with a null failed window in the dry run printed `REFUSED malformed`. A probe of the SDK under its fake clock showed the lost timeout for the two calls under one `Promise.all` and showed nothing lost for `const s = ctx.sleepFor(100); await ctx.awaitEvent(...); await s`. With the await's store call held one turn, both orders gave a timeout at 130 seconds and no wake lost.
- Claims that did not reproduce: none. The review listed six sentences it checked and found true, among them that the workflow enqueues only the current hour's key and that `purge` takes `1d`.

## Root cause

A plan is written before its code, so nothing can run it. The record's sentences were checked by the one who wrote them against the documents, and the review checked them against the code and the checker. Every finding came from reading a sentence beside the file it speaks of: an executor, the workflow, the checker. The project has cases that read documents, and each holds a string or a count to a value. None holds a promise.

## Mechanisms

Built in this PR:

- None that is a check. The record's lines now name the cases that will hold them.

Deferred (recorded in BUILD.md):

- One definition of the kinds of a store's failure in core, with each consumer switching on it, and a case that holds the checker's kinds to the CLI's. Exit test line 45 requires both of PR5.6.
- A repository variable that pins the commit the week's workflow runs. Exit test line 47 requires it of PR5.6.
- A case that runs the checker on the committed receipt and reads every purge report's windows. Exit test line 47 requires it of PR5.8.

## What this round still would not catch

An exit test line that promises more than its cases hold would be merged today, as this one nearly was twice. A week printed by two commits would be accepted, because no document names the commit that printed it. And the second fold is unread: a sentence it added that is false of the code would ship in this record. Two rounds found 13 and then 15, and the second number is not smaller than the first.
