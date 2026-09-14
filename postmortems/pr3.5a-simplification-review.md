# Postmortem: PR3.5a simplification review (PR #25)

PR3.5a is the first slice of the PR3.5 simplification sweep. Its contract is that it reshapes code without changing behavior, except where a change is named. Two Fable `/code-review` rounds ran over the branch.

Round one covered `main...d971246` and reported ten findings. One is a correctness finding in this repository's sense, meaning a reachable contract or release-safety violation: the sweep deleted a type exported by the published `@durablerun/core`. Round one also claimed that the loopback listen helper absorbed later server errors. Round two's experiment found no reachable trigger for that, so it is recorded as latent hygiene rather than a correctness finding.

Round two covered `main...ed99ed6` and judged the fixes and the `/simplify` pass as new code. It found eight defects that those fixes had introduced. All twenty findings are resolved on the branch.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

- **Release safety: deleting `WakeSignals`.** A consumer upgrading past `v0.1.0-alpha.1` who writes `import type { WakeSignals } from '@durablerun/core'` would get TS2305. The same PR rejected removing `retryDelaySeconds` for exactly that reason. Nothing shipped, because the branch was never merged.
- **Latent: the listen helper.** `listenLocal` kept its bind-time `error` listener after a successful bind, and a synchronous `listen` throw left it registered as well. A listener left in place absorbs the first server `error` event after bind. Round one proposed file-descriptor exhaustion as the trigger. Round two flooded a server under a low descriptor limit, and Node emitted no `error` event with or without the listener. No reachable trigger is known, so the impact is unproven.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The sweep deleted the published `WakeSignals` type export | Consumers that import the type stop compiling after upgrading | `verify:packages`, the published-package smoke | Its consumer fixture imports a fixed set from core (`LaunchOutcome`, `systemClock`, `type Clock`), and nothing compared the packed export surface with the last release | `scripts/package-surface.mjs`: every name the v0.1.0-alpha.1 release exported must still be exported by the packed packages, run by `verify:packages` (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Fable `/code-review` round one over `main...d971246` (10 findings reported; 1 is a correctness finding) | 1 | No |
| Fable `/code-review` round two over `main...ed99ed6` (10 findings reported; 8 were introduced by round-one fixes and the simplify pass; none is a correctness finding) | 0 | No |

Self-catch rate: 0 of 1, or 0% (previous round: 40%, `watcher-2026-09-09-github-observer.md`).

## Recurrence

- **Removing a published export: not a recurrence.** The hosted-alpha release-boundary round checked a manifest field (`publishConfig.tag`), not the export surface.
- **The latent listener shape: the same class.** It belongs to the EventEmitter error-ownership class that PR16 found in Postgres pools. PR16's mechanism owns listeners inside the Postgres executor only, and the driver's HTTP servers were outside it. It is not a correctness recurrence, because no trigger is demonstrated, but the class is identical.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| `package-surface.mjs` against the v0.1.0-alpha.1 surface | 2 | A published type that changes shape while its name stays exported. In the v0.1.0-alpha.1 core `dist/types.d.ts`, `completedPayloadJson` was deleted from `TaskResult`, and the check still printed `every name v0.1.0-alpha.1 exported is still exported (184 names)` and exited 0. It compares names, not declarations |
| `EventMemo` type guards (`isTimedOutMemo`, `isPayloadWake`, `memoOfWake`) | 1, for outcome arms | An optional field added to an existing outcome arm. With the guards in place, `payloadBytes?: number` was added to the payload arm of `EventWake` in a scratch tree, and the SDK typecheck exited 0. A required field fails to compile at `memoOfWake`, `commitEventMemo`, and the store decoder, but an optional one does not, so the SDK can silently drop it |
| Listener tests over the worker and wake servers, success path and throw path | 3 | A server built outside the two enumerated factories that keeps `server.once('error', reject)` after bind. It ran beside the listener tests in a temporary test file (`specimen: a server outside the enumerated pair still absorbs its errors`, asserting `listenerCount('error') === 1`), and both files passed. The tests enumerate servers; they do not check every emitter the driver creates |

## Fix-induced defects

Eight. Round two reviewed the round-one fixes and the `/simplify` pass as new code, not merely re-tested, and found these:

1. **Unlabelled assertion in the timeout owner test.** The rework put an unlabelled assertion ahead of the labelled one, so the mutation probe scored its mutant `wrong-path` instead of `caught` (witnessed at `ed99ed6` on a quiet host by `pnpm verify:mutations -k sdk-owned-event-timeout-discriminant`: `!! sdk-owned-event-timeout-discriminant: WRONG-PATH — packages/sdk/test/event-regressions.test.ts > event regressions prototype pollution cannot turn an event delivery into a timeout: AssertionError: expected { kind: 'retry-scheduled' } to deeply equal { kind: 'suspended' }` at line 209, before `b30c782` relabelled the test. After the relabel, the same mutant is caught by its attributable verdict at `45992fb` (`every mutation was caught by its attributable verdict ... (1 exact-only, 0 with collateral failures)`)).
2. **Undocumented behavior change.** Removing the bind listener changed behavior without a DESIGN.md update, and its comment misstated the old behavior.
3. **Synchronous throw still left the listener.** A synchronous `listen` throw still left the listener registered.
4. **False docstring claim.** The new `openTestDb` docstring said no test default could reach a real process. In fact `{ url, nowMs }` writes a frozen clock into the shared file.
5. **Dangling pointer.** SIMPLIFY-BACKLOG.md pointed at a BUILD.md rejection that did not exist.
6. **Casts cancelled the derived `EventMemo` guarantee.** With a third `EventWake` arm added, the SDK still compiled (scratch typecheck, exit 0). After the guard fix, the same arm fails at `memoOfWake` (exit 2, TS2322).
7. **Headers overclaimed.** The rewritten `tla.sh` and `SchedulerCI.cfg` headers claimed things the script and spec do not do.
8. **Dead code.** `infrastructureOutcome` carried four lines of unreachable exhaustiveness code.

Every one is fixed on the branch. The behavioral ones went red before their fix.

## Evidence

- Red: `28b3d99` fails `tsc --noEmit -p packages/core` with `test/published-exports.test.ts(2,15): error TS2305: Module '"../src/index.js"' has no exported member 'WakeSignals'.` It runs against `cb81095`, the commit that deleted the export. The class mechanism went red the same way: with `WakeSignals` removed from the core barrel, `bash scripts/package-smoke.sh` exited 1 with `package-surface: 1 name(s) exported by v0.1.0-alpha.1 are gone: @durablerun/core .: WakeSignals`. The latent listener fixes were red before they landed. `a56af71` failed `leaves no error listener behind once a server is bound` with `expected 1 to be +0`, and `a912ca0` failed `leaves no error listener behind when listen throws` with `expected 1 to be +0`
- Fixes: `fd6fdb3` restores the export, and the core typecheck exits 0. `4db415a` adds the surface check. With `WakeSignals` restored, package-smoke exits 0 and reports `every name v0.1.0-alpha.1 exported is still exported (184 names)`. `dab8898` and `7cc1c97` remove the listener on both paths, and `http-hardening.test.ts` passes 4 of 4. At `45992fb` all seven affected mutations are caught by their attributable verdicts, and the full verify exits 0 with 5,940 tests passing.
- Finder, round one: "The diff deletes the exported `WakeSignals` interface from `@durablerun/core` ... a consumer with `import type { WakeSignals } from '@durablerun/core'` gets TS2305 after upgrading."
- Finder, round two: "The rewritten prototype-pollution test adds an unlabelled `expect(await pass(f, reg, 'w2')).toEqual({ kind: 'suspended' })` before the labelled assertion ... scores the mutant `wrong-path`, where main scored it `caught`." Plus seven further fix-induced findings, listed above.
- Not reproduced:
  - **Round one's listener trigger.** Round two flooded a server under a low file-descriptor limit, and Node emitted no `error` event with or without the listener.
  - **Round one's JSON-parse owner claim.** A temporary await test forged `JSON.parse` for the marker text. It passed without the `sdk-context-captured-json-parse` mutant and passed with it. Under the same mutant, the step owner `protects every task-value JSON parse boundary with one captured capability` failed, so markers cannot observe that mutant.

## Root cause

The sweep's contract was "no behavior change", and nothing mechanical checked the package boundary. Typecheck and the tests prove what repository code uses, and a type export that only outside consumers import is visible to neither.

The fix-induced defects share a second cause. The fixes were written against a finding list and verified against that list. They were not re-read as new code against this repository's rules until the second review round did it.

## Mechanisms

Built in this PR:

- `scripts/package-surface.mjs` with the checked-in v0.1.0-alpha.1 surface, run by `verify:packages` together with a control snapshot the check must refuse (rung 2). It replaces the one-name type test from round one.
- Type guards that make a new `EventWake` outcome fail to compile in the SDK (rung 1, for outcome arms).
- Listener tests for both the successful-bind path and the throwing-`listen` path (rung 3).

Deferred (recorded in BUILD.md):

- None. The one observed gap, export removal, is closed by the surface check.

## What this round still would not catch

- A published type whose members change shape while its name stays exported. `package-surface.mjs` compares names only.
- A new field on an existing `EventWake` arm that the SDK ignores. The guards distinguish arms, not fields.
- A driver-created EventEmitter, other than the two servers, that absorbs its own errors.
- A server error after bind ends the host process, and the driver writes no log of its own first.
