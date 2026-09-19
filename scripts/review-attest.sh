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
#      Every commit such a postmortem cites must be on the pull request's
#      branch, and its red tests and fixes must be real, distinct, and
#      ordered, because a commit id does not survive a rebase
#      (check_postmortem_commits below). '--check-postmortem <path>
#      --prove-reds' also runs the probe each cited red test names.
#   3. The review artifacts match THIS HEAD and verifiably COMPLETED: a codex
#      log containing exactly one matching 'review-head:' line and its
#      'tokens used' completion marker, and a review-workflow journal with
#      exactly one matching review-head record and per-finding results — or an explicit
#      'reviews-abandoned:<non-empty reason>' trailer in the PR body (echoed
#      into the public status description).
#      Abandonment excuses the ARTIFACTS of reviews that never completed;
#      it never excuses the postmortem obligation, which is checked first.
#
# It cannot force the reviews to be GOOD — it forces the failure mode from
# "forgot under momentum" (which happened twice) to "deliberately attested
# falsely", a different and auditable class.
set -euo pipefail
usage() {
  echo "usage: review-attest.sh <pr-number> <codex-log> <workflow-journal|->" >&2
  echo "       review-attest.sh --check-postmortem <path> [<head>] [--prove-reds]" >&2
  echo "       review-attest.sh --check-codex-log <path> <head>" >&2
  echo "       review-attest.sh --check-journal <path> <head>" >&2
  echo "       review-attest.sh --check-pr-body <path>" >&2
  exit 2
}

# Both are found from this script, as the template always was, so a copy of the
# script in another tree judges that tree.
REPO="$(dirname "$0")/.."
TEMPLATE="$REPO/postmortems/TEMPLATE.md"

# The marker is a whole line but deliberately need not be the last one: a
# completed Codex run prints its verdict afterward, while a failed stream can
# print the marker and then stop on an unprefixed 429. Head identity and the
# terminal error shape are therefore independent checks.
check_codex_log() {
  local path="$1" expected_head="$2" actual_head head_count aborts
  [[ -f "$path" ]] || { echo "no codex log: $path" >&2; return 1; }
  [[ -n "$expected_head" ]] || {
    echo "codex log check requires a non-empty expected review head." >&2
    return 1
  }

  head_count=$(grep -cE '^review-head:' "$path" || true)
  if [[ "$head_count" -ne 1 ]]; then
    echo "codex log is not bound to a review head (found $head_count review-head lines)." >&2
    return 1
  fi
  actual_head=$(sed -nE 's/^review-head:[[:space:]]*(.*)$/\1/p' "$path")
  actual_head=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$actual_head")
  if [[ -z "$actual_head" ]]; then
    echo "codex log is not bound to a review head (the review-head value is empty)." >&2
    return 1
  fi
  if [[ "$actual_head" != "$expected_head" ]]; then
    echo "codex log reviewed $actual_head, expected $expected_head." >&2
    return 1
  fi

  grep -qxF 'tokens used' "$path" || {
    echo "codex log INCOMPLETE: no terminal 'tokens used' line." >&2
    echo "  A round that never reached its end must not attest." >&2
    return 1
  }
  aborts=$(tail -5 "$path" | grep -Ei \
    '^(error|stream error):|unexpected status[[:space:]]+429|429 Too Many Requests' || true)
  if [[ -n "$aborts" ]]; then
    echo "codex log ENDS IN AN ERROR — the round aborted rather than finishing:" >&2
    head -2 <<<"$aborts" >&2
    echo "  Re-run the review, or declare 'reviews-abandoned:<reason>' in the PR body," >&2
    echo "  which says so publicly instead of quietly." >&2
    return 1
  fi
}

check_journal() {
  local path="$1" expected_head="$2" actual_head head_count
  local plan_count complete_count planned completed result_reviewers
  [[ -f "$path" ]] || { echo "no workflow journal: $path" >&2; return 1; }
  [[ -n "$expected_head" ]] || {
    echo "review journal check requires a non-empty expected review head." >&2
    return 1
  }
  if ! jq -e -s 'all(.[]; type == "object")' "$path" >/dev/null 2>&1; then
    echo "review journal is not valid JSON-lines object evidence." >&2
    return 1
  fi

  head_count=$(jq -s '[.[] | select(.type == "review-head")] | length' "$path")
  if [[ "$head_count" -ne 1 ]]; then
    echo "review journal is not bound to a review head (found $head_count review-head records)." >&2
    return 1
  fi
  actual_head=$(jq -r 'select(.type == "review-head") | .head // empty' "$path")
  if [[ -z "$actual_head" ]]; then
    echo "review journal is not bound to a review head (the head value is empty)." >&2
    return 1
  fi
  if [[ "$actual_head" != "$expected_head" ]]; then
    echo "review journal reviewed $actual_head, expected $expected_head." >&2
    return 1
  fi

  plan_count=$(jq -s '[.[] | select(.type == "review-plan")] | length' "$path")
  if [[ "$plan_count" -ne 1 ]]; then
    echo "review journal must contain exactly one review plan (found $plan_count)." >&2
    return 1
  fi
  complete_count=$(jq -s '[.[] | select(.type == "review-complete")] | length' "$path")
  if [[ "$complete_count" -eq 0 ]]; then
    echo "review journal has no terminal completion record." >&2
    return 1
  fi
  if [[ "$complete_count" -ne 1 ]]; then
    echo "review journal must contain exactly one terminal completion record." >&2
    return 1
  fi
  if ! jq -e -s '
      all(.[];
        .type == "review-head"
        or .type == "review-plan"
        or .type == "result"
        or .type == "review-complete"
      )
      and (
        [.[] | select(.type == "review-plan")][0].reviewers as $reviewers
        | ($reviewers | type) == "array"
        and ($reviewers | length) > 0
        and all($reviewers[]; type == "string" and length > 0)
        and ($reviewers | unique | length) == ($reviewers | length)
      )
      and all(
        .[] | select(.type == "result");
        (.reviewer | type) == "string"
        and (.reviewer | length) > 0
        and (.verdict | type) == "string"
        and (.verdict | length) > 0
      )
      and (
        [.[] | select(.type == "review-complete")][0].reviewers
        | type
      ) == "array"
    ' "$path" >/dev/null; then
    echo "review journal has an invalid plan, result, or completion schema." >&2
    return 1
  fi

  planned=$(jq -c -s \
    '[.[] | select(.type == "review-plan")][0].reviewers | sort' "$path")
  completed=$(jq -c -s \
    '[.[] | select(.type == "review-complete")][0].reviewers | sort' "$path")
  if [[ "$completed" != "$planned" ]]; then
    echo "review journal completion inventory differs from its plan." >&2
    return 1
  fi
  result_reviewers=$(jq -c -s \
    '[.[] | select(.type == "result") | .reviewer]' "$path")
  if ! jq -e -s '
      [.[] | select(.type == "result") | .reviewer] as $reviewers
      | ($reviewers | unique | length) == ($reviewers | length)
    ' "$path" >/dev/null; then
    echo "review journal duplicates reviewer results." >&2
    return 1
  fi
  if [[ "$(jq -c 'sort' <<<"$result_reviewers")" != "$planned" ]]; then
    echo "review journal result inventory differs from its plan." >&2
    return 1
  fi
  if ! jq -e -s '.[-1].type == "review-complete"' "$path" >/dev/null; then
    echo "review journal terminal completion record must be last." >&2
    return 1
  fi
  if ! jq -e -s '
      length >= 4
      and .[0].type == "review-head"
      and .[1].type == "review-plan"
      and .[-1].type == "review-complete"
      and all(.[2:-1][]; .type == "result")
    ' "$path" >/dev/null; then
    echo "review journal records are out of lifecycle order." >&2
    return 1
  fi
}

review_findings_count() {
  local body="$1" count line
  count=$(grep -cE '^review-findings:' <<<"$body" || true)
  if [[ "$count" -ne 1 ]]; then
    echo "review-findings must appear exactly once." >&2
    return 1
  fi
  line=$(grep -E '^review-findings:' <<<"$body")
  if ! grep -qE '^review-findings:[[:space:]]*[0-9]+[[:space:]]*$' <<<"$line"; then
    echo "review-findings must be a canonical whole line." >&2
    return 1
  fi
  if ! grep -qE '^review-findings:[[:space:]]*(0|[1-9][0-9]*)[[:space:]]*$' <<<"$line"; then
    echo "review-findings must use canonical decimal notation." >&2
    return 1
  fi
  sed -nE 's/^review-findings:[[:space:]]*([0-9]+)[[:space:]]*$/\1/p' <<<"$line"
}

check_pr_body() {
  local body="$1" count line reason
  review_findings_count "$body" >/dev/null || return 1
  count=$(grep -cE '^reviews-abandoned:' <<<"$body" || true)
  if [[ "$count" -gt 1 ]]; then
    echo "reviews-abandoned must appear at most once." >&2
    return 1
  fi
  if [[ "$count" -eq 1 ]]; then
    line=$(grep -E '^reviews-abandoned:' <<<"$body")
    reason="${line#reviews-abandoned:}"
    reason=$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$reason")
    if [[ -z "$reason" ]]; then
      echo "reviews-abandoned requires a non-empty reason." >&2
      return 1
    fi
  fi
}

abandonment_reason() {
  local body="$1" line reason
  line=$(grep -E '^reviews-abandoned:' <<<"$body" || true)
  [[ -n "$line" ]] || return 0
  reason="${line#reviews-abandoned:}"
  sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$reason"
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

# --- the commits a postmortem cites -----------------------------------------
#
# A postmortem cites its red tests and its fixes by commit id, and an id does
# not survive a rebase. A branch that moves after its postmortem is written
# leaves every id naming a commit the branch no longer holds, and nothing else
# in this gate reads them: one postmortem on main cites eleven commits that
# were never on the branch it merged from, each with a twin there under the
# same subject. So the ids are read here and held to the pull request's head.

# Prints what a postmortem cites, tab separated, in the order it is written.
#
# `commit -1 ID SECTION` is a backticked id of 7 to 40 hex digits anywhere in
# the document. The rest comes from where the template puts commits: the lines
# of its Evidence section that carry a `<hash>` slot, the red tests' first and
# the fixes' second. A postmortem's bullet belongs with a template line when it
# begins with the same word, so "- Fixes, one commit for each finding:" is a
# fixes line, a second round gets a line of its own, and a template that
# renames a line renames what is asked for. No label is spelled in this script.
# A bullet runs until the next one, and its wrapped lines are joined first.
# `label N WORD LABEL` is the template's Nth such line, `line N` a bullet that
# belongs with it, and `commit N ID WORD` an id on one, after the word WORD.
#
# The template line's other slots are read the same way, by the word before
# each. An id straight after the word before `<buggy commit>`, today "against",
# is `commit 0 ID WORD`: the code a red test ran against, neither a red test
# nor a fix. After a red's id, the word before `<test file>`, today "probe",
# names the test that shows it red: `probe FILE`, and `name TEXT` when another
# backticked text follows at once.
cited_commits() {
  local content="$1"
  [[ -s "$TEMPLATE" ]] || { echo "cannot read $TEMPLATE" >&2; return 1; }
  awk -v template="$TEMPLATE" '
    function refuse(message) {
      print "cannot read the evidence lines of " template ": " message > "/dev/stderr"
      refused = 1
      exit 1
    }

    function template_line(line,    fields, word, label, rest, slot, lead) {
      split(line, fields, /[[:space:]]+/)
      word = fields[2]
      sub(/[^[:alnum:]].*$/, "", word)
      if (fields[1] != "-" || word == "" || index(line, ":") == 0) {
        refuse("a line with a `<hash>` slot is not a labelled bullet: " line)
      }
      if (word in seen) {
        refuse("two lines with a `<hash>` slot begin with the word " word)
      }
      seen[word] = 1
      words[++count] = word
      label = line
      sub(/:.*$/, ":", label)
      print "label\t" count "\t" word "\t" label
      rest = line
      while (match(rest, /[[:alpha:]]+ `<[^>]*>`/)) {
        slot = substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
        lead = tolower(slot)
        sub(/ .*$/, "", lead)
        if (index(slot, "`<test file>`")) {
          probe = lead
        } else if (!index(slot, "`<hash>`")) {
          against[lead] = 1
        }
      }
    }

    function scan(text, kind,    rest, token, gap, word, named, red_seen) {
      rest = text
      while (match(rest, /`[^`]+`/)) {
        token = substr(rest, RSTART + 1, RLENGTH - 2)
        gap = substr(rest, 1, RSTART - 1)
        rest = substr(rest, RSTART + RLENGTH)
        gsub(/\t/, " ", token)
        if (named && gap ~ /^[[:space:]]*$/) {
          print "name\t" token
          named = 0
          continue
        }
        named = 0
        sub(/[[:space:]]+$/, "", gap)
        word = match(gap, /[[:alpha:]]+$/) ? substr(gap, RSTART, RLENGTH) : ""
        if (kind == 1 && red_seen && probe != "" && tolower(word) == probe) {
          print "probe\t" token
          named = 1
        } else if (token ~ /^[0-9a-f]+$/ && length(token) >= 7 && length(token) <= 40) {
          if (kind > 0 && (tolower(word) in against)) {
            print "commit\t0\t" token "\t" word
          } else {
            print "commit\t" kind "\t" token "\t" (kind > 0 ? word : section)
            red_seen = red_seen || kind == 1
          }
        }
      }
    }

    function emit_bullet(    i, prefix, kind) {
      if (bullet == "") {
        return
      }
      kind = -1
      for (i = 1; i <= count; i++) {
        prefix = "- " words[i]
        if (substr(bullet, 1, length(prefix)) == prefix && substr(bullet, length(prefix) + 1, 1) !~ /[[:alnum:]]/) {
          kind = i
        }
      }
      if (kind > 0) {
        print "line\t" kind
      }
      scan(bullet, kind)
      bullet = ""
    }

    BEGIN {
      section = "its opening"
    }

    NR == FNR {
      if ($0 ~ /^## /) {
        template_evidence = ($0 == "## Evidence")
      } else if (template_evidence && index($0, "`<hash>`")) {
        template_line($0)
      }
      next
    }

    /^## / {
      emit_bullet()
      section = $0
      evidence = ($0 == "## Evidence")
      next
    }

    evidence && /^- / {
      emit_bullet()
      bullet = $0
      next
    }

    evidence && bullet != "" && /^[[:space:]]+[^[:space:]]/ {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      bullet = bullet " " line
      next
    }

    {
      emit_bullet()
      scan($0, -1)
    }

    END {
      if (refused) {
        exit 1
      }
      if (count < 2) {
        refuse("its Evidence section needs a red tests line and then a fixes line, each with a `<hash>` slot")
      }
      emit_bullet()
    }
  ' "$TEMPLATE" - <<<"$content"
}

# A rebase keeps a commit's subject and its patch and gives it a new id. When
# exactly one commit of the branch is that twin, the refusal names it, because
# the repair is to cite it.
moved_hint() {
  local id="$1" head_id="$2" subject twin patch
  subject=$(git -C "$REPO" log -1 --format=%s "$id")
  twin=$(git -C "$REPO" log --format='%H %s' "$head_id" \
    | SUBJECT="$subject" awk '{ id = $1; sub(/^[^ ]+ /, ""); if ($0 == ENVIRON["SUBJECT"]) print id }')
  [[ -n "$twin" && "$twin" != *$'\n'* ]] || return 0
  patch=$(git -C "$REPO" show "$id" | git patch-id --stable | cut -d' ' -f1)
  [[ -n "$patch" && "$patch" == "$(git -C "$REPO" show "$twin" | git patch-id --stable | cut -d' ' -f1)" ]] || return 0
  echo " ${twin:0:7} on the branch has the same subject and the same patch, so the branch moved after this was written: cite ${twin:0:7}."
}

# Refuses a postmortem that cites a commit the head does not descend from. On
# the template's lines an id must also resolve, none may be both a red test and
# a fix, and some cited fix must descend from each red test. A postmortem of
# several findings cites several of each, so "its fix" is any fix cited: a fix
# line also names commits older than the reds (the one a defect came in with),
# and a later round's red comes after the first round's fixes. Anywhere else an
# id that names no commit here is left alone, because a digest or an id of
# another repository is written the same way. Every stale id is reported in one
# run, because a moved branch makes all of them stale at once.
#
# Sets CITED_REDS, CITED_PROBE_FILE, CITED_PROBE_NAME, CITED_HEAD and
# CITED_SUMMARY for the caller.
CITED_REDS=()
declare -A CITED_PROBE_FILE=() CITED_PROBE_NAME=()
CITED_HEAD=""
CITED_SUMMARY=""
check_postmortem_commits() {
  local path="$1" content="$2" head="$3"
  local head_id cited record first second third id where red fix ordered index problem last_red=""
  local -a labels=() words=() problems=() reds=() fixes=()
  local -A lines_on=() commits_on=() red_cited=() fix_cited=() others=()

  head_id=$(git -C "$REPO" rev-parse --verify --quiet "${head}^{commit}" 2>/dev/null) || {
    echo "SEV rule: the commits postmortem $path cites cannot be judged: $head is not a commit in this repository." >&2
    echo "  Fetch the pull request's head, then run this again." >&2
    return 1
  }
  cited=$(cited_commits "$content") || return 1

  while IFS=$'\t' read -r record first second third; do
    case "$record" in
      label)
        words[first]="$second"
        labels[first]="$third"
        ;;
      line)
        lines_on[$first]=$((${lines_on[$first]:-0} + 1))
        ;;
      probe)
        [[ -z "$last_red" ]] || CITED_PROBE_FILE[$last_red]="$first"
        ;;
      name)
        [[ -z "$last_red" ]] || CITED_PROBE_NAME[$last_red]="$first"
        ;;
      commit)
        if [[ "$first" -lt 0 ]]; then
          where="under $third"
        elif [[ "$first" -eq 0 ]]; then
          where="after \"$third\""
        else
          where="on its '${labels[first]}' line"
          commits_on[$first]=$((${commits_on[$first]:-0} + 1))
        fi
        id=$(git -C "$REPO" rev-parse --verify --quiet "${second}^{commit}" 2>/dev/null) || {
          [[ "$first" -lt 0 ]] \
            || problems+=("cites \`$second\` $where, which does not resolve to a commit in this repository.")
          continue
        }
        if ! git -C "$REPO" merge-base --is-ancestor "$id" "$head_id" 2>/dev/null; then
          problems+=("cites \`$second\` $where, which is not an ancestor of the head ${head_id:0:7}.$(moved_hint "$id" "$head_id")")
          continue
        fi
        others[$id]=1
        if [[ "$first" -eq 1 ]]; then
          last_red="$id"
          [[ -n "${red_cited[$id]:-}" ]] || reds+=("$id")
          red_cited[$id]="$second"
        elif [[ "$first" -eq 2 ]]; then
          [[ -n "${fix_cited[$id]:-}" ]] || fixes+=("$id")
          fix_cited[$id]="$second"
        fi
        ;;
    esac
  done <<<"$cited"

  for index in "${!labels[@]}"; do
    if [[ "${lines_on[$index]:-0}" -eq 0 ]]; then
      problems+=("has no Evidence line that begins '- ${words[index]}', the template's '${labels[index]}' line, so what it cites there cannot be read.")
    elif [[ "${commits_on[$index]:-0}" -eq 0 ]]; then
      problems+=("cites no commit on a line that begins '- ${words[index]}'. The template's '${labels[index]}' line carries one.")
    fi
  done

  # Order is judged only among commits that are real and on the branch: a stale
  # id has no place in the history to be before or after anything.
  if [[ ${#problems[@]} -eq 0 ]]; then
    for red in "${reds[@]}"; do
      if [[ -n "${fix_cited[$red]:-}" ]]; then
        problems+=("cites \`${red_cited[$red]}\` on its '${labels[1]}' line and on its '${labels[2]}' line: a red test and its fix are two commits.")
        continue
      fi
      ordered=0
      for fix in "${fixes[@]}"; do
        if git -C "$REPO" merge-base --is-ancestor "$red" "$fix" 2>/dev/null; then
          ordered=1
          break
        fi
      done
      [[ "$ordered" -eq 1 ]] \
        || problems+=("cites \`${red_cited[$red]}\` on its '${labels[1]}' line, and no commit on its '${labels[2]}' line descends from it: a red test comes before its fix.")
    done
  fi

  if [[ ${#problems[@]} -gt 0 ]]; then
    for problem in "${problems[@]}"; do
      echo "SEV rule: postmortem $path $problem" >&2
    done
    return 1
  fi
  CITED_REDS=("${reds[@]}")
  CITED_HEAD="$head_id"
  CITED_SUMMARY="on ${head_id:0:7}: ${#reds[@]} red, ${#fixes[@]} fix, $((${#others[@]} - ${#reds[@]} - ${#fixes[@]})) other cited; each red is before a fix"
}

# --- --prove-reds: a cited red test fails where it is cited ------------------
#
# Ancestry cannot see a "red" commit that already holds its fix, or a test that
# never failed. This opt-in mode runs the probe each cited red names: at the red
# commit, in a scratch worktree with its own dependencies, at least one test
# must fail by name. The same probe must then pass at the head, in the same
# environment, or the failure was never the defect's: a database that is not
# running fails every test of a store at any commit. The probe is named and not
# derived, because a red that adds a case to a generated surface changes no
# test file, and the test file it did change can pass. A red that names no
# probe is not run, and the summary line counts it. It runs on the attester's
# machine and takes seconds for a red.

# A scratch copy gets its own install, so its workspace packages are its own.
# Borrowing another tree's node_modules directories is quicker and wrong: a
# workspace package is a relative link, and through a borrowed directory it
# resolves in the tree it was borrowed from, which holds the fix. A red whose
# test is in one package and whose fix is in another then passes. So every
# dependency link is held to the copy before anything runs in it.
scratch_copy() {
  local commit="$1" copy="$2" inside link target links=0
  git -C "$REPO" worktree add --quiet --detach "$copy" "$commit" >&2 || return 1
  (cd "$copy" && pnpm install --frozen-lockfile --offline) >"$copy.install.log" 2>&1 || {
    echo "cannot install the dependencies of ${commit:0:7} offline into a scratch copy:" >&2
    tail -5 "$copy.install.log" >&2
    return 1
  }
  inside=$(cd "$copy" && pwd -P)
  while IFS= read -r link; do
    links=$((links + 1))
    target=$(readlink -f "$link" || true)
    [[ "$target" == "$inside"/* ]] || {
      echo "${link#"$copy"/} resolves outside the scratch copy of ${commit:0:7}, to ${target:-nothing}." >&2
      return 1
    }
  done < <(find "$copy" -name .pnpm -prune -o -type l -path '*/node_modules/*' -print)
  [[ "$links" -gt 0 ]] || {
    echo "the install into the scratch copy of ${commit:0:7} linked no dependency." >&2
    return 1
  }
}

remove_scratch_copies() {
  local work="$1" copy
  for copy in "$work"/*/; do
    [[ -e "$copy.git" ]] && git -C "$REPO" worktree remove --force "${copy%/}" >/dev/null 2>&1
  done
  rm -rf "$work"
  git -C "$REPO" worktree prune || true
}

# Runs one probe in a scratch copy and prints "PASSED FAILED", or nothing when
# the run left no report to read. A test the name filter skips is in vitest's
# total and in neither count, so a name that matches nothing reads "0 0".
run_probe() {
  local copy="$1" report="$2" file="$3" name="$4"
  local -a filter=()
  [[ -z "$name" ]] || filter=(-t "$name")
  (cd "$copy" && pnpm exec vitest run "$file" "${filter[@]}" --reporter=json --outputFile="$report") >"$report.log" 2>&1 || true
  jq -er '"\(.numPassedTests) \(.numFailedTests)"' "$report" 2>/dev/null || true
}

prove_reds() {
  local path="$1" work red short file name probe copy report counts passed failed problem
  local head_short="${CITED_HEAD:0:7}"
  local -a proven=() unnamed=() problems=()

  work=$(mktemp -d "${TMPDIR:-/tmp}/review-attest-reds.XXXXXX")
  # shellcheck disable=SC2064
  trap "remove_scratch_copies '$work'" EXIT

  for red in "${CITED_REDS[@]}"; do
    short="${red:0:7}"
    file="${CITED_PROBE_FILE[$red]:-}"
    name="${CITED_PROBE_NAME[$red]:-}"
    probe="$file${name:+, \"$name\"}"
    if [[ -z "$file" ]]; then
      unnamed+=("$short")
      echo "red $short names no probe, so it is not run"
      continue
    fi
    git -C "$REPO" cat-file -e "$red:$file" 2>/dev/null || {
      problems+=("red \`$short\` names the probe $file, which that commit does not hold.")
      continue
    }
    copy="$work/red-$short"
    report="$work/red-$short.json"
    SECONDS=0
    scratch_copy "$red" "$copy" || {
      problems+=("red \`$short\` could not be run: the scratch copy above is not one a result can be trusted from.")
      continue
    }
    counts=$(run_probe "$copy" "$report" "$file" "$name")
    read -r passed failed <<<"$counts"
    if [[ -z "$counts" ]]; then
      tail -5 "$report.log" >&2
      problems+=("red \`$short\`: the run of $probe at that commit left no report to read.")
    elif [[ "$failed" -gt 0 ]]; then
      proven+=("$red")
      echo "red $short: $failed failed and $passed passed at that commit, in ${SECONDS}s: $probe"
      jq -r '[.testResults[].assertionResults[]? | select(.status == "failed") | .fullName] | .[:20][] | "    " + .' "$report"
    elif [[ "$passed" -gt 0 ]]; then
      problems+=("red \`$short\`: its probe $probe passed ($passed) and nothing failed at that commit, so it is not a red test.")
    else
      problems+=("red \`$short\`: its probe $probe ran no test at that commit. The file does not load there, or no test has that name.")
    fi
  done

  if [[ ${#proven[@]} -gt 0 ]]; then
    copy="$work/head-$head_short"
    SECONDS=0
    if ! scratch_copy "$CITED_HEAD" "$copy"; then
      problems+=("the head $head_short could not be run: the scratch copy above is not one a result can be trusted from.")
      proven=()
    fi
    for red in "${proven[@]}"; do
      short="${red:0:7}"
      file="${CITED_PROBE_FILE[$red]}"
      name="${CITED_PROBE_NAME[$red]:-}"
      probe="$file${name:+, \"$name\"}"
      report="$work/head-for-$short.json"
      counts=$(run_probe "$copy" "$report" "$file" "$name")
      read -r passed failed <<<"$counts"
      if [[ -z "$counts" ]]; then
        tail -5 "$report.log" >&2
        problems+=("red \`$short\`: the run of $probe at the head $head_short left no report to read.")
      elif [[ "$failed" -gt 0 ]]; then
        problems+=("red \`$short\`: its probe $probe also fails at the head $head_short ($failed failed), so the failure is not the defect's: no fix removed it.")
      elif [[ "$passed" -eq 0 ]]; then
        problems+=("red \`$short\`: its probe $probe ran no test at the head $head_short, so nothing shows a fix removed the failure.")
      else
        echo "head $head_short: $passed passed and none failed: $probe"
      fi
    done
    echo "the head took ${SECONDS}s"
  fi

  [[ ${#proven[@]} -gt 0 || ${#problems[@]} -gt 0 ]] \
    || problems+=("none of its ${#CITED_REDS[@]} cited reds names a probe, so this run proved nothing.")
  if [[ ${#problems[@]} -gt 0 ]]; then
    for problem in "${problems[@]}"; do
      echo "SEV rule: postmortem $path $problem" >&2
    done
    return 1
  fi
  echo "proved ${#proven[@]} of ${#CITED_REDS[@]} cited reds: each fails at its own commit and passes at $head_short${unnamed:+; ${#unnamed[@]} named no probe and were not run: ${unnamed[*]}}"
}

# The head defaults to HEAD, which is the pull request's head in the worktree
# its author runs this from before pushing.
if [[ "${1:-}" == "--check-postmortem" ]]; then
  PROVE_REDS=0
  if [[ "${!#}" == "--prove-reds" ]]; then
    PROVE_REDS=1
    set -- "${@:1:$#-1}"
  fi
  [[ $# -eq 2 || $# -eq 3 ]] || usage
  [[ -f "$2" ]] || { echo "no postmortem: $2" >&2; exit 1; }
  CONTENT=$(<"$2")
  ROWS=$(check_postmortem_tables "$2" "$CONTENT")
  check_postmortem_commits "$2" "$CONTENT" "${3:-HEAD}"
  echo "SEV rule satisfied: $ROWS findings accounted for in $2; commits $CITED_SUMMARY"
  [[ "$PROVE_REDS" -eq 0 ]] || prove_reds "$2"
  exit 0
fi

if [[ "${1:-}" == "--check-codex-log" ]]; then
  [[ $# -eq 3 ]] || usage
  check_codex_log "$2" "$3"
  echo "codex log complete and bound to review head $3"
  exit 0
fi

if [[ "${1:-}" == "--check-journal" ]]; then
  [[ $# -eq 3 ]] || usage
  check_journal "$2" "$3"
  echo "review journal complete and bound to review head $3"
  exit 0
fi

if [[ "${1:-}" == "--check-pr-body" ]]; then
  [[ $# -eq 2 ]] || usage
  [[ -f "$2" ]] || { echo "no PR body: $2" >&2; exit 1; }
  BODY_FIXTURE=$(<"$2")
  check_pr_body "$BODY_FIXTURE"
  echo "PR body review trailers are well formed"
  exit 0
fi

[[ $# -eq 3 ]] || usage
PR="$1"; CODEX_LOG="$2"; JOURNAL="$3"

SHA=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)
BODY=$(gh pr view "$PR" --json body --jq .body)
check_pr_body "$BODY"

# --- SEV gate (runs FIRST: nothing below may skip it) -----------------------

DECLARED=$(review_findings_count "$BODY")
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
    check_postmortem_commits "$f" "$CONTENT" "$SHA"
    PM_FILES="$PM_FILES  commits $CITED_SUMMARY"$'\n'
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

REASON=$(abandonment_reason "$BODY")
if [[ -n "$REASON" ]]; then
  gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
    -f context=adversarial-review -f description="ABANDONED (see PR body): ${REASON:0:80}"
  echo "attested via explicit abandonment (SEV gate above still enforced)"
  exit 0
fi

if [[ "$JOURNAL" == "-" ]]; then
  echo "workflow journal is required unless reviews are explicitly abandoned." >&2
  exit 1
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
check_codex_log "$CODEX_LOG" "$SHA"
[[ -f "$JOURNAL" ]] || { echo "no workflow journal: $JOURNAL" >&2; exit 1; }
reject_repo_file "$JOURNAL" "workflow journal"
check_journal "$JOURNAL" "$SHA"

RAN="codex + verified multi-lens review"
gh api "repos/{owner}/{repo}/statuses/$SHA" -f state=success \
  -f context=adversarial-review \
  -f description="$RAN reported for $SHA; review-findings: $DECLARED"
echo "attested: adversarial-review success on $SHA (review-findings: $DECLARED)"
