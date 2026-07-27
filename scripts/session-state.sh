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
cd "$(dirname "$0")/.." || {
  echo "session-state: cannot enter the repo root" >&2
  exit 2
}
ROOT=$(pwd -P) || {
  echo "session-state: cannot resolve the repo root" >&2
  exit 2
}
found=0

note() { found=1; printf '%s\n' "$*"; }

# --- work launched against this repo --------------------------------------
# One process graph is authoritative. A non-furniture process is rooted in
# this repository when its cwd or an argv field names the main checkout or a
# registered worktree. Its descendants remain owned even if they chdir. This
# catches ordinary relative commands and wait-loop children without declaring
# every unrelated `sleep` on the host to be ours.
[[ -d /proc && -r /proc ]] || {
  echo "session-state: no readable /proc — cannot enumerate processes or report clean" >&2
  exit 2
}
process_output=$(python3 - "$ROOT" <<'PY'
import os
import stat as stat_module
import subprocess
import sys
from dataclasses import dataclass


class EvidenceError(Exception):
    pass


@dataclass(frozen=True)
class Stat:
    ppid: int
    state: str
    start: int
    comm: str


@dataclass(frozen=True)
class Process:
    pid: int
    ppid: int
    start: int
    cwd: str | None
    cwd_deleted: bool
    argv: tuple[bytes, ...]
    exe: str
    comm: str


@dataclass(frozen=True)
class Worktree:
    path: str


def refuse(message: str) -> None:
    print(f"session-state: {message}", file=sys.stderr)
    raise SystemExit(2)


def read_stat(pid: int) -> Stat | None:
    try:
        raw = (f"/proc/{pid}/stat")
        with open(raw, "rb") as handle:
            body = handle.read()
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as exc:
        raise EvidenceError(f"cannot read /proc/{pid}/stat: {exc}") from exc
    close = body.rfind(b")")
    if close < 0:
        raise EvidenceError(f"malformed /proc/{pid}/stat")
    fields = body[close + 2 :].split()
    if len(fields) < 20:
        raise EvidenceError(f"short /proc/{pid}/stat")
    try:
        return Stat(
            ppid=int(fields[1]),
            state=os.fsdecode(fields[0]),
            start=int(fields[19]),
            comm=os.fsdecode(body[body.find(b"(") + 1 : close]),
        )
    except (TypeError, ValueError) as exc:
        raise EvidenceError(f"malformed /proc/{pid}/stat fields") from exc


def same_identity(left: Stat | None, right: Stat | None) -> bool:
    return (
        left is not None
        and right is not None
        and left.start == right.start
        and left.ppid == right.ppid
    )


RETRY_OBSERVATION = object()


def read_process_once(
    pid: int, own_uid: int
) -> Process | None | object:
    before = read_stat(pid)
    if before is None or before.state == "Z":
        return None
    try:
        if os.stat(f"/proc/{pid}").st_uid != own_uid:
            return None
    except (FileNotFoundError, ProcessLookupError):
        return None
    except OSError as exc:
        after = read_stat(pid)
        if not same_identity(before, after):
            return RETRY_OBSERVATION
        raise EvidenceError(f"cannot identify /proc/{pid}: {exc}") from exc

    try:
        with open(f"/proc/{pid}/cmdline", "rb") as handle:
            argv = tuple(part for part in handle.read().split(b"\0") if part)
    except (FileNotFoundError, ProcessLookupError):
        after = read_stat(pid)
        if after is None or after.state == "Z":
            return None
        if not same_identity(before, after):
            return RETRY_OBSERVATION
        raise EvidenceError(f"live same-user process {pid} has unreadable argv")
    except OSError as exc:
        after = read_stat(pid)
        if not same_identity(before, after):
            return RETRY_OBSERVATION
        raise EvidenceError(
            f"cannot inspect argv for live same-user process {pid}: {exc}"
        ) from exc

    cwd_deleted = False
    try:
        cwd_link = os.readlink(f"/proc/{pid}/cwd")
        cwd_deleted = cwd_link.endswith(" (deleted)")
        cwd: str | None = cwd_link.removesuffix(" (deleted)")
    except (FileNotFoundError, ProcessLookupError):
        after = read_stat(pid)
        if after is None or after.state == "Z":
            return None
        if not same_identity(before, after):
            return RETRY_OBSERVATION
        cwd = None
    except OSError:
        # A non-dumpable process can deliberately hide cwd. Preserve that
        # missing fact; the ownership pass refuses only when this session
        # actually needs it to decide repository ownership.
        cwd = None

    try:
        exe = os.readlink(f"/proc/{pid}/exe")
    except OSError:
        exe = ""
    after = read_stat(pid)
    if after is None or after.state == "Z":
        return None
    if not same_identity(before, after):
        return RETRY_OBSERVATION
    return Process(
        pid=pid,
        ppid=before.ppid,
        start=before.start,
        cwd=cwd,
        cwd_deleted=cwd_deleted,
        argv=argv,
        exe=exe,
        comm=before.comm,
    )


def read_process(pid: int, own_uid: int) -> Process | None:
    # start/ppid do not change across exec, so bracketing heterogeneous proc
    # reads with stat alone is not a coherent snapshot. Require two identical
    # complete observations; an exec between argv and cwd is then retried
    # rather than accepted as a process state that never existed.
    previous: Process | None = None
    for _attempt in range(5):
        observed = read_process_once(pid, own_uid)
        if observed is None:
            return None
        if observed is RETRY_OBSERVATION:
            previous = None
            continue
        if not isinstance(observed, Process):
            raise EvidenceError(f"invalid process observation for {pid}")
        if previous == observed:
            return observed
        previous = observed
    raise EvidenceError(
        f"live same-user process {pid} did not yield a coherent process snapshot"
    )


def worktree_inventory(root: str) -> tuple[Worktree, ...]:
    result = subprocess.run(
        ["git", "worktree", "list", "--porcelain", "-z"],
        cwd=root,
        capture_output=True,
    )
    if result.returncode != 0:
        detail = os.fsdecode(result.stderr or result.stdout).strip()
        refuse(f"git worktree list failed: {detail}")
    if not result.stdout:
        refuse("git worktree inventory omitted the current repository root")
    if not result.stdout.endswith(b"\0\0"):
        refuse("malformed git worktree inventory")

    worktrees: list[Worktree] = []
    seen: set[str] = set()
    for raw_record in result.stdout[:-2].split(b"\0\0"):
        fields = raw_record.split(b"\0")
        if (
            len(fields) < 2
            or not fields[0].startswith(b"worktree ")
            or not fields[0].removeprefix(b"worktree ")
            or not (
                fields[1].startswith(b"HEAD ")
                or fields[1] == b"bare"
            )
        ):
            refuse("malformed git worktree inventory")
        decoded = os.fsdecode(fields[0].removeprefix(b"worktree "))
        if not os.path.isabs(decoded):
            refuse("malformed git worktree inventory")
        path = os.path.realpath(decoded)
        if path in seen:
            refuse("malformed git worktree inventory")
        seen.add(path)
        worktrees.append(Worktree(path=path))

    physical_root = os.path.realpath(root)
    if physical_root not in seen:
        refuse("git worktree inventory omitted the current repository root")
    return tuple(sorted(worktrees, key=lambda worktree: len(worktree.path), reverse=True))


def path_is_under(path: str | None, roots: tuple[str, ...]) -> bool:
    if path is None:
        return False
    physical = os.path.realpath(path)
    return any(physical == root or physical.startswith(root + os.sep) for root in roots)


PATH_WORD_BYTES = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./-+~%@"


def path_word_byte(value: int) -> bool:
    return value >= 128 or value in PATH_WORD_BYTES


def argument_names_root(argument: bytes, root: bytes) -> bool:
    offset = 0
    while True:
        found = argument.find(root, offset)
        if found < 0:
            return False
        before_ok = found == 0 or not path_word_byte(argument[found - 1])
        end = found + len(root)
        after_ok = (
            end == len(argument)
            or argument[end] == ord("/")
            or not path_word_byte(argument[end])
        )
        if before_ok and after_ok:
            return True
        offset = found + 1


def arguments_name_root(argv: tuple[bytes, ...], roots: tuple[str, ...]) -> bool:
    encoded_roots = tuple(os.fsencode(root) for root in roots)
    return any(
        argument_names_root(argument, root)
        for argument in argv
        for root in encoded_roots
    )


def executable_name(process: Process) -> str:
    # argv[0] is the logical role for launchers implemented by an interpreter
    # (Claude is a native shim today; nosync-wrap is a Python script). Fall
    # back to /proc/exe only for the rare process with an empty argv.
    source = (os.fsdecode(process.argv[0]) if process.argv else "") or process.exe
    return os.path.basename(source).lstrip("-")


def is_furniture(process: Process) -> bool:
    name = executable_name(process)
    args = tuple(os.fsdecode(arg) for arg in process.argv[1:])
    if name in {"tmux", "nosync-wrap"}:
        return True
    if (
        name.startswith("python")
        and args
        and os.path.basename(args[0]) == "nosync-wrap"
    ):
        return True
    if name == "systemd" and args == ("--user",):
        return True
    if name == "(sd-pam)":
        return True
    if name in {"bash", "dash", "fish", "sh", "zsh"}:
        # Bare interactive/login shells are furniture. A shell with -c or a
        # script operand (including stdin's explicit -s) is work and remains
        # visible even when the script happens to use only shell builtins.
        return not any(
            arg in {"-c", "--command", "-s"}
            or (
                arg.startswith("-")
                and not arg.startswith("--")
                and "s" in arg[1:]
            )
            or not arg.startswith("-")
            for arg in args
        )
    if name == "codex":
        if args[:1] == ("app-server",):
            return True
        return not args or args[:1] in {("resume",), ("fork",)}
    if name == "claude":
        return "-p" not in args and "--print" not in args
    return False


def elapsed(start: int) -> str:
    try:
        with open("/proc/uptime", encoding="ascii") as handle:
            uptime = float(handle.read().split()[0])
        seconds = max(0, int(uptime - start / os.sysconf("SC_CLK_TCK")))
    except (OSError, ValueError):
        return "?"
    days, seconds = divmod(seconds, 86_400)
    hours, seconds = divmod(seconds, 3_600)
    minutes, seconds = divmod(seconds, 60)
    clock = f"{hours:02}:{minutes:02}:{seconds:02}"
    return f"{days}-{clock}" if days else clock


def valid_parent(process: Process, parent: Process | None) -> bool:
    # A reused parent PID is newer than its alleged child. Parent and child can
    # legitimately be born in the same kernel clock tick.
    return parent is not None and parent.start <= process.start


def descendant_set(
    seeds: set[int],
    children: dict[int, tuple[int, ...]],
) -> set[int]:
    descendants = set(seeds)
    pending = list(seeds)
    while pending:
        parent = pending.pop()
        for child in children.get(parent, ()):
            if child not in descendants:
                descendants.add(child)
                pending.append(child)
    return descendants


def fd_identity(pid: int, fd: int, process: Process) -> tuple[int, int, int] | None:
    # The stdout reader of this invocation is causally part of the check, not
    # leftover repository work. Match the actual pipe object rather than a
    # process name or the whole process group (which can contain real
    # background work).
    for _attempt in range(2):
        before = read_stat(pid)
        if (
            before is None
            or before.start != process.start
            or before.ppid != process.ppid
        ):
            return None
        try:
            descriptor = os.stat(f"/proc/{pid}/fd/{fd}")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            return None
        except OSError:
            return None
        after = read_stat(pid)
        if same_identity(before, after):
            return (
                descriptor.st_dev,
                descriptor.st_ino,
                stat_module.S_IFMT(descriptor.st_mode),
            )
    return None


root = os.path.realpath(sys.argv[1])
worktrees = worktree_inventory(root)
roots = tuple(worktree.path for worktree in worktrees)
try:
    numeric_pids = sorted(
        int(name)
        for name in os.listdir("/proc")
        if name.isascii() and name.isdigit()
    )
except OSError as exc:
    refuse(f"cannot enumerate /proc: {exc}")
if not numeric_pids:
    refuse("/proc has no numeric process entries — cannot report clean")

records: dict[int, Process] = {}
try:
    for pid in numeric_pids:
        process = read_process(pid, os.geteuid())
        if process is not None:
            records[pid] = process
except EvidenceError as exc:
    refuse(str(exc))

scanner = os.getpid()
if scanner not in records:
    refuse("the process scanner could not read its own /proc record")

children_lists: dict[int, list[int]] = {}
for process in records.values():
    parent = records.get(process.ppid)
    if valid_parent(process, parent):
        children_lists.setdefault(process.ppid, []).append(process.pid)
children = {
    pid: tuple(sorted(child_pids))
    for pid, child_pids in children_lists.items()
}

# The top contiguous same-uid ancestor defines this invocation's session.
# cwd is meaningful ownership evidence inside that session. Outside it, only
# an argv path explicitly naming this repository is attributable; this keeps a
# persistent container/session initializer that inherited cwd from becoming
# permanent false work.
ancestry = [scanner]
cursor = scanner
while True:
    process = records[cursor]
    parent = records.get(process.ppid)
    if (
        not valid_parent(process, parent)
        or parent is None
        or parent.pid in ancestry
    ):
        break
    ancestry.append(parent.pid)
    cursor = parent.pid
session_members = descendant_set({ancestry[-1]}, children)
invocation_ancestors = set(ancestry[1:])
scanner_tree = descendant_set({scanner}, children)
self_tree = scanner_tree | invocation_ancestors

# A pipeline reader is a sibling, not a scanner descendant. Command
# substitution adds an internal pipe between the scanner and its Bash parent,
# so inspect stdout along the complete invocation ancestry. A downstream
# reader's fd 0 names one of those same pipe objects. Exclude exactly that
# causal subtree while preserving unrelated same-pgid background work.
invocation_readers: set[int] = set()
invocation_output_fds = {
    identity
    for pid in invocation_ancestors
    if (identity := fd_identity(pid, 1, records[pid])) is not None
    and stat_module.S_ISFIFO(identity[2])
}
if invocation_output_fds:
    reader_roots = {
        pid
        for pid, process in records.items()
        if pid not in self_tree
        and fd_identity(pid, 0, process) in invocation_output_fds
    }
    invocation_readers = descendant_set(reader_roots, children)
nonreporting = self_tree | invocation_readers

furniture = {pid for pid, process in records.items() if is_furniture(process)}
explicit_anchors = {
    pid
    for pid, process in records.items()
    if arguments_name_root(process.argv, roots)
}
contextual_anchors = {
    pid
    for pid, process in records.items()
    if pid in session_members and path_is_under(process.cwd, roots)
}
anchors = explicit_anchors | contextual_anchors
owned_cache: dict[int, bool] = {}


def is_owned(pid: int, visiting: set[int] | None = None) -> bool:
    if pid in owned_cache:
        return owned_cache[pid]
    if pid in anchors:
        owned_cache[pid] = True
        return True
    process = records[pid]
    parent = records.get(process.ppid)
    if not valid_parent(process, parent) or parent is None:
        owned_cache[pid] = False
        return False
    active = set() if visiting is None else visiting
    if pid in active:
        owned_cache[pid] = False
        return False
    active.add(pid)
    answer = is_owned(parent.pid, active)
    active.remove(pid)
    owned_cache[pid] = answer
    return answer


for pid, process in records.items():
    if (
        process.cwd_deleted
        and pid in session_members
        and pid not in nonreporting
    ):
        refuse(
            "cannot prove ownership of deleted working directory for live "
            f"same-user process {pid}"
        )
    if (
        process.cwd is None
        and pid in session_members
        and pid not in nonreporting
        and pid not in furniture
        and not is_owned(pid)
    ):
        refuse(
            f"live same-user process {pid} hides cwd, so repository ownership "
            "cannot be proved"
        )

for pid in sorted(records):
    process = records[pid]
    if pid in nonreporting or pid in furniture or not is_owned(pid):
        continue
    command = " ".join(os.fsdecode(arg) for arg in process.argv) or f"[{process.comm}]"
    command = " ".join(command.split())
    print(f"process   {pid}  up {elapsed(process.start)}  {command[:110]}")
for worktree in worktrees:
    if worktree.path != root:
        print(f"worktree  {worktree.path}")
PY
)
process_status=$?
if [[ "$process_status" -ne 0 ]]; then
  exit "$process_status"
fi
if [[ -n "$process_output" ]]; then
  found=1
  printf '%s\n' "$process_output"
fi

if ! stashes=$(git stash list 2>&1); then
  echo "session-state: git stash list failed: $stashes" >&2
  exit 2
fi
while read -r line; do
  [[ -n "$line" ]] || continue
  note "stash     ${line}"
done <<<"$stashes"

if ! status=$(git status --short 2>&1); then
  echo "session-state: git status failed: $status" >&2
  exit 2
fi
while read -r line; do
  [[ -n "$line" ]] || continue
  note "file      ${line}"
done <<<"$status"

if [[ "$found" -eq 0 ]]; then
  echo "session-state: clean — no repo processes, no wait loops, no extra worktrees,"
  echo "               no stashes, no uncommitted files."
else
  echo
  echo "session-state: the above is what is still alive. Nothing here is"
  echo "               necessarily wrong — but none of it is 'nothing'."
  exit 1
fi
