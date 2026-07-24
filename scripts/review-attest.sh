#!/usr/bin/env bash
# Post the 'adversarial-review' commit status for a PR head — the status
# that branch protection REQUIRES before main will accept a merge.
#
# The mechanism (prevention ladder, not checklist): merging without the
# review round is now an operation GitHub refuses, not a rule to remember.
# This script is the only producer of the status, and it refuses to attest
# unless ALL of the following hold:
#
#   1. The PR body declares 'review-findings: <count>' — mandatory, so a
#      round can never silently claim nothing was found. 0 is a public,
#      auditable claim that no review round found bugs (e.g. red commits
#      on the branch were caught by the author's own machinery, not by
#      review).
#   2. A nonzero count requires the PR to ADD (not merely touch or rename)
#      a postmortems/*.md containing every '## ' section of
#      postmortems/TEMPLATE.md, with its placeholders filled and at least
#      one row in its findings table. This is the SEV rule (CLAUDE.md).
#   3. The review artifacts verifiably COMPLETED: a codex log containing
#      its terminal 'tokens used' marker, and a review-workflow journal
#      with per-finding results — or an explicit 'reviews-abandoned:<reason>'
#      trailer in the PR body (echoed into the public status description).
#      Abandonment excuses the ARTIFACTS of reviews that never completed;
#      it never excuses the postmortem obligation, which is checked first.
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

# --- SEV gate (runs FIRST: nothing below may skip it) -----------------------

DECLARED=$(sed -nE 's/^review-findings:[[:space:]]*([0-9]+).*$/\1/p' <<<"$BODY" | head -1)
if [[ -z "$DECLARED" ]]; then
  echo "SEV rule: the PR body must carry a 'review-findings: <count>' line." >&2
  echo "  0 publicly claims no review round found bugs (red commits, if any," >&2
  echo "  were caught by the author's own machinery). A nonzero count" >&2
  echo "  requires a postmortem added in this PR (see postmortems/TEMPLATE.md)." >&2
  exit 1
fi
DECLARED=$((10#$DECLARED))

HEADLINES=$(gh pr view "$PR" --json commits --jq '.commits[].messageHeadline')
if [[ "$DECLARED" -eq 0 ]] && grep -qE '^RED[: ]' <<<"$HEADLINES"; then
  echo "note: branch carries RED commits while declaring review-findings: 0 —"
  echo "  that claim is public and auditable against the commit log."
fi

if [[ "$DECLARED" -gt 0 ]]; then
  # ADDED files only: a whitespace edit or rename of an existing postmortem
  # must not satisfy a new round's obligation (and deleted/renamed paths
  # must not 404 the content fetch below).
  PM_FILES=$(gh api "repos/{owner}/{repo}/pulls/$PR/files" --paginate \
    --jq '.[] | select(.status == "added") | .filename' \
    | grep -E '^postmortems/.*\.md$' | grep -vx 'postmortems/TEMPLATE.md' || true)
  if [[ -z "$PM_FILES" ]]; then
    echo "SEV rule: review-findings: $DECLARED declared but the PR ADDS no postmortems/*.md — refusing to attest" >&2
    exit 1
  fi
  # Required sections come from the template itself — one definition, no
  # drift between the checker and what authors copy.
  mapfile -t REQ_SECTIONS < <(grep -E '^## ' "$(dirname "$0")/../postmortems/TEMPLATE.md")
  [[ "${#REQ_SECTIONS[@]}" -gt 0 ]] || { echo "cannot read required sections from postmortems/TEMPLATE.md" >&2; exit 1; }
  while IFS= read -r f; do
    CONTENT=$(gh api "repos/{owner}/{repo}/contents/$f?ref=$SHA" --jq .content | base64 -d)
    for section in "${REQ_SECTIONS[@]}"; do
      grep -qF "$section" <<<"$CONTENT" || {
        echo "SEV rule: postmortem $f is missing required section '$section'" >&2; exit 1; }
    done
    if grep -qF '<hash>' <<<"$CONTENT" || grep -qF '<round name>' <<<"$CONTENT"; then
      echo "SEV rule: postmortem $f still contains template placeholders — fill it in" >&2
      exit 1
    fi
    grep -qE '^\| [0-9]' <<<"$CONTENT" || {
      echo "SEV rule: postmortem $f has an empty findings table" >&2; exit 1; }
  done <<<"$PM_FILES"
  echo "SEV rule satisfied: $DECLARED findings declared, postmortem(s) added with all required sections:"
  echo "$PM_FILES"
fi

# --- artifact completeness (or explicit public abandonment) -----------------

if grep -qE '^reviews-abandoned:' <<<"$BODY"; then
  REASON=$(grep -E '^reviews-abandoned:' <<<"$BODY" | head -1)
  gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
    -f context=adversarial-review -f description="ABANDONED (see PR body): ${REASON:0:80}"
  echo "attested via explicit abandonment (SEV gate above still enforced)"
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
  -f description="codex + verified multi-lens review reported for $SHA; review-findings: $DECLARED"
echo "attested: adversarial-review success on $SHA (review-findings: $DECLARED)"
