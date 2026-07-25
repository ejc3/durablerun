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
deletes a checker AND its entry here passes. CI closes the ordinary version of
that hole by staging the pull request tree with the BASE branch's checker
sources and running the BASE branch's semantic inventory there -- see
.github/workflows/ci.yml, job `base-gate`. The workflow itself still comes
from the head branch; CLAUDE.md states that threat-model limit explicitly.
"""

import ast
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Optional [root] [base]: grade a tree other than this script's own and assert
# that its gate is a superset of base. `--run-base HEAD BASE` is the execution
# door used by CI: stage HEAD with BASE's scripts and run BASE's semantically
# enumerated checker commands there.
OWN = Path(__file__).resolve().parent.parent
RUN_BASE = sys.argv[1:2] == ["--run-base"]
LIST_CHECKERS = sys.argv[1:2] == ["--list-checkers"]
if RUN_BASE:
    if len(sys.argv) != 4:
        sys.exit("usage: gate-lint.py --run-base HEAD BASE")
    ROOT = Path(sys.argv[2]).resolve()
    BASE = Path(sys.argv[3]).resolve()
elif LIST_CHECKERS:
    if len(sys.argv) != 3:
        sys.exit("usage: gate-lint.py --list-checkers ROOT")
    ROOT = Path(sys.argv[2]).resolve()
    BASE = None
else:
    _args = [a for a in sys.argv[1:] if not a.startswith("-")]
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
    "source_lex.py": "shared lexical and root-validation library imported by source checkers",
}


ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=.*$", re.S)
SCRIPT_PATH = re.compile(r"^(?:\./)?scripts/([\w.-]+\.(?:py|sh))$")
CONTROL_COMMANDS = {
    ".",
    "break",
    "cd",
    "continue",
    "eval",
    "exec",
    "exit",
    "false",
    "return",
    "source",
}
BASE_RUNNER_BODY = """if [ -f /tmp/base/scripts/gate-lint.py ] && grep -q -- '--run-base HEAD BASE' /tmp/base/scripts/gate-lint.py; then
  python3 /tmp/base/scripts/gate-lint.py --run-base "$GITHUB_WORKSPACE" /tmp/base
else
  python3 scripts/gate-lint.py --run-base "$GITHUB_WORKSPACE" /tmp/base
fi"""


def shell_commands(
    body: str, context: str
) -> tuple[list[tuple[dict[str, str], tuple[str, ...]]], list[str]]:
    """Parse the deliberately small shell language allowed in package scripts.

    Only `&&` composition is accepted. Constructs whose reachability or exit
    status needs a shell evaluator fail closed instead of being counted by
    textual occurrence.
    """
    if "\n" in body or "\r" in body:
        return [], [f"{context} contains a command separator newline; use explicit `&&`."]
    if "$(" in body or "`" in body:
        return [], [f"{context} uses command substitution, which gate-lint cannot prove reachable."]

    lexer = shlex.shlex(body, posix=True, punctuation_chars=";&|()<>")
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        tokens = list(lexer)
    except ValueError as exc:
        return [], [f"{context} does not parse as a shell command: {exc}."]

    forbidden = [token for token in tokens if token and set(token) <= set(";&|()<>") and token != "&&"]
    if forbidden:
        return [], [
            f"{context} uses unsupported shell control {forbidden[0]!r}; only `&&` is "
            "accepted so checker reachability stays decidable."
        ]

    groups: list[list[str]] = [[]]
    for token in tokens:
        if token == "&&":
            if not groups[-1]:
                return [], [f"{context} has an empty command beside `&&`."]
            groups.append([])
        else:
            groups[-1].append(token)
    if not groups[-1]:
        return [], [f"{context} ends with `&&` and an unreachable empty command."]

    commands: list[tuple[dict[str, str], tuple[str, ...]]] = []
    for tokens_in_command in groups:
        environment: dict[str, str] = {}
        while tokens_in_command and ASSIGNMENT.fullmatch(tokens_in_command[0]):
            key, value = tokens_in_command.pop(0).split("=", 1)
            environment[key] = value
        if not tokens_in_command:
            return [], [f"{context} contains only environment assignments, not an execution."]
        if tokens_in_command[0] in CONTROL_COMMANDS:
            return [], [
                f"{context} executes shell control {tokens_in_command[0]!r}; checker "
                "reachability after it is not accepted."
            ]
        if "$" in tokens_in_command[0]:
            return [], [f"{context} computes its executable dynamically; refusing to guess."]
        commands.append((environment, tuple(tokens_in_command)))
    return commands, []


def executed_script(argv: tuple[str, ...]) -> str | None:
    """Return a scripts/*.py|sh file only when it occupies command position."""
    executable = Path(argv[0]).name
    candidate: str | None = None
    if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", executable) or executable in {
        "bash",
        "sh",
    }:
        arguments = list(argv[1:])
        if arguments[:1] == ["--"]:
            arguments.pop(0)
        if arguments and not arguments[0].startswith("-"):
            candidate = arguments[0]
    else:
        candidate = argv[0]

    match = SCRIPT_PATH.fullmatch(candidate or "")
    return match.group(1) if match else None


def gate_checkers(
    root: Path,
) -> tuple[set[str], list[str], list[dict[str, object]], list[str]]:
    """Semantically enumerate checker executions reachable from `pnpm verify`."""
    errors: list[str] = []
    try:
        package = json.loads((root / "package.json").read_text())
    except (OSError, json.JSONDecodeError) as exc:
        return set(), [], [], [f"{root / 'package.json'} cannot be read: {exc}."]
    scripts = package.get("scripts")
    if not isinstance(scripts, dict):
        return set(), [], [], [f"{root / 'package.json'} has no scripts object."]

    active: set[str] = set()
    found: set[str] = set()
    order: list[str] = []
    invocations: list[dict[str, object]] = []

    def expand(name: str, inherited: dict[str, str] | None = None) -> None:
        if name in active:
            errors.append(f"package script recursion reaches {name!r} twice before returning.")
            return
        body = scripts.get(name)
        if not isinstance(body, str):
            errors.append(f"package script {name!r} is missing or is not a string.")
            return
        active.add(name)
        commands, parse_errors = shell_commands(body, f"package script {name!r}")
        errors.extend(parse_errors)
        if parse_errors:
            active.remove(name)
            return

        for environment, argv in commands:
            merged_environment = {**(inherited or {}), **environment}
            ref: str | None = None
            if argv[0] == "pnpm":
                if len(argv) >= 3 and argv[1] == "run" and argv[2] in scripts:
                    ref = argv[2]
                elif len(argv) >= 2 and argv[1] in scripts:
                    ref = argv[1]
            if ref is not None:
                expand(ref, merged_environment)
                continue

            path = executed_script(argv)
            if path is None:
                continue
            if path in found:
                errors.append(
                    f"scripts/{path} is invoked more than once from `pnpm verify`; "
                    "refusing to discard one invocation's arguments or exit status."
                )
                continue
            found.add(path)
            order.append(path)
            invocations.append(
                {"name": path, "argv": argv, "environment": merged_environment}
            )

        active.remove(name)

    expand("verify")
    return found, order, invocations, errors


def selftest_subjects(root: Path) -> tuple[set[str], list[str]]:
    """Read refusal subjects only from the self-test's canonical tables."""
    path = root / "scripts" / "lint-selftest.py"
    try:
        module = ast.parse(path.read_text(), filename=str(path))
    except (OSError, SyntaxError) as exc:
        return set(), [f"{path} cannot be read: {exc}."]

    assignments: dict[str, list[ast.expr]] = {
        "BAD_CASES": [],
        "BAD_INVOCATIONS": [],
    }
    for node in module.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in assignments:
                assignments[target.id].append(node.value)

    errors: list[str] = []
    subjects: set[str] = set()

    def subject(entry: ast.expr, table: str) -> None:
        if (
            not isinstance(entry, ast.Tuple)
            or not entry.elts
            or not isinstance(entry.elts[0], ast.Constant)
            or not isinstance(entry.elts[0].value, str)
        ):
            errors.append(f"{path} {table} contains an entry with no literal checker name.")
            return
        name = entry.elts[0].value
        if not re.fullmatch(r"[\w.-]+\.(?:py|sh)", name):
            errors.append(f"{path} {table} names invalid checker {name!r}.")
            return
        subjects.add(name)

    def harvest(value: ast.expr, table: str) -> None:
        if isinstance(value, (ast.List, ast.Tuple)):
            for entry in value.elts:
                subject(entry, table)
            return
        if isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
            harvest(value.left, table)
            harvest(value.right, table)
            return
        if isinstance(value, ast.ListComp):
            subject(value.elt, table)
            return
        errors.append(f"{path} {table} is not a statically enumerable list.")

    for table, values in assignments.items():
        if len(values) != 1:
            errors.append(f"{path} must assign {table} exactly once; found {len(values)}.")
            continue
        harvest(values[0], table)
    return subjects, errors


def workflow_run_blocks(text: str) -> tuple[list[str], list[str]]:
    """Return active run scalars from the two-space-indented base-gate job."""
    lines = text.splitlines()
    jobs = [i for i, line in enumerate(lines) if re.fullmatch(r"  base-gate:\s*", line)]
    if len(jobs) != 1:
        return [], [f"ci.yml has {len(jobs)} base-gate jobs; expected exactly one."]

    end = len(lines)
    for i in range(jobs[0] + 1, len(lines)):
        if re.match(r"^  [A-Za-z0-9_-]+:\s*", lines[i]):
            end = i
            break

    errors: list[str] = []
    job_lines = lines[jobs[0] + 1 : end]
    job_guards = [line.strip() for line in job_lines if re.match(r"^    if:\s*", line)]
    if job_guards != ["if: github.event_name == 'pull_request'"]:
        errors.append(
            "base-gate must have exactly one `if: github.event_name == 'pull_request'` guard."
        )
    if any(re.match(r"^(?:      - |        )if:\s*", line) for line in job_lines):
        errors.append("base-gate steps may not carry a conditional `if` guard.")
    if any(
        re.match(r"^(?:      - |        )continue-on-error:\s*", line)
        for line in job_lines
    ):
        errors.append("base-gate may not set continue-on-error.")

    blocks: list[str] = []
    i = jobs[0] + 1
    while i < end:
        match = re.match(r"^(?:      - |        )run:\s*(.*?)\s*$", lines[i])
        if not match:
            i += 1
            continue
        value = match.group(1)
        if value in {"|", "|-", ">", ">-"}:
            body: list[str] = []
            i += 1
            while i < end:
                line = lines[i]
                if line.strip() and len(line) - len(line.lstrip()) <= 8:
                    break
                body.append(line[10:] if line.startswith("          ") else line.strip())
                i += 1
            blocks.append("\n".join(body))
            continue
        blocks.append(value)
        i += 1
    return blocks, errors


def has_base_runner(ci: Path) -> tuple[bool, list[str]]:
    if not ci.exists():
        return False, [".github/workflows/ci.yml is missing."]
    blocks, errors = workflow_run_blocks(ci.read_text())
    return any(body.strip() == BASE_RUNNER_BODY for body in blocks), errors


def run_base_checkers(head: Path, base: Path) -> int:
    """Run BASE's checker commands with BASE scripts resolving inside HEAD."""
    _found, order, invocations, errors = gate_checkers(base)
    if errors:
        print("gate-lint: cannot enumerate the base gate", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    if not order:
        print(
            "gate-lint: the base `pnpm verify` reaches zero script checkers; "
            "refusing a vacuous base gate.",
            file=sys.stderr,
        )
        return 1
    if len(invocations) != len(order):
        print(
            f"gate-lint: enumerated {len(order)} base checkers but recovered "
            f"{len(invocations)} invocations.",
            file=sys.stderr,
        )
        return 1

    with tempfile.TemporaryDirectory(prefix="durablerun-base-gate-") as tmp:
        staged = Path(tmp) / "head"
        shutil.copytree(
            head,
            staged,
            ignore=shutil.ignore_patterns(".git", "node_modules", ".pnpm-store", ".store-cache"),
        )
        staged_scripts = staged / "scripts"
        if staged_scripts.exists():
            shutil.rmtree(staged_scripts)
        shutil.copytree(base / "scripts", staged_scripts)

        # Several checkers total-harvest `git ls-files`. A plain directory copy
        # would make that inventory empty and silently disable their scope
        # checks, so give the staged tree a synthetic index containing exactly
        # the files the checkers can inspect.
        for command in (("git", "init", "-q"), ("git", "add", "-f", "--", ".")):
            indexed = subprocess.run(
                command,
                cwd=staged,
                capture_output=True,
                text=True,
                check=False,
            )
            if indexed.returncode != 0:
                print(
                    f"gate-lint: could not build the staged Git index with "
                    f"{' '.join(command)!r}: {indexed.stderr.strip()}",
                    file=sys.stderr,
                )
                return 1

        ran = 0
        for invocation in invocations:
            name = str(invocation["name"])
            argv = tuple(str(arg) for arg in invocation["argv"])
            environment = {
                **os.environ,
                **{str(k): str(v) for k, v in dict(invocation["environment"]).items()},
            }
            print(f"== base-owned scripts/{name} applied to the head tree")
            try:
                result = subprocess.run(
                    argv,
                    cwd=staged,
                    env=environment,
                    capture_output=True,
                    text=True,
                    check=False,
                )
            except OSError as exc:
                print(f"gate-lint: could not execute scripts/{name}: {exc}", file=sys.stderr)
                return 1
            if result.stdout:
                print(result.stdout, end="" if result.stdout.endswith("\n") else "\n")
            if result.stderr:
                print(
                    result.stderr,
                    end="" if result.stderr.endswith("\n") else "\n",
                    file=sys.stderr,
                )
            if result.returncode != 0:
                print(
                    f"gate-lint: base-owned scripts/{name} rejected the head tree "
                    f"with exit {result.returncode}.",
                    file=sys.stderr,
                )
                return 1
            ran += 1

    if ran != len(order):
        print(
            f"gate-lint: expected {len(order)} base checkers but ran {ran}.",
            file=sys.stderr,
        )
        return 1
    print(f"gate-lint: {ran} base-owned checkers applied to the head tree")
    return 0


def main() -> int:
    if RUN_BASE:
        if BASE is None:
            return 1
        return run_base_checkers(ROOT, BASE)

    problems: list[str] = []

    on_disk = {
        p.name
        for p in (ROOT / "scripts").iterdir()
        if p.is_file() and p.suffix in {".py", ".sh"}
    }
    in_gate, order, _invocations, parse_errors = gate_checkers(ROOT)
    if LIST_CHECKERS:
        if parse_errors:
            for error in parse_errors:
                print(f"gate-lint: {error}", file=sys.stderr)
            return 1
        if not order:
            print(
                "gate-lint: `pnpm verify` reaches zero script checkers; refusing a vacuous inventory.",
                file=sys.stderr,
            )
            return 1
        print("\n".join(order))
        return 0
    problems.extend(parse_errors)

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
    subjects, subject_errors = selftest_subjects(ROOT)
    problems.extend(subject_errors)
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
    #    base-gate job must actively invoke the runner that stages base-owned
    #    checker sources over the head tree; a job name or prose reference
    #    executes nothing.
    ci = ROOT / ".github" / "workflows" / "ci.yml"
    runner_active, workflow_errors = has_base_runner(ci)
    problems.extend(workflow_errors)
    if not runner_active:
        problems.append(
            "The `base-gate` job does not actively run "
            "`python3 scripts/gate-lint.py --run-base HEAD BASE`. Without that "
            "execution, the whole gate is evaluated from the branch under review."
        )

    # 6. Run from the base branch against a pull request: the gate may grow,
    #    never shrink. This is the one rule the branch under review cannot edit
    #    its way past, because the copy enforcing it is the base's.
    if BASE is not None:
        base_gate, _base_order, _base_invocations, base_errors = gate_checkers(BASE)
        problems.extend(f"base gate: {error}" for error in base_errors)
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
