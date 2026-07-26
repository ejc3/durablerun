#!/usr/bin/env python3
"""A deferral must live in the PR that will do it, never under a DONE one.

PR3.6 recorded seven deferrals. Every one named no destination PR, no trigger
and no owner, and all seven sat under a heading marked DONE — the one section
a reader skips. That is not a deferral, it is a decision not to do the work,
written in the shape of a plan. Among them was the single mechanism that would
have closed the defect class recurring in every review round of that PR, so
the cost was not hypothetical.

The rule is therefore about PLACEMENT, which is mechanical: work parked under
a completed entry is orphaned, and work listed under a live PR entry is owned
by that PR — the containing entry IS the destination, so nothing needs to
repeat it.

Only work-item bullets count. Prose inside an entry frequently discusses
deferral (including this file's own rationale in BUILD.md), and a checker that
fires on text ABOUT the rule is the kind that gets weakened until it is quiet.

Historical ``postmortems/*-plan.md`` files are decision records, not a second
delivery ledger. They carry one exact, top-of-file banner declaring that their
status is frozen and BUILD.md alone owns current status. BUILD.md in turn may
not cite ``scratchpad/`` paths: those are intentionally transient and cannot
serve as auditable plan evidence.

Run by `pnpm verify`.
"""
import re
import sys
from pathlib import Path

# Optional [root]: grade a tree other than this script's own, so the BASE
# branch's copy can be run against a pull request (ci.yml `base-gate`).
ROOT = (
    Path(sys.argv[1])
    if len(sys.argv) > 1 and not sys.argv[1].startswith('-')
    else Path(__file__).resolve().parent.parent
)
BUILD = ROOT / "BUILD.md"
HISTORICAL_PLAN_BANNER = (
    "> **Historical decision record.** Status is frozen at decision time; "
    "`BUILD.md` is the sole current status owner."
)

# Work that is announced rather than described as shipped.
DEFERRED = re.compile(
    r"\b(deferr?(ed|al|s)?|still missing|not closed|to be done|left for|"
    r"postponed|belongs to a later|todo|requiring closure)\b",
    re.IGNORECASE,
)
EXCUSED = re.compile(r"\bABANDONED:", re.IGNORECASE)

ENTRY = re.compile(r"^[-*] \*\*(PR[\d.]+)\b")
BULLET = re.compile(r"^(?P<indent>\s*)[-*]\s+")
SCRATCHPAD_PATH = re.compile(r"(?<![\w.-])scratchpad/", re.IGNORECASE)

violations: list[str] = []
owner: tuple[str, bool] | None = None
build_lines = BUILD.read_text().splitlines()
for line in build_lines:
    entry = ENTRY.match(line)
    if entry:
        owner = (entry.group(1), "DONE" in line)
        continue

    bullet = BULLET.match(line)
    if not bullet:
        continue
    if not bullet.group("indent"):
        owner = None
    if not DEFERRED.search(line) or EXCUSED.search(line):
        continue
    if owner is None:
        violations.append(
            "BUILD.md: deferred work belongs to no PR entry:\n"
            f"    {line.strip()[:110]}\n"
            "  Every deferred work item must be nested under the live PR that owns it."
        )
        continue
    name, done = owner
    if done:
        violations.append(
            f"BUILD.md: {name} is DONE and still owns deferred work:\n"
            f"    {line.strip()[:110]}\n"
            f"  DONE is the section a reader skips, so anything parked here is\n"
            f"  dropped silently. Move it under the PR that will do it, or write\n"
            f"  'ABANDONED: <reason>' — an honest answer where silence is not."
        )

for line_number, line in enumerate(build_lines, start=1):
    if SCRATCHPAD_PATH.search(line):
        violations.append(
            "BUILD.md points at transient scratchpad state:\n"
            f"    line {line_number}: {line.strip()[:110]}\n"
            "  BUILD.md is the auditable delivery ledger; replace transient\n"
            "  scratchpad evidence with a checked-in artifact or acceptance criterion."
        )

postmortems = ROOT / "postmortems"
for plan in sorted(postmortems.glob("*-plan.md")):
    lines = plan.read_text().splitlines()
    if len(lines) < 3 or lines[2] != HISTORICAL_PLAN_BANNER:
        violations.append(
            f"{plan.relative_to(ROOT)}: historical plan does not declare BUILD.md "
            "as its sole current status owner:\n"
            f"  Put this canonical banner immediately below the title:\n"
            f"    {HISTORICAL_PLAN_BANNER}"
        )

for v in violations:
    print(v)
if violations:
    sys.exit(1)
print(
    "deferral-lint: clean — delivery status has one current owner and no "
    "deferred work is parked under a completed PR entry"
)
