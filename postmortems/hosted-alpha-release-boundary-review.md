# Postmortem: hosted-alpha release-boundary review

The hosted-alpha foundation added a reusable one-slot inline launcher and the
first four publishable `@durablerun` package manifests. Adversarial release
review found two defects before publication: outcome-observer failures could
escape as launcher failures or detached rejections after the worker had
already ended durably, and npm's implicit channel would publish all four alpha
packages under `latest`. Both defects now have preserved red commits, narrow
fixes, and focused regressions. Neither affected a released package or deployed
host.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The useful question is why the original green checks did not own the
observer exception boundary or the registry channel, not who could have read
the implementation more carefully.

## Severity

The worst release-facing defect was the npm channel. Publishing
`0.1.0-alpha.0` without an explicit dist-tag would target `latest`, so a plain
consumer install could select prerelease code as the stable default. The same
omission existed in core, SDK, driver, and the libSQL store; the clean install
smoke proved that their tarballs worked but not where npm would expose them.

The inline defect made an observation hook authoritative over launch
accounting. A synchronous `onOutcome` exception after `runClaimedRun` completed
caused `tick` to convert the rejected launch call into `launch-failed`, reporting
`ended: 0` and `launchFailed: 1` even though the durable task was completed. An
async hook returned a Promise that the launcher ignored, allowing observation
to outlive the bounded slot and potentially reject without a handler. The
durable completion itself was not rolled back, but hosted health, counters, and
process behavior could contradict it. Under the standing review rule, both are
release-safety SEVs.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `inlineLauncher` invoked `onOutcome` after durable completion without awaiting or containing it | A synchronous observer exception was reclassified as a failed launch, while an async observer detached from the one-slot invocation | Inline launcher control-flow boundary and its focused behavioral suite | The original tests used only a synchronous nonthrowing observer and asserted worker completion, so callback lifetime and failure ownership were absent from the contract | Construct the opaque ending first, await the one observer invocation inside failure containment, and exercise throwing and gated-async observers (rung 1 for the current exception path, rung 3 for future edits) |
| 2 | All four `0.1.0-alpha.0` manifests declared public access but no npm dist-tag | A normal npm publish would place prerelease packages on `latest`, exposing alpha code through unqualified installs | Packed-manifest release smoke | The smoke asserted the semver, exports, access, dependencies, installation, and runtime, but treated a prerelease version as if npm inferred its release channel | Pin `publishConfig.tag` to `alpha` in every public package and assert it from every unpacked tarball (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial release-blocker review of the hosted-alpha foundation | 2 | no |

Self-catch rate: **0 of 2, or 0%** (previous comparable hosted-authorization
review: **0 of 1, or 0%**).

There was no improvement. Before review, the original inline suite and the
four-package install smoke were green. They established the happy path at each
new surface but omitted the authority boundary peculiar to that surface.

## Recurrence

Finding 1 is another instance of the observability-over-authority class. PR
#14 finding 9 required the bounded dogfood host to preserve the worker outcome
instead of flattening failures into a successful scheduled invocation, and the
resident driver already contains observer-write failures so they cannot stop
driving. Those mechanisms protected their existing call sites. They did not
generate a failure surface for the new reusable `onOutcome` seam, so the same
class reappeared with the polarity reversed: observation turned a real durable
success into a transport failure. The earlier tests were examples of safe
consumers, not ownership of the property that observation cannot rewrite
control flow.

Finding 2 has no earlier npm dist-tag mechanism. It is adjacent to the mutable
prerelease-channel failure in the TLA artifact postmortem: in both cases a
version-looking identifier was mistaken for control of a mutable release
channel. The TLA repair removed one upstream artifact URL from a proof path; it
could not protect npm metadata introduced later. Here the existing manifest
smoke checked `version` and `publishConfig.access` but omitted the separate
field that npm actually uses to choose a channel. That was a proxy for the
release property, not the property itself.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Guarded, awaited `onOutcome` invocation plus the throwing and gated-async regression cases | 1 for a callback's returned thenable at the current invocation; 3 for future code | An observer can start nested async work and return `void`. The launcher has no Promise to await, so its call settles while that work remains detached; Experiment A left all four focused tests green and printed `nestedWorkFinished: false` after launch settlement. |
| `publishConfig.tag: alpha` in every packed manifest plus the package-smoke assertion | 3 | An authorized publisher can pass `--tag latest`, which overrides the manifest. Experiment B left the four-package smoke green, then npm's real dry-run selected `latest`. |

Experiment A was written and run as a disposable direct probe against commit
`59855b3`. The unchanged focused suite first reported four passing tests. The
probe then supplied this observer to a real claimed libSQL run:

```ts
let nestedWorkFinished = false
onOutcome() {
  void nestedGate.then(() => {
    nestedWorkFinished = true
  })
}

await launcher.launch(invocation)
console.log(JSON.stringify({ launchSettled: true, nestedWorkFinished }))
```

It exited zero and printed:

```json
{"launchSettled":true,"nestedWorkFinished":false}
```

The mechanism owns the Promise the observer returns; JavaScript cannot make an
unreturned child Promise awaitable from outside the callback. The shipped
hosted observer performs only a synchronous assignment, but this is the honest
boundary of the public extension point.

Experiment B first ran the enrolled smoke and observed all four tarballs
install, typecheck, and execute. It then packed core and exercised npm's actual
override path without publishing:

```sh
case_root=$(mktemp -d)
pnpm --filter @durablerun/core pack --pack-destination "$case_root"
npm publish "$case_root/durablerun-core-0.1.0-alpha.0.tgz" \
  --dry-run --tag latest --access public
```

The command exited zero and npm reported:

```text
Publishing to https://registry.npmjs.org/ with tag latest and public access (dry-run)
+ @durablerun/core@0.1.0-alpha.0
```

The manifest controls the safe default, not a credentialed maintainer who
explicitly overrides it.

## Fix-induced defects

**Zero.** Finding 1 was present in the initial inline-worker commit `afae4fc`;
finding 2 was present in the initial package commit `5a13fdd`. Neither was
introduced by a repair for an earlier finding in this review round. The second
red/green pair followed the observer repair chronologically, but changed only
the pre-existing package metadata and smoke assertion. Both repairs were
rerun through their focused suites as new code.

## Evidence

- Inline red test: commit `4a98a6e` — run and seen failing **2 of 4** focused
  tests against hosted foundation `3fd6845`. The throwing case received
  `ended: 0, launchFailed: 1` instead of `ended: 1, launchFailed: 0`; the async
  case observed that the launch had already settled before its gated observer.
- Inline fix: commit `3c52d6e` — constructs the opaque ending before
  observation, awaits `onOutcome`, contains its failure, and returns the
  original ending. The focused verdict became **4 of 4** tests green and the
  driver TypeScript check passed.
- Package red test: commit `47e270d` — run and seen failing against `3c52d6e`.
  The first unpacked tarball stopped with `package-smoke: @durablerun/core: npm
  dist-tag is not alpha`.
- Package fix: commit `2465bf7` — adds the `alpha` tag to core, SDK, driver, and
  store-libsql. The confined package smoke packed all four, inspected their
  published manifests, installed them in a clean consumer, typechecked, and
  ran successfully.
- Finder, quoted verdicts: "`inlineLauncher`'s `onOutcome` can throw after the
  worker durably completes, making tick report `launchFailed` and `ended=0`;
  async callbacks can detach," and "the four alpha packages dry-run to npm tag
  `latest`; pin the alpha tag in published metadata and assert the packed
  manifests."
- Current focused evidence on `59855b3`: the inline suite passed **4 of 4** and
  confined `pnpm verify:packages` passed the four-tarball external-consumer
  receipt. Experiment A and Experiment B then established one distinct false
  negative for each claimed mechanism.
- A durable-state-loss claim did **not** reproduce. In the throwing-observer
  red case the task remained `completed` with payload `"done"`; only launch
  accounting and the advisory outcome were corrupted. A claim that the alpha
  manifest makes `latest` publication impossible also did **not** reproduce:
  Experiment B's explicit CLI override selected `latest`.

## Root cause

Both new surfaces allowed an implicit behavior to become authority. The
launcher used JavaScript's ordinary exception/Promise behavior as if an
observer were part of worker execution, although durable execution had already
ended. The packages used npm's ordinary `latest` default as if the prerelease
semver selected an alpha channel. In each case, the first test proved the
primary outcome—worker completion or clean installation—without naming the
secondary boundary that could contradict it.

This is the new-layer scoping failure in two forms. Reusing verified worker and
package-building layers did not verify the callback lifecycle or registry
publication layer added above them. The review found mechanism gaps because
the implementation added those surfaces without adding their failure and
channel dimensions at birth.

## Mechanisms

Built in this branch:

- `inlineLauncher` constructs the exact-identity ending before invoking the
  observer, awaits the observer's returned thenable in the same bounded slot,
  and contains observer failure so it cannot alter `LaunchOutcome` or tick
  counters. Focused cases own both synchronous failure and asynchronous
  lifetime (rung 1 for the present call shape, rung 3 for regression).
- Every public alpha package declares `publishConfig.tag: alpha`; the existing
  package smoke checks that field in the unpacked manifest rather than the
  workspace source, alongside its clean install and runtime receipt (rung 3).

Deferred (recorded in BUILD.md):

- None. No global release framework, new lint, or callback sandbox is justified
  by these two fixes. Preventing a credentialed publisher from explicitly
  overriding npm metadata, or preventing plugin code from forking its own
  unreturned work, would require authority outside these package APIs and is
  not part of the hosted-alpha exit test; BUILD.md is unchanged.

## What this round still would not catch

A host observer can deliberately fork unreturned work, as Experiment A did,
or return a Promise that never settles and hold the one inline slot forever.
The framework can await and contain only the value the plugin returns. The
checked-in hosted observer is synchronous and does neither, but the public
hook is trusted host code rather than a sandbox.

A publisher with npm credentials can explicitly supply `--tag latest`, as
Experiment B did, or later move registry dist-tags independently of any
tarball. The packed-manifest gate protects the ordinary metadata-driven
publish path; it is not registry access control. Those are the precise
residuals demonstrated by the two mechanism experiments, rather than a claim
that either repair is complete against hostile host or maintainer authority.
