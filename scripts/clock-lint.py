#!/usr/bin/env python3
"""SQL clock-source lint — the SQL analog of the determinism lint.

The determinism lint bans ambient time in TypeScript (Date.now, new Date);
this bans it in SQL. Database time enters store SQL through exactly ONE
definition — NOW_MS in time.ts — so that "engine time is database time"
(rule 3) has a single home and a batch cannot secretly read a second,
drifting clock via a raw wall-clock function. Any raw clock call outside
time.ts is a violation; use NOW_MS (and, per batch-lint, read it once by
routing writes through FencedBatch).

Usage: clock-lint.py [root]   (root defaults to the repo; the self-test
passes a fixture tree, which is how this checker gets checked.)
"""

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

try:
    root = validated_root(
        sys.argv[1:],
        Path(__file__).resolve().parent.parent,
        "clock-lint.py",
    )
    source_paths = store_sql_sources(root, "clock-lint.py")
except ValueError as error:
    sys.exit(str(error))

# SQL is case-insensitive, so this pattern must be. The first version was not,
# and its alternatives were inconsistently cased on top of that — SQLite
# builtins lowercase-only, NOW()/CURRENT_TIMESTAMP uppercase-only — so each
# alternative caught exactly one of the two spellings a developer writes.
# `UNIXEPOCH()` and `now()` both sailed through, and `now()` is the canonical
# Postgres spelling, so the lint was blind to the most common clock call in a
# dialect this engine has promised to support.
#
# Function names must appear AS CALLS. Matching them as bare words instead
# turned prose and identifiers into violations — batch labels like
# `expire-lease-now` and comments reading "not a second NOW" all matched,
# which is the failure that trains people to weaken a checker until it is
# quiet. The bare-keyword forms (CURRENT_TIMESTAMP, CURRENT_TIME) take no
# parentheses in any dialect and so stay word-matched.
CALLS = (
    "unixepoch|julianday|strftime|now|sysdate|clock_timestamp|statement_timestamp"
    "|transaction_timestamp|getdate|timeofday|utc_timestamp|utc_date|utc_time"
    "|localtime|localtimestamp|current_timestamp|curdate|curtime|unix_timestamp"
)
CLOCKS = re.compile(
    rf"\b(?:{CALLS})\s*\("
    # Bare keyword forms: legal with no parentheses in at least one dialect,
    # so the call-shaped pattern above would miss them. MySQL accepts
    # LOCALTIME and UTC_TIMESTAMP bare; Postgres accepts LOCALTIMESTAMP.
    r"|\b(?:current_timestamp|current_time|current_date"
    r"|localtime|localtimestamp|utc_timestamp|utc_date|utc_time)\b"
    # SQLite reads a date function with no argument as the current time, the same
    # as with 'now'.
    r"|\b(?:datetime|date|time)\s*\(\s*(?:'now'|\))",
    re.IGNORECASE,
)
META_KEY = r"(?:[A-Za-z_][A-Za-z0-9_]*\.)?key"
FAKE_NOW = r"'fake_now_ms'"
FAKE_NOW_PREDICATE = (
    rf"(?:\b{META_KEY}\s*=\s*{FAKE_NOW}"
    rf"|{FAKE_NOW}\s*=\s*\b{META_KEY}"
    rf"|\b{META_KEY}\s+(?!NOT\b)IN\s*\([^;)]*{FAKE_NOW})"
)
FAKE_NOW_READ = re.compile(
    rf"\bSELECT\b(?=[^;]*\b(?:FROM|JOIN)\s+meta\b)[^;]*{FAKE_NOW_PREDICATE}",
    re.IGNORECASE,
)
violations = 0
for path in source_paths:
    if path.name == "time.ts" and path.parent.parent.parent == root / "packages":
        continue
    source = path.read_text()
    # `datetime('now')` and the fake-clock row both carry their sentinel as a
    # SQL literal. Preserve only those exact values; every other data string
    # remains blank, so `'NOW()'` cannot impersonate a call.
    try:
        view = sql_file_view if path.suffix == ".sql" else sql_template_view
        visible = view(source, frozenset({"fake_now_ms", "now"}))
    except ValueError as error:
        print(f"{path.relative_to(root)}: cannot lex TypeScript source: {error}")
        violations += 1
        continue
    for match in CLOCKS.finditer(visible):
        lineno = source.count("\n", 0, match.start()) + 1
        print(
            f"{path.relative_to(root)}:{lineno}: raw wall-clock function in "
            f"store SQL — database time enters ONLY through NOW_MS (time.ts)"
        )
        violations += 1
    for match in FAKE_NOW_READ.finditer(visible):
        lineno = source.count("\n", 0, match.start()) + 1
        print(
            f"{path.relative_to(root)}:{lineno}: raw meta/fake_now_ms clock read "
            "in store SQL — database time enters ONLY through NOW_MS (time.ts)"
        )
        violations += 1

if violations:
    sys.exit(1)
print("clock-lint: database time confined to NOW_MS (time.ts)")
