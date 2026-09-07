# Postmortem: hosted authorization operation authority review

The hosted-alpha authorization slice introduced a public, exhaustive list of
four semantic operations and rejected any operation outside it. Adversarial
review found that the list was TypeScript-readonly but runtime-mutable: a
consumer could append a fifth operation, after which the central validator
accepted it and an ordinary allow plugin authorized it. The finding was made
before the first implementation commit, but after the author's focused and
full-driver tests had passed. The repaired history records the exact mutable
implementation, a failing behavioral regression, the runtime freeze, and this
machinery audit.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The important failure is that compile-time notation was accepted as
runtime authority and every original test left that proxy untouched.

## Severity

Without review, the public contract would have promised that an unmapped
operation fails closed with HTTP 500 while the runtime did the opposite after
mutation. A JavaScript consumer, a cast, or another in-process integration
could append an operation such as `task.delete` and pass it to
`authorizeHostedRequest`; a broad plugin's explicit allow then produced an
authorization grant. This is a release-safety SEV because the defect widened
the authority vocabulary at runtime. It was not, by itself, a remote exploit:
the alpha router did not yet exist and the reproducer required in-process
mutation. Shipping the primitive would nevertheless have made later routing
code depend on a false fail-closed guarantee.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `HOSTED_AUTHORIZATION_OPERATIONS` used `as const`, which is erased at runtime, while `isOperation` trusted the exported array's current contents | Mutating the export widened the supposedly closed operation set and let a normal allow plugin grant an unmodeled operation instead of returning the promised 500 | The authorization boundary's runtime representation and a mutation-focused behavioral test | Typechecking proved only a readonly tuple type; the six original tests called known operations or one unknown operation without first mutating the authority source | Freeze the exported tuple at runtime, keep validation derived from that frozen source, retain the mapped type that makes per-operation policy exhaustive, and execute an append-then-authorize regression (rung 1 for mutation of this representation; rung 3 for behavioral evidence) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| Adversarial review of the uncommitted hosted-authorization implementation | 1 | no |

Self-catch rate: **0 of 1, or 0%** (previous comparable committed
implementation-review round, PR #16: **0 of 9, or 0%**).

There was no improvement. Before review, the focused authorization suite was
6 of 6 green, the complete driver suite was 63 of 63 green, TypeScript passed,
and the relevant lints passed. Those checks established behavior only while
the exported authority retained its initial contents.

## Recurrence

No earlier postmortem records this exact exported-operation mutation. It is,
however, another instance of the repository's recurring proxy class:
`as const` described runtime immutability to the typechecker and was treated as
if it made mutation unwritable. The property was that no live process can
widen the authorization vocabulary. The proxy was that well-typed callers
cannot call mutating array methods.

The repository's standing single-representation rule pointed toward the right
shape, but no existing mechanism required an exported authority collection to
be frozen or attacked it through JavaScript's runtime surface. This finding
does not prove a prior freeze mechanism failed; it proves the established
structural lesson was not applied to the new boundary.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Runtime-frozen exported tuple, with `isOperation` reading it | 1 for mutation of this object | No in-scope false negative: `push`, `splice`, index assignment, and length assignment cannot change the frozen array. The adjacent broader defect is a second acceptance source in `isOperation`; freezing the tuple cannot prevent source code from adding one. |
| Append `task.delete`, then require `invalid-operation` | 3 | The test names one unknown value. Experiment A added `if (value === 'task.cancel') return true` to `isOperation` while leaving the exported tuple frozen; all seven focused tests still passed and a direct `task.cancel` call returned `{"principal":"admin"}`. |
| Exhaustive `HostedAuthorizationByOperation` mapped type and snapshotted adapter | 1 for typed construction | No in-scope false negative when the operation union grows: `satisfies HostedAuthorizationByOperation` makes a missing policy a type error, and construction rejects missing runtime functions. A caller can bypass this optional adapter and supply one broad plugin directly; central operation validation, not this mapping, must reject unknown operations. Experiment A shows that boundary. |

Experiment A was written and run in a disposable checkout of fix commit
`fd28273` with this deliberate second authority:

```ts
function isOperation(value: unknown): value is HostedAuthorizationOperation {
  if (value === 'task.cancel') return true
  return (
    typeof value === 'string' &&
    (HOSTED_AUTHORIZATION_OPERATIONS as readonly string[]).includes(value)
  )
}
```

The unchanged focused suite reported:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
```

The direct probe then called `authorizeHostedRequest` with `task.cancel` and
an allow plugin; it exited zero and printed:

```json
{"principal":"admin"}
```

This is the honest boundary. Runtime freezing closes mutation of the exported
representation. The single `task.delete` regression is not a proof that future
source changes cannot introduce a second authority.

## Fix-induced defects

**Zero.** This finding was present in the initial authorization implementation,
not introduced by a repair earlier in the round. Fix commit `fd28273` changes
only the array's runtime construction from a plain tuple to `Object.freeze`.
The seven focused tests, driver TypeScript check, formatting, determinism lint,
and user-boundary lint passed after the change, and adversarial re-review found
no further release blocker.

## Evidence

- Original finder: adversarial review of the uncommitted implementation based
  on `bdab7e7`. The reviewer ran:

  ```sh
  pnpm exec tsx -e "import { HOSTED_AUTHORIZATION_OPERATIONS, authorizeHostedRequest, allowAuthorization } from './packages/driver/src/index.ts'; (HOSTED_AUTHORIZATION_OPERATIONS as unknown as string[]).push('task.delete'); const req = new Request('https://alpha.example/api/tasks'); authorizeHostedRequest(() => allowAuthorization('admin'), 'task.delete' as never, req, '').then((x) => console.log(JSON.stringify({operations: HOSTED_AUTHORIZATION_OPERATIONS, result: x}))).catch((e) => console.error(e.code,e.httpStatus,e.message))"
  ```

  It exited zero and printed:

  ```json
  {"operations":["task.enqueue","event.emit","tick.run","task.inspect","task.delete"],"result":{"principal":"admin"}}
  ```

  The quoted review verdict was: "A JS consumer/cast can push an unmodeled op
  and `authorizeHostedRequest` will authorize it with any ordinary plugin,
  violating unmapped operations become 500 and exhaustive per-operation."
- Initial implementation: commit `e0b0443`. Its focused suite passed 6 of 6;
  this is the mutable implementation shape against which the red regression
  was added.
- Red test: commit `36ff5ab` — run and seen failing **1 of 7** against
  `e0b0443`. The mutation succeeded, the authorization call resolved, and the
  test failed with `expected HostedAuthorizationError`.
- Fix: commit `fd28273`. The tuple is frozen at runtime; the same focused suite
  passed 7 of 7. Driver TypeScript, Biome, determinism lint, user-boundary lint,
  and `git diff --check` were green.
- The first implementation had not been committed when review found the bug;
  the original branch therefore had no buggy hash. This repaired branch
  deliberately reconstructs the relevant mutable shape as `e0b0443` so the red
  and green evidence are reproducible rather than retroactively claimed.
- The claim that `as const` made the exported value immutable did **not**
  reproduce: the original probe appended `task.delete` and printed the widened
  list. The claim that the freeze proves every future operation validator is
  closed also did **not** reproduce: Experiment A retained seven green tests
  while authorizing `task.cancel` through a second source-code arm.

## Root cause

The implementation had two representations of "readonly" with different
authority. TypeScript's tuple type controlled what checked callers could
express, while JavaScript's live array controlled what the validator accepted.
The type disappeared at runtime, but the validator consulted the mutable
object. Tests exercised values against the initial list and therefore never
asked whether the authority itself could change. The common machinery failure
was treating a compile-time access restriction as the runtime security
property.

## Mechanisms

Built in this branch:

- `Object.freeze` creates the exported operation tuple in its immutable runtime
  form, and `isOperation` derives membership from that same object (rung 1 for
  mutation of this representation).
- `HostedAuthorizationByOperation` maps over the tuple-derived union, while
  `authorizationByOperation` snapshots and validates every required function;
  there is no fallback policy (rung 1 for typed construction and runtime
  configuration).
- The focused behavioral regression attempts to append `task.delete`, invokes
  the central boundary with that operation, and requires `invalid-operation`
  500. It cleans up the mutation in the deliberately buggy red state so the
  rest of the suite remains diagnostic (rung 3).

Deferred (recorded in BUILD.md):

- None. The finding's fix and prevention ship in this branch. Experiment A is
  an explicit mechanism boundary, not an accepted deferral or new hosted-alpha
  work item.

## What this round still would not catch

A future change can add a second acceptance arm for an untested unknown value
while leaving the tuple frozen and the `task.delete` regression green;
Experiment A did exactly that with `task.cancel`. The mapped policy type cannot
protect a caller that intentionally uses a single broad plugin instead of the
per-operation adapter, so the central validator remains load-bearing. A host
with arbitrary in-process code can also replace its own plugin policy; that is
outside this boundary's threat model and is not presented as something the
freeze prevents.
