# Postmortem: the events review round (PR #11)

PR #11 added durable events to the engine: `emitEvent` (first-write-wins,
one batch delivers the stored payload to every waiter) and `awaitEvent`
(checkpoint-or-register in one batch, with an optional timeout), plus the
SDK's replay-aware `ctx.awaitEvent`. The implementation followed the
spec-first rule — the protocol was modeled and TLC-verified before any SQL
was written — and the full gate (lint, ledger, types, ~250 tests, fuzz,
exhaustive-safety TLC) was green. The adversarial review round then found
five real correctness bugs, one of them severe. All five are fixed in this
PR; this document records why they got through and what now prevents each
class.

## Severity

Without the review, all five would have shipped in a durable-execution
engine whose whole product is "your workflow's state is correct":

1. **Stale wake re-consumption (worst).** A run's wake fields were matched
   by event name alone and never invalidated. A task that awaited the same
   event name twice (retry loops — the natural usage) instantly re-consumed
   the first delivery: a durable false timeout, and a late-emitted payload
   silently lost. Wrong results, durably recorded, on a mainstream pattern.
2. **Unfenced success signal to a zombie.** The "already emitted" read in
   `awaitEvent` had no lease fence, so a worker whose lease had been taken
   over could read a success and keep executing side effects.
3. **Foreign `task_id` accepted.** The wait-row insert, the park update,
   and the hit read did not bind `task_id` into their fences — a confused
   caller could park state across task boundaries.
4. **Replay-key injectivity broken by event names.** Names containing `#`
   or a `$` prefix collided with the replay memo namespace — two distinct
   awaits could share one memo.
5. **Invalid timeout retried forever.** A `NaN`/negative `timeoutSeconds`
   was classified as a retryable failure, burning attempts on a bug that
   can never succeed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Wake fields matched by name, never consumed | Durable false timeouts; lost late payloads | Replay-equivalence harness (the SDK's generated fault surface) | Its program grammar was `step \| sleep` only — no generated program could contain await → timeout → await again; the conformance timeout scenario stopped one await short | Enroll event ops in the program generator; ctx-method inventory gate so future methods cannot stay un-enrolled (rungs 2–3) |
| 2 | "Already emitted" read unfenced | Zombie worker gets a success signal | Spec ledger — the model fences `AwaitEventHit` explicitly | The ledger checks label presence and duplicate tags, never that the SQL implements the mapped action's guards; the one zombie test exercised only the miss branch | Guard-twin check in the ledger: every fenced spec ACTION must name an executable twin test (rung 2) |
| 3 | `task_id` unbound in wait/park/hit fences | Cross-task state corruption | Invariant library — the identical class already existed as the checkpoint cross-task invariant | That invariant was hand-scoped to the checkpoints table; nothing makes new tables carrying (task_id, run_id) inherit the referential check | Waits referential invariant now; schema-driven generation of such checks next (rungs 2–3) |
| 4 | `#`/`$` in event names break memo-key injectivity | Two awaits share one durable memo | The class fix from one PR earlier (step names) | The fix was landed inside `step()` — method-local; the key-construction seam stayed open to raw strings | Branded key constructors: user names enter the memo namespace only through a validating constructor (rung 1) |
| 5 | Invalid timeout classified retryable | Attempts burned on a permanent bug | The class fix from one PR earlier (`sleepFor` validation) | Same shape: the validation-plus-classification wrap lived only in `sleepFor` | User knobs enter the context only through a validator that is also the classifier (rung 1) |

## Evidence

- Red tests: commit `3d7c453` — five regression tests, run and seen failing
  against the reviewed implementation (commit `466a65c`).
- Fixes: commit `af5b356`; gate after fix: `pnpm verify` and the fuzz sweep
  both exit 0, and the PR's CI (verify + tla) is green on that head.
- Finders: a four-lens review workflow (16 confirmed findings after
  adversarial verification, deduplicating to the five defects above — all
  four lenses independently converged on defect 1) and an independent codex
  review of the same tree (its line references target `a3fc7c4`, the tests
  commit directly atop the implementation) whose verdict was **"do not
  merge"**, citing reproducible lost-wake, cross-task, and stale-wake
  failures. The verbatim finding titles and the codex verdict are attached
  to the PR as a review-evidence comment.
- The prevention analysis behind the table above was produced by a
  dedicated root-cause pass over the machinery as it existed at `466a65c`.

## Root cause

The repo's enrollment machinery is keyed on exactly one unit: the batch
label, harvested mechanically from store source. New store labels therefore
auto-enroll into the fault matrix and the spec ledger — but the events
round grew the system along four other axes: SDK context methods, spec
guard conditions, schema columns carrying identity, and claim-carried
consumable state (the wake fields). No inventory harvests any of those
axes, so every generator and checker silently under-covered the new surface
while reporting green.

Defects 4 and 5 sharpen the lesson: both are literal repeats of classes
fixed one PR earlier, whose fixes were committed as class fixes but
structured as instance fixes — the guard lived in the method that had the
bug, so the class had no chokepoint, and the next method re-decided (by
default: no). A class fix generalizes only when new code cannot function
without passing through the fixed point.

Three of the five escaped through rules that already existed as PROSE in
the PR gate ("guards need executable twins", "fences bind the full argument
surface", "rules travel to new boundaries") with no harvester enforcing
them. Prose rules are where this codebase's repeat bugs live.

## Mechanisms

Built in this PR:

- **Ledger guard-twin check** (rung 2, commit `a6e556a`): the spec ledger
  already maps each batch label to its TLA actions; the checker now
  requires every fenced action to name an executable twin test
  (`fenceTwin('Action')` markers, checked per action with stale markers
  refused), so a modeled-but-unenforced guard fails the build. Run before
  tagging, it listed all 13 fenced actions red. Defect 2's class.
- **SDK entry chokepoint + generated event coverage** (rungs 1–3, commit
  `136d319`): user names and knobs enter the context only through core's
  classified validators (UserName.parse / userDurationToMs / userEpochMs,
  lint-enforced); durable replay keys are only constructible from
  validated names; a context-method inventory gate ties the TaskContext
  interface to the replay-equivalence program generator, which now
  generates emits, awaits (inline, park-then-wake, timeout), absolute
  sleeps, and an adversarial legal-name corpus; and a generated
  invalid-input enumeration asserts permanent failure at attempt 1 for
  every method's bad inputs. Defects 1, 4, 5 as classes, for every future
  context method.
- **Event invariants incl. the waits referential check** (rung 3, commit
  `a6e556a`): wait-cross-task (the checkpoints precedent the waits table
  never inherited), wait-for-fired-event (a surviving waiter for an
  emitted event IS a lost wakeup), and wake-payload-mismatch (payload
  provenance), each proven to fire on constructed corruption. Defect 3's
  class.

Deferred (recorded in BUILD.md):

- A stale-fence fault column in the generated fault matrix (per-label
  zombie probes with snapshot comparison) — overlaps the guard-twin
  mechanism; needs per-label zombie-construction plumbing.
- A fence-surface lint (every caller-supplied identity parameter appears in
  every write fence of its batch, or carries an explicit waiver) — high
  noise risk; the generated referential invariants provide the detection.
- Structural wake-consumption binding (a wake bound to the awaiting step
  rather than consumed by a flag) — subsumed for now by generated event
  programs that exercise repeated awaits.
