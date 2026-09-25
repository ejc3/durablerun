# Postmortem: the operable alpha milestone record (PR5.0)

The pull request records the operable alpha milestone in BUILD.md: exit test lines 32 to 44, the maintainer's receipt M1, the order of the pull requests that build it, the non-goals, and what is held for the maintainer. It changes documents only. Its one review found four MEDIUM and thirteen LOW findings, and the one narrow re-review of the fold found four MEDIUM and ten LOW. Twenty-one are counted: each is a sentence that is false against the code or against another line of the record, a check that could not fail or could never pass, or a command that exits 2 as written. No code changed, so nothing a user runs was wrong, but every exit test line is a specification a later pull request builds to, and a false line becomes a false test or a leak in that pull request.

**This document is adversarial toward the MACHINERY and blameless toward people.** The question in each section is what would have made the sentence unwritable, or caught it without a person reading.

## Severity

The worst finding is the re-review's first. After the fold, line 33 let the CLI print the message of a failed rollback's error when its name was one of the SDK's two halt names. A rollback that throws an error of the same name is stored in exactly the same shape as the halt, so PR5.3a, building to that line, would have printed user-authored text without `--reveal`, from a tool whose credential is full admin over the store. Next in weight: line 44 first passed with two empty purge sets, and after the fold it asked for a test-only way past a safety floor in published @durablerun/core that line 42 says does not exist. The fault surface of line 34 described a store outage where the fault matrix raises SimCrash, so its PR5.3a red could not fail. The rest would have left later pull requests building to lines that contradict each other, commands that exit 2 when copied, and a gate that never opens if the maintainer refuses.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Line 34 called the fault surface's first kind a store outage and one of the fault matrix's kinds, where the matrix's crash-before is SimCrash, and gave crash-after and duplicate no declared exit (first review, finding 1, MEDIUM) | PR5.3a's red could not fail, and two faults had no expected result | Reading the line against the fault matrix and the SimWorld header | The line was written from the design, which ran no code | None. Line 34 states the three faults at the executor and each one's exit |
| 2 | Line 41 listed the terminal paths by hand and left out `fail-rollback` (first review, finding 2, MEDIUM) | The line could be met without checking the stamp a saga's end writes | A list generated from `TERMINAL_BATCH_LABELS` | The line is prose; nothing compares it with the constant | None now. The line requires the cases to be generated from that list |
| 3 | Line 44's purge on alpha.1 rows passed when both sets were empty (first review, finding 3, MEDIUM) | The purge verb and its oracle could pass having removed nothing | A floor in the line | Nothing reads a line for vacuity | None. The line requires a non-empty set holding each terminal state alpha.1 reached |
| 4 | Lines 37, 40 and 42 assumed approvals the Held paragraph keeps for the maintainer, and the PR5.2 entry called the PR3.3 constraint relaxed (first review, finding 4, MEDIUM) | Three pull requests would build to decisions not made | Reading the lines against the Held paragraph | No check relates two paragraphs of the record | None. The Order paragraph gates the three pull requests |
| 5 | Receipt M1's cron command had no `--queue` or `--target`, which line 38 requires (first review, finding 5, LOW) | The command exits 2 as written | A parse of every quoted command by the CLI's parser | The parser does not exist yet | None now; deferred below |
| 6 | Line 32 asked the v5 fixture to print what the current version prints, which `doctor`'s recorded version cannot (first review, finding 6, LOW) | A check that could never pass | Reading the line against the design's `doctor` output | Prose | None. The line exempts that field |
| 7 | Lines 32 and 38 held every verb to rules for verbs that open a store, which `help` and `tick` do not (first review, finding 7, LOW) | Two checks that could never pass for two verbs | Reading each rule against the command list | Prose | None. Both rules are scoped |
| 8 | Line 34 declared exit 6 safe to repeat for every verb, which is false for `selftest` (first review, finding 8, LOW) | A check that could never pass for one verb | Reading the rule against line 44's `selftest` | Prose | None. See finding 18 for its repair |
| 9 | The Status paragraph said the repository's work ends at line 44, which contradicts PR5.5 in the Order paragraph (first review, finding 10, LOW) | A reader is told two endings | Reading two paragraphs together | Prose | None. The milestone ends when lines 32 to 44 are met, which PR5.5 records |
| 10 | Line 33's sentinels left out the SDK's two rollback halt names, whose messages embed a step key (first review, finding 11, LOW) | A user-authored value could print unguarded | Reading the line against the SDK's halt writer | Prose | None. Its first repair was wrong; see findings 14 and 15 |
| 11 | The non-goals gave the event lock's reason to the retention of caller events too (first review, finding 12, LOW) | A wrong reason recorded for a non-goal | Reading the sentence against the design | Prose | None. Each item has its own reason |
| 12 | The record said alpha.1's `migrate()` refuses any version but 5, where at the tag it migrates versions 0 to 4 up to 5 (first review, finding 14, LOW) | A false account of the tag's behaviour in the migration item | Reading the tag's admin.ts | Prose | None. The item says what the tag does |
| 13 | The pull request body said the deferral lint reaches the new section's text and miscounted the departures (first review, finding 15, LOW) | The body claimed a check that does not run | Reading the lint's source | The body is prose | None. The body states the lint's reach |
| 14 | After the fold, line 33 printed an SDK halt's message with step keys redacted, but a user's rollback error of the same name is stored in the same shape (re-review, finding 1, MEDIUM) | A renderer built to the line prints user-authored text without `--reveal` | Reading the SDK's `haltFailure` beside core's `taskFailureJson` | The fold carried the ruling's wording into the record without reading the two writers | None. A failed rollback's error is redacted whole; its name prints only when it equals a halt name |
| 15 | After the fold, line 33 planted a sentinel in a step key, but a step key is a checkpoint name, which prints (re-review, finding 2, MEDIUM) | A check that could never pass for `checkpoints`, and a key in a message would need a quote parser | Reading the SDK's checkpoint naming and PR5.3a's checkpoint view | Same as finding 14 | None. Step keys print, and the decisions list says so |
| 16 | After the fold, line 44 passed the purge floor through a test-only policy on core's entry, while line 42 says core refuses any window under 3,600 seconds (re-review, finding 3, MEDIUM) | Two lines contradict each other, and the verb never ran on alpha.1's rows | Reading alpha.1's clock at the tag | The fold wrote the ruling's mechanism without checking whether alpha.1 honours a fake clock; it does | None. alpha.1 runs under a fake clock set in the past, which is then cleared, and the verb purges |
| 17 | Line 41 said no label's cell from a terminal pre-state moves the stamp, which `retry-task` does (re-review, finding 5, LOW) | A check built to the line fails on `retry-task` | Reading `reviveCas` | Prose | None. The line excepts `retry-task` |
| 18 | After the fold, `selftest`'s repeat class was a fresh queue, which line 34's own repeat check can never accept, and the rule still said every verb (re-review, finding 6, LOW) | A check that could never pass for `selftest` | Reading the carve-out against the check it modifies | Prose | None. The rule says every verb but `selftest`, which is judged by its own output |
| 19 | The Held paragraph and the decisions list still required `--target` on every write, which `tick` never takes (re-review, finding 7, LOW) | The class of finding 7 left in two sentences | A search of the section for the fixed rule's other statements | The fold fixed the instances named, not the class | None. Both sentences are scoped |
| 20 | Receipt M1's daily purge and line 32's `migrate --yes` lacked the flags their verbs require (re-review, finding 8, LOW) | Two more commands that exit 2 as written | Same as finding 5 | Same as finding 5, and the fold fixed only the command named | None now; deferred below |
| 21 | After the fold, the Order paragraph said three pull requests do not merge before the maintainer approves, and then planned for a refusal; it also left out the `fence_at_ms` gate change (re-review, finding 9, LOW) | A gate that never opens if the maintainer refuses | Reading the two sentences together | Prose | None. The pull requests wait for a decision, and a refusal is met by a named docs pull request |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one review of the pull request: the built-in code review skill at medium, run by a subagent, with the reviewer's own checks of each finding | 13 | No |
| The one narrow re-review of the fold, which read the code at the fold's head and ran nothing | 8 | No |
| This project's machinery: lint, format check, typecheck, the deferral lint, the gate lint, the review-bot lint, the counts test and the test that reads BUILD.md, all green on both reviewed heads | 0 | Yes |

Self-catch rate: 0 of 21, or 0% (previous round on main, the closing docs pull request of round two: 0 of 2, or 0%).

Not counted, each because it holds no false claim or is kept as intended: the first review's finding 9, marked plausible, since whether the drill's `--yes` fails depends on a parser PR5.3a has not written (fixed as wording); its finding 13, an omission of the finding query beside a true 14.9 second figure (fixed); its finding 16, since a completed milestone leaves no current heading, so the bound of at most one is kept on purpose (the body says so); its finding 17, whose false sentence was in the author's report and not in the pull request (the record now names PR5.3d); and the re-review's findings 4 (no store credential among the sentinels, an omission the line never claimed to cover; fixed), 10 (a forbidden write left out of the authentication item, an omission; fixed), 11 and 12 (plausible omissions about which delivery's result the CLI receives and what exit 6 means after a commit; fixed), 13 (the queue the redeploy drives was not named, an omission; fixed) and 14 (this postmortem, process).

## Recurrence

One class holds all twenty-one: a sentence of the record that is false against the code, against another sentence, or against a rule of the record itself, in prose no check reads. The closing docs postmortems of the last two rounds (`postmortems/followups-last-docs-review.md` and `postmortems/closing-docs-round-two-review.md`) record the same class, and nothing has been built against it, so no earlier mechanism failed here.

Within the round the class recurred after its own repair twice. Findings 19 and 20 are findings 7 and 5 again: the fold fixed the sentence the review named and did not search the section for the same rule or the same kind of command elsewhere. Findings 14, 15, 16 and 21 are new text the fold wrote from the fold's instructions, and the instructions had not been read against the code either (the SDK's halt writer, the SDK's checkpoint names, alpha.1's clock).

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The counts test, `packages/conformance/test/design-counts.test.ts`, and the test that reads BUILD.md, `packages/conformance/test/tla-artifact.test.ts` | 2, syntactic: the first holds marked numbers in DESIGN.md to the code, the second pins the milestone heading and two phrases | The fold's head `cd39345` passed both files, 21 tests in 2 files, while holding every one of the re-review's findings |
| The deferral lint | 2, syntactic: it reads the first line of an entry and of a bullet for words of deferral | The same head passed it. The new section holds no bullets, so it reads none of the section's text |
| A person's reading of the record against the code | none | The fold was committed at `cd39345` with findings 14 to 21 in its text, after the author's own read of the section |

## Fix-induced defects

Five of the twenty-one: findings 14 and 15 came from the repair of finding 10, finding 16 from the repair of finding 3, finding 18 from the repair of finding 8, and finding 21 from the repair of finding 4. The fold was re-reviewed as new text by the narrow re-review, which is how all five were found. This fold is not re-reviewed, as the plan's cap on review rounds says.

## Evidence

- Red tests: none of its own, and this line cites no commit.
- Fixes: commit `c50cdda` for findings 1 to 4.
- Fixes: commit `cd39345` for findings 5 to 12, and the pull request body for finding 13.
- Fixes: commit `8306dd5` for findings 14 to 21, and for the re-review's uncounted findings 4 and 10 to 13.
- Finder: the one review of the pull request, quoted verdict: "It reported 15 findings. I confirmed 4 MEDIUM and 10 LOW (two of the LOW as plausible rather than certain), and refuted 1 LOW with evidence." The reviewer added three LOW findings of its own, which makes seventeen.
- Finder: the narrow re-review of the fold, quoted on its first finding: "A renderer built to this line would print that user-authored message without --reveal."
- The re-review's evidence for finding 16, which this fold checked at the tag v0.1.0-alpha.1: alpha.1's `NOW_MS` in packages/store-libsql/src/time.ts reads the `fake_now_ms` meta row before the wall clock.
- Claims that did not reproduce: the first review refuted one of its skill's findings, that the design does not say PR5.2a merges after PR5.3d; the design's PR5.2a scope says it does. The re-review's plausible findings 11 and 13 were each confirmed by reading code: PR5.3a's fault injection on its branch resolves a duplicate with the second delivery's result, and the example host reads one queue from `DURABLERUN_QUEUE`. Its finding 10's libSQL half follows from the executor's map and was not produced from a live server.

## Root cause

The record is prose that states what code at a named commit does and what commands that do not yet exist will accept, and every layer that reads BUILD.md reads a heading, a first line or a marked number. The review found the false sentences; the fold then repaired each named sentence and wrote its new sentences from the fold's instructions, so a class named once was left in other sentences, and an instruction that was itself unchecked became a false line.

## Mechanisms

Built in this PR:

- None. The pull request changes documents only, and the sentences are corrected.

Deferred (recorded in BUILD.md):

- None is recorded by this pull request. Once PR5.3a's command table and parser exist, a test that parses every `pnpm cli` command BUILD.md and DESIGN.md quote with that parser would catch findings 5 and 20 at rung 2; it is offered to the coordinator for PR5.3a rather than written into the record, because this fold is limited to the review's findings. A check that compares a sentence with the code it describes has no owner beyond the option recorded under the counts test's entry.

## What this round still would not catch

A sentence of the milestone section that states what the engine, the SDK, alpha.1 or a future verb does, and differs from the code or from another line, would ship today: no check reads the prose, and each line is tested only when the pull request that owns it builds its test. A command quoted in the record that the CLI will refuse would ship until the CLI's parser exists and something runs it on the record.
