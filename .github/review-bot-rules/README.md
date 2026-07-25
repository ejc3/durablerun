# durablerun review-bot rules

The shared source of truth for CodeRabbit (`.coderabbit.yaml`) and Greptile
(`.greptile/config.json`). Each file defines ONE class of defect, the incident
that proves it matters, the failure shapes a reviewer can decide from a diff,
and — as importantly — the nearest legitimate shapes that must NOT be flagged.
A rule that flags correct code gets switched off, and a switched-off rule
protects nothing.

Every rule here was written from `postmortems/`, not from taste. If you cannot
name the finding a rule exists to catch, it does not belong in this directory.

**These bots are a detection net, not a prevention.** CLAUDE.md's ladder is
explicit that a probabilistic grader is not a rung: the mechanisms that make a
class *unwritable* or *machine-caught* live in `packages/` and `scripts/`.
What these add is an independent reader — and the detection ledger in
`postmortems/pr3.6-fence-provenance.md` says that is exactly where this
project's findings have come from: 37 of 44, against 0 from the entire
automated suite. So a finding from one of these bots should not end in a fix.
It should end in the mechanism that would have made the fix unnecessary, and
the rules are written to ask for that.

`scripts/review-bot-lint.py` (run by `pnpm verify`) keeps this directory and
the two configs honest: every rule referenced by both bots, every reference
resolving to a file, every scope matching something that exists, and this
README listing every rule.

**Review bots must apply the BASE branch's configuration.** A pull request
that edits these rules must not weaken its own review. Both configs say so,
and it is worth being precise that this is an INSTRUCTION to a hosted service,
not a mechanism we control — unlike `.github/workflows/ci.yml`'s `base-gate`
job, which deterministically runs the base branch's checkers against the pull
request's tree.

## Turning these on

The configuration is complete and checked; the two services are not installed.
Neither can be installed from a checkout — both are GitHub Apps needing repo
admin and a billing decision:

1. Install **CodeRabbit** (coderabbit.ai) and **Greptile** (greptile.com) on
   `ejc3/durablerun`. Both read their config from the default branch, so this
   directory must reach `main` before either does anything.
2. Add their check names to the protected-branch contexts on `main`, which
   today are `["verify", "tla", "adversarial-review"]`. Until that is done both
   bots comment without blocking, which is worth having on its own — but
   `pre_merge_checks` in `.coderabbit.yaml` is set to `mode: error` and
   `statusCheck` is true in `.greptile/config.json`, so they are ready to gate
   the moment the contexts are added.
3. Nothing in `pnpm verify` changes. These are hosted reviewers; the local gate
   neither runs nor needs them, and `scripts/review-bot-lint.py` checks only
   that the configuration is coherent.

A note on cost, since it is the reason this is a decision and not a default:
both services charge per contributor and review every pull request by default.
`auto_review.drafts` is off so drafts are skipped.

Current rules:

- `checks-must-be-able-to-fail.md`
- `dialect-portability.md`
- `docs-track-behaviour.md`
- `fence-gates-every-write.md`
- `guard-needs-an-executable-twin.md`
- `mechanism-not-point-fix.md`
- `no-one-shot-flags.md`
- `one-instant-per-batch.md`
- `red-test-before-fix.md`
- `single-representation.md`
- `test-determinism.md`
