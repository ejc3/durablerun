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
import io
import os
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
AGENTS_TITLE = "# durablerun"
BUILD_TITLE = "# Build plan: phases → PR stack of tractable diffs"
CONFINE_HEADING = "## Standing rule: confine heavy local runs"
OVERVIEW_HEADING = "## Overview"
CONFINE_SECTION_BODY = """Anything that can grow — fuzz runs, TLC, codex, bulk test sweeps — runs
through `scripts/confine.sh`. `scripts/confine.sh` is the single definition of
the live protective memory, swap, CPU, and task limits. A runaway must die
inside that scope rather than taking the box down. `verify:fuzz`,
`verify:fuzz:deep`, `verify:tla`, and `verify:mutations` are pre-wired."""
TRANSPORT_BLOCK = """<!-- mutation-suite-transport-contract:start -->
This top-of-file block is the sole normative suite transport contract:
`parse_report` and `run_suite` raise `SuiteInfrastructureError`; only a
structurally valid `SuiteResult` reaches verdict classification.
<!-- mutation-suite-transport-contract:end -->"""


@dataclass(frozen=True)
class ProcessFixtureControl:
    key: str
    document: str
    marker: str


PROCESS_FIXTURE_CONTROLS = (
    ProcessFixtureControl(
        "agents-confine-heading",
        "AGENTS.md",
        CONFINE_HEADING,
    ),
    ProcessFixtureControl(
        "agents-confine-body",
        "AGENTS.md",
        CONFINE_SECTION_BODY,
    ),
    ProcessFixtureControl(
        "agents-overview-heading",
        "AGENTS.md",
        OVERVIEW_HEADING,
    ),
    ProcessFixtureControl(
        "agents-continuation-heading",
        "AGENTS.md",
        "## Fixture continuation",
    ),
    ProcessFixtureControl(
        "build-start-marker",
        "BUILD.md",
        "<!-- mutation-suite-transport-contract:start -->",
    ),
    ProcessFixtureControl(
        "build-end-marker",
        "BUILD.md",
        "<!-- mutation-suite-transport-contract:end -->",
    ),
    ProcessFixtureControl(
        "build-continuation-heading",
        "BUILD.md",
        "## Fixture continuation",
    ),
)


@dataclass(frozen=True)
class ProcessFixtureIsolationFault:
    fault_id: str
    document: str
    container: str
    before: str
    after: str
    expected_problems: tuple[str, ...]
    expects_ambiguous_target: bool = False


def tree(root: Path, files: dict[str, str]) -> Path:
    """Materialize a fake store package so a lint can be pointed at it."""
    for rel, body in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


def store(body: str, name: str = "store.ts") -> dict[str, str]:
    return {f"packages/store-fixture/src/{name}": body}



def gate(
    verify: str,
    extra_scripts: tuple[str, ...] = (),
    base_gate: bool = True,
    base_gate_run: bool = True,
    nightly: bool = True,
) -> dict[str, str]:
    """A miniature repo for gate-lint: a package.json, a scripts/ dir, a CI file.

    gate-lint grades the SHAPE OF THE GATE rather than the contents of a source
    file, so its fixture is a whole tiny repo. `run` copies gate-lint.py into
    scripts/ and it excludes itself from its own on-disk sweep, so only
    `extra_scripts` stand as checkers here.
    """
    ci = "jobs:\n"
    if base_gate:
        ci += "  base-gate:\n    if: github.event_name == 'pull_request'\n"
        if base_gate_run:
            ci += (
                "    steps:\n"
                "      - run: |\n"
                "          if [ -f /tmp/base/scripts/gate-lint.py ] && "
                "grep -q -- '--run-base HEAD BASE' /tmp/base/scripts/gate-lint.py; then\n"
                "            python3 /tmp/base/scripts/gate-lint.py --run-base "
                '"$GITHUB_WORKSPACE" /tmp/base\n'
                "          else\n"
                "            python3 scripts/gate-lint.py --run-base "
                '"$GITHUB_WORKSPACE" /tmp/base\n'
                "          fi\n"
            )
    else:
        ci += "  verify:\n"

    files = {
        "package.json": json.dumps(
            {
                "scripts": {
                    "verify": verify,
                    "verify:mutations": "python3 scripts/mutation-probe.py",
                }
            }
        ),
        "AGENTS.md": (
            f"{AGENTS_TITLE}\n\n"
            f"{CONFINE_HEADING}\n\n"
            f"{CONFINE_SECTION_BODY}\n\n"
            f"{OVERVIEW_HEADING}\n\n"
            "Fixture overview.\n\n"
            "## Fixture continuation\n"
        ),
        "BUILD.md": (
            f"{BUILD_TITLE}\n\n"
            f"{TRANSPORT_BLOCK}\n\n"
            "## Fixture continuation\n"
        ),
        ".github/workflows/ci.yml": ci,
        "scripts/lint-selftest.py": (
            "BAD_CASES = [\n"
            + "".join(f"    ({json.dumps(name)},),\n" for name in extra_scripts)
            + "]\nBAD_INVOCATIONS = []\nGOOD_CASES = []\n"
        ),
    }
    if nightly:
        files[".github/workflows/nightly.yml"] = (
            "name: nightly\n"
            "on: workflow_dispatch\n"
            "permissions:\n"
            "  contents: read\n"
            "jobs:\n"
            "  proof:\n"
            "    runs-on: ubuntu-latest\n"
            "    steps:\n"
            "      - uses: actions/checkout@v4\n"
            "        with:\n"
            "          persist-credentials: false\n"
        )
    for name in extra_scripts:
        files[f"scripts/{name}"] = "# a checker\n"
    for name in (
        "confine.sh",
        "nightly-fuzz-shard.sh",
        "tla.sh",
        "review-attest.sh",
        "session-state.sh",
        "source_lex.py",
    ):
        files[f"scripts/{name}"] = "# declared non-gate process support\n"
    return files


def process_docs(agents: str, build: str) -> dict[str, str]:
    files = gate(
        "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
        "&& python3 scripts/lint-selftest.py",
        ("a-lint.py", "b-lint.py"),
    )
    package = json.loads(files["package.json"])
    package["name"] = "durablerun"
    files["package.json"] = json.dumps(package)
    files["AGENTS.md"] = (
        f"{AGENTS_TITLE}\n\n"
        f"{CONFINE_HEADING}\n\n"
        f"{agents.strip()}\n\n"
        f"{OVERVIEW_HEADING}\n\n"
        "Fixture overview.\n\n"
        "## Fixture continuation\n"
    )
    files["BUILD.md"] = (
        f"{BUILD_TITLE}\n\n"
        f"{build.strip()}\n\n"
        "## Fixture continuation\n"
    )
    return files


@dataclass(frozen=True)
class FencePlacement:
    pass


@dataclass(frozen=True)
class InvalidFencePlacement:
    pass


@dataclass(frozen=True)
class HtmlCommentPlacement:
    pass


@dataclass(frozen=True)
class PrePlacement:
    pass


@dataclass(frozen=True)
class BlankDelimitedHtmlPlacement:
    tag: str

    def __post_init__(self) -> None:
        if self.tag not in {"div", "section"}:
            raise ValueError(f"unsupported blank-delimited HTML tag {self.tag!r}")


@dataclass(frozen=True)
class IndentedCodePlacement:
    pass


HiddenProcessPlacement = (
    FencePlacement
    | InvalidFencePlacement
    | HtmlCommentPlacement
    | PrePlacement
    | BlankDelimitedHtmlPlacement
    | IndentedCodePlacement
)


def render_hidden_process_placement(
    placement: HiddenProcessPlacement,
    canonical_body: str,
) -> str:
    match placement:
        case FencePlacement():
            return f"```md\n{canonical_body}\n```\n\n"
        case InvalidFencePlacement():
            return f"```md\n    ```\n{canonical_body}\n```\n\n"
        case HtmlCommentPlacement():
            return f"<!--\n{canonical_body}\n-->\n\n"
        case PrePlacement():
            return f"<pre>\n{canonical_body}\n</pre>\n\n"
        case BlankDelimitedHtmlPlacement(tag):
            return f"<{tag}>\n{canonical_body}\n</{tag}>\n\n"
        case IndentedCodePlacement():
            return (
                "".join(
                    f"    {line}\n" for line in canonical_body.splitlines()
                )
                + "\n"
            )
    raise TypeError(f"unknown hidden process placement: {placement!r}")


def hidden_process_container(placement: HiddenProcessPlacement) -> str:
    match placement:
        case FencePlacement():
            return "fence"
        case InvalidFencePlacement():
            return "invalid-fence-close"
        case HtmlCommentPlacement():
            return "comment"
        case PrePlacement():
            return "pre"
        case BlankDelimitedHtmlPlacement(tag):
            return tag
        case IndentedCodePlacement():
            return "indented-code"
    raise TypeError(f"unknown hidden process placement: {placement!r}")


def hidden_process_preserves_body(
    placement: HiddenProcessPlacement,
) -> bool:
    match placement:
        case IndentedCodePlacement():
            return False
        case (
            FencePlacement()
            | InvalidFencePlacement()
            | HtmlCommentPlacement()
            | PrePlacement()
            | BlankDelimitedHtmlPlacement()
        ):
            return True
    raise TypeError(f"unknown hidden process placement: {placement!r}")


@dataclass(frozen=True)
class HiddenProcessCase:
    document: str
    placement: HiddenProcessPlacement
    gate_problem: str
    description: str

    @property
    def container(self) -> str:
        return hidden_process_container(self.placement)


@dataclass(frozen=True)
class HiddenProcessObligation:
    required_text: str
    fault: ProcessFixtureIsolationFault


def hidden_process_canonical_body(document: str) -> str:
    if document == "AGENTS.md":
        return f"{CONFINE_HEADING}\n\n{CONFINE_SECTION_BODY}"
    if document == "BUILD.md":
        return TRANSPORT_BLOCK
    raise ValueError(f"unknown process fixture document: {document}")


def hidden_process_following_control(document: str) -> str:
    if document == "AGENTS.md":
        return OVERVIEW_HEADING
    if document == "BUILD.md":
        return "## Fixture continuation"
    raise ValueError(f"unknown process fixture document: {document}")


def hidden_process_cases() -> tuple[HiddenProcessCase, ...]:
    agents_problem = (
        "AGENTS.md confinement section must defer all quantitative policy"
    )
    build_problem = "BUILD.md misclassifies malformed suite transport"
    return (
        HiddenProcessCase(
            "AGENTS.md",
            FencePlacement(),
            agents_problem,
            "a fenced Markdown example is not an operative standing rule",
        ),
        HiddenProcessCase(
            "AGENTS.md",
            HtmlCommentPlacement(),
            agents_problem,
            "a confinement section inside an HTML comment is not operative documentation",
        ),
        HiddenProcessCase(
            "BUILD.md",
            FencePlacement(),
            build_problem,
            "a fenced transport block is an example rather than the plan's contract",
        ),
        HiddenProcessCase(
            "BUILD.md",
            HtmlCommentPlacement(),
            build_problem,
            "nested comment markers cannot move the transport contract from its prefix",
        ),
        HiddenProcessCase(
            "AGENTS.md",
            InvalidFencePlacement(),
            agents_problem,
            "a four-space pseudo-close does not end a top-level Markdown fence",
        ),
        HiddenProcessCase(
            "BUILD.md",
            InvalidFencePlacement(),
            build_problem,
            "a pseudo-close four spaces beyond its list container does not end a fence",
        ),
        HiddenProcessCase(
            "BUILD.md",
            IndentedCodePlacement(),
            build_problem,
            "list-relative indented code is not an operative transport contract",
        ),
        HiddenProcessCase(
            "AGENTS.md",
            PrePlacement(),
            agents_problem,
            "Markdown inside a raw pre block is not an operative standing rule",
        ),
        HiddenProcessCase(
            "BUILD.md",
            PrePlacement(),
            build_problem,
            "Markdown inside a raw pre block is not an operative transport contract",
        ),
        HiddenProcessCase(
            "AGENTS.md",
            BlankDelimitedHtmlPlacement("div"),
            agents_problem,
            "Markdown inside a generic raw HTML block is not an operative standing rule",
        ),
        HiddenProcessCase(
            "BUILD.md",
            BlankDelimitedHtmlPlacement("div"),
            build_problem,
            "generic raw HTML cannot own the operative transport contract",
        ),
        HiddenProcessCase(
            "AGENTS.md",
            BlankDelimitedHtmlPlacement("section"),
            agents_problem,
            "Markdown inside a raw section is not an operative standing rule",
        ),
        HiddenProcessCase(
            "BUILD.md",
            BlankDelimitedHtmlPlacement("section"),
            build_problem,
            "a raw section cannot own the operative transport contract",
        ),
    )


def hidden_process_contract(document: str, container: str) -> dict[str, str]:
    files = process_docs(CONFINE_SECTION_BODY, TRANSPORT_BLOCK)
    matching = [
        case
        for case in hidden_process_cases()
        if (case.document, case.container) == (document, container)
    ]
    if len(matching) != 1:
        raise ValueError(f"unknown hidden process case: {document}/{container}")
    case = matching[0]
    canonical_body = hidden_process_canonical_body(document)
    block = f"{canonical_body}\n\n"
    files[document] = files[document].replace(
        block,
        render_hidden_process_placement(case.placement, canonical_body),
        1,
    )
    return files


def hidden_process_bad_case_payload(
    case: HiddenProcessCase,
) -> tuple[dict[str, str], str, str]:
    return (
        hidden_process_contract(case.document, case.container),
        case.gate_problem,
        case.description,
    )


def hidden_process_bad_cases() -> list[tuple[str, dict[str, str], str, str]]:
    return [
        (
            "gate-lint.py",
            *hidden_process_bad_case_payload(case),
        )
        for case in hidden_process_cases()
    ]


def nested_build_contract(container: str) -> dict[str, str]:
    files = process_docs(CONFINE_SECTION_BODY, TRANSPORT_BLOCK)
    indented_block = "".join(
        f"    {line}\n" for line in TRANSPORT_BLOCK.splitlines()
    )
    wrappers = {
        "fence": (
            "- ```md\n"
            "  - **Attributable mutation catches.**\n"
            f"{indented_block}"
            "  - **Fixture continuation.**\n"
            "  ```\n"
        ),
        "raw-html": (
            "- <div>\n"
            "  - **Attributable mutation catches.**\n"
            f"{indented_block}"
            "  - **Fixture continuation.**\n"
            "  </div>\n"
        ),
        "deindented": (
            "  - **Attributable mutation catches.**\n"
            "\n"
            "outside the list\n"
            "\n"
            f"{indented_block}"
            "  - **Fixture continuation.**\n"
        ),
        "wrong-owner": (
            "      - **Attributable mutation catches.**\n"
            f"{indented_block}"
            "  - **Fixture continuation.**\n"
        ),
    }
    files["BUILD.md"] = f"{BUILD_TITLE}\n\n{wrappers[container]}"
    return files


def raw_agent_contract(opening: str, closing: str = "") -> dict[str, str]:
    files = process_docs(CONFINE_SECTION_BODY, TRANSPORT_BLOCK)
    body = files["AGENTS.md"].removeprefix(f"{AGENTS_TITLE}\n\n")
    files["AGENTS.md"] = f"{AGENTS_TITLE}\n\n{opening}\n{body}{closing}\n"
    return files


def process_fixture_inventory_problem(
    document: str,
    container: str,
    marker: str,
) -> str:
    return (
        f"{document.removesuffix('.md')} {container} fixture corrupts "
        f"unrelated inventory {marker!r}"
    )


def process_fixture_fault_index(
    faults: tuple[ProcessFixtureIsolationFault, ...],
) -> dict[str, ProcessFixtureIsolationFault]:
    index: dict[str, ProcessFixtureIsolationFault] = {}
    for fault in faults:
        if fault.fault_id in index:
            raise ValueError(
                f"duplicate process fixture fault id {fault.fault_id}"
            )
        index[fault.fault_id] = fault
    return index


def validate_process_fixture_controls(
    controls: tuple[ProcessFixtureControl, ...],
) -> None:
    identities: set[tuple[str, str]] = set()
    for control in controls:
        identity = (control.document, control.key)
        if identity in identities:
            raise ValueError(
                "duplicate process fixture control identity "
                f"{control.document}/{control.key}"
            )
        identities.add(identity)


def process_fixture_control_fault_ids(
    control: ProcessFixtureControl,
) -> tuple[str, str]:
    return (
        f"{control.key}-missing",
        f"{control.key}-duplicate",
    )


def process_fixture_control_faults(
    controls: tuple[ProcessFixtureControl, ...] = PROCESS_FIXTURE_CONTROLS,
) -> tuple[ProcessFixtureIsolationFault, ...]:
    validate_process_fixture_controls(controls)
    faults: list[ProcessFixtureIsolationFault] = []
    for control in controls:
        missing_fault_id, duplicate_fault_id = (
            process_fixture_control_fault_ids(control)
        )
        inventory_problem = process_fixture_inventory_problem(
            control.document,
            "fence",
            control.marker,
        )
        missing_problems = [inventory_problem]
        if control.key in ("build-start-marker", "build-end-marker"):
            missing_problems.append(
                "BUILD fence fixture corrupts the canonical transport body"
            )
        faults.append(
            ProcessFixtureIsolationFault(
                missing_fault_id,
                control.document,
                "fence",
                control.marker,
                f"[removed {control.key}]",
                tuple(missing_problems),
            )
        )

        if control.key in ("build-start-marker", "build-end-marker"):
            duplicate_before = "\n\n## Fixture continuation"
            duplicate_after = (
                f"\n\n{control.marker}\n\n## Fixture continuation"
            )
        else:
            duplicate_before = control.marker
            duplicate_after = f"{control.marker}\n{control.marker}"
        faults.append(
            ProcessFixtureIsolationFault(
                duplicate_fault_id,
                control.document,
                "fence",
                duplicate_before,
                duplicate_after,
                (inventory_problem,),
            )
        )
    result = tuple(faults)
    process_fixture_fault_index(result)
    return result


def hidden_process_case_obligations(
    case: HiddenProcessCase,
) -> tuple[HiddenProcessObligation, ...]:
    obligations: list[HiddenProcessObligation] = []
    if case.document == "BUILD.md" and hidden_process_preserves_body(
        case.placement
    ):
        obligations.append(
            HiddenProcessObligation(
                TRANSPORT_BLOCK,
                ProcessFixtureIsolationFault(
                    f"build-{case.container}-transport-body",
                    "BUILD.md",
                    case.container,
                    "`parse_report` and `run_suite` raise",
                    "`parse_report` or `run_suite` raise",
                    (
                        f"BUILD {case.container} fixture corrupts "
                        "the canonical transport body",
                    ),
                ),
            )
        )
    if isinstance(case.placement, BlankDelimitedHtmlPlacement):
        following_control = hidden_process_following_control(case.document)
        document_name = case.document.removesuffix(".md")
        control_name = following_control.removeprefix("## ")
        closing = f"</{case.placement.tag}>"
        boundary = f"{closing}\n\n{following_control}"
        obligations.append(
            HiddenProcessObligation(
                boundary,
                ProcessFixtureIsolationFault(
                    f"{document_name.lower()}-{case.container}-boundary",
                    case.document,
                    case.container,
                    boundary,
                    f"{closing}\n{following_control}",
                    (
                        f"{document_name} {case.container} fixture fails to "
                        f"terminate raw HTML before the {control_name} control",
                    ),
                ),
            )
        )
    return tuple(obligations)


def process_fixture_isolation_faults() -> tuple[
    ProcessFixtureIsolationFault, ...
]:
    faults = list(process_fixture_control_faults())
    for case in hidden_process_cases():
        faults.extend(
            obligation.fault
            for obligation in hidden_process_case_obligations(case)
        )
    faults.append(
        ProcessFixtureIsolationFault(
            "ambiguous-process-fixture-mutation-target",
            "AGENTS.md",
            "fence",
            "\n",
            "\n",
            (),
            expects_ambiguous_target=True,
        )
    )
    result = tuple(faults)
    process_fixture_fault_index(result)
    return result


PROCESS_FIXTURE_ISOLATION_FAULTS = process_fixture_isolation_faults()
PROCESS_FIXTURE_ISOLATION_FAULT_INDEX = process_fixture_fault_index(
    PROCESS_FIXTURE_ISOLATION_FAULTS
)


def inject_process_fixture_fault(
    document: str,
    container: str,
    body: str,
    injected_fault: str | None,
) -> str:
    if injected_fault is None:
        return body
    fault = PROCESS_FIXTURE_ISOLATION_FAULT_INDEX[injected_fault]
    if (document, container) != (fault.document, fault.container):
        return body
    if body.count(fault.before) != 1:
        raise AssertionError(
            f"{injected_fault} mutation target is not unique in {document}/{container}"
        )
    return body.replace(fault.before, fault.after, 1)


def process_fixture_isolation_problems(
    *,
    injected_fault: str | None = None,
) -> list[str]:
    """Reject process-contract negatives that also corrupt unrelated controls."""
    if (
        injected_fault is not None
        and injected_fault not in PROCESS_FIXTURE_ISOLATION_FAULT_INDEX
    ):
        raise ValueError(f"unknown process fixture isolation fault: {injected_fault}")

    problems: list[str] = []
    for case in hidden_process_cases():
        document = hidden_process_contract(
            case.document,
            case.container,
        )[case.document]
        document = inject_process_fixture_fault(
            case.document,
            case.container,
            document,
            injected_fault,
        )
        for control in PROCESS_FIXTURE_CONTROLS:
            if control.document != case.document:
                continue
            if document.count(control.marker) != 1:
                problems.append(
                    process_fixture_inventory_problem(
                        case.document,
                        case.container,
                        control.marker,
                    )
                )
        for obligation in hidden_process_case_obligations(case):
            if document.count(obligation.required_text) != 1:
                problems.extend(obligation.fault.expected_problems)
    return problems


def hidden_process_enrollment_problem(
    case: HiddenProcessCase,
    observed_count: int,
) -> str:
    return (
        f"hidden process case {case.document}/{case.container} must be enrolled "
        f"exactly once in BAD_CASES; observed {observed_count}"
    )


def hidden_process_enrollment_problems(
    bad_cases: list[tuple[str, dict[str, str], str, str]],
) -> list[str]:
    """Require every canonical hidden-process case to reach the executable corpus."""
    enrolled = list(bad_cases)
    canonical = hidden_process_bad_cases()

    return [
        hidden_process_enrollment_problem(case, enrolled.count(bad_case))
        for case, bad_case in zip(hidden_process_cases(), canonical, strict=True)
        if enrolled.count(bad_case) != 1
    ]


def hidden_process_enrollment_surface_problems(
    bad_cases: list[tuple[str, dict[str, str], str, str]],
) -> list[str]:
    """Mutate every canonical enrollment in both cardinality directions."""
    problems: list[str] = []
    canonical = hidden_process_bad_cases()
    exercised = 0
    for case, bad_case in zip(hidden_process_cases(), canonical, strict=True):
        missing = list(bad_cases)
        missing.remove(bad_case)
        duplicate = [*bad_cases, bad_case]
        for observed_count, mutated in ((0, missing), (2, duplicate)):
            exercised += 1
            expected = [hidden_process_enrollment_problem(case, observed_count)]
            observed = hidden_process_enrollment_problems(mutated)
            if observed != expected:
                problems.append(
                    "hidden process enrollment self-test attributed "
                    f"{case.document}/{case.container} count {observed_count} "
                    f"incorrectly: expected {expected!r}, observed {observed!r}"
                )
    expected_exercised = 2 * len(canonical)
    if exercised != expected_exercised:
        problems.append(
            "hidden process enrollment self-test exercised "
            f"{exercised} of {expected_exercised} cardinality faults"
        )
    return problems


def hidden_process_case_fault_ids(
    case: HiddenProcessCase,
) -> tuple[str, ...]:
    fault_ids: list[str] = []
    if case.document == "BUILD.md" and not isinstance(
        case.placement,
        IndentedCodePlacement,
    ):
        fault_ids.append(f"build-{case.container}-transport-body")
    if isinstance(case.placement, BlankDelimitedHtmlPlacement):
        document_name = case.document.removesuffix(".md").lower()
        fault_ids.append(f"{document_name}-{case.container}-boundary")
    return tuple(fault_ids)


def hidden_process_obligation_enrollment_problem(
    case: HiddenProcessCase,
    fault_id: str,
    observed_count: int,
) -> str:
    return (
        f"hidden process obligation {case.document}/{case.container}/{fault_id} "
        f"must be generated exactly once; observed {observed_count}"
    )


def hidden_process_obligation_enrollment_problems(
    faults: tuple[ProcessFixtureIsolationFault, ...],
) -> list[str]:
    fault_ids = [fault.fault_id for fault in faults]
    return [
        hidden_process_obligation_enrollment_problem(
            case,
            fault_id,
            fault_ids.count(fault_id),
        )
        for case in hidden_process_cases()
        for fault_id in hidden_process_case_fault_ids(case)
        if fault_ids.count(fault_id) != 1
    ]


def hidden_process_obligation_surface_problems() -> list[str]:
    """Mutate every structurally required case obligation at cardinality 0 and 2."""
    canonical = PROCESS_FIXTURE_ISOLATION_FAULTS
    problems = hidden_process_obligation_enrollment_problems(canonical)
    exercised = 0
    expected_exercised = 0
    for case in hidden_process_cases():
        for fault_id in hidden_process_case_fault_ids(case):
            expected_exercised += 2
            matching = [
                fault for fault in canonical if fault.fault_id == fault_id
            ]
            if len(matching) != 1:
                continue
            missing = tuple(
                fault for fault in canonical if fault.fault_id != fault_id
            )
            duplicate = (*canonical, matching[0])
            for observed_count, mutated in ((0, missing), (2, duplicate)):
                exercised += 1
                expected = [
                    hidden_process_obligation_enrollment_problem(
                        case,
                        fault_id,
                        observed_count,
                    )
                ]
                observed = hidden_process_obligation_enrollment_problems(
                    mutated
                )
                if observed != expected:
                    problems.append(
                        "hidden process obligation self-test attributed "
                        f"{fault_id} count {observed_count} incorrectly: "
                        f"expected {expected!r}, observed {observed!r}"
                    )
    if exercised != expected_exercised:
        problems.append(
            "hidden process obligation self-test exercised "
            f"{exercised} of {expected_exercised} cardinality faults"
        )
    return problems


def process_fixture_control_collision_problems() -> list[str]:
    """Control identities and the fault IDs they generate must be collision-free."""
    probes = tuple(
        (
            control,
            (
                "duplicate process fixture control identity "
                f"{control.document}/{control.key}"
            ),
        )
        for control in PROCESS_FIXTURE_CONTROLS
    ) + (
        (
            ProcessFixtureControl(
                "agents-confine-heading",
                "BUILD.md",
                BUILD_TITLE,
            ),
            "duplicate process fixture fault id agents-confine-heading-missing",
        ),
    )
    problems: list[str] = []
    for probe, expected_error in probes:
        try:
            process_fixture_control_faults((*PROCESS_FIXTURE_CONTROLS, probe))
        except ValueError as error:
            if str(error) != expected_error:
                problems.append(
                    "process fixture control collision was rejected for the "
                    f"wrong reason: expected {expected_error!r}, observed {str(error)!r}"
                )
        else:
            problems.append(
                f"process fixture controls accepted {expected_error}"
            )
    return problems


def process_fixture_control_enrollment_problem(
    fault_id: str,
    observed_count: int,
) -> str:
    return (
        f"process fixture control fault {fault_id} must be generated exactly "
        f"once; observed {observed_count}"
    )


def process_fixture_control_enrollment_problems(
    controls: tuple[ProcessFixtureControl, ...],
    faults: tuple[ProcessFixtureIsolationFault, ...],
) -> list[str]:
    fault_ids = [fault.fault_id for fault in faults]
    return [
        process_fixture_control_enrollment_problem(
            fault_id,
            fault_ids.count(fault_id),
        )
        for control in controls
        for fault_id in process_fixture_control_fault_ids(control)
        if fault_ids.count(fault_id) != 1
    ]


def process_fixture_control_enrollment_surface_problems() -> list[str]:
    """Mutate every generated control fault in both cardinality directions."""
    canonical = process_fixture_control_faults()
    problems = process_fixture_control_enrollment_problems(
        PROCESS_FIXTURE_CONTROLS,
        canonical,
    )
    exercised = 0
    for control in PROCESS_FIXTURE_CONTROLS:
        for fault_id in process_fixture_control_fault_ids(control):
            matching = [
                fault for fault in canonical if fault.fault_id == fault_id
            ]
            if len(matching) != 1:
                continue
            missing = tuple(
                fault for fault in canonical if fault.fault_id != fault_id
            )
            duplicate = (*canonical, matching[0])
            for observed_count, mutated in ((0, missing), (2, duplicate)):
                exercised += 1
                expected = [
                    process_fixture_control_enrollment_problem(
                        fault_id,
                        observed_count,
                    )
                ]
                observed = process_fixture_control_enrollment_problems(
                    PROCESS_FIXTURE_CONTROLS,
                    mutated,
                )
                if observed != expected:
                    problems.append(
                        "process fixture control enrollment self-test "
                        f"attributed {fault_id} count {observed_count} "
                        f"incorrectly: expected {expected!r}, "
                        f"observed {observed!r}"
                    )
    expected_exercised = 4 * len(PROCESS_FIXTURE_CONTROLS)
    if exercised != expected_exercised:
        problems.append(
            "process fixture control enrollment self-test exercised "
            f"{exercised} of {expected_exercised} cardinality faults"
        )
    return problems


def under(prefix: str, files: dict[str, str]) -> dict[str, str]:
    return {f"{prefix}/{rel}": body for rel, body in files.items()}


def base_runner_fixture(
    *,
    reject_from: str | None,
    base_verify: str | None = None,
) -> dict[str, str]:
    verify = (
        "python3 scripts/a-lint.py && bash scripts/b-lint.sh "
        "&& python3 scripts/lint-selftest.py"
    )
    head = gate(verify, ("a-lint.py", "b-lint.sh"))
    base = gate(base_verify if base_verify is not None else verify, ("a-lint.py", "b-lint.sh"))
    base["scripts/a-lint.py"] = (
        "from pathlib import Path\n"
        "raise SystemExit(1 if "
        "(Path(__file__).resolve().parent.parent / 'REJECT').exists() else 0)\n"
        if reject_from == "python"
        else "raise SystemExit(0)\n"
    )
    base["scripts/b-lint.sh"] = (
        "#!/usr/bin/env bash\ntest ! -f REJECT\n"
        if reject_from == "shell"
        else "#!/usr/bin/env bash\nexit 0\n"
    )
    return {**under("head", head), **under("base", base), "head/REJECT": "reject\n"}


def base_runner_growth_fixture() -> dict[str, str]:
    """A head may add a checker when its own gate and refusal corpus enroll it."""
    base_verify = (
        "python3 scripts/a-lint.py && bash scripts/b-lint.sh "
        "&& python3 scripts/gate-lint.py && python3 scripts/lint-selftest.py"
    )
    head_verify = (
        "python3 scripts/a-lint.py && bash scripts/b-lint.sh "
        "&& python3 scripts/c-lint.py && python3 scripts/gate-lint.py "
        "&& python3 scripts/lint-selftest.py"
    )
    base = gate(
        base_verify,
        ("a-lint.py", "b-lint.sh", "gate-lint.py"),
    )
    head = gate(
        head_verify,
        ("a-lint.py", "b-lint.sh", "c-lint.py", "gate-lint.py"),
    )
    base["scripts/gate-lint.py"] = (SCRIPTS / "gate-lint.py").read_text()
    head["scripts/gate-lint.py"] = (SCRIPTS / "gate-lint.py").read_text()
    return {**under("head", head), **under("base", base)}


def base_runner_workspace_problems() -> list[str]:
    """The staged semantic gate needs its own installed workspace graph."""
    problems = []
    with tempfile.TemporaryDirectory(prefix="durablerun-base-install-fixture-") as tmp:
        fixture_bin = Path(tmp)
        installer = fixture_bin / "pnpm"
        installer.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            "from pathlib import Path\n"
            "root = Path.cwd()\n"
            "assert sys.argv[1:] == ['install', '--frozen-lockfile', '--ignore-scripts']\n"
            "assert root != Path(os.environ['BASE_FIXTURE_HEAD'])\n"
            "assert (root / '.git' / 'index').is_file()\n"
            "assert (root / 'pnpm-workspace.yaml').is_file()\n"
            "assert (root / 'pnpm-lock.yaml').is_file()\n"
            "if os.environ['BASE_FIXTURE_INSTALL_FAIL'] == '1':\n"
            "    print('injected staged workspace install failure', file=sys.stderr)\n"
            "    raise SystemExit(9)\n"
            "compiler = root / 'node_modules' / '.bin' / 'tsc'\n"
            "compiler.parent.mkdir(parents=True)\n"
            "compiler.write_text('fixture compiler')\n"
            "link = root / 'packages' / 'consumer' / 'node_modules' / '@durablerun' / 'core'\n"
            "link.parent.mkdir(parents=True)\n"
            "link.symlink_to(root / 'packages' / 'core', target_is_directory=True)\n"
            "print('staged workspace install completed')\n"
        )
        installer.chmod(0o755)
        for install_fails in (False, True):
            files = base_runner_fixture(reject_from=None)
            files.update({
                "head/pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
                "head/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
                "head/packages/core/package.json": '{"name":"@durablerun/core"}\n',
            })
            files["base/scripts/a-lint.py"] = (
                "from pathlib import Path\n"
                "root = Path(__file__).resolve().parent.parent\n"
                "assert (root / 'node_modules/.bin/tsc').read_text() == 'fixture compiler'\n"
                "assert (root / 'packages/consumer/node_modules/@durablerun/core').resolve() == root / 'packages/core'\n"
                "print('staged workspace semantic checker ran')\n"
                if not install_fails
                else "print('staged workspace semantic checker ran')\n"
            )
            result = run(
                "gate-lint.py",
                files,
                ("--run-base", "{root}/head", "{root}/base"),
                environment={
                    "PATH": f"{fixture_bin}{os.pathsep}{os.environ['PATH']}",
                    "BASE_FIXTURE_HEAD": "{root}/head",
                    "BASE_FIXTURE_INSTALL_FAIL": "1" if install_fails else "0",
                },
            )
            output = result.stdout + result.stderr
            if install_fails:
                if (
                    result.returncode == 0
                    or "injected staged workspace install failure" not in output
                    or "staged workspace semantic checker ran" in output
                ):
                    problems.append(
                        "a staged dependency install failure must reject the base gate "
                        "with its diagnostics before any semantic checker runs\n"
                        f"    exit {result.returncode}: {output.strip()}"
                    )
            elif (
                result.returncode != 0
                or "staged workspace semantic checker ran" not in output
            ):
                problems.append(
                    "the base gate must install frozen, script-free dependencies in its "
                    "staged workspace before the semantic checker needs tools and package links\n"
                    f"    exit {result.returncode}: {output.strip()}"
                )
    return problems


ACTIVE_RULE = "Flag something decidable. Pass for the nearest legitimate shape."
CODERABBIT_GLOBAL = (
    "Apply durablerun's custom review rules from `.github/review-bot-rules/` as they "
    "exist in the feature branch under review. A pull request can edit or remove these "
    "in-repo instructions, so they are a head-owned detection net rather than base-owned "
    "enforcement. This project's standing rules are in CLAUDE.md and its spec is "
    "DESIGN.md; a finding should name the MECHANISM that would have made the defect "
    "unwritable or machine-caught, not only the line to change — a fix without a "
    "prevention is not accepted here."
)
PROVENANCE_NOTE = (
    "CodeRabbit uses the feature branch under review: "
    "https://docs.coderabbit.ai/getting-started/yaml-configuration. "
    "Greptile reads settings from the source branch of the PR: "
    "https://www.greptile.com/docs/code-review/greptile-json-reference. "
    "A pull request can therefore weaken its own in-repo review rules."
)
CODERABBIT_PROVENANCE = (
    "CodeRabbit uses the feature branch under review; a pull request can edit or remove "
    "these in-repo instructions."
)
GREPTILE_PROVENANCE = (
    "Greptile reads settings from the source branch of the PR; a pull request can edit or "
    "remove these in-repo instructions."
)
HOSTED_GATE_NOTE = (
    "CodeRabbit custom checks are configured with `mode: error`, and "
    "`reviews.request_changes_workflow: true` turns a failed error check into a "
    "requested-changes review. CodeRabbit custom checks expose `name`, `mode`, and "
    "`instructions`; they do not define per-check GitHub status contexts. Greptile is "
    'configured with `"statusCheck": true`. Require only the aggregate contexts the '
    "installed apps actually publish."
)


def active_check(rule: str = ACTIVE_RULE, rule_stem: str = "a-rule") -> str:
    return (
        "Fail when the diff introduces or materially widens any failure shape in "
        f"`.github/review-bot-rules/{rule_stem}.md`. "
        + rule
        + " Pass for the cases listed in that file Allowed section, for test-only "
        "scaffolding that does not make production behaviour worse, and for existing "
        "debt the diff does not worsen."
    )


def corpus(
    rule_body: str,
    *,
    rule_stem: str = "a-rule",
    in_coderabbit: bool = True,
    active_coderabbit: bool = True,
    coderabbit_name: str | None = None,
    coderabbit_mode: str = "error",
    coderabbit_instructions: str | None = None,
    greptile_id: str | None = None,
    greptile_rule: str = ACTIVE_RULE,
    readme_note: str = PROVENANCE_NOTE,
    status_check: bool = True,
    coderabbit_path: str = "**/*",
    coderabbit_path_instructions: str = CODERABBIT_GLOBAL,
    coderabbit_extra_path: str = "",
    greptile_scope: list[str] | None = None,
    greptile_index: tuple[str, ...] | None = None,
) -> dict[str, str]:
    """A miniature review-bot corpus: one rule and both active configurations."""
    coderabbit_name = coderabbit_name or f"durablerun: {rule_stem}"
    greptile_id = greptile_id or f"durablerun-{rule_stem}"
    greptile_index = (rule_stem,) if greptile_index is None else greptile_index
    if coderabbit_instructions is None:
        coderabbit_instructions = active_check(greptile_rule, rule_stem)
    cr = (
        f"# {CODERABBIT_PROVENANCE}\n"
        "reviews:\n"
        "  request_changes_workflow: true\n"
        "  path_instructions:\n"
        f"    - path: {json.dumps(coderabbit_path)}\n"
        "      instructions: |\n"
        f"        {coderabbit_path_instructions}\n"
        f"{coderabbit_extra_path}"
    )
    if in_coderabbit:
        cr += (
            "  pre_merge_checks:\n"
            "    custom_checks:\n"
            f"      - name: {json.dumps(coderabbit_name)}\n"
            f"        mode: {coderabbit_mode if active_coderabbit else 'off'}\n"
            "        instructions: |\n"
            f"          {coderabbit_instructions}\n"
        )
    return {
        f".github/review-bot-rules/{rule_stem}.md": rule_body,
        ".github/review-bot-rules/README.md": (
            f"# Rules\n\n{readme_note}\n\n"
            "<!-- review-bot-global:start -->\n"
            f"{CODERABBIT_GLOBAL}\n"
            "<!-- review-bot-global:end -->\n\n"
            "<!-- review-bot-gating:start -->\n"
            f"{HOSTED_GATE_NOTE}\n"
            "<!-- review-bot-gating:end -->\n\n"
            f"- `{rule_stem}.md`\n"
        ),
        ".coderabbit.yaml": cr,
        ".greptile/rules.md": (
            f"# Rules\n\n{GREPTILE_PROVENANCE}\n\n"
            + "".join(f"- `{stem}.md`\n" for stem in greptile_index)
        ),
        ".greptile/config.json": json.dumps(
            {
                "instructions": GREPTILE_PROVENANCE,
                "statusCheck": status_check,
                "rules": [
                    {
                        "id": greptile_id,
                        "rule": greptile_rule,
                        "scope": (
                            greptile_scope
                            if greptile_scope is not None
                            else ["packages/**"]
                        ),
                    }
                ],
            }
        ),
        "packages/example.ts": "// tracked scope witness\n",
    }


def replaced(files: dict[str, str], rel: str, before: str, after: str) -> dict[str, str]:
    """Return one fixture with one exact source fragment changed."""
    changed = dict(files)
    if changed[rel].count(before) != 1:
        raise ValueError(f"{rel} fixture does not contain exactly one {before!r}")
    changed[rel] = changed[rel].replace(before, after)
    return changed


WHOLE_RULE = """# A Rule

Scope: `packages/**` — siblings cover the rest.

<!-- review-bot-scope:start -->
packages/**
<!-- review-bot-scope:end -->

<!-- review-bot-synopsis:start -->
""" + ACTIVE_RULE + """
<!-- review-bot-synopsis:end -->

Report a failure when the diff does any of:

- something decidable

Allowed cases (do NOT flag these):

- the nearest legitimate shape
"""

STORE_LIBSQL_SCOPE = "packages/store-libsql/src/**/*.ts"
STORE_LIBSQL_RULE = WHOLE_RULE.replace(
    "Scope: `packages/**` — siblings cover the rest.",
    f"Scope: `{STORE_LIBSQL_SCOPE}` — siblings cover the rest.",
).replace(
    "<!-- review-bot-scope:start -->\npackages/**\n<!-- review-bot-scope:end -->",
    "<!-- review-bot-scope:start -->\n"
    f"{STORE_LIBSQL_SCOPE}\n"
    "<!-- review-bot-scope:end -->",
)

RED_PAIR_SYNOPSIS = (
    "Flag a repair whose regression test and fix share one commit. "
    "Pass for separate red-test and fix commits."
)


def red_pair_rule(synopsis: str = RED_PAIR_SYNOPSIS, allowed: str = "") -> str:
    return f"""# Red test before fix

Scope: `packages/**` — siblings cover the rest.

<!-- review-bot-scope:start -->
packages/**
<!-- review-bot-scope:end -->

<!-- review-bot-synopsis:start -->
{synopsis}
<!-- review-bot-synopsis:end -->

Report a failure when the diff does any of:

- a repair lands without a preceding failing regression

Allowed cases (do NOT flag these):

- a test-only red commit followed by a fix commit
{allowed}"""


def red_pair_corpus(rule_body: str, synopsis: str) -> dict[str, str]:
    return corpus(
        rule_body,
        rule_stem="red-test-before-fix",
        greptile_rule=synopsis,
    )


CLEAN_STORE = store(
    """
export class S {
  async ok(q: string) {
    await this.db.batch('sweep:scan', [{ sql: `SELECT 1`, args: [] }], 'read')
  }
}
"""
)

# Each case: (lint script, fixture files, exact verdict marker, why it must be rejected).
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
        "a computed label is invisible to this lint",
        "a label held in a variable hides the whole batch from the lint",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe() {
    const batch = this.db.batch.bind(this.db)
    await batch('brand-new-write', [
      { sql: `UPDATE tasks SET a = 1`, args: [] },
      { sql: `UPDATE runs SET b = 2`, args: [] },
    ])
  }
}
"""
        ),
        "indirect this.db.batch reference is opaque",
        "aliasing the executor method must fail closed instead of hiding a raw multi-write batch",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(suffix: string) {
    await this.db.batch('heartbeat' + suffix, [
      { sql: `UPDATE tasks SET a = 1`, args: [] },
    ])
  }
}
"""
        ),
        "a computed label is invisible to this lint",
        "a literal prefix must not disguise a computed runtime label",
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
        "a computed label is invisible to this lint",
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
        "raw this.db.batch('brand-new-write') is unclassified",
        "an unclassified literal label must fail until it is classified",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe() {
    await this.db /* receiver trivia */ . batch /* call trivia */ (
      'brand-new-write',
      [{ sql: `UPDATE tasks SET a = 1`, args: [] }],
    )
  }
}
"""
        ),
        "raw this.db.batch('brand-new-write') is unclassified",
        "comments and spacing between call tokens must not hide a real batch",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(n: number) {
    const statements = [{ sql: `UPDATE tasks SET a = 1`, args: [] }]
    return n++ / Number(this.db.batch('brand-new-write', statements)) / 2
  }
}
"""
        ),
        "raw this.db.batch('brand-new-write') is unclassified",
        "division after postfix increment must not turn executable code into a regex",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(n: number | undefined) {
    const statements = [{ sql: `UPDATE tasks SET a = 1`, args: [] }]
    return n! / Number(this.db.batch('brand-new-write', statements)) / 2
  }
}
"""
        ),
        "raw this.db.batch('brand-new-write') is unclassified",
        "division after a non-null assertion must not turn executable code into a regex",
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
        "'heartbeat' is declared a SINGLE write but carries 2 statements",
        "a label declared a SINGLE write must fail once it grows a second statement",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('heartbeat', [
      { sql: `UPDATE runs SET note = ']})' WHERE id = ?`, args: [q] },
      { sql: `UPDATE tasks SET state = 'running'`, args: [] },
    ])
  }
}
"""
        ),
        "'heartbeat' is declared a SINGLE write but carries 2 statements",
        "a bracket inside SQL must not truncate the batch shape",
    ),
    (
        "batch-lint.py",
        store(
            r"""
export class S {
  async probe(q: string) {
    await this.db.batch('heartbeat', [
      { sql: 'x', args: [/\]\}\]\)/.test(q)] },
      { sql: 'y', args: [] },
    ])
  }
}
"""
        ),
        "'heartbeat' is declared a SINGLE write but carries 2 statements",
        "delimiter-looking regex tokens must not hide a later statement",
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
        "'sweep:scan' is declared a READ but is not run in 'read' mode",
        "a label declared a READ must fail when it is not run in read mode",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe(q: string) {
    await this.db.batch('get-checkpoints', [
      { sql: `SELECT ${NOW_MS} AS first_clock`, args: [] },
      { sql: `SELECT ${NOW_MS} AS second_clock`, args: [] },
    ], 'read')
  }
}
"""
        ),
        "'get-checkpoints' reads the clock in 2 places across 2 statements",
        "two statements of one batch reading the clock is the class-A bug itself",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async probe() {
    const statements = [
      { sql: `SELECT ${NOW_MS} AS first_clock`, args: [] },
      { sql: `SELECT ${NOW_MS} AS second_clock`, args: [] },
    ]
    await this.db.batch('get-checkpoints', statements, 'read')
  }
}
"""
        ),
        "statement list shape is opaque",
        "an indirect statement array must not turn into zero audited statements",
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
        "raw this.db.batch('brand-new-write') is unclassified",
        "a file below the package's src directory must not be invisible",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="probe.ts",
        ),
        "cancellation-deadline comparison outside fragments.ts",
        "an eligibility comparison outside fragments.ts is how the claim lost the deadline predicate",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE CANCEL_AT_MS <= 5`\n",
            name="probe.ts",
        ),
        "cancellation-deadline comparison outside fragments.ts",
        "SQL identifiers are case-insensitive, so uppercase cannot create a second eligibility definition",
    ),
    (
        "fragment-lint.py",
        store(
            'const SQL = `SELECT 1 FROM tasks WHERE "cancel_at_ms" <= 5`\n',
            name="probe.ts",
        ),
        "cancellation-deadline comparison outside fragments.ts",
        "portable SQL double quotes identify a column, so the SQL literal view must not erase the guarded field",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms\n  <= 5`\n",
            name="probe.ts",
        ),
        "cancellation-deadline comparison outside fragments.ts",
        "SQL whitespace may split an eligibility comparison across source lines",
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
        "cancellation-deadline comparison outside fragments.ts",
        "a nested file must not be invisible to the fragment checker",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="nested/deep/fragments.ts",
        ),
        "cancellation-deadline comparison outside fragments.ts",
        "only the canonical top-level fragments.ts may define eligibility predicates",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT unixepoch('subsec')`\n", name="nested/deep/probe.ts"),
        "raw wall-clock function in store SQL",
        "a nested file must not be invisible to the clock checker",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT 1\n  * NOW()`\n"),
        "raw wall-clock function in store SQL",
        "a SQL multiplication line is not a block-comment continuation",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT NOW()`\n", name="generated/time.ts"),
        "raw wall-clock function in store SQL",
        "only the package's exact top-level time.ts is exempt",
    ),
    (
        "clock-lint.py",
        store("const SQL = 'SELECT NOW()'\n"),
        "raw wall-clock function in store SQL",
        "ordinary TypeScript string delimiters must not hide executable SQL",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT ${'NOW()'} AS at`\n"),
        "raw wall-clock function in store SQL",
        "a literal SQL fragment inside a template interpolation remains executable",
    ),
    (
        "clock-lint.py",
        store(
            r"""const SQL = `SELECT 'c:\' AS p, NOW() AS t`
"""
        ),
        "raw wall-clock function in store SQL",
        "a backslash before a SQL quote must not hide executable SQL after that quote",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT value FROM meta WHERE key = 'fake_now_ms'`\n"),
        "raw meta/fake_now_ms clock read in store SQL",
        "a direct fake-now read is a second spelling of the database clock",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT value FROM meta WHERE 'fake_now_ms' = key`\n"),
        "raw meta/fake_now_ms clock read in store SQL",
        "reversing equality operands must not hide a direct fake-now read",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT value FROM meta WHERE key IN ('fake_now_ms')`\n"),
        "raw meta/fake_now_ms clock read in store SQL",
        "an IN predicate must not hide a direct fake-now read",
    ),
    (
        "clock-lint.py",
        {
            "packages/store-fixture/src/store.ts": "export const harmless = 1\n",
            "packages/store-fixture/src/nested/clock.sql": "SELECT CURRENT_DATE AS today\n",
        },
        "raw wall-clock function in store SQL",
        "a nested shared SQL file must be audited alongside TypeScript SQL templates",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/src/status.ts": "const SQL = `SELECT completed_payload FROM tasks`\n",
        },
        "task outcome column completed_payload outside",
        "an app that selects an outcome column is a second decoder",
    ),
    (
        "outcome-lint.py",
        {
            "packages/driver/src/inspect.ts": (
                "export const reason = (row: Record<string, unknown>) => row.failure_reason\n"
            ),
        },
        "task outcome column failure_reason outside",
        "reading an outcome column from a row object is a second decoder",
    ),
    (
        "outcome-lint.py",
        {
            "packages/driver/src/inspect.ts": (
                "export const reason = (row: Record<string, unknown>) => row['failure_reason']\n"
            ),
        },
        "task outcome column failure_reason outside",
        "an element access must not hide an outcome column inside a string",
    ),
    (
        "outcome-lint.py",
        {"packages/sdk/src/probe.ts": "const SQL = `SELECT FAILURE_REASON FROM tasks`\n"},
        "task outcome column FAILURE_REASON outside",
        "SQL identifiers are case-insensitive",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/nested/task-result.ts": (
                "export const read = (row: { completed_payload: unknown }) => row.completed_payload\n"
            ),
        },
        "task outcome column completed_payload outside",
        "only core's exact top-level task-result.ts is exempt",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "packages/driver/bin/host.ts": "const SQL = `SELECT completed_payload FROM tasks`\n",
        },
        "task outcome column completed_payload outside",
        "host binaries are production sources",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/contract.ts": (
                "export const read = (row: { failure_reason: unknown }) => row.failure_reason\n"
            ),
        },
        "task outcome column failure_reason outside",
        "contract.ts may name the columns as data, but its code is still audited",
    ),
    (
        "outcome-lint.py",
        {"packages/README.md": "no sources\n"},
        "refusing a vacuous audit",
        "an empty harvest must not pass as a clean audit",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/src/status.tsx": "export const SQL = `SELECT completed_payload FROM tasks`\n",
        },
        "task outcome column completed_payload outside",
        "a .tsx source is a production source",
    ),
    (
        "outcome-lint.py",
        {
            "packages/driver/src/probe.mts": (
                "export const reason = (row: Record<string, unknown>) => row.failure_reason\n"
            ),
        },
        "task outcome column failure_reason outside",
        "a .mts source is a production source",
    ),
    (
        "outcome-lint.py",
        {
            "packages/driver/src/probe.cts": (
                "export const reason = (row: Record<string, unknown>) => row.failure_reason\n"
            ),
        },
        "task outcome column failure_reason outside",
        "a .cts source is a production source",
    ),
    (
        "outcome-lint.py",
        {"packages/core/src/contract.ts": "export const SQL = `SELECT failure_reason FROM tasks`\n"},
        "task outcome column failure_reason outside",
        "SQL in contract.ts is audited like any production source",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/src/view.tsx": (
                "export const View = (row: Record<string, unknown>) => (\n"
                "  <p>it's done: {String(row.completed_payload)}</p>\n"
                ")\n"
            ),
        },
        "task outcome column completed_payload outside",
        "JSX text must not hide an outcome column in a .tsx source",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM runs WHERE state IN ('pending','running')`\n",
            name="probe.ts",
        ),
        "raw state list outside fragments.ts",
        "a raw state list outside fragments.ts is a second definition of 'live'",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM runs WHERE state in ('pending','running')`\n",
            name="probe.ts",
        ),
        "raw state list outside fragments.ts",
        "SQL keywords are case-insensitive, so lowercase in cannot bypass the live-state definition",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM runs WHERE state\n  IN ('pending','running')`\n",
            name="probe.ts",
        ),
        "raw state list outside fragments.ts",
        "SQL whitespace may split a raw live-state list across source lines",
    ),
    (
        "determinism-lint.sh",
        {"packages/core/src/probe.ts": "export const at = Date.now()\n"},
        "determinism violation:",
        "ambient time in engine source is the nondeterminism this repo forbids",
    ),
    (
        "user-boundary-lint.sh",
        {"packages/sdk/src/probe.ts": "import { durationToMs } from '@durablerun/core'\n"},
        "user-boundary violation:",
        "the SDK using the raw validator makes bad input retryable instead of fatal",
    ),
    (
        "session-state.sh",
        {"README.md": "a non-Git work directory\n"},
        "git worktree list failed",
        "missing Git evidence must not be reported as a clean session",
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
        "deferred to a later round",
        "work parked under a completed entry is dropped silently, because DONE is skipped",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 something** — DONE. It shipped.\n"
                "  - **TODO:** add the missing mechanism.\n"
            )
        },
        "TODO:",
        "TODO still names unfinished work when it appears under a completed entry",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 something** — DONE. It shipped.\n"
                "  - **A gap requiring closure:** add the missing mechanism.\n"
            )
        },
        "requiring closure:",
        "requiring closure still names unfinished work under a completed entry",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- TODO: the fence-provenance mechanism, deferred to whoever picks this up\n\n"
                "- **PR9.9 owned work** — planned.\n"
            )
        },
        "deferred work belongs to no PR entry",
        "a deferral before the first PR entry is unowned rather than exempt",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.8 live work** — planned.\n"
                "  - **Owned work** — implement the live entry.\n"
                "* **PR9.9 completed work** — DONE. It shipped.\n"
                "  - **TODO:** add the missing mechanism.\n"
            )
        },
        "PR9.9 is DONE and still owns deferred work",
        "an alternate top-level bullet marker must not hide a completed PR's deferral",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 current work** — planned.\n"
                "  - **Owned mechanism** — implement it here.\n"
            ),
            "postmortems/fixture-plan.md": (
                "# Historical implementation plan\n\n"
                "## Cannot be made structural — documented deferrals (BUILD.md)\n\n"
                "1. The typed target API is **Deferred, explicitly.**\n"
            ),
        },
        "historical plan does not declare BUILD.md as its sole current status owner",
        "a decision-time plan must not impersonate the current delivery ledger after its work lands",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 current work** — planned.\n"
                "  - **Owned mechanism** — implement it here.\n"
            ),
            "postmortems/fixture-proposal.md": (
                "# Historical implementation plan\n\n"
                "## Current status\n\n"
                "The typed target API is still deferred.\n"
            ),
        },
        "historical plan does not declare BUILD.md as its sole current status owner",
        "document role must come from structure rather than a filename ending in -plan.md",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 current work** — planned.\n"
                "  - **Owned mechanism** — implement it here.\n"
            ),
            "postmortems/fixture-plan.md": (
                "# Historical implementation plan\n\n"
                "> **Historical decision record.** Status is frozen at decision time; "
                "`BUILD.md` is the sole current status owner.\n\n"
                "## Current status\n\n"
                "The typed target API is still deferred.\n"
            ),
        },
        "historical plan claims current delivery status",
        "a canonical banner is an assertion, not proof, when the same document still publishes a current-status section",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 compiler work** — planned.\n"
                "  Spiked at scratchpad/compiler-spike: the prototype worked.\n"
            ),
        },
        "BUILD.md points at transient scratchpad state",
        "the canonical live plan cannot cite an uncommitted scratchpad as auditable evidence",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 compiler work** (candidate, spiked not started).\n"
                "  The implementation will be proved by checked-in tests.\n"
            ),
        },
        "BUILD.md claims an unauditable spike",
        "removing the scratchpad pathname must not leave its unsupported delivery claim behind",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('brand-new-label', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch label 'brand-new-label' is not in the ledger block",
        "a batch label mapped to no TLA action must fail until it is mapped or excluded",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "packages/store-mysql/src/probe.ts": (
                "await this.db.batch('mysql-brand-new-label', "
                "[{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch label 'mysql-brand-new-label' is not in the ledger block",
        "the language-neutral ledger must harvest labels from every dialect store",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
                "const batch = this.db.batch.bind(this.db)\n"
                "await batch('brand-new-label', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "an indirect executor call must fail closed rather than vanish from the ledger and fault matrix",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
                "await (this.db).batch('brand-new-label', "
                "[{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "parenthesizing the database receiver must not erase a batch from the language-neutral label inventory",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
                "const { batch: execute } = this.db\n"
                "await execute('brand-new-label', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "renamed destructuring of the executor must fail closed instead of hiding a batch",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/probe.ts": (
                "await this.db.batch('cancel-task', [{ sql: `SELECT 1`, args: [] }])\n"
                "await this.db.batch('sweep:cancel', [{ sql: `SELECT 1`, args: [] }])\n"
                "const db: StoreDatabase = this.db\n"
                "await db.batch('brand-new-label', [{ sql: `SELECT 1`, args: [] }])\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "a type annotation on a database alias must not make the aliased executor invisible",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/store.ts": (
                "import { FencedBatch } from '@durablerun/core'\n"
                "async function cancel(label: 'cancel-task' | 'sweep:cancel') {\n"
                "  return new FencedBatch(label, token(), {})\n"
                "}\n"
                "async function probe(label: 'brand-new-label') {\n"
                "  return new FencedBatch(label, token(), {})\n"
                "}\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* 'sweep:cancel' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "opaque label classification is not unique to one binding",
        "a path-and-variable-name allowlist must not classify a second unrelated dynamic batch as the cancel transition",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/store.ts": (
                "import { FencedBatch } from '@durablerun/core'\n"
                "export class Store {\n"
                "  async visible() {\n"
                "    const b = new FencedBatch('cancel-task', token(), {})\n"
                "    await b.run(this.db)\n"
                "  }\n"
                "  async hidden(label: string) {\n"
                "    const b = {\n"
                "      run: (db: any) => db.batch(label, [{ sql: `SELECT 1`, args: [] }]),\n"
                "    }\n"
                "    await b.run(this.db)\n"
                "  }\n"
                "}\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "an executor name authorized in one scope must not authorize an unrelated binding that receives this.db in another scope",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/store.ts": (
                "export class Store {\n"
                "  async hidden(db: any, label: string) {\n"
                "    await db.batch(label, [{ sql: `SELECT 1`, args: [] }])\n"
                "  }\n"
                "}\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "every executable .batch call in a store source must use the one canonical this.db.batch door",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/store.ts": (
                "import { FencedBatch } from '@durablerun/core'\n"
                "export class Store {\n"
                "  async hidden(label: string) {\n"
                "    const b = new FencedBatch('cancel-task', token(), {})\n"
                "    const invoke = async (b: any) => b.run(this.db)\n"
                "    await invoke({\n"
                "      run: (db: any) => db.batch(label, [{ sql: `SELECT 1`, args: [] }]),\n"
                "    })\n"
                "  }\n"
                "}\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* 'cancel-task' -> excluded [read]\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "a nested parameter must shadow an outer fenced binding before it can receive this.db",
    ),
    (
        "spec-ledger.py",
        {
            "packages/store-libsql/src/store.ts": (
                "import { FencedBatch } from '@durablerun/core'\n"
                "export class Store {\n"
                "  async hidden(b: FencedBatch, label: string) {\n"
                "    b = {\n"
                "      run: (db: any) => db.batch(label, [{ sql: `SELECT 1`, args: [] }]),\n"
                "    } as any\n"
                "    await b.run(this.db)\n"
                "  }\n"
                "}\n"
            ),
            "specs/Scheduler.tla": (
                "---- MODULE Scheduler ----\n"
                "\\* BATCH-LABEL LEDGER\n"
                "\\* --------------------\n\n"
                "====\n"
            ),
        },
        "batch call shape is opaque",
        "a typed fenced parameter cannot remain authorized after reassignment",
    ),
    (
        "batch-lint.py",
        store(
            """
export class Store {
  async hidden() {
    await this.client.batch('hidden', [])
  }
}
"""
        ),
        "batch call shape is opaque",
        "the libSQL transport exception must not authorize this.client.batch in an arbitrary store",
    ),
    (
        "batch-lint.py",
        {
            "packages/store-libsql/src/executor.ts": """
export class LibsqlExecutor implements SqlExecutor {
  async batch(statements: readonly unknown[]) {
    await this.client.batch(statements)
  }

  async hidden(statements: readonly unknown[]) {
    await this.client.batch(statements)
  }
}
""",
        },
        "batch call shape is opaque",
        "even the transport owner must expose exactly one driver batch call in its canonical method",
    ),
    (
        "batch-lint.py",
        store(
            """
export class Store {
  async hidden() {
    await this.client['batch']('hidden', [])
  }
}
"""
        ),
        "batch call shape is opaque",
        "a computed client member must not become an invisible transport batch",
    ),
    (
        "batch-lint.py",
        store(
            """
export async function hidden(external: unknown) {
  await external['batch']('hidden', [])
}
"""
        ),
        "batch call shape is opaque",
        "a computed member call can resolve to batch and must fail closed",
    ),
    (
        "batch-lint.py",
        store(
            """
export async function hidden(external: unknown) {
  const { batch: invoke } = external
  await invoke('hidden', [])
}
"""
        ),
        "batch call shape is opaque",
        "destructuring a batch member must not erase the executor call",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden() {
    const b = new FencedBatch('cancel-task', token(), { now: NOW_MS })
    {
      class b {
        static run(db: unknown) {
          return db['batch']('hidden', [])
        }
      }
      await b.run(this.db)
    }
  }
}
"""
        ),
        "batch call shape is opaque",
        "a class declaration must shadow an outer fenced binding by compiler identity",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden(b: FencedBatch, values: unknown[]) {
    for (b of values) {
      consume(b)
    }
    await b.run(this.db)
  }
}
"""
        ),
        "batch call shape is opaque",
        "a for-of target is a write that invalidates a fenced parameter",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden() {
    const b = new FencedBatch('cancel-task', token(), { now: NOW_MS })
    const attacker = {
      db: evilExecutor,
      async invoke() {
        await b.run(this.db)
      },
    }
    await attacker.invoke()
  }
}
"""
        ),
        "batch call shape is opaque",
        "a regular nested method rebinds this and cannot lend its executor to a fenced batch",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from './evil'

export class Store {
  async hidden() {
    const b = new FencedBatch('hidden', token(), { now: NOW_MS })
    await b.run(this.db)
  }
}
"""
        ),
        "batch call shape is opaque",
        "the FencedBatch constructor must resolve to the canonical core import",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'
import { evil } from './evil'

export class Store {
  async hidden(opts: { evil: FencedBatch }) {
    await evil.run(this.db)
  }
}
"""
        ),
        "batch call shape is opaque",
        "a typed object member is not a parameter binding and cannot authorize an imported attacker",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden(b: FencedBatch, label: string) {
    poison()
    await b.run(this.db)
    function poison() {
      b = { run: (db: unknown) => db['batch'](label, []) } as any
    }
  }
}
"""
        ),
        "batch call shape is opaque",
        "a hoisted function can mutate a fenced parameter before a textually earlier run",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden(b: FencedBatch, label: string) {
    if (true) {
      var b = { run: (db: unknown) => db['batch'](label, []) }
    }
    await b.run(this.db)
  }
}
"""
        ),
        "batch call shape is opaque",
        "a var declaration is function-scoped and can overwrite a fenced parameter",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async hidden(b: FencedBatch) {
    ;(b as unknown as { run: unknown }).run = evil
    await b.run(this.db)
  }
}
"""
        ),
        "batch call shape is opaque",
        "a cast must not hide a direct write to a fenced executor method",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py", "orphan-lint.py"),
        ),
        "scripts/orphan-lint.py is not run by `pnpm verify`",
        "a checker sits in scripts/ that the verify chain never runs and nothing declares",
    ),
    (
        "gate-lint.py",
        process_docs(
            (
                "Heavy runs use scripts/confine.sh with MemoryMax 16G and "
                "CPUQuota 3200%.\n"
            ),
            TRANSPORT_BLOCK,
        ),
        "AGENTS.md confinement section must defer all quantitative policy",
        "copied resource numbers drift from the executable confinement policy",
    ),
    (
        "gate-lint.py",
        process_docs(
            CONFINE_SECTION_BODY,
            (
                "A malformed report, suite error, or disagreement is a wrong-path "
                "result. Missing or signaled output is infrastructure failure.\n"
            ),
        ),
        "BUILD.md misclassifies malformed suite transport",
        "reporter transport failure must never be documented as a domain verdict",
    ),
    (
        "gate-lint.py",
        {
            rel: body
            for rel, body in process_docs(
                CONFINE_SECTION_BODY,
                TRANSPORT_BLOCK,
            ).items()
            if rel != "AGENTS.md"
        },
        "durablerun process contract source AGENTS.md is missing",
        "deleting one process-contract source must fail closed",
    ),
    (
        "gate-lint.py",
        {
            rel: body
            for rel, body in process_docs(
                CONFINE_SECTION_BODY,
                TRANSPORT_BLOCK,
            ).items()
            if rel != "BUILD.md"
        },
        "durablerun process contract source BUILD.md is missing",
        "deleting the plan-side process contract must fail closed",
    ),
    (
        "gate-lint.py",
        {
            rel: body
            for rel, body in process_docs(
                CONFINE_SECTION_BODY,
                TRANSPORT_BLOCK,
            ).items()
            if rel != "scripts/confine.sh"
        },
        "durablerun process contract source scripts/confine.sh is missing",
        "deleting the executable policy owner must fail closed",
    ),
    (
        "gate-lint.py",
        process_docs(
            CONFINE_SECTION_BODY
            + " The cap is sixteen gibibytes and thirty-two cores.",
            TRANSPORT_BLOCK,
        ),
        "AGENTS.md confinement section must defer all quantitative policy",
        "spelling numeric limits as words must not bypass the single-definition rule",
    ),
    (
        "gate-lint.py",
        process_docs(
            CONFINE_SECTION_BODY
            + "\n\nThe confinement cap is ninety-nine gibibytes.",
            TRANSPORT_BLOCK,
        ),
        "AGENTS.md confinement section must defer all quantitative policy",
        "a second paragraph before the next heading extends the confinement contract",
    ),
    (
        "gate-lint.py",
        {
            **process_docs(CONFINE_SECTION_BODY, TRANSPORT_BLOCK),
            "package.json": json.dumps(
                {
                    "name": "durablerun",
                    "scripts": {
                        "verify": (
                            "python3 scripts/a-lint.py && "
                            "python3 scripts/b-lint.py && "
                            "python3 scripts/lint-selftest.py"
                        ),
                    },
                }
            ),
        },
        "package.json must route verify:mutations exactly to mutation-probe.py",
        "deleting the documented mutation-audit command must fail the process contract",
    ),
    (
        "gate-lint.py",
        {
            **process_docs(CONFINE_SECTION_BODY, TRANSPORT_BLOCK),
            "package.json": json.dumps(
                {
                    "name": "durablerun",
                    "scripts": {
                        "verify": (
                            "python3 scripts/a-lint.py && "
                            "python3 scripts/b-lint.py && "
                            "python3 scripts/lint-selftest.py"
                        ),
                        "verify:mutations": "echo mutation-probe.py",
                    },
                }
            ),
        },
        "package.json must route verify:mutations exactly to mutation-probe.py",
        "printing the runner name is not execution of the documented audit command",
    ),
] + [
    (
        "gate-lint.py",
        *hidden_process_bad_case_payload(case),
    )
    for case in hidden_process_cases()
] + [
    (
        "gate-lint.py",
        nested_build_contract("fence"),
        "BUILD.md misclassifies malformed suite transport",
        "a list-marker-prefixed fence cannot make its nested contract operative",
    ),
    (
        "gate-lint.py",
        nested_build_contract("raw-html"),
        "BUILD.md misclassifies malformed suite transport",
        "a list-marker-prefixed raw HTML block cannot own a nested contract",
    ),
    (
        "gate-lint.py",
        nested_build_contract("deindented"),
        "BUILD.md misclassifies malformed suite transport",
        "a deindent terminates the owning list before the transport block",
    ),
    (
        "gate-lint.py",
        nested_build_contract("wrong-owner"),
        "BUILD.md misclassifies malformed suite transport",
        "the transport block must remain a child of its exact owning list item",
    ),
    (
        "gate-lint.py",
        raw_agent_contract("</div>"),
        "AGENTS.md confinement section must defer all quantitative policy",
        "a raw closing block tag can hide the following Markdown heading",
    ),
    (
        "gate-lint.py",
        raw_agent_contract("<div/>"),
        "AGENTS.md confinement section must defer all quantitative policy",
        "a self-closing raw block tag can hide the following Markdown heading",
    ),
    (
        "gate-lint.py",
        raw_agent_contract("<div></div>"),
        "AGENTS.md confinement section must defer all quantitative policy",
        "a same-line raw block tag remains open through the next blank line",
    ),
    (
        "gate-lint.py",
        raw_agent_contract("<pre class=x", "</pre>"),
        "AGENTS.md confinement section must defer all quantitative policy",
        "a type-one raw HTML block does not require a closing angle bracket",
    ),
    (
        "gate-lint.py",
        gate("python3 scripts/a-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py",), base_gate=False),
        "ci.yml has 0 base-gate jobs",
        "no base-gate job, so the whole gate is graded by the branch under review",
    ),
    (
        "gate-lint.py",
        gate("vitest run", ()),
        "`pnpm verify` reaches only 0 script(s)",
        "a verify chain that runs no checker makes every other rule here vacuous",
    ),
    (
        "gate-lint.py",
        {
            **gate("python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py", "b-lint.py")),
            "scripts/lint-selftest.py": (
                'BAD_CASES = [("a-lint.py",)]\nBAD_INVOCATIONS = []\n'
            ),
        },
        "scripts/b-lint.py runs in the gate but scripts/lint-selftest.py never exercises it",
        "a checker runs in the gate with nothing proving it can reject anything",
    ),
    (
        "gate-lint.py",
        {
            **gate(
                "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
                "&& python3 scripts/fence-audit.py && python3 scripts/lint-selftest.py",
                ("a-lint.py", "b-lint.py", "fence-audit.py"),
            ),
            "scripts/lint-selftest.py": (
                'BAD_CASES = [("a-lint.py",), ("b-lint.py",)]\n'
                'GOOD_CASES = [("fence-audit.py",)]\n'
            ),
        },
        "scripts/fence-audit.py runs in the gate but scripts/lint-selftest.py never exercises it",
        "a gate checker mentioned only by an acceptance case has no proof it can refuse",
    ),
    (
        "gate-lint.py",
        {
            rel: body
            for rel, body in gate(
                "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
                "&& python3 scripts/lint-selftest.py",
                ("a-lint.py", "b-lint.py"),
            ).items()
            if rel != "scripts/lint-selftest.py"
        },
        "scripts/lint-selftest.py cannot be read",
        "a missing self-test source must be a normal refusal, never a checker crash",
    ),
    (
        "gate-lint.py",
        gate(
            "echo scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
        ),
        "scripts/a-lint.py is not run by `pnpm verify`",
        "a checker path printed by echo is a textual reference, not an execution",
    ),
    (
        "gate-lint.py",
        gate(
            "exit 0; python3 scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
        ),
        "uses unsupported shell control ';'",
        "a checker after an unconditional exit is unreachable despite appearing in the script",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
            base_gate_run=False,
        ),
        "does not actively run `python3 scripts/gate-lint.py --run-base HEAD BASE`",
        "an empty base-gate mapping executes no base-owned composition or checker runner",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
            nightly=False,
        ),
        ".github/workflows/nightly.yml is missing",
        "deleting the long-running verification workflow must not make its safety checks vacuous",
    ),
    (
        "review-bot-lint.py",
        red_pair_corpus(
            red_pair_rule(
                "Flag a repair whose test and fix share one commit unless its message "
                "quotes the observed failure. Pass for separate red-test and fix commits."
            ),
            "Flag a repair whose test and fix share one commit unless its message "
            "quotes the observed failure. Pass for separate red-test and fix commits.",
        ),
        "does not unconditionally reject a regression test and fix sharing one commit",
        "the red-pair synopsis makes its rejection conditional on commit prose",
    ),
    (
        "review-bot-lint.py",
        red_pair_corpus(
            red_pair_rule(
                "Flag a repair whose regression test and fix share one commit. "
                "Pass for separate red-test and fix commits and combined commits "
                "quoting the failure they saw."
            ),
            "Flag a repair whose regression test and fix share one commit. "
            "Pass for separate red-test and fix commits and combined commits "
            "quoting the failure they saw.",
        ),
        "Pass for arm permits combined repair commits",
        "the red-pair synopsis cannot waive the two-commit invariant",
    ),
    (
        "review-bot-lint.py",
        red_pair_corpus(
            red_pair_rule(
                RED_PAIR_SYNOPSIS,
                "\n- **A combined commit quoting its observed failure.**",
            ),
            RED_PAIR_SYNOPSIS,
        ),
        "Allowed cases section permits a combined repair commit",
        "the detailed allowed cases cannot contradict the mandatory pair",
    ),
    (
        "review-bot-lint.py",
        red_pair_corpus(
            red_pair_rule(
                "Flag a repair whose regression test and fix share one commit."
            ),
            "Flag a repair whose regression test and fix share one commit.",
        ),
        "active-review synopsis must state both a 'Flag' rejection arm and a 'Pass for' allowance arm",
        "a malformed red-pair synopsis must produce a normal verdict instead of crashing",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE.replace("Allowed cases (do NOT flag these):", "Some other heading:")),
        "has no 'the shapes that must NOT be flagged' section",
        "a rule with no Allowed section — it will flag correct code and be switched off",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, in_coderabbit=False),
        "has 0 active CodeRabbit checks named 'durablerun: a-rule'",
        "a rule no config references, so no reviewer ever applies it",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_id="durablerun-renamed"),
        "has 0 Greptile rules with id 'durablerun-a-rule'",
        "a config naming a rule file that does not exist points the reviewer at nothing",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, coderabbit_name="x" * 60),
        "CodeRabbit refuses the whole file at 50 or more",
        "a custom-check name CodeRabbit refuses, which voids the whole config file",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, status_check=False),
        'does not set "statusCheck": true',
        "Greptile posting no status check, so its findings cannot gate anything",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".github/review-bot-rules/README.md",
            HOSTED_GATE_NOTE,
            HOSTED_GATE_NOTE.replace(
                "they do not define per-check GitHub status contexts",
                "`statusCheck: true` is already set for every custom check",
            ),
        ),
        "hosted-gate note is not the canonical account of active configuration",
        "README claiming CodeRabbit has a per-custom-check status field its schema does not expose",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "        mode: error\n",
            "        mode: error\n        statusCheck: true\n",
        ),
        "has unsupported field 'statusCheck'",
        "an invented CodeRabbit custom-check field is rejected instead of silently ignored",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "        mode: error\n",
            '        mode: error\n        "statusCheck": true\n',
        ),
        "has unrecognized custom-check field syntax",
        "a quoted unsupported field cannot fall outside the custom-check allowlist",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "        mode: error\n",
            "        mode: error\n        <<: *custom-check-defaults\n",
        ),
        "has unrecognized custom-check field syntax",
        "a YAML merge cannot inject custom-check fields outside the owned literal shape",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "        mode: error\n",
            '        mode: error\n         "statusCheck": true\n',
        ),
        "has unrecognized custom-check indentation",
        "an invalid nine-space field cannot sit between the owned field and body shapes",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "    custom_checks:\n",
            "    custom_checks:\n      statusCheck: true\n",
        ),
        "has unrecognized content before its first custom check",
        "invalid mapping content cannot hide in the custom-check list prelude",
    ),
    (
        "review-bot-lint.py",
        replaced(
            corpus(WHOLE_RULE),
            ".coderabbit.yaml",
            "  request_changes_workflow: true\n",
            "  request_changes_workflow: false\n",
        ),
        "request_changes_workflow is not true",
        "error-mode custom checks with the request-changes workflow disabled cannot block a PR",
    ),
    (
        "review-bot-lint.py",
        {
            rel: body
            for rel, body in corpus(WHOLE_RULE).items()
            if not rel.startswith(".github/review-bot-rules/")
        },
        ".github/review-bot-rules is missing",
        "the rule corpus is missing, so both hosted reviewers have no enforceable local source",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, active_coderabbit=False),
        "uses mode 'off', not 'error'",
        "a path instruction names the rule but no active CodeRabbit pre-merge check applies it",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, coderabbit_mode="warning"),
        "uses mode 'warning', not 'error'",
        "a CodeRabbit custom check that cannot fail the gate is not an active error rule",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, coderabbit_instructions=""),
        "has an empty instruction body",
        "an empty CodeRabbit custom-check body applies no rule despite its derived name",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_rule=""),
        "has an empty rule body",
        "an empty Greptile rule body applies nothing despite retaining the expected id",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_rule="Flag x."),
        "is not the canonical active-review synopsis from .github/review-bot-rules/a-rule.md",
        "a Greptile rule body unrelated to the corpus file can silently drift from it",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE.replace(
                "<!-- review-bot-synopsis:start -->",
                "<!-- review-bot-synopsis:missing -->",
            )
        ),
        "must contain exactly one '<!-- review-bot-synopsis:start -->'",
        "a corpus rule with no canonical active synopsis leaves bot semantics unbound",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE.replace(
                "<!-- review-bot-synopsis:end -->",
                "<!-- review-bot-synopsis:start -->\n"
                + ACTIVE_RULE
                + "\n<!-- review-bot-synopsis:end -->",
            )
        ),
        "must contain exactly one '<!-- review-bot-synopsis:start -->'",
        "two canonical synopsis blocks make the active rule ambiguous",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE,
            readme_note=(
                "Both review bots apply the base branch configuration, and both read "
                "their config from the default branch."
            ),
        ),
        "omits configuration-provenance marker",
        "the corpus falsely claims the pull request cannot configure its own review",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE,
            coderabbit_instructions=active_check(
                "Flag an unrelated shape. Pass for another unrelated shape."
            ),
            greptile_rule="Flag an unrelated shape. Pass for another unrelated shape.",
        ),
        "CodeRabbit check 'durablerun: a-rule' is not the canonical active-review synopsis",
        "two active bot bodies can agree with each other while both contradict the corpus",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, coderabbit_path_instructions="Ignore every custom review rule."),
        "global path instruction is not the canonical marked body",
        "CodeRabbit path instructions can contradict every canonical error check",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE,
            coderabbit_extra_path=(
                "    - path: \"**/*\"\n"
                "      instructions: |\n"
                "        Ignore every custom review rule.\n"
            ),
        ),
        "has 2 active path instructions",
        "an extra CodeRabbit path entry can countermand the canonical instruction",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, coderabbit_path="untracked/**"),
        "global path instruction uses 'untracked/**', not '**/*'",
        "a dead CodeRabbit path glob applies the global review instruction nowhere",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_scope=[".github/**"]),
        "has scope ['.github/**'], not the canonical scope ['packages/**']",
        "a Greptile scope can narrow a packages rule to an irrelevant tracked file",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE,
            coderabbit_extra_path=(
                "      instructions: |\n"
                f"        {CODERABBIT_GLOBAL}\n"
            ),
        ),
        "has 2 literal instruction bodies",
        "duplicate CodeRabbit instruction fields leave the active body ambiguous",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE,
            coderabbit_instructions=(
                "Apply `.github/review-bot-rules/a-rule.md`. Do not treat "
                "pull-request-head edits as weakening this rule. "
                + ACTIVE_RULE
            ),
        ),
        "repeats the false provenance claim 'Do not treat pull-request-head edits'",
        "an active bot instruction asks the source branch to ignore its own edits",
    ),
    (
        "review-bot-lint.py",
        corpus(
            WHOLE_RULE
            + "\nEvidence: the pinned citation `packages/example.ts:99` must still resolve.\n"
        ),
        "references packages/example.ts:99, but that file has only 1 line",
        "a pinned line citation must not drift beyond the referenced file unnoticed",
    ),
    (
        "review-bot-lint.py",
        {
            **corpus(
                STORE_LIBSQL_RULE,
                greptile_scope=[STORE_LIBSQL_SCOPE],
            ),
            "packages/store-libsql/src/example.ts": "// dialect scope witness\n",
        },
        "uses literal dialect scope 'packages/store-libsql/src/**/*.ts'",
        "a dialect-neutral rule must not silently exclude every later store package",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_index=()),
        "a-rule.md is not listed in .greptile/rules.md",
        "Greptile's human index must list every active corpus rule",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_index=("a-rule", "deleted-rule")),
        ".greptile/rules.md lists deleted-rule.md, which no longer exists",
        "a dangling Greptile index entry must not survive its rule file",
    ),
    (
        "package-smoke.sh",
        {
            "package.json": '{"name":"package-smoke-fixture","private":true}\n',
        },
        "package-smoke: found no package manifests",
        "an empty package inventory must fail the clean-consumer packaging gate",
    ),
    (
        "gate-lint.py",
        {
            **gate(
                "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
                "&& python3 scripts/lint-selftest.py",
                ("a-lint.py", "b-lint.py"),
            ),
            ".github/workflows/nightly.yml": (
                "name: nightly\n"
                "on: workflow_dispatch\n"
                "jobs:\n"
                "  proof:\n"
                "    runs-on: ubuntu-latest\n"
                "    steps:\n"
                "      - uses: actions/checkout@v4\n"
                "      - run: pnpm verify\n"
            ),
        },
        "nightly checkout must disable persisted credentials",
        "a scheduled verification checkout must not retain a write-capable token",
    ),
] + [
    (
        "clock-lint.py",
        store(f"const SQL = `SELECT {spelling} AS t`\n"),
        "raw wall-clock function in store SQL",
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
        "CURDATE()",
        "curdate()",
        "CURTIME()",
        "curtime()",
    )
]

# Git inventory is an input to the scope checker, so exercise each observable
# state explicitly instead of letting the fixture runner always create one.
GIT_BAD_CASES = [
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE),
        "unavailable",
        "git ls-files failed, so review scopes cannot be audited",
        "an unavailable tracked-file inventory must not make scope coverage vacuous",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE),
        "empty",
        "git ls-files returned no paths",
        "an empty tracked-file inventory must not make scope coverage vacuous",
    ),
    (
        "review-bot-lint.py",
        corpus(WHOLE_RULE, greptile_scope=["untracked/**"]),
        "tracked",
        "matches no tracked file",
        "a dead Greptile scope must be measured against the tracked-file inventory",
    ),
]

ENV_BAD_CASES = [
    (
        "session-state.sh",
        {
            "README.md": "a process-enumeration fixture\n",
            "fail-python.sh": (
                "python3() {\n"
                "  printf '%s\\n' 'session-state: injected process graph failure' >&2\n"
                "  return 7\n"
                "}\n"
            ),
        },
        {"BASH_ENV": "{root}/fail-python.sh"},
        "session-state: injected process graph failure",
        "a failed process-graph scan must not become an empty ownership inventory",
    ),
]


@dataclass(frozen=True)
class SessionProcessCase:
    case_id: str
    topology: str
    expected: str
    why: str
    detail: str | None = None
    expected_marker: str | None = None


# These are live-process fixtures because /proc ancestry and cwd are the
# contract. A fake ps listing would merely test a second representation of
# that contract and could drift independently of the kernel surface.
SESSION_PROCESS_CASES = (
    SessionProcessCase(
        "relative-repo-cwd",
        "repo",
        "reported",
        "a relative non-sleep command running in the repository is live work",
    ),
    SessionProcessCase(
        "unrelated-tmp-sleep",
        "outside-sleep",
        "clean",
        "a sleep outside every repository root is not evidence about this session",
    ),
    SessionProcessCase(
        "repo-owned-descendant",
        "descendant",
        "reported",
        "a child remains repository-owned after changing its own cwd",
    ),
    SessionProcessCase(
        "registered-worktree-cwd",
        "worktree",
        "reported",
        "every registered worktree is a repository process root",
    ),
    SessionProcessCase(
        "foreign-session-inherited-cwd",
        "foreign-cwd",
        "clean",
        "an unrelated session initializer that inherited the repository cwd is not repository work",
    ),
    SessionProcessCase(
        "foreign-session-explicit-argv",
        "foreign-argv",
        "reported",
        "an explicit repository argv remains evidence even after a process leaves this session",
    ),
    SessionProcessCase(
        "invocation-pipeline-reader",
        "pipeline-reader",
        "clean",
        "the process consuming this checker's own stdout is invocation furniture",
    ),
    SessionProcessCase(
        "same-pgid-background-work",
        "same-pgid",
        "reported",
        "a pre-existing repository job must not disappear merely because it shares the invocation process group",
    ),
    SessionProcessCase(
        "stdin-shell-work",
        "bash-stdin",
        "reported",
        "a shell executing a stdin script with only builtin waits is work, not interactive furniture",
    ),
    *(
        SessionProcessCase(
            f"argv-shell-{name}",
            "shell-operator",
            "reported",
            f"a repository path adjacent to shell operator {operator!r} is explicit argv evidence",
            detail=operator,
        )
        for name, operator in (
            ("and", "&&"),
            ("or", "||"),
            ("pipe", "|"),
            ("output", ">"),
            ("input", "<"),
        )
    ),
    SessionProcessCase(
        "removed-worktree-live-process",
        "removed-worktree",
        "refused",
        "a live process in a removed worktree has indeterminate deleted-cwd provenance",
        expected_marker="cannot prove ownership of deleted working directory",
    ),
    SessionProcessCase(
        "empty-worktree-inventory",
        "worktree-inventory-empty",
        "refused",
        "a successful but empty worktree inventory cannot prove process scope",
        expected_marker="git worktree inventory omitted the current repository root",
    ),
    SessionProcessCase(
        "malformed-worktree-inventory",
        "worktree-inventory-malformed",
        "refused",
        "a malformed worktree inventory cannot become an incomplete clean snapshot",
        expected_marker="malformed git worktree inventory",
    ),
)


BAD_INVOCATIONS = [
    (
        "review-attest.sh",
        {
            "postmortem.md": """# Postmortem: fixture

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | one | impact | layer | reason | mechanism |
| 2 | two | impact | layer | reason | mechanism |

## Detection ledger

- External review: 2
""",
        },
        ("--check-postmortem", "{root}/postmortem.md"),
        "no parsable detection ledger rows",
        "a prose ledger must not let a postmortem's finding count pass unaccounted",
    ),
    (
        "review-attest.sh",
        {
            "postmortem.md": """# Postmortem: fixture

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | one | impact | layer | reason | mechanism |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| external review | 1 | no | unparsed extra cell |
""",
        },
        ("--check-postmortem", "{root}/postmortem.md"),
        "detection ledger row with 4 data cells; expected exactly 3",
        "an extra ledger cell must not be silently discarded from the canonical table",
    ),
    (
        "batch-lint.py",
        store(
            "await this.db.batch('brand-new-write', "
            "[{ sql: `UPDATE tasks SET a = 1`, args: [] }])\n"
        ),
        ("--not-a-root",),
        "unknown option '--not-a-root'",
        "a dash-prefixed argument must not turn into an empty root",
    ),
    (
        "batch-lint.py",
        store(
            "await this.db.batch('brand-new-write', "
            "[{ sql: `UPDATE tasks SET a = 1`, args: [] }])\n"
        ),
        ("{root}/missing",),
        "root does not exist",
        "a nonexistent root must not grade an empty source set",
    ),
    (
        "batch-lint.py",
        {"packages/.keep": ""},
        ("{root}",),
        "no store TypeScript sources",
        "an empty packages directory must not make the batch audit vacuous",
    ),
    (
        "clock-lint.py",
        {"packages/.keep": ""},
        ("{root}",),
        "no store TypeScript sources",
        "an empty packages directory must not make the clock audit vacuous",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="probe.ts",
        ),
        ("--not-a-root",),
        "unknown option '--not-a-root'",
        "a dash-prefixed argument must not silently grade the checker's own tree",
    ),
    (
        "fragment-lint.py",
        store(
            "const SQL = `SELECT 1 FROM tasks WHERE cancel_at_ms <= 5`\n",
            name="probe.ts",
        ),
        ("{root}/missing",),
        "root does not exist",
        "a nonexistent root must not grade an empty fragment source set",
    ),
    (
        "fragment-lint.py",
        {"packages/.keep": ""},
        ("{root}",),
        "no store TypeScript sources",
        "an empty packages directory must not make the fragment audit vacuous",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
        ),
        ("--list-checker", "{root}"),
        "unknown option '--list-checker'",
        "a misspelled mode must not fall through to a different grading mode",
    ),
    (
        "gate-lint.py",
        gate(
            "python3 scripts/a-lint.py && python3 scripts/b-lint.py "
            "&& python3 scripts/lint-selftest.py",
            ("a-lint.py", "b-lint.py"),
        ),
        ("{root}", "{root}", "{root}"),
        "usage: gate-lint.py [ROOT [BASE]]",
        "the default grading mode must reject rather than ignore an extra root",
    ),
    (
        "review-attest.sh",
        {
            "aborted.log": (
                "review-head: fixture-head\n"
                "review analysis completed\n"
                "tokens used\n"
                "stream error: unexpected status 429 Too Many Requests\n"
            ),
        },
        ("--check-codex-log", "{root}/aborted.log", "fixture-head"),
        "codex log ENDS IN AN ERROR",
        "a non-prefixed stream error after the marker is an aborted review",
    ),
    (
        "review-attest.sh",
        {
            "missing-head.log": (
                "review analysis completed\n"
                "tokens used\n"
                "review verdict: no findings\n"
            ),
        },
        ("--check-codex-log", "{root}/missing-head.log", "fixture-head"),
        "codex log is not bound to a review head",
        "a completed-looking artifact without the reviewed commit cannot attest another head",
    ),
    (
        "review-attest.sh",
        {
            "wrong-head.log": (
                "review-head: stale-head\n"
                "review analysis completed\n"
                "tokens used\n"
                "review verdict: no findings\n"
            ),
        },
        ("--check-codex-log", "{root}/wrong-head.log", "fixture-head"),
        "codex log reviewed stale-head, expected fixture-head",
        "an artifact for an older commit must not attest the current head",
    ),
    (
        "review-attest.sh",
        {
            "missing-head.jsonl": (
                '{"type":"result","finding":"one","verdict":"accepted"}\n'
            ),
        },
        ("--check-journal", "{root}/missing-head.jsonl", "fixture-head"),
        "review journal is not bound to a review head",
        "a completed-looking multi-lens journal cannot attest an unrelated head",
    ),
    (
        "review-attest.sh",
        {
            "wrong-head.jsonl": (
                '{"type":"review-head","head":"stale-head"}\n'
                '{"type":"result","finding":"one","verdict":"accepted"}\n'
            ),
        },
        ("--check-journal", "{root}/wrong-head.jsonl", "fixture-head"),
        "review journal reviewed stale-head, expected fixture-head",
        "a multi-lens journal for an older commit must not attest the current head",
    ),
    (
        "review-attest.sh",
        {
            "incomplete.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
            ),
        },
        ("--check-journal", "{root}/incomplete.jsonl", "fixture-head"),
        "review journal has no terminal completion record",
        "an interrupted review must not attest after only its first result",
    ),
    (
        "review-attest.sh",
        {
            "missing-result.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system","tooling"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"review-complete","reviewers":["whole-system","tooling"]}\n'
            ),
        },
        ("--check-journal", "{root}/missing-result.jsonl", "fixture-head"),
        "review journal result inventory differs from its plan",
        "a completion marker cannot hide a planned reviewer that never reported",
    ),
    (
        "review-attest.sh",
        {
            "duplicate-result.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"review-complete","reviewers":["whole-system"]}\n'
            ),
        },
        ("--check-journal", "{root}/duplicate-result.jsonl", "fixture-head"),
        "review journal duplicates reviewer results",
        "two rows from one reviewer cannot answer for two independently planned lenses",
    ),
    (
        "review-attest.sh",
        {
            "extra-result.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"result","reviewer":"unplanned","verdict":"clean"}\n'
                '{"type":"review-complete","reviewers":["whole-system"]}\n'
            ),
        },
        ("--check-journal", "{root}/extra-result.jsonl", "fixture-head"),
        "review journal result inventory differs from its plan",
        "an unplanned result cannot substitute for the coordinator-owned reviewer inventory",
    ),
    (
        "review-attest.sh",
        {
            "early-completion.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"review-complete","reviewers":["whole-system"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
            ),
        },
        ("--check-journal", "{root}/early-completion.jsonl", "fixture-head"),
        "review journal terminal completion record must be last",
        "a completion record written before later work is not an atomic terminal barrier",
    ),
    (
        "review-attest.sh",
        {
            "out-of-order.jsonl": (
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-complete","reviewers":["whole-system"]}\n'
            ),
        },
        ("--check-journal", "{root}/out-of-order.jsonl", "fixture-head"),
        "review journal records are out of lifecycle order",
        "matching inventories do not prove that the head was bound and the review planned before results appeared",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 0\nreviews-abandoned:   \n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "reviews-abandoned requires a non-empty reason",
        "an empty abandonment trailer must not publish a successful review status",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "reviews-abandoned: reviewer service unavailable\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "review-findings must appear exactly once",
        "abandoning review artifacts never excuses the mandatory finding count",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 0\nreview-findings: 37\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "review-findings must appear exactly once",
        "a stale zero before the real count must not skip the nonzero SEV gate",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 37\nreview-findings: 0\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "review-findings must appear exactly once",
        "trailer order must not choose which of two conflicting finding counts is authoritative",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 37 reviewed\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "review-findings must be a canonical whole line",
        "trailing prose must not be silently discarded while parsing the incident count",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 00037\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "review-findings must use canonical decimal notation",
        "leading zeroes create a second textual representation of the incident count",
    ),
    (
        "gate-lint.py",
        base_runner_fixture(reject_from="python"),
        ("--run-base", "{root}/head", "{root}/base"),
        "base-owned scripts/a-lint.py rejected the head tree",
        "the base-owned Python checker rejects the head tree but is never executed",
    ),
    (
        "gate-lint.py",
        base_runner_fixture(reject_from="shell"),
        ("--run-base", "{root}/head", "{root}/base"),
        "base-owned scripts/b-lint.sh rejected the head tree",
        "the base-owned shell checker rejects the head tree but is omitted from execution",
    ),
    (
        "gate-lint.py",
        base_runner_fixture(reject_from=None, base_verify="pnpm test"),
        ("--run-base", "{root}/head", "{root}/base"),
        "base `pnpm verify` reaches zero script checkers",
        "a base gate containing zero checker invocations is accepted as meaningful",
    ),
    (
        "mutation-probe.py",
        {},
        (
            "--classifier-self-test",
            "--verifier-lock-self-test-drop-inheritance",
        ),
        (
            "--verifier-lock-self-test-drop-inheritance requires "
            "--verifier-lock-self-test-child"
        ),
        "a verifier-lock fault option must not be ignored by another self-test mode",
    ),
] + [
    (
        "mutation-probe.py",
        {},
        ("--classifier-self-test", "--self-test-fault", fault),
        f"self-test caught injected fault {fault}",
        f"the verdict classifier must reject its {fault} false-positive path",
    )
    for fault in (
        "ignore-file",
        "ignore-full-name",
        "ignore-marker",
        "match-marker-substring",
        "accept-suite-error",
        "accept-incoherent-report",
        "accept-malformed-report",
        "accept-collateral-assertion",
        "accept-collateral-message",
        "accept-orphan-verdict-marker",
        "accept-frozen-migration-mutation",
    )
]

ENV_BAD_INVOCATIONS = [
    (
        "review-attest.sh",
        {
            "codex.log": (
                "review-head: fixture-head\n"
                "review analysis completed\n"
                "tokens used\n"
                "review verdict: no findings\n"
            ),
            "fake-gh.sh": (
                "gh() {\n"
                "  if [[ \"$1\" == pr && \"$2\" == view ]]; then\n"
                "    case \"$5\" in\n"
                "      headRefOid) printf '%s\\n' fixture-head ;;\n"
                "      body) printf '%s\\n' 'review-findings: 0' ;;\n"
                "      commits) return 0 ;;\n"
                "      *) return 2 ;;\n"
                "    esac\n"
                "    return 0\n"
                "  fi\n"
                "  [[ \"$1\" == api ]] && return 0\n"
                "  return 2\n"
                "}\n"
            ),
        },
        ("12", "{root}/codex.log", "-"),
        {"BASH_ENV": "{root}/fake-gh.sh"},
        "workflow journal is required unless reviews are explicitly abandoned",
        "a valid Codex log alone cannot attest the mandatory multi-lens review",
    ),
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
        "batch-lint.py",
        {
            "packages/store-libsql/src/executor.ts": """
export class LibsqlExecutor implements SqlExecutor {
  async batch(statements: readonly unknown[]) {
    return this.client.batch(statements)
  }
}
""",
        },
        "the executor's single canonical client batch is the transport implementation door",
    ),
    (
        "batch-lint.py",
        store(
            """
import { FencedBatch } from '@durablerun/core'

export class Store {
  async ok(values: readonly unknown[]) {
    const b = new FencedBatch('cancel-task', token(), { now: NOW_MS })
    for (const b of values) consume(b)
    await b.run(this.db)
  }
}
"""
        ),
        "a loop-local shadow does not invalidate the outer fenced binding",
    ),
    (
        "batch-lint.py",
        store(
            r"""
export class S {
  async ok(q: string) {
    await this.db.batch(
      'heartbeat',
      [{ sql: `UPDATE runs SET a = 1`, args: [/sql:/.test(q), q.length / 2] }],
    )
  }
}
"""
        ),
        "regex contents do not become object keys and division remains code",
    ),
    (
        "batch-lint.py",
        store(
            """
export class S {
  async ok() {
    await this.db.batch(
      'sweep:scan',
      [
        { sql: `SELECT 1`, args: [] },
        /* statement-list trailing trivia */
      ],
      'read',
      // argument-list trailing trivia
    )
  }
}
"""
        ),
        "comments after trailing commas remain trivia rather than opaque expressions",
    ),
    (
        "batch-lint.py",
        store(
            r"""
// this.db.batch('brand-new-write', [])
const quoted = "this.db.batch('brand-new-write', [])"
const templated = `this.db.batch('brand-new-write', [])`
const pattern = /this\.db\.batch\(/
"""
        ),
        "comments, strings, templates, and regexes do not manufacture batch calls",
    ),
    ("review-bot-lint.py", corpus(WHOLE_RULE), "a complete rule referenced by both bots"),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 owned work** — planned.\n"
                "  This prose explains why deferral belongs to the live entry.\n"
                "  - **Owned mechanism** — implement it here.\n"
            )
        },
        "prose about deferral inside a live PR entry is not an orphaned work item",
    ),
    (
        "deferral-lint.py",
        {
            "BUILD.md": (
                "# plan\n\n"
                "- **PR9.9 current work** — planned.\n"
                "  - **Owned mechanism** — implement it here.\n"
            ),
            "postmortems/fixture-plan.md": (
                "# Historical implementation plan\n\n"
                "> **Historical decision record.** Status is frozen at decision time; "
                "`BUILD.md` is the sole current status owner.\n\n"
                "## Decision-time residuals\n\n"
                "The work was assigned to PR9.9; see BUILD.md for current status.\n"
            ),
        },
        "a canonical historical banner keeps decision context without creating a second live plan",
    ),
    (
        "gate-lint.py",
        gate("python3 scripts/a-lint.py && python3 scripts/b-lint.py && python3 scripts/lint-selftest.py", ("a-lint.py", "b-lint.py")),
        "every checker run by the gate, every one self-tested, base-gate present",
    ),
    (
        "gate-lint.py",
        process_docs(
            CONFINE_SECTION_BODY,
            TRANSPORT_BLOCK,
        ),
        "process contracts refer to their executable single definitions",
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
    (
        "clock-lint.py",
        store("const SQL = `/*\n  NOW()\n*/\nSELECT 1`\n"),
        "a database clock name inside a multiline block comment",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT 1 -- NOW()`\n"),
        "a database clock name inside a SQL line comment",
    ),
    (
        "clock-lint.py",
        store("const SQL = `SELECT 'NOW()' AS label`\n"),
        "a database clock name inside a SQL string literal",
    ),
    (
        "clock-lint.py",
        store("const SQL = \"SELECT 'NOW()' AS label\"\n"),
        "a SQL data literal stays non-executable inside an ordinary TypeScript string",
    ),
    (
        "outcome-lint.py",
        store("const SQL = `SELECT completed_payload, failure_reason FROM tasks`\n"),
        "the stores own the outcome columns",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/task-result.ts": (
                "export const TASK_RESULT_COLUMNS = 'state, completed_payload, failure_reason'\n"
            ),
        },
        "core's decoder defines the outcome column list",
    ),
    (
        "outcome-lint.py",
        {"packages/conformance/src/invariants.ts": "const SQL = `SELECT failure_reason FROM tasks`\n"},
        "the conformance oracle reads raw task state",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/contract.ts": (
                "import { TASK_OUTCOME_COLUMNS } from './task-result.js'\n"
                "export const COLUMNS = ['state', ...TASK_OUTCOME_COLUMNS] as const\n"
            ),
        },
        "contract.ts takes the outcome column names from the decoder",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/fenced-batch.ts": (
                "// the engine writes JSON constants into failure_reason\nexport {}\n"
            ),
        },
        "a comment naming an outcome column is not a read",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/test/status.test.ts": "const SQL = `UPDATE tasks SET completed_payload = NULL`\n",
        },
        "tests corrupt outcome rows on purpose and are not production sources",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/src/status.ts": (
                "import { TASK_RESULT_COLUMNS } from '@durablerun/core'\n"
                "export const SQL = `SELECT ${TASK_RESULT_COLUMNS} FROM tasks`\n"
            ),
        },
        "a reader that selects the decoder's column list spells no outcome column",
    ),
    (
        "outcome-lint.py",
        {
            "packages/core/src/index.ts": "export {}\n",
            "apps/fixture/src/view.tsx": "export const View = () => <p>it's done</p>\n",
        },
        "JSX text in a .tsx source that names no outcome column is not a violation",
    ),
]

GOOD_INVOCATIONS = [
    (
        "gate-lint.py",
        base_runner_growth_fixture(),
        ("--run-base", "{root}/head", "{root}/base"),
        "base-owned checks accept a head-owned checker that is wired into verify and its refusal corpus",
    ),
    (
        "mutation-probe.py",
        {},
        ("--classifier-self-test",),
        "the cheap attribution self-test neither mutates sources nor requires a clean tree",
    ),
    (
        "mutation-probe.py",
        {},
        ("--orchestration-self-test",),
        "parallel mutation orchestration can prove its shard and result protocol cheaply",
    ),
    (
        "review-attest.sh",
        {
            "completed.log": (
                "review-head: fixture-head\n"
                "review analysis completed\n"
                "tokens used\n"
                "review verdict: no findings\n"
            ),
        },
        ("--check-codex-log", "{root}/completed.log", "fixture-head"),
        "a completed review may print its verdict after the token marker",
    ),
    (
        "review-attest.sh",
        {
            "completed.jsonl": (
                '{"type":"review-head","head":"fixture-head"}\n'
                '{"type":"review-plan","reviewers":["whole-system"]}\n'
                '{"type":"result","reviewer":"whole-system","verdict":"clean"}\n'
                '{"type":"review-complete","reviewers":["whole-system"]}\n'
            ),
        },
        ("--check-journal", "{root}/completed.jsonl", "fixture-head"),
        "a completed multi-lens review journal is accepted only for its bound head",
    ),
    (
        "review-attest.sh",
        {
            "body.md": "review-findings: 0\n",
        },
        ("--check-pr-body", "{root}/body.md"),
        "one canonical review finding count is accepted",
    ),
    (
        "review-attest.sh",
        {
            "postmortem.md": """# Postmortem: fixture

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | one | impact | layer | reason | mechanism |
| 2 | two | impact | layer | reason | mechanism |
| 3 | three | impact | layer | reason | mechanism |
| 4 | four | impact | layer | reason | mechanism |
| 5 | five | impact | layer | reason | mechanism |
| 6 | six | impact | layer | reason | mechanism |
| 7 | seven | impact | layer | reason | mechanism |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| no findings | **0** | — |
| first detector | 1 + 1 | no |
| second detector | 3 + 2 | **yes** |
""",
        },
        ("--check-postmortem", "{root}/postmortem.md"),
        "the canonical tables accept bold zeroes and additive finding counts",
    ),
]


def run(
    lint: str,
    files: dict[str, str],
    args: tuple[str, ...] | None = None,
    git_state: str = "tracked",
    environment: dict[str, str] | None = None,
    forbidden_artifact: str | None = None,
) -> subprocess.CompletedProcess[str]:
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
        if lint in {
            "batch-lint.py",
            "clock-lint.py",
            "fragment-lint.py",
            "outcome-lint.py",
            "spec-ledger.py",
        }:
            (root / "scripts" / "source_lex.py").write_text(
                (SCRIPTS / "source_lex.py").read_text()
            )
        if lint == "mutation-probe.py":
            (root / "scripts" / "typescript-verdict-analyzer.cjs").write_text(
                (SCRIPTS / "typescript-verdict-analyzer.cjs").read_text()
            )
        if lint == "review-bot-lint.py":
            if git_state not in {"unavailable", "empty", "tracked"}:
                raise ValueError(f"unknown Git fixture state: {git_state}")
            if git_state == "unavailable":
                (root / ".git").write_text("not a git directory\n")
            else:
                subprocess.run(
                    ["git", "init", "-q"],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    check=True,
                )
            if git_state == "tracked":
                subprocess.run(
                    ["git", "add", "."],
                    cwd=root,
                    capture_output=True,
                    text=True,
                    check=True,
                )
        runner = ["bash"] if lint.endswith(".sh") else [sys.executable]
        lint_args = (
            [str(root)]
            if args is None
            else [arg.replace("{root}", str(root)) for arg in args]
        )
        process_environment = {
            **os.environ,
            **{
                key: value.replace("{root}", str(root))
                for key, value in (environment or {}).items()
            },
        }
        if lint == "mutation-probe.py":
            dependency_root = str(SCRIPTS.parent / "node_modules")
            inherited_node_path = process_environment.get("NODE_PATH")
            process_environment["NODE_PATH"] = (
                f"{dependency_root}{os.pathsep}{inherited_node_path}"
                if inherited_node_path
                else dependency_root
            )
        result = subprocess.run(
            [*runner, str(copied), *lint_args],
            capture_output=True,
            text=True,
            cwd=str(root),
            env=process_environment,
        )
        if forbidden_artifact is not None and (root / forbidden_artifact).exists():
            return subprocess.CompletedProcess(
                args=result.args,
                returncode=1,
                stdout=result.stdout,
                stderr=result.stderr
                + f"\ncreated forbidden artifact: {forbidden_artifact}\n",
            )
        return result


SESSION_PROBE_CODE = """\
PROBE = "session-state-relative-probe"
import select
print("ready", flush=True)
select.select([], [], [])
"""

SESSION_DESCENDANT_CODE = """\
PROBE = "session-state-descendant-probe"
import select
select.select([], [], [])
"""

SESSION_ORPHAN_CODE = """\
import os
import signal

pipe_read, pipe_write = os.pipe()
first = os.fork()
if first:
    os.close(pipe_write)
    payload = os.read(pipe_read, 64)
    os.close(pipe_read)
    os.waitpid(first, 0)
    print(f"ready {payload.decode('ascii')}", flush=True)
    raise SystemExit(0)

os.close(pipe_read)
second = os.fork()
if second:
    os.close(pipe_write)
    os._exit(0)

os.setsid()
os.chdir(os.environ["SESSION_PROCESS_TARGET"])
null_fd = os.open(os.devnull, os.O_RDWR)
for standard_fd in (0, 1, 2):
    os.dup2(null_fd, standard_fd)
if null_fd > 2:
    os.close(null_fd)
os.write(pipe_write, str(os.getpid()).encode("ascii"))
os.close(pipe_write)
signal.pause()
"""

SESSION_CLEAN_VERDICT = "session-state: clean —"
SESSION_DIRTY_VERDICT = "session-state: the above is what is still alive."


def wait_for_probe(process: subprocess.Popen[str]) -> str:
    if process.stdout is None:
        raise AssertionError("session process probe has no readiness pipe")
    readable, _, _ = select.select([process.stdout], [], [], 5)
    if not readable:
        raise AssertionError("session process probe did not become ready")
    ready = process.stdout.readline().strip()
    if not ready.startswith("ready"):
        detail = process.stderr.read().strip() if process.stderr is not None else ""
        raise AssertionError(
            f"session process probe exited before readiness: {ready!r} {detail!r}"
        )
    return ready


def stop_probe(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            if os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
    if process.stdin is not None:
        process.stdin.close()
    if process.stdout is not None:
        process.stdout.close()
    if process.stderr is not None:
        process.stderr.close()


def worktree_git_fault_environment(outside: Path, mode: str) -> dict[str, str]:
    real_git = shutil.which("git")
    if real_git is None:
        raise AssertionError("session process fixture requires git")
    shim_dir = outside / f"git-{mode}"
    shim_dir.mkdir()
    shim = shim_dir / "git"
    if mode == "empty":
        fault = "exit 0\n"
    elif mode == "malformed":
        fault = (
            "porcelain=0\n"
            "for arg in \"$@\"; do\n"
            "  [ \"$arg\" = \"--porcelain\" ] && porcelain=1\n"
            "done\n"
            "if [ \"$porcelain\" -eq 1 ]; then\n"
            "  printf 'HEAD fixture\\0\\0'\n"
            "else\n"
            "  printf '%s\\n' 'not-a-worktree-record'\n"
            "fi\n"
            "exit 0\n"
        )
    else:
        raise ValueError(f"unknown worktree Git fault {mode!r}")
    shim.write_text(
        "#!/bin/sh\n"
        "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"list\" ]; then\n"
        f"{fault}"
        "fi\n"
        f"exec {shlex.quote(real_git)} \"$@\"\n"
    )
    shim.chmod(0o755)
    return {"PATH": f"{shim_dir}{os.pathsep}{os.environ['PATH']}"}


@contextmanager
def session_process_probe(
    case: SessionProcessCase,
    root: Path,
    outside: Path,
):
    environment = {**os.environ, "SESSION_PROCESS_OUTSIDE": str(outside)}
    scan_environment: dict[str, str] = {}
    worktree: Path | None = None
    worktree_registered = False
    process: subprocess.Popen[str] | None = None
    orphan_pid: int | None = None
    try:
        if case.topology in {
            "worktree",
            "removed-worktree",
            "worktree-inventory-empty",
            "worktree-inventory-malformed",
        }:
            candidate_worktree = outside / "registered-worktree"
            subprocess.run(
                ["git", "worktree", "add", "--detach", str(candidate_worktree), "HEAD"],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            )
            worktree = candidate_worktree
            worktree_registered = True
            cwd = worktree
        else:
            cwd = root

        if case.topology == "outside-sleep":
            sleep = shutil.which("sleep")
            if sleep is None:
                raise AssertionError("session process fixture requires sleep")
            process = subprocess.Popen(
                [sleep, "300"],
                cwd=tempfile.gettempdir(),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            probe_pid = process.pid
        elif case.topology == "descendant":
            parent_code = f"""\
PARENT_PROBE = "session-state-parent-probe"
import os
import select
import signal
import subprocess
import sys

child = subprocess.Popen(
    [sys.executable, "-c", {SESSION_DESCENDANT_CODE!r}],
    cwd=os.environ["SESSION_PROCESS_OUTSIDE"],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

def stop(_signum, _frame):
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=5)
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop)
print(f"ready {{child.pid}}", flush=True)
select.select([], [], [])
"""
            process = subprocess.Popen(
                [sys.executable, "-c", parent_code],
                cwd=cwd,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            ready = wait_for_probe(process)
            probe_pid = int(ready.split()[1])
        elif case.topology in {"foreign-cwd", "foreign-argv"}:
            target = root if case.topology == "foreign-cwd" else outside
            orphan_environment = {
                **environment,
                "SESSION_PROCESS_TARGET": str(target),
            }
            orphan_args = [sys.executable, "-c", SESSION_ORPHAN_CODE]
            if case.topology == "foreign-argv":
                orphan_args.append(str(root))
            process = subprocess.Popen(
                orphan_args,
                cwd=outside,
                env=orphan_environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            ready = wait_for_probe(process)
            orphan_pid = int(ready.split()[1])
            process.wait(timeout=5)
            probe_pid = orphan_pid
        elif case.topology == "same-pgid":
            process = subprocess.Popen(
                [sys.executable, "-c", SESSION_PROBE_CODE],
                cwd=root,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            wait_for_probe(process)
            if os.getpgid(process.pid) != os.getpgrp():
                raise AssertionError("same-pgid probe did not share the fixture process group")
            probe_pid = process.pid
        elif case.topology == "bash-stdin":
            process = subprocess.Popen(
                ["/bin/bash", "-s"],
                cwd=root,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            if process.stdin is None:
                raise AssertionError("stdin-shell probe has no script pipe")
            process.stdin.write(
                "printf '%s\\n' ready\n"
                "while :; do read -r -t 30 _ || :; done\n"
            )
            process.stdin.close()
            process.stdin = None
            wait_for_probe(process)
            probe_pid = process.pid
        elif case.topology == "shell-operator":
            quoted_root = shlex.quote(str(root))
            quoted_outside = shlex.quote(str(outside))
            if case.detail == "&&":
                setup = f"cd {quoted_root}&&cd {quoted_outside}"
            elif case.detail == "||":
                setup = f"cd {quoted_root}||exit 91; cd {quoted_outside}"
            elif case.detail == "|":
                setup = f"cd {quoted_root}|:; cd {quoted_outside}"
            elif case.detail == ">":
                setup = f"cd {quoted_root}>/dev/null; cd {quoted_outside}"
            elif case.detail == "<":
                setup = f"test -d {quoted_root}</dev/null; cd {quoted_outside}"
            else:
                raise ValueError(f"unknown shell operator {case.detail!r}")
            process = subprocess.Popen(
                [
                    "/bin/bash",
                    "-c",
                    f"{setup}; printf '%s\\n' ready; "
                    "while :; do read -r -t 30 _ || :; done",
                ],
                cwd=outside,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            wait_for_probe(process)
            probe_pid = process.pid
        else:
            probe_args = [sys.executable, "-c", SESSION_PROBE_CODE]
            process = subprocess.Popen(
                probe_args,
                cwd=cwd,
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                start_new_session=True,
            )
            wait_for_probe(process)
            probe_pid = process.pid

        if case.topology == "removed-worktree":
            if worktree is None:
                raise AssertionError("removed-worktree probe has no registered worktree")
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            )
            worktree_registered = False
            cwd_link = os.readlink(f"/proc/{probe_pid}/cwd")
            if not cwd_link.endswith(" (deleted)"):
                raise AssertionError(
                    f"removed-worktree probe cwd is not deleted: {cwd_link!r}"
                )
        elif case.topology == "worktree-inventory-empty":
            scan_environment = worktree_git_fault_environment(outside, "empty")
        elif case.topology == "worktree-inventory-malformed":
            scan_environment = worktree_git_fault_environment(outside, "malformed")

        yield probe_pid, scan_environment
    finally:
        if process is not None:
            stop_probe(process)
        if orphan_pid is not None:
            try:
                os.kill(orphan_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            for _attempt in range(100):
                if not Path(f"/proc/{orphan_pid}").exists():
                    break
                select.select([], [], [], 0.01)
        if worktree is not None and worktree_registered:
            subprocess.run(
                ["git", "worktree", "remove", "--force", str(worktree)],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            )


def run_pipeline_reader_case(
    copied: Path,
    root: Path,
) -> tuple[subprocess.CompletedProcess[str], int]:
    consumer_code = """\
import os
import sys
print(f"ready {os.getpid()}", file=sys.stderr, flush=True)
sys.stdout.write(sys.stdin.read())
"""
    consumer = subprocess.Popen(
        [sys.executable, "-c", consumer_code],
        cwd=root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        if consumer.stderr is None:
            raise AssertionError("pipeline consumer has no readiness pipe")
        readable, _, _ = select.select([consumer.stderr], [], [], 5)
        if not readable:
            raise AssertionError("pipeline consumer did not become ready")
        ready = consumer.stderr.readline().strip()
        if not ready.startswith("ready "):
            raise AssertionError(f"pipeline consumer readiness was {ready!r}")
        consumer_pid = int(ready.split()[1])
        if consumer.stdin is None:
            raise AssertionError("pipeline consumer has no stdin")
        scanner = subprocess.run(
            ["bash", str(copied)],
            cwd=root,
            stdout=consumer.stdin,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        consumer.stdin.close()
        consumer.stdin = None
        consumer.wait(timeout=5)
        consumer_stdout = consumer.stdout.read() if consumer.stdout is not None else ""
        consumer_stderr = consumer.stderr.read() if consumer.stderr is not None else ""
        return (
            subprocess.CompletedProcess(
                args=scanner.args,
                returncode=scanner.returncode,
                stdout=consumer_stdout,
                stderr=(scanner.stderr or "") + consumer_stderr,
            ),
            consumer_pid,
        )
    finally:
        stop_probe(consumer)


def run_session_process_case(
    case: SessionProcessCase,
) -> tuple[subprocess.CompletedProcess[str], int]:
    with tempfile.TemporaryDirectory() as tmp:
        fixture = Path(tmp)
        root = tree(fixture / "repo", {"README.md": "session process fixture\n"})
        (root / "scripts").mkdir(parents=True, exist_ok=True)
        copied = root / "scripts" / "session-state.sh"
        copied.write_text((SCRIPTS / "session-state.sh").read_text())
        for args in (
            ("init", "-q"),
            ("config", "user.name", "lint-selftest"),
            ("config", "user.email", "lint-selftest@example.invalid"),
            ("add", "."),
            ("commit", "-qm", "fixture"),
        ):
            subprocess.run(
                ["git", *args],
                cwd=root,
                capture_output=True,
                text=True,
                check=True,
            )
        outside = fixture / "outside"
        outside.mkdir()
        if case.topology == "pipeline-reader":
            return run_pipeline_reader_case(copied, root)
        with session_process_probe(case, root, outside) as (
            probe_pid,
            scan_environment,
        ):
            environment = {**os.environ, **scan_environment}
            result = subprocess.run(
                ["bash", str(copied)],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=10,
                env=environment,
            )
        return result, probe_pid


def session_process_verdict_problem(
    case: SessionProcessCase,
    result: subprocess.CompletedProcess[str],
    probe_pid: int,
) -> str | None:
    output = result.stdout + result.stderr
    reported = any(
        fields[:2] == ["process", str(probe_pid)]
        for fields in (line.split() for line in output.splitlines())
    )
    if "Traceback (most recent call last)" in output:
        return f"crashed instead of classifying probe pid {probe_pid}\n    {output.strip()[:300]}"
    if case.expected == "reported":
        if not reported:
            return (
                f"did not report probe pid {probe_pid}; exit {result.returncode}\n"
                f"    {output.strip()[:300]}"
            )
        if result.returncode != 1:
            return (
                f"reported probe pid {probe_pid} with exit {result.returncode}, "
                "not the inventory verdict 1"
            )
        if SESSION_DIRTY_VERDICT not in output:
            return f"reported probe pid {probe_pid} without the non-clean inventory verdict"
        return None
    if case.expected == "clean":
        if reported:
            return f"reported invocation or foreign probe pid {probe_pid}"
        if result.returncode != 0:
            return (
                f"refused a clean topology for probe pid {probe_pid}; exit {result.returncode}\n"
                f"    {output.strip()[:300]}"
            )
        if SESSION_CLEAN_VERDICT not in output:
            return "returned zero without the clean inventory verdict"
        return None
    if case.expected == "refused":
        if result.returncode != 2:
            return (
                f"returned {result.returncode}, not fail-closed exit 2 for probe pid "
                f"{probe_pid}\n    {output.strip()[:300]}"
            )
        if case.expected_marker is None or case.expected_marker not in output:
            return (
                f"refused without diagnostic {case.expected_marker!r}\n"
                f"    {output.strip()[:300]}"
            )
        if SESSION_CLEAN_VERDICT in output:
            return "printed a clean verdict after refusing incomplete evidence"
        return None
    raise ValueError(f"unknown session process expectation: {case.expected}")


def session_process_case_problem(case: SessionProcessCase) -> str | None:
    result, probe_pid = run_session_process_case(case)
    return session_process_verdict_problem(case, result, probe_pid)


def session_process_oracle_problems() -> list[str]:
    case = SessionProcessCase(
        "oracle-control",
        "synthetic",
        "reported",
        "a process report is valid only with the exact inventory verdict",
    )
    pid = 424242
    process_line = f"process   {pid}  up 00:00:01  fixture\n"
    valid = subprocess.CompletedProcess(
        args=(),
        returncode=1,
        stdout=process_line + SESSION_DIRTY_VERDICT + "\n",
        stderr="",
    )
    wrong_exit = subprocess.CompletedProcess(
        args=(),
        returncode=2,
        stdout=process_line + SESSION_DIRTY_VERDICT + "\n",
        stderr="session-state: injected evidence failure\n",
    )
    missing_footer = subprocess.CompletedProcess(
        args=(),
        returncode=1,
        stdout=process_line,
        stderr="",
    )
    problems: list[str] = []
    if session_process_verdict_problem(case, valid, pid) is not None:
        problems.append("session process oracle rejected its exact non-clean control")
    if session_process_verdict_problem(case, wrong_exit, pid) is None:
        problems.append("session process oracle accepted an evidence-error exit as a report")
    if session_process_verdict_problem(case, missing_footer, pid) is None:
        problems.append("session process oracle accepted a report with no inventory verdict")
    return problems


def load_embedded_session_scanner() -> types.ModuleType:
    source = (SCRIPTS / "session-state.sh").read_text()
    start_marker = "process_output=$(python3 - \"$ROOT\" <<'PY'\n"
    main_marker = "\nroot = os.path.realpath(sys.argv[1])\n"
    if start_marker not in source or main_marker not in source:
        raise AssertionError(
            "session-state process scanner has no deterministic definition seam"
        )
    body = source.split(start_marker, 1)[1].split("\nPY\n)", 1)[0]
    definitions = body.split(main_marker, 1)[0]
    module_name = "_session_state_snapshot_fixture"
    module = types.ModuleType(module_name)
    sys.modules[module_name] = module
    try:
        exec(compile(definitions, "scripts/session-state.sh::<process-scan>", "exec"), module.__dict__)
    finally:
        sys.modules.pop(module_name, None)
    return module


def session_snapshot_coherence_problem() -> str | None:
    try:
        module = load_embedded_session_scanner()
    except (AssertionError, OSError, SyntaxError) as exc:
        return f"session process scanner lacks an executable snapshot seam: {exc}"

    stable_stat = module.Stat(ppid=7, state="S", start=11, comm="worker")
    module.read_stat = lambda _pid: stable_stat
    real_os = module.os
    cmdline_reads = 0

    class TransitionOS:
        def stat(self, _path: str):
            return types.SimpleNamespace(st_uid=1000)

        def readlink(self, path: str) -> str:
            if path.endswith("/cwd"):
                # Exec moved from coherent state A (argv A, repo cwd) to
                # coherent state B (argv B, outside cwd) between field reads.
                return "/fixture/outside"
            if path.endswith("/exe"):
                return "/fixture/worker"
            raise AssertionError(f"unexpected process link {path}")

        def __getattr__(self, name: str):
            return getattr(real_os, name)

    def transition_open(path: str, _mode: str = "rb"):
        nonlocal cmdline_reads
        if not path.endswith("/cmdline"):
            raise AssertionError(f"unexpected process file {path}")
        cmdline_reads += 1
        phase = b"worker-phase-a\0" if cmdline_reads == 1 else b"worker-phase-b\0"
        return io.BytesIO(phase)

    module.os = TransitionOS()
    module.open = transition_open
    try:
        observed = module.read_process(4242, 1000)
    except module.EvidenceError:
        return None
    except Exception as exc:
        return f"session process snapshot seam crashed under exec transition: {exc}"
    if observed is None:
        return "session process snapshot silently dropped a live exec-transition process"
    coherent = {
        ((b"worker-phase-a",), "/fixture/repo"),
        ((b"worker-phase-b",), "/fixture/outside"),
    }
    actual = (observed.argv, observed.cwd)
    if actual not in coherent:
        return (
            "session process snapshot accepted mixed exec generations: "
            f"argv={observed.argv!r}, cwd={observed.cwd!r}"
        )
    return None


def session_internal_evidence_problems() -> list[str]:
    problems: list[str] = []

    module = load_embedded_session_scanner()
    stable_stat = module.Stat(ppid=7, state="S", start=11, comm="worker")
    module.read_stat = lambda _pid: stable_stat
    real_os = module.os

    class OwnerFaultOS:
        def stat(self, _path: str):
            raise PermissionError("fixture owner denial")

        def __getattr__(self, name: str):
            return getattr(real_os, name)

    module.os = OwnerFaultOS()
    try:
        module.read_process(4242, 1000)
    except module.EvidenceError:
        pass
    else:
        problems.append("session process scanner swallowed a stable owner-read failure")

    module = load_embedded_session_scanner()
    stable_stat = module.Stat(ppid=7, state="S", start=11, comm="worker")
    module.read_stat = lambda _pid: stable_stat
    real_os = module.os

    class ReadableOwnerOS:
        def stat(self, _path: str):
            return types.SimpleNamespace(st_uid=1000)

        def __getattr__(self, name: str):
            return getattr(real_os, name)

    module.os = ReadableOwnerOS()
    module.open = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        PermissionError("fixture argv denial")
    )
    try:
        module.read_process(4242, 1000)
    except module.EvidenceError:
        pass
    else:
        problems.append("session process scanner swallowed a stable argv-read failure")

    module = load_embedded_session_scanner()
    module.open = lambda *_args, **_kwargs: io.BytesIO(b"malformed stat")
    try:
        module.read_stat(4242)
    except module.EvidenceError:
        pass
    else:
        problems.append("session process scanner accepted malformed /proc stat evidence")

    terminal_cases = (
        ("initial-Z", ("Z",), None),
        ("initial-X", ("X",), None),
        ("initial-x", ("x",), None),
        ("owner-error", ("S", "X"), "owner-error"),
        ("cmdline-missing", ("S", "X"), "cmdline-missing"),
        ("cmdline-error", ("S", "X"), "cmdline-error"),
        ("cwd-missing", ("S", "X"), "cwd-missing"),
        ("cwd-error", ("S", "X"), "cwd-error"),
        ("final-bracket", ("S", "X"), None),
    )
    for case_id, states, fault in terminal_cases:
        module = load_embedded_session_scanner()
        reads = 0

        def transition_stat(_pid: int):
            nonlocal reads
            state = states[min(reads, len(states) - 1)]
            reads += 1
            return module.Stat(ppid=7, state=state, start=11, comm="exiting-worker")

        module.read_stat = transition_stat
        real_os = module.os

        class ExitingOS:
            def stat(self, _path: str):
                if fault == "owner-error":
                    raise PermissionError("exiting task released its owner record")
                return types.SimpleNamespace(st_uid=1000)

            def readlink(self, path: str) -> str:
                if path.endswith("/cwd"):
                    if fault == "cwd-missing":
                        raise FileNotFoundError("exiting task released its fs state")
                    if fault == "cwd-error":
                        raise PermissionError("exiting task hid its fs state")
                    return "/fixture/repo"
                if path.endswith("/exe"):
                    return "/fixture/python"
                raise AssertionError(f"unexpected process link {path}")

            def __getattr__(self, name: str):
                return getattr(real_os, name)

        def transition_open(_path: str, _mode: str = "rb"):
            if fault == "cmdline-missing":
                raise FileNotFoundError("exiting task released its argv")
            if fault == "cmdline-error":
                raise PermissionError("exiting task hid its argv")
            return io.BytesIO(b"python\0")

        module.os = ExitingOS()
        module.open = transition_open
        try:
            observed = module.read_process(4242, 1000)
        except module.EvidenceError as exc:
            problems.append(
                f"session process scanner rejected terminal {case_id} state: {exc}"
            )
        else:
            if observed is not None:
                problems.append(
                    f"session process scanner retained terminal {case_id} state"
                )
    return problems


def session_pr_gate_contract_problem() -> str | None:
    contract = (SCRIPTS.parent / ".claude/skills/pr-gate/SKILL.md").read_text()
    required = (
        "cwd, argv, and live ancestry",
        "unrelated host sleeps are not repository evidence",
    )
    stale = (
        "processes\n   whose command line names this repo",
        "wait loops (a `sleep` with a live\n   parent)",
    )
    if any(marker not in contract for marker in required) or any(
        marker in contract for marker in stale
    ):
        return (
            "pr-gate session-state contract still describes command-name and "
            "global-sleep proxies instead of cwd, argv, and ancestry ownership"
        )
    return None


def session_process_problems() -> list[str]:
    problems: list[str] = []
    for case in SESSION_PROCESS_CASES:
        try:
            problem = session_process_case_problem(case)
        except (AssertionError, OSError, subprocess.SubprocessError, ValueError) as exc:
            problems.append(
                f"session-state.sh process fixture {case.case_id} could not run: {exc}"
            )
            continue
        if problem is not None:
            problems.append(
                f"session-state.sh process fixture {case.case_id} {problem} — {case.why}"
            )
    problems.extend(session_process_oracle_problems())
    coherence_problem = session_snapshot_coherence_problem()
    if coherence_problem is not None:
        problems.append(coherence_problem)
    try:
        problems.extend(session_internal_evidence_problems())
    except (AssertionError, OSError, SyntaxError) as exc:
        problems.append(f"session process internal fail-closed fixture could not run: {exc}")
    contract_problem = session_pr_gate_contract_problem()
    if contract_problem is not None:
        problems.append(contract_problem)
    return problems


MUTATION_SUITE_TIMEOUT_PASSED = (
    "mutation-probe suite-timeout self-test observed the suite wall-time limit"
)
MUTATION_SUITE_TIMEOUT_REJECTED = (
    "mutation-probe suite-timeout self-test rejected unauthenticated verifier"
)


@dataclass(frozen=True)
class MutationSuiteChildObservation:
    returncode: int
    output: str
    records: tuple[dict[str, object], ...]
    live_processes: tuple[int, ...]
    watchdog_problem: str | None


def mutation_suite_process_is_live(process_id: int) -> bool:
    try:
        fields = Path(f"/proc/{process_id}/stat").read_text().split()
    except OSError:
        return False
    return len(fields) > 2 and fields[2] != "Z"


def mutation_suite_records(state_path: Path) -> tuple[dict[str, object], ...]:
    if not state_path.exists():
        return ()
    records: list[dict[str, object]] = []
    for line in state_path.read_text().splitlines():
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return tuple(records)


def mutation_suite_record_pids(
    records: tuple[dict[str, object], ...],
) -> tuple[int, ...]:
    pids: set[int] = set()
    for record in records:
        for key in ("leader", "descendant"):
            process_id = record.get(key)
            if (
                isinstance(process_id, int)
                and not isinstance(process_id, bool)
                and process_id > 1
            ):
                pids.add(process_id)
    return tuple(sorted(pids))


def cleanup_mutation_suite_records(
    records: tuple[dict[str, object], ...],
) -> tuple[int, ...]:
    groups: set[int] = set()
    pids = mutation_suite_record_pids(records)
    for record in records:
        leader = record.get("leader")
        descendant = record.get("descendant")
        if (
            not isinstance(leader, int)
            or isinstance(leader, bool)
            or leader <= 1
            or leader == os.getpgrp()
        ):
            continue
        candidates = [leader]
        if isinstance(descendant, int) and not isinstance(descendant, bool):
            candidates.append(descendant)
        for process_id in candidates:
            try:
                if os.getpgid(process_id) == leader:
                    groups.add(leader)
                    break
            except ProcessLookupError:
                continue
    for group in groups:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 2
    while any(mutation_suite_process_is_live(pid) for pid in pids) and time.monotonic() < deadline:
        time.sleep(0.02)
    return tuple(pid for pid in pids if mutation_suite_process_is_live(pid))


def run_mutation_suite_child(
    mode: str,
    *,
    fault: str | None = None,
    signal_after_label: str | None = None,
    signal_count: int = 1,
    signal_settle_seconds: float = 0.0,
) -> MutationSuiteChildObservation:
    with tempfile.TemporaryDirectory(prefix="durablerun-suite-self-test-") as temporary:
        state_path = Path(temporary) / "verifiers.jsonl"
        command = [
            sys.executable,
            str(SCRIPTS / "mutation-probe.py"),
            mode,
            "--suite-self-test-state",
            str(state_path),
        ]
        if fault is not None:
            command.extend(("--suite-timeout-self-test-fault", fault))
        process = subprocess.Popen(
            command,
            cwd=SCRIPTS.parent,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        watchdog_problem: str | None = None
        stdout = ""
        stderr = ""
        try:
            if signal_after_label is not None:
                launch_deadline = time.monotonic() + 1.0
                authenticated = False
                while process.poll() is None and time.monotonic() < launch_deadline:
                    authenticated = any(
                        record.get("label") == signal_after_label
                        for record in mutation_suite_records(state_path)
                    )
                    if authenticated:
                        break
                    time.sleep(0.01)
                if not authenticated:
                    watchdog_problem = (
                        f"{signal_after_label} verifier did not write its authenticated "
                        "PID record before the launch watchdog"
                    )
                else:
                    if signal_settle_seconds > 0:
                        time.sleep(signal_settle_seconds)
                    for signal_index in range(signal_count):
                        try:
                            os.killpg(process.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            watchdog_problem = (
                                f"{signal_after_label} self-test exited before SIGTERM "
                                f"{signal_index + 1} of {signal_count}"
                            )
                            break
                        if signal_index + 1 < signal_count:
                            time.sleep(0.05)
            try:
                stdout, stderr = process.communicate(timeout=1.5)
            except subprocess.TimeoutExpired:
                watchdog_problem = watchdog_problem or (
                    f"{mode} exceeded its external 1.5s completion watchdog"
                )
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                stdout, stderr = process.communicate(timeout=2)
            records = mutation_suite_records(state_path)
            pids = mutation_suite_record_pids(records)
            live_processes = tuple(
                pid for pid in pids if mutation_suite_process_is_live(pid)
            )
            returncode = process.returncode if process.returncode is not None else -1
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate(timeout=2)
            records = mutation_suite_records(state_path)
            cleanup_failures = cleanup_mutation_suite_records(records)
            if cleanup_failures:
                raise RuntimeError(
                    "suite self-test cleanup left live processes "
                    f"{cleanup_failures}"
                )
        return MutationSuiteChildObservation(
            returncode,
            "\n".join((stdout, stderr)).strip(),
            records,
            live_processes,
            watchdog_problem,
        )


def mutation_suite_record_problem(
    observation: MutationSuiteChildObservation,
    expected_labels: set[str],
) -> str | None:
    labels = [record.get("label") for record in observation.records]
    if len(labels) != len(expected_labels) or set(labels) != expected_labels:
        return (
            "verifier-created PID records do not match the expected surfaces: "
            f"observed {labels}, expected {sorted(expected_labels)}"
        )
    for record in observation.records:
        leader = record.get("leader")
        descendant = record.get("descendant")
        if (
            not isinstance(leader, int)
            or isinstance(leader, bool)
            or leader <= 1
            or not isinstance(descendant, int)
            or isinstance(descendant, bool)
            or descendant <= 1
            or leader == descendant
        ):
            return f"verifier-created PID record is malformed: {record}"
    return None


def mutation_suite_timeout_problem() -> str | None:
    """Prove both production defaults with verifier-authenticated processes."""
    observation = run_mutation_suite_child("--suite-timeout-self-test-child")
    if observation.watchdog_problem is not None:
        return observation.watchdog_problem
    record_problem = mutation_suite_record_problem(
        observation,
        {"vitest", "typecheck"},
    )
    if record_problem is not None:
        return record_problem
    if observation.live_processes:
        return (
            "production deadline left verifier processes live: "
            f"{observation.live_processes}"
        )
    if (
        observation.returncode != 0
        or MUTATION_SUITE_TIMEOUT_PASSED not in observation.output
    ):
        return (
            "production default deadline probe failed: "
            f"{observation.output[:300]}"
        )

    false_negative = run_mutation_suite_child(
        "--suite-timeout-self-test-child",
        fault="immediate-magic-error",
    )
    if false_negative.watchdog_problem is not None:
        return false_negative.watchdog_problem
    if false_negative.records:
        return "immediate magic exception unexpectedly launched a verifier"
    if (
        false_negative.returncode == 0
        or MUTATION_SUITE_TIMEOUT_REJECTED not in false_negative.output
    ):
        return (
            "suite deadline regression accepted an immediate magic exception "
            f"without verifier evidence: {false_negative.output[:300]}"
        )
    return None


def mutation_suite_linger_problem() -> str | None:
    observation = run_mutation_suite_child("--suite-linger-self-test-child")
    if observation.watchdog_problem is not None:
        return observation.watchdog_problem
    record_problem = mutation_suite_record_problem(observation, {"linger"})
    if record_problem is not None:
        return record_problem
    if observation.live_processes:
        return (
            "exited verifier leader left live descendants: "
            f"{observation.live_processes}"
        )
    if observation.returncode != 0:
        return (
            "normal verifier leader exit with a descendant was not rejected and "
            f"reaped as infrastructure: {observation.output[:300]}"
        )
    return None


def mutation_suite_interrupt_problem() -> str | None:
    observation = run_mutation_suite_child(
        "--suite-interrupt-self-test-child",
        signal_after_label="interrupt",
        signal_count=2,
        signal_settle_seconds=0.2,
    )
    if observation.watchdog_problem is not None:
        return observation.watchdog_problem
    record_problem = mutation_suite_record_problem(observation, {"interrupt"})
    if record_problem is not None:
        return record_problem
    if observation.live_processes:
        return (
            "repeated SIGTERM interrupted cleanup without reaping nested verifier processes: "
            f"{observation.live_processes}"
        )
    if observation.returncode == 0:
        return "SIGTERM interruption returned successful verifier status"
    return None


if sys.argv[1:] == ["--mutation-suite-timeout-case"]:
    focused_problem = mutation_suite_timeout_problem()
    if focused_problem is not None:
        print(f"lint-selftest: {focused_problem}")
        sys.exit(1)
    print("lint-selftest: mutation suite wall-time limit accepted")
    sys.exit(0)


if sys.argv[1:] == ["--mutation-suite-linger-case"]:
    focused_problem = mutation_suite_linger_problem()
    if focused_problem is not None:
        print(f"lint-selftest: {focused_problem}")
        sys.exit(1)
    print("lint-selftest: mutation suite lingering descendants rejected")
    sys.exit(0)


if sys.argv[1:] == ["--mutation-suite-interrupt-case"]:
    focused_problem = mutation_suite_interrupt_problem()
    if focused_problem is not None:
        print(f"lint-selftest: {focused_problem}")
        sys.exit(1)
    print("lint-selftest: mutation suite interrupt cleanup accepted")
    sys.exit(0)


if sys.argv[1:] == ["--session-process-cases"]:
    focused_problems = session_process_problems()
    for focused_problem in focused_problems:
        print(f"lint-selftest: {focused_problem}")
    if focused_problems:
        sys.exit(1)
    print(
        f"lint-selftest: {len(SESSION_PROCESS_CASES)} live session process cases accepted"
    )
    sys.exit(0)


if sys.argv[1:] == ["--base-runner-workspace-cases"]:
    focused_problems = base_runner_workspace_problems()
    for focused_problem in focused_problems:
        print(f"lint-selftest: {focused_problem}")
    if focused_problems:
        sys.exit(1)
    print("lint-selftest: 2 staged workspace dependency cases accepted")
    sys.exit(0)


failures = []
failures.extend(base_runner_workspace_problems())
failures.extend(process_fixture_isolation_problems())
failures.extend(hidden_process_enrollment_problems(BAD_CASES))
failures.extend(hidden_process_enrollment_surface_problems(BAD_CASES))
failures.extend(hidden_process_obligation_surface_problems())
failures.extend(process_fixture_control_collision_problems())
failures.extend(process_fixture_control_enrollment_surface_problems())
suite_timeout_problem = mutation_suite_timeout_problem()
if suite_timeout_problem is not None:
    failures.append(suite_timeout_problem)
suite_linger_problem = mutation_suite_linger_problem()
if suite_linger_problem is not None:
    failures.append(suite_linger_problem)
suite_interrupt_problem = mutation_suite_interrupt_problem()
if suite_interrupt_problem is not None:
    failures.append(suite_interrupt_problem)
for fault in PROCESS_FIXTURE_ISOLATION_FAULTS:
    injected_fault = fault.fault_id
    try:
        observed_problems = process_fixture_isolation_problems(
            injected_fault=injected_fault
        )
    except AssertionError:
        if not fault.expects_ambiguous_target:
            failures.append(
                "process fixture isolation self-test rejected the mutation "
                f"target for {injected_fault} as ambiguous"
            )
        continue
    if fault.expects_ambiguous_target:
        failures.append(
            "process fixture isolation self-test accepted the ambiguous "
            f"mutation target for {injected_fault}"
        )
    elif tuple(observed_problems) != fault.expected_problems:
        failures.append(
            "process fixture isolation self-test attributed injected fault "
            f"{injected_fault} incorrectly: expected {fault.expected_problems!r}, "
            f"observed {observed_problems!r}"
        )
failures.extend(session_process_problems())

orchestration_inventory = subprocess.run(
    [
        sys.executable,
        str(SCRIPTS / "mutation-probe.py"),
        "--orchestration-self-test",
    ],
    capture_output=True,
    text=True,
)
orchestration_inventory_marker = (
    "declared injected faults exercised from canonical inventory"
)
if orchestration_inventory_marker not in (
    orchestration_inventory.stdout + orchestration_inventory.stderr
):
    failures.append(
        "mutation-probe.py orchestration self-test did not prove that every "
        "declared injected fault was exercised from its canonical inventory"
    )

# The migration debt hook is itself a bypass: adding a label to the same
# editable set makes an unfenced batch "classified" without proving any shape.
# The rung-1 property is that no such category exists at all.
if "FENCED_DEBT" in (SCRIPTS / "batch-lint.py").read_text():
    failures.append(
        "batch-lint.py still exposes editable FENCED_DEBT; an unfenced write "
        "can re-enter the classified inventory without a structural reason"
    )


def refusal_problem(
    result: subprocess.CompletedProcess[str],
    expected_marker: str,
) -> str | None:
    """A refusal is a rule-specific verdict, not any nonzero process exit."""
    output = result.stdout + result.stderr
    if result.returncode == 0:
        return "ACCEPTED a bad input"
    if "Traceback (most recent call last)" in output:
        return f"CRASHED on a bad input\n    {output.strip()[:300]}"
    if expected_marker not in output:
        return (
            f"REJECTED for the wrong reason; expected {expected_marker!r}\n"
            f"    {output.strip()[:300]}"
        )
    return None


# The inventory is the gate's executable inventory, not a filename convention
# or a second hand-kept list. A new checker becomes an obligation here at the
# same instant it becomes reachable from `pnpm verify`.
covered = (
    {lint for lint, _, _, _ in BAD_CASES}
    | {lint for lint, _, _, _, _ in BAD_INVOCATIONS}
    | {lint for lint, _, _, _, _ in GIT_BAD_CASES}
)
inventory = subprocess.run(
    [
        sys.executable,
        str(SCRIPTS / "gate-lint.py"),
        "--list-checkers",
        str(SCRIPTS.parent),
    ],
    capture_output=True,
    text=True,
)
if inventory.returncode != 0:
    failures.append(
        "gate-lint.py could not enumerate the executable checker inventory:\n"
        f"    {(inventory.stdout + inventory.stderr).strip()[:300]}"
    )
else:
    gate_members = {line for line in inventory.stdout.splitlines() if line}
    for name in sorted(gate_members - {"lint-selftest.py"} - covered):
        failures.append(
            f"{name} has no case here proving it can fail. Add at least one input "
            f"it must reject to BAD_CASES in scripts/lint-selftest.py — a checker "
            f"nobody has watched fail is a checker nobody should believe."
        )

for lint, files, expected_marker, why in BAD_CASES:
    result = run(lint, files)
    problem = refusal_problem(result, expected_marker)
    if problem:
        failures.append(
            f"{lint} {problem} — {why}\n"
            f"    {next(iter(files.values())).strip()[:120]}"
        )

for lint, files, git_state, expected_marker, why in GIT_BAD_CASES:
    result = run(lint, files, git_state=git_state)
    problem = refusal_problem(result, expected_marker)
    if problem:
        failures.append(f"{lint} {problem} — {why}\n    Git state: {git_state}")

for lint, files, environment, expected_marker, why in ENV_BAD_CASES:
    result = run(lint, files, environment=environment)
    problem = refusal_problem(result, expected_marker)
    if problem:
        failures.append(f"{lint} {problem} — {why}\n    Environment: {environment}")

for lint, files, args, expected_marker, why in BAD_INVOCATIONS:
    result = run(lint, files, args)
    problem = refusal_problem(result, expected_marker)
    if problem:
        failures.append(
            f"{lint} {problem} — {why}\n"
            f"    {' '.join(args)}"
        )

for (
    lint,
    files,
    args,
    environment,
    expected_marker,
    why,
) in ENV_BAD_INVOCATIONS:
    result = run(
        lint,
        files,
        args,
        environment=environment,
    )
    problem = refusal_problem(result, expected_marker)
    if problem:
        failures.append(
            f"{lint} {problem} — {why}\n"
            f"    {' '.join(args)} with {environment}"
        )

for lint, files, why in GOOD_CASES:
    result = run(lint, files)
    if result.returncode != 0:
        failures.append(f"{lint} REJECTED a good input — {why}\n    {result.stdout.strip()[:200]}")

for lint, files, args, why in GOOD_INVOCATIONS:
    result = run(lint, files, args)
    if result.returncode != 0:
        failures.append(
            f"{lint} REJECTED a good invocation — {why}\n"
            f"    {(result.stdout + result.stderr).strip()[:200]}"
        )

no_bytecode = run(
    "mutation-probe.py",
    {},
    ("--classifier-self-test",),
    forbidden_artifact="scripts/__pycache__",
)
if no_bytecode.returncode != 0:
    failures.append(
        "mutation-probe.py dirtied its clean fixture while importing shared tooling — "
        "a mutation audit then refuses its own bytecode artifact\n"
        f"    {(no_bytecode.stdout + no_bytecode.stderr).strip()[-200:]}"
    )

ledger_no_bytecode = run(
    "spec-ledger.py",
    {
        "packages/store-libsql/src/store.ts": (
            "await this.db.batch('read-probe', [{ sql: `SELECT 1`, args: [] }], 'read')\n"
        ),
        "specs/Scheduler.tla": (
            "---- MODULE Scheduler ----\n"
            "\\* BATCH-LABEL LEDGER\n"
            "\\* 'read-probe' -> excluded [read]\n"
            "\\* --------------------\n\n"
            "====\n"
        ),
    },
    forbidden_artifact="scripts/__pycache__",
)
if ledger_no_bytecode.returncode != 0:
    failures.append(
        "spec-ledger.py dirtied its clean fixture while importing source_lex — "
        "the ordinary verification gate must not create repository artifacts\n"
        f"    {(ledger_no_bytecode.stdout + ledger_no_bytecode.stderr).strip()[-200:]}"
    )

for f in failures:
    print(f"lint-selftest: {f}")
if failures:
    sys.exit(1)
print(
    f"lint-selftest: {len(BAD_CASES)} bad inputs, {len(GIT_BAD_CASES)} Git-state "
    f"inputs, {len(ENV_BAD_CASES)} environment inputs, and "
    f"{len(BAD_INVOCATIONS) + len(ENV_BAD_INVOCATIONS)} bad invocations rejected, "
    f"{len(GOOD_CASES) + len(GOOD_INVOCATIONS)} good inputs accepted"
)
