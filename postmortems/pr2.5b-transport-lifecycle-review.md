# Postmortem: PR2.5b transport lifecycle review (PR #73)

PR #73 gives the Launcher port an abort signal and gives the local HTTP
transport a lifecycle. The driver's launch deadline tells the launcher when it
stops waiting, the worker's wake ping has a deadline, both loopback servers set
header and request limits, and each server closes in a stated order. It passed
every local gate, including the unfiltered mutation audit and the base gate,
and its CI was green. One full review then confirmed, with probes and with main
as the control, the claims that carry the change: an aborted launch is exactly
a timed-out launch, the run in the relay case completes once, all eight red
cases were red at their commits, and the new cases do not depend on the wall
clock. It found no HIGH and no MEDIUM. It found three LOW and wrote two notes.
Four findings are counted here: a sentence of DESIGN.md that was narrower than
the code, two pin cases that could not fail for the reason they name, a wrapper
of the port that dropped an argument of the port, and, under the review's
second note, a code comment that said the opposite of what the reviewer's probe
showed.

**This document is adversarial toward the MACHINERY and blameless toward
people.** Never "who wrote it", "should have noticed", "was careless" — those
explain nothing and are not actionable. Always "what would have made this
unwritable, or caught it without a human looking". Every section below asks a
question whose comfortable answer is the wrong one; if a section is easy to
fill in, it has not been answered yet.

## Severity

Nothing here could lose, duplicate or misattribute durable state, and nothing a
caller can reach today behaved wrongly. What would have shipped is a test file
and a specification that said more than was so.

The worst finding is the pair of pins. The pull request claims that a request
rejected with a body leaves its kept-alive connection usable, because the
platform discards what is left of a request body once its response has
finished, and it added two cases to pin that. Their bodies were 1,000 and 5
bytes. A body that small fits in the request stream's buffer, so the parser
swallows it whether or not the platform discards it, and both cases passed with
the discard switched off. On the day the platform stopped discarding, a
rejected upload would wedge the launcher's kept-alive connection, every launch
after it on that connection would fail, and the two cases written to say so
would still be green.

The second is the sentence in DESIGN.md section 3.9 about the worker server's
`close()`. It said that `close()` waits for the connections that hold a
request. It waits for every connection that is still open, and one that never
sent a byte holds it for its whole bound of five seconds. The reviewer measured
5.0 s with a silent client, where main's `close()` took no time, and 3.9 s with
the connection that fetch's pool opens after an aborted launch. A host author
who read the specification would not have expected either.

The third is a comment beside the two servers' limits. It said that a request
which outlives them is a client that stalled. The reviewer showed the other
case: a request that had arrived whole was answered 408 because the server's
own event loop stalled between the accept and the first read. The cost is one
failed launch, which the lease recovers, but the comment pointed a reader of
that 408 at the client.

The fourth is latent. The wrapper that gives a launch its deadline declared the
invocation alone, so it dropped any options its own caller passed. Its only
caller, `tick()`, passes none. The first caller to hand the loop's launcher a
signal would have had it ignored in silence.

## Findings

| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |
|---|--------|--------|----------------------------------|------------------|-------------------------|
| 1 | DESIGN.md section 3.9 said the worker's `close()` waits for the connections that hold a request. It waits for every open connection, and one that never sent a byte holds it for the whole bound of five seconds | A host that closes a worker beside a silent client, or within four seconds of an aborted launch, waits up to five seconds that the specification did not mention: 5.0 s and 3.9 s measured, against none on main | The author's own notes. The simplify pass had reported this cost before the review, and it went into the pull request's body and not into DESIGN.md | No check reads a sentence of the specification against the code, and the case that holds the bound sends half a request, so no case ever connected and stayed silent | None for the sentence, which is prose (no rung). The red of the behaviour is written down with the option in BUILD.md |
| 2 | The two pin cases sent bodies of 1,000 and 5 bytes, which fit in the request stream's buffer, so both passed with the platform's discard switched off | The property they name would go unheld on the day the platform stopped discarding, and a rejected upload would then fail every later launch on its connection | The rule that a check is seen failing before it is believed: every guard of this repository has a mutation and a named case | The registry mutates lines of this repository. The discard is the platform's, so there is no line to mutate, and the pins were written as passing cases with no control | The pins send one megabyte, and the control was run: with the discard off both fail by their named wait (rung 3, with a control run by hand) |
| 3 | The wrapper that gives a launch its deadline declared the invocation alone and dropped its own caller's options | None today, because `tick()` passes none. The first caller to hand the loop's launcher a signal would have had it ignored in silence | The type of the port | A function that declares fewer parameters satisfies the port, which is what keeps the change additive, so the compiler cannot tell a launcher that ignores the options from a wrapper that loses them | A case and a mutation hold this wrapper (rung 3). Nothing holds wrappers of the port as a class |
| 4 | The comment beside the limits said that a request which outlives them is a client that stalled. A request that arrived whole is answered 408 when this process stalls between the accept and the first read | A reader of such a 408 is pointed at the client. The cost itself is one failed launch, which the lease recovers | No layer reads a comment | The limits are held by reading them back from the live servers, because the platform's timers cannot be driven by the fake clock, so no case ever saw a limit fire | None: the comment and DESIGN.md now say it (no rung) |

## Detection ledger

The branch had passed every local gate before the review read it: the
unfiltered audit with every mutation caught by its exact verdict, the base
gate, the chaos process test five times in a row, and green CI. Its own
machinery had found real things on the way. Scratch experiments against the
unchanged servers found that the wake server's `close()` could be held open for
as long as a client liked, which was on nobody's list. A debug run found that
two new cases waited four seconds on the connection pool's own timer inside a
budget of five. The simplify pass found a line of `close()` with no mutation
and a test harness wrapper that dropped the options. None of those is a finding
of this round. Every counted finding came from the review.

| Detector | Findings | Ours? |
|----------|----------|-------|
| The one full review of PR #73: the built-in review skill as one agent, and the reviewer's own probes with main as the control | 4 | No |
| This project's machinery: the mutation registry and its audit, the cases on real loopback servers, the determinism lint, the published-surface check | 0 | Yes |

Self-catch rate: 0 of 4, or 0% (previous round: 0%, PR #66's, 0 of 9).

One thing this ledger should not hide. The cost in finding 1 was known before
the review: the simplify pass reported it, and it was written into the pull
request's body. It is still the review's finding, because the specification is
where it had to be said and the review is what put it there.

## Recurrence

**A sentence that says more, or less, than the code (findings 1 and 4).** This
class recurs. The review of PR #68 counted three things that pull request said,
or left unsaid, that were not so, and the review of PR #63 counted sentences of
DESIGN.md and BUILD.md that said more than was held or measured. No earlier round instituted a
mechanism against it, and PR #68's postmortem gives the reason in its evidence:
no test reads prose. So the class is met in each round by the review and by
nothing else, and this round adds no mechanism either. What made finding 1
checkable was the reviewer's probe, a client that connects and says nothing.
That probe is recorded with the option in BUILD.md as its ready-made red, so
the sentence gets a reader on the day the option is built, and not before.

**A hold that could not fail (finding 2).** This class recurs as well: the
review of PR #63 counted four holds that read as protection and could not
fail. The
mechanism this repository has against it is the mutation registry, which
proves for every registered guard that its named case fails. It did not reach
the pins because of what it checks: it mutates lines of this repository. The
pins hold a behaviour of the platform, there is no line of ours to mutate, and
so nothing in the build ever saw the pins fail. The registry checks that a case
can fail for a fault in our source. The property is that a case can fail for
the fault it names, and for a pin of someone else's behaviour those are
different things.

**A wrapper that lags the port it wraps (finding 3).** No earlier postmortem
records this class. It did recur inside this pull request. The simplify pass
found the same defect in the e2e harness's launcher, which dropped the options,
and that instance was fixed. No sweep for the class followed, although the
watchdog's wrapper was twenty lines of the same diff. An instance was fixed
where a class had been shown.

## Mechanism audit — the false negative of each

| Mechanism | Rung | Code that still has the bug and still passes |
|-----------|------|----------------------------------------------|
| The pins send a body larger than the request stream can buffer | 3 | The pins as first committed, with bodies of 1,000 and 5 bytes, run with `IncomingMessage.prototype._dump` replaced by a function that does nothing: both pass, 2 of 2, in the same run in which the pins as they are now both fail. A later edit that shrinks the body, or a platform whose buffer grows past one megabyte, passes again with the discard gone. Nothing would notice, because the control that showed the pins failing is a run by hand and not a case |
| A case and a mutation for the wrapper of the launch deadline | 3 | `launch: (inv) => launcherRef.launch(inv)`, the e2e harness's launcher as it stood before this pull request's simplify fold. It drops the options, and every gate was green with it, the unfiltered audit included. A new wrapper of the port written that way passes everything today, and the dogfood host's wrapper is written that way now, on purpose: nothing hands it options and the launcher inside it ignores a signal |
| The corrected sentences of DESIGN.md and the two comments in `http.ts` | none | They are prose, and no code passes or fails them. The sentence about `close()` could be made false again by the next change to `close()` with every gate green |

## Fix-induced defects

None in this round. It had one review and one fold, and no review follows the
fold by the maintainer's direction, so the fold was re-tested and not re-read:
the gates it touches ran on its head, and the unfiltered audit and the base
gate ran again after main was merged in.

The behaviour in finding 1 was itself introduced by a fix, before the review.
The pull request's own red showed that the old `close()` dropped the ack of a
launch on the wire, and the fix, which waits for open connections, is what
made `close()` wait for a silent one. That cost was seen before the review and
written down in the wrong place.

## Evidence

- Red tests: none of this round's own for findings 1 and 4, so this line cites no commit. They are a sentence of DESIGN.md and a comment, and no test reads prose.
- Fixes: commit `b1d1ae2` corrects both, in DESIGN.md section 3.9 and in the two comments of `packages/driver/src/http.ts`, states the review's two notes beside them, and records the option in BUILD.md. Behaviour is unchanged.
- Red tests: none of this round's own for finding 2, so this line cites no commit. The pins were the cases at fault, and the platform's discard is not a line of this repository, so there was no source to leave unfixed under a failing case. A control stands in its place: the platform's discard was switched off by replacing `IncomingMessage.prototype._dump` with a function that does nothing.
- Fixes: commit `9759b98` gives both pins a body of one megabyte. Under the control both then fail by their named wait, "timed out waiting for: three answers on one connection", and the pins as first committed pass under the same control, which is the defect. With the platform as it is, all eleven cases of the file pass.
- Red tests: none of this round's own for finding 3, so this line cites no commit. Nothing calls the wrapper with options, and no case could reach it before it was exported for one. The maintainer's direction for this fold was that none of it needs a red commit.
- Fixes: commit `02586cf` hands the caller's signal on, adds the case, registers one mutation and re-aims another at the rewritten line. Gate after the fix: the affected closure, thirteen mutations of thirteen caught by their exact verdict with none collateral, and the gates the fold touches, all green on that head: typecheck, lint, the format check, the ten source checkers, the driver suite, the two changed test files five times in a row, the chaos process test, the package smoke with its published-surface check, the registry's count and finds by import of a copy, and the registry's self-test. After main was merged in by commit id, a short list ran once on the merged head: the same gates, the unfiltered audit with every one of 952 mutations caught by its exact verdict and none collateral, and the base gate against that commit of main with this branch's arm applied. One line of that list stopped within a second on the author's own script, which looked for the bridge step by a name that main had changed. The base gate then ran alone on the same head and passed.
- Finder: the one full review of PR #73. Its verdict: "No HIGH or MEDIUM findings. Three LOW findings, two notes, and one fact you need before pushing: main moved during the review, so the base gate arm's key is stale."
- What the review confirmed, with its own probes and main as the control. Every late answer it tried after an abort (accepted, a rejection, a forged object, a claimed ending) left task rows, run rows and counters equal to a launcher that never hears the abort, and the guard case failed when the loop was bent to read the late answer. The relay case completes exactly once. All eight red cases were red by test name at their red commits. After `server.close()` the runtime stops checking its header and request timeouts, on the supported version: an open server dropped a silent client at 1.2 s, and a closed one never did. Two mutations applied by hand died by their exact markers. Four concurrent runs of the two changed test files at a load of 35 to 48 all passed.
- What is not counted. The review's first note: no case covers a launch whose body is still executing when the driver gives up. The reviewer probed it at the head and on main and the rows were identical, nothing the pull request said about it was false, and exit test line 15 is met as worded. DESIGN.md now says what starts the second body and what makes it harmless, and names the four existing cases that hold the pieces. The built-in skill's other two findings: "an ack dropped at the bound" was refuted by the reviewer, with 200 of 200 acks delivered when the force-close ran in the same tick as the answer, and "three copies of a cancellable sleep" is a simplify candidate this pull request had already rejected with a written reason.
- Why four and not three. The review's second note is a cost that DESIGN.md did not state, and a cost left unstated is not a finding by this project's rule. The comment beside the limits went further than silence: it said a request that outlives the limits is a client that stalled, and the reviewer's probe showed the server stalling. A claim about the change that was false counts, so finding 4 is the comment and not the note.

## Root cause

Each of the four is a claim that nothing in the build had ever seen false. The
pins claimed a behaviour of the platform and were never run with that
behaviour switched off. The two sentences claimed what `close()` waits for and
who stalls, and prose has no reader but a reviewer. The wrapper claimed to be a
launcher like any other, and its one caller never passes the argument it
dropped. This repository's machinery is strong where a claim is a line of its
own source, because a mutation can then show the claim's case failing. It is
silent where the claim is about the platform, is written in a sentence, or
concerns an argument nobody passes yet.

## Mechanisms

Built in this PR:

- The two pins send one megabyte, past what the request stream buffers, and say
  in the file why the size matters. With the platform's discard switched off
  both fail by their named wait. Rung 3, with a control run by hand. They live
  in `packages/driver/test/http-lifecycle.test.ts`.
- A case and a registered mutation for the wrapper of the launch deadline: a
  caller's abort reaches the wrapped launcher with the clock where it was.
  Rung 3. The case is in `packages/driver/test/loop.test.ts`.
- DESIGN.md section 3.9 and the two comments in `packages/driver/src/http.ts`
  state what `close()` waits for and what it costs, that the limits bound this
  process's own stalls, and that the timeout, not the abort, is what can start
  a second body of a run. These are statements and not mechanisms.

Deferred (recorded in BUILD.md):

- Ending the connections that never sent a byte when the worker server's
  `close()` begins. It changes behaviour, so it needs its own red, and the
  reviewer's silent-client probe is that red, written down with the option and
  its trigger. Deferral is acceptable because the wait is bounded at five
  seconds, happens only at shutdown, and no host of this repository calls
  `close()` on a path where those seconds matter.
- A standing control for the two pins, a case that switches the platform's
  discard off and expects the pins' scenario to wedge. It is recorded as an
  option with its trigger. Deferral is acceptable because the control was run
  once by hand on the supported runtime, and because a standing one would hang
  a test on a private method of the platform.

## What this round still would not catch

- A sentence of DESIGN.md or a comment that the next change makes false ships
  today with every gate green. Nothing reads prose against code.
- A pin of a platform behaviour that cannot fail for the reason it names ships
  today if its author does not switch that behaviour off once by hand. The two
  pins of this pull request would go blind again if their body shrank or the
  platform's buffer grew, and nothing would say so.
- A new wrapper of the Launcher port that drops the options ships today. The
  compiler accepts it by the same rule that keeps the port additive, and the
  one case that exists holds one wrapper.
- A launch whose body is still executing when the driver gives up has no case
  through the HTTP transport. The reviewer probed it at the head and on main
  and the rows are identical, and four existing cases hold its pieces, but a
  change that broke the whole path and none of the pieces would ship.
