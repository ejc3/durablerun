#!/usr/bin/env python3
"""Batch-label ledger check (see scripts/spec-ledger.sh history): every
labeled batch in the store must be accounted for INSIDE the spec's ledger
block, as a quoted 'label'. Multiline-tolerant harvest; dynamic labels are
declared here and asserted present in the source so they cannot rot."""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
spec = (root / "specs" / "Scheduler.tla").read_text()
src = ""
for path in sorted((root / "packages" / "store-libsql" / "src").glob("*.ts")):
    src += path.read_text()

# Harvest string-literal labels across newlines: batch( 'x' | FencedBatch( 'x'
labels = set(re.findall(r"(?:\.batch\(|new FencedBatch\()\s*[\r\n]*\s*'([a-zA-Z0-9:_-]+)'", src))
# Labels passed through variables must be declared here AND exist in source.
DYNAMIC = {"cancel-task", "sweep:cancel"}
for label in DYNAMIC:
    if f"'{label}'" not in src:
        sys.exit(f"spec-ledger: declared dynamic label '{label}' not found in source")
labels |= DYNAMIC

# The check is scoped to the ledger block and requires the quoted form —
# a bare word elsewhere in the spec (prose, identifiers) counts for nothing.
match = re.search(r"BATCH-LABEL LEDGER.*?-{20,}\n\n", spec, re.S)
if not match:
    sys.exit("spec-ledger: BATCH-LABEL LEDGER block not found in Scheduler.tla")
block = match.group(0)

missing = sorted(label for label in labels if f"'{label}'" not in block)
if missing:
    for label in missing:
        print(
            f"spec-ledger: batch label '{label}' is not in the ledger block "
            f"(map it to an action or exclude it with a reason)"
        )
    sys.exit(1)
print(f"spec-ledger: all {len(labels)} batch labels accounted for (block-scoped)")
