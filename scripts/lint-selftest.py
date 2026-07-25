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
import json
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



def gate(verify: str, extra_scripts: tuple[str, ...] = (), base_gate: bool = True) -> dict[str, str]:
    """A miniature repo for gate-lint: a package.json, a scripts/ dir, a CI file.

    gate-lint grades the SHAPE OF THE GATE rather than the contents of a source
    file, so its fixture is a whole tiny repo. `run` copies gate-lint.py into
    scripts/ and it excludes itself from its own on-disk sweep, so only
    `extra_scripts` stand as checkers here.
    """
    files = {
        "package.json": json.dumps({"scripts": {"verify": verify}}),
        ".github/workflows/ci.yml": "jobs:\n  base-gate:\n" if base_gate else "jobs:\n  verify:\n",
        # Named the way the real self-test names them: quoted, one per case.
        "scripts/lint-selftest.py": "".join(f'BAD_CASES: "{n}"\n' for n in extra_scripts),
    }
    for name in extra_scripts:
        files[f"scripts/{name}"] = "# a checker\n"
    return files


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
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('heartbeat', [
      { sql: `UPDATE runs SET a = 1 WHERE id = ?`, args: [q] },
      { sql: `UPDATE tasks SET state = 'running'`, args: [] },
    ])
  }
}
"""
        ),
        "a label declared a SINGLE write must fail once it grows a second statement",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('sweep:scan', [{ sql: `UPDATE runs SET a = 1`, args: [] }])
  }
}
"""
        ),
        "a label declared a READ must fail when it is not run in read mode",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('set-checkpoint', [
      { sql: `UPDATE runs SET claim_expires_at_ms = ${NOW_MS} + 1 WHERE id = ?`, args: [q] },
      { sql: `INSERT INTO checkpoints (updated_at_ms) VALUES (${NOW_MS})`, args: [] },
    ])
  }
}
"""
        ),
        "two statements of one batch reading the clock is the class-A bug itself",
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
""",
            name="nested/deeper/store.ts",
        ),
        "a file below the package's src directory must not be invisible",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="probe.ts",
        ),
        "an eligibility comparison outside fragments.ts is how the claim lost the deadline predicate",
    ),
    # Every store-source checker must see a file BELOW src/. Three of the four
    # globbed exactly one directory deep, so anything in a subfolder was
    # invisible to them; the recursive fix landed in one and the other three
    # kept the hole. One case each, so a checker cannot regress alone.
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="nested/deep/probe.ts",
        ),
        "a nested file must not be invisible to the fragment checker",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT unixepoch('subsec')`\n", name="nested/deep/probe.ts"),
        "a nested file must not be invisible to the clock checker",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM runs WHERE state IN ('pending','running')`\n",
            name="probe.ts",
        ),
        "a raw state list outside fragments.ts is a second definition of 'live'",
    ),
    (
        "determinism-lint.sh",
        {"packages/core/src/probe.ts": "export const at = Date.now()\n"},
        "ambient time in engine source is the nondeterminism this repo forbids",
    ),
    (
        "user-boundary-lint.sh",
        {"packages/sdk/src/probe.ts": "import { durationToMs } from '@durablerun/core'\n"},
        "the SDK using the raw validator makes bad input retryable instead of fatal",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 something** — DONE. It shipped.\n"
                "  - **A thing we did not do** — deferred to a later round.\n"
            )
        },
        "work parked under a completed entry is dropped silently, because DONE is skipped",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('brand-new-label', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": "---- MODULE Scheduler ----\n====\n",
            "scripts/spec-ledger-map.md": "",
        },
        "a batch label mapped to no TLA action must fail until it is mapped or excluded",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py", "orphan-lint.py"),
        ),
        "a checker sits in scripts/ that the verify chain never runs and nothing declares",
    ),
    (
        "gate-lint.py",
        gate("python3 scripts/a-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py",), base_gate=False),
        "no base-gate job, so the whole gate is graded by the branch under review",
    ),
    (
        "gate-lint.py",
        gate("vitest run", ()),
        "a verify chain that runs no checker makes every other rule here vacuous",
    ),
    (
        "gate-lint.py",
        {
            **gate("python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py", "b-lint.py")),
            "scripts/lint-selftest.py": 'BAD_CASES: "a-lint.py"\n',
        },
        "a checker runs in the gate with nothing proving it can reject anything",
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
        # Spellings a review found the pattern did not know. Each is a real
        # clock in some dialect this engine intends to support, so each is a
        # way to write the class-A bug that the checker would have called
        # clean.
        "UTC_TIMESTAMP(6)",
        "UTC_TIMESTAMP",
        "LOCALTIME",
        "LOCALTIMESTAMP",
        "timeofday()",
        "GETDATE()",
    )
]

# Inputs each lint must ACCEPT. A checker that rejects everything passes every
# case above while being useless — but the real repo already covers that
# direction, because `pnpm verify` runs every checker over it and the build is
# green, so each one demonstrably accepts a large body of correct code. What
# is NOT covered there is the near miss: correct code that looks like a
# violation. Every entry below is a false positive a checker actually produced.
GOOD_CASES = [
    ("batch-lint.py", CLEAN_STORE, "a classified read batch"),
    (
        "gate-lint.py",
        gate("python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py", "b-lint.py")),
        "every checker run by the gate, every one self-tested, base-gate present",
    ),
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
    """Run `lint` against a throwaway tree that looks like the repo.

    The script is COPIED into the fixture tree rather than run from scripts/,
    because several checkers locate the repo from their own path — pointing
    them at a fixture any other way would silently run them over the real
    repo and report whatever it happens to say. The root is also passed as an
    argument for the checkers that accept one; the two agree.
    """
    with tempfile.TemporaryDirectory() as tmp:
        root = tree(Path(tmp), files)
        (root / "scripts").mkdir(parents=True, exist_ok=True)
        copied = root / "scripts" / lint
        copied.write_text((SCRIPTS / lint).read_text())
        runner = ["bash"] if lint.endswith(".sh") else [sys.executable]
        return subprocess.run(
            [*runner, str(copied), str(root)],
            capture_output=True,
            text=True,
            cwd=str(root),
        )


failures = []

# The inventory check. Without it, this file silently covers whichever
# checkers someone remembered: a new lint could be written, wired into the
# gate and believed, with no evidence it can fail — which is exactly how the
# two broken ones shipped. Every checker in scripts/ must appear here with at
# least one input it must REJECT. A checker with no bad case is a checker
# nobody has watched fail.
EXEMPT = {
    # Not checkers: this file, and the review-attestation tool (which has its
    # own test because it talks to git and GitHub).
    "lint-selftest.py",
    "review-attest.sh",
}
covered = {lint for lint, _, _ in BAD_CASES}
for script in sorted(SCRIPTS.iterdir()):
    name = script.name
    if name in EXEMPT or not ("lint" in name or "ledger" in name):
        continue
    if name not in covered:
        failures.append(
            f"{name} has no case here proving it can fail. Add at least one input "
            f"it must reject to BAD_CASES in scripts/lint-selftest.py — a checker "
            f"nobody has watched fail is a checker nobody should believe."
        )

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
