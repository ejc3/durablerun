#!/usr/bin/env python3
"""The gate is not trusted to remember what it is made of.

Every other checker here guards the engine. This one guards the gate, because
the gate had two holes that nothing could see:

1. NOTHING KNEW WHAT `pnpm verify` ACTUALLY RUNS. No script read package.json,
   so a checker could be written, fixtured, believed, and never invoked. The
   self-test would confirm it rejects bad input; the gate would never call it.
   A checker nobody runs is worse than no checker, for the same reason a
   checker that cannot fail is: it is believed.

2. THE SELF-TEST FOUND ITS SUBJECTS BY NAME. Its inventory skipped anything
   whose filename lacked "lint" or "ledger", so a future `fence-audit.py` or
   `invariant-check.py` was silently exempt from the requirement to prove it
   can fail. A naming convention is not structure.

Both are the same mistake the engine keeps making in miniature: deriving a
set from a proxy (a filename, an assumption) instead of from the thing itself.
So the set is derived from the gate. Every executable under scripts/ is either
reachable from the `verify` chain or declared below with a reason -- the total
harvest rule, which this repo already applies to batch labels and spec entries.

What this CANNOT do, stated plainly because the next reader will assume
otherwise: it runs from inside the branch it is checking, so a change that
deletes a checker AND its entry here passes. That hole is closed in CI by
running the BASE branch's copy of the gate against the pull request's tree --
see .github/workflows/ci.yml, job `base-gate`. This script is what makes that
job's job small.
"""

import json
import re
import sys
from pathlib import Path

# Optional [root]: grade a tree other than this script's own. `--base <tree>`
# additionally asserts that the graded tree's gate is a SUPERSET of the gate in
# <tree>. Run from the base checkout against the pull request's tree, that is
# the check a branch cannot edit its way past, because the copy doing the
# comparing is not the copy under review.
_args = [a for a in sys.argv[1:] if not a.startswith("-")]
OWN = Path(__file__).resolve().parent.parent
ROOT = Path(_args[0]).resolve() if _args else OWN
BASE = Path(_args[1]).resolve() if len(_args) > 1 else None

# Executables under scripts/ that the gate deliberately does NOT run, each with
# the reason. Adding a line here is the honest way to keep something out of the
# gate; deleting a checker without one is what this script exists to catch.
#
# It lives in the SCRIPT and not in the tree on purpose. When the base branch's
# copy grades a pull request, the declarations it applies are the base's, so a
# change cannot exempt a checker from the base gate by declaring it away in the
# same diff. The cost is that these names describe this script's own repo, so
# the staleness rule below only applies when it is grading that repo.
NOT_IN_GATE = {
    "confine.sh": "a cgroup wrapper other commands run under, not a check",
    "tla.sh": "TLC model checking — its own CI job and `pnpm verify:tla`, far too slow for every commit",
    "mutation-probe.py": "edits sources and runs the suite once per mutation; a deliberate audit, not a gate",
    "review-attest.sh": "runs at PR time against a pull request, not against a working tree",
    "session-state.sh": "reports what is still running; an operator tool with nothing to assert",
}


def gate_checkers(root: Path) -> tuple[set[str], list[str]]:
    """Every scripts/ file reachable from `pnpm verify`, by following the chain."""
    scripts = json.loads((root / "package.json").read_text())["scripts"]

    seen: set[str] = set()
    found: set[str] = set()
    order: list[str] = []

    def expand(name: str) -> None:
        if name in seen or name not in scripts:
            return
        seen.add(name)
        body = scripts[name]
        for ref in re.findall(r"pnpm (?:run )?([\w:-]+)", body):
            expand(ref)
        for path in re.findall(r"scripts/([\w.-]+)", body):
            if path not in found:
                found.add(path)
                order.append(path)

    expand("verify")
    return found, order


def selftest_subjects(root: Path) -> set[str]:
    """The checkers lint-selftest.py exercises, read out of its own source."""
    src = (root / "scripts" / "lint-selftest.py").read_text()
    return set(re.findall(r"scripts/([\w.-]+)", src)) | set(
        re.findall(r"[\"']([\w.-]+\.(?:py|sh))[\"']", src)
    )


def main() -> int:
    problems: list[str] = []

    on_disk = {
        p.name
        for p in (ROOT / "scripts").iterdir()
        if p.is_file() and p.suffix in {".py", ".sh"}
    }
    in_gate, order = gate_checkers(ROOT)

    # 1. Every checker on disk is either run by the gate or declared out of it.
    for name in sorted(on_disk - in_gate - set(NOT_IN_GATE) - {Path(__file__).name}):
        problems.append(
            f"scripts/{name} is not run by `pnpm verify` and is not declared in "
            f"NOT_IN_GATE.\n    A checker nothing runs is believed and never "
            f"consulted. Wire it into the verify chain, or add it to "
            f"NOT_IN_GATE in {Path(__file__).name} with the reason."
        )

    # 2. Nothing is declared out of the gate that the gate actually runs, and
    #    nothing is declared that no longer exists.
    #
    #    The staleness half only means something in a tree these names describe.
    #    Graded against an unrelated tree -- a self-test fixture, or a repo laid
    #    out differently -- every one of them is "missing" and the rule says
    #    nothing. Requiring at least one to be present is what tells those two
    #    situations apart: in a tree that has some of them, one gone is a real
    #    deletion; in a tree that has none, they were never this tree's.
    declarations_apply = any(n in on_disk for n in NOT_IN_GATE)
    for name, why in NOT_IN_GATE.items():
        if name in in_gate:
            problems.append(
                f"scripts/{name} is declared NOT_IN_GATE ({why!r}) but the verify "
                f"chain runs it. One of the two is wrong."
            )
        if name not in on_disk and declarations_apply:
            problems.append(
                f"NOT_IN_GATE names scripts/{name}, which does not exist. "
                f"A stale exemption hides the next file that takes its name."
            )

    # 3. Every checker the gate runs must be exercised by the self-test, so
    #    "it can fail" is proven for the whole gate and not for a subset the
    #    self-test happened to find by filename.
    subjects = selftest_subjects(ROOT)
    for name in sorted(in_gate - subjects):
        if name == "lint-selftest.py":
            continue
        problems.append(
            f"scripts/{name} runs in the gate but scripts/lint-selftest.py never "
            f"exercises it, so nothing shows it can REJECT anything. Give it a "
            f"bad input it must refuse, or an EXEMPT entry saying why it has none."
        )

    # 4. The gate is reachable at all: a `verify` that runs no checker would
    #    satisfy every rule above by being empty.
    if len(in_gate) < 2:
        problems.append(
            f"`pnpm verify` reaches only {len(in_gate)} script(s). Every rule here "
            f"is vacuous on an empty gate, so this is the floor that makes them mean "
            f"something."
        )

    # 5. Everything above reads the working tree, which a branch can edit. The
    #    only defence is the base branch's copy, so the job that provides it has
    #    to exist.
    ci = ROOT / ".github" / "workflows" / "ci.yml"
    if not ci.exists() or "base-gate" not in ci.read_text():
        problems.append(
            "There is no `base-gate` job in .github/workflows/ci.yml. Without it "
            "the whole gate — including this script — is evaluated from the branch "
            "under review, so a change that removes a checker and its declaration "
            "together is green by construction."
        )

    # 6. Run from the base branch against a pull request: the gate may grow,
    #    never shrink. This is the one rule the branch under review cannot edit
    #    its way past, because the copy enforcing it is the base's.
    if BASE is not None:
        base_gate, _ = gate_checkers(BASE)
        for name in sorted(base_gate - in_gate):
            problems.append(
                f"scripts/{name} runs in the gate on the base branch and does not "
                f"run in the gate on this one. A pull request may add checks and "
                f"may not quietly drop them; if removing it is deliberate, say so "
                f"in the pull request body under `gate-changes:`."
            )

    if problems:
        print("gate-lint: the gate does not describe itself correctly\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}\n", file=sys.stderr)
        return 1

    against = f" (vs base at {BASE})" if BASE is not None else ""
    print(
        f"gate-lint: clean{against} — `pnpm verify` runs {len(in_gate)} checkers "
        f"({', '.join(order)}), every one self-tested; "
        f"{len(NOT_IN_GATE)} declared out of the gate"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
