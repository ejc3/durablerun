# Postmortem: the 2026-09-07 mutable TLA prerelease artifact failure

The September 1–7 scheduled nightlies each stopped before model checking
because the bytes published at the TLA+ `v1.8.0` prerelease URL no longer
matched the repository's pinned checksum. The product milestone remained
green, as did `pnpm verify` and every one of the 32 fuzz shards, but the proof
volume gate produced no model verdict for seven days. The first fix made the
approved checker a repository-owned input, but adversarial review then found
that it mislabeled the fat JAR as MIT-only and that one integrity-error path
could exit before printing its promised infrastructure diagnosis. Exact-head
review found that the first license repair still omitted four shaded components,
three stripped notices, and the current JLine copyright; it also found two
factual errors in the milestone transition. The final verdict remains an
infrastructure and release-safety failure, not a protocol counterexample.

## Severity

The worst escaped defect was release-facing: commit `e97ae81` added a bundled
third-party binary while incorrectly saying the distribution was MIT-only,
omitting the embedded EPL-2.0/GPL-2.0-with-Classpath-Exception, Apache-2.0, and
BSD-3-Clause notices and corresponding source information. Shipping that
description would have made the repository's redistribution record materially
false. Its first repair still did not reconcile the actual archive and omitted
Gson, prettier4j, Activation, and LSP4J, the stripped Activation, Jakarta Mail,
and LSP4J notices, and JLine's current copyright. The same first fix also
promised an `unreadable` infrastructure diagnosis that `set -euo pipefail`
could prevent from running.

Independently, seven consecutive scheduled proof runs never started TLC. That
left the repository without its full state-space verdict and made a red nightly
easy to normalize as dependency noise. No workflow state was lost or
duplicated, and the logs contained no model violation, but a proof gate that
can be disabled by an upstream file replacement cannot protect a release.
These are release-safety and verification-infrastructure SEVs; none is evidence
of an escaped protocol defect.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A clean or cache-missing TLA run downloaded a version-named asset from a mutable prerelease and then compared it with a fixed digest | Replacing the upstream asset made all six TLA matrix jobs fail before TLC, so the nightly had no safety or liveness verdict | Hermetic verification dependency ownership | The checksum detected changed bytes but the approved bytes were absent from the repository; clean-run availability still depended on the mutable URL | Check in the exact known-green JAR and remove the download path (rung 1 for upstream replacement); verify its fixed SHA-256 before every invocation and test offline and corrupt-artifact paths (rung 3) |
| 2 | The vendoring README called the fat JAR an MIT distribution although it embeds Jakarta Mail under EPL-2.0 or GPL-2.0 with the Classpath Exception, Apache Commons Math under Apache-2.0, and JLine under BSD-3-Clause | The repository would redistribute a binary with a false license summary and without recording all retained notices and corresponding-source locations | Third-party artifact inventory and release review | The first fix copied the top-level project's license assumption without inspecting the archive's embedded manifests or treating redistribution as a new product surface | Record the embedded license inventory, notices, pinned source tree, build recipe, and Jakarta Mail source JARs; require those entries in the focused test (rung 3, explicitly a hardcoded manifest) |
| 3 | Under `set -euo pipefail`, the diagnostic command substitution reran a failing `sha256sum` without neutralizing its status, so the shell exited before `${actual:-unreadable}` and the `INFRA ERROR` line | An unreadable checker produced a raw tool exit rather than the promised classified failure, recreating an ambiguous pre-TLC red | Artifact preflight failure matrix | The original corruption test exercised readable wrong bytes only; it never made the digest command itself fail | Make the diagnostic pipeline total with `\|\| true` and add missing, corrupt, and digest-command-failure cases (rung 3) |
| 4 | The first license repair checked selected README strings instead of reconciling the JAR's classes; it omitted Gson, prettier4j, Activation, and LSP4J, stripped notices for Activation, Jakarta Mail, and LSP4J, and retained a JLine copyright ending in 2018 for JLine 3.25.0 | The public repository still lacked the applicable redistribution record after claiming the defect closed | Archive-derived component ownership | A handpicked string list was a proxy for the archive inventory and could remain green while undocumented classes were present | Classify every JAR class exactly once as project-owned or one of seven explicit external components, require every component to be present and documented with exact version/license/source, and restore upstream legal files beside the JAR (rung 2) |
| 5 | `BUILD.md` made hosted alpha current while root `AGENTS.md` still directed contributors to the completed remote-dogfood slice | Work and review could follow stale repository instructions instead of the hosted-alpha exit test | Milestone source-of-truth consistency | Updating the plan did not force the always-loaded contributor instructions to move with it | Co-read BUILD and AGENTS in the focused regression and pin the hosted-alpha instruction (rung 2) |
| 6 | The completed milestone called 12-hour checkpoints “hourly cycles”; only the scheduler tick was hourly | The durable evidence overstated the workflow cadence by 12× | Milestone evidence accuracy | Tick frequency and due-work frequency were collapsed into one label | Pin 15 12-hour cycles and distinguish their hourly launch ticks in the focused regression (rung 2) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Scheduled nightly checksum failure, confirmed from all six TLA job logs | 1 | yes |
| Adversarial review of the vendoring fix | 2 | no |
| Exact-head closeout review | 3 | no |

Self-catch rate: **1 of 6, or 17%** (previous verification-infrastructure round:
**2 of 2, or 100%**).

The rate fell from 100% to 17%. Our nightly stopped the original line, but the
author's machinery accepted five defects introduced by its repair and closeout.
Reviewers had to inspect the embedded archive, execute the untested shell
failure path, and cross-check repository guidance against the evidence.
Detection worked for dependency drift; it did not work for the new
redistribution, diagnostic, and milestone-record surfaces.

## Recurrence

This was the fourth encounter with the same dependency-stability class. The
repository pinned or refreshed the `v1.8.0` checksum on July 18 (`8c48f00`),
August 9 (`c029b31`), and August 23 (`d6f3b22`), then failed again from
September 1 through September 7. Every checksum-maintenance round so far used
the digest as a proxy for the property.

The digest actually proved only that the bytes downloaded today matched bytes
approved earlier. The required property was stronger: a clean checkout can
always run the exact approved checker without trusting the current contents or
availability of an upstream prerelease URL. Refreshing the digest preserved
the proxy and guaranteed recurrence whenever the publisher replaced the
asset. Repository ownership removes that upstream mutation from the execution
path instead of refreshing it again.

Finding 2 is another instance of the new-layer scoping failure already named
by the SDK residual rule: the availability fix created a binary-redistribution
layer but gave that layer no inventory-derived assurance surface. Treating the
TLA+ project's MIT license as a proxy for every class bundled into its fat JAR
is the same mistake as treating lower-layer verification as coverage of a new
layer. The follow-up manifest is deliberately described as hardcoded below; it
closes this artifact's known obligations without pretending to derive them.

Finding 3 recurs from the July 24 diagnostic incident. That round made
post-TLC exits distinguish model violations from infrastructure failures, but
the new artifact preflight sat before `report()` and introduced a fresh
unclassified exit. The earlier mechanism protected TLC subprocess results,
not every command in a preflight failure handler. Its scope was narrower than
the property readers inferred from the `INFRA ERROR` promise.

Finding 4 is a direct recurrence of finding 2 in the same round. The first
repair named three components and asserted five strings, but those strings did
not answer the property: which component owns every class actually shipped?
Gson, prettier4j, Activation, and LSP4J classes remained undocumented, three
upstream notices remained stripped, and the retained JLine file described an
older release. The mechanism was a proxy, so the second repair replaces its
selected-string inventory with exact one-owner classification of the archive.

Findings 5 and 6 share the ordinary duplicated-record failure: BUILD named the
new milestone and the real checkpoint cadence, while contributor guidance and
the milestone summary repeated older interpretations. The focused consistency
case now reads those records together. It is a check, not a claim that prose has
become a single representation.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Repository-owned checker with no download path | 1 for upstream replacement | No in-scope false negative: an upstream replacement is unreachable because `scripts/tla.sh` names only `tools/tla/tla2tools.jar`. An adjacent supply-chain defect remains possible if a change replaces both the checked-in JAR and its approved digest. |
| Fixed SHA-256 checked before Java starts | 3 | A wrong JAR paired with its own newly approved digest passes integrity. In Experiment A, `/etc/hostname` replaced the JAR and the script constant was updated to that file's digest; integrity passed. |
| Five-case artifact behavior test | 3 | Experiment A still passed all five tests because fake Java proves routing and fail-fast behavior, while the license assertions inspect the README rather than deriving an inventory from the JAR: `Test Files 1 passed (1)` and `Tests 5 passed (5)`. |
| Hardcoded license and source manifest | 3 | A future JAR with different bundled code still passes if the README retains the five expected strings. Experiment A replaced the entire archive with `/etc/hostname`, retained the README, and all five tests passed. The manifest is a reviewed record, not the property that documentation equals archive contents. |
| Totalized checksum diagnostic plus digest-failure case | 3 | A failure outside the three enumerated artifact cases can still exit silently. In Experiment B, replacing `mktemp` with `/usr/bin/false` made the current script exit 1 with zero output bytes, while the focused five-test suite remained green. The fix makes the checksum error handler total; it does not classify every shell prerequisite. |
| Exact one-owner class inventory plus per-component record | 2 | Experiment C added `com/google/gson/not-gson/Foreign.class`, updated the paired digest, and retained the Gson record; all six focused tests still passed because a foreign component can choose an already owned namespace. The check catches changed archive shape, not deceptive namespace reuse or incorrect license facts. |
| Co-read milestone guidance and cadence assertions | 2 | Experiment D restored the wrong top-of-file values but repeated the required phrases in an unrelated historical paragraph; all six focused tests still passed. The check catches omission of the current phrases, not their semantic placement or truth. |

Experiment A was written and run in a disposable copy of the artifact fixture:

```sh
cp /etc/hostname tools/tla/tla2tools.jar
bad_sha=$(sha256sum tools/tla/tla2tools.jar | awk '{print $1}')
sed -i "s/eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a/$bad_sha/" scripts/tla.sh
vitest run packages/conformance/test/tla-artifact.test.ts
```

The observed historical verdict was five passing tests. This is an intentional boundary:
the focused tests prove hermetic selection, the three enrolled artifact
failure cases, and presence of the current license record. The real TLA
invocation, archive/provenance review, and full model runs remain the semantic
and inventory checks on a newly proposed checker.

Experiment B was also written and run against the current working tree:

```sh
case_root=$(mktemp -d)
mkdir -p "$case_root/bin"
ln -s /usr/bin/false "$case_root/bin/mktemp"
PATH="$case_root/bin:$PATH" TLA_ONLY=liveness1 bash scripts/tla.sh
```

It exited 1 with no output. The focused suite then passed all five tests. That
false negative bounds the new diagnostic test to the missing, corrupt, and
digest-command-failure cases it actually enumerates.

Experiments C and D were run in a disposable worktree after the archive-derived
test landed. C added an empty class at the foreign path above with `zip`, updated
the script's digest to the modified JAR, and ran the focused test. D restored
the two stale milestone statements while retaining the required phrases in an
unrelated paragraph, then ran the same test. Both reported one file and six
tests green. These failures bound the new mechanism to namespace ownership and
literal cross-record consistency; neither can prove legal facts or prose intent.

## Fix-induced defects

**Five: findings 2–6.** Findings 2 and 3 were introduced by commit `e97ae81`,
the repair for finding 1. Finding 4 survived `bdab7e7`, the first repair of
finding 2, because its string manifest did not derive ownership from the JAR.
Findings 5 and 6 were introduced by `77fcfae`, the milestone closeout prompted
by the incident. Findings 2 and 3 received failing regression tests in
`3daac08` before green fix `bdab7e7`; findings 4–6 received failing regression
tests in `09563c9` before green fix `cca4424`.

## Evidence

- Original red test: commit `83a3267` — one focused test was run and seen failing
  against buggy `main` commit `2263acb`; the simulated unavailable network
  returned exit 55 before the old script could run TLC.
- First fix: commit `e97ae81` vendors the known-green `tla2tools.jar` with SHA-256
  `eabd140a70f49eb9305a3bd3f3df944eddf87e5a90d329789085f8953a80533a`,
  removes the network/cache path, and validates the artifact before Java
  starts. Its README's MIT-only statement and its unreachable diagnostic
  fallback are findings 2 and 3, not evidence of a complete repair.
- Follow-up red tests: commit `3daac08` — two new focused tests were run and
  seen failing against `e97ae81`. One showed that a failing digest command
  exited without `INFRA ERROR`; the other showed that the README omitted the
  embedded license and source inventory.
- Follow-up fixes: commit `bdab7e7` totalizes the checksum
  diagnostic and records an initial partial inventory, pinned source tree, and
  build recipe. Its five focused cases were green but finding 4 proves that was
  not a complete redistribution check.
- Closing red tests: commit `09563c9` was run against the partial inventory and
  failed two of six cases. It found undocumented owned classes directly in the
  archive and the inconsistent milestone/cadence records.
- Closing fix: commit `cca4424` assigns all 2,014 classes exactly one owner,
  records all seven shaded components, restores the exact Activation, Jakarta
  Mail, and LSP4J notices and current JLine license, and aligns BUILD and
  AGENTS. The focused verdict is six of six green.
- Final gate after the follow-up fix: `pnpm verify` passed 100 test files and
  5,889 tests.
  `TLA_SCOPE=ci` passed after 1,812,645 generated and 486,377 distinct states,
  exercising safety and all five temporal branches.
- Finder: this project's scheduled nightly, most recently [run
  34101637055](https://github.com/ejc3/durablerun/actions/runs/34101637055).
  All six TLA jobs reported, `sha256sum: WARNING: 1 computed checksum did NOT
  match` and exited before TLC. The `verify` job and fuzz shards 0–31 were
  green in the same run.
- Adversarial-review finders, quoted verdicts: "The standalone JAR is a fat
  distribution with EPL-2.0/GPL-2.0-with-Classpath-Exception, Apache-2.0, and
  BSD-3-Clause material; calling the distribution MIT-only is incorrect," and
  "under `set -euo pipefail`, the second failing `sha256sum` exits from the
  command substitution before the `unreadable` fallback can be printed."
- The same pre-TLC failure occurred in nightly runs 33487837644, 33609471220,
  33734143609, 33854075456, 33955385622, 34022019187, and 34101637055, covering
  September 1–7 on `main` commit `2263acb`.
- A protocol-counterexample claim did **not** reproduce. The failing jobs did
  not start Java, while the post-fix CI scope completed with no model error.
  An unconstrained all-local concurrent run exited 143 under the repository's
  confinement after its probes. That terminated run is inconclusive, is not a
  model verdict, and is presented as neither green nor a counterexample.
- Recovery [run
  34138471466](https://github.com/ejc3/durablerun/actions/runs/34138471466)
  passed all 39 jobs on the hermetic artifact head: `pnpm verify`, all 32
  deep-fuzz shards, and all six isolated full-volume TLA targets. Later commits
  only correct records and focused tests; the checker, script, model, and
  configs validated by that run are byte-identical.
- Exact-head closeout review quoted the remaining inventory defect as: “The
  vendored binary still lacks third-party redistribution notices despite
  claiming that the licensing defect is closed.” It also identified the stale
  current-milestone instruction and the hourly/12-hour cadence contradiction.

## Root cause

The gate confused integrity detection with dependency ownership. A checksum is
excellent at refusing unapproved bytes, but it cannot preserve approved bytes
or make a mutable prerelease immutable. Because every TLA target reacquired the
same external file on its clean runner, one upstream replacement disabled the
entire proof matrix. Three earlier checksum changes treated each symptom as a
new digest instead of removing the unstable dependency from the clean-run path.

The repair then scoped "vendor the checker" as an availability change, even
though it created three additional surfaces: redistribution obligations, a new
preflight diagnostic, and milestone-transition records. Project-level licensing
was first substituted for the archive inventory; a selected string list was
then substituted for class ownership. One readable-corruption example was
substituted for the error handler's failure domain under `set -euo pipefail`,
and one BUILD edit was treated as if contributor guidance and evidence language
moved automatically. The common cause was verifying the old outcome without
enumerating the surfaces created by the fix itself.

## Mechanisms

Built across commits `e97ae81`, `bdab7e7`, and `cca4424`:

- The exact known-green fat JAR lives under `tools/tla/`, with provenance,
  revision, and checksum recorded. Upstream asset replacement is structurally
  irrelevant to a checkout's ability to run TLC (rung 1 for this incident
  class).
- `scripts/tla.sh` validates the repository copy's fixed SHA-256 on every
  invocation. Its diagnostic pipeline is total for a failed digest command and
  labels missing, corrupt, or unreadable artifacts as `INFRA ERROR` before Java
  starts (rung 3).
- Six focused cases use a fake curl that records and fails any former download
  path, prove the repository artifact is selected, exercise missing, corrupt,
  and digest-command-failure paths, derive exact component ownership from every
  archived class, and cross-check the current milestone records (rungs 2 and 3).
- `tools/tla/README.md` identifies the JAR as a multi-license distribution,
  maps all seven third-party components to their exact versions, licenses,
  notices, and source, and restores stripped or stale legal files beside the
  unmodified JAR (rung 2; namespace ownership is not license inference).
- BUILD and AGENTS agree that hosted alpha is current, while BUILD distinguishes
  12-hour workflow cycles from their hourly launch ticks (rung 2).

Nothing from this incident remains deferred. Recovery run 34138471466 supplied
the isolated full-volume evidence that a constrained all-local concurrent run
could not.

## What this round still would not catch

A repository change could replace the JAR and checksum together with an
incorrect or malicious checker; the focused artifact tests would still pass
because they prove selection and integrity, not the semantics of TLC. The
namespace inventory can still misattribute a component that places classes
inside another component's prefix, and it cannot derive legal facts, so every
checker update still requires archive and source review. A shell prerequisite
outside the three enrolled artifact cases can
still exit without the artifact-specific diagnosis, as the `mktemp` experiment
shows. The real model runs catch a checker that cannot execute the
specifications, but a checker designed to emit a false green remains a
provenance and code-review threat. A single full target can also exceed its
isolated runner's capacity; vendoring removes upstream mutability, not
state-space resource limits. The remote recovery receipt is green, but it does
not prove future artifact updates or runner sizes safe.
