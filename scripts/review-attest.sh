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
usage() {
  echo "usage: review-attest.sh <pr-number> <codex-log> <workflow-journal|->" >&2
  echo "       review-attest.sh --check-postmortem <path>" >&2
  exit 2
}

# One parser owns both sides of the arithmetic. The earlier global row count
# and permissive ledger pipeline were two hand-kept views: a prose ledger (or
# any malformed ledger the pipeline reduced to nothing) skipped validation.
# The offline entry point below exercises this exact path without GitHub.
check_postmortem_tables() {
  local path="$1" content="$2"
  awk -v path="$path" '
    BEGIN {
      findings_header = "| # | Defect | Impact | Layer that should have caught it | Why it could not | Mechanism (ladder rung) |"
      findings_separator = "|---|--------|--------|----------------------------------|------------------|-------------------------|"
      ledger_header = "| Detector | Findings | Ours? |"
      ledger_separator = "|----------|----------|-------|"
    }

    function reject(message) {
      print "SEV rule: postmortem " path " " message > "/dev/stderr"
      failed = 1
      exit 1
    }

    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }

    function parse_row(line, expected, table,    i, character, escaped, count, value, key) {
      for (key in cells) {
        delete cells[key]
      }
      if (substr(line, 1, 1) != "|" || substr(line, length(line), 1) != "|") {
        reject("has a " table " row without leading and trailing pipes")
      }

      for (i = 2; i < length(line); i++) {
        character = substr(line, i, 1)
        if (escaped) {
          value = value character
          escaped = 0
        } else if (character == "\\") {
          value = value character
          escaped = 1
        } else if (character == "|") {
          cells[++count] = value
          value = ""
        } else {
          value = value character
        }
      }
      if (escaped) {
        reject("has a " table " row whose trailing pipe is escaped")
      }
      cells[++count] = value
      if (count != expected) {
        reject("has a " table " row with " count " data cells; expected exactly " expected)
      }
      return count
    }

    /^## Findings$/ {
      findings_sections++
      if (findings_sections > 1) {
        reject("has more than one exact ## Findings section")
      }
      section = "findings"
      next
    }

    /^## Detection ledger$/ {
      ledger_sections++
      if (ledger_sections > 1) {
        reject("has more than one exact ## Detection ledger section")
      }
      section = "ledger"
      next
    }

    /^## / {
      section = ""
      next
    }

    section == "findings" && $0 == findings_header {
      findings_headers++
      if (findings_headers > 1 || findings_done) {
        reject("has more than one canonical findings table")
      }
      expect_findings_separator = 1
      next
    }

    section == "findings" && expect_findings_separator {
      if ($0 != findings_separator) {
        reject("does not put the exact template separator below its findings header")
      }
      expect_findings_separator = 0
      in_findings = 1
      next
    }

    section == "findings" && in_findings {
      if ($0 ~ /^\|/) {
        parse_row($0, 6, "findings")
        finding = trim(cells[1])
        if (finding !~ /^[0-9]+$/) {
          reject("has a non-numeric row in its canonical findings table")
        }
        findings_rows++
        next
      }
      in_findings = 0
      findings_done = 1
    }

    section == "findings" && !findings_headers && $0 ~ /^\|/ {
      reject("has an unexpected pipe-delimited block before its canonical findings table")
    }

    section == "findings" && findings_done && $0 ~ /^\|/ {
      reject("has a second pipe-delimited block in its Findings section")
    }

    section == "ledger" && $0 == ledger_header {
      ledger_headers++
      if (ledger_headers > 1 || ledger_done) {
        reject("has more than one canonical detection ledger table")
      }
      expect_ledger_separator = 1
      next
    }

    section == "ledger" && expect_ledger_separator {
      if ($0 != ledger_separator) {
        reject("does not put the exact template separator below its detection ledger header")
      }
      expect_ledger_separator = 0
      in_ledger = 1
      next
    }

    section == "ledger" && in_ledger {
      if ($0 ~ /^\|/) {
        parse_row($0, 3, "detection ledger")
        expression = cells[2]
        gsub(/\*\*/, "", expression)
        gsub(/[[:space:]]/, "", expression)
        if (expression !~ /^[0-9]+(\+[0-9]+)*$/) {
          reject("has a malformed Findings cell in its detection ledger")
        }
        term_count = split(expression, terms, "[+]")
        for (i = 1; i <= term_count; i++) {
          ledger_sum += terms[i]
        }
        ledger_rows++
        ledger_expression = ledger_expression (ledger_expression == "" ? "" : "+") expression
        next
      }
      in_ledger = 0
      ledger_done = 1
    }

    section == "ledger" && !ledger_headers && $0 ~ /^\|/ {
      reject("has an unexpected pipe-delimited block before its canonical detection ledger table")
    }

    section == "ledger" && ledger_done && $0 ~ /^\|/ {
      reject("has a second pipe-delimited block in its Detection ledger section")
    }

    END {
      if (failed) {
        exit 1
      }
      if (findings_sections != 1) {
        reject("must contain exactly one exact ## Findings section")
      }
      if (findings_headers != 1 || findings_rows == 0) {
        reject("has no parsable findings rows under the exact template header")
      }
      if (ledger_sections != 1) {
        reject("must contain exactly one exact ## Detection ledger section")
      }
      if (ledger_headers != 1 || ledger_rows == 0) {
        reject("has no parsable detection ledger rows under the exact template header")
      }
      if (ledger_sum == 0) {
        reject("has a zero-total detection ledger for a non-empty findings table")
      }
      if (ledger_sum != findings_rows) {
        message = "has " findings_rows " findings but its detection ledger accounts for " ledger_sum " (" ledger_expression ")"
        reject(message)
      }
      print findings_rows
    }
  ' <<<"$content"
}

if [[ "${1:-}" == "--check-postmortem" ]]; then
  [[ $# -eq 2 ]] || usage
  [[ -f "$2" ]] || { echo "no postmortem: $2" >&2; exit 1; }
  CONTENT=$(<"$2")
  ROWS=$(check_postmortem_tables "$2" "$CONTENT")
  echo "SEV rule satisfied: $ROWS findings accounted for in $2"
  exit 0
fi

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
  TOTAL_ROWS=0
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    CONTENT=$(gh api "repos/{owner}/{repo}/contents/$f?ref=$SHA" --jq .content | base64 -d)
    # A postmortem is what the template says a postmortem is. Other documents
    # are allowed to live here and are simply not candidates.
    head -1 <<<"$CONTENT" | grep -q '^# Postmortem' || continue
    PM_FILES="$PM_FILES$f"$'\n'
    # -e on every pattern below is load-bearing, not style. Six template
    # placeholder lines begin with '-', and grep parsed those as OPTIONS and
    # exited 2. For the section check that failed CLOSED (the || fired), but
    # for the placeholder check the && short-circuited and read as "the
    # placeholder is absent" — so a verbatim copy of the template passed on
    # exactly those six lines. A checker that fails open is worse than none.
    while IFS= read -r section; do
      grep -qF -e "$section" <<<"$CONTENT" || {
        echo "SEV rule: postmortem $f is missing required section '$section'" >&2; exit 1; }
    done <<<"$REQ_SECTIONS"
    while IFS= read -r slot; do
      grep -qF -e "$slot" <<<"$CONTENT" && {
        echo "SEV rule: postmortem $f still contains the template line '$slot' — fill it in" >&2
        exit 1; }
    done <<<"$PLACEHOLDERS"
    # An author's own deferral marker is an unfinished postmortem too.
    grep -qE -e '<!--[[:space:]]*(TODO|filled in)' <<<"$CONTENT" && {
      echo "SEV rule: postmortem $f still carries an unfilled-section marker" >&2; exit 1; }
    ROWS=$(check_postmortem_tables "$f" "$CONTENT")
    TOTAL_ROWS=$((TOTAL_ROWS + ROWS))
  done <<<"$ADDED"

  if [[ -z "$PM_FILES" ]]; then
    echo "SEV rule: review-findings: $DECLARED declared but the PR ADDS no postmortem" >&2
    echo "  (a postmortem is a postmortems/*.md whose first line begins '# Postmortem';" >&2
    echo "   copy postmortems/TEMPLATE.md)" >&2
    exit 1
  fi
  # The declared count and the documented findings must agree. Requiring
  # merely "at least one row" let 'review-findings: 8' be satisfied by a
  # postmortem describing one, which is the SEV rule met in form and skipped
  # in substance.
  if [[ "$TOTAL_ROWS" -lt "$DECLARED" ]]; then
    echo "SEV rule: review-findings: $DECLARED declared but the added postmortem(s)" >&2
    echo "  document only $TOTAL_ROWS finding(s). Every declared finding needs a row." >&2
    exit 1
  fi
  echo "SEV rule satisfied: $DECLARED findings declared, $TOTAL_ROWS documented, postmortem(s) added with all required sections:"
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

# A review artifact is a transient LOG, never a file that lives in the repo.
# Without this, the checker's own source satisfied it: this script contains
# both marker strings, so passing scripts/review-attest.sh as both the codex
# log and the journal produced a green status with no review at all. Anything
# git tracks here is evidence of nothing.
reject_repo_file() {
  local path="$1" what="$2"
  if git ls-files --error-unmatch "$path" >/dev/null 2>&1; then
    echo "$what is a file tracked in this repository ($path)." >&2
    echo "  A review artifact is a transient log. A checked-in file proves nothing —" >&2
    echo "  including this script, which contains both marker strings." >&2
    exit 1
  fi
}

[[ -f "$CODEX_LOG" ]] || { echo "no codex log: $CODEX_LOG" >&2; exit 1; }
reject_repo_file "$CODEX_LOG" "codex log"
# Two checks, because one is not enough and the obvious one is a trap.
#
# 'tokens used' must be codex's own terminal line, not the phrase appearing
# anywhere: a substring match accepted any file that merely mentions the
# words, this script included.
#
# But it does NOT mean the review finished. Measured against two real logs: a
# round killed partway by an upstream content filter ALSO ends with that
# marker — codex prints it whether it completed or aborted. Requiring the
# marker near the end is worse than useless, because a completed round keeps
# printing its verdict afterwards while an aborted one stops right there; that
# rule would have rejected the good log and attested the dead one.
#
# What actually separates them is how the log ENDS: a round that died stops on
# an error, a round that finished stops on its findings.
grep -qx 'tokens used' "$CODEX_LOG" || {
  echo "codex log INCOMPLETE: no terminal 'tokens used' line." >&2
  echo "  A round that never reached its end must not attest." >&2
  exit 1; }
if tail -5 "$CODEX_LOG" | grep -qE '^(ERROR|error):'; then
  echo "codex log ENDS IN AN ERROR — the round aborted rather than finishing:" >&2
  tail -5 "$CODEX_LOG" | grep -E '^(ERROR|error):' | head -2 >&2
  echo "  Re-run the review, or declare 'reviews-abandoned:<reason>' in the PR body," >&2
  echo "  which says so publicly instead of quietly." >&2
  exit 1
fi
if [[ "$JOURNAL" != "-" ]]; then
  [[ -f "$JOURNAL" ]] || { echo "no workflow journal: $JOURNAL" >&2; exit 1; }
  reject_repo_file "$JOURNAL" "workflow journal"
  grep -q '"type":"result"' "$JOURNAL" || { echo "journal has no agent results" >&2; exit 1; }
fi

RAN="codex"
[[ "$JOURNAL" != "-" ]] && RAN="codex + verified multi-lens review"
gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
  -f context=adversarial-review \
  -f description="$RAN reported for $SHA; review-findings: $DECLARED"
echo "attested: adversarial-review success on $SHA (review-findings: $DECLARED)"
