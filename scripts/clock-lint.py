#!/usr/bin/env python3
"""SQL clock-source lint — the SQL analog of the determinism lint.

The determinism lint bans ambient time in TypeScript (Date.now, new Date);
this bans it in SQL. Database time enters store SQL through exactly ONE
definition — NOW_MS in time.ts — so that "engine time is database time"
(§3.4 rule 3) has a single home and a batch cannot secretly read a second,
drifting clock via a raw wall-clock function. Any raw clock call outside
time.ts is a violation; use NOW_MS (and, per batch-lint, read it once by
routing writes through FencedBatch).
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
# The sole sanctioned home of a database-clock read.
EXEMPT = {"time.ts"}
CLOCKS = re.compile(
    r"\bunixepoch\b|\bjulianday\b|\bstrftime\b|CURRENT_TIMESTAMP|CURRENT_TIME\b"
    r"|datetime\(\s*'now'|date\(\s*'now'|time\(\s*'now'"
    r"|\bNOW\(\)|\bSYSDATE\b|\bclock_timestamp\b|\bstatement_timestamp\b"
    r"|\btransaction_timestamp\b"
)

violations = 0
for store_dir in sorted(root.glob("packages/store-*/src")):
    for path in sorted(store_dir.glob("*.ts")):
        if path.name in EXEMPT:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            if CLOCKS.search(line):
                print(
                    f"{path.relative_to(root)}:{lineno}: raw wall-clock function in "
                    f"store SQL — database time enters ONLY through NOW_MS (time.ts)"
                )
                violations += 1

if violations:
    sys.exit(1)
print("clock-lint: database time confined to NOW_MS (time.ts)")
