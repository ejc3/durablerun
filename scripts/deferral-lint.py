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

Only sub-bullets count. Prose inside an entry frequently discusses deferral
(including this file's own rationale in BUILD.md), and a checker that fires on
text ABOUT the rule is the kind that gets weakened until it is quiet.

Run by `pnpm verify`.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "BUILD.md"

# Work that is announced rather than described as shipped.
DEFERRED = re.compile(
    r"\b(deferr?(ed|al|s)?|still missing|not closed|to be done|left for|"
    r"postponed|belongs to a later)\b",
    re.IGNORECASE,
)
EXCUSED = re.compile(r"\bABANDONED:", re.IGNORECASE)

lines = BUILD.read_text().splitlines()

starts = [i for i, l in enumerate(lines) if re.match(r"^- \*\*PR[\d.]+", l)]
violations: list[str] = []
for n, i in enumerate(starts):
    end = starts[n + 1] if n + 1 < len(starts) else len(lines)
    name = re.match(r"^- \*\*(PR[\d.]+)", lines[i]).group(1)
    if "DONE" not in lines[i]:
        continue
    # Sub-bullets only: these are the items, not the narration.
    for l in lines[i:end]:
        if not re.match(r"^\s+- ", l):
            continue
        if DEFERRED.search(l) and not EXCUSED.search(l):
            violations.append(
                f"BUILD.md: {name} is DONE and still owns deferred work:\n"
                f"    {l.strip()[:110]}\n"
                f"  DONE is the section a reader skips, so anything parked here is\n"
                f"  dropped silently. Move it under the PR that will do it, or write\n"
                f"  'ABANDONED: <reason>' — an honest answer where silence is not."
            )

for v in violations:
    print(v)
if violations:
    sys.exit(1)
print(f"deferral-lint: clean — no deferred work parked under a completed PR entry")
