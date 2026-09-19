# Postmortem: PR3.9f part 2 review (PR #59)

PR #59 builds `heartbeat` as two statement trees on every dialect and names, in
one checked list, the eight statements a store still sends as SQL text. Its
first version also narrowed `fragment-lint` and `clock-lint`: in a store file
that builds a `FencedBatch` they read only the characters between a raw batch
call's parentheses. It passed every local gate, including the unfiltered
mutation audit and the lints' own self-test. One full review then found
nothing wrong in the heartbeat rewrite or in the base gate's bridge, and found
that the narrowing had dropped two kinds of text that no tree rule reads. One
of the two was in the pull request's own body, written down as a cost the
maintainer had accepted, which nobody had. The narrowing is removed, and the
two lints are byte-identical to main's again. Four findings are counted.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

The worst finding is text that nothing read. `expire-lease-now` and
`driver-heartbeat` are sent as SQL text, and a store is free to write that text
in a constant above the call, as `expireLeaseNow` already does with two of its
locals. After the narrowing, a database clock call, a cancellation deadline
comparison or a raw state list written there was read by no lint and by no
tree. A raw clock call in a lease write breaks the rule that a batch has one
instant, and only the clock-jitter test of that one statement could have seen
it.

The second is the check the two lints were kept for. A cancellation deadline
compared by hand inside a fragment of a tree-built statement, with `<` where
the shared fragment says `<=`, is a second definition of "cancellation due".
Two doors then disagree at the boundary instant. The tree carries a fragment
as text and does not read a comparison written in it, so `fragment-lint` is
the only thing that refuses it, and the narrowing took that away from every
`store.ts`, each with about twenty hand-typed fragments.

The third misled a reader: BUILD.md's exit test said the two lints "scan
exactly that text", and they neither read only that text nor read all of it.

The fourth is a cost that was named as something smaller. A held heartbeat on
PostgreSQL is one more round trip, on every beat of every worker, and the pull
request called it one more statement.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | In a store file that builds a `FencedBatch`, the two text lints read only the characters between a raw batch call's parentheses, so SQL written in a constant and sent by a listed raw batch was read by nothing | A raw clock call, a deadline comparison or a raw state list in a lease write ships unseen | The lints' self-test, which gained bad cases for the narrowed view | Both new bad cases put the bad text inline, between the parentheses, which is the one place the view still read | The narrowing is deleted and the lints are main's, byte for byte (1, by deletion). Five fixture cases, and text planted in every real store source file (3) |
| 2 | A deadline comparison typed into a fragment of a tree-built statement passed both lints | A second definition of "cancellation due" ships, and two doors disagree at the boundary instant | The false negative the author wrote and ran, which found exactly this | It was recorded as an accepted cost, and two self-test good cases asserted it as correct behaviour. Nothing tells a cost its owner accepted from one an author wrote down | The same deletion (1). The two good cases are gone and their inputs are bad cases (3) |
| 3 | BUILD.md's exit test 3 said the two lints "scan exactly that text", false in both directions | A reader trusts a scope that does not exist | Review of the plan in the same diff | Nothing reads BUILD.md against the code | The sentence says what is true (none: prose) |
| 4 | A held heartbeat on PostgreSQL became four queries where it was three, and the pull request said "one more statement" | One more round trip on every beat of every worker, undisclosed as such | `round-trips.test.ts`, which pins the queries a store call sends | It measured only the batches a saga touches, and never a heartbeat | The test pins a held beat at four queries and a refused one at six (3) |

## Detection ledger

The branch had passed every local gate before the review read it: the
unfiltered audit at 862 of 862, conformance on three dialects, and the lints'
self-test at 200 bad inputs and 36 good ones. Every counted finding came from
the review. The author's own false-negative run did find the text of finding
2, and it is not credited here, because what it produced was a sentence
calling the loss accepted and not a fix or a question to the person who could
accept it.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #59: the built-in review skill as one subagent, and the reviewer's own probes with main as the control | 4 | No |
| This project's machinery: lints and their self-test, conformance, corpus, mutation probe, round-trip pins | 0 | Yes |

Self-catch rate: 0% (previous round: 0%).

Three rounds on this work at zero. Part 3c's round, part 1's and this one all
reviewed statements moving from text to trees. The first two found what sits
beside equivalence. This one found a gate loosened in the same diff that
claimed to keep it, and the machinery that checks a gate, its self-test, was
edited in that diff to agree with the loosening.

## Recurrence

**A proxy standing where a property fits. Recurred, and it is the class
AGENTS.md catalogues.** The property is which text a rule reads: every piece
of SQL that reaches no tree rule. The narrowing stood a position in for it:
text between a raw call's parentheses, in a file that constructs a
`FencedBatch`. That is the same defect as a self-test that found its subjects
by filename and a gate lint that counted a textual mention as execution. The
earlier mechanisms were each a fix to one proxy. None asks of a new scope
"is this the property or a picture of it", and this round adds no check that
does. It removes the one proxy.

**A cost of the tree path that no layer measured. Recurred.** Part 1's round
found that every read was rebuilt on each call, and held it with a test that
a second call compiles nothing. That holds one cost. `round-trips.test.ts`
holds another, for the batches a saga touches. A statement that went from one
query to two was covered by neither. Each mechanism holds the cost its round
met, and the class is wider than both.

**Spec or plan text made false by its own diff. Recurred in every recent
round.** PR #51's round, the sagas round, part 1's round and this one each
found it. No mechanism exists and this round adds none.

**A check's own test edited to agree with a weaker check.** I can find no
earlier round with this shape. The self-test exists so that a lint cannot
quietly stop refusing something, and it was changed in the same commit as the
lint, by two good cases that asserted the new silence. A self-test protects a
lint from every change but one that edits both.

## Mechanism audit — the false negative of each

Each row was written and run against the fixed code.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The two lints are main's again and read a store file whole | 1 for this defect, by deletion: there is no view left to narrow. The lints themselves are 2 and syntactic, a list of spellings | `liveTask: sqlFragment(`t.state IN ${LIVE} AND r.claim_expires_at_ms < ${NOW}`)` in the libSQL store passes `fragment-lint` and `clock-lint`, here and on main. Ran. The lint has a rule for `cancel_at_ms` and none for a lease deadline, and it never had one |
| Five fixture bad cases: a constant sent by a listed raw batch, and a fragment typed in place | 3 | Both lints patched to skip any file that holds three or more `new FencedBatch(`. The whole self-test passed, 205 bad inputs and 34 good, and both lints then accepted the reviewer's constant in the real libSQL store. Ran. Every fixture builds at most one batch and each real `store.ts` builds 27, so a narrowing keyed on anything the fixtures lack passes them. This false negative is why the next row exists |
| Text planted in every real store source file, at its end and in its first typed fragment | 3 | `fragment-lint` patched to blank every typed fragment of a file but the first. The whole self-test passed, 254 bad inputs. The patched lint accepted `t.cancel_at_ms < 5 AND` planted in the second typed fragment of the libSQL `store.ts`, and the real lint refused it at that line. Ran. The planted positions are two for each file, and a lint can lose any other |
| A held heartbeat is pinned at four queries and a refused one at six | 3 | The PostgreSQL executor patched to send one more `SELECT 1` in every batch labelled `claim`. It typechecks, and `round-trips.test.ts` passes. Ran. The test sends claims and measures none of them: it pins the calls someone thought to list |

Finding 3 has no mechanism, so it has no row.

## Fix-induced defects

None found. The fixes were not reviewed as new code: this pull request has no
second review unless the fold changes what the product does, and it does not.
They were re-tested, the reviewer's three probes were run again against them
with main as the control, and each mechanism's false negative was run. One
slip inside the fold was caught before its commit: removing the corpus
descriptor's dead arm left a variable unused, and the typecheck refused it.

## Evidence

- Red test: commit `b0ba8a4`, run and seen failing (5 cases) against
  `3a7024c`, the reviewed head as it stands on this branch. Each failure reads
  "ACCEPTED a bad input". Three give the reason "text a listed raw batch sends
  is read wherever in the file it is written", one "no tree rule reads a
  comparison typed into a fragment, so this lint must", and one "a clock call
  typed into a fragment is refused at build time, before any test builds the
  statement".
- Fixes: commit `fbb290c` deletes the narrowing (findings 1 and 2), `a37a3e1`
  pins the heartbeat's queries (finding 4), `5b792c4` plants text in the real
  store files, and `73bf84d` corrects BUILD.md and DESIGN.md (finding 3). The
  narrowing came in with `93af076`. Gate after the fixes: the lints' self-test
  in full at 254 bad inputs and 34 good, core, the SDK and driver suites, the
  three store suites, conformance on three dialects, the probe's self-test and
  the unfiltered audit at 873 mutations, and the base gate with the arm live,
  each at exit 0. The pull request's body carries the gate table.
- Finder: the one full review of PR #59. Its verdict: "The narrowing went
  further than "text that reaches no tree", in two ways. The author disclosed
  only one of them." and "Nothing is wrong with the heartbeat rewrite or the
  base gate's bridge arm."
- The reviewer's probes, run again on the fixed code with main as the control.
  A constant holding a clock call, a deadline comparison and a raw state list,
  sent by a listed raw batch: `fragment-lint` and `clock-lint` exit 1 on both,
  where the reviewed head exited 0. A deadline comparison, a raw state list
  and a raw clock call typed into a tree fragment: refused on both. The same
  three typed into heartbeat's own fragment: refused.
- Measured against main, counted at the client: a held heartbeat on
  PostgreSQL is `BEGIN`, the update, the gated read and `COMMIT`, four queries
  where main sends three, and a refused beat is six on both. Over loopback to
  a local PostgreSQL 17, 300 held beats in three rounds, two alternating
  passes, under a load average near 27: 0.79 to 0.92 milliseconds a beat on
  main and 1.33 to 1.54 here. The difference holds the round trip and the
  cost of building two trees, which were not separated.
- Every finding was checked before it was folded, and none was refuted. Seven
  of the review's eleven items are not counted. Four were fixed as small
  items: no mutation named the new test, a stale comment and a dead arm in the
  corpus descriptor, the source analyzer started by each lint, and a list
  entry that died with a bare KeyError. Three are listed in the pull request's
  body with a reason each: the list is checked by label and not by statement,
  the fake clock's column is one spelling, and a test recorder resembles
  another.
- What did not reproduce. The review ran a lease deadline compared in a
  fragment and found that neither lint has ever refused it, on main or here,
  so that half of the premise "the lints see hand-written deadlines" was never
  true. The review skill said the body had no `gate-changes:` entry for the
  lints, and the reviewer refuted it: the entry was there. The review did not
  reproduce its eleventh item.

## Root cause

A gate was loosened and its own test was edited to match, in one commit, by
one author, and every layer that ran afterwards took the edited test as the
definition of correct. The self-test guards a lint against a change that
forgets a rule. It cannot guard against a change that decides a rule no
longer applies, because such a change rewrites the expectation with the rule.
The one check that did see the loss, the false negative the postmortem
discipline demands, worked: it was written, run, and it found finding 2 before
the review did. What failed is what happened next. A loss that only the
maintainer could accept was written into the body as accepted, and nothing in
the process distinguishes that sentence from a true one.

## Mechanisms

Built in this PR:

- The narrowing is deleted, rung 1 for this defect: `fragment-lint.py`,
  `clock-lint.py` and `source_lex.py` are main's files, so there is no scope
  left to get wrong. Their `gate-changes:` entry is gone with it.
- Five bad cases in `scripts/lint-selftest.py` for text a listed raw batch
  sends from a constant and for a fragment typed in place, rung 3. The two
  good cases that asserted the opposite are deleted.
- Text planted in every real store source file, rung 3, in the same script: a
  constant at the file's end, and a comparison in its first typed fragment,
  for each of the two lints. It exists because the fixture cases' false
  negative was run and was real.
- `round-trips.test.ts` pins a heartbeat's queries, held and refused, rung 3.

Deferred (recorded in BUILD.md):

- None. A rule that a `gate-changes:` entry which loosens a gate names who
  accepted it would be a process instruction, which the prevention ladder does
  not count, and no mechanical form of it is known.

## What this round still would not catch

- A lint that loses text anywhere but a file's end and its first typed
  fragment ships today, past every fixture and every planted case.
- A lease deadline compared by hand in a fragment ships today, as it always
  could: `fragment-lint` has a rule for the cancellation deadline alone.
- A round trip added to a batch that `round-trips.test.ts` sends and does not
  measure ships today.
- A second raw batch that reuses a listed label passes the list's test, on
  main too. The lints still read its text, and `batch-lint` still holds its
  shape.
- A read of the fake clock's row by any spelling but the column's name passes
  the tree's scan and the lint.
- A loss written into a pull request's body as accepted, by someone who
  cannot accept it, ships today. Only a reader catches it.
- A self-test edited in the same commit as the check it guards, to agree with
  a weaker check, ships today.
- A sentence in BUILD.md or DESIGN.md that its own diff makes false ships
  today, as in every recent round.
