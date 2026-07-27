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

# Source checkers are part of the clean-tree gate. Importing their shared
# lexical machinery must not create scripts/__pycache__ in the tree it audits.
sys.dont_write_bytecode = True

from source_lex import (
    sql_file_view,
    sql_template_view,
    store_sql_sources,
    validated_root,
)

# Optional [root]: grade a tree other than this script's own, so the BASE
# branch's copy can be run against a pull request (ci.yml `base-gate`).
try:
    root = validated_root(
        sys.argv[1:],
        Path(__file__).resolve().parent.parent,
        "fragment-lint.py",
    )
    source_paths = store_sql_sources(root, "fragment-lint.py")
except ValueError as error:
    sys.exit(str(error))

EXEMPT = {"fragments.ts", "schema.ts"}
STATE_LITERALS = frozenset(
    {
        "pending",
        "running",
        "sleeping",
        "completed",
        "failed",
        "cancelled",
    }
)
STATE_LITERAL_SOURCE = "|".join(
    re.escape(state) for state in sorted(STATE_LITERALS)
)
RULES = [
    (
        re.compile(r"\bcancel_at_ms\b\s*(?:<=|>=|<|>)", re.IGNORECASE),
        "cancellation-deadline comparison outside fragments.ts "
        "(use cancelDue/cancelNotDue/eligibleTask)",
    ),
    (
        re.compile(
            r"\bIN\s*\(\s*"
            rf"'(?:{STATE_LITERAL_SOURCE})'",
            re.IGNORECASE,
        ),
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
    source = path.read_text()
    try:
        view = sql_file_view if path.suffix == ".sql" else sql_template_view
        visible = view(source, STATE_LITERALS)
    except ValueError as error:
        print(f"{path.relative_to(root)}: cannot lex TypeScript source: {error}")
        violations += 1
        continue
    for pattern, message in RULES:
        for match in pattern.finditer(visible):
            lineno = source.count("\n", 0, match.start()) + 1
            print(f"{path.relative_to(root)}:{lineno}: {message}")
            violations += 1
if violations:
    sys.exit(1)
print("fragment-lint: eligibility predicates confined to fragments.ts")
