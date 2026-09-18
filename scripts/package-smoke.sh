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
# The check must be able to fail, and for the reason each control names. A control
# changes one thing in a copy of the snapshot and leaves the rest, the real withdrawals
# included, so every other refusal stays quiet. The refusal is read, not only the exit
# code: a control that is refused for another reason fails here.
surface_control="$PACK_DIR/surface-control.json"
surface_refuses() {
  # $1 what the control shows, $2 the refusal expected, $3 JavaScript that edits the copy.
  node -e "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const exported=s.surface['@durablerun/core']['.'];const withdrawn=(((s.withdrawn??={})['@durablerun/core']??={})['.']??={});$3;fs.writeFileSync(process.argv[2],JSON.stringify(s))" \
    "$surface_snapshot" "$surface_control"
  local refusal
  if refusal="$(node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_control" 2>&1)"; then
    echo "package-smoke: package-surface accepted $1" >&2
    exit 1
  fi
  if [[ "$refusal" != *"package-surface: 1 "* || "$refusal" != *"$2"* ]]; then
    echo "package-smoke: package-surface refused $1 for another reason: $refusal" >&2
    exit 1
  fi
}
surface_refuses 'a snapshot naming a never-exported name' \
  'PackageSurfaceControlNeverExported' \
  "exported.push('PackageSurfaceControlNeverExported')"
# A withdrawal that does not hold: without these the table would excuse a name nobody
# deleted, a name the release never had, or a name with nothing said about why.
surface_refuses 'a withdrawal of a name that is still exported' \
  'FencedBatch is withdrawn, but it is still exported' \
  "withdrawn.FencedBatch='a control'"
surface_refuses 'a withdrawal of a name the release never exported' \
  'never exported it' \
  "withdrawn.PackageSurfaceControlNeverExported='a control'"
# The reason is blanked on a real withdrawal, the only kind that holds otherwise.
surface_refuses 'a withdrawal with no reason' \
  'is withdrawn with no reason' \
  "withdrawn[Object.keys(withdrawn)[0]]=' '"

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
