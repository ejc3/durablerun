#!/usr/bin/env python3
"""Checkers must be checked.

Every lint in this repo guards a contract rule, and every one of them was
written, reviewed, wired into the gate, and believed — without a single test
proving it can FAIL. That is how two of them shipped broken in the same PR
that introduced them:

  - batch-lint matched only single-quoted literal labels, so any label built
    from a variable or a template string was invisible. A hand-rolled
    multi-statement write containing two raw clock reads — both of the bug
    classes these lints exist to prevent — passed batch-lint, the spec ledger
    and the label inventory simultaneously.
  - clock-lint's pattern was case-sensitive while SQL is not, and its
    alternatives were inconsistently cased, so `UNIXEPOCH()` and `now()` both
    passed. `now()` is the canonical Postgres spelling.

Neither could be caught by review of the lint's own source, because both look
correct: the bug is in what the pattern does NOT match, and absence is exactly
what human reading is worst at. So each lint now gets a fixture tree of
known-bad inputs and an assertion that it exits nonzero on each — plus a
known-good tree it must accept, because a checker that fails everything is
just as useless as one that fails nothing.

Run by `pnpm verify`. A new lint belongs in LINTS below with at least one bad
fixture per rule it claims to enforce.
"""
import subprocess
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent


def tree(root: Path, files: dict[str, str]) -> Path:
    """Materialize a fake store package so a lint can be pointed at it."""
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


def store(body: str, name: str = "store.ts") -> dict[str, str]:
    return {f"packages/store-fixture/src/{name}": body}


CLEAN_STORE = store(
    """
export class S {
  async ok(q: string) {
    await this.db.batch('sweep:scan', [{ sql: `SELECT 1`, args: [] }], 'read')
  }
}
"""
)

# Each case: (lint script, fixture files, why it must be rejected).
BAD_CASES = [
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    const label = `probe-write`
    await this.db.batch(label, [
      { sql: `UPDATE tasks SET a = 1`, args: [] },
      { sql: `UPDATE runs SET b = 2`, args: [] },
    ])
  }
}
"""
        ),
        "a label held in a variable hides the whole batch from the lint",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string, v: number) {
    await this.db.batch(`migrate:v${v}`, [{ sql: `UPDATE tasks SET a = 1`, args: [] }])
  }
}
""",
            name="other.ts",
        ),
        "a template-literal label is only allowed where it is declared",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('brand-new-write', [{ sql: `UPDATE tasks SET a = 1`, args: [] }])
  }
}
"""
        ),
        "an unclassified literal label must fail until it is classified",
    ),
] + [
    (
        "clock-lint.py",
        store(f"const SQL = `SELECT {spelling} AS t`\n"),
        f"raw clock call {spelling!r} must be rejected in any casing",
    )
    for spelling in (
        "unixepoch('subsec')",
        "UNIXEPOCH('subsec')",
        "now()",
        "NOW()",
        "CURRENT_TIMESTAMP",
        "current_timestamp",
        "strftime('%s','now')",
        "STRFTIME('%s','now')",
        "datetime('now')",
        "DATETIME('now')",
        "julianday('now')",
        "JULIANDAY('now')",
        "clock_timestamp()",
        "CLOCK_TIMESTAMP()",
        "SYSDATE()",
        "sysdate()",
    )
]

# Inputs each lint must ACCEPT — a checker that rejects everything passes the
# cases above while being useless, and the false positives here are real ones
# the stricter clock pattern produced on its first run.
GOOD_CASES = [
    ("batch-lint.py", CLEAN_STORE, "a classified read batch"),
    ("clock-lint.py", CLEAN_STORE, "a batch label containing the word 'now'"),
    (
        "clock-lint.py",
        store("// derived from the CAS above at ITS single NOW — not a second NOW\n"),
        "prose about the rule is not a violation of it",
    ),
    (
        "clock-lint.py",
        store("const SQL = `UPDATE runs SET x = 1 WHERE id = 'expire-lease-now'`\n"),
        "an identifier ending in 'now' is not a clock call",
    ),
]


def run(lint: str, files: dict[str, str]) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        root = tree(Path(tmp), files)
        return subprocess.run(
            [sys.executable, str(SCRIPTS / lint), str(root)],
            capture_output=True,
            text=True,
        )


failures = []
for lint, files, why in BAD_CASES:
    result = run(lint, files)
    if result.returncode == 0:
        failures.append(f"{lint} ACCEPTED a bad input — {why}\n    {next(iter(files.values())).strip()[:120]}")

for lint, files, why in GOOD_CASES:
    result = run(lint, files)
    if result.returncode != 0:
        failures.append(f"{lint} REJECTED a good input — {why}\n    {result.stdout.strip()[:200]}")

for f in failures:
    print(f"lint-selftest: {f}")
if failures:
    sys.exit(1)
print(f"lint-selftest: {len(BAD_CASES)} bad inputs rejected, {len(GOOD_CASES)} good inputs accepted")
