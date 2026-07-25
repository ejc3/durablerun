#!/usr/bin/env python3
"""Batch-provenance lint (the root-cause mechanism for two whole bug classes).

Six codex review rounds found the SAME two classes proliferating across the
store — "two NOWs in one batch" (a batch reads database time in separate
statements, which drift by ~1ms under real libSQL/MySQL) and "a losing batch
still writes" (a hand-rolled follow-on fires on a PRE-EXISTING post-state a
stale/duplicate/corrupt invocation could have produced). Both exist for ONE
reason: these ops hand-roll `this.db.batch([...])` with per-statement guards
instead of going through FencedBatch, the primitive that mints ONE stamp and
makes every follow-on key on the winning write BY CONSTRUCTION. CLAUDE.md
already warned "hand-rolled batches ... are how the losing-sweeper race
shipped"; the sweep was migrated to FencedBatch, but spawn/claim/activate/
emit/await never were, and NOTHING FAILED THE BUILD to force it. This lint is
that build failure.

THE HARVEST IS TOTAL. Every `this.db.batch(` call site must be accounted for,
and its label must be a single-quoted literal unless it is declared in
DYNAMIC below. The first version of this lint matched only literal labels and
therefore could not see a label built from a variable or a template string —
so a hand-rolled multi-statement write with two raw clock reads passed it,
the spec ledger, and the label-inventory test simultaneously. It was not
hypothetical: `migrate:v${version}` had been shipping in admin.ts the whole
time, invisible to all three. A checker that silently skips what it cannot
parse is worse than no checker, because it is believed.

Usage: batch-lint.py [root]   (root defaults to the repo; the self-test
passes a fixture tree, which is how this checker gets checked.)
"""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent

# Read-only batches — no write to fence.
READS = {
    "get-checkpoints", "next-wake", "task-result", "sweep:scan", "admin:now",
}

# Single-statement writes — one statement cannot key on another's post-state.
SINGLE_WRITES = {
    "expire-lease-now", "heartbeat", "admin:set-fake-now", "admin:clear-fake-now",
    "migrate:version",
}

# Multi-statement writes whose stamp is a token the CALLER already holds, so
# they cannot mint a fresh one. Each needs a written reason, because "it is
# fine" is exactly the judgement this lint exists to stop being made silently.
TOKEN_FENCED = {
    # DESIGN.md rule 5: the worker's claim token IS the stamp, minted at claim
    # and unique to that worker. It must survive the batch because the worker
    # keeps running, so a per-batch stamp is not available here.
    "set-checkpoint": "claim token is the stamp (rule 5)",
    # Observability only; nothing in the protocol reads the drivers table, and
    # re-applying the same beat is the same row.
    "driver-heartbeat": "advisory liveness row, replay-identical",
    # The migration runner carries its own structural fence: an applied:vN
    # sentinel INSERT whose key violation rolls the whole batch back.
    "migrate:bootstrap": "migration sentinel fence (schema.ts)",
}

# FROZEN migration debt: hand-rolled MULTI-STATEMENT WRITE batches whose
# follow-ons carry the two bug classes. Route through FencedBatch and DELETE
# from this set. It may only shrink — adding a label here is the smell the
# lint exists to surface in review.
FENCED_DEBT = {"spawn", "claim", "activate", "emit-event", "await-event"}

# Call sites whose label is legitimately computed. Each names the file and the
# prefix it produces, so the label still has to be classified above; only the
# "must be a literal" rule is waived.
DYNAMIC = {
    ("packages/store-libsql/src/admin.ts", "migrate:v"): (
        "one batch per migration version, labelled by version"
    ),
}
DYNAMIC_LABELS = {"migrate:v*"}

CLASSIFIED = READS | SINGLE_WRITES | set(TOKEN_FENCED) | FENCED_DEBT | DYNAMIC_LABELS

CALL = re.compile(r"this\.db\.batch\(")
STATIC_LABEL = re.compile(r"this\.db\.batch\(\s*[\r\n]*\s*'([a-zA-Z0-9:_-]+)'")

violations = []
for store_dir in sorted(root.glob("packages/store-*/src")):
    for path in sorted(store_dir.glob("*.ts")):
        rel = str(path.relative_to(root))
        src = path.read_text()
        # Total accounting: every call site is either a literal we can read or
        # a declared dynamic one. Nothing is skipped.
        sites = len(CALL.findall(src))
        labels = STATIC_LABEL.findall(src)
        declared = [d for d in DYNAMIC if d[0] == rel]
        dynamic_here = sum(src.count(f"`{prefix}") for _, prefix in declared)
        if len(labels) + dynamic_here != sites:
            violations.append(
                f"{rel}: {sites} this.db.batch( call sites but only "
                f"{len(labels)} literal + {dynamic_here} declared-dynamic labels — "
                f"a computed label is invisible to this lint, the spec ledger and "
                f"the label inventory at once. Make it a literal, or declare it in "
                f"DYNAMIC in scripts/batch-lint.py."
            )
        for label in sorted(set(labels)):
            if label not in CLASSIFIED:
                violations.append(
                    f"{rel}: raw this.db.batch('{label}') is unclassified — a "
                    f"multi-statement WRITE must use FencedBatch (post-state fence); "
                    f"a read or single write is declared in READS / SINGLE_WRITES, "
                    f"and a caller-token-fenced write in TOKEN_FENCED with a reason, "
                    f"in scripts/batch-lint.py"
                )

for v in violations:
    print(v)
if violations:
    sys.exit(1)

if FENCED_DEBT:
    print(
        f"batch-lint: clean (every batch call site accounted for). "
        f"MIGRATION DEBT — route through FencedBatch: {', '.join(sorted(FENCED_DEBT))}"
    )
else:
    print("batch-lint: clean — every store write batch is fenced")
