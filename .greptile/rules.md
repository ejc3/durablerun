# durablerun custom review rules

Apply durablerun's custom review rules from `.github/review-bot-rules/` as they exist in the source branch of the PR. A pull request can edit or remove these in-repo instructions, so they are a head-owned detection net rather than base-owned enforcement. This project's standing rules are in CLAUDE.md and its spec is DESIGN.md; a finding should name the MECHANISM that would have made the defect unwritable or machine-caught, not only the line to change — a fix without a prevention is not accepted here.

durablerun is a durable task-execution engine over SQLite/libSQL. Every store
operation is ONE atomic batch of SQL statements, and most of this repo's
defect history is a statement acting on rows or instants it cannot justify.
The rules below are written from the postmortems, each naming the finding it
exists to catch.

- **Checks must be able to fail** — `checks-must-be-able-to-fail.md`
- **Dialect portability: the engine layer must be spellable in three dialects** — `dialect-portability.md`
- **Prose that describes behaviour must be true of the diff that ships** — `docs-track-behaviour.md`
- **A fence must gate every write, not merely appear in it** — `fence-gates-every-write.md`
- **Every guard and every stated invariant needs an executable twin** — `guard-needs-an-executable-twin.md`
- **Mechanism, not point fix — every correctness fix lands at a rung of the prevention ladder** — `mechanism-not-point-fix.md`
- **Re-entrant lifecycles latch on a generation, never on a flag** — `no-one-shot-flags.md`
- **One instant per batch** — `one-instant-per-batch.md`
- **Red test before fix** — `red-test-before-fix.md`
- **Single representation: one definition, one read path** — `single-representation.md`
- **Test determinism: advance a clock, don't wait on one** — `test-determinism.md`

Two things worth knowing before reviewing here:

- The bar for a finding is not "this could be better". It is "this shape has
  shipped a silent correctness bug in this repo, here is the one it shipped".
  Each rule file carries that incident.
- Every rule has an Allowed section listing the nearest legitimate shapes,
  drawn from code currently in the tree. Check it before reporting.
