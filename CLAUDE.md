# absurd-lite

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

## Standing rule: prevention analysis on every correctness finding

When a bug or design issue affecting correctness is found (by review, sim,
or production), the fix is not complete until we have answered from first
principles: **what invariant, primitive shape, contract rule, or automated
checker would have made this bug inexpressible or automatically caught?** —
and instituted it (a new §3.4-style rule, a sim checker, a conformance case,
a lint). Point fixes without a prevention are not accepted. Precedents:
the one-shot activation flag → "no one-shot flags for re-entrant lifecycles,
latch on generations"; batch fence self-defeat → "fence on the post-state".
