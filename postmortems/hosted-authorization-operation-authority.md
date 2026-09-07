# Postmortem: hosted authorization operation authority review

The hosted-alpha authorization slice initially exported an exhaustive list of
four semantic operations. Adversarial review found that the TypeScript-readonly
list was runtime-mutable: a consumer could append a fifth operation, after
which the central validator accepted it. The repaired history preserves the
exact mutable implementation, failing regression, and intermediate runtime
freeze. Before the public API shipped, the simplification pass removed the
collection from the public surface entirely. The final boundary derives its
operation union and runtime membership from one module-private tuple, so a
plugin receives an operation value but no authority collection to mutate.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The important failure is that compile-time notation was accepted as
runtime authority and every original test left that proxy untouched.

## Severity

Without review, the public contract would have promised that an unmapped
operation fails closed with HTTP 500 while the runtime did the opposite after
mutation. A JavaScript consumer, a cast, or another in-process integration
could append an operation such as `task.delete` and pass it to
`authorizeHostedRequest`; a broad plugin's explicit allow then produced an
authorization grant. The standing review rule classified that escaped defect
as a release-safety SEV. Its actual reach was narrower: it was not a remote
exploit, the reproducer required trusted in-process code, and that code could
already replace its plugin or bypass the HTTP adapter. The release-relevant
problem was a public API making a false fail-closed promise, which the final
private representation removes instead of defending with more public machinery.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | `HOSTED_AUTHORIZATION_OPERATIONS` used `as const`, which is erased at runtime, while `isOperation` trusted the exported array's current contents | Mutating the export widened the supposedly closed operation set and let a normal allow plugin grant an unmodeled operation instead of returning the promised 500 | The authorization boundary's runtime representation and a mutation-focused behavioral test | Typechecking proved only a readonly tuple type; the six original tests called known operations or one unknown operation without first mutating the authority source | The intermediate repair froze the export; the final simplification removes the export and derives both the type and runtime check from one module-private tuple (rung 1 for external mutation of the authority source) |

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
shape, but the first repair interpreted that as "freeze the exported
collection." The later simplification applied the stronger and smaller rule:
do not export internal authority that no consumer needs. This finding does not
prove a prior freeze mechanism failed; it shows that deleting an unnecessary
capability is preferable to adding machinery around it.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Module-private operation tuple, with the public union and runtime membership derived from it | 1 for external mutation of the authority source | No in-scope external-mutation false negative: no reference to the tuple crosses the module boundary. Source code in this module can intentionally add another operation; that is a code change, not authority granted to a plugin. |
| Require `task.delete` to produce `invalid-operation` | 3 | The test names one unknown value. Experiment A added a second acceptance arm for `task.cancel`; the focused tests still passed and a direct `task.cancel` call returned `{"principal":"admin"}`. The private single source removes accidental external widening, not deliberate source changes. |

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

This remains the honest test boundary. The historical freeze closed mutation
of one exported object; the final private tuple removes that object from the
public capability surface. Neither shape proves that a future source edit
cannot deliberately widen the vocabulary.

## Fix-induced defects

**Zero.** This finding was present in the initial authorization implementation,
not introduced by a repair earlier in the round. Fix commit `fd28273` changed
only the array's runtime construction from a plain tuple to `Object.freeze`.
The later simplification replaced that repair with the private representation;
it did not reveal or introduce another correctness finding.

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
- The final simplification retains the four known-operation and unknown-operation
  behaviors, but no longer exports an operation collection, custom header
  facade, or framework policy combinators. The hosted router remains the sole
  selector of operation values and passes the exact bounded body to one plugin
  before parsing or store work.

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

- One module-private tuple generates the public operation union and the runtime
  membership check. Plugins receive only a selected value, never the collection
  that defines authority (rung 1 for external mutation of that source).
- The focused behavior test invokes the central boundary with `task.delete` and
  requires `invalid-operation` 500 while separately exercising every route-owned
  operation (rung 3).
- The router owns route-to-operation selection and invokes exactly one required
  plugin before parsing or store work. Scheme composition and per-operation
  policy stay in host code rather than a second framework policy layer.

Deferred (recorded in BUILD.md):

- No framework auth machinery is deferred. JWT, platform-signature verification,
  multiple-scheme composition, and per-operation policy are intentionally owned
  by the host-supplied plugin and are not hosted-alpha framework scope.

## What this round still would not catch

A future source change can add a second acceptance arm for an untested unknown
value while leaving the `task.delete` regression green; Experiment A did
exactly that with `task.cancel`. A host can also intentionally authorize every
known operation or bypass its own router and call the store directly. Host code
is the trusted policy boundary; the private operation representation is not
presented as a sandbox against it.
