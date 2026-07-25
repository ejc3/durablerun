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
#      a postmortem containing every '## ' section of
#      postmortems/TEMPLATE.md, with its placeholders filled and at least
#      one row in its findings table. This is the SEV rule (CLAUDE.md).
#      A postmortem is identified the same way the template defines one —
#      by its '# Postmortem' heading — so other documents may live in
#      postmortems/ without being mistaken for one. Selecting by directory
#      instead made this gate refuse the very branch that introduced it,
#      whose design notes live there too; a mechanism that can only be
#      satisfied by mangling good documents teaches people to bypass it.
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
  ADDED=$(gh api "repos/{owner}/{repo}/pulls/$PR/files" --paginate \
    --jq '.[] | select(.status == "added") | .filename' \
    | grep -E '^postmortems/.*\.md$' | grep -vx 'postmortems/TEMPLATE.md' || true)

  TEMPLATE="$(dirname "$0")/../postmortems/TEMPLATE.md"
  # Everything the checker demands is READ FROM THE TEMPLATE, so adding a
  # section or a placeholder there extends this gate automatically and the
  # checker can never describe a different document than authors copy.
  REQ_SECTIONS=$(grep -E '^## ' "$TEMPLATE")
  [[ -n "$REQ_SECTIONS" ]] || { echo "cannot read required sections from $TEMPLATE" >&2; exit 1; }
  # A placeholder is any template LINE carrying an angle-bracket slot. Taking
  # whole lines catches the multi-line prose slots too, which a '<[^>]*>'
  # match cannot see — those were most of them, so naming two by hand let a
  # verbatim copy of the template attest.
  PLACEHOLDERS=$(grep -F '<' "$TEMPLATE" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$')
  [[ -n "$PLACEHOLDERS" ]] || { echo "cannot read placeholders from $TEMPLATE" >&2; exit 1; }

  PM_FILES=""
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    CONTENT=$(gh api "repos/{owner}/{repo}/contents/$f?ref=$SHA" --jq .content | base64 -d)
    # A postmortem is what the template says a postmortem is. Other documents
    # are allowed to live here and are simply not candidates.
    head -1 <<<"$CONTENT" | grep -q '^# Postmortem' || continue
    PM_FILES="$PM_FILES$f"$'\n'
    while IFS= read -r section; do
      grep -qF "$section" <<<"$CONTENT" || {
        echo "SEV rule: postmortem $f is missing required section '$section'" >&2; exit 1; }
    done <<<"$REQ_SECTIONS"
    while IFS= read -r slot; do
      grep -qF "$slot" <<<"$CONTENT" && {
        echo "SEV rule: postmortem $f still contains the template line '$slot' — fill it in" >&2
        exit 1; }
    done <<<"$PLACEHOLDERS"
    # An author's own deferral marker is an unfinished postmortem too.
    grep -qE '<!--[[:space:]]*(TODO|filled in)' <<<"$CONTENT" && {
      echo "SEV rule: postmortem $f still carries an unfilled-section marker" >&2; exit 1; }
    grep -qE '^\| [0-9]' <<<"$CONTENT" || {
      echo "SEV rule: postmortem $f has an empty findings table" >&2; exit 1; }
  done <<<"$ADDED"

  if [[ -z "$PM_FILES" ]]; then
    echo "SEV rule: review-findings: $DECLARED declared but the PR ADDS no postmortem" >&2
    echo "  (a postmortem is a postmortems/*.md whose first line begins '# Postmortem';" >&2
    echo "   copy postmortems/TEMPLATE.md)" >&2
    exit 1
  fi
  echo "SEV rule satisfied: $DECLARED findings declared, postmortem(s) added with all required sections:"
  printf '%s' "$PM_FILES"
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

RAN="codex"
[[ "$JOURNAL" != "-" ]] && RAN="codex + verified multi-lens review"
gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
  -f context=adversarial-review \
  -f description="$RAN reported for $SHA; review-findings: $DECLARED"
echo "attested: adversarial-review success on $SHA (review-findings: $DECLARED)"
