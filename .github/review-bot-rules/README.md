# durablerun review-bot rules

The shared source of truth for CodeRabbit (`.coderabbit.yaml`) and Greptile
(`.greptile/config.json`). Each file defines ONE class of defect, the incident
that proves it matters, the failure shapes a reviewer can decide from a diff,
and — as importantly — the nearest legitimate shapes that must NOT be flagged.
A rule that flags correct code gets switched off, and a switched-off rule
protects nothing.

Every rule here was written from `postmortems/`, not from taste. If you cannot
name the finding a rule exists to catch, it does not belong in this directory.

The global CodeRabbit path instruction is canonical here too, so an extra or
contradictory path entry cannot drift beside the error checks:

<!-- review-bot-global:start -->
Apply durablerun's custom review rules from `.github/review-bot-rules/` as they exist in the feature branch under review. A pull request can edit or remove these in-repo instructions, so they are a head-owned detection net rather than base-owned enforcement. This project's standing rules are in CLAUDE.md and its spec is DESIGN.md; a finding should name the MECHANISM that would have made the defect unwritable or machine-caught, not only the line to change — a fix without a prevention is not accepted here.
<!-- review-bot-global:end -->

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
the two configs honest: every rule file owns one marked canonical active
synopsis and one marked canonical scope list, both bots carry the exact
synopsis, Greptile carries the exact scopes, every reference resolves to a
file, every scope matches a tracked path, and this README lists every rule.

**Configuration provenance is not independent of the pull request.**
[CodeRabbit uses the feature branch under review](https://docs.coderabbit.ai/getting-started/yaml-configuration),
and [Greptile reads settings from the source branch of the PR](https://www.greptile.com/docs/code-review/greptile-json-reference).
A pull request can therefore weaken its own in-repo review rules, delete them,
or edit the checker that calls the configuration coherent. No instruction in
one of those same files can override how the hosted service chooses its
configuration.

Only policy enforced outside the pull request — for example CodeRabbit central
configuration or Greptile organization-enforced rules — can close that
provenance hole. No such external control is represented by this repository.
The `base-gate` job protects local checker composition and runs base-owned
checker code; it does not change either review bot's source-branch behavior.

## Turning these on

Neither service can be installed from a checkout: both are GitHub Apps, so
installation is an OAuth flow in a browser and needs repo admin.

1. **CodeRabbit** — https://coderabbit.ai, "Sign in with GitHub", authorize the
   app, select `ejc3/durablerun`. For a pull-request review it automatically
   uses `.coderabbit.yaml` from the feature branch under review. Free for
   open-source, which this repo now is; the free tier is
   rate-limited (roughly 200 files and 4 pull-request reviews per hour), and
   `pre_merge_checks.custom_checks` — which this config uses, in `mode: error` —
   is otherwise a paid feature, so confirm it is active on the plan you land on
   rather than assuming the checks are running.
2. **Greptile** — https://greptile.com, install the GitHub App on the same repo.
   It reads `.greptile/config.json` from the source branch of the PR. $30 per
   seat per month including 50 reviews, then $1 per review; pre-Series-A
   companies under $2M revenue get 50% off. Watch that per-review meter on a
   repo with a lot of pull requests.
3. **Treat in-repo rules as head-owned detection.** Landing them on `main`
   makes them the starting point for later branches, but it does not stop a
   later pull request from changing the copy that reviews that same request.
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
