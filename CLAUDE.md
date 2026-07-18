# durablerun

A port of Absurd (earendil-works/absurd, Postgres durable execution) to a
pluggable SQL backend (SQLite/libsql first; MySQL, Postgres later), driven by
lightweight tick drivers that launch workers on demand.

- **DESIGN.md is the spec.** Every invariant in it is (or becomes) a
  conformance test. Any PR that changes behavior updates DESIGN.md in the same
  diff.
- **BUILD.md is the plan.** Local-first: everything through Phase 5 runs on
  this machine (SQLite `file:`/`:memory:`, Postgres/MySQL in podman
  containers, driver/workers as local Node processes). Cloud lands in Phase C.

## Commands

- `/pr-gate` — the consolidated review gate (.claude/skills/pr-gate). ALL
  review checks, simplify gotchas, dialect traps, and process rules live
  there, each linked to its source lesson. Walk it before every PR push.
- `pnpm verify` — lint + format-check + typecheck + test. Run before every
  commit; this is the CI gate until a remote exists.
- `pnpm test` — vitest across the workspace.
- `pnpm format` — apply Biome formatting.

## Load-bearing engine rules (from DESIGN.md §3.4)

1. Fenced batches keyed on the POST-transition state (batch statements see
   earlier statements' effects — never re-check the consumed pre-condition).
2. awaitEvent/emitEvent must be atomic AND mutually exclusive per dialect
   (SQLite: one batch; PG/MySQL: row-lock transaction).
3. Engine time is database time; clients pass relative durations only.
4. Claim is a fenced batch keyed on the per-tick claim token.
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

## Standing rule: confine heavy local runs

Anything that can grow — fuzz runs, TLC, codex, bulk test sweeps — runs
through `scripts/confine.sh` (cgroup scope: MemoryMax 16G default, swap off,
CPUQuota 3200%). A runaway gets OOM-killed inside its scope instead of
taking the box down; memory was the killer the one time it happened.
`verify:fuzz`, `verify:fuzz:deep`, and `verify:tla` are pre-wired.

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

## Standing rule: prevention analysis on every correctness finding

When a bug or design issue affecting correctness is found (by review, sim,
or production), the fix is not complete until we have answered from first
principles: **what invariant, primitive shape, contract rule, or automated
checker would have made this bug inexpressible or automatically caught?** —
and instituted it (a new §3.4-style rule, a sim checker, a conformance case,
a lint). Point fixes without a prevention are not accepted. Precedents:
the one-shot activation flag → "no one-shot flags for re-entrant lifecycles,
latch on generations"; batch fence self-defeat → "fence on the post-state".

Tests live at the CLASS altitude, not just the instance: every fixed bug
gets, besides its red test, an extension of the layer that should have
caught the class — an invariant-library checker (run by every sim, scenario,
and fuzz walk), a fuzz-surface op, or a sim actor set. Two structural rules
fall out: (1) every TLA action GUARD has an executable twin (an invariant or
a conformance case) — max_attempts was guarded in the model and enforced
nowhere, and the fuzz ran green while violating it; (2) safety checking
needs a progress floor — a fuzz walk that accomplishes nothing must fail,
or total fence-loss regressions pass invariant-clean.
