#!/usr/bin/env python3
"""Batch-provenance lint (the root-cause mechanism for two whole bug classes).

Six review rounds found the SAME two classes proliferating across the store —
"two clock reads in one batch" (a batch reads database time in separate
statements, which drift by about a millisecond under real libSQL and MySQL)
and "a losing batch still writes" (a hand-rolled follow-on fires on a
PRE-EXISTING post-state that a stale, duplicate or corrupt invocation could
have produced). Both existed for one reason: those operations hand-rolled
`this.db.batch([...])` with per-statement guards instead of going through
FencedBatch, the primitive that stamps each statement and makes every
follow-on key on the winning write BY CONSTRUCTION. Nothing failed the build
to force the migration. This lint is that build failure.

THE HARVEST IS TOTAL, AND IT IS ABOUT SHAPE, NOT NAMES. Every executable
`this.db.batch(` call site is harvested through one lexical view. Inline
statement arrays are parsed object by object; an indirect statement list
fails closed rather than impersonating an empty batch. The sole generated
migration list is an exact, reason-bearing exception owned by its structural
sentinel tests. A label is a claim about shape, and this checks the claim —
the previous version trusted the label, so a batch classified as a single
write could quietly grow a second, unfenced statement and stay green forever.
The source inventory also fails closed instead of accepting an empty root.

Usage: batch-lint.py [root]   (root defaults to the repo; the self-test
passes a fixture tree, which is how this checker gets checked.)
"""

import re
import sys
from pathlib import Path

from source_lex import (
    matching_delimiter,
    store_typescript_sources,
    typescript_structure,
    validated_root,
)

try:
    root = validated_root(
        sys.argv[1:],
        Path(__file__).resolve().parent.parent,
        "batch-lint.py",
    )
    source_paths = store_typescript_sources(root, "batch-lint.py")
except ValueError as error:
    sys.exit(str(error))

# Read-only batches — no write to fence.
READS = {
    "get-checkpoints",
    "next-wake",
    "task-result",
    "sweep:scan",
    "admin:now",
    "migrate:version",
}

# Single-statement writes — one statement cannot key on another's post-state,
# and cannot disagree with itself about the time.
SINGLE_WRITES = {
    "expire-lease-now",
    "heartbeat",
    "admin:set-fake-now",
    "admin:clear-fake-now",
}

# Multi-statement writes whose stamp is a token the CALLER already holds, so
# they cannot mint a fresh one. Each needs a written reason, because "it is
# fine" is exactly the judgement this lint exists to stop being made silently.
TOKEN_FENCED = {
    # Observability only; nothing in the protocol reads the drivers table, and
    # re-applying the same beat is the same row.
    "driver-heartbeat": "advisory liveness row, replay-identical",
    # The migration runner carries its own structural fence: an applied:vN
    # sentinel INSERT whose key violation rolls the whole batch back.
    "migrate:bootstrap": "migration sentinel fence (schema.ts)",
}

# Batches allowed to read the clock in more than one statement. Every entry is
# a standing bug of class A unless the reason says why the drift is harmless,
# so this stays as close to empty as the engine allows.
MULTI_CLOCK = {
    # Two read-only discovery scans. A task sitting exactly on a deadline can
    # appear in one and not the other; the per-item batch that follows
    # re-checks every predicate under its own fence, so the only effect is
    # that the item waits for the next tick.
    "sweep:scan": "read-only discovery; every item is re-checked under its own fence",
}

# Call sites whose label is legitimately computed. Each names the file and the
# prefix it produces, so the label still has to be classified above; only the
# "must be a literal" rule is waived.
DYNAMIC = {
    ("packages/store-libsql/src/admin.ts", "migrate:v"): (
        "one batch per migration version, labelled by version"
    ),
}
DYNAMIC_LABELS = {"migrate:v*"}

# One shipped call delegates construction of its statement list. It is not
# silently counted as zero: the exception names the exact call and the
# independent structural mechanism that owns it.
OPAQUE_STATEMENT_LISTS = {
    ("packages/store-libsql/src/admin.ts", "migrate:v*"): (
        "fencedBatch(migration)",
        "the migration runner prepends an applied:vN primary-key sentinel "
        "and schema tests execute and freeze every generated migration",
    ),
}

# Every protocol transition now goes through FencedBatch, so this set is
# empty and stays empty: there is no longer a place to record new debt.
FENCED_DEBT: set[str] = set()

CLASSIFIED = READS | SINGLE_WRITES | set(TOKEN_FENCED) | FENCED_DEBT | DYNAMIC_LABELS

CALL = re.compile(r"\bthis\s*\.\s*db\s*\.\s*batch\s*\(")
STATIC_LABEL = re.compile(r"\A\s*'([a-zA-Z0-9:_-]+)'")
DYNAMIC_LABEL = re.compile(r"\A\s*`([a-zA-Z0-9:_-]*)\$\{")
NOW_REFERENCE = re.compile(r"\$\{\s*NOW_MS\s*\}")


def significant_bounds(structure: str, start: int, end: int) -> tuple[int, int] | None:
    while start < end and structure[start].isspace():
        start += 1
    while end > start and structure[end - 1].isspace():
        end -= 1
    return None if start == end else (start, end)


def trivia_only(source: str) -> bool:
    """Whether a span contains only whitespace and TypeScript comments."""
    index = 0
    while index < len(source):
        if source[index].isspace():
            index += 1
            continue
        if source.startswith("//", index):
            end = source.find("\n", index + 2)
            index = len(source) if end < 0 else end
            continue
        if source.startswith("/*", index):
            close = source.find("*/", index + 2)
            if close < 0:
                return False
            index = close + 2
            continue
        return False
    return True


def split_top_level(
    source: str,
    structure: str,
    start: int,
    end: int,
) -> list[tuple[int, int]] | None:
    """Split a structural span on commas outside all nested delimiters."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack: list[str] = []
    parts: list[tuple[int, int]] = []
    part_start = start
    for index in range(start, end):
        char = structure[index]
        if char in pairs:
            stack.append(char)
        elif char in pairs.values():
            if not stack or pairs[stack[-1]] != char:
                return None
            stack.pop()
        elif char == "," and not stack:
            parts.append((part_start, index))
            part_start = index + 1
    if stack:
        return None
    parts.append((part_start, end))
    if parts and trivia_only(source[parts[-1][0] : parts[-1][1]]):
        parts.pop()
    return parts


def top_level_sql_keys(structure: str, start: int, end: int) -> int | None:
    """Count literal `sql:` keys in one already-delimited object."""
    pairs = {"(": ")", "[": "]", "{": "}"}
    stack: list[str] = []
    count = 0
    index = start
    while index < end:
        char = structure[index]
        if char in pairs:
            stack.append(char)
            index += 1
            continue
        if char in pairs.values():
            if not stack or pairs[stack[-1]] != char:
                return None
            stack.pop()
            index += 1
            continue
        if not stack and (char.isalpha() or char in "_$"):
            token_end = index + 1
            while token_end < end and (
                structure[token_end].isalnum() or structure[token_end] in "_$"
            ):
                token_end += 1
            colon = token_end
            while colon < end and structure[colon].isspace():
                colon += 1
            if (
                structure[index:token_end] == "sql"
                and structure[colon : colon + 1] == ":"
            ):
                count += 1
            index = token_end
            continue
        index += 1
    return None if stack else count


def inline_statement_spans(
    src: str,
    structure: str,
    argument: tuple[int, int],
) -> list[tuple[int, int]] | None:
    """Resolve every member of an inline array to one statement object."""
    bounds = significant_bounds(structure, *argument)
    if bounds is None:
        return None
    start, end = bounds
    if structure[start] != "[":
        return None
    close = matching_delimiter(src, start, structure)
    if close is None or close != end - 1:
        return None
    elements = split_top_level(src, structure, start + 1, close)
    if elements is None:
        return None
    statements: list[tuple[int, int]] = []
    for element in elements:
        element_bounds = significant_bounds(structure, *element)
        if element_bounds is None:
            return None
        element_start, element_end = element_bounds
        if structure[element_start] != "{":
            return None
        element_close = matching_delimiter(src, element_start, structure)
        if element_close is None or element_close != element_end - 1:
            return None
        if top_level_sql_keys(structure, element_start + 1, element_close) != 1:
            return None
        statements.append((element_start, element_end))
    return statements


violations = []
for path in source_paths:
    rel = str(path.relative_to(root))
    src = path.read_text()
    try:
        structural = typescript_structure(src)
    except ValueError as error:
        violations.append(f"{rel}: cannot lex TypeScript source: {error}")
        continue
    for match in CALL.finditer(structural):
        open_paren = match.end() - 1
        close_paren = matching_delimiter(src, open_paren, structural)
        if close_paren is None:
            violations.append(
                f"{rel}: cannot establish this.db.batch call boundary; "
                "refusing an opaque batch shape"
            )
            continue
        arguments = split_top_level(src, structural, open_paren + 1, close_paren)
        if arguments is None or len(arguments) not in {2, 3}:
            violations.append(
                f"{rel}: this.db.batch call arguments are structurally opaque"
            )
            continue
        body = src[open_paren + 1 : close_paren]
        label_argument = src[arguments[0][0] : arguments[0][1]]
        static = STATIC_LABEL.match(label_argument)
        dynamic = DYNAMIC_LABEL.match(label_argument)
        if static:
            label = static.group(1)
        elif dynamic and (rel, dynamic.group(1)) in DYNAMIC:
            label = dynamic.group(1) + "*"
        else:
            violations.append(
                f"{rel}: this.db.batch( with a label this lint cannot read "
                f"({body[:40].strip()!r}) — a computed label is invisible to "
                f"this lint, the spec ledger and the label inventory at once. "
                f"Make it a literal, or declare it in DYNAMIC in "
                f"scripts/batch-lint.py."
            )
            continue

        if label not in CLASSIFIED:
            violations.append(
                f"{rel}: raw this.db.batch('{label}') is unclassified — a "
                f"multi-statement WRITE must use FencedBatch (post-state fence); "
                f"a read or single write is declared in READS / SINGLE_WRITES, "
                f"and a caller-token-fenced write in TOKEN_FENCED with a reason, "
                f"in scripts/batch-lint.py"
            )
            continue

        statement_spans = inline_statement_spans(
            src,
            structural,
            arguments[1],
        )
        if statement_spans is None:
            statement_argument = src[arguments[1][0] : arguments[1][1]]
            exemption = OPAQUE_STATEMENT_LISTS.get((rel, label))
            if exemption is None or re.sub(r"\s+", "", statement_argument) != re.sub(
                r"\s+", "", exemption[0]
            ):
                violations.append(
                    f"{rel}: '{label}' statement list shape is opaque — "
                    "raw batches must carry an inline array whose every "
                    "element exposes exactly one sql: property"
                )
                continue

        # The label is a CLAIM about the batch's shape. Check the claim.
        # Clock reads are counted per STATEMENT, not per occurrence: the
        # clock expression is stable within one statement (measured), so
        # using it three times there is one instant. Drift only happens
        # BETWEEN statements.
        statements = len(statement_spans) if statement_spans is not None else 0
        clocks = (
            sum(
                1
                for start, end in statement_spans
                if NOW_REFERENCE.search(src[start:end])
            )
            if statement_spans is not None
            else 0
        )
        is_read = (
            len(arguments) == 3
            and re.fullmatch(
                r"\s*'read'\s*",
                src[arguments[2][0] : arguments[2][1]],
            )
            is not None
        )

        if label in SINGLE_WRITES and statements != 1:
            violations.append(
                f"{rel}: '{label}' is declared a SINGLE write but carries "
                f"{statements} statements — a second statement has no fence "
                f"on the first one's post-state. Route it through FencedBatch, "
                f"or reclassify it in scripts/batch-lint.py."
            )
        if label in READS and not is_read:
            violations.append(
                f"{rel}: '{label}' is declared a READ but is not run in 'read' "
                f"mode — it can write, and nothing fences it."
            )
        if statements > 1 and clocks > 1 and label not in MULTI_CLOCK:
            violations.append(
                f"{rel}: '{label}' reads the clock in {clocks} places across "
                f"{statements} statements. Two statements of one batch see "
                f"DIFFERENT clocks on a real backend, so any pair of values "
                f"that must agree eventually will not. Derive the later ones "
                f"from what the first statement wrote, or declare the batch in "
                f"MULTI_CLOCK in scripts/batch-lint.py with a reason."
            )

for v in violations:
    print(v)
if violations:
    sys.exit(1)

print(
    "batch-lint: clean — every batch call site is classified and matches its declared shape"
)
