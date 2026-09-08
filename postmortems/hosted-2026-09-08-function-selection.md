# Postmortem: hosted function selection, 2026-09-08

**Pre-merge self-catch rate: 0 of 1.** The first Vercel deployment after
PR #22 merged failed before function building: an earlier wildcard consumed
the private queue function's configuration match. The local configuration test
had verified that the queue entry existed, not that Vercel would select it.
This follow-up removes overlapping patterns from the five-route example and
makes the existing test derive its required configuration keys from the actual
route files. The previous production deployment remained unchanged; no
protocol counterexample or durable-state impact was observed.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question is which configuration the host consumes, not whether a
reviewer could have noticed an ordering dependency.

## Severity

This is one escaped release-safety defect. The merged unattended-workflow
example could not deploy, so its live acceptance receipt was unreachable.
Vercel rejected the candidate before replacing production or executing its
functions. There was no observed loss, duplication, or misattribution of
durable state. A deployment blocker discovered after merge is a SEV under the
standing rule; it is not evidence that the verified SQL protocol failed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `functions` listed `api/*.ts` before `api/wake.ts`; Vercel selects the first matching entry, then rejects the unused exact entry | The unattended example failed deployment before function building | Hosted-example configuration regression | It inspected the raw wake entry and its trigger without representing effective function selection | Five disjoint literal route keys remove the current overlap (rung 1); the existing test derives exact key inventory from route files and checks every duration plus the queue trigger (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Vercel deployment pre-builder validation after merge | 1 | no |

Self-catch rate: **0 of 1, or 0%** (previous comparable
[Vercel install-selection incident](hosted-alpha-vercel-install-selection.md):
**0 of 1, or 0%**). There is no improvement to claim. Package, example, and
protocol checks were green before merge; none modeled this host selection
decision. The later regression reproduces the escape, but does not retroactively
count as a pre-merge detection.

## Recurrence

This repeats the host-boundary gap in the install-selection incident. That
repair correctly pinned the installer, and the cron check correctly pinned its
schedule. Neither proved every other configuration field. The new queue check
again treated a present field as evidence for the deployment outcome: the
private trigger was present under an entry the provider never selected.
The recurrent class is checking an input without its consumer's selection
semantics, not a failure of the installer or cron fixes themselves.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Disjoint literal configuration for the current five flat route paths | 1, for this selection ambiguity | No first-match overlap exists among those five distinct literal paths. This is not a claim that other configuration fields are valid; the executed invalid-runtime control below preserves disjointness while remaining undeployable. |
| Existing configuration test: generated route-key equality, durations, installer, cron, and queue trigger | 3 | Setting `config.functions['api/wake.ts'].runtime = 'not-a-version'` leaves every assertion green, while Vercel's real detector rejects the runtime. |

The bounded control ran on 2026-09-08 at 15:23:59 UTC. It executed the actual
configuration assertion block from `runtime.node-test.ts` against an in-memory
five-key configuration, then repeated it after this change:

```js
config.functions['api/wake.ts'].runtime = 'not-a-version'
```

Both configurations were then passed to the installed Vercel CLI 59.10.0
`detectBuilders` implementation with the real route-file inventory and package
metadata. No source file or provider deployment was changed. The output was:

```json
{"case":"exact-inventory","actualConfigurationAssertions":"passed","providerErrors":null}
{"case":"invalid-runtime-boundary","actualConfigurationAssertions":"passed","providerErrors":[{"code":"invalid_function_runtime","message":"Function Runtimes must have a valid version, for example `now-php@1.0.0`."}]}
```

The assertion is an inventory/configuration check, not a replacement for the
provider's complete validator. The structural repair removes the observed
ordering dependency instead of copying a glob matcher into the test.

## Fix-induced defects

**Zero of one.** The overlap existed in merged PR #22, before this red/fix
pair. No additional confirmed finding was introduced by the repair. The
invalid-runtime control is a deliberately constructed boundary example, not
an accidentally shipped second defect.

## Evidence

- Buggy merge: `a9527cf053c4aabff10b23fd066642af3e4d81d5`, whose tree
  matches the audited PR #22 head `e8a6bb40994ff66ba2abf2e0e1d8037da97b02e7`.
- Finder: Vercel deployment `9cuHe4m5AsuGtCGKUns6T4s3yxSZ` at
  2026-09-08 15:18:38.500 UTC, for
  `durablerun-alpha-b9d8nl890-ejc3-7031s-projects.vercel.app`. Its build verdict:

  > Error: The pattern "api/wake.ts" defined in `functions` doesn’t match any Serverless Functions inside the `api` directory.

- Vercel's official
  [function selector](https://github.com/vercel/vercel/blob/main/packages/fs-detectors/src/detect-builders.ts#L659-L669)
  searches keys in insertion order for an exact or glob match. Its
  [unused-entry check](https://github.com/vercel/vercel/blob/main/packages/fs-detectors/src/detect-builders.ts#L1005-L1057)
  rejects the shadowed entry. The installed CLI 59.10.0 implementation reproduced
  `unused_function` on the released config; exact-five configuration produced
  no detector errors.
- Red test: `f68148eedd1c7a7fc59b6ae5a25746be07118862`, run against the
  buggy merged configuration. Confined `pnpm verify` exited 1 at the external
  example: **10 passed, 1 failed**. The configuration assertion observed
  `['api/*.ts', 'api/wake.ts']` instead of
  `['api/events.ts', 'api/inspect.ts', 'api/tasks.ts', 'api/tick.ts', 'api/wake.ts']`.
- Fix: `289cd7cc7bf5607652b20531c46507c7c4a2e19b`. Confined
  `pnpm verify:packages` passed the external consumer smoke and **all 11
  example tests**, with zero failures or skips. Full confined `pnpm verify`
  then exited zero: **104 workspace test files, 5,937 tests**, with a
  450.98-second Vitest sweep. This local green result does not by itself prove
  provider deployment or live queue delivery.
- Separate hosted evidence: the corrected production deployment reached
  `READY`. The [alpha.1 receipt](../receipts/hosted-alpha-v0.1.0-alpha.1.json)
  binds its corrected example source and configuration hash to both measured
  tasks and a complete, sanitized provider trace. That trace demonstrates a
  successful private queue invocation at each due time with no tick during
  either sleep-to-completion interval.
- A missing `api/wake.ts` file did **not** explain the provider message: the
  real inventory contained that file, and selecting its exact configuration
  first made the same provider detector accept all five functions. This was
  configuration shadowing, not a missing route or a queue/SQL runtime failure.

## Root cause

The test asserted a declaration rather than the configuration effective for
the file. The broad duration pattern and the queue-specific entry were each
reasonable in isolation, but they were not merged by the provider. The host
selected the broad entry first. Because local tests invoked adapters directly
and checked the raw manifest entry, their world omitted that decision.

## Mechanisms

Built in this follow-up:

- Replace the wildcard with the five explicit route paths in
  `examples/vercel-turso/vercel.json`, removing overlap for the current route
  set without relying on ordering (rung 1).
- Extend the existing configuration test to enumerate the actual flat `.ts`
  route files and require exactly those keys, with a 60-second duration on
  each and the existing private trigger on `api/wake.ts` (rung 3).

Deferred (recorded in BUILD.md):

- None added. Provider deployment and the bounded live unattended receipt are
  already milestone exit evidence. No new validator framework, dependency,
  global mutation corpus, or protocol work is needed for this release blocker.

## What this round still would not catch

An independent invalid provider field can still pass the local configuration
assertions, as the executed invalid-runtime control demonstrates. They also
do not prove provider build acceptance, callback authorization, or delayed
queue execution. The actual replacement deployment and the existing receipt
paired with redacted provider request logs remain necessary before declaring
the unattended milestone complete. This repair does not broaden the supported
route topology beyond the current five flat TypeScript functions.
