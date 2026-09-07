#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$(mktemp -d /tmp/durablerun-package-tarballs.XXXXXX)"
CONSUMER_DIR="$(mktemp -d /tmp/durablerun-package-consumer.XXXXXX)"
EXAMPLE_DIR="$(mktemp -d /tmp/durablerun-hosted-example.XXXXXX)"
trap 'rm -rf "$PACK_DIR" "$CONSUMER_DIR" "$EXAMPLE_DIR"' EXIT

packages=(core sdk driver store-libsql)

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
done

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
