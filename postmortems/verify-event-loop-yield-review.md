# Postmortem: the verify event-loop yield, review round 1 (PR #45)

PR #45 stops the `verify` job failing on runs in which every test passed. It adds a timer yield after every test of the conformance file, a regression test for it, one root vitest configuration, and a BUILD.md entry. It changes no engine code. One Fable review ran the change's own claims and found no blocking defect and three low ones. A fourth was ours, found by an exhibit written while folding the first. All four are fixed.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing here could lose or misattribute durable state. The cost is to the gate's credibility.

- **A regression test that fails for a reason other than the one it names.** Selected alone by name, the assertion test ran without the three tests it measures and failed. A developer bisecting by name, or a mutation run that targets tests by title, would have read a red that says nothing about the event loop.
- **A plan entry stronger than its evidence.** BUILD.md said the mechanism was measured, and one link of it was an estimate.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The regression test's verdict was a fourth test. Run alone with `-t "is not one stall"`, the three blocking tests are skipped and it fails with "expected 0.69 to be greater than 400" | A red that is about test selection and not about the event loop | The author's controls on the new test | The controls asked whether the test could PASS for the wrong reason, a monitor that never ticks, and never whether it could FAIL for one | The verdict is the suite's `afterAll`. No fourth test exists to select, one blocker selected alone passes, and a name that matches nothing skips the suite (rung 1: the selectable test is gone) |
| 2 | BUILD.md's PR3.13 said "the mechanism is measured" over a link that was estimated, that a CI runner is slow enough to push the stretch past a minute, and gave "about 20 seconds on CI" with no source | The plan overstates what is known about the failure it records | Nothing checks a plan entry's claims against evidence | No such checker exists, and the author wrote the entry from memory of the investigation | The entry now separates measured from estimated, cites five CI timings of 16.2 to 22.3 seconds, and says the run with the slowest timing passed (text, no mechanism) |
| 3 | BUILD.md said the nightly fuzz shards "were not measured" and did not say that the yield cannot help them: each shard is one test with a 600 second budget | A reader would take the shards as covered by the same fix | The same | The same | The entry says so, records that eleven of twelve nightly runs passed and the twelfth failed in TLA, and gives the fix's shape if the failure appears (text, no mechanism) |
| 4 | The test's upper bound, 1200 ms, admitted a helper that yields after every second test: two chained 600 ms tests are 1200 | A yield that works half the time would pass | The bound's own derivation | It was set from the red and green values, 1757 and 600, and not from the smallest chain it must refuse | The bound is 900, between one test and two. Run, the every-second-test helper fails with "expected 1156.79 to be less than 900" (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| One Fable review over `9aa3b30...7ea9ced`, its own runs | 3 | no |
| A false-negative exhibit written while folding finding 1 | 1 | yes |

Self-catch rate: 1 of 4. The defect this PR fixes was itself found by our machinery: CI's `verify` failed and the cause was measured. That is not counted here, because the ledger is about the change under review. The built-in `/code-review` lens did not return inside the time box, so the three review findings come from the reviewer's own runs and reading.

## Recurrence

Finding 1 is a recurrence of the class PR #42's second round named in its finding 13: a check that reads as a verdict for a reason other than the one it names. There the mechanism was a control that separates the causes. Here the author did apply that control, and only in one direction. The test was checked against passing for nothing, with a lower bound that fails a dead monitor, and nobody asked how it could fail for nothing. A control has two directions.

Findings 2 and 3 are a recurrence of the class four of PR #42's seven first-round findings were in: text stated more strongly than its evidence. No mechanism was instituted then, and none is now. What worked was a reviewer asking for the source of each number.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The suite-level verdict with a bound of 900 ms | 3 | One test that never yields. Run: with the yield in place this test passes, and the same probe over the whole conformance file still shows one stall of 17.6 seconds, the libSQL wake-witness test alone. The test proves that a timer can run BETWEEN tests. It says nothing about a stretch inside one test, and BUILD.md records that case as open |
| The timer yield after every conformance test | 3 | A test file that does not call it. Run: the regression test with the call removed fails at 1757 ms, which is what every other test file in the repository would show if it chained blocking tests. The call is per file on purpose, because only one file was measured to need it |

## Fix-induced defects

None of four. The fold changed one test and two texts, and the restructured test was run in five modes before it was committed.

## Evidence

- Review artifact: a Fable subagent invoking the built-in `/code-review` and `/simplify` skills over `9aa3b30...7ea9ced`, 20 minutes, in the PR's worktree. `/simplify` finished all four lenses. `/code-review` did not return inside the box. Its verdict: "Every measured claim I could test on this branch held up, and I found no blocking defect."
- Quoted: "Selected alone with `-t \"is not one stall\"`, it fails 1 of 1: `expected 0.455 to be greater than 400`", "\"About 20 seconds on CI, a third of the limit\" has no source in the PR body", and "A between-test yield cannot help inside a single test."
- What the review ran and found sound: the test fails at 1757 ms with the yield removed and at 0 with the monitor disabled, 10 of 10 runs pass under sixteen busy loops on a four-core quota, no test depends on the old 5000 ms default, and the repository has no fake timers.
- Finding 1, witnessed at `7ea9ced`: `-t "is not one stall"` exits 1 with "expected 0.69 to be greater than 400". After the fix: whole file passes, no yield fails at 1757, one blocker selected alone passes, a name that matches nothing skips three tests at exit 0, ten runs under load pass. There is no committed red, because the fix removes the test that could be selected.
- Finding 4, run: a helper that yields after every second test fails with "expected 1156.79 to be less than 900". Under the old bound it would have passed.
- Findings 2 and 3, checked: five CI logs time the libSQL wake-witness test at 20686, 16183, 20433, 22288, and 21235 ms, and the nightly workflow's last twelve runs are eleven successes and one TLA failure with no `Timeout calling` line.

## Root cause

The investigation behind this PR was long and corrected itself several times, and the entry and the test were written at its end from what the author by then believed. The test's controls covered the mistake the author had just made, a check that passes for nothing, and not its mirror. The plan entry carried the investigation's conclusion in the investigation's confident voice, and one of its links had only ever been an estimate.

## Mechanisms

- **Built now**
  - The regression test's verdict in the suite's `afterAll`, with a bound derived from the smallest chain it must refuse.
  - A BUILD.md entry that separates measured from estimated and names its open items.
- **Deferred, recorded in BUILD.md**
  - The wake-witness test split into several tests, if it grows.
  - A yield between seeds inside the nightly fuzz shard's loop, if the failure appears there.

## What this round still would not catch

- A stretch inside one test, which no yield between tests can split.
- A test file other than the conformance file that chains blocking tests for a minute. None is known, and only that file runs alone for minutes.
- Any claim in BUILD.md that outruns its evidence. Nothing checks one.
