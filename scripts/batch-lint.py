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

# Source checkers are part of the clean-tree gate. Importing their shared
# lexical machinery must not create scripts/__pycache__ in the tree it audits.
sys.dont_write_bytecode = True

from source_lex import (
    batch_calls,
    batch_label,
    matching_delimiter,
    split_top_level,
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

# Read-only batches sent as text — no write to fence. A store's own reads are not here:
# each is a FencedBatch of reads (`readTree`), which runs in read mode whatever is asked
# and refuses a second read of the clock that gives no reason.
READS = {
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

# Call sites whose label is legitimately computed. Each names the file and the
# prefix it produces, so the label still has to be classified above; only the
# "must be a literal" rule is waived.
DYNAMIC = {
    ("packages/store-libsql/src/admin.ts", "migrate:v"): (
        "one batch per migration version, labelled by version"
    ),
    ("packages/store-postgres/src/admin.ts", "migrate:v"): (
        "one batch per migration version, labelled by version"
    ),
    ("packages/store-mysql/src/admin.ts", "migrate:v"): (
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
    ("packages/store-postgres/src/admin.ts", "migrate:v*"): (
        "fencedBatch(migration)",
        "the migration runner prepends an applied:vN primary-key sentinel "
        "and schema tests execute and freeze every generated migration",
    ),
    ("packages/store-mysql/src/admin.ts", "migrate:v*"): (
        "versionBatch(migration)",
        "MySQL commits each DDL statement on its own, so the executor runs "
        "every migrate: write under one named lock, every statement is safe "
        "to repeat, and schema tests execute and freeze every migration",
    ),
}

CLASSIFIED = READS | SINGLE_WRITES | set(TOKEN_FENCED) | DYNAMIC_LABELS

NOW_REFERENCE = re.compile(r"\$\{\s*NOW_MS\s*\}")


def significant_bounds(structure: str, start: int, end: int) -> tuple[int, int] | None:
    while start < end and structure[start].isspace():
        start += 1
    while end > start and structure[end - 1].isspace():
        end -= 1
    return None if start == end else (start, end)


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


try:
    call_inventory = batch_calls(root, source_paths, "batch-lint.py")
except ValueError as error:
    sys.exit(str(error))

violations = []
for path in source_paths:
    rel = str(path.relative_to(root))
    src = path.read_text()
    try:
        structural = typescript_structure(src)
    except ValueError as error:
        violations.append(f"{rel}: cannot lex TypeScript source: {error}")
        continue
    calls = call_inventory[rel]
    for call in calls:
        if call.kind != "raw":
            continue
        arguments = call.arguments
        if len(arguments) not in {2, 3}:
            violations.append(
                f"{rel}: this.db.batch call arguments are structurally opaque"
            )
            continue
        body = src[call.open_paren + 1 : call.close_paren]
        parsed_label = batch_label(src, call)
        if parsed_label.kind == "static":
            label = parsed_label.value
        elif (
            parsed_label.kind == "template"
            and (rel, parsed_label.value) in DYNAMIC
        ):
            label = parsed_label.value + "*"
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
        if statements > 1 and clocks > 1:
            violations.append(
                f"{rel}: '{label}' reads the clock in {clocks} places across "
                f"{statements} statements. Two statements of one batch see "
                f"DIFFERENT clocks on a real backend, so any pair of values "
                f"that must agree eventually will not. Derive the later ones "
                f"from what the first statement wrote."
            )

for v in violations:
    print(v)
if violations:
    sys.exit(1)

print(
    "batch-lint: clean — every batch call site is classified and matches its declared shape"
)
