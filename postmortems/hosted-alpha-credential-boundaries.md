# Postmortem: hosted-alpha credential boundaries (PR #20)

The hosted-alpha review found two unchecked configuration relationships at the
edges of the example application. Equal API and cron tokens collapsed the
documented operation-authority split, and the hosted receipt accepted a
plaintext HTTP destination before attaching those tokens. The example now
rejects equal credentials when its authorization plugin is constructed and
accepts only an HTTPS receipt base URL before constructing authenticated
requests.

**This document is adversarial toward the MACHINERY and blameless toward
people.** The relevant question is what would have made these configurations
unusable, or caught them before an outside review.

## Severity

This is a SEV because both escaped defects crossed credential boundaries. An
operator could configure one bearer token that authorized both ordinary API
operations and the more privileged scheduler tick despite the documented
separation. Independently, a mistyped `http:` receipt URL could transmit both
bearer credentials without transport encryption. Without the review, either
configuration could have reached the hosted-alpha deployment and invalidated
its authorization receipt.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | The example authorization composition accepted equal API and cron bearer tokens | One credential authorized enqueue, emit, inspect, and tick, collapsing the promised operation split | Hosted configuration construction and its executable example test | Existing tests proved that two distinct constants had different authority, but no configuration guard represented the required inequality | Snapshot both configured tokens once and reject equality at the composition chokepoint; execute that invalid configuration in the example suite (rung 3) |
| 2 | The hosted receipt accepted an `http:` base URL before creating requests carrying bearer credentials | A local configuration mistake could send both credentials over a plaintext connection | Receipt configuration parsing and its executable example test | The receipt used the generic `URL` parser, and the receipt test covered only a valid production-shaped destination | Route the script through one HTTPS-only URL parser before reading the bearer-token variables or constructing requests; execute a plaintext input in the example suite (rung 3) |

## Detection ledger

| Detector | Findings | Ours? |
|----------|----------|-------|
| CodeRabbit security review on PR #20 | 2 | No |

Self-catch rate: **0 of 2, or 0%** (previous hosted-alpha durable-identity
review: **0%**). The unchanged rate means the new hosted boundary still had
configuration properties documented in prose but absent from executable
construction checks.

## Recurrence

Finding 1 recurs in the authorization-authority class. The earlier hosted
authorization review made the route operation vocabulary module-private and
fail-closed, but that mechanism protected which operation the router asks a
plugin to authorize. It did not protect the example plugin's mapping from
credentials to those operations. The prior mechanism was exact for route
vocabulary but only a proxy for the broader promise that API and tick authority
remain separate in the checked-in deployment.

Finding 2 is not a recurrence of a previously recorded hosted-alpha class. The
router correctly kept authorization ahead of parsing and storage, but no prior
mechanism owned the transport scheme selected by the external receipt client.

## Mechanism audit — the false negative of each

After both fixes, the exact guards were temporarily narrowed to the two
regression literals:

```ts
if (apiToken === 'example-api-token' && cronToken === 'example-api-token') {
  throw new TypeError('hosted API and cron tokens must be distinct')
}

if (url.href === 'http://hosted.test/') {
  throw new TypeError('DURABLERUN_BASE_URL must use HTTPS')
}
```

The complete hosted example suite still passed **5 of 5**. A separate probe
then constructed the plugin with `another-shared-token` in both fields and
parsed `http://other.test`; it printed
`{"sharedRejected":false,"httpRejected":false}`. The mutations were restored
immediately, and `git diff --exit-code` returned zero.

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| Equal-token construction guard plus configuration regression | 3 | The literal-only equality guard above passes the existing regression while another equal token escapes. The shipped guard compares the two runtime snapshots directly; the experiment establishes that the finite test is not a proof of its implementation. |
| HTTPS-only receipt URL parser plus boundary regression | 3 | The literal-only URL guard above passes the existing regression while another plaintext host escapes. The shipped parser checks the canonical `URL.protocol`; the experiment establishes the same finite-test boundary. |

## Fix-induced defects

**Zero of two.** Both findings reproduced independently against the reviewed
parent before either repair. The second red test was added only after the first
fix was green, and the combined five-test example suite was rerun after both
fixes and after restoring the mechanism-audit mutations.

## Evidence

- Equal-token red test: commit `e8f009f` against its buggy PR parent `17192db`;
  the defect was initially reviewed at `c49799d`.
  The focused example suite failed **1 of 4** with `Missing expected exception
  (TypeError)` while its other three tests passed.
- Equal-token fix: commit `7b3fdb8`. At that exact commit the same suite passed
  **4 of 4**.
- Plaintext-target red test: commit `86012ed` against `7b3fdb8`. The focused
  example suite failed **1 of 5** with `Missing expected exception (TypeError)`
  while its other four tests passed.
- Plaintext-target fix: commit `fbd400d`. At that exact commit the same suite
  passed **5 of 5**.
- Finder, CodeRabbit security review: "When `apiToken` and `cronToken` are
  equal, the same credential authorizes API operations and `tick.run`. Reject
  duplicate values when constructing `hostedAuthorization`."
- Finder, CodeRabbit security review: "`new URL()` accepts `http:`. `call` then
  sends bearer credentials over that connection. Reject non-HTTPS URLs before
  any request is created."
- Both findings reproduced as stated. No candidate in this deliberately narrow
  two-finding repair scope was disconfirmed; comments about route inventory,
  release inventory, and lint self-tests are triaged separately and are not
  silently counted here.

## Root cause

The existing machinery tested successful authorization behavior after
configuration, but it did not make configuration relationships executable.
Two prose assumptions therefore crossed into credential-bearing code as plain
strings: the two secrets were assumed distinct, and the production URL was
assumed secure. Neither the router's closed operation vocabulary nor the
bearer adapter could recover once those inputs had already erased the intended
boundary.

The smallest common repair is validation at the construction chokepoint that
first has enough information to state each property. These are runtime
relationships, so a direct predicate plus a failing configuration test is the
highest applicable rung; TypeScript cannot prove inequality of environment
strings or the scheme of a runtime URL.

## Mechanisms

Built in this PR:

- `hostedAuthorization` snapshots both credential inputs, validates each with
  the existing bearer adapter, and rejects exact equality before returning a
  plugin. The executable example test supplies the forbidden configuration
  directly (rung 3).
- `requireHostedReceiptBaseUrl` is the receipt script's single URL-construction
  path and rejects every canonical protocol other than `https:` before the
  script reads either bearer-token variable or constructs a request. The
  executable example test supplies a plaintext URL directly (rung 3).

Deferred (recorded in BUILD.md):

- None. Both runtime properties are enforced at their existing chokepoints;
  this incident creates no new product or assurance scope.

## What this round still would not catch

The point mutations demonstrate that either finite regression can stay green
if a future implementation special-cases its exact input. The shipped checks
state the runtime properties directly rather than enumerating examples, but
the tests alone cannot prove that source shape. A host-supplied custom plugin
can also intentionally use one scheme for every operation; that is explicit
host policy permitted by the pluggable-auth contract, not an authority the
framework can infer or reject. Finally, this repair validates the receipt's
initial URL. TLS certificate validation and redirect credential handling remain
properties of the standards-compliant host `fetch` implementation rather than
new protocol code in this example.
