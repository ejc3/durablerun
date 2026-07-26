#!/usr/bin/env python3
"""The review-bot rules are a corpus, not a folder of essays.

Two hosted reviewers read `.github/review-bot-rules/`: CodeRabbit through
`.coderabbit.yaml` and Greptile through `.greptile/config.json`. Nothing about
that arrangement is self-correcting. A rule can be written and referenced by
neither config, in which case no reviewer ever applies it. A config can name a
rule file that was renamed, in which case the reviewer is pointed at nothing
and says so to nobody. A rule can be scoped to a directory that no longer
exists and quietly grade an empty set. Every one of those failures looks
exactly like a working rule from the outside, which is the property this repo
keeps paying for: a checker that cannot fail is believed.

This project has been here before in miniature. `spec-ledger.py` exists
because a batch label could be shipped and never enter the ledger;
`gate-lint.py` exists because a checker could be written, fixtured, and never
invoked. This is the same total-harvest rule applied to the reviewers: every
rule file has one canonical marked synopsis, both configs carry that exact
synopsis in one active error rule, every reference resolves to a file, and
every scope matches something that exists.

What it deliberately does NOT do is judge the rules. Whether a rule is any
good is settled by whether its findings survive, and that shows up in the
detection ledger of the next postmortem. A hosted reviewer is a detection net
of last resort, never a rung on the prevention ladder (CLAUDE.md); this script
only makes sure the net is actually strung up.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

_args = [a for a in sys.argv[1:] if not a.startswith("-")]
ROOT = Path(_args[0]).resolve() if _args else Path(__file__).resolve().parent.parent

RULES_DIR = ROOT / ".github" / "review-bot-rules"
CODERABBIT = ROOT / ".coderabbit.yaml"
GREPTILE = ROOT / ".greptile" / "config.json"
GREPTILE_RULES = ROOT / ".greptile" / "rules.md"
SYNOPSIS_START = "<!-- review-bot-synopsis:start -->"
SYNOPSIS_END = "<!-- review-bot-synopsis:end -->"
SCOPE_START = "<!-- review-bot-scope:start -->"
SCOPE_END = "<!-- review-bot-scope:end -->"
GLOBAL_START = "<!-- review-bot-global:start -->"
GLOBAL_END = "<!-- review-bot-global:end -->"
GATING_START = "<!-- review-bot-gating:start -->"
GATING_END = "<!-- review-bot-gating:end -->"
HOSTED_GATE_NOTE = (
    "CodeRabbit custom checks are configured with `mode: error`, and "
    "`reviews.request_changes_workflow: true` turns a failed error check into a "
    "requested-changes review. CodeRabbit custom checks expose `name`, `mode`, and "
    "`instructions`; they do not define per-check GitHub status contexts. Greptile is "
    'configured with `"statusCheck": true`. Require only the aggregate contexts the '
    "installed apps actually publish."
)

PROVENANCE_MARKERS = (
    "https://docs.coderabbit.ai/getting-started/yaml-configuration",
    "feature branch under review",
    "https://www.greptile.com/docs/code-review/greptile-json-reference",
    "source branch of the PR",
    "can therefore weaken its own in-repo review rules",
)
FORBIDDEN_PROVENANCE = (
    "Do not treat pull-request-head edits",
    "Review bots must apply the BASE branch's configuration",
    "Both read config from the DEFAULT BRANCH",
    "reads `.coderabbit.yaml` from the default branch",
)
LINE_CITATION = re.compile(
    r"(?P<path>(?:[\w.@-]+/)*[\w.@-]+\."
    r"(?:json|md|py|sh|tla|ts|tsx|yaml|yml)):"
    r"(?P<line>[0-9]+)(?:-[0-9]+)?"
)
LITERAL_STORE_SCOPE = re.compile(r"^packages/store-(?!\*)[^/]+/")
DIALECT_SCOPE_EXEMPTION = "<!-- review-bot-dialect-scope-exemption:"

# Sections every rule must carry. The Allowed list is not optional and not a
# formality: a rule that flags correct code gets switched off, and a switched-
# off rule protects nothing. Requiring the author to write down the nearest
# legitimate shape is what stops that.
REQUIRED = (
    ("Scope:", "a Scope line naming what it covers and what a sibling rule covers instead"),
    ("Report a failure when", "the list of failure shapes"),
    ("Allowed cases", "the shapes that must NOT be flagged"),
)

# The rule id a config uses is derived from the filename, so the two cannot
# drift apart without this script noticing.
def rule_id(stem: str) -> str:
    return f"durablerun-{stem}"


def check_name(stem: str) -> str:
    return f"durablerun: {stem}"


def coderabbit_body(rel: str, synopsis: str) -> str:
    return (
        f"Fail when the diff introduces or materially widens any failure shape in `{rel}`. "
        f"{synopsis} Pass for the cases listed in that file Allowed section, for test-only "
        "scaffolding that does not make production behaviour worse, and for existing debt "
        "the diff does not worsen."
    )


def rule_synopsis(text: str, rel: str) -> tuple[str, list[str]]:
    """Read the config-facing rule body from its Markdown source."""
    body, errors = marked_body(text, SYNOPSIS_START, SYNOPSIS_END, rel)
    if errors:
        return body, errors
    if not body.startswith("Flag ") or body.count("Pass for ") != 1:
        return body, [
            f"{rel}'s active-review synopsis must state both a 'Flag' rejection arm "
            "and a 'Pass for' allowance arm."
        ]
    return body, []


def red_pair_policy(text: str, synopsis: str, rel: str) -> list[str]:
    """The canonical red-test rule may not grant a one-commit exception."""
    if not rel.endswith("/red-test-before-fix.md") or not synopsis:
        return []
    rejection, allowance = synopsis.split("Pass for ", 1)
    problems: list[str] = []
    if "regression test and fix share one commit" not in rejection.lower():
        problems.append(
            f"{rel}'s active-review synopsis does not unconditionally reject a "
            "regression test and fix sharing one commit."
        )
    if "combined commit" in allowance.lower():
        problems.append(
            f"{rel}'s active-review synopsis Pass for arm permits combined repair commits."
        )
    allowed = text.split("Allowed cases", 1)[1] if "Allowed cases" in text else ""
    if re.search(r"(?im)^\s*-\s+.*combined commit", allowed):
        problems.append(f"{rel}'s Allowed cases section permits a combined repair commit.")
    return problems


def citation_problems(text: str, rel: str) -> list[str]:
    """Reject line-number citations, whose target silently changes by insertion."""
    problems: list[str] = []
    for match in LINE_CITATION.finditer(text):
        citation = match.group(0)
        path = match.group("path")
        line = int(match.group("line"))
        target = ROOT / path
        if "/" in path and target.is_file():
            line_count = len(target.read_text().splitlines())
            if line > line_count:
                problems.append(
                    f"{rel} references {citation}, but that file has only "
                    f"{line_count} line{'s' if line_count != 1 else ''}."
                )
                continue
        problems.append(
            f"{rel} uses unstable line citation {citation!r}; cite the file and "
            "symbol or heading instead."
        )
    return problems


def marked_body(text: str, start_marker: str, end_marker: str, rel: str) -> tuple[str, list[str]]:
    """Read one canonical literal body from a pair of unique markers."""
    if text.count(start_marker) != 1 or text.count(end_marker) != 1:
        return "", [
            f"{rel} must contain exactly one {start_marker!r} and one {end_marker!r} marker."
        ]
    start = text.index(start_marker) + len(start_marker)
    end = text.index(end_marker)
    if end <= start:
        return "", [f"{rel} has its {start_marker!r} markers out of order."]
    body = text[start:end].strip()
    if not body:
        return "", [f"{rel} has an empty body between {start_marker!r} markers."]
    return body, []


def yaml_scalar(raw: str) -> str:
    """Decode the scalar spellings used by CodeRabbit's generated check list."""
    raw = raw.strip()
    if raw.startswith('"'):
        value = json.loads(raw)
        if not isinstance(value, str):
            raise ValueError("expected a string")
        return value
    if raw.startswith("'") and raw.endswith("'"):
        return raw[1:-1].replace("''", "'")
    return raw.split(" #", 1)[0].strip()


def significant_yaml_line(line: str) -> bool:
    return bool(line.strip()) and not line.lstrip().startswith("#")


def normalized_prose(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def yaml_block_end(lines: list[str], start: int, indent: int, limit: int) -> int:
    for index in range(start + 1, limit):
        line = lines[index]
        if significant_yaml_line(line) and len(line) - len(line.lstrip()) <= indent:
            return index
    return limit


def coderabbit_path_instructions(text: str) -> tuple[list[dict[str, str]], list[str]]:
    """Harvest the one generated `reviews.path_instructions` list.

    The list is fully owned here. Accepting arbitrary extra path entries would
    let one active instruction countermand the canonical error checks while
    every checked body remained intact.
    """
    lines = text.splitlines()
    errors: list[str] = []

    reviews = [i for i, line in enumerate(lines) if re.fullmatch(r"reviews:\s*", line)]
    if len(reviews) != 1:
        return [], [f".coderabbit.yaml has {len(reviews)} top-level reviews sections; expected one."]

    reviews_end = yaml_block_end(lines, reviews[0], 0, len(lines))
    sections = [
        i
        for i in range(reviews[0] + 1, reviews_end)
        if re.fullmatch(r"  path_instructions:\s*", lines[i])
    ]
    if len(sections) != 1:
        return [], [
            ".coderabbit.yaml has no unique reviews.path_instructions list, so active "
            "path review semantics are ambiguous."
        ]

    section_end = yaml_block_end(lines, sections[0], 2, reviews_end)
    raw_entries: list[tuple[int, str]] = []
    for i in range(sections[0] + 1, section_end):
        match = re.fullmatch(r"    - path:\s*(.*?)\s*", lines[i])
        if match:
            raw_entries.append((i, match.group(1)))
        elif re.match(r"^    - ", lines[i]):
            errors.append(
                f".coderabbit.yaml line {i + 1} is a path instruction without a literal path."
            )

    entries: list[dict[str, str]] = []
    for position, (start, raw_path) in enumerate(raw_entries):
        end = raw_entries[position + 1][0] if position + 1 < len(raw_entries) else section_end
        try:
            path = yaml_scalar(raw_path)
        except (ValueError, json.JSONDecodeError) as exc:
            errors.append(
                f".coderabbit.yaml line {start + 1} has an invalid path scalar: {exc}."
            )
            continue

        headers = [
            i
            for i in range(start + 1, end)
            if re.fullmatch(r"      instructions:\s*\|\s*", lines[i])
        ]
        if len(headers) != 1:
            errors.append(
                f".coderabbit.yaml path {path!r} has {len(headers)} literal instruction "
                "bodies; expected one."
            )

        body = ""
        if len(headers) == 1:
            body_lines: list[str] = []
            for line in lines[headers[0] + 1 : end]:
                if significant_yaml_line(line) and len(line) - len(line.lstrip()) <= 6:
                    break
                body_lines.append(line[8:] if line.startswith("        ") else line.strip())
            body = "\n".join(body_lines).strip()
        entries.append({"path": path, "instructions": body})

    return entries, errors


def coderabbit_request_changes_workflow(text: str) -> list[str]:
    """Require error-mode checks to have the workflow that makes them blocking."""
    lines = text.splitlines()
    reviews = [i for i, line in enumerate(lines) if re.fullmatch(r"reviews:\s*", line)]
    if len(reviews) != 1:
        return []
    reviews_end = yaml_block_end(lines, reviews[0], 0, len(lines))
    values = [
        match.group(1).split(" #", 1)[0].strip()
        for line in lines[reviews[0] + 1 : reviews_end]
        if (
            match := re.fullmatch(
                r"  request_changes_workflow:\s*(.*?)\s*",
                line,
            )
        )
    ]
    if len(values) != 1:
        return [
            ".coderabbit.yaml has no unique reviews.request_changes_workflow boolean."
        ]
    if values[0] != "true":
        return [
            ".coderabbit.yaml reviews.request_changes_workflow is not true, so "
            "error-mode custom checks cannot request changes."
        ]
    return []


def coderabbit_custom_checks(text: str) -> tuple[list[dict[str, str]], list[str]]:
    """Harvest only active `reviews.pre_merge_checks.custom_checks` entries.

    A full YAML dependency would make the checker unavailable in the minimal
    Python environment used by the gate. This parser is intentionally narrow
    and fails closed when the one generated shape this repository owns drifts.
    Text elsewhere in the file, including path instructions and comments,
    cannot enter the result.
    """
    lines = text.splitlines()
    errors: list[str] = []

    reviews = [i for i, line in enumerate(lines) if re.fullmatch(r"reviews:\s*", line)]
    if len(reviews) != 1:
        return [], [f".coderabbit.yaml has {len(reviews)} top-level reviews sections; expected one."]

    reviews_end = yaml_block_end(lines, reviews[0], 0, len(lines))
    pre_merge = [
        i
        for i in range(reviews[0] + 1, reviews_end)
        if re.fullmatch(r"  pre_merge_checks:\s*", lines[i])
    ]
    if len(pre_merge) != 1:
        return [], [
            ".coderabbit.yaml has no unique reviews.pre_merge_checks section, so no custom "
            "rule can gate a review."
        ]

    pre_merge_end = yaml_block_end(lines, pre_merge[0], 2, reviews_end)
    custom = [
        i
        for i in range(pre_merge[0] + 1, pre_merge_end)
        if re.fullmatch(r"    custom_checks:\s*", lines[i])
    ]
    if len(custom) != 1:
        return [], [
            ".coderabbit.yaml has no unique reviews.pre_merge_checks.custom_checks list."
        ]

    custom_end = yaml_block_end(lines, custom[0], 4, pre_merge_end)
    entries: list[tuple[int, str]] = []
    for i in range(custom[0] + 1, custom_end):
        match = re.fullmatch(r"      - name:\s*(.*?)\s*", lines[i])
        if match:
            entries.append((i, match.group(1)))
        elif re.match(r"^      - ", lines[i]):
            errors.append(
                f".coderabbit.yaml line {i + 1} is a custom check without a literal name."
            )

    checks: list[dict[str, str]] = []
    for position, (start, raw_name) in enumerate(entries):
        end = entries[position + 1][0] if position + 1 < len(entries) else custom_end
        try:
            name = yaml_scalar(raw_name)
        except (ValueError, json.JSONDecodeError) as exc:
            errors.append(f".coderabbit.yaml line {start + 1} has an invalid check name: {exc}.")
            continue

        instruction_headers = [
            i
            for i in range(start + 1, end)
            if re.fullmatch(r"        instructions:\s*\|\s*", lines[i])
        ]
        instruction_body_start = (
            instruction_headers[0] + 1 if len(instruction_headers) == 1 else end
        )
        for index in range(start + 1, end):
            line = lines[index]
            if not significant_yaml_line(line):
                continue
            indent = len(line) - len(line.lstrip())
            if index >= instruction_body_start and indent >= 10:
                continue
            if indent != 8:
                errors.append(
                    f".coderabbit.yaml check {name!r} line {index + 1} has "
                    f"unrecognized custom-check indentation ({indent}); fields use "
                    "eight spaces and literal instruction bodies use at least ten."
                )
                continue
            field = re.fullmatch(r"        ([A-Za-z][A-Za-z0-9_-]*):.*", line)
            if not field:
                errors.append(
                    f".coderabbit.yaml check {name!r} line {index + 1} has "
                    "unrecognized custom-check field syntax; use literal mode and "
                    "instructions fields only."
                )
            elif field.group(1) not in {"mode", "instructions"}:
                errors.append(
                    f".coderabbit.yaml check {name!r} has unsupported field "
                    f"{field.group(1)!r}; custom checks expose only name, mode, "
                    "and instructions."
                )

        raw_modes = [
            match.group(1)
            for line in lines[start + 1 : end]
            if (match := re.fullmatch(r"        mode:\s*(.*?)\s*", line))
        ]
        modes: list[str] = []
        for raw_mode in raw_modes:
            try:
                modes.append(yaml_scalar(raw_mode))
            except (ValueError, json.JSONDecodeError) as exc:
                errors.append(
                    f".coderabbit.yaml check {name!r} has an invalid mode scalar: {exc}."
                )
        if len(modes) != 1:
            errors.append(
                f".coderabbit.yaml check {name!r} has {len(modes)} mode fields; expected one."
            )
        if len(instruction_headers) != 1:
            errors.append(
                f".coderabbit.yaml check {name!r} has {len(instruction_headers)} literal "
                "instruction bodies; expected one."
            )

        body = ""
        if len(instruction_headers) == 1:
            body_lines: list[str] = []
            for line in lines[instruction_headers[0] + 1 : end]:
                if significant_yaml_line(line) and len(line) - len(line.lstrip()) <= 8:
                    break
                body_lines.append(line[10:] if line.startswith("          ") else line.strip())
            body = "\n".join(body_lines).strip()

        checks.append(
            {
                "name": name,
                "mode": modes[0] if len(modes) == 1 else "",
                "instructions": body,
            }
        )

    return checks, errors


def tracked(root: Path) -> tuple[list[str], str | None]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files"], capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        detail = out.stderr.strip() or f"exit status {out.returncode}"
        return [], f"git ls-files failed, so review scopes cannot be audited: {detail}"
    paths = out.stdout.splitlines()
    if not paths:
        return [], "git ls-files returned no paths, so review scope validation would be vacuous."
    return paths, None


def main() -> int:
    problems: list[str] = []

    if not RULES_DIR.is_dir():
        problems.append(
            f"{RULES_DIR.relative_to(ROOT)} is missing. Without the corpus, every rule check "
            "below would be vacuous."
        )

    files = (
        sorted(p for p in RULES_DIR.glob("*.md") if p.name != "README.md")
        if RULES_DIR.is_dir()
        else []
    )
    stems = {p.stem for p in files}

    if not files:
        problems.append(
            f"{RULES_DIR.relative_to(ROOT)} holds no rules. An empty corpus makes every check "
            "below vacuous."
        )

    # 1. Each rule file has the sections that make it applicable to a diff,
    #    plus the compact synopsis both hosted configurations must apply.
    synopses: dict[str, str] = {}
    rule_scopes: dict[str, list[str]] = {}
    for p in files:
        body = p.read_text()
        rel = str(p.relative_to(ROOT))
        for marker, what in REQUIRED:
            if marker not in body:
                problems.append(
                    f"{rel} has no {what!r} section (looked for {marker!r}). "
                    f"A rule missing it is prose, and a reviewer will apply it as taste."
                )
        if "\n- " not in body.split("Report a failure when", 1)[-1][:4000]:
            problems.append(
                f"{rel} lists no failure shapes as bullets. A shape a reviewer "
                f"cannot decide from a diff generates noise that buries real findings."
            )
        synopsis, synopsis_problems = rule_synopsis(body, rel)
        problems.extend(synopsis_problems)
        if synopsis and not synopsis_problems:
            synopses[p.stem] = synopsis
            problems.extend(red_pair_policy(body, synopsis, rel))
        problems.extend(citation_problems(body, rel))
        scope_body, scope_problems = marked_body(body, SCOPE_START, SCOPE_END, rel)
        problems.extend(scope_problems)
        if scope_body:
            scopes = [line.strip() for line in scope_body.splitlines() if line.strip()]
            if any(re.search(r"\s", scope) for scope in scopes):
                problems.append(f"{rel} has whitespace inside a canonical review scope.")
            elif len(scopes) != len(set(scopes)):
                problems.append(f"{rel} repeats a canonical review scope.")
            else:
                rule_scopes[p.stem] = scopes
                if (
                    any(LITERAL_STORE_SCOPE.match(scope) for scope in scopes)
                    and DIALECT_SCOPE_EXEMPTION not in body
                ):
                    literal = next(
                        scope for scope in scopes if LITERAL_STORE_SCOPE.match(scope)
                    )
                    problems.append(
                        f"{rel} uses literal dialect scope {literal!r}; use a "
                        "packages/store-* scope or declare why the rule is dialect-local."
                    )

    readme = RULES_DIR / "README.md"
    readme_text = readme.read_text() if readme.exists() else ""
    global_instructions = ""
    if readme_text:
        global_instructions, global_problems = marked_body(
            readme_text,
            GLOBAL_START,
            GLOBAL_END,
            str(readme.relative_to(ROOT)),
        )
        problems.extend(global_problems)
        gating_note, gating_problems = marked_body(
            readme_text,
            GATING_START,
            GATING_END,
            str(readme.relative_to(ROOT)),
        )
        problems.extend(gating_problems)
        if (
            not gating_problems
            and normalized_prose(gating_note) != HOSTED_GATE_NOTE
        ):
            problems.append(
                f"{readme.relative_to(ROOT)} hosted-gate note is not the canonical "
                "account of active configuration."
            )

    # 2. Both hosted reviewers must carry one ACTIVE body for every rule. A
    #    filename appearing in path instructions or an id with an empty body
    #    is only a textual reference; neither can fail a review.
    cr_text = CODERABBIT.read_text() if CODERABBIT.exists() else ""
    cr_checks: list[dict[str, str]] = []
    cr_paths: list[dict[str, str]] = []
    if not cr_text:
        problems.append(".coderabbit.yaml is missing — CodeRabbit would review with no rules at all.")
    else:
        cr_paths, cr_path_errors = coderabbit_path_instructions(cr_text)
        problems.extend(cr_path_errors)
        problems.extend(coderabbit_request_changes_workflow(cr_text))
        cr_checks, cr_errors = coderabbit_custom_checks(cr_text)
        problems.extend(cr_errors)

    if len(cr_paths) != 1:
        problems.append(
            f".coderabbit.yaml has {len(cr_paths)} active path instructions; expected exactly "
            "the one corpus-owned global instruction."
        )
    elif cr_paths[0]["path"] != "**/*":
        problems.append(
            f".coderabbit.yaml global path instruction uses {cr_paths[0]['path']!r}, not '**/*'."
        )
    elif global_instructions and cr_paths[0]["instructions"] != global_instructions:
        problems.append(
            ".coderabbit.yaml global path instruction is not the canonical marked body "
            f"from {readme.relative_to(ROOT)}."
        )

    cr_by_name: dict[str, list[dict[str, str]]] = {}
    for check in cr_checks:
        cr_by_name.setdefault(check["name"], []).append(check)

    gp_rules: dict[str, list[dict[str, object]]] = {}
    gp_scopes: dict[str, list[str]] = {}
    if GREPTILE.exists():
        try:
            cfg = json.loads(GREPTILE.read_text())
        except json.JSONDecodeError as e:
            problems.append(f".greptile/config.json does not parse: {e}")
            cfg = {}
        entries = cfg.get("rules", [])
        if not isinstance(entries, list):
            problems.append('.greptile/config.json "rules" is not a list.')
            entries = []
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                problems.append(
                    f".greptile/config.json rule {index} is not an object and cannot be active."
                )
                continue
            rid = entry.get("id")
            if not isinstance(rid, str) or not rid:
                problems.append(f".greptile/config.json rule {index} has no string id.")
                continue
            gp_rules.setdefault(rid, []).append(entry)
            scope = entry.get("scope", [])
            if not isinstance(scope, list) or not all(isinstance(g, str) for g in scope):
                problems.append(f".greptile/config.json rule {rid!r} has a non-string scope.")
            else:
                gp_scopes[rid] = scope
        if cfg.get("statusCheck") is not True:
            problems.append(
                '.greptile/config.json does not set "statusCheck": true, so Greptile posts no '
                "status and its findings cannot gate anything."
            )
    else:
        problems.append(".greptile/config.json is missing — Greptile would review with no rules.")

    for p in files:
        rel = f".github/review-bot-rules/{p.name}"
        synopsis = synopses.get(p.stem, "")
        named_checks = cr_by_name.get(check_name(p.stem), [])
        if len(named_checks) != 1:
            problems.append(
                f"{rel} has {len(named_checks)} active CodeRabbit checks named "
                f"{check_name(p.stem)!r}; expected exactly one."
            )
        else:
            check = named_checks[0]
            if check["mode"] != "error":
                problems.append(
                    f"CodeRabbit check {check['name']!r} uses mode {check['mode']!r}, not 'error'."
                )
            if not check["instructions"]:
                problems.append(f"CodeRabbit check {check['name']!r} has an empty instruction body.")
            elif rel not in check["instructions"]:
                problems.append(
                    f"CodeRabbit check {check['name']!r} does not link its corpus file {rel}."
                )
            elif synopsis and check["instructions"] != coderabbit_body(rel, synopsis):
                problems.append(
                    f"CodeRabbit check {check['name']!r} is not the canonical active-review "
                    f"synopsis from {rel} in the required error-check wrapper."
                )

        named_rules = gp_rules.get(rule_id(p.stem), [])
        if len(named_rules) != 1:
            problems.append(
                f"{rel} has {len(named_rules)} Greptile rules with id {rule_id(p.stem)!r}; "
                "expected exactly one."
            )
        else:
            body = named_rules[0].get("rule")
            if not isinstance(body, str) or not body.strip():
                problems.append(f"Greptile rule {rule_id(p.stem)!r} has an empty rule body.")
            elif synopsis and body.strip() != synopsis:
                problems.append(
                    f"Greptile rule {rule_id(p.stem)!r} is not the canonical active-review "
                    f"synopsis from {rel}."
                )
            elif len(named_checks) == 1 and body.strip() not in named_checks[0]["instructions"]:
                problems.append(
                    f"Greptile rule {rule_id(p.stem)!r} is not present verbatim in the "
                    "corresponding active CodeRabbit instructions; the two rule bodies drifted."
                )
        canonical_scope = rule_scopes.get(p.stem)
        configured_scope = gp_scopes.get(rule_id(p.stem))
        if (
            canonical_scope is not None
            and configured_scope is not None
            and configured_scope != canonical_scope
        ):
            problems.append(
                f"Greptile rule {rule_id(p.stem)!r} has scope {configured_scope!r}, not "
                f"the canonical scope {canonical_scope!r} from {rel}."
            )

    # 3. And the reverse: a config naming a rule that does not exist points the
    #    reviewer at nothing, silently.
    expected_checks = {check_name(stem) for stem in stems}
    for name in sorted(cr_by_name):
        if name not in expected_checks:
            problems.append(
                f".coderabbit.yaml declares active check {name!r}, but no rule filename derives it."
            )
    for rid in sorted(gp_rules):
        stem = rid.removeprefix("durablerun-")
        if stem not in stems:
            problems.append(
                f".greptile/config.json declares rule {rid!r}, but "
                f".github/review-bot-rules/{stem}.md does not exist."
            )
    for rel in sorted(set(re.findall(r"\.github/review-bot-rules/([\w.-]+\.md)", cr_text))):
        if rel != "README.md" and rel[:-3] not in stems:
            problems.append(
                f".coderabbit.yaml references .github/review-bot-rules/{rel}, which does not exist."
            )

    # 4. A scope that matches nothing grades an empty set and reports clean
    #    forever, which is indistinguishable from a rule that found no problems.
    paths, tracking_problem = tracked(ROOT)
    if tracking_problem:
        problems.append(tracking_problem)
    else:
        for rid, globs in sorted(gp_scopes.items()):
            for g in globs:
                pat = re.escape(g).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
                if not any(re.fullmatch(pat, f) for f in paths):
                    problems.append(
                        f"rule {rid!r} is scoped to {g!r}, which matches no tracked file. "
                        f"It will grade an empty set and report clean forever."
                    )

    # 5. CodeRabbit rejects a custom-check name of 50 characters or more, and
    #    rejects the WHOLE file when it does — falling back to default review
    #    with the rules silently unused. It reports this in a pull-request
    #    comment, which is the worst place for it: the configuration looks
    #    installed, the bot posts, and none of the rules are running. It cost
    #    exactly one real review round to find, so it is a rule now.
    for name in (check["name"] for check in cr_checks):
        if len(name) >= 50:
            problems.append(
                f'.coderabbit.yaml check name is {len(name)} characters, and CodeRabbit '
                f'refuses the whole file at 50 or more: {name!r}. The file then falls back '
                f'to defaults and every rule here is silently unused.'
            )

    # 6. Both human indexes describe the same corpus. Drift in either is how a
    #    rule becomes invisible to the person deciding whether one covers a class.
    for index, text in (
        (readme, readme_text),
        (
            GREPTILE_RULES,
            GREPTILE_RULES.read_text() if GREPTILE_RULES.exists() else "",
        ),
    ):
        if not index.exists():
            problems.append(
                f"{index.relative_to(ROOT)} is missing, so the corpus has no index there."
            )
            continue
        for p in files:
            if p.name not in text:
                problems.append(f"{p.name} is not listed in {index.relative_to(ROOT)}.")
        for named in re.findall(r"`([\w.-]+\.md)`", text):
            if named != "README.md" and named[:-3] not in stems:
                problems.append(
                    f"{index.relative_to(ROOT)} lists {named}, which no longer exists."
                )

    # 7. Configuration provenance is a service fact, not an instruction a
    #    source-branch file can wish away. Preserve the explicit residual in
    #    the human index and every bot-facing copy so this repository never
    #    again describes head-owned review rules as base-owned enforcement.
    if readme.exists():
        for marker in PROVENANCE_MARKERS:
            if marker not in readme_text:
                problems.append(
                    f"{readme.relative_to(ROOT)} omits configuration-provenance marker "
                    f"{marker!r}."
                )

    provenance_docs = {
        CODERABBIT: ("feature branch under review", "can edit or remove"),
        GREPTILE: ("source branch of the PR", "can edit or remove"),
        GREPTILE_RULES: ("source branch of the PR", "can edit or remove"),
    }
    for path, markers in provenance_docs.items():
        if not path.exists():
            problems.append(f"{path.relative_to(ROOT)} is missing its provenance disclosure.")
            continue
        body = path.read_text()
        for marker in markers:
            if marker not in body:
                problems.append(
                    f"{path.relative_to(ROOT)} omits configuration-provenance marker {marker!r}."
                )
        for false_claim in FORBIDDEN_PROVENANCE:
            if false_claim in body:
                problems.append(
                    f"{path.relative_to(ROOT)} repeats the false provenance claim "
                    f"{false_claim!r}."
                )

    if readme.exists():
        for false_claim in FORBIDDEN_PROVENANCE:
            if false_claim in readme_text:
                problems.append(
                    f"{readme.relative_to(ROOT)} repeats the false provenance claim "
                    f"{false_claim!r}."
                )

    if problems:
        print("review-bot-lint: the rule corpus and the bots disagree\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}\n", file=sys.stderr)
        return 1

    print(
        f"review-bot-lint: clean — {len(files)} rules, each active in CodeRabbit and Greptile, "
        "with corpus-derived matching bodies and scopes, one canonical global path "
        "instruction, disclosed source-branch provenance, and every scope matching "
        "tracked files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
