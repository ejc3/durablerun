#!/usr/bin/env python3
"""Batch-label ledger check (see scripts/spec-ledger.sh history): every
labeled batch in the store must be accounted for INSIDE the spec's ledger
block, as a quoted 'label'. Multiline-tolerant harvest; dynamic labels are
declared here and asserted present in the source so they cannot rot.

Each side model that scripts/tla.sh enrols keeps a ledger block of its own, and
it is read too: its quoted labels are labels the stores send, its actions are
the actions of the module's next-state relation, all of them, and a class it
states is the class the main ledger gives that label.

`--labels` prints every static label. `--text-labels` prints, for each store, the
labels of its raw batches, which are the statements it sends as SQL text and not
as trees; a template label is its prefix and a star."""
import json
import re
import sys
from pathlib import Path

# Source checkers are part of the clean-tree gate. Importing their shared
# lexical machinery must not create scripts/__pycache__ in the tree it audits.
sys.dont_write_bytecode = True

from source_lex import (
    batch_calls,
    batch_label,
    store_typescript_sources,
    validated_root,
)

arguments = list(sys.argv[1:])
asked = [flag for flag in ("--labels", "--text-labels") if flag in arguments]
if len(asked) > 1 or any(arguments.count(flag) > 1 for flag in asked):
    sys.exit("spec-ledger.py: --labels or --text-labels may appear at most once")
labels_only = asked == ["--labels"]
text_labels_only = asked == ["--text-labels"]
for flag in asked:
    arguments.remove(flag)
try:
    root = validated_root(
        arguments,
        Path(__file__).resolve().parent.parent,
        "spec-ledger.py",
    )
    source_paths = store_typescript_sources(root, "spec-ledger.py")
except ValueError as error:
    sys.exit(str(error))

# Template migration labels are setup trace addresses rather than protocol
# actions; their SQL shape is independently fenced and checked by batch-lint.
# Every protocol label is otherwise a literal at its FencedBatch construction
# site, so the executable call and this inventory have one representation.
SETUP_LABEL_FAMILIES = {
    (
        "packages/store-libsql/src/admin.ts",
        "raw",
        "migrate:v",
    ): "migration versions are setup trace addresses, not protocol actions",
    (
        "packages/store-postgres/src/admin.ts",
        "raw",
        "migrate:v",
    ): "migration versions are setup trace addresses, not protocol actions",
    (
        "packages/store-mysql/src/admin.ts",
        "raw",
        "migrate:v",
    ): "migration versions are setup trace addresses, not protocol actions",
}

labels: set[str] = set()
text_labels: dict[str, set[str]] = {}
try:
    call_inventory = batch_calls(root, source_paths, "spec-ledger.py")
except ValueError as error:
    sys.exit(str(error))

for path in source_paths:
    rel = path.relative_to(root).as_posix()
    source = path.read_text()
    calls = call_inventory[rel]
    parsed_calls = [(call, batch_label(source, call)) for call in calls]
    store_text = text_labels.setdefault(rel.split("/")[1], set())
    store_text.update(
        parsed.value + ("*" if parsed.kind == "template" else "")
        for call, parsed in parsed_calls
        if call.kind == "raw" and parsed.kind != "opaque"
    )
    opaque_identities = [
        (call.kind, parsed.value)
        for call, parsed in parsed_calls
        if parsed.kind == "opaque"
    ]
    duplicate_opaque = next(
        (
            identity
            for identity in opaque_identities
            if opaque_identities.count(identity) > 1
        ),
        None,
    )
    if duplicate_opaque is not None:
        sys.exit(
            f"{rel}: opaque label classification is not unique to one binding: "
            f"{duplicate_opaque[0]} label {duplicate_opaque[1]!r}"
        )
    for call, parsed in parsed_calls:
        if parsed.kind == "static":
            labels.add(parsed.value)
            continue
        identity = (rel, call.kind, parsed.value)
        if parsed.kind == "template" and identity in SETUP_LABEL_FAMILIES:
            continue
        sys.exit(
            f"{rel}: batch call shape is opaque: "
            f"cannot resolve {call.kind} label {parsed.value!r}"
        )

if labels_only:
    print(json.dumps(sorted(labels)))
    sys.exit(0)
if text_labels_only:
    print(json.dumps({store: sorted(found) for store, found in sorted(text_labels.items())}))
    sys.exit(0)

spec = (root / "specs" / "Scheduler.tla").read_text()

# The check is scoped to the ledger block and requires the quoted form —
# a bare word elsewhere in the spec (prose, identifiers) counts for nothing.
LEDGER_BLOCK = re.compile(r"BATCH-LABEL LEDGER.*?-{20,}\n\n", re.S)
match = LEDGER_BLOCK.search(spec)
if not match:
    sys.exit("spec-ledger: BATCH-LABEL LEDGER block not found in Scheduler.tla")
block = match.group(0)

missing = sorted(label for label in labels if f"'{label}'" not in block)
if missing:
    for label in missing:
        print(
            f"spec-ledger: batch label '{label}' is not in the ledger block "
            f"(map it to an action or exclude it with a reason)"
        )
    sys.exit(1)

# Every label's ledger line must carry exactly one duplicate-semantics tag —
# the spec-side twin of the fault matrix's 'duplicate' column. A label whose
# replay semantics nobody classified is a label whose replay semantics
# nobody thought about.
TAGS = ("[cas-fenced]", "[receipt]", "[read]", "[setup]")
label_class: dict[str, str] = {}
for label in labels:
    line = next((ln for ln in block.splitlines() if f"'{label}'" in ln), "")
    stated = [t for t in TAGS if t in line]
    if len(stated) == 1:
        label_class[label] = stated[0]
untagged = sorted(labels - label_class.keys())
if untagged:
    for label in untagged:
        print(
            f"spec-ledger: label '{label}' has no (or ambiguous) duplicate-semantics "
            f"tag — exactly one of {', '.join(TAGS)} required on its ledger line"
        )
    sys.exit(1)
# Every modeled guard needs an EXECUTABLE twin (CLAUDE.md class rule): for
# each ledger line mapping a label to actions with [cas-fenced], every
# ACTION named must be claimed by a fenceTwin('Action') marker inside a
# test file — placed on the test that exercises that action's fence/guard
# refusal (zombie or replay gets zero rows / an error, never success).
# Per-ACTION, not per-label, is load-bearing: 'await-event' had a twin for
# its miss branch while the hit branch shipped an unfenced success read.
fenced_actions = set()
for ln in block.splitlines():
    m = re.search(r"'[a-zA-Z0-9:_-]+'\s*->\s*([A-Za-z0-9_/ ]+?)\s*\[cas-fenced\]", ln)
    if m:
        fenced_actions.update(a.strip() for a in m.group(1).split("/"))
tests = ""
for path in sorted(root.glob("packages/*/test/**/*.ts")):
    tests += path.read_text()
# The conformance suite's tests live in src/ (run via the per-store runner).
for path in sorted(root.glob("packages/conformance/src/**/*.ts")):
    tests += path.read_text()
marked = set(re.findall(r"fenceTwin\('([A-Za-z0-9_]+)'\)", tests))
untwinned = sorted(a for a in fenced_actions if a not in marked)
if untwinned:
    for action in untwinned:
        print(
            f"spec-ledger: fenced action '{action}' has no executable twin — "
            f"add fenceTwin('{action}') to the test that proves its "
            f"fence/guard refuses a stale or duplicate caller"
        )
    sys.exit(1)
stale_marks = sorted(m for m in marked if m not in fenced_actions)
if stale_marks:
    for mark in stale_marks:
        print(
            f"spec-ledger: fenceTwin('{mark}') marks an action that is not a "
            f"[cas-fenced] mapping in the ledger — remove or rename it"
        )
    sys.exit(1)

# The side models. scripts/tla.sh enrols a side model by the mutant list beside it,
# <Model>.mutants.json, and the same list enrols the model's ledger block here, so a
# model that is checked is a model whose mapping is read. A side block is held to what
# this script can see: its labels are the stores', its actions are the module's, and a
# class it states is the one the main ledger gives the label. No guard is read here.
#
# The block is line-oriented, so that nothing is guessed. LAYOUT is the whole rule, and
# a line that breaks it is answered with it.
LAYOUT = (
    "After `\\*`, one space is prose, three start an entry, and five or more continue it. "
    "An entry is `'label' ... -> Action / Action  [class]`, whole on its line, or "
    "`Action -- reason` for an action that no batch implements."
)
ACTION = r"[A-Z][A-Za-z0-9_]*"
ACTIONS = rf"{ACTION}(?: / {ACTION})*"
MAPPING = re.compile(rf"(?P<left>'[^'\s]+'.*?) -> (?P<actions>{ACTIONS})(?:  .*)?")
NO_BATCH = re.compile(rf"(?P<actions>{ACTIONS}) -- \S.*")
QUOTED = re.compile(r"'([^'\s]+)'")
BRACKETED = re.compile(r"\[[^\]\s]*\]")


def next_state_actions(module_text: str) -> set[str] | None:
    """The actions Next is a disjunction of, or None when it is anything else."""
    body = re.search(r"^Next ==(.*(?:\n .*)*)", module_text, re.M)
    if not body:
        return None
    flat = re.sub(r"\\\*.*", "", body.group(1))
    actions = set()
    for disjunct in re.sub(r"\\E[^:]*:", " ", flat).split("\\/"):
        named = re.fullmatch(rf"\s*({ACTION})(?:\([^()]*\))?\s*", disjunct)
        if named:
            actions.add(named.group(1))
        elif disjunct.strip():
            return None
    return actions or None


problems: list[str] = []
side_models: list[str] = []
for mutants in sorted((root / "specs").glob("*.mutants.json")):
    model = mutants.name.removesuffix(".mutants.json")
    module = root / "specs" / f"{model}.tla"
    if not module.is_file():
        problems.append(
            f"spec-ledger: specs/{mutants.name} enrols {model}.tla, which does not exist"
        )
        continue
    module_text = module.read_text()
    found = LEDGER_BLOCK.search(module_text)
    if not found:
        problems.append(
            f"spec-ledger: {model}.tla has no BATCH-LABEL LEDGER block, and scripts/tla.sh "
            f"checks the model (specs/{mutants.name} enrols it), so its mapping onto the "
            f"stores' batches must be written where this script reads it"
        )
        continue
    next_actions = next_state_actions(module_text)
    if next_actions is None:
        problems.append(
            f"spec-ledger: cannot read {model}.tla's next-state relation: Next must be a "
            f"disjunction of named actions, each under its quantifiers"
        )
        continue
    side_block = found.group(0)
    for token in sorted(set(QUOTED.findall(side_block)) - labels):
        problems.append(
            f"spec-ledger: {model}.tla's ledger block quotes '{token}', which is not a "
            f"batch label of any store (a label that was renamed or deleted leaves a "
            f"mapping that reads as current)"
        )
    mapped: set[str] = set()
    no_batch: set[str] = set()
    for line in side_block.splitlines()[1:]:
        shape = re.fullmatch(r"\\\*( *)(.*)", line)
        indent, body = (len(shape.group(1)), shape.group(2)) if shape else (0, line)
        if not body or indent == 1 or indent >= 5:
            continue  # a blank line, prose, or the continuation of an entry
        mapping = MAPPING.fullmatch(body) if indent == 3 else None
        unmapped = NO_BATCH.fullmatch(body) if indent == 3 else None
        if mapping:
            mapped.update(mapping["actions"].split(" / "))
            stated = BRACKETED.findall(body)
            if len(stated) > 1 or not set(stated) <= set(TAGS):
                problems.append(
                    f"spec-ledger: {model}.tla's ledger entry states {' '.join(stated)}: an "
                    f"entry states at most one duplicate-semantics class, one of "
                    f"{', '.join(TAGS)}\n    {line}"
                )
                continue
            for label in QUOTED.findall(mapping["left"]):
                if stated and label in label_class and label_class[label] != stated[0]:
                    problems.append(
                        f"spec-ledger: {model}.tla's ledger block gives '{label}' the class "
                        f"{stated[0]}, and Scheduler.tla's ledger gives it "
                        f"{label_class[label]}: the class is the label's, so the two must agree"
                    )
        elif unmapped:
            no_batch.update(unmapped["actions"].split(" / "))
        else:
            problems.append(
                f"spec-ledger: cannot read this line of {model}.tla's ledger block:\n"
                f"    {line}\n  {LAYOUT}"
            )
    named = mapped | no_batch
    for action in sorted(named - next_actions):
        problems.append(
            f"spec-ledger: {model}.tla's ledger block names action '{action}', which is not "
            f"an action of the module's next-state relation"
        )
    for action in sorted(next_actions - named):
        problems.append(
            f"spec-ledger: action '{action}' of {model}.tla's next-state relation is not in "
            f"its ledger block (map it from a batch label, or list it as having no batch, "
            f"with the reason)"
        )
    for action in sorted(mapped & no_batch):
        problems.append(
            f"spec-ledger: {model}.tla's ledger block maps action '{action}' from a batch "
            f"and also lists it as having no batch"
        )
    side_models.append(f"{model}.tla ({len(next_actions)} actions)")
if problems:
    print("\n".join(problems))
    sys.exit(1)

print(
    f"spec-ledger: all {len(labels)} batch labels accounted for and "
    f"duplicate-classified; all {len(fenced_actions)} fenced actions "
    f"have executable twins (block-scoped)"
)
if side_models:
    print(
        f"spec-ledger: side model blocks read: {', '.join(side_models)}; their labels "
        f"are the stores' and their actions are their modules'"
    )
