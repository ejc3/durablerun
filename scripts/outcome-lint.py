#!/usr/bin/env python3
"""Task-outcome read lint: one decoder for a task's observable outcome.

A task's outcome lives in its `state`, `completed_payload`, and `failure_reason`
columns, and core's `decodeTaskResult` is the one decode that refuses a row whose
outcome contradicts its state. A second decoder is where divergence lives: the
hosted inspector once dropped a cancelled task's reason, and the dogfood status
command once reported rows the stores refuse. So no production source outside
the stores, core's `task-result.ts`, and the conformance harness may spell
`completed_payload` or `failure_reason`, in SQL or in code. Core's shared
statements, `packages/core/src/statements/`, and their column descriptor,
`packages/core/src/store-tables.ts`, may name one only as an object key: the
column a statement assigns, or the column the descriptor lists. A property read,
a selected column, and SQL text are refused there as everywhere. Read an outcome
through `getTaskResult`, or select `TASK_RESULT_COLUMNS` and decode the row
with `decodeTaskResult`. The stores own the columns, `task-result.ts` defines
the decoder, and the conformance harness reads raw state as its oracle. Every
TypeScript extension is read, in both its code and its SQL. A .tsx source is
read as raw text, because the lexer does not parse JSX.

Usage: outcome-lint.py [root]   (root defaults to the repo; the self-test
passes a fixture tree, which is how this checker gets checked.)
"""

import re
import sys
from pathlib import Path

# Source checkers are part of the clean-tree gate. Importing their shared
# lexical machinery must not create scripts/__pycache__ in the tree it audits.
sys.dont_write_bytecode = True

from source_lex import sql_template_view, typescript_structure, validated_root

try:
    root = validated_root(
        sys.argv[1:],
        Path(__file__).resolve().parent.parent,
        "outcome-lint.py",
    )
except ValueError as error:
    sys.exit(str(error))

DECODER = Path("packages/core/src/task-result.ts")
# The stores' shared compare-and-sets and the column descriptor they are typed by.
STATEMENTS = Path("packages/core/src/statements")
STORE_TABLES = Path("packages/core/src/store-tables.ts")
SOURCE_SUFFIXES = frozenset({".ts", ".tsx", ".mts", ".cts"})
COLUMNS = re.compile(r"\b(?:completed_payload|failure_reason)\b", re.IGNORECASE)
# What follows an object key, in code with strings and comments blanked.
OBJECT_KEY = re.compile(r"\s*:")

source_paths = tuple(
    path
    for pattern in ("packages/*/src", "packages/*/bin", "apps/*/src", "apps/*/bin")
    for directory in sorted(root.glob(pattern))
    for path in sorted(directory.rglob("*"))
    if path.is_file() and path.suffix in SOURCE_SUFFIXES
)
if not source_paths:
    sys.exit(
        "outcome-lint.py: no production TypeScript sources matched "
        "packages/*/{src,bin} or apps/*/{src,bin}; refusing a vacuous audit"
    )

violations = 0
for path in source_paths:
    relative = path.relative_to(root)
    package = relative.parts[1]
    if relative.parts[0] == "packages" and (
        package.startswith("store-") or package == "conformance"
    ):
        continue
    if relative == DECODER:
        continue
    assigns_only = relative == STORE_TABLES or relative.parent == STATEMENTS
    source = path.read_text()
    if path.suffix == ".tsx":
        # The lexer does not parse JSX text, and JSX text can look like a comment
        # or a string to it. Read the raw source, which can only report more: a
        # comment naming a column counts too.
        views = [source]
    else:
        try:
            views = [typescript_structure(source), sql_template_view(source)]
        except ValueError as error:
            print(f"{relative}: cannot lex TypeScript source: {error}")
            violations += 1
            continue
    seen: set[int] = set()
    for visible in views:
        for match in COLUMNS.finditer(visible):
            if match.start() in seen:
                continue
            seen.add(match.start())
            if (
                assigns_only
                and visible is views[0]
                and OBJECT_KEY.match(visible, match.end())
                and visible[max(match.start() - 1, 0)] != "."
            ):
                continue
            lineno = source.count("\n", 0, match.start()) + 1
            print(
                f"{relative}:{lineno}: task outcome column {match.group(0)} outside "
                "the stores and decodeTaskResult (use getTaskResult, or select "
                "TASK_RESULT_COLUMNS and decode with decodeTaskResult)"
            )
            violations += 1
if violations:
    sys.exit(1)
print(
    "outcome-lint: task outcome columns confined to the stores, decodeTaskResult, "
    "and the columns core's shared statements assign"
)
