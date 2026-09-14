#!/usr/bin/env python3
"""Task-outcome read lint: one decoder for a task's observable outcome.

A task's outcome lives in its `state`, `completed_payload`, and `failure_reason`
columns, and core's `decodeTaskResult` is the one decode that refuses a row whose
outcome contradicts its state. A second decoder is where divergence lives: the
hosted inspector once dropped a cancelled task's reason, and the dogfood status
command once reported rows the stores refuse. So no production source outside
the stores, core's `task-result.ts`, and the conformance harness may spell
`completed_payload` or `failure_reason`, in SQL or in code. Read an outcome
through `getTaskResult`, or select `TASK_RESULT_COLUMNS` and decode the row
with `decodeTaskResult`. The stores own the columns, `task-result.ts` defines
the decoder, and the conformance harness reads raw state as its oracle. Core's
`contract.ts` names the columns as write-policy data, so only its code is read.

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
COLUMN_DATA = Path("packages/core/src/contract.ts")
COLUMNS = re.compile(r"\b(?:completed_payload|failure_reason)\b", re.IGNORECASE)

source_paths = tuple(
    path
    for pattern in ("packages/*/src", "packages/*/bin", "apps/*/src", "apps/*/bin")
    for directory in sorted(root.glob(pattern))
    for path in sorted(directory.rglob("*.ts"))
    if path.is_file()
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
    source = path.read_text()
    try:
        views = [typescript_structure(source)]
        if relative != COLUMN_DATA:
            views.append(sql_template_view(source))
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
            lineno = source.count("\n", 0, match.start()) + 1
            print(
                f"{relative}:{lineno}: task outcome column {match.group(0)} outside "
                "the stores and decodeTaskResult (use getTaskResult, or select "
                "TASK_RESULT_COLUMNS and decode with decodeTaskResult)"
            )
            violations += 1
if violations:
    sys.exit(1)
print("outcome-lint: task outcome columns confined to the stores and decodeTaskResult")
