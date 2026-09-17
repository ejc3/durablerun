# Postmortem: PR3.11b generated surfaces, review round 1 (PR #35)

PR3.11b added two generated driver surfaces: a launch payload case crossing driver versions, and a driver loop clock-shape surface. Before review, the clock-shape surface found that a backwards host clock step stretched a wake's floor wait past the registry interval, and a first fix landed. One Fable `/code-review` round then found two defects the surfaces could not see. The worker server acknowledged launches with malformed identity, which then never activated. And the first loop fix still let a wake overshoot the look its park planned when the step landed partway through a park. Both are fixed: launch identity has one definition in core, and the loop measures its waits with a monotonic clock reading.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

- **Malformed launch identity (worst).** The worker server answered 202 to a launch with an empty queue, run id, or claim token, or a claim generation of 1.5, 0, or -1. The detached pass then failed to activate, so the run sat as a lost launch until the sweep relaunched it, and the driver never saw a 400. A driver build or proxy that sends such values turns every launch into a relaunch loop until the relaunch cap. The activation compare-and-swap refused every such pass, so no durable state was lost or misattributed.
- **Floor wait overshoot.** After a backwards host clock step partway through a park, a wake's floor wait ended up to 125 ms after the look the park planned. That delays a due wake and the registry beat by up to the shorter of the park and the wake floor. The registry TTL is twice the interval, so the impact is latency, not a driver read as dead.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The worker server accepted a launch with an empty queue, run id, or claim token, or a fractional, zero, or negative claim generation (review finding 9) | The launch is acknowledged and never activates, so the run waits for lost-launch relaunches with no refusal to the driver | The launch payload surface and the worker-server hardening tests | The surface generated only omitted identity fields, and the parser checked JavaScript types, so a well-typed malformed value was never sent | `launchIdentity` in core is the one definition of a launch's identity and reuses the stores' positive claim generation check (rung 1). The surface generates malformed identity values (rung 3) |
| 2 | A backwards clock step partway through a park stretched a wake's floor wait past the planned look (review finding 5) | A due wake or registry beat delayed by up to 125 ms | The driver loop clock-shape surface | It stepped the clock only as a park began and compared sleep lengths, never when a wait ended against the planned look | `Clock.elapsedMs` makes every loop wait a monotonic duration (rung 1 for the loop's duration math). The surface steps halfway through a park and measures the planned look in elapsed time (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| PR3.11b launch payload and clock-shape surfaces, before review | 0 | yes |
| Fable `/code-review` round 1 over `a5e0ff4...9d208cd` | 2 | no |

Self-catch rate: 0 of 2, or 0% (previous round: 0%, `pr3.11a-cancelled-heartbeat-review.md`).

Before review, the same branch's surfaces caught two other defects that never reached review: the clock-shape surface found the floor wait stretched by a step at park start, and the store answer surface found handlers running on answers missing required fields. So the machinery is finding real defects, but the two review-caught ones sat outside the axes the surfaces generate.

## Recurrence

- **Clock steps in the loop's waits recurred for the third time.** `pr3.2a-lifecycle-review.md` finding 4 was a wake floor that ignored clock steps. Its mechanism was two loop tests at one step timing. This branch's surface found a second instance at park start, and review found a third partway through a park. Each mechanism checked a timing, while the property is that no loop wait depends on wall time. The loop now reads a monotonic clock for every wait, so a wall step cannot enter that arithmetic.
- **Launch payload validation recurred as values instead of presence.** `pr3.2a-lifecycle-review.md` finding 1 was a required field an older driver omits, and its mechanism, a payload of ids plus a red test for an older driver's payload, checks presence. The same boundary accepted malformed values. The payload surface's axes came from the instance already known.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| `Clock.elapsedMs` for the loop's waits | 1 for the loop's duration math | A wait elsewhere that reads wall time, in a path the idle clock-shape surface never runs. Run: a wall-clock read inserted into `withLaunchTimeout`'s sleep leaves all 54 clock shapes green, because the surface never launches |
| The clock-shape surface's planned-look measurement | 3 | A due wake delayed by a clock step. Reasoned from the surface's inputs, not run: no shape spawns a task, so the tick's next wake is always null. Run as a control: sizing the registry beat's due time from wall time is caught with 332 problems, and sizing the floor wait from wall time with 28 |
| `launchIdentity` | 1 for the identity's shape | A well-formed id that no claim issued. Run: `launchIdentity({ queue: 'q', runId: 'x', claimToken: 't', claimGen: 1 })` returns the identity, so a launch naming run `x` is acknowledged and waits for the sweep |
| The launch payload surface's malformed identity values | 3 | Any malformed value outside its table. It sends an empty string or a number for each text field and 1.5, 0, -1, or a string for the claim generation, and nothing else |

## Fix-induced defects

One. Finding 2 was introduced by `78f0779`, the fix for the clock-shape surface's own pre-review catch. That fix floored elapsed wall-time durations at zero, which bounded a step at park start but not one partway through the park. The review round covered `78f0779` as new code, which is how it was found.

## Evidence

- Red tests: commit `78c6df7`, run and seen failing (1 test, 4 problems) against `a5e0ff4`:
  - "interval 100ms, step -400ms, wake: the wait after a wake slept 250ms, past the registry interval"
  - "interval 100ms, step -400ms, wake: 12 registry beats in 1451ms, fewer than 13"
  - the same two for a one-hour step.
- Red tests: commit `3b3e2d1`, run and seen failing (2 tests) against `78f0779`:
  - six problems of the form "interval 1000ms, step -400ms at middle, wake: the wait after a wake ends 125ms past the look the park planned";
  - six malformed identity payloads answered 202 instead of 400.
- Fixes: commits `78f0779` and `346d802`. Gate after `346d802`: `pnpm typecheck`, the determinism lint, and Biome lint and format pass, and core, driver, and SDK tests pass (30 files, 382 tests).
- Finder: Fable `/code-review` round 1 over `a5e0ff4...9d208cd`, quoted verdicts:
  - "a backwards clock step partway through a park can still push the look past the planned look";
  - "`http.ts:133-138` only checks `typeof parsed.claimGen !== 'number'`, so `NaN`, `1.5` or `-1` gets a 202".
- Did not reproduce as stated: `NaN`. `JSON.stringify(NaN)` is `null`, so a driver's payload cannot carry a NaN claim generation, and the surface sends 1.5, 0, and -1 instead.

## Root cause

Both surfaces took their axes from the instances already known: omission for the payload, because the earlier defect was an omitted field, and a step at park start, because that was the first instance found. A generator whose inputs come from past defects covers those defects and their neighbors, not the property's input space. The loop's duration math also read wall time, so every new wait was a new place for a step to enter.

## Mechanisms

Built in this PR:

- `Clock.elapsedMs`, a monotonic reading that the driver loop uses for every wait (rung 1), in `packages/core/src/clock.ts` and `packages/driver/src/loop.ts`.
- `LAUNCH_IDENTITY_FIELDS` and `launchIdentity`, the one definition of a launch's identity (rung 1), in `packages/core/src/launch.ts`, used by the worker server.
- The launch payload surface generates malformed identity values, and the clock-shape surface steps partway through a park and measures the planned look (rung 3).

Deferred (recorded in BUILD.md):

- The store answer case and the refusal it needs, under PR3.11c. Deferral is acceptable because the fences refuse a zombie's writes, so no durable state is at risk while it is open.
- A clock-shape axis with a due wake, so a step that delays a due wake is observable, under PR3.11c.

## What this round still would not catch

- A defect of the shape "a wait sized from wall time outside the idle loop paths", such as the launch timeout, would ship today.
- A launch naming a well-formed id that no claim issued is acknowledged and waits for the sweep.
- A due wake delayed by a clock step ships unseen, because no clock shape spawns a task.
