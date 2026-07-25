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

root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
# The sole sanctioned home of a database-clock read.
EXEMPT = {"time.ts"}

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
    "|localtime|localtimestamp|current_timestamp"
)
CLOCKS = re.compile(
    rf"\b(?:{CALLS})\s*\("
    # Bare keyword forms: legal with no parentheses in at least one dialect,
    # so the call-shaped pattern above would miss them. MySQL accepts
    # LOCALTIME and UTC_TIMESTAMP bare; Postgres accepts LOCALTIMESTAMP.
    r"|\b(?:current_timestamp|current_time|current_date"
    r"|localtime|localtimestamp|utc_timestamp|utc_date|utc_time)\b"
    r"|\b(?:datetime|date|time)\s*\(\s*'now'",
    re.IGNORECASE,
)
# Comments describe the rule; they must not trip it.
LINE_COMMENT = re.compile(r"//.*$|/\*.*?\*/")
BLOCK_COMMENT_LINE = re.compile(r"^\s*\*")

violations = 0
for store_dir in sorted(root.glob("packages/store-*/src")):
    for path in sorted(store_dir.rglob("*.ts")):
        if path.name in EXEMPT:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if BLOCK_COMMENT_LINE.match(line):
                continue
            if CLOCKS.search(LINE_COMMENT.sub("", line)):
                print(
                    f"{path.relative_to(root)}:{lineno}: raw wall-clock function in "
                    f"store SQL — database time enters ONLY through NOW_MS (time.ts)"
                )
                violations += 1

if violations:
    sys.exit(1)
print("clock-lint: database time confined to NOW_MS (time.ts)")
