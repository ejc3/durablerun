# Postmortem: hosted-alpha Hobby cron review

The hosted Vercel example configured a once-per-minute recovery cron while its
checked-in instructions presented an ordinary Vercel deployment with no paid
plan prerequisite. A read-only deployment review confirmed that the live alpha
project was on Hobby, where Vercel rejects cron schedules more frequent than
once daily. The example now uses one daily recovery sweep, its instructions and
design state the resulting latency honestly, and a focused regression owns the
checked-in schedule.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The useful question is why no executable check connected the
deployment configuration to the selected host plan before an external review
did so.

## Severity

The exact checked-in application could not deploy to the selected Hobby
project: Vercel rejects a `* * * * *` cron on that plan before any route,
migration, or receipt can run. That makes the hosted-alpha exit test
unreachable for a developer following the instructions. Under the standing
rule, a review-caught release blocker is a SEV even though no durable state was
at risk.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `vercel.json` requested a minute cron although the documented deployment had no Pro prerequisite and the live alpha project was Hobby | Vercel rejects the deployment, so the hosted receipt cannot start | Hosted-example deployment configuration test | The example tests exercised the router and local libSQL behavior but never read `vercel.json` or represented Vercel's Hobby cadence limit | Assert the single checked-in recovery cron is the daily `/api/tick` schedule, and keep the operational latency explicit in the README and design (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Read-only hosted deployment review against the live Vercel project and current Vercel documentation | 1 | no |

Self-catch rate: **0 of 1, or 0%** (previous hosted release-boundary review:
**0 of 2, or 0%**). The rate did not improve: local route and package evidence
was green while the host-owned deployment configuration remained untested.

## Recurrence

This is another instance of the new-layer scoping failure documented by the
hosted release-boundary review. That round added package-manifest and inline
callback checks, but neither mechanism enrolled Vercel configuration. The
package smoke proved an external consumer could install and execute the code;
it did not prove the selected hosting plan would accept the application. The
earlier mechanisms were correct for their layers but were proxies for the
larger hosted outcome.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Exact daily-cron assertion in the hosted example test | 3 | A configuration can retain the accepted daily cron while another Vercel field is undeployable; a disposable fixture with `maxDuration: 9999` passed the cron assertion and printed `{"cronRegressionPassed":true,"maxDuration":9999}`. |

The experiment ran the same deep equality assertion over this disposable
configuration and exited zero:

```js
const config = {
  functions: { 'api/*.ts': { maxDuration: 9999 } },
  crons: [{ path: '/api/tick', schedule: '0 0 * * *' }],
}
assert.deepEqual(config.crons, [
  { path: '/api/tick', schedule: '0 0 * * *' },
])
```

That is an intentional boundary, not a claim that one assertion proves the
entire Vercel deployment. It owns the escaped cadence mismatch; Vercel remains
the authority for its other plan and runtime limits.

## Fix-induced defects

**Zero.** The finding existed before this review's red/fix pair. The fix changes
only the cron cadence and matching documentation, and the complete focused
example suite was rerun after the change.

## Evidence

- Red test: commit `22a320263db4b3a0c2277fe402426be2eee054d9` — run and
  seen failing against buggy base
  `2eb22e8412f8783fa6e20773a06a08104d644a5c`. `npm test` reported **2
  passing, 1 failing**; the regression expected `0 0 * * *` and observed
  `* * * * *`.
- Fix: commit `a345a1f0dde4f2be4374201a1093adcc9ff719e9` — changes the
  recovery cron to midnight UTC and aligns README and DESIGN.md. `npm test`
  reported **3 passing, 0 failing**, and `npm run typecheck` exited zero.
- Finder, quoted verdict: "the linked alpha project is Hobby, while the
  checked-in minute cron exceeds Hobby's once-daily limit and prevents
  deployment." The read-only Vercel API reported `billing: hobby` for the
  linked account. Vercel's official
  [cron accuracy documentation](https://vercel.com/docs/cron-jobs/manage-cron-jobs#cron-jobs-accuracy)
  states that Hobby cron jobs can run only once per day and that more-frequent
  expressions fail deployment.
- A separate Web-handler incompatibility did **not** reproduce: Vercel's
  official Node.js runtime documentation specifies the same default
  `{ fetch(request) { ... } }` export used by the four example routes.
- A claim that the daily sweep makes the 45-second receipt wait for cron did
  **not** reproduce. The receipt invokes authenticated `/api/tick` requests
  directly for suspension, resumption, and lost-launch recovery; the focused
  event and recovery tests remained green.

## Root cause

The assurance boundary ended at code execution. Router tests supplied Web
`Request` objects directly, and the package smoke installed the example, but
neither consumed the deployment manifest or named the host plan. As a result,
the minute schedule inherited a hidden Pro assumption from the broader design
while the executable example and its instructions promised no such
prerequisite.

## Mechanisms

Built in this PR:

- The hosted example test reads the authoritative `vercel.json` and requires
  exactly one daily `/api/tick` recovery cron. The original minute schedule is
  preserved as a failing red commit (rung 3).
- The example README and deployment section of DESIGN.md state the Hobby-safe
  cadence, its midnight-UTC schedule, and its coarse recovery bound. The
  receipt's explicit ticks remain the bounded milestone evidence.

Deferred (recorded in BUILD.md):

- None. An authenticated deploy on every unit-test run would add external
  credentials and mutable infrastructure without improving ownership of the
  observed configuration field.

## What this round still would not catch

A different Vercel setting can make the application undeployable while the
daily-cron assertion remains green, as the `maxDuration: 9999` experiment
shows. The regression also cannot predict a future Vercel policy change. It
owns the concrete Hobby cadence escape; an actual release deployment and
hosted receipt remain the outcome-level checks for the complete platform
contract.
