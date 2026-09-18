#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$(mktemp -d /tmp/durablerun-package-tarballs.XXXXXX)"
CONSUMER_DIR="$(mktemp -d /tmp/durablerun-package-consumer.XXXXXX)"
EXAMPLE_DIR="$(mktemp -d /tmp/durablerun-hosted-example.XXXXXX)"
trap 'rm -rf "$PACK_DIR" "$CONSUMER_DIR" "$EXAMPLE_DIR"' EXIT

packages=()
shopt -s nullglob
package_manifests=("$ROOT"/packages/*/package.json)
if [[ "${#package_manifests[@]}" -eq 0 ]]; then
  echo "package-smoke: found no package manifests" >&2
  exit 1
fi
for manifest in "${package_manifests[@]}"; do
  visibility="$(
    node -e "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));process.stdout.write(m.private===true?'private':'public')" "$manifest"
  )"
  if [[ "$visibility" == "public" ]]; then
    packages+=("$(basename "$(dirname "$manifest")")")
  elif [[ "$visibility" != "private" ]]; then
    echo "package-smoke: invalid package visibility for $manifest" >&2
    exit 1
  fi
done
if [[ "${#packages[@]}" -eq 0 ]]; then
  echo "package-smoke: found no public packages" >&2
  exit 1
fi

for package in "${packages[@]}"; do
  pnpm --dir "$ROOT" --filter "@durablerun/$package" pack --pack-destination "$PACK_DIR" >/dev/null
  archive_count="$(find "$PACK_DIR" -maxdepth 1 -type f -name "durablerun-$package-*.tgz" | wc -l)"
  if [[ "$archive_count" -ne 1 ]]; then
    echo "package-smoke: expected one tarball for @durablerun/$package, found $archive_count" >&2
    exit 1
  fi
  archive="$(find "$PACK_DIR" -maxdepth 1 -type f -name "durablerun-$package-*.tgz")"
  unpacked="$(mktemp -d "$PACK_DIR/$package.XXXXXX")"
  tar -xzf "$archive" -C "$unpacked"
  node "$ROOT/scripts/package-smoke-manifest.mjs" "$unpacked/package" "@durablerun/$package"
  mkdir -p "$PACK_DIR/surface/$package"
  tar -xzf "$archive" -C "$PACK_DIR/surface/$package"
done

surface_snapshot="$ROOT/scripts/published-surface-v0.1.0-alpha.1.json"
node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_snapshot"
# The check must be able to fail: a snapshot that names one export the packages
# never had has to be refused, or a broken reader would pass every tree.
surface_control="$PACK_DIR/surface-control.json"
node -e "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));s.surface['@durablerun/core']['.'].push('PackageSurfaceControlNeverExported');fs.writeFileSync(process.argv[2],JSON.stringify(s))" \
  "$surface_snapshot" "$surface_control"
if node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_control" >/dev/null 2>&1; then
  echo "package-smoke: package-surface accepted a snapshot naming a never-exported name" >&2
  exit 1
fi

# A withdrawal must be able to fail as well. One of a name the packages still export
# has to be refused, or the table would excuse a name without anyone deleting it, and so
# does one of a name the release never exported, and one with no reason.
surface_withdrawal() {
  node -e "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));s.withdrawn={'@durablerun/core':{'.':{[process.argv[3]]:process.argv[4]}}};fs.writeFileSync(process.argv[2],JSON.stringify(s))" \
    "$surface_snapshot" "$surface_control" "$1" "$2"
  if node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_control" >/dev/null 2>&1; then
    echo "package-smoke: package-surface accepted a withdrawal of $3" >&2
    exit 1
  fi
}
surface_withdrawal FencedBatch 'a control' 'a name that is still exported'
surface_withdrawal PackageSurfaceControlNeverExported 'a control' 'a name the release never exported'

node "$ROOT/scripts/package-smoke-manifest-selftest.mjs"

cp "$ROOT/scripts/package-smoke-fixture/package.json" "$CONSUMER_DIR/package.json"
cp "$ROOT/scripts/package-smoke-fixture/tsconfig.json" "$CONSUMER_DIR/tsconfig.json"
cp "$ROOT/scripts/package-smoke-fixture/smoke.ts" "$CONSUMER_DIR/smoke.ts"

npm install --prefix "$CONSUMER_DIR" --ignore-scripts --no-audit --no-fund --prefer-offline \
  "$PACK_DIR"/*.tgz >/dev/null
"$ROOT/node_modules/.bin/tsc" -p "$CONSUMER_DIR/tsconfig.json"
node "$CONSUMER_DIR/dist/smoke.js"

cp -R "$ROOT/examples/vercel-turso/." "$EXAMPLE_DIR/"
npm install --prefix "$EXAMPLE_DIR" --ignore-scripts --no-audit --no-fund --prefer-offline \
  "$PACK_DIR"/*.tgz >/dev/null
npm run --prefix "$EXAMPLE_DIR" typecheck
npm test --prefix "$EXAMPLE_DIR"

echo "package-smoke: four tarballs install and run in generic and hosted-alpha external consumers"
