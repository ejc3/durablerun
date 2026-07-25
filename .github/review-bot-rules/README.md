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

Neither service can be installed from a checkout: both are GitHub Apps, so
installation is an OAuth flow in a browser and needs repo admin.

1. **CodeRabbit** — https://coderabbit.ai, "Sign in with GitHub", authorize the
   app, select `ejc3/durablerun`. It reads `.coderabbit.yaml` from the default
   branch. Free for open-source, which this repo now is; the free tier is
   rate-limited (roughly 200 files and 4 pull-request reviews per hour), and
   `pre_merge_checks.custom_checks` — which this config uses, in `mode: error` —
   is otherwise a paid feature, so confirm it is active on the plan you land on
   rather than assuming the checks are running.
2. **Greptile** — https://greptile.com, install the GitHub App on the same repo.
   It reads `.greptile/config.json`. $30 per seat per month including 50 reviews,
   then $1 per review; pre-Series-A companies under $2M revenue get 50% off.
   Watch that per-review meter on a repo with a lot of pull requests.
3. **Both read config from the DEFAULT BRANCH.** This directory has to reach
   `main` before either bot applies any of it. Until then they review with
   their stock behaviour.
4. **Make them gate.** `main`'s required contexts are today
   `["verify", "tla", "adversarial-review"]`. Add each bot's check name once you
   can see what it posts. `mode: error` and `statusCheck: true` are already set,
   so they block the moment the contexts include them; until then they comment
   only, which is worth having on its own.

Nothing in `pnpm verify` changes. These are hosted reviewers; the local gate
neither runs nor needs them, and `scripts/review-bot-lint.py` checks only that
the configuration is coherent.

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
