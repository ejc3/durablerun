#!/usr/bin/env python3
"""Batch-provenance lint (the root-cause mechanism for two whole bug classes).

Six review rounds found the SAME two classes proliferating across the store —
"two clock reads in one batch" (a batch reads database time in separate
statements, which drift by about a millisecond under real libSQL and MySQL)
and "a losing batch still writes" (a hand-rolled follow-on fires on a
PRE-EXISTING post-state that a stale, duplicate or corrupt invocation could
have produced). Both existed for one reason: those operations hand-rolled
`this.db.batch([...])` with per-statement guards instead of going through
FencedBatch, the primitive that stamps each statement and makes every
follow-on key on the winning write BY CONSTRUCTION. Nothing failed the build
to force the migration. This lint is that build failure.

THE HARVEST IS TOTAL, AND IT IS ABOUT SHAPE, NOT NAMES. Every
`this.db.batch(` call site is parsed: its label, how many statements it
carries, whether it is a read, and how many of those statements read the
clock. A label is a claim about shape, and this checks the claim — the
previous version trusted the label, so a batch classified as a single write
could quietly grow a second, unfenced statement and stay green forever. It
also globbed one directory deep, so anything under a nested `src/` folder was
invisible.

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
    "migrate:version",
}

# Single-statement writes — one statement cannot key on another's post-state,
# and cannot disagree with itself about the time.
SINGLE_WRITES = {
    "expire-lease-now", "heartbeat", "admin:set-fake-now", "admin:clear-fake-now",
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

# Batches allowed to read the clock in more than one statement. Every entry is
# a standing bug of class A unless the reason says why the drift is harmless,
# so this stays as close to empty as the engine allows.
MULTI_CLOCK = {
    # Two read-only discovery scans. A task sitting exactly on a deadline can
    # appear in one and not the other; the per-item batch that follows
    # re-checks every predicate under its own fence, so the only effect is
    # that the item waits for the next tick.
    "sweep:scan": "read-only discovery; every item is re-checked under its own fence",
}

# Call sites whose label is legitimately computed. Each names the file and the
# prefix it produces, so the label still has to be classified above; only the
# "must be a literal" rule is waived.
DYNAMIC = {
    ("packages/store-libsql/src/admin.ts", "migrate:v"): (
        "one batch per migration version, labelled by version"
    ),
}
DYNAMIC_LABELS = {"migrate:v*"}

# Every protocol transition now goes through FencedBatch, so this set is
# empty and stays empty: there is no longer a place to record new debt.
FENCED_DEBT: set[str] = set()

CLASSIFIED = READS | SINGLE_WRITES | set(TOKEN_FENCED) | FENCED_DEBT | DYNAMIC_LABELS

CALL = re.compile(r"this\.db\.batch\(")
STATIC_LABEL = re.compile(r"\A\s*'([a-zA-Z0-9:_-]+)'")
DYNAMIC_LABEL = re.compile(r"\A\s*`([a-zA-Z0-9:_-]*)\$\{")


def call_body(src: str, open_paren: int) -> str:
    """The text between `batch(` and its matching `)`."""
    depth = 0
    for i in range(open_paren, len(src)):
        ch = src[i]
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
            if depth == 0:
                return src[open_paren + 1 : i]
    return src[open_paren + 1 :]


violations = []
for store_dir in sorted(root.glob("packages/store-*/src")):
    for path in sorted(store_dir.rglob("*.ts")):
        rel = str(path.relative_to(root))
        src = path.read_text()
        for match in CALL.finditer(src):
            body = call_body(src, match.end() - 1)
            static = STATIC_LABEL.match(body)
            dynamic = DYNAMIC_LABEL.match(body)
            if static:
                label = static.group(1)
            elif dynamic and (rel, dynamic.group(1)) in DYNAMIC:
                label = dynamic.group(1) + "*"
            else:
                violations.append(
                    f"{rel}: this.db.batch( with a label this lint cannot read "
                    f"({body[:40].strip()!r}) — a computed label is invisible to "
                    f"this lint, the spec ledger and the label inventory at once. "
                    f"Make it a literal, or declare it in DYNAMIC in "
                    f"scripts/batch-lint.py."
                )
                continue

            if label not in CLASSIFIED:
                violations.append(
                    f"{rel}: raw this.db.batch('{label}') is unclassified — a "
                    f"multi-statement WRITE must use FencedBatch (post-state fence); "
                    f"a read or single write is declared in READS / SINGLE_WRITES, "
                    f"and a caller-token-fenced write in TOKEN_FENCED with a reason, "
                    f"in scripts/batch-lint.py"
                )
                continue

            # The label is a CLAIM about the batch's shape. Check the claim.
            # Clock reads are counted per STATEMENT, not per occurrence: the
            # clock expression is stable within one statement (measured), so
            # using it three times there is one instant. Drift only happens
            # BETWEEN statements.
            segments = body.split("sql:")[1:]
            statements = len(segments)
            clocks = sum(1 for s in segments if "${NOW_MS}" in s)
            is_read = re.search(r"'read'\s*,?\s*\Z", body.strip()) is not None

            if label in SINGLE_WRITES and statements != 1:
                violations.append(
                    f"{rel}: '{label}' is declared a SINGLE write but carries "
                    f"{statements} statements — a second statement has no fence "
                    f"on the first one's post-state. Route it through FencedBatch, "
                    f"or reclassify it in scripts/batch-lint.py."
                )
            if label in READS and not is_read:
                violations.append(
                    f"{rel}: '{label}' is declared a READ but is not run in 'read' "
                    f"mode — it can write, and nothing fences it."
                )
            if statements > 1 and clocks > 1 and label not in MULTI_CLOCK:
                violations.append(
                    f"{rel}: '{label}' reads the clock in {clocks} places across "
                    f"{statements} statements. Two statements of one batch see "
                    f"DIFFERENT clocks on a real backend, so any pair of values "
                    f"that must agree eventually will not. Derive the later ones "
                    f"from what the first statement wrote, or declare the batch in "
                    f"MULTI_CLOCK in scripts/batch-lint.py with a reason."
                )

for v in violations:
    print(v)
if violations:
    sys.exit(1)

print("batch-lint: clean — every batch call site is classified and matches its declared shape")
