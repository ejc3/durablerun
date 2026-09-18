# Postmortem: the verify event-loop yield, the review's late lens (PR #45, fixed in its follow-up)

PR #45 stopped the `verify` job failing on runs in which every test passed, and merged with four findings recorded. Its review's built-in `/code-review` lens had not returned inside the time box. It returned an hour later with eight more findings, none a blocker and several better than the change they reviewed. PR #45 had three pull requests queued behind it and was correct as measured, so it merged, and this follow-up folds all eight. Every one was found by review. None was ours.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing here could lose or misattribute durable state. The cost is a gate that can go red for nothing, and a record that says more than was known.

- **The longest stretch in the repository was not the one PR #45 named.** A nightly fuzz shard is one test. Measured here at the nightly's batch size, its worker went 43.6 seconds without its event loop turning, and the yield PR #45 added between tests cannot reach inside one test.
- **The fix could be deleted with every test green.** PR #45's regression test installed the helper on itself, so removing the helper's call from the conformance file left the whole suite passing.
- **A misspelled key in the new root config would have silently restored the old timeout.** Run here: with `testTimeout` written `testTimout`, a test saw 5000 ms, vitest printed nothing, and `pnpm typecheck` passed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The nightly fuzz shard, not the wake-witness test, is the longest stretch that never yields, and BUILD.md said the shards "were not measured" while `nightly.yml` says its batches keep every process under vitest's worker deadline | The nightly can fail with every test passing, and the plan did not know the deadline was already budgeted for | The investigation behind PR #45 | It measured the file that had failed and stopped there. It never read `nightly.yml` | The yield moves into `makeLibsqlFixture`, which every fuzz walk passes through. A nightly-sized batch goes from one stall of 43.6 seconds to none of two seconds or more. BUILD.md says the deadline was known (rung 1: the yield sits at the one door, with no call to forget) |
| 2 | Nothing guarded the helper's call in `libsql.test.ts` | Delete the call and the 48.9 second stretch returns with every test and lint green | PR #45's regression test | It tested the helper, which it installed on itself, and not the wiring | The call no longer exists. `fixture-libsql-yields.test.ts` builds a fixture through the factory and fails if the factory does not yield (rung 1 for the wiring, rung 3 for the line) |
| 3 | PR #45's regression test asserted on a duration and shared state between tests, two shapes `.github/review-bot-rules/test-determinism.md` flags, and the fold of its own review tightened the bound from 1200 ms to 900, which cut its headroom from about 640 ms to about 340 | A test that can fail on correct code under one scheduling pause | The repository's own rule | The rule is prose for review bots and reviewers. The author did not read it, and nothing else enforces it | The test is replaced by one that arms a zero-delay timer, builds a fixture, and asks whether the timer fired. It measures no duration and shares no state (rung 3) |
| 4 | `hookTimeout` stayed at vitest's 10 seconds while the PostgreSQL fixture is created and dropped in hooks | The same runner load that pushed a test past 5 seconds can time a hook out | The reasoning behind the root config | It followed the one failure seen, a test body, and not the class, PostgreSQL work under load | `hookTimeout` is set beside `testTimeout`. Nobody measured a hook, and the commit says so (rung 3) |
| 5 | Raising `testTimeout` to 30 seconds loosened a cap the old default also provided: vitest fails a test that never yields once it finishes late. Run here, a test that blocks for 6 seconds fails under the 5 second default | A blocking libSQL test could grow toward the worker deadline with nothing objecting | The same | The author saw the timeout as a margin for slow tests and not also as a cap on blocking ones | 15 seconds: three times the slowest PostgreSQL test seen, and under the 60 second deadline at two and a half times the runner's speed (rung 3) |
| 6 | The commit message, the helper's comment, and PR #45's body said two registered mutations own the loop in `bindStoreConformanceSurfaces`. There are five | A wrong count in the permanent record, with the design conclusion unaffected | The author's count | It came from a hand-written parser of the registry that missed entries, the second such undercount that day | The helper and its comment are deleted. Counted again with `grep -c` against the raw text: five find lines, five mutant lines (no mechanism beyond counting against ground truth) |
| 7 | The regression test's 100 ms sleep did nothing once a yield ran after each test, and is the rule's "real sleep standing in for a wait" | Dead code with a comment describing a need the code no longer had | The same rule as finding 3 | The same | Deleted with the test |
| 8 | PR #45's body declined to type-check the root config because "vitest loads it at the start of every run, where a broken config fails everything at once". A misspelled key loads in silence | A written reason that was false for the likeliest mistake | The author's claim, which was never run | It described a syntax error and was stated of every error | `tsconfig.vitest.json` includes the file and `pnpm typecheck` runs it. Run, `testTimout` and `hookTimout` each fail with TS2769 (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The built-in `/code-review` lens of PR #45's review, returning after the time box, with a verifier's runs | 8 | no |

Self-catch rate: 0 of 8. PR #45's first round was 1 of 4. The investigation that found the failure's mechanism was careful about its instruments and corrected itself many times. None of that care was spent on the question the review asked first: where else does this happen.

## Recurrence

Finding 3 is a rule that exists as prose. The repository wrote down, with examples, that a test must not assert on a duration or read state another test wrote, and the author wrote a test that did both the same day. A rule only a reviewer enforces is enforced when a reviewer arrives.

Finding 6 is an instrument error that recurred within hours. A regular expression written to parse registry entries missed the ones that carry a comment line, once while counting the entries that own a loop and once while taking an inventory for part 3. The second time a positive control caught it. The first time there was none, and the count went into a commit message.

Finding 8 is the class PR #42's round named: text stated more strongly than its evidence. There it was a plan entry. Here it was the reason given for declining a review point, which is the text least likely to be run.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The yield in `makeLibsqlFixture`, held by `fixture-libsql-yields.test.ts` | 1 and 3 | A test that builds one fixture and then loops without yielding. Run: with the yield in place and that test green, the probe over the whole conformance file still shows one stall of 15.7 seconds, the libSQL wake-witness test on its single fixture |
| The root config under tsc | 2 | A correctly spelled key with a wrong value. Run: `testTimeout: 150_000` typechecks at exit 0. The type knows the keys and not the numbers |
| The 15 second cap on a test with no timeout of its own | 3 | A blocking test that declares a larger timeout. Run: the wake-witness test declares 120 seconds, blocks for 15 to 22, and passes. The cap binds only tests that do not ask for more |

## Fix-induced defects

One of eight. Finding 3's second half, the tightened bound, was introduced by the fold of PR #45's own first round. It made the test stricter against one false negative and more fragile against scheduling noise, and the late lens measured a 600 ms block taking 798 ms under contention.

## Evidence

- Review artifact: the built-in `/code-review` skill, invoked by PR #45's Fable reviewer over `9aa3b30...7ea9ced`, with finder agents and one verifier. It reported 5 confirmed findings, 6 plausible, and 1 refuted, after the reviewer's 20 minute box. The reviewer's updated verdict: "The PR does what it says for the `verify` job, and nothing here blocks it. Two items deserve attention before it is called done."
- Quoted: "the nightly fuzz test, not the wake-witness test, is the longest stretch that never yields", "Deleting the call leaves every test and lint green", "A root config with `testTimeout` misspelled as `testTimout` loads with no warning", and "There are five."
- Finding 1, measured here: `FUZZ_SEEDS=20000 FUZZ_STEPS=150 FUZZ_BATCHES=4 FUZZ_BATCH_INDEX=0` on `fuzz-01.test.ts`, 157 walks, one stall of 43,616 ms before and none of 2 seconds or more after. The whole conformance file, 5978 of 5978 passing each time: longest stall 48,928 ms on main, 17,586 with PR #45's helper, 15,718 with the yield in the factory.
- Findings 2, 3, and 7. Red: commit `5136c37`, the new test fails with "expected false to be true": building a libSQL fixture never lets a pending timer fire. Green: `20312b2`, five runs of five.
- Findings 4, 5, and 8: commit `ba213c6`. Witnessed red: with `testTimout`, `pnpm typecheck` exits 0 on the old tree. After: each of `testTimout` and `hookTimout` fails with TS2769, the correct file passes, a test sees `task.timeout` of 15000, and the same 120 test files are discovered. Finding 5's premise, run: a test that blocks for 6 seconds fails with "Test timed out in 5000ms" under the default, and one that blocks for 2 passes.
- Finding 6, counted: `grep -c` finds the loop line five times in the registry as a find and five times as a mutant, under `scheduler-`, `fault-matrix-`, `poison-matrix-`, `timestamp-boundary-`, and `wake-witness-conformance-dispatch`.
- A dead end, so it is not retried: importing the root config from a conformance test, to put it in that package's tsc program, fails with TS6059 because the file is outside the package's `rootDir`.

## Root cause

PR #45 was written at the end of a long measurement of one failing file, and it fixed that file where the measurement pointed. The review asked three questions the measurement never had: where else does a worker go a minute without turning, what would notice if this fix were deleted, and what does the repository already say about tests like this one. Each had an answer in the repository: `nightly.yml`, the test's own imports, and a rule file.

## Mechanisms

- **Built now**
  - One timer yield in `makeLibsqlFixture`, in place of a helper a test file has to remember to call.
  - A regression test with no duration in it, which fails if the factory stops yielding.
  - The root vitest config under tsc, and both timeouts at 15 seconds.
- **Deferred, recorded in BUILD.md**
  - The wake-witness test split into several tests, if it grows.
  - `verify:fuzz:deep`, whose shards are one test of about 3,125 walks and exceed their own 600 second budget. It runs in no gate.

## What this round still would not catch

- A libSQL test that builds one fixture and loops for a minute.
- A wrong number in the root config, as opposed to a wrong key.
- A test that breaks a rule which only review reads.
