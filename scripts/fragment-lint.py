#!/usr/bin/env python3
"""Eligibility fragments live in ONE file per dialect store (fragments.ts);
no other store source may write an eligibility comparison or a raw state
list. This is structural prevention: the claim once re-derived
task eligibility without the cancellation-deadline predicate, and no reader
noticed for many commits. A predicate that can only be spelled in one place
cannot drift. (schema.ts is definitional DDL and exempt.)"""
import re
import sys
from pathlib import Path

from source_lex import store_typescript_sources, validated_root

# Optional [root]: grade a tree other than this script's own, so the BASE
# branch's copy can be run against a pull request (ci.yml `base-gate`).
try:
    root = validated_root(
        sys.argv[1:],
        Path(__file__).resolve().parent.parent,
        "fragment-lint.py",
    )
    source_paths = store_typescript_sources(root, "fragment-lint.py")
except ValueError as error:
    sys.exit(str(error))

EXEMPT = {"fragments.ts", "schema.ts"}
RULES = [
    (
        re.compile(r"cancel_at_ms\s*(<=|>=|<|>)"),
        "cancellation-deadline comparison outside fragments.ts "
        "(use cancelDue/cancelNotDue/eligibleTask)",
    ),
    (
        re.compile(r"IN\s*\(\s*'(pending|running|sleeping|completed|failed|cancelled)'"),
        "raw state list outside fragments.ts (use ${LIVE} or a new shared fragment)",
    ),
]

violations = 0
for path in source_paths:
    relative = path.relative_to(root)
    if (
        path.name in EXEMPT
        and len(relative.parts) == 4
        and relative.parts[0] == "packages"
        and relative.parts[1].startswith("store-")
        and relative.parts[2] == "src"
    ):
        continue
    for lineno, line in enumerate(path.read_text().splitlines(), 1):
        for pattern, message in RULES:
            if pattern.search(line):
                print(f"{path.relative_to(root)}:{lineno}: {message}")
                violations += 1
if violations:
    sys.exit(1)
print("fragment-lint: eligibility predicates confined to fragments.ts")
