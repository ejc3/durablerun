# Postmortem: hosted-alpha Vercel install selection

The hosted-alpha example was tested as an isolated npm consumer, but Vercel
imports it from a repository whose root declares a pnpm workspace. Vercel's
repository-root package-manager detection therefore selected pnpm, and pnpm
correctly ignored the example because it is intentionally outside that
workspace. A read-only deployment review found the resulting missing-package
build failure. The example now explicitly selects `npm install` in the Vercel
configuration, and the existing configuration regression owns that choice.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The useful question is why the external-consumer smoke removed the
repository context that Vercel uses to choose an installer, not who could have
noticed the parent lockfile.

## Severity

The checked-in application could not build when imported from this repository
with `examples/vercel-turso` as its Vercel Root Directory. Vercel selected the
repository's pnpm installation path, which installed the nine declared
workspace projects but none of the example's dependencies. The function build
then had no `@vercel/functions` or `@durablerun/*` modules, so deployment and
the hosted receipt were unreachable. Under the standing rule, a review-caught
deployment blocker is a SEV even though no durable state was exposed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The nested Vercel application relied on automatic installer selection although the repository root selects pnpm and the example is absent from `pnpm-workspace.yaml` | Vercel installed the enclosing workspace instead of the application; all function imports were unresolved and no deployment or receipt could run | Hosted-example deployment configuration and its external install smoke | The smoke copied the example out of the repository before running npm, deliberately erasing the parent workspace context; the configuration test read only the cron field | Set the authoritative Vercel `installCommand` to `npm install`, assert that exact field beside the cron, and continue running the copied-example npm package smoke (rung 1 for explicit host selection, rung 3 for deletion regression) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Read-only hosted release/deployment review against the checked-in repository topology and current Vercel behavior | 1 | no |

Self-catch rate: **0 of 1, or 0%** (previous hosted durable-identity review:
**0 of 2, or 0%**). The rate did not improve: all package and hosted-example
checks were green while none represented the package-manager decision made
above the copied application.

## Recurrence

This is another instance of the new-layer scoping failure recorded by the
hosted release-boundary and Hobby-cron reviews. The package smoke correctly
proved packed artifacts in a clean npm consumer, and the prior Vercel
regression correctly owned the selected cron cadence. Neither represented the
installer-selection layer introduced by importing a nested application from a
pnpm repository. They were valid checks for narrower properties, but proxies
for the complete deployable-host outcome.

The Hobby-cron repair already made the test read `vercel.json`, but it asserted
only `crons`. That mechanism did not fail; its claimed boundary was exact. The
recurrence shows that each newly relied-on deployment field needs executable
ownership rather than treating one checked field as evidence for the entire
host manifest.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Explicit npm install selection plus the exact config assertion | 1 for bypassing automatic selection; 3 for regression | A config can retain both asserted fields while another Vercel field prevents deployment. The executable fixture below keeps `installCommand: 'npm install'` and the daily cron but uses the invalid-for-plan `maxDuration: 9999`; both current assertions pass. |

The false-negative fixture was written and run with Node's strict assertions:

```js
const config = {
  installCommand: 'npm install',
  functions: { 'api/*.ts': { maxDuration: 9999 } },
  crons: [{ path: '/api/tick', schedule: '0 0 * * *' }],
}
assert.equal(config.installCommand, 'npm install')
assert.deepEqual(config.crons, [
  { path: '/api/tick', schedule: '0 0 * * *' },
])
```

It exited zero and printed:

```json
{"configRegressionPassed":true,"maxDuration":9999}
```

The mechanism owns the installer choice that escaped. It is not a local
reimplementation of Vercel's complete and changing configuration validator;
the release deployment and hosted receipt remain the whole-outcome checks.

## Fix-induced defects

**Zero of one.** The missing override existed before this review's red/fix
pair. The fix changes one Vercel field and the matching specification and
instructions. The four-package smoke, example typecheck, and all three example
tests were rerun after the change.

## Evidence

- Red test: commit `08c6231ae4c7458e125e96a1d52866eb9f48adad`
  against buggy commit `c49799d965d63d6f851d3f2dc66b2a748227c758`.
  Confined `pnpm verify:packages` reported **2 passing, 1 failing**; the
  configuration regression expected `npm install` and observed `undefined`.
- Fix: commit `3e2f87b8a58a3f8fa585f868b9f74cf81fe075c1` adds the
  installer override and aligns README and DESIGN.md. Confined
  `pnpm verify:packages` then packed and exercised all four external packages,
  typechecked the hosted example, and reported **3 passing, 0 failing**.
- Direct reproduction used a fresh archive of the buggy commit and ran
  `pnpm install --frozen-lockfile --ignore-scripts` from
  `examples/vercel-turso`. It exited zero while printing `Scope: all 9
  workspace projects`; neither `node_modules/@vercel/functions` nor
  `node_modules/@durablerun/core` existed under the example. The subsequent
  TypeScript check failed with `TS2307: Cannot find module` for those packages
  and the other three durablerun imports.
- Finder, quoted verdict: "Vercel detects the monorepo package manager from the
  repository-root lockfile, but `examples/vercel-turso` is excluded by
  `pnpm-workspace.yaml`; pnpm exits successfully after installing the parent
  workspace and leaves every example dependency absent."
- Vercel's official
  [monorepo documentation](https://vercel.com/docs/monorepos) states that it
  detects the package manager from the repository-root lockfile. Its official
  [build configuration documentation](https://vercel.com/docs/builds/configure-a-build#install-command)
  states that `installCommand` overrides the detected install command and runs
  from the configured Root Directory.
- A Web-handler incompatibility did **not** reproduce. Vercel's official Node
  runtime documentation specifies the same default `{ fetch(request) { ... }
  }` export used by all four routes. The daily Hobby cron, 60-second duration,
  and `CRON_SECRET` Bearer behavior also match the current platform contract.
- Broken package artifacts or URL dependency resolution did **not** reproduce.
  The confined package smoke built, inspected, installed, typechecked, and ran
  all four tarballs; a separate HTTP-tarball consumer resolved the exact
  internal alpha dependencies to the four top-level URL packages without a
  registry copy.
- The review's initial npm-tag concern did **not** reproduce at the registry
  boundary. Although npm 10's dry-run notice displayed its pre-flattening
  default, actual source-directory and tarball PUTs to a throwaway local
  registry both carried `dist-tags: { alpha: '0.1.0-alpha.0' }`. No external
  package was published.

## Root cause

The install smoke modeled the application after extraction, while Vercel makes
its installer decision before that isolation exists. Copying the example was
useful for proving the absence of workspace links and source imports, but it
also deleted the repository-root pnpm lockfile and workspace definition from
the test world. The test then invoked npm explicitly, so it could not detect a
host choosing pnpm first.

The common machinery gap was an unmodeled host decision. The repository had
evidence for the tarballs, npm consumer, Web router, cron field, local
migration, event flow, and lost-launch recovery, but no executable requirement
for which installer Vercel must use to reach any of them.

## Mechanisms

Built in this PR:

- `examples/vercel-turso/vercel.json` supplies the host-consumed
  `installCommand: "npm install"`, removing package-manager auto-detection from
  this application's deploy path (rung 1 for the current Vercel configuration
  shape).
- The hosted configuration test reads that authoritative file and requires the
  exact npm command beside the existing Hobby cron contract. The red commit
  preserves its ability to catch deletion (rung 3).
- README and DESIGN.md explain why this external consumer deliberately differs
  from the enclosing pnpm workspace, keeping the deployment prerequisite
  visible at the user and specification boundaries.

Deferred (recorded in BUILD.md):

- None. An authenticated Vercel deployment is already the hosted-alpha exit
  test, not a new assurance project. Reimplementing Vercel's full installer and
  configuration semantics locally would duplicate a changing external
  authority without closing the observed field more directly.

## What this round still would not catch

The checked-in test can remain green while a different Vercel field is invalid,
as the `maxDuration: 9999` fixture demonstrates, or while Vercel later changes
the precedence or meaning of `installCommand`. It also cannot ensure an
operator selected `examples/vercel-turso` as the project's Root Directory.
Those are host-level outcomes, so the actual release deployment and bounded
hosted receipt remain necessary. This round specifically makes the repository's
current pnpm topology unable to silently select the wrong installer for the
checked-in application.
