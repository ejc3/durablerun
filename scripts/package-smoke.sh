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
# and changes included, so every other refusal stays quiet. The refusal is read, not only
# the exit code: a control that is refused for another reason, or for a second one, fails here.
surface_control="$PACK_DIR/surface-control.json"
surface_refusal_holds() {
  # $1 what the control shows, $2 the unpacked packages, $3 the snapshot, then every text
  # the one refusal must hold.
  local refusal expected
  if refusal="$(node "$ROOT/scripts/package-surface.mjs" "$2" "$3" 2>&1)"; then
    echo "package-smoke: package-surface accepted $1" >&2
    exit 1
  fi
  for expected in "package-surface: 1 " "${@:4}"; do
    if [[ "$refusal" != *"$expected"* ]]; then
      echo "package-smoke: package-surface refused $1 for another reason: $refusal" >&2
      exit 1
    fi
  done
}
surface_refuses() {
  # $1 what the control shows, $2 the refusal expected, $3 JavaScript that edits the copy of
  # the snapshot, then any more text the refusal must hold.
  node -e "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const core=(table)=>(((s[table]??={})['@durablerun/core']??={})['.']??={});const exported=core('surface'),withdrawn=core('withdrawn'),changed=core('changed');$3;fs.writeFileSync(process.argv[2],JSON.stringify(s))" \
    "$surface_snapshot" "$surface_control"
  surface_refusal_holds "$1" "$PACK_DIR/surface" "$surface_control" "$2" "${@:4}"
}
surface_refuses 'a snapshot naming a never-exported name' \
  'PackageSurfaceControlNeverExported is gone' \
  "exported.PackageSurfaceControlNeverExported=['a control']"
surface_refuses 'a snapshot naming an entry point that is not packed' \
  './package-surface-control: the entry point itself is gone' \
  "s.surface['@durablerun/core']['./package-surface-control']={}"
# A withdrawal that does not hold: without these the table would excuse a name nobody
# deleted, a name the release never had, or a name with nothing said about why.
surface_refuses 'a withdrawal of a name that is still exported' \
  'Checkpoint is withdrawn, but it is still exported' \
  "withdrawn.Checkpoint='a control'"
surface_refuses 'a withdrawal of a name the release never exported' \
  'never exported it' \
  "withdrawn.PackageSurfaceControlNeverExported='a control'"
# The reason is blanked on a real withdrawal, the only kind that holds otherwise.
surface_refuses 'a withdrawal with no reason' \
  'is withdrawn with no reason' \
  "withdrawn[Object.keys(withdrawn)[0]]=' '"
# The declarations are read, not only the names: a copy of the packed packages in which a
# released interface lost one member is refused, and the refusal names the interface and the
# member. A check that compares export names accepts it, as
# postmortems/pr3.5a-simplification-review.md records.
surface_lost_member="$PACK_DIR/surface-lost-member"
cp -R "$PACK_DIR/surface" "$surface_lost_member"
node -e "const fs=require('node:fs');const file=process.argv[1];const before=fs.readFileSync(file,'utf8');const member='    checkpointName: string;\n';if(before.split(member).length!==2)throw new Error('package-smoke: expected one checkpointName member in '+file);fs.writeFileSync(file,before.replace(member,''))" \
  "$surface_lost_member/core/package/dist/types.d.ts"
surface_refusal_holds 'a released interface that lost a member' \
  "$surface_lost_member" "$surface_snapshot" \
  'Checkpoint is declared differently' '- checkpointName: string;'
# A private constructor is part of what a consumer sees, because it says the class cannot be
# constructed: a copy in which UserName lost its private constructor, and kept its other
# private member, is refused.
surface_lost_constructor="$PACK_DIR/surface-lost-constructor"
cp -R "$PACK_DIR/surface" "$surface_lost_constructor"
node -e "const fs=require('node:fs');const file=process.argv[1];const before=fs.readFileSync(file,'utf8');const member='    private constructor();\n';if(before.split(member).length!==2)throw new Error('package-smoke: expected one private constructor in '+file);fs.writeFileSync(file,before.replace(member,''))" \
  "$surface_lost_constructor/core/package/dist/validate.d.ts"
surface_refusal_holds 'a released class that lost its private constructor' \
  "$surface_lost_constructor" "$surface_snapshot" \
  'UserName is declared differently' '- private constructor();'
# The same from the other side: the snapshot says a member was declared another way.
surface_refuses 'a snapshot in which one member of a released interface differs' \
  'Checkpoint is declared differently' \
  "exported.Checkpoint[1]=exported.Checkpoint[1].replace(';',' | PackageSurfaceControl;')" \
  '- checkpointName: string | PackageSurfaceControl;' '+ checkpointName: string;'
# A change that does not hold: without these the table would excuse a declaration nobody
# changed, a name the release never had, a name that is gone, a change with nothing said
# about why, or a second change to a name that is already listed.
surface_refuses 'a change listed for a declaration that did not change' \
  'Checkpoint is listed as changed, but it is declared as' \
  "changed.Checkpoint={reason:'a control',declarationSha256:'0'}"
surface_refuses 'a change listed for a name the release never exported' \
  'PackageSurfaceControlNeverExported is listed as changed, but' \
  "changed.PackageSurfaceControlNeverExported={reason:'a control',declarationSha256:'0'}"
surface_refuses 'a change listed for a withdrawn name' \
  'is both withdrawn and listed as changed' \
  "changed[Object.keys(withdrawn)[0]]={reason:'a control',declarationSha256:'0'}"
# The last two edit a real change, the only kind that holds otherwise.
surface_refuses 'a change listed with no reason' \
  'is listed as changed with no reason' \
  "changed[Object.keys(changed)[0]].reason=' '"
surface_refuses 'a second change to a listed name' \
  'the sha256 recorded is not the packed declaration' \
  "changed[Object.keys(changed)[0]].declarationSha256='0'"

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
