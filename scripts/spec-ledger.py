#!/usr/bin/env python3
"""Batch-label ledger check (see scripts/spec-ledger.sh history): every
labeled batch in the store must be accounted for INSIDE the spec's ledger
block, as a quoted 'label'. Multiline-tolerant harvest; dynamic labels are
declared here and asserted present in the source so they cannot rot."""
import json
import re
import sys
from pathlib import Path

from source_lex import (
    batch_calls,
    batch_label,
    store_typescript_sources,
    validated_root,
)

arguments = list(sys.argv[1:])
if arguments.count("--labels") > 1:
    sys.exit("spec-ledger.py: --labels may appear at most once")
labels_only = "--labels" in arguments
if labels_only:
    arguments.remove("--labels")
try:
    root = validated_root(
        arguments,
        Path(__file__).resolve().parent.parent,
        "spec-ledger.py",
    )
    source_paths = store_typescript_sources(root, "spec-ledger.py")
except ValueError as error:
    sys.exit(str(error))

# Variable labels are a closed, reason-bearing surface. Template migration
# labels are setup trace addresses rather than protocol actions; their SQL
# shape is independently fenced and checked by batch-lint.
DYNAMIC = {"cancel-task", "sweep:cancel"}
OPAQUE_LABELS = {
    ("packages/store-libsql/src/store.ts", "fenced", "label"): DYNAMIC,
}
SETUP_LABEL_FAMILIES = {
    (
        "packages/store-libsql/src/admin.ts",
        "raw",
        "migrate:v",
    ): "migration versions are setup trace addresses, not protocol actions",
}

labels: set[str] = set()
all_source = ""
for path in source_paths:
    rel = path.relative_to(root).as_posix()
    source = path.read_text()
    all_source += source
    try:
        calls = batch_calls(source)
    except ValueError as error:
        sys.exit(f"{rel}: {error}")
    for call in calls:
        parsed = batch_label(source, call)
        if parsed.kind == "static":
            labels.add(parsed.value)
            continue
        identity = (rel, call.kind, parsed.value)
        dynamic = OPAQUE_LABELS.get(identity)
        if dynamic is not None:
            labels.update(dynamic)
            continue
        if parsed.kind == "template" and identity in SETUP_LABEL_FAMILIES:
            continue
        sys.exit(
            f"{rel}: batch call shape is opaque: "
            f"cannot resolve {call.kind} label {parsed.value!r}"
        )

# The declared variable values must remain present in their defining source;
# otherwise an old classification could answer for a newly opaque call.
for label in DYNAMIC:
    if f"'{label}'" not in all_source:
        sys.exit(f"spec-ledger: declared dynamic label '{label}' not found in source")
labels |= DYNAMIC

if labels_only:
    print(json.dumps(sorted(labels)))
    sys.exit(0)

spec = (root / "specs" / "Scheduler.tla").read_text()

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

# Every label's ledger line must carry exactly one duplicate-semantics tag —
# the spec-side twin of the fault matrix's 'duplicate' column. A label whose
# replay semantics nobody classified is a label whose replay semantics
# nobody thought about.
TAGS = ("[cas-fenced]", "[receipt]", "[read]", "[setup]")
untagged = []
for label in sorted(labels):
    line = next((ln for ln in block.splitlines() if f"'{label}'" in ln), "")
    if sum(1 for t in TAGS if t in line) != 1:
        untagged.append(label)
if untagged:
    for label in untagged:
        print(
            f"spec-ledger: label '{label}' has no (or ambiguous) duplicate-semantics "
            f"tag — exactly one of {', '.join(TAGS)} required on its ledger line"
        )
    sys.exit(1)
# Every modeled guard needs an EXECUTABLE twin (CLAUDE.md class rule): for
# each ledger line mapping a label to actions with [cas-fenced], every
# ACTION named must be claimed by a fenceTwin('Action') marker inside a
# test file — placed on the test that exercises that action's fence/guard
# refusal (zombie or replay gets zero rows / an error, never success).
# Per-ACTION, not per-label, is load-bearing: 'await-event' had a twin for
# its miss branch while the hit branch shipped an unfenced success read.
fenced_actions = set()
for ln in block.splitlines():
    m = re.search(r"'[a-zA-Z0-9:_-]+'\s*->\s*([A-Za-z0-9_/ ]+?)\s*\[cas-fenced\]", ln)
    if m:
        fenced_actions.update(a.strip() for a in m.group(1).split("/"))
tests = ""
for path in sorted(root.glob("packages/*/test/**/*.ts")):
    tests += path.read_text()
# The conformance suite's tests live in src/ (run via the per-store runner).
for path in sorted(root.glob("packages/conformance/src/**/*.ts")):
    tests += path.read_text()
marked = set(re.findall(r"fenceTwin\('([A-Za-z0-9_]+)'\)", tests))
untwinned = sorted(a for a in fenced_actions if a not in marked)
if untwinned:
    for action in untwinned:
        print(
            f"spec-ledger: fenced action '{action}' has no executable twin — "
            f"add fenceTwin('{action}') to the test that proves its "
            f"fence/guard refuses a stale or duplicate caller"
        )
    sys.exit(1)
stale_marks = sorted(m for m in marked if m not in fenced_actions)
if stale_marks:
    for mark in stale_marks:
        print(
            f"spec-ledger: fenceTwin('{mark}') marks an action that is not a "
            f"[cas-fenced] mapping in the ledger — remove or rename it"
        )
    sys.exit(1)

print(
    f"spec-ledger: all {len(labels)} batch labels accounted for and "
    f"duplicate-classified; all {len(fenced_actions)} fenced actions "
    f"have executable twins (block-scoped)"
)
