# Postmortem: hosted-alpha worker-route contract review (PR #20)

The hosted-alpha design correctly named an exact four-route HTTP surface, but
its next paragraph also presented an external resident driver posting launches
to `/api/worker` as a supported deployment choice. The router has no such
endpoint and correctly returns 404. Review caught the contradictory release
instruction before the alpha; the design now states that the alpha uses the
bounded inline tick and defers resident and detached-worker placement.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The relevant question is why two adjacent descriptions of the same
release surface could disagree while all executable checks stayed green.

## Severity

This is a release-safety SEV because DESIGN.md is the authoritative contract.
A developer following the advertised option would deploy a resident driver
that sends every launch to `/api/worker`; the alpha application would return
404 for every request, so claimed work would not reach a worker. Durable state
was not corrupted, but one supposedly supported deployment path could not
execute the product outcome at all.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The current Vercel deployment section offered a resident-driver `/api/worker` path even though the alpha router exposes exactly four other routes and BUILD.md defers resident and detached workers | An operator following the option receives 404 for every launch and the workflow cannot progress through that placement | Authoritative current-milestone design and the hosted route inventory | The exact route list, BUILD non-goals, and executable router were each correct, but the adjacent placement paragraph remained a second free-text capability description that no executable check interpreted | Keep one exact current route inventory in the hosted-alpha design, make the placement paragraph refer to it and explicitly defer `/api/worker`, and retain the router's closed route map plus unknown-path 404 behavior (rung 1 for representation within the current design and router; rung 3 for behavior) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| CodeRabbit functional-correctness review of PR #20 | 1 | No |

Self-catch rate: **0 of 1, or 0%** (previous hosted durable-identity review:
**0 of 2, or 0%**). The rate did not improve: the router and its focused tests
were green while the authoritative prose still advertised an absent endpoint.

## Recurrence

This recurs in the hosted deployment-contract class exposed by the earlier
Hobby cron review. That round's schedule assertion correctly owns the concrete
cron cadence, but it cannot enroll unrelated placement prose. More broadly,
the repository's single-representation rule already identified duplicated
capability descriptions as hazardous; the current route inventory and the
resident-driver option nevertheless described the alpha surface independently.

The earlier mechanisms were therefore narrower than this property. The cron
test proves one manifest field, and the hosted router tests prove HTTP
behavior; neither proves that every sentence in DESIGN.md describes that
behavior. The correction removes the competing current option rather than
adding a second endpoint or claiming that another textual scan would establish
semantic support.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| One exact route inventory in the current hosted-alpha design, with the placement paragraph referring to it and marking other placements as future | 1 within the current design section | A historical roadmap paragraph can still mention `/api/worker`, and a future editor could make that wording look current without changing the canonical inventory. No prose structure can make reader interpretation unwritable; the current heading and explicit deferral establish scope rather than validate every mention repository-wide. |
| Private four-entry router map plus unknown-path 404 behavior | 1 for the implementation inventory; 3 for execution | Commit `c49799d` is the executed false negative: the router returned `{"status":404,"body":{"error":"not_found"}}` for `POST /api/worker` and its focused suite was green, while DESIGN.md still promised that path. The implementation mechanism protects the actual surface, not the truth of prose about it. |

The direct probe used dependencies that throw if touched. It received the 404
before authorization or store work:

```ts
const forbidden = new Proxy({}, {
  get() {
    throw new Error('dependency touched')
  },
})
const router = createHostedRouter({
  store: forbidden,
  ids: forbidden,
  clock: forbidden,
  registry: new Map(),
  authorization: () => allowAuthorization(),
  queue: 'q',
  sweepLimit: 1,
  leaseSeconds: 1,
})
const response = await router.handle(
  new Request('https://alpha.example/api/worker', {
    method: 'POST',
    body: '{}',
  }),
)
```

## Fix-induced defects

**Zero.** The router behavior was already correct, and the repair changes only
the authoritative placement description. The other files in the correction
commit are independent planning, test-fixture simplification, and postmortem
audit cleanup; they do not add a worker path or alter request dispatch.

## Evidence

- Red behavior test: **not applicable to this documentation-only defect**.
  At the pre-fix documentation commit `c49799d`, the implementation already
  enforced the intended four-route/non-goal contract. The direct router probe
  returned `{"status":404,"body":{"error":"not_found"}}`; making a behavior
  assertion red would require breaking the correct router. A checker that
  searches prose for endpoint tokens would instead be a weaker syntactic proxy
  for supported deployment behavior, so no artificial red commit was made.
- Pre-fix contract evidence from `DESIGN.md` at `c49799d` said: "run the tiny
  driver elsewhere ... with it POSTing worker launches to `/api/worker` on the
  Vercel deployment" and concluded that this and fully serverless placement
  were alternatives that "use the same engine code." The preceding paragraph
  named exactly `/api/tasks`, `/api/events`, `/api/tick`, and `/api/inspect`.
- Fix: commit `dbecca6` states that the hosted alpha is fully serverless and
  explicitly defers a resident driver, `/api/worker`, and detached HTTP
  workers. The affected hosted and inline targets passed **11 of 11** tests;
  driver TypeScript, Biome on both changed tests, `git diff --check`, and the
  deferral lint all exited zero.
- Finder, quoted verdict: "`DESIGN.md:1225-1229` presents this as a supported
  hosted-alpha deployment, but `createHostedRouter` defines only the four
  routes in the route inventory. Its dispatcher returns 404 for `/api/worker`,
  so resident-driver launches cannot reach the deployment." The review is
  retained in [PR #20's thread](https://github.com/ejc3/durablerun/pull/20#discussion_r3951844721).
- The suggestion to add a documentation-to-route inventory checker was not
  accepted. Such a checker would need to infer support from prose spellings,
  and could be green while an endpoint had the wrong method, authorization,
  or behavior. The private route table and executable 404 test remain the
  implementation authority; the hosted receipt exercises the supported path.
- The possibility that `/api/worker` was an unimplemented but functioning
  fallback did **not** reproduce: the dependency-forbidden probe returned 404.
  The possibility that the sentence was merely historical context also did
  **not** reproduce: it lived under "Vercel deployment shape (initial target)"
  and used present-tense "either" language immediately after the alpha route
  inventory.

## Root cause

The hosted milestone narrowed to one serverless vertical slice, but one
placement paragraph retained the broader architecture's resident-driver path.
Route code and BUILD.md changed with the milestone; that paragraph did not.
Because prose, executable routes, and planning non-goals were independent
representations, ordinary tests could prove the desired implementation while
the authoritative user contract contradicted it.

## Mechanisms

Built in this PR:

- The current hosted-alpha design has one exact route inventory. Its placement
  paragraph now refers to that surface and marks resident and detached-worker
  placement as future, eliminating the competing current capability statement
  (rung 1 within the authoritative section).
- `HostedRouter.handle` retains one private closed route map and rejects every
  unknown path before dependencies are touched; the focused suite covers the
  four supported operations and unknown-path 404 behavior (rungs 1 and 3).

Deferred (recorded in BUILD.md):

- None. A generated prose-token inventory was considered and rejected, not
  added to the roadmap: it would be a syntactic proxy for endpoint semantics
  and would expand assurance machinery past the hosted-alpha exit test.

## What this round still would not catch

A future paragraph can again imply support for a route outside the canonical
inventory while every router test stays green. The first mechanism makes the
current authoritative section internally singular; it does not compile all
natural-language claims into the route map. Conversely, a supported endpoint
can have host-specific deployment failures that local routing tests cannot
predict. The clean external install, real Vercel deployment, and retained
hosted receipt remain the outcome-level checks for those residuals.
