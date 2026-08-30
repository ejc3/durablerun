# Postmortem: useful Turso dogfood evidence review (PR #14)

PR #14 adds a scheduled repository-reference journal, retained status
receipts, and deliberate driver and worker death probes. Adversarial review
found that the workload was runnable but its green workflow did not yet prove
the milestone: normal receipts were not validated, credentials were scoped too
broadly, and fault evidence was not exact. Review of the first repair found a
fourth, fix-induced defect in which the retained receipt was not the receipt
the gate validated. Final workflow-contract review found two more failures in
the proof path: `tee` could hide a failed producer, and the built-in repository
token remained job-wide despite the narrower environment. Exact-head
whole-system review then found that a pre-existing short task could satisfy the
normal receipt policy without seven elapsed days. The final exact-head pass
found three more outcome failures: a fault probe could kill ordinary due work,
an observed inline-worker outage could leave the scheduled invocation green,
and an idempotently reused wrong-target or year-cadence task could satisfy the
receipt. Release-candidate review then found that clearing the one-shot fault
hook also cleared the probe's isolated queue identity, so recovery polled the
ordinary queue and never recovered the crashed probe. The last release-contract
pass found three more operability failures: a live journal could remain green
without timely progress, the advertised Node floor did not support the dogfood
entrypoint flag, and a productive bounded worker retained its losing five-second
finalization timer. All fourteen defects are fixed before merge.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The question is what would have made these defects unwritable or
caught them without a reviewer, not who should have noticed them.

## Severity

The worst finding exposed the dedicated Turso write credential and the
repository token to every action in the job, including checkout, tool setup,
and artifact upload. Compromise of an unnecessarily privileged action could
therefore disclose or mutate the remote dogfood evidence.

The scheduled seven-day workload could also remain green after its durable
task failed or was cancelled, after completion with incomplete evidence, or
while its partial journal was discontinuous. A later repair retained one
status read but validated another. Those defects could produce a green run and
an unvalidated artifact for the milestone's central no-lost-effects claim.

The workflow also relied on GitHub's implicit Linux shell. Its pipelines
therefore returned `tee`'s status rather than a failing tick or verifier's
status. Separately, `contents: read` left the built-in repository token
available throughout the job even after explicit `GITHUB_TOKEN` environment
variables were narrowed to worker steps.

The normal receipt policy also accepted any nonnegative span from durable task
parameters. Because idempotent start preserves an existing task, a completed
one-cycle task under the production key could pass a later workflow configured
for fifteen cycles without providing the milestone's seven-day evidence.

Fresh fault tasks still shared the ordinary journal queue, so a due normal run
could consume the one injected death and leave the named probe untested. The
bounded host also flattened an observed store outage into an ordinary ended
launch, allowing both the tick and its unchanged live receipt to pass. Finally,
the receipt bound only a minimum durable span, not the task type, target, count,
and cadence: the production key could journal another repository or sleep for a
year while every hourly workflow stayed green.

The first queue-isolation repair coupled routing to the transient fault hook.
The workflow cleared that hook before recovery, which silently switched both
recovery ticks to the ordinary queue; the probe remained crashed while normal
work could run instead.

A structurally valid live receipt could also remain green indefinitely with no
checkpoint or with a stale last checkpoint, so seven days of scheduled success
still did not prove seven days of progress. Local users on supported early Node
22 releases failed before the dogfood CLI started because
`--env-file-if-exists` was added only in Node 22.9; the locked test toolchain in
fact requires Node 22.12. Finally, every productive bounded worker could keep
its short-lived Node process alive for five idle seconds because
`Promise.race` did not cancel its losing finalization deadline.

Finally, fault dispatches accepted lower-bound recovery counters and omitted
exact checkpoint attempt ownership. Extra or misclassified recovery
transitions, or a checkpoint rewritten on a later attempt, could look like the
promised single recovery.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Turso credentials and `GITHUB_TOKEN` were job-level environment variables | Checkout, setup, and upload actions inherited credentials they did not need | Workflow security topology | The existing workflow gate covered older checkout defaults; the new workflow had no least-privilege enrollment | Put credentials only on the steps that require them and parse the workflow in a focused regression (rung 2) |
| 2 | Normal scheduled receipts were not validated, including terminal, incomplete completed, and inconsistent partial-live states | Seven days of green jobs could coexist with a failed task or a journal that did not prove contiguous progress | Dogfood outcome gate and receipt contract | Artifact creation and command success stood in for semantic success; only deliberate faults had a verifier | One receipt-policy authority validates every normal state against durable count, span, continuity, attempts, result, and failure evidence (rung 1 authority with rung 2 cases) |
| 3 | Fault recovery accepted lower-bound counters and omitted exact `ownerAttempt` | Extra failures, wrong recovery classification, or checkpoint rewriting could satisfy a probe | Fault-edge progress oracle | Aggregate presence was treated as exact causal evidence, and the new dogfood layer was outside the generated store fault surface | Require exact complementary counters, zero user attempts, one exact checkpoint, ordinal one, and owner attempt one (rung 2) |
| 4 | The first receipt repair retained one status read and validated a second | The uploaded artifact could disagree with the value that made the job green | Single-representation receipt boundary | Write-receipt and verify-receipt steps independently queried the database | The verifier emits and validates the same value piped to `dogfood-after.json` (rung 1 current data flow with rung 2 topology test) |
| 5 | Workflow pipelines ran under implicit `bash -e`, without `pipefail` | A failed tick, recovery command, or final receipt verifier could be masked by successful `tee`, leaving a green job and retained bad evidence | Workflow execution contract | Tests pinned command text and the verifier's semantics, not the shell that decides the command's exit status | Select GitHub's explicit `bash` shell for every run step and parse that default in a regression (rung 2) |
| 6 | `contents: read` kept `github.token` available to every action | Checkout, setup, or upload code could receive repository read capability despite the claimed step scope | Workflow capability topology | The first repair and regression modeled named environment variables; GitHub's implicit token context bypassed that proxy | Give the job no repository permissions, check out the public source anonymously, and use only an optional dedicated read token on worker steps (rung 1 capability removal with rung 2 regression) |
| 7 | Normal receipts accepted any nonnegative durable expected span | An idempotently reused one-cycle task could make the seven-day milestone workflow green immediately | Milestone receipt and durable-configuration reconciliation | Using durable parameters correctly removed current-process drift, but no fixed outcome floor constrained those parameters; the config test covered only newly created defaults | Define one seven-day milestone constant, derive the default schedule from it, and reject every normal live or completed receipt below it (rung 1 authority with rung 2 regression) |
| 8 | A fresh deliberate-death task shared the normal journal queue | An older due run could receive the crash, so the retained probe receipt did not test the promised recovery edge | Fault-target identity | A fresh idempotency key identified the receipt but `tick` selected by the shared queue with `claimLimit=1` | Derive an isolated queue from every fault probe's fresh key and reproduce competition with real file-backed tasks (rung 1 routing shape with rung 2 regression) |
| 9 | The bounded host flattened `aborted`, lease-lost, task-failure, and launcher-failure outcomes into a successful tick | A Turso outage or task failure observed by the inline worker could leave the scheduled workflow green | Bounded-host outcome boundary | Generic SDK/driver recovery correctly preserved the lease story, but the dogfood host had no exhaustive success/failure policy above it | Exhaustively map every `WorkerOutcome` with `satisfies Record`, reconcile first, then reject the invocation on task/infrastructure/registry/launcher failures or nonzero `launchFailed` (rung 1 single/exhaustive authority with rung 2 outage regression) |
| 10 | Receipt validation bound only durable count/span and a seven-day minimum, not the complete configured workload | A reused key could journal the wrong repository/ref or a two-cycle, one-year cadence while hourly jobs stayed green | Durable workload identity | The durable parameters were treated as self-authenticating intent; status discarded target fields and kept derived count/span as a second representation | Persist and expose one durable workload object, compare task type/repository/ref/cycles/interval exactly in both start and verify, and derive evidence math from that object (rung 1 single representation with rung 2 real-runtime cases) |
| 11 | The isolated queue was derived from the one-shot fault hook rather than persistent probe identity | Clearing the hook for recovery switched both ticks to the ordinary queue, leaving either deliberate-death probe unrecovered | Fault-probe lifecycle identity | Finding 8 isolated injection but treated transient injection mode as the lasting route; tests stopped after target selection and never exercised injection to recovery configuration | Require an explicit persistent probe identity, derive routing from it, reject fault injection without it, and remove the runtime-only fault override (rung 1 single configuration path with rung 2 workflow/config regression) |
| 12 | Live receipts enforced shape but no elapsed-time progress floor | An hourly workflow could stay green for seven days with zero or stalled checkpoints | Milestone liveness and receipt policy | Contiguity and span checks described existing evidence but never compared its age with the configured cadence | Read task creation, checkpoint time, and current time from the database; fail after the next durable interval plus a two-hour scheduling grace (rung 1 database-time authority with rung 2 boundary cases) |
| 13 | Dogfood scripts used `--env-file-if-exists` while the support contract declared Node `>=22` | Supported Node 22.0-22.8 users failed before the CLI ran; the locked test stack also requires Node 22.12 | Runtime support contract | No check reconciled entrypoint features and locked tool requirements with the root engine declaration or README | Raise the single root floor to `>=22.12.0`, make README delegate to it, and pin the observed contract in a focused regression (rung 1 declaration with rung 2 synchronization) |
| 14 | Bounded worker finalization left the losing five-second sleep referenced | Every productive one-shot tick could retain five seconds of idle process time | Worker finalization lifetime | Tests asserted the winning worker result; neither `Promise.race` nor the fake clock cancelled the losing deadline | Give the finalization deadline its own abort owner and cancel it after either race outcome; assert no pending fake-clock deadline remains (rung 1 lifetime ownership with rung 2 regression) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial operability and whole-system reviewers of `e4e45bb` | 3 | no |
| Adversarial mechanism review of the first receipt repair | 1 | no |
| Final workflow-contract and evidence review | 2 | no |
| Final exact-head whole-system review | 1 | no |
| Final exact-head Codex outcome review | 2 | no |
| Bounded re-review of the repaired dogfood slice | 1 | no |
| Release-candidate whole-system and simplification review | 1 | no |
| Final release-contract and bounded-exit review | 3 | no |
| Existing tests, lints, and workflow gates before review | 0 | yes |

Self-catch rate: **0 of 14, or 0%** (previous round: **103 of 151, or
68.2%**). This is a 68.2 percentage-point regression. The red tests reproduce
the findings but were written after reviewers named them, so they do not count
as self-catches.

## Recurrence

All fourteen findings recur at class level.

Findings 2 and 4 repeat partial evidence standing in for successful outcome.
Earlier rounds rejected completion markers that survived later aborts and
durable writes standing in for successful returns. Those mechanisms enrolled
their existing engine and review-artifact layers; nothing enrolled a new
product receipt or required its retained representation to be the validated
representation.

Finding 1 repeats the credential-scope class from the final remote review. Its
mechanism pinned checkout behavior in existing workflows, not secret flow in
every new workflow. Finding 3 repeats the repository's lower-bound-as-proxy
class: earlier generated fault matrices required exact transition outcomes,
but the new dogfood receipt surface was not generated or enrolled at birth.
The recurring defect is therefore layer enrollment, not a failure of the
narrow checks to do what they claimed.

Finding 5 repeats the repository's execution-proxy class: command text said
the verifier ran, but the shell's pipeline verdict did not carry its failure.
Finding 6 is a recurrence of finding 1 inside this same round and proves the
first mechanism insufficient. Scanning explicit step environments was a proxy
for credential capability; it could not see GitHub's implicit token context.
The replacement removes the job permission instead of adding another spelling
check.

Finding 7 is another partial-evidence proxy and exposes the boundary of finding
2's repair. Durable parameters are the correct authority for what task was
created, but they are not the milestone requirement itself. The earlier
mechanism proved only that observed span matched stored intent; it did not
prove that stored intent covered seven days. The fixed floor is now a separate
authority shared by default construction and receipt validation.

Finding 8 repeats misattributed evidence: the key named the receipt while the
queue selected the actor that actually received the fault. Finding 9 repeats
successful transport standing in for successful outcome; generic lease-safe
recovery was correct, but the outcome-bearing host erased the worker verdict.
Finding 10 is the next false negative of findings 2 and 7: a minimum span was a
proxy for the exact workload. Durable intent must be compared with configured
intent, not merely trusted because it is durable.

Finding 11 recurs inside finding 8's repair. The key-derived queue fixed who
received the injected death, but injection mode was a proxy for the probe's
longer lifecycle. A route that must survive start, death, recovery, and
verification cannot be derived from the hook that recovery deliberately clears.

Finding 12 is the liveness counterpart of findings 2 and 7: internally
consistent evidence was again a proxy for the milestone, this time without any
requirement that it advance on schedule. Finding 13 repeats finding 5's
execution-contract class: the label "Node 22" stood in for the precise runtime
features and locked tools the commands execute. Finding 14 repeats finding 9 at
the process boundary: a successful returned outcome stood in for a quiescent
bounded host, while an unowned losing promise kept the process alive.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Step-scoped secret environments plus the parsed-workflow test | 2 | Put `${{ secrets.TURSO_AUTH_TOKEN }}` in an action's `with` map; the test checks job and action `env`, so its current assertions still pass |
| Shared normal receipt policy | 1 authority and 2 semantics | Give the checkpoint commit A and the completed-result observation commit B with matching counts and span; the policy returns no errors |
| Exact fault counters and checkpoint attempt | 2 | Give an otherwise exact driver receipt an empty `ownerRunId`; exact counters and `ownerAttempt` still pass |
| One validated-and-retained receipt plus topology test | 1 current flow and 2 future edits | Insert a step after verification that overwrites `dogfood-after.json`; the current producer assertions still pass |
| Explicit workflow `bash` default plus parsed regression | 2 | Begin a run block with `set +o pipefail`; the shell-default test still passes and `false \| tee` exits zero |
| Empty job permissions, anonymous checkout, and built-in-token regression | 1 capability removal and 2 future edits | Pass a separate PAT secret through an action's `with.token`; permissions remain empty and the regression's `github.token` predicate still passes |
| Shared seven-day milestone constant and normal-receipt floor | 1 authority and 2 semantics | Forge or restore two checkpoint timestamps seven days apart without seven days of execution; the receipt has the required stored span and still passes |
| Key-derived isolated fault queue | 1 routing shape and 2 regression | Manually configure ordinary work to use the derived fault queue; the config layer permits the namespace collision even though the shipped workflow never does |
| Exhaustive bounded-host outcome disposition | 1 authority and 2 semantics | Make the observer return well-formed but stale or wrong data without throwing; the worker reports normal suspension, so no failure outcome exists for the host to surface |
| Single durable workload representation plus exact intent comparison | 1 authority and 2 real-runtime cases | Return a checkpoint snapshot naming another repository/ref while the durable workload still matches intent; receipt validation does not compare snapshot metadata to the parameters |
| Persistent probe identity, one validated fault configuration, and workflow topology regression | 1 configuration path and 2 future edits | Export a different `DURABLERUN_DOGFOOD_KEY` inside the recovery run block; the parsed workflow still has no step-level key override, but the recovery queue changes |
| Database-time live-progress deadline | 1 time authority and 2 boundary cases | Forward-shift the task creation or latest-checkpoint timestamp along with database time; the stalled receipt looks fresh and still passes |
| Root Node floor plus README delegation and focused contract test | 1 declaration and 2 synchronization | Add a future dependency requiring Node 24 outside the enrolled dogfood commands; the fixed `>=22.12.0` assertion still passes |
| Owned, abortable worker-finalization deadline | 1 lifetime ownership and 2 regression | Supply a contract-violating `Clock` that ignores the abort signal; its losing five-second timer remains pending after the productive worker returns |

The boundary probes were executed against `01e195d` and returned:

```json
{
  "scopedTestStillPasses": true,
  "contentMismatchErrors": [],
  "emptyOwnerErrors": [],
  "representationTestStillPasses": true
}
```

The two final mechanism probes were executed against `f0ee79e` and returned:

```json
{
  "shellDefaultStillPasses": true,
  "disabledPipefailExit": 0,
  "tokenPredicateStillPasses": true,
  "actionReceivesSecret": true
}
```

The seven-day-floor boundary probe was executed against `2ea505a` and
returned:

```json
{
  "forgedTimestampReceiptErrors": []
}
```

The three final mechanism boundaries were executed against `4e38cda` and
returned:

```json
{
  "faultQueue": "dogfood-fault-fresh-probe",
  "normalQueue": "dogfood-fault-fresh-probe",
  "manualNamespaceCollision": true,
  "silentObserverTickResult": {
    "swept": [],
    "claimed": 1,
    "launched": 0,
    "launchFailed": 0,
    "ended": 1,
    "nextWakeAtEpochMs": 1788092964754,
    "backlog": true
  },
  "storedSnapshot": {
    "repository": "wrong-owner/wrong-repo",
    "ref": "release",
    "commitSha": "stale-commit",
    "treeSha": "stale-tree",
    "committedAt": "2020-01-01T00:00:00Z"
  },
  "silentObserverReceiptErrors": []
}
```

The release-candidate queue-lifecycle reproduction was executed against
`00daaf4` and returned:

```json
{
  "injectedQueue": "dogfood-fault-ref-journal-fault-123-1",
  "recoveryQueue": "dogfood",
  "sameQueue": false,
  "recoveryClaimed": 0,
  "probeStateAfterRecovery": "running"
}
```

The final mechanism-boundary probe was executed against `6044339` and exited
zero:

```json
{
  "shiftedTimingErrors": [],
  "hypotheticalDependencyFloor": ">=24.0.0",
  "nodeContractTestStillPasses": true,
  "customClockPendingAfterTick": [5000]
}
```

Before the green repair, the partial-live probe used a sleeping receipt with
seven user attempts, nine infrastructure retries, duplicate ordinal one, and
zero contiguous checkpoints. It returned no errors. The repair rejects that
probe; it is finding 2's concrete false negative, not a residual.

## Fix-induced defects

**Two of fourteen.** Finding 4 was introduced by the first fix for finding 2:
adding `dogfood:verify` after `dogfood:status` created two independently timed
representations. It was found by re-reviewing the repair as new code before
the green commit, rather than by merely rerunning the original regressions.
Finding 11 was introduced by finding 8's isolation fix: injection moved to a
key-derived queue, but recovery still cleared the value that selected it.
Findings 12 through 14 were not fix-induced: their outcome failures predated
their regressions and repairs. Findings 1 through 3, 5 through 10, and 12
through 14 were already present at `e4e45bb`.

## Evidence

- Red tests: commit `1d26ef9` was run against the behavior in `e4e45bb` and
  produced exactly six failures: two terminal states, incomplete completion,
  two inexact fault receipts, and job-level secret scope.
- Expanded red tests: commit `7cb27ca` was run before its repair and produced
  exactly two failures: corrupt partial-live evidence and a retained receipt
  that was not the validated representation.
- Pipeline red test: commit `d94f945` produced exactly one failure because the
  workflow shell default was absent.
- Token-capability red test: commit `91fc3cb` produced exactly one failure
  because permissions were `contents: read` and the workflow passed
  `github.token`.
- Receipt fixes: commit `01e195d`; its confined `pnpm verify` passed all 89
  test files and 3,234 tests, plus lint, format-check, and typecheck.
- Workflow fixes: commit `f0ee79e`; its confined `pnpm verify` passed all 91
  test files and 3,236 tests, plus lint, format-check, and typecheck.
- Seven-day-floor red test: commit `3646ed7` produced exactly one failure
  because a completed one-cycle, zero-span normal receipt returned no errors.
- Seven-day-floor fix: commit `2ea505a`; its confined `pnpm verify` passed all
  91 test files and 3,237 tests, plus lint, format-check, and typecheck.
- Fault-target red test: commit `34c1d44` produced exactly one failure because
  the fresh probe remained pending while the older normal task was claimed.
- Fault-target fix: commit `7440f9d`; its confined `pnpm verify` passed all 91
  test files and 3,238 tests.
- Host-outcome red test: commit `53a349f` produced exactly one failure because
  an injected `StoreUnavailableError` yielded no rejected tick while the live
  receipt still passed.
- Host-outcome fix: commit `6d0f484`; its confined `pnpm verify` passed all 91
  test files and 3,239 tests.
- Workload-binding red tests: commit `ed76aec` produced exactly three failures:
  wrong-target reuse, one-year-cadence reuse, and receipt intent mismatch.
- Workload-binding fix: commit `4e38cda`; its exact-tree confined `pnpm verify`
  passed all 91 test files and 3,242 tests, plus every lint, format-check, and
  typecheck.
- Probe-lifecycle red test: commit `669913e` produced exactly one failure
  because clearing the one-shot fault changed `dogfood-fault-fresh-probe` back
  to `dogfood`.
- Probe-lifecycle fix: commit `5623f61`; its confined `pnpm verify` passed all
  91 test files and 3,243 tests, plus every lint, format-check, and typecheck.
- Final release-contract red tests: commit `9374554`; the focused run produced
  exactly three failures: the stale live receipt returned `[]`, the manifest
  declared `>=22` instead of the then-required `>=22.9`, and the productive
  worker left `[5000]` in the fake clock's pending deadlines.
- Final release-contract fixes: commit `6044339`; the focused five-file run
  passed all 64 tests, and confined `pnpm verify` passed all 92 test files and
  3,247 tests, plus lint, format-check, and typecheck.
- Operability reviewer verdict: "scheduled normal seven-day job stays green
  after terminal task failure or bad completed evidence; only fault dispatch
  is validated" and "Turso credentials and GITHUB_TOKEN are job-level env,
  inherited by checkout, setup, and upload."
- Whole-system reviewer verdict: "the fault verifier uses lower-bound counters
  and does not assert ownerAttempt, so extra or reclassified failures or a
  checkpoint rewrite can pass."
- Repair-audit verdict: "dogfood-after.json comes from dogfood:status, then
  dogfood:verify opens the database and validates a second status read; the
  retained artifact is not the value the gate validated."
- Final workflow-contract verdict: "all `tee` pipelines fail open" because
  the implicit shell omits `pipefail`, and "the credential scope claim remains
  false for `GITHUB_TOKEN`" because job permissions expose the built-in token
  context to actions.
- Final whole-system verdict: "a completed one-cycle, zero-span normal journal
  passes verification" and a real file-backed task under the reused key exited
  zero even when current workflow configuration requested fifteen cycles and
  seven days.
- Final Codex probes showed `selectedNormal:true` when a due normal task and a
  fresh fault task shared the queue, and showed an injected store outage ending
  with `{claimed:1, ended:1}` while the task stayed running and receipt errors
  remained empty.
- Final bounded outcome review reproduced a file-backed reused key observing
  `wrong-owner/wrong-repo@release` while verification returned no errors, plus
  a two-cycle one-year cadence whose hourly no-progress receipts also passed.
- Release-candidate reviewer verdict: "fault recovery changes queues"; its
  file-backed reproduction left the isolated probe running, recovery claimed
  zero work from the ordinary queue, and final receipt validation reported no
  completion, checkpoint, or relaunch.
- Final release-contract review showed that an aged zero-progress live receipt
  passed, Node 22.0-22.8 could not parse the dogfood entrypoint flag, and a
  productive tick took about 5.27 seconds because its losing finalization timer
  remained referenced. After `6044339`, the same real `systemClock`
  one-checkpoint tick exited zero in 0.26 seconds.
- The active-wait identity concern did not reproduce through any public API
  sequence; its exact stale row required raw corruption, partial restore, or a
  mixed-version writer, so BUILD.md keeps it trigger-gated. Resident HTTP
  lifecycle faults did reproduce, but the selected bounded inline tick never
  enters that transport path; BUILD.md retains them as Phase 2 options.

## Root cause

The new workflow treated successful command execution, artifact existence,
and plausible aggregate counters as interchangeable with the user outcome.
That created separate authorities for scheduled success, retained evidence,
fault recovery, and credential scope. Existing mechanisms belonged to older
engine, mutation, and workflow layers. Nothing required a new outcome-bearing
workflow to define one fail-closed receipt contract, retain exactly the value
it validated, enumerate exact fault outcomes, or declare least-privilege
secret flow. The final misses came from two more proxies: naming a command was
treated as propagating its exit status, and scanning explicit environments was
treated as proving the absence of an implicit job capability. Finally, matching
observations to durable task intent was treated as matching the milestone,
without separately pinning the milestone's minimum duration. The last three
misses repeated the same shape at new boundaries: receipt identity stood in for
fault-target identity, lease-safe reconciliation stood in for host success, and
a minimum durable span stood in for the exact configured workload. The final
fix-induced miss used transient injection mode as a proxy for the probe's
persistent routing identity. The final release-contract misses repeated that
substitution three ways: valid evidence shape stood in for timely progress, a
major-version label stood in for the precise entrypoint and locked-tool floor,
and a resolved race stood in for cancellation of its losing process resource.

## Mechanisms

Built in this PR:

- One receipt-policy module accepts untrusted status input and owns normal and
  fault verdicts; the CLI and workflow use it instead of shell predicates
  (rung 1 authority, rung 2 semantic coverage).
- One durable workload representation carries task type, repository, ref,
  cycles, and interval. Start and receipt verification compare it exactly with
  configured intent, the handler, status reader, and verifier share one parser,
  and all count/span evidence is derived from it; the former derived duplicate
  fields were deleted (rung 1).
- Live receipts validate bounded contiguous progress; completed receipts also
  require full count, minimum seven-day span, completed-result shape, zero user
  attempts, and no failure reason (rung 2).
- Live receipts carry task creation, latest contiguous checkpoint time, and
  current time from the database. One progress rule rolls a deadline from that
  durable anchor by the next configured interval plus two hourly scheduling
  slots, so zero or stalled progress fails closed (rung 1 time authority with
  rung 2 before/after boundary cases).
- Fault receipts require exact driver or worker counter pairs, zero user
  attempts, ordinal one, and owner attempt one (rung 2).
- The validated value is the same value retained for upload, removing the
  second database read (rung 1 for the current flow).
- Every run step uses GitHub's explicit `bash` contract, whose `pipefail`
  behavior makes producer failures authoritative; a parsed-workflow regression
  pins the shell selection (rung 2).
- Turso credentials exist only on database steps. The job has no repository
  permissions and checks out this public repository anonymously; an optional
  dedicated read token exists only on ref-reading worker steps. Parsed-workflow
  regressions pin the current capability topology (rung 1 removal with rung 2
  future-edit coverage).
- One `DOGFOOD_MILESTONE_SPAN_MS` constant owns the seven-day requirement,
  derives the default schedule, and gates every normal live or completed
  receipt regardless of current process configuration (rung 1 authority with
  rung 2 state coverage).
- Fault probes derive an isolated queue from their fresh idempotency key and an
  explicit probe identity that remains set after the one-shot hook is cleared.
  The runtime has no second fault override, so start, injection, recovery, and
  verification share one validated configuration path (rung 1 routing shape
  with rung 2 real-runtime and topology regressions).
- One exhaustive `WorkerOutcome` disposition table owns the bounded host's
  success policy. It preserves advisory reconciliation, then rejects observed
  task, infrastructure, registry, or launcher failure and any generic failed
  launch. The total table is rung 1 authority; the injected-outage regression
  pins the semantic classification at rung 2.
- The root manifest declares the actual `>=22.12.0` floor required by both the
  dogfood entrypoint and locked test toolchain, while README delegates to that
  single declaration. A focused regression pins the observed contract (rung 1
  declaration with rung 2 synchronization).
- Worker finalization owns an abort controller for its bounded deadline and
  aborts that deadline after either race outcome. The losing sleep therefore
  cannot retain a compliant clock or short-lived host, and the fake-clock
  regression requires no pending deadline (rung 1 lifetime ownership with rung
  2 regression).

Deferred (recorded in BUILD.md):

- No finding-level repair is deferred. Resident HTTP launcher, wake, and
  host-shutdown hardening remains outside this milestone because the selected
  scheduled path uses bounded inline ticks. Active-wait identity remains
  trigger-gated absent an external writer, partial restore, mixed-version
  deployment, or public-API counterexample.

## What this round still would not catch

A secret added through an action's `with` expression or a new workflow outside
the focused dogfood test could still ship. A completed result whose observation
contents differ from checkpoint snapshots can pass when counts and span agree.
An exact fault receipt can carry an empty or foreign `ownerRunId`; fresh probe
keys and the current writer make that unreachable without corruption or an
alternate writer, but the verifier does not prove causal run identity. A
future step inserted after verification could overwrite the retained receipt
before upload. Finally, no local gate can establish seven consecutive days of
remote Turso execution; the retained remote receipts remain required elapsed
milestone evidence. A run block can explicitly disable `pipefail` after the
workflow selects `bash`, and a future action can receive a separate token via
`with`; both are demonstrated boundaries of the focused workflow regressions.
Direct corruption, a partial restore, or a database-clock discontinuity can
make stored checkpoint timestamps appear seven days apart without seven days
of continuous execution; the dedicated database and retained per-run receipts
remain the operational evidence around that boundary. A manually configured
normal task can still choose the derived fault queue namespace, and a buggy
observer can return well-formed stale or wrong-target snapshot metadata without
throwing; the shipped workflow and production observer do neither, and the
executed boundary probes above document those limits. A recovery run block can
still export a different key after workflow parsing; the current workflow does
not, and the persistent job-level key is visible in every retained receipt.
Forward-shifted task/checkpoint timing or a database-clock rollback can make a
stalled journal look fresh. A future dependency or entrypoint outside the
focused Node-contract enrollment can raise the real runtime floor without
changing the pinned declaration. A `Clock` implementation that violates its
interrupt contract can retain the finalization timer after abort. The executed
boundary probe documents each limit; none occurs in the selected database,
locked toolchain, or production `systemClock` path.
