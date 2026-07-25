#!/usr/bin/env python3
"""Eligibility fragments live in ONE file per dialect store (fragments.ts);
no other store source may write an eligibility comparison or a raw state
list. This is structural prevention: the claim once re-derived
task eligibility without the cancellation-deadline predicate, and no reader
noticed for many commits. A predicate that can only be spelled in one place
cannot drift. (schema.ts is definitional DDL and exempt.)"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
EXEMPT = {'fragments.ts', 'schema.ts'}
RULES = [
    (re.compile(r'cancel_at_ms\s*(<=|>=|<|>)'),
     'cancellation-deadline comparison outside fragments.ts (use cancelDue/cancelNotDue/eligibleTask)'),
    (re.compile(r"IN\s*\(\s*'(pending|running|sleeping|completed|failed|cancelled)'"),
     'raw state list outside fragments.ts (use ${LIVE} or a new shared fragment)'),
]

violations = 0
for store_dir in sorted(root.glob('packages/store-*/src')):
    for path in sorted(store_dir.rglob('*.ts')):
        if path.name in EXEMPT:
            continue
        for lineno, line in enumerate(path.read_text().splitlines(), 1):
            for pattern, message in RULES:
                if pattern.search(line):
                    print(f'{path.relative_to(root)}:{lineno}: {message}')
                    violations += 1
if violations:
    sys.exit(1)
print('fragment-lint: eligibility predicates confined to fragments.ts')
