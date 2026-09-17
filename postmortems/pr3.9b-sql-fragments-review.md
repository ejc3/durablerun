# Postmortem: PR3.9b SQL fragments in statement trees, review rounds 1 and 2 (PR #38)

PR3.9b moves claim, activation, and the launch deferral onto shared statement trees. A dialect's predicates reach those trees as SQL fragments: store-owned text plus binds, which core turns into nodes. One Fable `/code-review` round and one Fable `/simplify` round found three defects in that fragment mechanism. A fragment compiled without parentheses, so an OR inside it could void every conjunct before it. A bind or clock token inside a string literal was split as if it were SQL. And a statement declared its fragments as two counts, which a fragment could move between unnoticed and which counted raw nodes the builder makes for itself. Our own gates caught two more defects before merge: four generated mutations whose text had moved, and a fragment check that built a `Map` task code can replace. A second `/code-review` round, over round one's fixes, then found six more: five in those fixes, and one older line on the worker path. No shipped fragment used any of these shapes. All eleven are fixed.

**This document is adversarial toward the MACHINERY and blameless toward people.**

## Severity

Nothing wrote a wrong row: every fragment the stores ship is parenthesized and holds no token in a literal. The severity is what the next three PRs inherit, because they add a fragment to almost every remaining statement.

- **An OR that voids the fence (worst).** `… AND activated_gen < ? AND lease_ms < ? OR lease_ms IS NULL` binds as `(… all the receipt conjuncts …) OR lease_ms IS NULL`. A row matching the last arm is written whatever its run id, token, and generation say. On a follow-on a losing invocation writes unfenced rows, while the gating rule still reports the statement gated. The text path refuses a top-level OR.
- **A token inside a literal.** `failure_reason <> 'at $NOW$'` spliced the clock's SQL inside the quotes, and a `?` in a literal consumed a bind. The failure is a syntax or bind error on the branch that runs it, reported as a store outage. The text path refuses a token inside a literal.
- **Counts that are not positions.** A fenced tail with `ORDER BY … DESC` was refused until it declared a fragment it does not hold, because the builder stores the direction as a raw node. The claim's candidate subquery was declared a value although it alone decides which rows are written, and a fragment moving from an assigned value to an IN operand changed neither count.
- **Found in round one's fixes.** A raw subquery under NOT IN was accepted only as a value, which wrapped it in a second pair of parentheses. SQLite then compares with one scalar and returns wrong rows silently. The JSON `?` operators compiled to a placeholder no argument binds, after the count check that caught that was removed. A comment or a dollar-quoted string flipped the literal scanner's quote parity, so a clock token inside a real literal was spliced.
- **Caught by our gates.** At `4e2e24d` four generated timestamp-addition mutations matched nothing, so `verify`, `mutations`, and `base-gate` failed in CI. At `fbe223c` a task that replaces the global `Map` made the next pass throw instead of completing, and two SDK tests failed.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A fragment compiled with no parentheses, so an OR inside a boolean fragment voids every conjunct before it | A row outside the receipt or the fence is written, and the gating rule still reports the statement gated | The tree statement tests, and the fence review-bot rule | The fragment test expected the unparenthesized SQL, and the rule's scope named only `fenced-batch.ts` | `rawSql` wraps every predicate and value in a parentheses node (rung 1). The rule's scope and its splice shape now cover `sql-tree.ts` and the shared statements |
| 2 | A `?` or clock token inside a fragment's string literal was split as a bind or spliced clock SQL | A syntax or bind error at run time, reported as a store outage | `rawSql` | It splits text without reading SQL, and the text path's literal check was not carried over | `rawSql` refuses a fragment whose single-quoted literal holds a bind or the clock token (rung 2, a text scan of the one thing a tree cannot read) |
| 3 | Fragments were declared as two counts, boolean and other | A legal tail with ORDER BY is refused, and a fragment can decide rows while declared a value | `addTree`'s declaration check | A count carries no position, and it counted raw nodes the builder makes for itself | `rawSql` takes the fragment's role, and the batch reads each raw node's position from the tree and refuses a mismatch or an unminted node (rung 1 for minting, rung 2 for position) |
| 4 | Four generated mutations owned SQL text that had moved into core nodes | `verify`, `mutations`, and `base-gate` fail. Nothing merges | The registry self-test, which did catch it, in CI | My pre-push check parsed registry tuples itself and could not see generated cases | None new: the gate worked, at the cost of one CI round. The lease deadline stays store-owned text, so those mutations keep owning it |
| 6 | A raw subquery under NOT IN was refused as a subquery and accepted as a value, so it compiled inside a second pair of parentheses (round 2) | SQLite compares with one scalar and returns wrong rows silently | The fragment role tests | The position logic listed IN and EXISTS, and the tests placed a subquery only under IN | A subquery position is the operand of IN, NOT IN, or EXISTS (rung 2) |
| 7 | Only the root WHERE chain counted as a predicate position (round 2) | A predicate in HAVING, ON, or a CASE condition is refused, and a value may stand as a whole HAVING boolean | The fragment role tests | Every test placed its predicate in a root WHERE | A predicate is the boolean of any WHERE, HAVING, ON, or CASE condition, at any depth (rung 2) |
| 8 | The JSON `?` operators compile to a placeholder no argument binds, and the count check that refused this was removed with the declared counts (round 2) | A deterministic bad statement reaches the driver and is retried as a store outage | `addTree` | Round one reasoned that every `?` comes from `rawSql`, which holds for fragments and not for operators or identifiers built from nodes | The compiled placeholder count is checked again (rung 2) |
| 9 | A comment, a dollar-quoted string, or a prefixed string flips the literal scanner's quote parity (round 2) | A clock token inside a real literal is spliced, silently | `rawSql`'s literal scan | It knew single-quoted literals only, and its tests held no comment or other string form | A fragment with a comment, a dollar-quoted string, or a prefixed string is refused (rung 2, a text scan) |
| 10 | One fragment node placed twice was judged once, by its first position (round 2) | A predicate node reused as an assigned value passes | The role check | It looked a node up, not an occurrence | A fragment node may stand in one place (rung 2) |
| 11 | The generated follow-on constructs a `Set` on every call, on the path a worker pass reaches after task code. The line predates this PR (round 2) | A task that replaces the global `Set` makes `complete` throw instead of completing | The SDK's ambient-global tests | They replace `Map`, and nothing replaced `Set` | The column set is built with a `Set` captured at module load (rung 1 for that site), and a core test builds a generated follow-on while `Set` throws (rung 3) |
| 5 | The role check built a `Map` on every tree statement | After a task replaces the global `Map`, the next pass throws instead of completing | The SDK's ambient-global tests, which did catch it | Nothing nearer the tree checks ran them under a replaced global | The checks keep positions in arrays and minted nodes in weak sets captured at module load (rung 1 for those sites). A core test adds and compiles tree statements while `Map` throws (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| CI `verify`, `mutations`, and `base-gate`, reproduced with the registry self-test | 1 | yes |
| The SDK's ambient-global tests, run before push | 1 | yes |
| Fable `/code-review` round 1 over `65000b2...4e2e24d` and `b0b152c` | 3 | no |
| Fable `/simplify` round 1 over `65000b2...4e2e24d` | 0 | no |
| Fable `/code-review` round 2 over `b0b152c...e975c19` | 6 | no |

Self-catch rate: 2 of 11, or 18% (previous round: 0%, `pr3.9a-statement-trees-review.md`).

`/simplify` independently described finding 3's cause, that the second count is a residual with no position, so it is credited there in prose and counted once. Both self-catches were gates doing their job late: finding 4 cost a CI round that a local run of the same self-test would have saved, and finding 5 was caught before push.

## Recurrence

- **Text spliced into a boolean position without parentheses recurred.** The fence review-bot rule already names it as an earlier finding in `fenced-batch.ts`, where `derived()` brackets a caller's `where` and `narrow`. That mechanism bracketed one splice point. `rawSql` is a second splice point in a new file, outside the rule's scope, so nothing connected the two. The parentheses are now part of how a fragment becomes a node, so there is no unbracketed way to place one.
- **A text-path check not carried to the tree path recurred, for the second PR running.** `pr3.9a-statement-trees-review.md` found the missing placeholder count, and here the missing literal check. Porting check by check leaves whichever check nobody remembered. The Mechanisms section now lists every check the text path makes beside its tree twin, so the next gap is a missing row, not a missing memory.
- **A proxy where a property fits recurred.** AGENTS.md's catalogue is this class: a count of fragments stood in for where each fragment stands. The count itself was this PR's answer to a residual the previous postmortem recorded, a raw fragment outside a boolean position being uncounted. It answered with a bigger count instead of a position.

- **Defects introduced by fixes recurred, for the third PR running.** `pr3.11c-store-answers-review.md` found five of its eight defects in its first fix, and `pr3.9a-statement-trees-review.md` found one. Here four of eleven came from round one's fixes. The mechanism that exists for this is reviewing a fold as new code, which is how round two found them. What it costs is a second review round on every PR whose first round changes a mechanism.

## Mechanism audit — the false negative of each

Every exhibit below was run against the fixed code, beside a control the same run refused: a fragment declared a value standing as a predicate.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| A fragment's declared role checked against its position | 2 | The role says where a fragment stands, not what it says. Run: a follow-on with `rawSql('1 = 1', 'predicate')` is ACCEPTED. The deferral's use of the shared admission now has a mutation for exactly this swap, and other fragments rely on the corpus and review |
| The subquery group check | 2 | One balanced group with any content. Run: `(SELECT task_id FROM tasks)`, which no fence gates, is ACCEPTED as an IN operand beside a gated conjunct |
| The string literal scan | 2, a text scan | Quoting other than single quotes. Run: `"odd?name" = 1` with one argument supplied is ACCEPTED and compiles to `("odd?name" = 1)` with a bind the driver cannot place, which fails at run time |
| Parentheses around a predicate or value | 1 | None found. There is no call that places a fragment without them, and a subquery is checked to be one group of its own |
| Minted nodes only | 1 | None found for statements. `isBuilderRaw` admits one builder-made shape, an ORDER BY direction of `asc` or `desc` with no parameters |
| Predicate positions in every boolean clause | 2 | A value that is only part of a boolean. Run: a value fragment as the left operand of a WHERE comparison, `(SELECT 1) = 1`, is ACCEPTED, beside a control that refuses a value standing as a whole HAVING boolean |
| Refusing comments and non-plain string forms | 2, a text scan | Quoting the scanner still does not read, as in the row above for a double-quoted identifier |
| The restored placeholder count | 2 | None found. It compares the compiled SQL with the arguments, whatever produced them |
| One place per fragment node | 2 | None found for a node. Two nodes minted from one fragment may still take different roles, which the deferral's wake instant does on purpose |
| Collections captured at module load | 1 for those sites | A prototype method task code patches. The review ran it: with `Array.prototype.includes` patched to return true, a RETURNING statement passes the grammar. The checks guard the engine's own statements at construction, not against hostile task code |

## Fix-induced defects

Four. Findings 8, 9, and 10 were introduced by round one's fixes in `ac0c9dc`, and round two found them by reviewing that fold as new code. Finding 6 was latent in round one's position logic. Finding 5 was introduced by the fix for finding 3: the position check kept its positions in a `Map`. The SDK's ambient-global tests caught it before push. Finding 3 was itself this PR's answer to a residual recorded in the previous postmortem.

## Evidence

- Red tests: commit `30c7248`, run and seen failing (3 of 20 tests) against `b0b152c`:
  - the unparenthesized OR;
  - the token inside a literal;
  - the fenced tail with ORDER BY refused.
- Fix: commit `ac0c9dc`.
- Red tests: commit `98f03e6`, run and seen failing (7 of 29 tests) against `e975c19`: the NOT IN subquery, the predicate in HAVING, the JSON `?` operator, the comment and string forms, the node placed twice, the fragment never placed, and the generated follow-on under a throwing `Set`.
- Fix: commit `5792924`.
- Finding 4's red was CI at `4e2e24d`: `verify`, `mutations`, and `base-gate` all failed, and `pnpm lint:mutation-verdicts` reproduced it locally with "mutation pattern occurs 0 times" for the four names. Fix: commit `b0b152c`, after which the self-test and a local base-gate reproduction pass.
- Finding 5's red was two SDK tests failing at `fbe223c`: "task initialization cannot replace replay map construction" and "uses stored Map entries under subclass and prototype pollution". Fix: commit `e975c19`.
- Gate after `5792924`: typecheck, Biome lint and format, and the determinism, user boundary, ledger, fragment, batch, clock, outcome, deferral, gate, and review-bot lints pass. Core, SDK, driver, harness, and dogfood tests pass (46 files, 472 tests), and store and non-fuzz conformance tests pass on libSQL and PostgreSQL (38 files, 6,338 tests). The registry self-test passes with 439 live mutations, and a local reproduction of base-gate passes.
- Gate after `e975c19`: typecheck, Biome lint and format, and the determinism, user boundary, ledger, fragment, batch, clock, outcome, deferral, gate, and review-bot lints pass. Core, SDK, driver, harness, and dogfood tests pass (46 files, 465 tests), and store and non-fuzz conformance tests pass on libSQL and PostgreSQL (38 files, 6,338 tests). The registry self-test passes with 439 live mutations, and a local reproduction of base-gate passes.
- Finders: Fable `/code-review` rounds 1 and 2, and Fable `/simplify` round 1. Quoted verdicts:
  - "`rawSql` emits the fragment with no parentheses, and the tree path has no top-level-OR check";
  - "It splits fragment text on every `?` and `$NOW$` without parsing SQL";
  - "`rawValues = rawFragmentCount(tree) - rawBooleans` counts nodes the store did not write";
  - "`rawValues` is every raw fragment that is not a boolean, so it carries no position";
  - "`requiredSubquery` recognizes only `exists` and `in`. Under the `not in` operator a raw subquery is refused as `'subquery'` and accepted only as `'value'`";
  - "with the placeholder-count check removed, 'placeholders equal arguments by construction' is false for Kysely's `?`, `?|`, and `?&` operators";
  - "`stringLiterals` and `isOneGroup` know only single-quoted literals. An apostrophe in a comment, a PostgreSQL `E'…'` string, or a dollar-quoted string flips their quote parity".
- Measured, not assumed:
  - Building the admission fragment per call costs 11.2 µs, against 4.4 µs hoisted, so the hoisting finding was declined.
  - Round two measured minting a 12 KB fragment at 68 to 109 µs. A fragment's text is now validated and split once per role and text: minting that fragment went from 97 µs to 22 µs, and building and compiling a claim from 492 µs to 434 µs.
  - Deleting one conjunct from the PostgreSQL copy of the shared admission fails the PostgreSQL corpus test while libSQL's passes, so the corpus does hold the two copies together.
- Checked clean by the review: every guard of the old claim, activation, and deferral SQL is in the new, bind order matches, and the deferral's dropped attempt bound is still enforced by the shared accounting guard.

## Root cause

A fragment is the one place a statement tree still holds text, and the first version treated that text as finished SQL to be placed, not as input to be bounded. So the properties a tree gives everything else, position and precedence, stopped at the fragment's edge. The count was the same mistake one level up: it described how many fragments there were, not where each one stood.

## Mechanisms

Built in this PR:

- `rawSql(fragment, role)`: a fragment's binds and clock become nodes, a predicate or value is wrapped in a parentheses node, a subquery must be one group, a token in a literal is refused, and the raw node is minted with its role (rung 1 and rung 2).
- `rawFragmentProblem`: every raw node must be minted, stand in one place, and have its role be its position in the tree, across every boolean clause (rung 1 for minting, rung 2 for position).
- A statement must place every fragment it takes, and the compiled placeholder count is checked again.
- One `whereClaimReceipt` for activation and the deferral, and a mutation that owns the deferral's use of the shared admission.
- Tree checks that construct no ambient collection at call time, with a core test under a throwing `Map`.
- The text path's checks beside their tree twins, so a missing port is a missing row:

| Text path check | Tree path twin |
|---|---|
| Every fence token names a stamped statement of the batch | The same, from the fences the one tree walk reports |
| A stamping statement writes the stamp and an instant | Read from the table the tree writes |
| A tail is a SELECT | The root node's kind |
| A positive fence in the WHERE clause, and no top-level OR | A gating conjunct by position, and parentheses around every fragment |
| No clock outside a compare-and-set | The clock token, clock function nodes, and the fragment text scan |
| No token inside a string literal | `rawSql`'s literal scan |
| No blind counter in a follow-on | Counting assignments over every arithmetic operator and fragment mentions |
| Placeholders equal arguments, and no undefined bind | By construction in `rawSql`, and `defineStatement`'s bind check |

Deferred (recorded in BUILD.md):

- Tree-path successors for the thirty text-path mutations, under PR3.9e. Until then the tree checks are held by their paired tests, not by mutations.

## What this round still would not catch

- A fragment whose content is wrong for its role, such as a predicate that admits every row, outside the one swap that now has a mutation.
- A subquery fragment that selects rows no fence gates.
- A `?` inside a double-quoted identifier or a dialect's other quoting, which fails at run time, not at construction.
- A value fragment that is one operand of a WHERE comparison, which decides rows while declared a value.
- Task code that patches a prototype method the checks call, such as `Array.prototype.includes`.
