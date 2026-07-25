#!/usr/bin/env bash
# What is still alive after a work round — WITHOUT guessing at names.
#
# Why this exists. Asked whether anything was still running, the answer given
# was "none", from `ps | grep -E 'codex-cli|tla2tools|vitest|worker-host'`.
# That grep lists TOOL names. Both things actually running were shell loops
# sitting in `sleep`, which no tool name can match, so the check could not
# have found what its silence was taken to prove. One of them had been
# spinning for 38 hours, from an earlier session, waiting on a log file that
# was never going to exist.
#
# The second one is worse and is the reason this file is a script rather than
# a note. It was a waiter whose own exit condition was
# `! pgrep -f "tla.sh"` — and `pgrep -f` matches command LINES, so the waiter
# matched itself. The condition could never become true. A loop written to
# stop when some work finishes, that cannot stop, is the same defect class
# this repository spent a whole PR removing from its SQL: a check that cannot
# fire, believed because it is quiet.
#
# So: no pattern guessing here. Everything below is enumerated from ground
# truth — the process table filtered by working directory and command line
# against THIS repository, plus git's own view of worktrees, stashes and
# uncommitted files. Reporting "clean" means this printed nothing, and that
# is a claim with a method behind it.
#
# Run it before saying a round is finished.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd -P)
SELF=$$
found=0

note() { found=1; printf '%s\n' "$*"; }

# --- work launched against this repo --------------------------------------
# Matched on the COMMAND LINE naming the repo or the scratchpad, never on the
# working directory: every interactive shell in this terminal has the repo as
# its cwd, and reporting those would bury the one line that matters. A check
# that cries wolf gets weakened until it is quiet, which is the same failure
# in a different costume.
#
# The exclusions are named individually and deliberately: they are the
# session's own furniture — the terminal multiplexer, the agent process, the
# login shells it runs inside. Anything else whose command line points at this
# repo was launched to DO something, and is therefore worth a line.
is_furniture() {
  case "$1" in
    *session-state.sh*|*tmux*|*nosync-wrap*|*"claude --resume"*|*"claude "*) return 0 ;;
    "-zsh "|"/usr/bin/zsh -l "|"/bin/bash -l ") return 0 ;;
  esac
  return 1
}

for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
  [[ "$pid" == "$SELF" ]] && continue
  # Braced so the REDIRECTION failure is suppressed too, not just tr's: a
  # process that exits between listing /proc and reading it is ordinary, and
  # a scanner that spews shell errors on it is one people learn to ignore.
  cmd=$( { tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null ) || continue
  [[ -z "$cmd" ]] && continue
  is_furniture "$cmd" && continue
  if [[ "$cmd" == *"$ROOT"* || "$cmd" == *"claude-1000"*"scratchpad"* ]]; then
    et=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    note "process   $pid  up $et  ${cmd:0:110}"
  fi
done

# A sleep whose parent is gone is orphaned and exits on its own; one with a
# live parent is a loop somebody is still waiting on.
while read -r pid ppid rest; do
  [[ -z "${pid:-}" ]] && continue
  [[ "$ppid" == "1" ]] && continue
  note "sleep     $pid (parent $ppid still alive — a wait loop is running)"
done < <(ps -eo pid,ppid,comm --no-headers 2>/dev/null | awk '$3=="sleep"')

# --- git state ------------------------------------------------------------
while read -r line; do
  [[ "$line" == "$ROOT "* ]] && continue
  note "worktree  ${line}"
done < <(git worktree list 2>/dev/null)

while read -r line; do
  note "stash     ${line}"
done < <(git stash list 2>/dev/null)

while read -r line; do
  note "file      ${line}"
done < <(git status --short 2>/dev/null)

if [[ "$found" -eq 0 ]]; then
  echo "session-state: clean — no repo processes, no wait loops, no extra worktrees,"
  echo "               no stashes, no uncommitted files."
else
  echo
  echo "session-state: the above is what is still alive. Nothing here is"
  echo "               necessarily wrong — but none of it is 'nothing'."
  exit 1
fi
