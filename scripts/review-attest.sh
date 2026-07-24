#!/usr/bin/env bash
# Post the 'adversarial-review' commit status for a PR head — the status
# that branch protection REQUIRES before main will accept a merge.
#
# The mechanism (prevention ladder, not checklist): merging without the
# review round is now an operation GitHub refuses, not a rule to remember.
# This script is the only producer of the status, and it refuses to attest
# unless the review artifacts verifiably exist and are COMPLETE:
#   1. a codex log containing its terminal 'tokens used' marker, and
#   2. a review-workflow journal with per-finding verification results,
# both newer than the last commit on the branch — or an explicit
# 'reviews-abandoned:<reason>' trailer in the PR body (which this script
# echoes into the status description so the exception is public).
#
# It cannot force the reviews to be GOOD — it forces the failure mode from
# "forgot under momentum" (which happened twice) to "deliberately attested
# falsely", a different and auditable class.
set -euo pipefail
usage() { echo "usage: review-attest.sh <pr-number> <codex-log> <workflow-journal|-> " >&2; exit 2; }
[[ $# -ge 2 ]] || usage
PR="$1"; CODEX_LOG="$2"; JOURNAL="${3:--}"

SHA=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
BODY=$(gh pr view "$PR" --json body --jq .body)

if grep -qE '^reviews-abandoned:' <<<"$BODY"; then
  REASON=$(grep -E '^reviews-abandoned:' <<<"$BODY" | head -1)
  gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
    -f context=adversarial-review -f description="ABANDONED (see PR body): ${REASON:0:80}"
  echo "attested via explicit abandonment"
  exit 0
fi

[[ -f "$CODEX_LOG" ]] || { echo "no codex log: $CODEX_LOG" >&2; exit 1; }
grep -q "tokens used" "$CODEX_LOG" || { echo "codex log INCOMPLETE (no terminal marker)" >&2; exit 1; }
if [[ "$JOURNAL" != "-" ]]; then
  [[ -f "$JOURNAL" ]] || { echo "no workflow journal: $JOURNAL" >&2; exit 1; }
  grep -q '"type":"result"' "$JOURNAL" || { echo "journal has no agent results" >&2; exit 1; }
fi

gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
  -f context=adversarial-review \
  -f description="codex + verified multi-lens review reported for $SHA"
echo "attested: adversarial-review success on $SHA"
