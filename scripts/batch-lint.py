#!/usr/bin/env python3
"""Batch-provenance lint (the root-cause mechanism for two whole bug classes).

Six codex review rounds found the SAME two classes proliferating across the
store — "two NOWs in one batch" (a batch reads database time in separate
statements, which drift by ~1ms under real libSQL/MySQL) and "a losing batch
still writes" (a hand-rolled follow-on fires on a PRE-EXISTING post-state a
stale/duplicate/corrupt invocation could have produced). Both exist for ONE
reason: these ops hand-roll `this.db.batch([...])` with per-statement guards
instead of going through FencedBatch, the primitive that mints ONE stamp and
reads ONE now and makes every follow-on key on the winning write BY
CONSTRUCTION. CLAUDE.md already warned "hand-rolled batches ... are how the
losing-sweeper race shipped"; the sweep was migrated to FencedBatch, but
spawn/claim/activate/emit/await never were, and NOTHING FAILED THE BUILD to
force it. This lint is that build failure.

Every raw `this.db.batch(...)` label must be classified. Reads and single
fenced writes are fine. A MULTI-STATEMENT WRITE must use FencedBatch — the
five below are the frozen migration debt (they may only SHRINK; a new label
here fails). A new, UNCLASSIFIED raw-batch label fails until you either make
it a read / single write, or route it through FencedBatch.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent

# Read-only or single-fenced-write batches — raw this.db.batch is fine.
READ_OR_SINGLE = {
    "get-checkpoints", "next-wake", "task-result", "sweep:scan",  # reads
    "expire-lease-now", "driver-heartbeat", "heartbeat", "set-checkpoint",  # single writes
    # Admin / setup infrastructure (spec-ledger [setup]) — not protocol
    # transitions; the migration runner carries its own structural fence
    # (the applied:vN sentinel, schema.ts).
    "admin:now", "admin:set-fake-now", "admin:clear-fake-now",
    "migrate:bootstrap", "migrate:version",
}

# FROZEN migration debt: hand-rolled MULTI-STATEMENT WRITE batches whose
# follow-ons carry the two bug classes. Route through FencedBatch (extended
# for the fan-out / discriminator / spawn shapes) and DELETE from this set.
# This set may only shrink — adding a label here is the smell the lint exists
# to surface in review.
FENCED_DEBT = {"spawn", "claim", "activate", "emit-event", "await-event"}

CLASSIFIED = READ_OR_SINGLE | FENCED_DEBT

violations = 0
for store_dir in sorted(root.glob("packages/store-*/src")):
    for path in sorted(store_dir.glob("*.ts")):
        src = path.read_text()
        labels = re.findall(r"this\.db\.batch\(\s*[\r\n]*\s*'([a-zA-Z0-9:_-]+)'", src)
        for label in sorted(set(labels)):
            if label not in CLASSIFIED:
                rel = path.relative_to(root)
                print(
                    f"{rel}: raw this.db.batch('{label}') is unclassified — a "
                    f"multi-statement WRITE must use FencedBatch (post-state fence, "
                    f"one now); a read or single write must be added to READ_OR_SINGLE "
                    f"in scripts/batch-lint.py"
                )
                violations += 1

if violations:
    sys.exit(1)

if FENCED_DEBT:
    print(
        f"batch-lint: clean (no unclassified raw batches). "
        f"MIGRATION DEBT — route through FencedBatch: {', '.join(sorted(FENCED_DEBT))}"
    )
else:
    print("batch-lint: clean — every store write batch is fenced")
