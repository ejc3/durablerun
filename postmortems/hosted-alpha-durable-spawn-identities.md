# Postmortem: hosted-alpha durable spawn identities

The hosted-alpha functional review found two manifestations of one missing
storage-boundary rule. A task name could be returned from libSQL with a
different value and select the wrong registered handler, while two distinct
idempotency keys could be stored as the same value and return the wrong spawn
receipt. Both inputs now cross one shared durable-string validator at the
libSQL and PostgreSQL spawn ingresses, and hosted enqueue classifies that
specific rejection as HTTP 400.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The relevant question is what would have made these outcomes
unwritable or caught them before an outside functional review.

## Severity

This is a SEV because the escaped behavior crossed durable identities. A
caller could enqueue one task name and have a different registered handler run
after the value crossed storage. Separately, a new enqueue carrying a distinct
idempotency key could be reported as a replay of an earlier task. Without the
review, hosted-alpha could therefore execute or attribute durable work to an
identity different from the one accepted at its HTTP boundary.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | Spawn accepted a task name containing a value that libSQL did not return unchanged | The tick selected the handler registered under the changed name instead of refusing the enqueue | Scheduler store ingress and shared conformance | The portable string predicate was private to task-value validation and `UserName`; spawn accepted a raw string and ordinary conformance names all round-tripped | Shared `requireDurableString` at both existing store spawn ingresses, with the returned task-name snapshot used for the bind; portable conformance plus hosted outcome regression (rung 1 single definition, rung 3 execution) |
| 2 | Spawn accepted distinct idempotency keys that libSQL stored as the same value | The second enqueue returned the first task's receipt and suppressed distinct durable work | Scheduler store ingress and shared conformance | Idempotency tests covered equality only in JavaScript's ordinary string domain, and no store-port validator owned the persisted key | The same shared validator snapshots the option once and validates and binds that snapshot; portable conformance checks rejection before executor I/O and absence of aliasing (rung 1 single definition, rung 3 execution) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Outside hosted-alpha functional-diff review | 2 | No |

Self-catch rate: **0%**. This was the first comparable hosted-alpha functional
review, so there is no earlier hosted-alpha percentage; the baseline is now
explicitly zero rather than inferred from a green ordinary-input suite.

## Recurrence

Both findings recur in a class the repository had already encountered. Core's
`UserName.parse` rejected NUL and lone UTF-16 surrogates for step and event
names, and scheduler-header serialization used the same
`storageStringRoundTrips` predicate. That mechanism did not protect spawn
identities because the predicate was private and adoption was per field. It
checked the values routed through those two callers, not the property that
every string used as a durable identity must cross the portable domain.

The repair raises the existing predicate into a shared store-port validator
and puts both current dialects behind it. Shared conformance now exercises the
same spawn behavior for every enrolled dialect. This closes the two reachable
spawn fields; it does not claim that a finite set of examples proves every
possible implementation of the predicate.

## Mechanism audit — the false negative of each

A temporary post-fix mutation replaced the general predicate with the
following exact-value check, leaving the underlying class present:

```ts
return raw !== 'admin\u0000suffix' && raw !== 'same\uD800'
```

The two focused regressions still passed: hosted **1/1** and libSQL
conformance **1/1**. A separate libSQL probe then used a previously untested
low-surrogate key and observed
`{"firstCreated":true,"secondCreated":false,"sameTaskId":true}`. The mutation
was restored immediately, and `git diff --exit-code` returned zero.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Shared durable-string validator plus portable spawn and hosted regressions | 1 for the one predicate and ingress snapshots; 3 for the regressions | The exact-value predicate shown above retains the class for `novel\uDC00` while both reviewed examples pass. The shipped predicate checks actual NUL and the entire Unicode surrogate category; the audit proves that the tests are finite evidence, not a semantic proof of that implementation. |
| `InvalidDurableStringError` maps the store rejection to hosted `400 invalid_request` | 1 for the current error taxonomy; 3 for the hosted regression | A future `SchedulerStore` can enforce the same durable-string domain but throw a generic `TypeError`; the two enrolled dialects and the libSQL-backed hosted test still pass, while that store receives HTTP 500. The mapping is proved for the current store implementations, not made part of the `SchedulerStore` type. |

## Fix-induced defects

**Zero of two.** Both findings reproduced on the buggy parent before any repair
was applied. The fix was then re-read as new code, its import/lint shape was
checked, all seven hosted tests passed, all four affected TypeScript projects
compiled, and a null-dependency PostgreSQL probe verified that both rejection
paths occur before ID generation or executor access.

## Evidence

- Red tests: commit `27bc7fd` against buggy commit `22a3202`. The hosted target
  failed **1/1**: expected status 400, no claim, and zero handler calls, but
  observed status 201, one claimed/completed task, and one handler call.
- The same red commit's libSQL conformance target failed **1/1**: both invalid
  operations resolved, the second key matched the first task, executor calls
  were 2, and task count was 2; the contract expected two rejections, no
  matched receipt, zero executor calls, and task count 1.
- Fix: commit `6747d6c`. At that exact commit the hosted target passed **1/1**
  and the libSQL conformance target passed **1/1**. The complete hosted file
  passed **7/7**. Focused TypeScript checks for core, driver, store-libsql, and
  store-postgres all exited zero, and Biome checked the five changed TypeScript
  files cleanly.
- PostgreSQL ingress evidence without a database used null ID/executor
  dependencies and received
  `["InvalidDurableStringError","InvalidDurableStringError"]` for the bad task
  name and idempotency key. Reaching either dependency would instead have
  crashed the probe, so this pins rejection before IDs and SQL. A live
  PostgreSQL conformance run did not execute because this checkout had no
  `DURABLERUN_POSTGRES_URL`; this was an environment limitation, not counted as
  green evidence.
- Finder: Codex's hosted-alpha functional-diff review of base `77fcfae` through
  the then-current head. Its accepted verdict was: "An enqueue can persist a
  task name that returns as another registry key, and two distinct
  idempotency keys can collapse to one task receipt."
- No other auth, bounded-body, route-operation, inline-tick, or store candidate
  from that scoped review was promoted without a reachable failing outcome.
  The known Hobby cron failure at base commit `22a3202` was intentionally
  excluded from these focused runs because it belongs to a separate red/fix
  pair.

## Root cause

The system had a portable durable-string rule but not a port-wide way to ask
for one. Its predicate lived inside validation code used by headers and SDK
names, while `SchedulerStore.spawn` exposed task names and idempotency keys as
ordinary strings. The hosted parser's nonempty-string check established an
HTTP shape, not storage identity. Ordinary idempotency conformance then tested
equal source strings and could not reveal equality introduced by the driver.

The common machinery failure was therefore field-by-field adoption of a
private predicate. The repair makes the domain a named core operation,
validates at the store ingress where every caller converges, snapshots the
optional key once, and persists the exact validated values. A dedicated error
class lets the HTTP layer return 400 without broadly reclassifying unrelated
`TypeError`s.

## Mechanisms

Built in this PR:

- Core exports one `requireDurableString` definition for the already-specified
  portable domain. Both libSQL and PostgreSQL invoke it before IDs or executor
  I/O and bind only the returned task-name value and one-read idempotency-key
  snapshot (rung 1 single representation at the current store ingresses).
- `InvalidDurableStringError` is the narrow classification carried from the
  store boundary to hosted enqueue's stable `400 invalid_request` response
  (rung 1 error taxonomy).
- One shared conformance scenario covers handler-name change, key aliasing,
  executor non-entry, and durable row count for every enrolled dialect; the
  hosted test pins the user-visible 400 and absence of work (rung 3).

Deferred (recorded in BUILD.md):

- None. The smallest class-level store-ingress mechanism and its hosted
  mapping landed now, so this incident creates no BUILD.md deferral.

## What this round still would not catch

The executed point mutation shows the exact boundary: a deliberately narrowed
implementation of `requireDurableString` can recognize only the two regression
literals and leave another lone-surrogate identity unstable while the focused
tests stay green. The shipped predicate operates on the semantic NUL and
Unicode-surrogate classes, and the common ingress removes duplicated field
predicates, but the regression data is not an exhaustive Unicode proof. A
future change to the portable storage domain must therefore change the one
predicate and extend the class cases rather than treating these two literals
as the contract.
