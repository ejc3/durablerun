#!/usr/bin/env bash
# Whether the release alpha.1 keeps working on a libSQL database the CLI migrated.
#
# It installs the four release assets of v0.1.0-alpha.1 into a consumer directory the way
# package-smoke.sh installs the current tarballs, after checking each against the sha256
# that scripts/published-surface-v0.1.0-alpha.1.json records, and runs
# packages/cli/test/alpha1-compat.ts against them. The asset URLs are the ones
# examples/vercel-turso/package.json pins. A sha256 that does not match fails. An asset
# that cannot be downloaded skips the harness, and the skip is printed with its reason and
# counted; set DURABLERUN_ALPHA1_REQUIRED=1 to make it fail instead. With
# DURABLERUN_ALPHA1_ASSETS set to a directory holding the four assets, nothing is downloaded.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d -t durablerun-alpha1.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# The pinned URLs, each with the sha256 the snapshot records for its file name. A URL whose
# file the snapshot does not record, or a recorded asset no URL pins, is refused here.
pins="$(
  node -e "
    const fs = require('node:fs')
    const [snapshotPath, examplePath] = process.argv.slice(1)
    const assets = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).assets ?? {}
    const deps = JSON.parse(fs.readFileSync(examplePath, 'utf8')).dependencies ?? {}
    const urls = Object.values(deps).filter((value) => /^https:\/\//.test(value))
    const named = new Set()
    for (const url of urls) {
      const file = url.slice(url.lastIndexOf('/') + 1)
      if (!Object.hasOwn(assets, file)) {
        console.error('alpha1-compat: ' + examplePath + ' pins ' + url + ', whose file the snapshot does not record')
        process.exit(1)
      }
      named.add(file)
      console.log(file + ' ' + assets[file] + ' ' + url)
    }
    for (const file of Object.keys(assets)) {
      if (!named.has(file)) {
        console.error('alpha1-compat: the snapshot records ' + file + ', and no URL pins it')
        process.exit(1)
      }
    }
  " "$ROOT/scripts/published-surface-v0.1.0-alpha.1.json" "$ROOT/examples/vercel-turso/package.json"
)"

mkdir -p "$WORK/assets"
while read -r file sha256 url; do
  if [[ -n "${DURABLERUN_ALPHA1_ASSETS:-}" ]]; then
    cp "$DURABLERUN_ALPHA1_ASSETS/$file" "$WORK/assets/$file"
  elif ! reason="$(curl --fail --silent --show-error --location --max-time 120 -o "$WORK/assets/$file" "$url" 2>&1)"; then
    if [[ "${DURABLERUN_ALPHA1_REQUIRED:-}" == "1" ]]; then
      echo "alpha1-compat: could not download $url: $reason" >&2
      exit 1
    fi
    echo "alpha1-compat: SKIPPED (1 skip): could not download $url: $reason"
    exit 0
  fi
  actual="$(sha256sum "$WORK/assets/$file" | cut -d' ' -f1)"
  if [[ "$actual" != "$sha256" ]]; then
    echo "alpha1-compat: $file has sha256 $actual, and the snapshot records $sha256" >&2
    exit 1
  fi
done <<< "$pins"

printf '{"name":"durablerun-alpha1-consumer","private":true,"type":"module"}\n' > "$WORK/package.json"
npm install --prefix "$WORK" --ignore-scripts --no-audit --no-fund --prefer-offline \
  "$WORK"/assets/*.tgz >/dev/null
cd "$ROOT"
node --import tsx packages/cli/test/alpha1-compat.ts "$WORK"
