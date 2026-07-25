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
rule file is referenced by both configs, every reference resolves to a file,
and every scope matches something that exists.

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


def tracked(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files"], capture_output=True, text=True, check=False
    )
    return out.stdout.splitlines()


def main() -> int:
    problems: list[str] = []

    if not RULES_DIR.is_dir():
        print(f"review-bot-lint: no {RULES_DIR.relative_to(ROOT)} — nothing to check")
        return 0

    files = sorted(p for p in RULES_DIR.glob("*.md") if p.name != "README.md")
    stems = {p.stem for p in files}

    if not files:
        problems.append(
            f"{RULES_DIR.relative_to(ROOT)} exists but holds no rules. An empty corpus makes "
            f"every check below vacuous."
        )

    # 1. Each rule file has the sections that make it applicable to a diff.
    for p in files:
        body = p.read_text()
        for marker, what in REQUIRED:
            if marker not in body:
                problems.append(
                    f"{p.relative_to(ROOT)} has no {what!r} section (looked for {marker!r}). "
                    f"A rule missing it is prose, and a reviewer will apply it as taste."
                )
        if "\n- " not in body.split("Report a failure when", 1)[-1][:4000]:
            problems.append(
                f"{p.relative_to(ROOT)} lists no failure shapes as bullets. A shape a reviewer "
                f"cannot decide from a diff generates noise that buries real findings."
            )

    # 2. Both hosted reviewers must actually reference every rule. A rule
    #    neither config mentions is one no reviewer will ever apply.
    cr_text = CODERABBIT.read_text() if CODERABBIT.exists() else ""
    if not cr_text:
        problems.append(".coderabbit.yaml is missing — CodeRabbit would review with no rules at all.")

    gp_ids: set[str] = set()
    gp_scopes: dict[str, list[str]] = {}
    if GREPTILE.exists():
        try:
            cfg = json.loads(GREPTILE.read_text())
        except json.JSONDecodeError as e:
            problems.append(f".greptile/config.json does not parse: {e}")
            cfg = {}
        for entry in cfg.get("rules", []):
            gp_ids.add(entry.get("id", ""))
            gp_scopes[entry.get("id", "")] = entry.get("scope", [])
        if cfg.get("statusCheck") is not True:
            problems.append(
                '.greptile/config.json does not set "statusCheck": true, so Greptile posts no '
                "status and its findings cannot gate anything."
            )
    else:
        problems.append(".greptile/config.json is missing — Greptile would review with no rules.")

    for p in files:
        rel = f".github/review-bot-rules/{p.name}"
        if rel not in cr_text:
            problems.append(
                f"{rel} is not referenced by .coderabbit.yaml, so CodeRabbit never applies it."
            )
        if rule_id(p.stem) not in gp_ids:
            problems.append(
                f"{rel} has no rule with id {rule_id(p.stem)!r} in .greptile/config.json, so "
                f"Greptile never applies it."
            )

    # 3. And the reverse: a config naming a rule that does not exist points the
    #    reviewer at nothing, silently.
    for rid in sorted(gp_ids):
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
    paths = tracked(ROOT)
    if paths:
        for rid, globs in sorted(gp_scopes.items()):
            for g in globs:
                pat = re.escape(g).replace(r"\*\*/", "(?:.*/)?").replace(r"\*\*", ".*").replace(r"\*", "[^/]*")
                if not any(re.fullmatch(pat, f) for f in paths):
                    problems.append(
                        f"rule {rid!r} is scoped to {g!r}, which matches no tracked file. "
                        f"It will grade an empty set and report clean forever."
                    )

    # 5. The README is the human index; drift there is how a rule becomes
    #    invisible to the person deciding whether one already covers a class.
    readme = RULES_DIR / "README.md"
    if readme.exists():
        text = readme.read_text()
        for p in files:
            if p.name not in text:
                problems.append(f"{p.name} is not listed in {readme.relative_to(ROOT)}.")
        for named in re.findall(r"`([\w.-]+\.md)`", text):
            if named != "README.md" and named[:-3] not in stems:
                problems.append(
                    f"{readme.relative_to(ROOT)} lists {named}, which no longer exists."
                )

    if problems:
        print("review-bot-lint: the rule corpus and the bots disagree\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}\n", file=sys.stderr)
        return 1

    print(
        f"review-bot-lint: clean — {len(files)} rules, each referenced by CodeRabbit and Greptile, "
        f"every scope matching tracked files"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
