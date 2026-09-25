# Postmortem: PR5.3a, the read-only operator CLI (its review and the narrow re-review of the fold)

PR5.3a adds `packages/cli`, a CLI that opens a store directly from `DURABLERUN_STORE_URL` and runs `doctor`, `migrate`, `result` and `checkpoints` over the ports that exist. One review of the first head found 13 defects, one of them HIGH: a store URL that did not parse crashed the CLI, and Node printed the URL with its database password. The fold fixed all 13. A narrow re-review of the fold found six more, two of them HIGH and both the same leak in a new shape: a password holding an @ and then a # / or ? still printed, through the `--target` message, through a driver's error with `--reveal`, and through mysql2's console warning without it. The verdict: 17 of the 19 count by the repo's rule, every one was found by outside review, and the credential leak survived one round of fixes because the first fold's refusal and its sweep were both pictures of the property, not the property.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

A database credential is full admin: it bypasses the hosted authorization port, and the rows it reaches hold params, checkpoints and event payloads in plaintext. The worst finding is the re-review's first: with the fold's head, `postgres://admin:x@SECRET#y@db.example.io/app` made `migrate --target elsewhere --yes` print SECRET in its mismatch message, made every read print `getaddrinfo ENOTFOUND SECRET` with `--reveal`, and sent a name lookup for the password's fragment before any command failed. The second, `mysql://root:a@b?SECRET@db.example.io/app`, printed SECRET on stderr for `doctor`, `result` and `checkpoints` with no flag at all, because mysql2 writes a warning to the console for a query key it does not know. Before the first fold, a typo in a password (a # or a space) printed the whole URL on every command. Nothing had shipped: the CLI is private and unreleased, and every finding was caught before the pull request merged. The other findings are false claims in DESIGN.md and in the exit table (exit 6 called safe to repeat while a wrong credential exits 6 on every repeat), a fault surface whose declared entry was never met, and operator facing messages and notes that were wrong for the case they printed on.

## Findings

Findings 1 to 13 are the review of the first head, and 14 to 19 the narrow re-review of the fold, numbered as the reviews listed them. Two count 0 and are not in the table. Finding 12: the alpha.1 harness skipped in CI when a download failed, a CI setting of tooling only, whose harness its own planted control shows can fail; CI now requires it. Finding 16: the coordinator's shared wording says both crashes exit 6, while crash after at the bootstrap and at a version write ends 0 because core's migrate reads the version again; this branch's table and DESIGN.md say that exception, and the shared text, which PR5.0 writes into BUILD.md, is the coordinator's to amend.

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | A server URL that does not parse made `main` throw, and Node printed the `TypeError` whose `input` is the whole URL (HIGH) | The database password on stderr, exit 1, on every command | The redaction test of exit line 33 | It planted values in rows, never a credential in the URL, and ran only URLs that parse | A credential sweep over every verb and flag; every parse maps to a `StoreUrlError` that quotes nothing; the bin's last catch prints only a name (rung 3) |
| 2 | The CLI read a `file:` URL's path differently from the libSQL client: not percent decoded, cut at ? only (MEDIUM) | A read could create a database, or refuse one that exists | The read guard's cases | They named files whose names need no encoding | The CLI reads the path with store-libsql's own `fileUrlPath` (rung 1, one definition) and a case per encoded character (rung 3) |
| 3 | The fault surface met only the labels one clean run sends from one starting state; the bootstrap's `faultsAt` entry was declared and never met, and DESIGN's rule (the state before, or the no fault state) was false across several versions (MEDIUM) | A declared exit no test held, and a rule no run could satisfy | The fault surface's own closure | It checked that sent labels are declared, not that declared labels are sent | Three starting states and a check that every declared label and `faultsAt` entry is sent from one (rung 3) |
| 4 | Exit 4 could not happen, a wrong credential exits 6, and the table and DESIGN called 6 safe to repeat (MEDIUM) | A caller retries a bad credential forever | The exit table test | It holds DESIGN and `exit.ts` equal to each other, not to what the executors raise | The table says 4 is reserved and that retries of 6 are capped, and a server case holds a wrong password to exit 6 (rung 3) |
| 5 | DESIGN said a read changes nothing, and opening a libSQL file switches a rollback journal file to WAL (LOW) | A false claim | The batch recording spy | A pragma is sent at open, not as a batch | DESIGN says it (text) |
| 6 | Only the opener imports a store was held by biome's rule, which matches spellings, so a relative import passed (LOW) | A proxy standing in for the boundary | The lint | It reads the specifier's text | A test resolves every import as the compiler does (rung 2) |
| 7 | The version 10 warning was libSQL advice and printed on PostgreSQL and MySQL too (LOW) | Wrong advice for two dialects | None: the text lived in the CLI | The CLI held dialect knowledge | Each store exports its own notes (rung 1) |
| 8 | `migrate` without `--yes` on a missing file exited 5 where DESIGN said 2 (LOW) | A plan an operator could not see | The migrate cases | No case named a missing file without `--yes` | A case (rung 3) |
| 9 | An empty `--target` was accepted for a URL with no host (LOW) | A write with nothing named | The target check | It compared two empty strings | A write to a URL with no host is refused, with a mutation (rung 3) |
| 10 | An unreadable row exited 0 and printed its reason without `--reveal` (LOW) | A failure read as success | The result cases | They asserted the old exit | Exit 10 and a reveal gate, with mutations (rung 3) |
| 11 | A `migrate` that failed partway reported none of the versions it applied (LOW) | An operator cannot tell where it stopped | The migrate cases | No case failed midway | A case that stops at the last version (rung 3) |
| 13 | A dump of every table and schema object held only rows and indexes on PostgreSQL and MySQL (LOW) | A false claim about what the fault surface compares | The dump | It read one catalog | Columns, constraints and triggers too (rung 3) |
| 14 | An @ outside the user name and password was refused only when both were empty, so `admin:x@SECRET#y@host` parsed with SECRET as the host (HIGH) | The password in the `--target` message, in a driver's error with `--reveal`, and in a name lookup | The fold's refusal and credential sweep | The refusal's condition was a proxy, and the sweep's URL list held no such shape | The refusal finds where the authority ends in the URL as written and refuses any @ after it (rung 3, with two mutations) |
| 15 | mysql2 printed a query key that held the password to the console, without `--reveal` (HIGH) | The password on stderr for every read | The credential sweep | It read only `main`'s io, which a driver's console bypasses | The sweep captures the console and the process's streams, and every URL of it runs through the bin (rung 3) |
| 17 | The fold's refusal also refused a valid URL with an @ in its query, with a message about a password (LOW) | A false message | The storeTarget cases | No case put an @ in a query | The message is true of every @ outside the user name and password, and cases hold it (rung 3) |
| 18 | The move to `fileUrlPath` refused `file::memory:` with a message about decoding (LOW) | A false message | The file URL cases | No case named `:memory:` as a file URL | The message names `:memory:`, and a case holds it (rung 3) |
| 19 | PostgreSQL's version 10 note gave the lock's hold time and left out the unbounded wait behind open transactions (LOW) | An operator told the stall is sub second | None | Notes are prose | The note says it (text) |

## Detection ledger

Every counted finding came from outside review. The fold's own new credential sweep found three more leaks in the class of finding 1 while the fold was being built (a password whose leading digits parse as a port, printed by the `--target` message; a URL the libSQL client refuses at open, which exited 1; a PostgreSQL password that does not percent decode, which exited 6); they are the author's machinery at work and are not counted.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The review of the first head, by reading and by its own probes (findings 1 to 11 and 13) | 12 | No |
| The narrow re-review of the fold, by its probes (findings 14, 15, 17, 18 and 19) | 5 | No |

Self-catch rate: 0 percent, 0 of 17; counting the three leaks the fold's own sweep found would make it 3 of 20, 15 percent (previous round, PR3.4e: 13 percent, 1 of 8). The machinery this branch built found the instances it had a URL for, and the reviewers found the shapes nobody had listed.

## Recurrence

The credential leak recurred inside this pull request. Round one instituted two mechanisms against it: a refusal of an @ outside the user name and password, and a sweep that plants a password in a list of URLs and reads every stream of every command. Both were proxies. The refusal checked that the user name and password parsed empty while the URL held an @, which is one symptom of a cut authority, not the property that every @ of the credentials lies inside the authority; a cut authority with a user name in front of it passed. The sweep checked the URLs its author thought of, and read the io `main` writes to, not the process's streams, so a driver that prints straight to the console was invisible to it by construction. Finding 15 is a new path of the same class that the sweep could not see; finding 14 is the same path in a shape the list did not hold. The class of an operator facing message that is false for the case it prints on (findings 7, 17, 18 and 19) appeared in both rounds, and two of its four instances were introduced by fixes.

## Mechanism audit — the false negative of each

Each row names code that still has the bug and still passes the mechanism. Rows A and C were planted in the worktree and run on the head, row D and the first row ran as short scripts, and the last two are shapes named from the mechanism's own boundary, not run.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The authority refusal | 3 | It models the WHATWG parser all three drivers use. A client that splits user and host at the first @ reads `mysql://root:p@ss@db.example.io/app` as host `ss@db.example.io` where the check reads `db.example.io` (run: the WHATWG host and a first @ split differ exactly so), so a store whose client parses by another rule would leak past it |
| A. The credential sweep | 3 | It looks for the whole planted password and its digits only. Planting `${new URL(url).password.slice(0, 3)}` into the `--target` mismatch message printed `127.0.0.1:1 (pw-)` and the sweep passed, 1 of 1 |
| C. The sweep, the bin runs and the sentinel sweep together | 3 | Every URL that holds a credential fails to open, and the URL of every database that opens holds none. Planting a write of the store URL to file descriptor 2 at the start of `result` printed it 49 times while all 11 redaction cases passed |
| D. The import resolver | 2 | It reads the specifiers TypeScript's scanner finds. `const name = '@durablerun/store-libsql'; export const load = () => import(name)` yields no specifier (run: `[]`, where the literal form yields the package) |
| Every declared label is sent | 3 | It covers the starting states its scenarios build. A label a command sends only from a state no scenario seeds, and does not declare, passes |
| The exit table test | 3 | It holds DESIGN.md and `exit.ts` equal to each other. A new failure a store raises that maps to a code the table calls safe passes, as exit 6 did for a bad credential |

## Fix-induced defects

Two of the 17, both LOW and both messages: finding 17 was made by the first fold's refusal, which refused a valid URL with a message about a password, and finding 18 by the move to `fileUrlPath`, which refused `file::memory:` with a message about decoding. Finding 14 is not counted here, because the leak existed before the fold and the fold's fix was only incomplete. The fold was re-reviewed as new code by a narrow review, which is what found all three; the fix for the re-review's findings was re-tested, with the unfiltered audit, and not re-reviewed.

## Evidence

- Red tests: commit `3cd1efb`, probe `packages/cli/test/redaction.test.ts` `a credential in the store URL or its token prints in no stream of any command, and every command answers with an exit code`, run and seen failing against `4cdeb89`, where main threw on a URL that does not parse and the bin printed the URL with its password.
- Fixes: commit `bdb1be7`, which turns that red test green; gate after the fix: the full list on the fold's head before the re-review, the unfiltered audit among it.
- Red tests: commit `0e50c71`, run and seen failing against `4cdeb89`, where reads of a %20, a %3F and a %23 name each exited 5.
- Fixes: commit `70d3474`, which turns that red test green.
- Red tests: commit `52dc184`, run and seen failing against `4cdeb89`, where the bootstrap batch was declared and never sent.
- Fixes: commit `e8f4b96`, which turns that red test green.
- Red tests: none of its own for findings 4 to 13, and this line cites no commit; each is a false claim or a missing case, fixed with its case or its text.
- Fixes: commits `a07cf8b` (exit 4), `3bce504` (journal mode), `cd4eedf` (the import resolver, with its planted control), `1a475ae` (the stores' notes), `9f5f279` (plan on a missing file), `b2bb428` (empty target), `3f74a6c` (exit 10), `210e69d` (migrate partway), `35738a9` (the alpha.1 harness required) and `ed21698` (the dump), each with its case where it changes behaviour.
- Red tests: commit `2ab480c`, run and seen failing against `fc09900`, where a password whose digits parse as a port printed them; one of the three leaks the fold's own sweep found.
- Fixes: commit `dbe1266`, which turns that red test green.
- Red tests: commit `7cf6df1`, probe `packages/cli/test/redaction.test.ts` `a credential in the store URL or its token prints in no stream of any command, and every command answers with an exit code`, run and seen failing (3 tests) against `dbe1266`, where the sweep failed at the mysql URL without reveal through the captured console, the exit 2 case failed with exit 6 and one batch sent, and the bin case failed at the mysql URL.
- Fixes: commit `b701d04`, which turns that red test green and rewords the refusal for finding 17; commit `eaaacd1` aims the refusal's mutation at the new check and registers one for the backslash.
- Red tests: none of its own for findings 18 and 19, and this line cites no commit.
- Fixes: commits `a7d9501` (the in memory file URL message) and `ebee2c2` (the PostgreSQL note).
- Finder of findings 1 to 13: the review of the first head, quoted: "When a server URL does not parse, main throws instead of returning an exit code. Node then prints an uncaught `TypeError: Invalid URL` whose `input` field is the whole DURABLERUN_STORE_URL, database password included."
- Finder of findings 14 to 19: the narrow re-review of the fold, quoted: "The leak class is not closed. Take a password that holds an @ and then a reserved character (# / ?)", with its probes through main and through the bin.
- Did not reproduce: none; every finding of both rounds reproduced, and the re-review marked finding 16 and finding 19 as reproduced by reading.
- Measured after the fix: the reviewer's three URLs through the bin with `doctor --queue q --reveal` exit 2 and print no part of the password, and `migrate --target elsewhere --yes` prints the refusal, not a host.

## Root cause

Every layer the CLI had tested values the author planted in places the author chose. The redaction sweep of round one planted values in rows; the credential sweep of the fold planted a password in URLs the author listed and read the streams the CLI owns. The property is about the operator's input, which is unbounded, and about every writer in the process, which the CLI does not own. A refusal written as a condition on the parsed result (the user name is empty) cannot express where the parser cut the input, which is the thing that decides whether a host holds a password; the fix moved the check to the input as written.

## Mechanisms

Built in this PR:

- The authority refusal: any @ after the end of the URL's authority, found in the URL as written, is refused before anything parses or opens, in `packages/cli/src/open-store.ts`, held by two registered mutations (rung 3).
- The credential sweep captures the console and both process streams around every in process run, and a bin case runs every URL of the sweep as a child process with and without `--reveal`, in `packages/cli/test/redaction.test.ts` (rung 3).
- The import resolver of round one, which reads where each import resolves (rung 2), and the declared label check of the fault surface (rung 3).

Deferred (recorded in BUILD.md):

- None. A stronger rung for the credential property would be a URL type the CLI can only print through a redacting formatter; every message that names a target already builds from `storeTarget`'s answer, so the remaining gap is a driver's own output, which a type in the CLI cannot reach.

## What this round still would not catch

A defect of these shapes would ship today: a message that prints part of a password, since the sweep looks for the whole of it and its digits; any print of the store URL on a path that runs only after a store opens, since no test's opened database has a credential in its URL; a store whose client parses a URL by a rule other than WHATWG's; an import of a store package through a computed specifier; a batch sent only from a starting state no fault scenario builds; and a new failure a store raises that lands on an exit code the table calls safe to repeat.
