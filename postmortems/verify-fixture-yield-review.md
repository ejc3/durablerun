# Postmortem: the verify event-loop yield, the review's late lens and the follow-up's own review (PR #45, fixed in PR #46)

PR #45 stopped the `verify` job failing on runs in which every test passed, and merged with four findings recorded. Its review's built-in `/code-review` lens had not returned inside the time box. It returned an hour later with eight more findings, none a blocker and several better than the change they reviewed. PR #45 had three pull requests queued behind it and was correct as measured, so it merged, and this follow-up folds all eight. The follow-up's own review then found eleven more, findings 9 to 19, and most of them are text that claimed more than the code did. Every one of the nineteen was found by review. None was ours.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing here could lose or misattribute durable state. The cost is a gate that can go red for nothing, and a record that says more than was known.

- **The longest stretch in the repository was not the one PR #45 named.** A nightly fuzz shard is one test. Measured here at the nightly's batch size, its worker went 43.6 seconds without its event loop turning, and the yield PR #45 added between tests cannot reach inside one test.
- **The fix could be deleted with every test green.** PR #45's regression test installed the helper on itself, so removing the helper's call from the conformance file left the whole suite passing.
- **A misspelled key in the new root config would have silently restored the old timeout.** Run here: with `testTimeout` written `testTimout`, a test saw 5000 ms, vitest printed nothing, and `pnpm typecheck` passed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The nightly fuzz shard, not the wake-witness test, is the longest stretch that never yields, and BUILD.md said the shards "were not measured" while `nightly.yml` says its batches keep every process under vitest's worker deadline | The nightly can fail with every test passing, and the plan did not know the deadline was already budgeted for | The investigation behind PR #45 | It measured the file that had failed and stopped there. It never read `nightly.yml` | The yield moves into `makeLibsqlFixture`, which every fuzz walk passes through. A nightly-sized batch goes from one stall of 43.6 seconds to none of two seconds or more. BUILD.md says the deadline was known (rung 1 for every fixture the factory builds, which have no call to forget. Finding 10 is the files that do not use the factory) |
| 2 | Nothing guarded the helper's call in `libsql.test.ts` | Delete the call and the 48.9 second stretch returns with every test and lint green | PR #45's regression test | It tested the helper, which it installed on itself, and not the wiring | The call no longer exists. `fixture-libsql-yields.test.ts` builds a fixture through the factory and fails if the factory does not yield (rung 1 for the wiring, rung 3 for the line) |
| 3 | PR #45's regression test asserted on a duration and shared state between tests, two shapes `.github/review-bot-rules/test-determinism.md` flags, and the fold of its own review tightened the bound from 1200 ms to 900, which cut its headroom from about 640 ms to about 340 | A test that can fail on correct code under one scheduling pause | The repository's own rule | The rule is prose for review bots and reviewers. The author did not read it, and nothing else enforces it | The test is replaced by one that arms a zero-delay timer, builds a fixture, and asks whether the timer fired. It measures no duration and shares no state (rung 3) |
| 4 | `hookTimeout` stayed at vitest's 10 seconds while the PostgreSQL fixture is created and dropped in hooks | The same runner load that pushed a test past 5 seconds can time a hook out | The reasoning behind the root config | It followed the one failure seen, a test body, and not the class, PostgreSQL work under load | `hookTimeout` is set beside `testTimeout`. Nobody measured a hook, and the commit says so (rung 3) |
| 5 | Raising `testTimeout` to 30 seconds loosened a cap the old default also provided: vitest fails a test that never yields once it finishes late. Run here, a test that blocks for 6 seconds fails under the 5 second default | A blocking libSQL test could grow toward the worker deadline with nothing objecting | The same | The author saw the timeout as a margin for slow tests and not also as a cap on blocking ones | 15 seconds: three times the slowest PostgreSQL test seen (rung 3). Finding 16 corrects the margin first claimed here |
| 6 | The commit message, the helper's comment, and PR #45's body said two registered mutations own the loop in `bindStoreConformanceSurfaces`. There are five | A wrong count in the permanent record, with the design conclusion unaffected | The author's count | It came from a hand-written parser of the registry that missed entries, the second such undercount that day | The helper and its comment are deleted. Counted again with `grep -c` against the raw text: five find lines, five mutant lines (no mechanism beyond counting against ground truth) |
| 7 | The regression test's 100 ms sleep did nothing once a yield ran after each test, and is the rule's "real sleep standing in for a wait" | Dead code with a comment describing a need the code no longer had | The same rule as finding 3 | The same | Deleted with the test |
| 8 | PR #45's body declined to type-check the root config because "vitest loads it at the start of every run, where a broken config fails everything at once". A misspelled key loads in silence | A written reason that was false for the likeliest mistake | The author's claim, which was never run | It described a syntax error and was stated of every error | `tsconfig.vitest.json` includes the file and `pnpm typecheck` runs it. Run, `testTimout` and `hookTimout` each fail with TS2769 (rung 2) |
| 9 | The comment at the yield, BUILD.md, and this postmortem said the yield works by letting the loop reach its timers phase, as if any turn of the loop would do | The repository has `Clock.yieldTurn`, which uses `setImmediate`, and the review's own reuse lens proposed swapping it in. Run in a worker thread, nine of nine each way: a stretch that resumes from a timer has the waiting reply handled first, and one that resumes from `setImmediate` meets the deadline first | The investigation's measurements | They compared a yield against no yield, and never one kind of yield against another | The comment states the measured difference and names `yieldTurn` as the wrong tool. Run, five of five: with the swap made, the fixture test fails (rung 3, by timer ordering. How the experiment maps onto vitest's calls is inferred) |
| 10 | The test's comment, BUILD.md, and finding 1 called the factory the one place every conformance test passes through. Eighteen files under test directories open a database through `openTestDb` and never reach it, four of them in the conformance package | A generated matrix built on `openTestDb` could grow into a minute that never yields while the fixture test stays green. The reason the yield cannot live in `openTestDb` was written only in a comment this follow-up deleted | The author's claim, never counted | It was stated from the two callers measured, the conformance file and the fuzz | The wording now names what the factory covers. BUILD.md records the eighteen files and the determinism lint's reason as an open item (no mechanism: the files are small today) |
| 11 | BUILD.md and this postmortem described the wake-witness test as one loop on one fixture. It runs two loops, each on its own fixture | The open item pointed at the costlier remedy, a split that needs mutations re-aimed, when a fixture for each chunk of cases also splits the stretch | The author's reading of the test | The description came from the probe's output, one stall of 15.1 seconds, and not from the test's code | Both texts corrected from `suite.ts` (none beyond reading the code) |
| 12 | The evidence cited three commits by hashes that a rebase had already replaced | After merge the red and green evidence could not be found from main | `scripts/review-attest.sh` | It checks sections and tables and does not resolve hashes | The evidence names commits by subject, which a rebase keeps (none) |
| 13 | The fixture test built one fixture, so it proved only that the first call yields | A cache or an early return above the yield brings the 48.9 second stretch back with the test green, which is finding 2's class again, inside the fix for finding 2 | The test written for finding 2 | It asked whether the factory yields, and not whether it yields every time | The test builds two fixtures. Run: behind a first-call flag, the second build fails with "yields-to-timers-2: expected false to be true" (rung 3) |
| 14 | Nothing failed if the tsc leg over `vitest.config.ts` was dropped from `pnpm typecheck`, and the commit that added the leg had no red test before it | A later misspelled key silently restores the 5000 ms default, which is finding 8 again | gate-lint, or a test | gate-lint does not pin the typecheck script, and no test read the limit | `root-vitest-config.test.ts` reads its own timeout. Run: with `testTimout`, and again with the file moved away, it fails with "expected 5000 to be 15000" (rung 3) |
| 15 | This postmortem did not say whether its fixes were re-reviewed, and did not name the claim the late lens refuted | A later round can raise the refuted claim again | `scripts/review-attest.sh` | It checks that sections exist and are filled, not what they answer | Both written below (none) |
| 16 | The config comment, a commit message, and finding 5 said 15 seconds keeps a blocking test under the 60 second deadline on a runner two and a half times slower. Fifteen times two and a half is 37.5, the limit is measured on the runner the test runs on, vitest fails a blocking test only after it finishes, and every long libSQL test declares a larger timeout | A stated safety margin that the limit does not provide | The author's arithmetic | Nobody computed it | The comment and the commit message claim only what was seen: three times the slowest PostgreSQL test (none) |
| 17 | BUILD.md's 830 seconds could not be derived from anything this record held | A reader computing from the 43.6 second stall gets 868 | The record | The rate, 0.266 seconds a walk, was in the verifier's report and was not copied | BUILD.md and the evidence below state the rate (none) |
| 18 | Tests that build several fixtures now reach the timers phase mid-test, so vitest can time one out mid-loop while its body, which nothing cancels, keeps running into later tests | In a run that is already red, one real timeout can read as several | None | It needs a timeout to happen first | Not fixed. Recorded under what this round would not catch |
| 19 | Two commit messages narrated the review, and one argued the next commit's design | History that describes a conversation in place of a change | The author's reading of his own messages | Nothing checks a commit message | Both reworded, with the tree unchanged (none) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| The built-in `/code-review` lens of PR #45's review, returning after the time box, with a verifier's runs | 8 | no |
| The Fable review of PR #46: the built-in `/code-review` with finder agents, and `/simplify` in report-only mode | 11 | no |

Self-catch rate: 0 of 19. PR #45's first round was 1 of 4. The investigation that found the failure's mechanism was careful about its instruments and corrected itself many times. None of that care was spent on the question the review asked first: where else does this happen.

## Recurrence

Finding 3 is a rule that exists as prose. The repository wrote down, with examples, that a test must not assert on a duration or read state another test wrote, and the author wrote a test that did both the same day. A rule only a reviewer enforces is enforced when a reviewer arrives.

Finding 6 is an instrument error that recurred within hours. A regular expression written to parse registry entries missed the ones that carry a comment line, once while counting the entries that own a loop and once while taking an inventory for part 3. The second time a positive control caught it. The first time there was none, and the count went into a commit message.

Finding 8 is the class PR #42's round named: text stated more strongly than its evidence. There it was a plan entry. Here it was the reason given for declining a review point, which is the text least likely to be run.

The second round is that class five more times: findings 9, 10, 11, 16, and 17 are each a sentence stronger than what was run or read. This is its third round in two days, and the mechanism so far, a reviewer reading the prose, is the last net and not a mechanism. Two of the five now have a test standing where the sentence stood: the fixture test asks about every build, and a test reads the timeout back. The other three are descriptions of code and of arithmetic, and nothing built here checks them.

Finding 13 is finding 2 again, inside finding 2's fix: a test that asks less than the sentence describing it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The yield in `makeLibsqlFixture`, held by `fixture-libsql-yields.test.ts` | 1 and 3 | A test that builds a fixture and then loops without yielding. Run: with the yield in place and that test green, the probe over the whole conformance file still shows one stall of 15.7 seconds, the longer of the wake-witness test's two loops |
| The fixture test asking twice | 3 | A factory that yields on its first two calls only. Run: the test passes |
| `root-vitest-config.test.ts` | 3 | A wrong `hookTimeout`. Run: with `hookTimeout: 150_000` the test passes and tsc exits 0. A test can read its own timeout and not a hook's |
| The root config under tsc | 2 | A correctly spelled key with a wrong value. Run: `testTimeout: 150_000` typechecks at exit 0. The type knows the keys and not the numbers |
| The 15 second cap on a test with no timeout of its own | 3 | A blocking test that declares a larger timeout. Run: the wake-witness test declares 120 seconds, blocks for 15 to 22, and passes. The cap binds only tests that do not ask for more |

## Fix-induced defects

Twelve of nineteen. In the first round, one of eight: finding 3's second half, the tightened bound, was introduced by the fold of PR #45's own first round. It made the test stricter against one false negative and more fragile against scheduling noise, and the late lens measured a 600 ms block taking 798 ms under contention.

All eleven findings of the second round are defects in the code, tests, and text written to fix the first eight. That round is the re-review of those fixes as new code. The fold of the second round was re-tested, with every new test seen failing under the defect it guards, and was not reviewed again.

## Evidence

- Review artifact: the built-in `/code-review` skill, invoked by PR #45's Fable reviewer over `9aa3b30...7ea9ced`, with finder agents and one verifier. It reported 5 confirmed findings, 6 plausible, and 1 refuted, after the reviewer's 20 minute box. The reviewer's updated verdict: "The PR does what it says for the `verify` job, and nothing here blocks it. Two items deserve attention before it is called done."
- Quoted: "the nightly fuzz test, not the wake-witness test, is the longest stretch that never yields", "Deleting the call leaves every test and lint green", "A root config with `testTimeout` misspelled as `testTimout` loads with no warning", and "There are five."
- Finding 1, measured here: `FUZZ_SEEDS=20000 FUZZ_STEPS=150 FUZZ_BATCHES=4 FUZZ_BATCH_INDEX=0` on `fuzz-01.test.ts`, 157 walks, one stall of 43,616 ms before and none of 2 seconds or more after. The whole conformance file, 5978 of 5978 passing each time: longest stall 48,928 ms on main, 17,586 with PR #45's helper, 15,718 with the yield in the factory.
- Findings 2, 3, and 7. Red: the commit "Show that building a libSQL fixture never lets a pending timer fire", where the new test fails with "expected false to be true": building a libSQL fixture never lets a pending timer fire. Green: "Yield to the timers phase where every libSQL fixture is built", five runs of five.
- Findings 4, 5, and 8: the commit "Put the root vitest config under tsc, and set both timeouts to fifteen seconds". Witnessed red: with `testTimout`, `pnpm typecheck` exits 0 on the old tree. After: each of `testTimout` and `hookTimout` fails with TS2769, the correct file passes, a test sees `task.timeout` of 15000, and the same 120 test files are discovered. Finding 5's premise, run: a test that blocks for 6 seconds fails with "Test timed out in 5000ms" under the default, and one that blocks for 2 passes.
- Finding 6, counted: `grep -c` finds the loop line five times in the registry as a find and five times as a mutant, under `scheduler-`, `fault-matrix-`, `poison-matrix-`, `timestamp-boundary-`, and `wake-witness-conformance-dispatch`.
- Finding 1's 830 seconds: the verifier measured a stall equal to the test's duration at 2, 20, and 50 walks, 0.266 seconds a walk, and 3,125 walks at that rate is 831 seconds.
- The late lens's refuted claim: that a 30 second default reaches the mutation probe's 600 second wall six times sooner. Every mutant runs only its registered test behind an anchored `-t` filter, so the residual is about 25 seconds more for a mutant that hangs. It also dropped the worry that a run from inside a package misses the root config: the effective config resolved to the root's from four working directories, with a directory outside the repository as the failing control.
- Second review artifact: a Fable subagent invoking the built-in `/code-review`, with finder agents, and `/simplify` in report-only mode over the four commits of PR #46. The `/code-review` verifier pass was skipped when its time box closed, so every finding was checked here against the code or by a run before it was folded. Its verdict: "The review found no HIGH and no blocking correctness bug" and "The fix works as measured. Most findings are text in BUILD.md, the postmortem and code comments that claims more than the code does."
- Finding 9, run here on Node 22.23.2, three runs of six modes: a worker blocks, sends a call mid-stretch, arms a deadline, and blocks past it. Begun from a timer callback, or after an awaited zero-delay timer, the reply is handled first, nine of nine. Begun from `setImmediate`, or after an awaited one, the deadline fires first, nine of nine. With the factory's yield swapped for `setImmediate`, the fixture test fails five runs of five.
- Findings 13 and 14: the commit "Hold every fixture build and the root configuration, and say why the yield is a timer". Seen failing: behind a first-call flag, "yields-to-timers-2: expected false to be true". With `testTimout`, and with the config moved away, "expected 5000 to be 15000". Restored, both pass, and typecheck, lint, the format check, and the determinism lint exit 0.
- Finding 10, counted: `grep -rl 'openTestDb('` over the packages' test directories lists nineteen files, the factory's own among them as the control.
- Two claims of the second review that did not hold as stated. Its efficiency lens said one `setImmediate` for each fixture would do, which the finding 9 experiment contradicts. Its reuse lens proposed `Clock.yieldTurn` for the same reason. And finding 17's 868 seconds comes from the stall, where the 830 came from the verifier's rate, which this record had not kept.
- A dead end, so it is not retried: importing the root config from a conformance test, to put it in that package's tsc program, fails with TS6059 because the file is outside the package's `rootDir`.

## Root cause

PR #45 was written at the end of a long measurement of one failing file, and it fixed that file where the measurement pointed. The review asked three questions the measurement never had: where else does a worker go a minute without turning, what would notice if this fix were deleted, and what does the repository already say about tests like this one. Each had an answer in the repository: `nightly.yml`, the test's own imports, and a rule file.

## Mechanisms

- **Built now**
  - One timer yield in `makeLibsqlFixture`, in place of a helper a test file has to remember to call.
  - A regression test with no duration in it, which fails if any build through the factory stops yielding, or yields from `setImmediate`.
  - A test that reads the root configuration's timeout back.
  - The root vitest config under tsc, and both timeouts at 15 seconds.
- **Deferred, recorded in BUILD.md**
  - The wake-witness test's longer loop given a fixture for each chunk of cases, or the test split, if it grows.
  - The eighteen files that open a database through `openTestDb` and get no yield.
  - `verify:fuzz:deep`, whose shards are one test of about 3,125 walks and exceed their own 600 second budget. It runs in no gate.

## What this round still would not catch

- A libSQL test that builds one fixture and loops for a minute.
- A file that opens its database through `openTestDb` and grows a minute of tests.
- One timed-out test whose body keeps running into the tests after it, now that a test with several fixtures reaches the timers phase mid-loop. It needs a run that is already red.
- A sentence in BUILD.md or a postmortem that says more than was run.
- A wrong number in the root config, as opposed to a wrong key.
- A test that breaks a rule which only review reads.
