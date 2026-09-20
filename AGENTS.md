# durablerun

## Standing rule: confine heavy local runs

Anything that can grow — fuzz runs, TLC, codex, bulk test sweeps — runs
through `scripts/confine.sh`. `scripts/confine.sh` is the single definition of
the live protective memory, swap, CPU, and task limits. A runaway must die
inside that scope rather than taking the box down. `verify:fuzz`,
`verify:fuzz:deep`, `verify:tla`, and `verify:mutations` are pre-wired.

## Overview

A port of Absurd (earendil-works/absurd, Postgres durable execution) to a
pluggable SQL backend (SQLite/libsql, PostgreSQL, and MySQL), driven by
lightweight tick drivers that launch workers on demand.

- **DESIGN.md is the spec.** Every invariant in it is (or becomes) a
  conformance test. Any PR that changes behavior updates DESIGN.md in the same
  diff.
- **BUILD.md is the plan.** Local reproducibility remains the baseline
  (SQLite `file:`/`:memory:`, Postgres in podman, and local driver/workers).
  The hosted-alpha and unattended sleep/resume foundations are complete.
  BUILD.md alone names the current milestone and its exit test. Broader cloud
  infrastructure remains deferred.

## Standing rule: outcome before machinery

The unit of progress is a demonstrated user outcome, not code volume, finding
count, proof-surface size, or process completeness. At any time BUILD.md names
one current milestone with a falsifiable exit test and explicit non-goals.
Order work by its distance from that exit test:

1. Close a reachable hole that can lose, duplicate, or misattribute durable
   state.
2. Remove an operability blocker that prevents useful dogfood, deployment,
   recovery, or diagnosis.
3. Build the minimum product surface needed to run and inspect the milestone.
4. Validate a core promise, such as portability, against a real implementation.
5. Defer everything else until observed use makes it necessary.

Before starting or expanding work, name the milestone evidence it will
produce. If there is none, it is not on the critical path: put it in an options
backlog or delete it. A review note becomes a correctness finding only when it
demonstrates a reachable contract or release-safety violation; nits,
hypothetical bypasses, and defects confined to review machinery are ordinary
tooling work, not product incidents.

The assurance rules below protect outcome-bearing changes; they do not create
independent scope. A finding authorizes the smallest sufficient fix and the
highest existing layer that can catch its class. It does not automatically
authorize a new global lint, mutation corpus, postmortem system, protocol,
abstraction, or full-system rewrite. New assurance machinery must close an
observed gap that existing structural, conformance, simulation, and protocol
checks cannot express, and it must replace or delete lower-value machinery.

Stop when the exit test passes. Do not polish past the milestone, reopen
source-identical work, or widen the plan because another detail is visible.
Keep one outcome-bearing implementation PR in flight; split or defer anything
that makes it difficult to review, land, and dogfood promptly.

## Commands

- `/pr-gate` — the consolidated review gate (.claude/skills/pr-gate). ALL
  review checks, simplify gotchas, dialect traps, and process rules live
  there, each linked to its source lesson. Walk it before every PR push.
- `pnpm verify` — lint + format-check + typecheck + test. Run before every
  commit. CI's `verify` job runs it on every pull request and every push.
- `pnpm test` — vitest across the workspace.
- `pnpm format` — apply Biome formatting.

## Load-bearing engine rules (from DESIGN.md §3.4)

1. Fenced batches keyed on the POST-transition state (batch statements see
   earlier statements' effects — never re-check the consumed pre-condition).
2. awaitEvent/emitEvent must be atomic AND mutually exclusive per dialect
   (SQLite: one batch; PostgreSQL: a row lock in the transaction; MySQL: a
   session named lock around it).
3. Engine time is database time; clients pass relative durations only.
4. Claim has a durable lease/receipt claim token, while mutating batch
   follow-ons key on the claim CAS's per-invocation statement stamp.
5. Checkpoint writes are lease-fenced in both placements.

Activation is a per-claim generation CAS (`activated_gen < claim_gen`), never
a one-shot flag. Sweeps classify lost-launch (reopen, no attempt) vs died
mid-run (`infra_retries`, not `max_attempts`).

## Standing rule: pluggability is law

The engine must work identically over SQLite/libsql, MySQL, and Postgres —
for the scheduler plane now and the run-bookkeeping plane (RunStateStore)
when it lands. Enforcement is structural, not aspirational:

- Engine logic never contains dialect-specific SQL or behavior; everything
  dialect-specific lives in a store-* package behind the port interfaces.
- A dialect is DONE when its StoreFixtureFactory passes the identical
  conformance suite (`@durablerun/conformance`) — no dialect-specific test
  forks, ever.
- The authoritative contract is language-neutral — the shared schema, each
  labeled batch's SQL semantics, the wire formats, the TLA+ spec, and the
  conformance scenarios — so a future port in another language (e.g.
  Rust/Tokio) implementing the same batches is a drop-in peer, proving
  itself against the same scenarios through its own runner. Never let the
  contract live only in TypeScript types.

## Standing rule: spec first for new protocols

Every new protocol area (a set of transitions with cross-actor invariants —
events, cancellation, sagas, the data plane) is modeled in specs/*.tla and
TLC-verified BEFORE its SQL is written. The implementation then maps its
labeled batches onto the verified actions (the ledger enforces the mapping).
A TLC counterexample at spec time is the cheapest bug we will ever find; the
sweep was implemented before it was modeled and the review cycle paid for
that ordering. Small protocol-free features (reads, plumbing) are exempt.

## Standing rule: red test before fix

Every bug fix lands as TWO commits: first a red-test commit — a regression
test that demonstrably FAILS against the buggy code (run it and see red
before committing) — then the fix commit that turns it green. The seams
exist to make every bug class red-testable: pinned SimWorld seeds for
interleavings, fake-now for time, raw fixture SQL for state construction,
seeded IdSource for predictable ids (including deliberate collisions),
buggify for legal-rare paths, FencedBatch for structural fencing. If a bug
cannot be expressed as a red test, that is a missing seam — build the seam
first.

## Standing rule: mutation effort follows the changed guard

CI's `mutations` job runs the unfiltered mutation audit on every pull request
and every push to main, and each mutation runs only its registered test, so a
green `mutations` check is the full-audit evidence. Guard-changing PRs still run
their affected mutation closure locally while iterating, under the rules owned
by `/pr-gate`. A filtered run is never a full audit.

Any change to this cadence, or deviation from a full run required by
`/pr-gate`, needs a PR-body `gate-changes:` entry explaining the old and new
gate and why the property remains protected.

## Standing rule: prevention analysis on every correctness finding

When a bug or design issue affecting correctness is found (by review, sim,
or production), the fix is not complete until we have answered from first
principles: **what invariant, primitive shape, contract rule, or automated
checker would have made this bug inexpressible or automatically caught?** —
and instituted it (a new §3.4-style rule, a sim checker, a conformance case,
a lint). Point fixes without a prevention are not accepted. Precedents:
the one-shot activation flag → "no one-shot flags for re-entrant lifecycles,
latch on generations"; batch fence self-defeat → "fence on the post-state".

The prevention ladder — every fix lands as high as the class can be
expressed, and "humans inspect more carefully" is not a rung:
1. Unwritable: types, structure, single definitions (opaque outcomes,
   eligibility fragments, FencedBatch).
2. Machine-caught at build: lints, generated test enumeration, TLC.
3. Machine-caught at runtime/test: invariants, fault matrix, fuzz floors.
A lesson of the form "review/prompt differently next time" is a red flag,
never a prevention: it means a mechanism gap was found and the net got
patched instead of the hole. Reviews exist to FIND mechanism gaps; every
confirmed finding must produce a mechanism, and the review process itself
is a detection net of last resort.

Two laws from the SDK residual round: (1) EVERY NEW LAYER gets its own
GENERATED fault surface at birth — the store's machinery enumerates batch
labels, so it structurally cannot cover a layer whose units are steps,
passes, and values; "the layer below is verified" is the scoped-review
fallacy in mechanism form (the SDK's surface is the replay-equivalence
harness: generated programs x fault-at-every-call x adversarial values).
(2) SINGLE REPRESENTATION: a value that crosses a serialization boundary
is returned in canonical (serialize-then-parse) form at the SOURCE — two
read paths for one value is where divergence lives.

Tests live at the CLASS altitude, not just the instance: every fixed bug
gets, besides its red test, an extension of the layer that should have
caught the class — an invariant-library checker (run by every sim, scenario,
and fuzz walk), a fuzz-surface op, or a sim actor set. Two structural rules
fall out: (1) every TLA action GUARD has an executable twin (an invariant or
a conformance case) — max_attempts was guarded in the model and enforced
nowhere, and the fuzz ran green while violating it; (2) safety checking
needs a progress floor — a fuzz walk that accomplishes nothing must fail,
or total fence-loss regressions pass invariant-clean.

## Standing rule: every review-caught bug is a SEV

A bug that survives the author's machinery and is found by adversarial
review — or anything later: the nightly volume legs, a sim escape after
merge, production — is a severity incident, not a routine fix. The code's
failure is the small part; the interesting failure is the machinery that
let it through. Every such round produces a complete postmortem, committed
in the same PR under `postmortems/` (copy `postmortems/TEMPLATE.md`), with
the evidence attached to the PR:

- per finding: the failing behavior and its user-visible impact;
- the red-test commit (run and seen failing) and the green-fix commit;
- the review artifact that found it — where it ran and its quoted verdict;
- per finding: the layer that structurally should have caught it, the
  precise reason it could not, and the mechanism instituted, with its rung
  on the prevention ladder;
- what was built now vs deferred (deferrals recorded in BUILD.md).

**The four questions that make it a postmortem and not a changelog.** A
per-finding catalogue is the easy half and answers nothing about whether the
machinery is improving; these are aggregate and they are hostile on purpose:

1. **The detection ledger.** What fraction of the defects did OUR machinery
   find, versus an outside reviewer? That ratio is the headline number.
   Fixes are the cheap part and a review round is not a repeatable process,
   so a rate that is not improving round over round means the mechanisms
   being added are not the ones that matter.
2. **Recurrence.** Is any finding another instance of a class an earlier
   round already instituted a mechanism against? If so that mechanism did
   not work, and saying exactly why is worth more than every fix in the
   round. A class that recurs is evidence its mechanism is a PROXY for the
   property rather than the property.
3. **The false negative of every mechanism.** For each one claimed, exhibit
   the code that still has the bug and still passes it — written and run,
   not imagined. A mechanism whose false negative cannot be written has not
   had its boundary understood. This is the check that stops a point fix
   from wearing the word "mechanism", and it is where a syntactic proxy
   ("the text contains a fence token") is forced to admit it is not the
   semantic property ("the fence gates the write").
4. **Fix-induced defects.** How many findings were caused by the fixes for
   earlier findings in the same round? A repair is a change, and the
   understanding behind it is about the shape the code had before.

The template carries these as required sections, and the attestation script
derives what it demands FROM the template — so tightening the template
tightens the gate, with no second list to keep in sync.

Enforced, not remembered: `scripts/review-attest.sh` refuses to produce the
required `adversarial-review` status unless the PR body declares
`review-findings: <count>` — mandatory, so a round can never silently claim
nothing was found. A nonzero count requires the PR to ADD a postmortem
(added files; touching or renaming an old one does not count) containing
every section of the template, placeholders filled, findings table
non-empty. Every commit that postmortem cites must be on the pull request's
branch, because a commit id does not survive a rebase and a branch moved
after its postmortem was written cites commits it no longer holds. An id in
prose that names no commit of the repository is left alone and printed as not
judged, because a digest is written the same way. The commits under its red
and fix labels must also resolve, be the pull request's own and not ones main
already held, and be ordered, a red before some fix. A commit cited under
both labels is what the label it comes first after says, and first after
both, or after neither, it is refused. A red line may cite no commit, when a
round has no red test of its own and says so, and a fixes line always cites
one. The range is held because the ids of the last postmortem, left in place
by a copy, are all of that except
its own. The `reviews-abandoned: <non-empty reason>` trailer can excuse incomplete review
artifacts, never this gate. Bugs caught by the author's own machinery
before review — TLC at spec time, red tests, fuzz — are the system
working, not SEVs; declaring `review-findings: 0` over a branch with red
commits publicly claims exactly that, the same auditable-if-false class as
the attestation itself.

## Standing rule: a simplify and elegance pass gates every PR

Correctness outranks speed here, and elegance is a correctness input: the
subtle bugs in this repo's history lived in duplicated shapes, method-local
guards, and second read paths — exactly what simplification removes. Before
the final push of every PR, run a dedicated simplification pass over the
FULL branch diff (`/simplify`, or an equivalent walk of the pr-gate
simplify checklist): hoist repeated shapes, collapse second representations,
push guards to chokepoints, delete config nobody can set. Every accepted
simplification lands in the PR; every rejected one gets a written reason in
the PR body. "It works" is not the bar — the implementation should read as
if written by someone who knew everything learned while building it.

## Standing rule: ratchet, and never let a proxy sit where a property fits

The prevention ladder is not a menu to pick a comfortable rung from; it is a
direction of travel. Every round moves at least one thing UP it, and the
target is always rung 1 — a shape the type system, the structure, or a single
definition makes unsayable — because everything below rung 1 is a check that
can be true while the property is false.

That gap has a name here and it is the same defect every time: a PROXY
standing in for the property it approximates. The catalogue, all paid for:

- `hasPositiveFence` checked that a statement's TEXT contains a fence; the
  property is whether the fence REACHES the rows. Four rounds of findings.
- `lint-selftest` found its subjects by FILENAME; the property is which
  checkers the gate runs.
- `gate-lint` counts a textual `scripts/foo` occurrence as execution; the
  property is that the checker EXECUTES. `echo scripts/determinism-lint.sh`
  satisfies it.
- Every clock and counter lint matched one SPELLING; the property is the
  operation. `NOT (EXISTS (` beat `NOT EXISTS (`, `x = 1 + x` beat `x = x + 1`,
  `now()` beat `UNIXEPOCH()`.
- A mechanism with one failing case was treated as proven; the property is
  that it fails for EVERY condition it claims. Two conditions of the wake
  surface could be deleted with all 1728 cases still green.

So when a finding lands, the question is not only "what mechanism catches
this" but "is that mechanism the property, or a picture of it?" If replacement
advances the current milestone, record it in BUILD.md with a named PR; otherwise
put it in the options backlog. PR3.9's SQL-tree work was part of the
milestone that ended on 2026-09-19, and PR3.10's per-condition mutation work
stays deferred.

The ratchet advances by substitution, not accumulation. A stronger structural
guarantee identifies and deletes the lower-rung checks, fixtures, and process
that it makes redundant. A change that moves a check DOWN the ladder —
replacing a structural guarantee with a lint, or a lint with a review
instruction — needs the same written justification as any other loosening of
the gate, in the PR body under `gate-changes:`.
