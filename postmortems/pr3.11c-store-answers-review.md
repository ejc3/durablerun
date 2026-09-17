# Postmortem: PR3.11c store answers, review rounds 1 and 2 (PR #36)

PR3.11c makes a worker refuse an activation answer it cannot read, before user code runs, and lets the run recover for a compatible build. Two Fable review rounds found eight defects in that refusal. In round 1, a refused answer ended as a nameless `aborted`. Malformed but present values ran the handler, and an outage at `activate` rejected the pass. In round 2, every defect lived in the first fix itself. The current store's own answer for a 1.001 s lease was refused. A bigint field, or an answer whose infrastructure retries reach its attempt, passed the check and then crashed or ran user code with a non-positive attempt. A throwing getter escaped the check, and a delivered wake saying `timedOut: false` was refused. All eight are fixed. The worker now decodes the answer once into the run it executes.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

- **The current store's lease refused (worst).** A driver claiming with a lease whose milliseconds are not exactly representable after `lease_ms / 1000`, such as 1.001 s, would never run a task. Every claim ends as `incompatible-store`, the sweep charges an infrastructure retry, and the task ends at the infrastructure cap with its handler never run. Of lease lengths 1 to 120,000 ms, 1,472 fail this way.
- **Handlers on answers the worker cannot use.** A zero claim generation, a sub-millisecond lease, an empty retry strategy, a wake without a step, or an answer with `infraRetries >= attempt` ran user code. A non-positive user attempt then makes the retry decision throw after user side effects ran.
- **Unnamed or thrown passes.** A refusal read as a store outage, and a bigint field, a throwing getter, or an outage at `activate` rejected `runClaimedRun`. The inline launcher throws on that, and the worker server swallows it, so the run waits for a lost-launch relaunch.

The fences refuse every write a wrong pass attempts, so no durable state was lost or misattributed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A refused activation answer ended as `aborted`, naming no field (round 1) | A version mismatch reads as a store outage | The store answer surface | It asserted only that no handler ran, not how the pass ended | `incompatible-store` outcome naming the field, pinned by the surface (rung 3) |
| 2 | Present but malformed values ran the handler (round 1) | User code on a zero claim generation, a sub-millisecond lease, an empty retry strategy, or a wake without a step | The store answer surface | It generated only omitted fields | Per-field decoding with the stores' bounds (rung 1). The surface generates malformed values for every read field (rung 3) |
| 3 | An outage at `activate` rejected `runClaimedRun` (round 1) | The inline launcher throws and the server swallows the pass | Store outage handling in the worker | `activate` was the one store call outside `trustedStoreOutcome` | `activate` goes through `trustedStoreOutcome`, pinned by a surface case (rung 3) |
| 4 | The current store's answer for a 1.001 s lease was refused (round 2) | Tasks never run under such a lease and end at the infrastructure cap | The store answer surface | Every case claimed with a 60 s lease, so no fractional lease crossed the check | The lease decodes through whole milliseconds, as the stores derive it (rung 1). The surface claims with 0.001 s, 1.001 s, 2.002 s, and 60 s leases (rung 3) |
| 5 | A bigint integer field passed the check, then the worker threw mixing bigint and number (round 2) | The pass rejects with no field named | The store answer surface | The malformed table held strings, fractions, and negatives, never another numeric type | Integer fields must be numbers (rung 1). The surface sends bigints (rung 3) |
| 6 | `infraRetries >= attempt` passed (round 2) | User code runs with a non-positive attempt, and a failure then throws out of the retry decision | The store answer surface | Every field was checked alone, and the table varied one field at a time | The decoder refuses answers breaking the stores' `attempt = attempts + infra_retries + 1` (rung 1). The surface sends one (rung 3) |
| 7 | A throwing getter escaped the check (round 2) | The pass rejects with no field named | The store answer surface | The surface built answers from plain values | The decoder reads each field inside a try (rung 1). The surface sends a throwing getter (rung 3) |
| 8 | A delivered wake carrying `timedOut: false` was refused (round 2) | A store that tags delivered wakes spends infrastructure retries to the cap | The store answer surface | Its compatible-addition case added fields only at the top level | The wake decodes through own properties and accepts `timedOut: false` (rung 1). A surface case delivers such a wake (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| PR3.11c store answer surface and clock shapes, before review | 0 | yes |
| Fable `/code-review` round 1 over the first refusal | 3 | no |
| Fable `/code-review` round 2 over `5ac6a14...6e6bfaf` | 4 | no |
| Fable `/simplify` round 2 over `5ac6a14...6e6bfaf` | 1 | no |

Self-catch rate: 0 of 8, or 0% (previous round: 0%, `pr3.11b-generated-surfaces-review.md`).

Before review, the store answer surface caught the original defect this PR exists for, a handler running on an answer missing required fields. The eight review-caught defects all sat outside the inputs the surface generated.

## Recurrence

- **Cross-version validation recurred, from presence to values, for the third time.** `pr3.2a-lifecycle-review.md` finding 1 was a launch field an older driver omits. `pr3.11b-generated-surfaces-review.md` finding 1 was the same boundary accepting malformed values. Here the activation answer boundary repeated both steps, omission and then values. Each round's mechanism was scoped to one boundary: `launchIdentity` is one definition for launch identity and nothing else. So the next boundary started again from the known instance, omission. The property is that every value crossing a version boundary is decoded, not checked, and a decoder has no "present" state separate from "well formed".
- **Check-then-use recurred as a second representation.** AGENTS.md's single representation law says a value crossing a boundary is returned in canonical form at the source. The first fix kept a predicate beside the raw answer, and the worker ran on the raw object, so what was checked and what ran were two representations. Findings 4 to 8 all live in the gap between them.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| `decodeClaimedRunAnswer`, the run the worker executes | 1 for "only decoded values run" | A well-formed value in the wrong unit. Run: an answer with `leaseSeconds: 60000`, a store answering milliseconds, decodes to `{"ok":true,"leaseSeconds":60000}`, and the worker heartbeats every 500 minutes |
| The decoder's `attempt > infraRetries` relation | 1 for that relation only | Any relation it does not encode. Run: `attempt: 5, infraRetries: 0, maxAttempts: 1` decodes as `{"ok":true}` |
| The surface's malformed values, leases, getter, and wake cases | 3 | Any value outside its tables. The 60,000 s lease above passes the whole surface |
| The clock shapes' exact due stamp | 3 | A launch delayed by less than the slack between a shape's natural latency and its bound. Run: a loop that sleeps 100 ms more before a scheduled wake leaves all 108 shapes green, while a 1,000 ms delay is caught with 22 problems |

## Fix-induced defects

Five. Findings 4 to 8 were introduced by `d8299c1`, the fix for round 1. It multiplied the lease by 1000 and demanded an exact integer. It reused `decodeBoundedInteger`, which accepts bigint, and checked fields one at a time. It read fields directly, and required `timedOut === undefined` for a delivered wake. Round 2 covered `d8299c1` as new code, which is how they were found.

## Evidence

- Red tests: commit `d74ebf6`, run and seen failing against `dff13c2`:
  - 27 refusals ended as `aborted` with no field;
  - 6 variants completed on malformed answers, 3 ended lease-lost, 1 scheduled a retry, and 1 threw;
  - an activation outage threw.
- Red tests: commit `0399109`, run and seen failing (3 of 6 tests) against `6e6bfaf`:
  - bigint variants `threw TypeError`, and the throwing getter `threw Error`;
  - the 1.001 s and 2.002 s leases ended as `incompatible-store`;
  - the delivered wake with `timedOut: false` ended as `incompatible-store`.
- Fixes: commits `d8299c1` and `b66f919`. Gate after `1e2c58e`: Biome lint and format, typecheck, and the determinism, user boundary, fragment, batch, clock, outcome, and deferral lints pass, and core, SDK, driver, harness, and dogfood tests pass (44 files, 436 tests).
- Finders: Fable `/code-review` rounds 1 and 2, and Fable `/simplify` round 2. Quoted round 2 verdicts:
  - "The leaseSeconds check computes `value * 1000` and requires an exact safe integer. The stores return `lease_ms / 1000`, so a lease with a fractional millisecond remainder fails the float round trip";
  - "`bounded()` goes through `decodeBoundedInteger`, which accepts bigint";
  - "An answer with `infraRetries >= attempt` passes the check, and user code runs with a user attempt of zero or less";
  - "a getter that throws escapes `fields[field]` instead of naming the field".
- Round 2 also found that the due-wake stamp sat at the end of the crossing park, not the due instant. That is a test instrument defect, not a product defect, so it is not counted above. With a loop that parks once more before a scheduled wake, the old stamp reported 0 due-launch problems and the corrected one 27.
- Did not reproduce as stated: the shape count. The reviewers reported 72 to 144 and 54 to 108, and the PR body's first draft said 216. The generator yields 108 shapes: 3 intervals, 9 step placements, 2 wake settings, and 2 due-wake settings.

## Root cause

The refusal was built as a predicate about the answer rather than a decoder producing the run. A predicate's input space is whatever its author imagines, so the surface generated the imagined failures: omission first, then a hand-picked malformed table. A decoder's output is the only thing the worker can run, so any input it accepts is by construction something the worker can execute. The residual is semantic, a well-formed value meaning something else, which no decoder sees.

## Mechanisms

Built in this PR:

- `decodeClaimedRunAnswer` and `WorkerClaimedRun` in `packages/core/src/claimed-run-answer.ts`. One rule table classifies and decodes each field, and `runClaimedRun` executes only the decoded run (rung 1).
- `ClaimedRunAnswerReadField`, derived from the rule table, types the surface's malformed table and the refusal's field, replacing a runtime enrollment test (rung 1).
- The store answer surface's bigint, relation, getter, lease, and wake cases, and the clock shapes' exact due stamp (rung 3).

Deferred (recorded in BUILD.md):

- None. The two false negatives above are recorded under what this round still would not catch. Neither loses or misattributes durable state, and PR4.3's second SQL dialect will cross real store answers with this worker.

## What this round still would not catch

- A defect of the shape "a store answers a well-formed value in another unit or with another meaning" would ship today, such as a lease in milliseconds.
- An answer breaking a field relation other than `attempt > infraRetries`, such as maximum attempts below the user attempt, runs.
- A due launch delayed by less than a shape's slack to its bound, such as 100 ms, ships unseen.
