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

# The spellings have ONE definition: `CLOCK_FUNCTIONS` and `CLOCK_SPELLING` in the tree
# rules, where every entry has a registered mutation. This lint kept a second list by hand,
# and a name added to one and not the other shipped in whichever scan lacked it. It reads
# the list of the tree it audits, so the two scans cannot differ, and it refuses to run on
# a list it cannot read, because a pattern built from nothing matches nothing.
#
# What the list's shape holds, each learned from a lint that was blind without it. SQL is
# case-insensitive, so the pattern is. Function names must appear AS CALLS: matched as bare
# words, batch labels like `expire-lease-now` and comments reading "not a second NOW" were
# violations, which is the failure that trains people to weaken a checker until it is
# quiet. The bare keywords take no parentheses in some dialect and stay word-matched: MySQL
# accepts LOCALTIME and UTC_TIMESTAMP bare, PostgreSQL accepts LOCALTIMESTAMP, and every
# dialect accepts CURRENT_TIMESTAMP. `now()` is PostgreSQL's usual spelling and `UNIXEPOCH()`
# SQLite's, and the first pattern here missed both by their case. SQLite reads a date function
# with no argument as the current time, and the literal 'now' reads the clock whatever function
# takes it: SQLite's timediff('now', ...), PostgreSQL's 'now' cast to a timestamp.
TREE_RULES = "packages/core/src/sql-tree.ts"
# The one arm this lint cannot apply. The tree refuses the bare word in a fragment, where
# nothing may name the test clock's row. A store's admin statements write that row by name,
# so here FAKE_NOW_READ below refuses a read of it and admits the write.
TREE_ONLY_ARM = r"\bfake_now_ms\b"


def list_lines(text: str, opening: str, closing: str, shape: str, what: str) -> list[str]:
    """What each line of one list holds. A list that is missing, empty, or has a line of another shape is refused."""
    found = re.search(rf"^{opening}\n(.*?)^{closing}\n", text, re.S | re.M)
    lines = [] if found is None else found.group(1).splitlines()
    held = [re.fullmatch(shape, line) for line in lines]
    if not held or None in held:
        raise ValueError(f"{TREE_RULES}: {what}")
    return [line.group(1) for line in held]


def tree_clock_spellings(text: str) -> str:
    """The tree rule's clock spellings as one pattern, read from the source that defines them."""
    functions = list_lines(
        text,
        r"const CLOCK_FUNCTIONS = \[",
        r"\]",
        r"  '([a-z_]+)',",
        "CLOCK_FUNCTIONS is not a list of one quoted name to a line",
    )
    arms = [
        arm.replace("${CLOCK_FUNCTIONS.join('|')}", "|".join(functions))
        for arm in list_lines(
            text,
            r"export const CLOCK_SPELLING = new RegExp\(\n  \[",
            r"  \]\.join\('\|'\),",
            r"    String\.raw`(.*)`,",
            "CLOCK_SPELLING is not a list of one String.raw arm to a line",
        )
    ]
    # Whatever else an arm interpolates is text this lint cannot write out. Left in, Python
    # reads it as a dollar sign and literal braces, the arm matches nothing, and every
    # spelling it holds passes.
    unread = [arm for arm in arms if "${" in arm]
    if unread:
        raise ValueError(f"{TREE_RULES}: an arm of CLOCK_SPELLING interpolates what this lint cannot read: {unread[0]}")
    if arms.count(TREE_ONLY_ARM) != 1:
        raise ValueError(f"{TREE_RULES}: CLOCK_SPELLING no longer holds the arm {TREE_ONLY_ARM}")
    return "|".join(arm for arm in arms if arm != TREE_ONLY_ARM)


try:
    CLOCKS = re.compile(tree_clock_spellings((root / TREE_RULES).read_text()), re.IGNORECASE)
except (OSError, ValueError, re.error) as error:
    sys.exit(f"clock-lint.py: cannot read the clock spellings: {error}")
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
