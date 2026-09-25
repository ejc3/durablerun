#!/usr/bin/env bash
# Run the shared conformance surfaces for ONE dialect against its server, and
# refuse a green run that exercised nothing.
#
# `pnpm verify` runs the dialects its job has servers for. A dialect with its
# own CI job runs here instead, so the long pole of the gate does not grow with
# every dialect. The run is narrowed with DURABLERUN_CONFORMANCE_DIALECTS, and
# a narrowed run is the kind that can pass by matching nothing, so this script
# reads the reporter's own record: every test passed, none was skipped, and
# the dialect's name is on the conformance tests that ran.
set -euo pipefail
cd "$(dirname "$0")/../../.."

dialect="${1:?usage: packages/conformance/bin/dialect-conformance.sh <dialect>}"
case "$dialect" in
  *[!a-z0-9]*) echo "dialect-conformance: '$dialect' is not a dialect name" >&2; exit 2 ;;
esac
[ -d "packages/store-$dialect" ] || { echo "dialect-conformance: no packages/store-$dialect" >&2; exit 2; }

report="$(mktemp -t "durablerun-$dialect-conformance.XXXXXX.json")"
trap 'rm -f "$report"' EXIT

code=0
DURABLERUN_CONFORMANCE_DIALECTS="$dialect" pnpm exec vitest run \
  packages/conformance/test/libsql.test.ts \
  packages/conformance/test/sql-corpus.test.ts \
  packages/conformance/test/store-tables-schema.test.ts \
  packages/conformance/test/text-statements.test.ts \
  "packages/store-$dialect/test" \
  packages/cli/test/cli-dialects.test.ts \
  packages/cli/test/fault-surface.test.ts \
  --reporter=default --reporter=json --outputFile.json="$report" || code=$?

python3 - "$report" "$dialect" "$code" <<'PY'
import json, sys

report, dialect, code = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    run = json.load(open(report))
except (OSError, ValueError) as error:
    sys.exit(f"dialect-conformance: vitest wrote no readable report ({error}); its exit code was {code}")
tests = [test for file in run["testResults"] for test in file["assertionResults"]]
named = [test for test in tests if f"[{dialect}]" in test["fullName"]]
failed = [test for test in tests if test["status"] == "failed"]
idle = [test for test in tests if test["status"] not in ("passed", "failed")]
print(
    f"dialect-conformance: {dialect}: {len(tests)} tests ran, {len(named)} named [{dialect}], "
    f"{len(failed)} failed, {len(idle)} skipped or pending, vitest exit {code}"
)
problems = []
if code != 0 or failed:
    problems.append(f"{len(failed)} test(s) failed (vitest exit {code})")
if idle:
    problems.append(f"{len(idle)} test(s) did not run, first: {idle[0]['fullName']}")
if not named:
    problems.append(f"no conformance test named [{dialect}] ran: the selection matched nothing")
if problems:
    sys.exit("dialect-conformance: " + "; ".join(problems))
PY
