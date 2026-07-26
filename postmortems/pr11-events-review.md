# Postmortem: the events review round (PR #11)

PR #11 added durable events to the engine: `emitEvent` (first-write-wins, one
batch delivers the stored payload to every waiter), `awaitEvent`
(checkpoint-or-register in one batch, with an optional timeout), and the
SDK's replay-aware `ctx.awaitEvent`. The protocol was modeled and TLC-verified
before SQL was written, and the full gate was green. Adversarial review then
found five correctness bugs, including a repeated-await path that durably
returned the wrong result. All five were fixed in the PR; this document
records why the existing machinery could not express them.

## Severity

Without the review, all five would have shipped in a durable-execution engine
whose product promise is that workflow state remains correct.

Worst first, wake fields were matched by event name and never consumed. A task
awaiting the same event twice could instantly re-consume the first delivery,
record a false timeout, and lose a later payload. An unfenced already-emitted
read could tell a zombie worker it had succeeded and let it continue side
effects. Missing task identity in the wait, park, and hit fences admitted
cross-task state. Replay-key collisions joined distinct awaits, and a
permanent invalid timeout was retried until its attempt budget was spent.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Wake fields matched by event name and were never consumed | Repeated same-name awaits durably false-time-out and lose a later payload | Replay-equivalence harness, the SDK's generated fault surface | Its grammar was only `step` or `sleep`; no generated program could express await, timeout, then await again, and the conformance timeout scenario stopped one await short | Enroll event operations in the program generator and tie every `TaskContext` member to the coverage inventory (rungs 1–3) |
| 2 | The already-emitted read in `awaitEvent` had no lease fence | A zombie worker receives a success signal and can continue side effects | Spec ledger; the model fences `AwaitEventHit` | The ledger checked label presence and duplicate tags, not whether mapped action guards had executable twins; the existing zombie test covered only the miss branch | Require every fenced model action to name an executable guard-twin test (rung 2) |
| 3 | `task_id` was absent from the wait insert, park update, and hit-read fences | A confused caller can park or read state across task boundaries | Invariant library; the checkpoint table already had this referential class | That invariant was hand-scoped to checkpoints; nothing enrolled a new table carrying `task_id` and `run_id` | Add the waits referential invariant; schema-derived referential coverage remained deferred (rungs 2–3) |
| 4 | Event names containing `#` or beginning with `$` broke replay-key injectivity | Two distinct awaits can share one durable memo | The previous step-name collision fix | The guard lived inside `step()` instead of at the memo-key construction boundary | Validated `UserName` values and branded key constructors are the only ordinary path into durable replay keys (rung 1) |
| 5 | Invalid `timeoutSeconds` was classified as retryable | `NaN` or a negative duration burns attempts on a call that can never succeed | The previous `sleepFor` validation fix | Validation plus permanent classification lived only in `sleepFor`; each method could omit it | User durations enter through a validator that also classifies invalid values as permanent (rung 1) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Four-lens adversarial review plus independent codex review | 5 | no |
| TLC, conformance, fuzz, replay equivalence, invariants, and lints before review | 0 | yes |

Self-catch rate: **0 of 5, or 0%**. No previous postmortem recorded the metric,
which is itself evidence that detector attribution had not yet become a
standing mechanism.

The five red regressions written after review prove reproducibility; they do
not become self-catches retroactively. Sixteen review reports converged,
after deduplication, on the five tabled defects.

## Recurrence

Findings 4 and 5 were direct recurrences of classes fixed one PR earlier.
Step-name injectivity and permanent duration classification had been called
class fixes, but each was structured as a method-local check. The mechanism
actually said "`step()` validates its name" and "`sleepFor()` classifies its
duration"; the intended property was "every value entering the durable
namespace crosses one validating and classifying boundary." The next context
method therefore reopened both classes without bypassing anything.

Finding 3 repeated the checkpoint cross-task class. Its invariant checked one
named table, not the schema property that a `(task_id, run_id)` relationship
must agree. Finding 2 exposed the same proxy in the spec ledger: an action
name appearing beside a batch label was treated as evidence that every guard
in that action existed in executable SQL. Finding 1 was the new-layer version
of the same gap: the store fault matrix was generated, while the SDK layer had
no generated event program surface at all.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| `TaskContext` coverage inventory plus generated-op inventory | 1 for classification, 2–3 for behavior | `newDurableMethod: 'observed-property'` satisfies the type inventory without adding a generated operation. Even for a method classified `generated`, a generator that emits every op kind once but never repeats one event name passes enrollment while missing finding 1's ordering |
| Spec action `fenceTwin()` inventory | 2, syntactic | A marker `fenceTwin('AwaitEventHit')` placed in a test that exercises only a healthy hit satisfies the ledger; the checker proves marker membership, not that the test makes a stale caller lose |
| Wait referential and event invariants | 3 | One atomic raw batch can insert a foreign wait and delete it before `engineInvariantViolations()` runs. The quiescent state is clean, so a transient cross-task write still passes every state invariant |
| `UserName.parse` plus branded replay-key construction | 1 inside the ordinary typed SDK path | `raw as unknown as UserName` crosses TypeScript's explicit escape hatch, and direct store callers do not use SDK replay keys. The mechanism makes ordinary construction unavailable; it does not turn a type assertion or lower-level port into runtime validation |
| Classified duration validators | 1 inside the SDK boundary | A new task-facing duration passed directly to a lower-level `durationToMs` helper rather than `userDurationToMs` still compiles unless the source lint recognizes that spelling and location. The type cannot distinguish an unclassified raw number by itself |

## Fix-induced defects

**Zero in this round.** All five rows were reported against the events
implementation before the review repairs. Red commit `3d7c453` captured them,
and green commit `af5b356` fixed them. The prevention mechanisms were added in
later commits and the final moved head was reviewed again; defects found in
that later code are recorded separately in
`postmortems/pr11-codex-final-review.md`, not reassigned to this ledger.

## Evidence

- Red tests: commit `3d7c453`, five regressions run and seen failing against
  reviewed implementation `466a65c`.
- Fixes: commit `af5b356`. The recorded post-fix gate was `pnpm verify` plus
  the fuzz sweep, both exit 0; PR CI `verify` and `tla` were green on that
  head.
- Finder: the four-lens workflow produced 16 confirmed reports that
  deduplicated to these five defects; all four lenses independently converged
  on finding 1. An independent codex review of the same tree said
  **“do not merge”** and cited reproducible lost-wake, cross-task, and
  stale-wake failures.
- Prevention commits were `a6e556a` for guard twins and event invariants and
  `136d319` for the SDK input chokepoint and generated event programs.
- The historical evidence retained no separate rejected-claim catalogue for
  this first round. The auditable claim is therefore limited to the 16
  confirmed reports and five deduplicated defects; this retrofit does not
  invent disconfirmations that were not recorded.

## Root cause

The repo's enrollment machinery was keyed on one unit: the batch label,
harvested mechanically from store source. New labels auto-enrolled in the
fault matrix and spec ledger, but events grew the system along four other
axes: SDK context methods, spec guard conditions, schema columns carrying
identity, and claim-carried consumable wake state. No inventory harvested
those axes, so each checker silently under-covered the new surface while
reporting green.

The repeated key and duration defects make the structural lesson sharper: a
class fix generalizes only when new code cannot function without passing
through its fixed point. Prose saying that guards travel to new boundaries
did not create such a point.

## Mechanisms

Built in PR #11:

- Ledger guard-twin inventory (rung 2, `a6e556a`): every fenced TLA action
  requires an executable marker, and stale markers are rejected.
- SDK entry chokepoint and generated event coverage (rungs 1–3, `136d319`):
  context members are classified, generated members must appear in the
  program grammar, user names and times use classified validators, and event
  programs cover inline hits, external wakes, and timeouts.
- Event invariants (rung 3, `a6e556a`): wait/task referential integrity,
  surviving waits for fired events, and wake-payload provenance, each with a
  constructed corruption that proves it can fire.

Deferred (recorded in `BUILD.md`):

- A stale-fence fault column in the generated fault matrix.
- A fence-surface check tying every caller identity to every write fence.
- Structural wake-to-await binding. This was later completed by `wake_step`
  during the final-head review.
- Schema-derived enrollment for every referential relationship; the hand-added
  waits invariant did not make that general.

## What this round still would not catch

A generated SDK method can be enrolled while its decisive ordering or value
combination is absent. A `fenceTwin` marker can exist in a test that never
proves stale refusal. Quiescent invariants cannot see corruption created and
erased within one atomic batch. The runtime validators can be bypassed by an
explicit type assertion or a lower-level store caller. Most importantly, the
round still carried an event wake identified by event name rather than by the
exact await step; the generated programs detected instances, but the
representation did not yet make stale wake consumption unwritable.
