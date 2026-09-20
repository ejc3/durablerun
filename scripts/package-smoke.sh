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
# The check must be able to fail, and for the reason each control names. A control changes one
# thing in a copy of the snapshot, or of the packed declarations, and leaves the rest, the real
# withdrawals and changes included, so every other refusal stays quiet. The refusal is read,
# not only the exit code: a control that is refused for another reason, or for a second one,
# fails here. A control that needs an entry that holds builds it, so the controls also pass on
# a snapshot whose tables are empty, as they are just after a release.
#
# Eight controls borrow one of three real names, Checkpoint, UserName and systemClock. They
# start from a base, a copy of the snapshot in which each of the three is declared as it is
# packed now, which the check prints, and is in neither table. So a real change to one of
# them, listed as it must be, leaves every control as it was. The base has to pass, or a
# control would be refused for its sake.
surface_packed="$PACK_DIR/surface-packed.json"
surface_base="$PACK_DIR/surface-base.json"
surface_control="$PACK_DIR/surface-control.json"
node "$ROOT/scripts/package-surface.mjs" --packed "$PACK_DIR/surface" "$surface_snapshot" > "$surface_packed"
node -e "const fs=require('node:fs');const [from,packedPath,to]=process.argv.slice(1);const s=JSON.parse(fs.readFileSync(from,'utf8'));const packed=JSON.parse(fs.readFileSync(packedPath,'utf8'))['@durablerun/core']['.'];const core=(table)=>(((s[table]??={})['@durablerun/core']??={})['.']??={});for(const name of ['Checkpoint','UserName','systemClock']){if(!packed[name])throw new Error('package-smoke: '+name+' is not packed, so the controls that borrow it need another name');core('surface')[name]=packed[name];delete core('withdrawn')[name];delete core('changed')[name]}fs.writeFileSync(to,JSON.stringify(s))" \
  "$surface_snapshot" "$surface_packed" "$surface_base"
node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_base" > /dev/null
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
  # $1 what the control shows, $2 the refusal expected, $3 JavaScript that edits a copy of the
  # base, then any more text the refusal must hold. The JavaScript has the core entry point's
  # three tables, pin(lines), the sha256 of a shape, and differ(), which says in the copy that
  # Checkpoint was released with another member and returns the sha256 of the packed
  # declaration, which is the one the base holds, so an entry that records it is a change that
  # holds.
  node -e "const fs=require('node:fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const core=(table)=>(((s[table]??={})['@durablerun/core']??={})['.']??={});const exported=core('surface'),withdrawn=core('withdrawn'),changed=core('changed');const pin=(lines)=>require('node:crypto').createHash('sha256').update(lines.join('\n')).digest('hex');const differ=()=>{const packed=pin(exported.Checkpoint);exported.Checkpoint[1]=exported.Checkpoint[1].replace(';',' | PackageSurfaceControl;');return packed};$3;fs.writeFileSync(process.argv[2],JSON.stringify(s))" \
    "$surface_base" "$surface_control"
  surface_refusal_holds "$1" "$PACK_DIR/surface" "$surface_control" "$2" "${@:4}"
}
surface_loses() {
  # $1 what the control shows, $2 a declaration file of the packed packages, $3 the one line
  # a copy of it loses, then every text the refusal must hold.
  local copy="$PACK_DIR/surface-loses"
  rm -rf "$copy"
  cp -R "$PACK_DIR/surface" "$copy"
  node -e "const fs=require('node:fs');const [file,member]=process.argv.slice(1);const before=fs.readFileSync(file,'utf8');if(before.split(member+'\n').length!==2)throw new Error('package-smoke: expected one line '+member.trim()+' in '+file);fs.writeFileSync(file,before.replace(member+'\n',''))" \
    "$copy/$2" "$3"
  surface_refusal_holds "$1" "$copy" "$surface_base" "${@:4}"
}
surface_gains() {
  # $1 what the control shows, $2 a declaration file of the packed packages, then the lines a
  # copy of it gains at its top, then --, then every text the refusal must hold.
  local what="$1" file="$2" copy="$PACK_DIR/surface-gains" lines=()
  shift 2
  while [[ "$1" != "--" ]]; do
    lines+=("$1")
    shift
  done
  shift
  rm -rf "$copy"
  cp -R "$PACK_DIR/surface" "$copy"
  node -e "const fs=require('node:fs');const [file,...lines]=process.argv.slice(1);fs.writeFileSync(file,lines.join('\n')+'\n'+fs.readFileSync(file,'utf8'))" \
    "$copy/$file" "${lines[@]}"
  surface_refusal_holds "$what" "$copy" "$surface_base" "$@"
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
surface_refuses 'a withdrawal with no reason' \
  'PackageSurfaceControlGone is withdrawn with no reason' \
  "exported.PackageSurfaceControlGone=['a control'];withdrawn.PackageSurfaceControlGone=' '"
# The declarations are read, not only the names: a copy of the packed packages in which a
# released interface lost one member is refused, and the refusal names the interface and the
# member. A check that compares export names accepts it, as
# postmortems/pr3.5a-simplification-review.md records.
surface_loses 'a released interface that lost a member' \
  core/package/dist/types.d.ts '    checkpointName: string;' \
  'Checkpoint is declared differently' '- checkpointName: string;'
# A private constructor is part of what a consumer sees, because it says the class cannot be
# constructed: a copy in which UserName lost its private constructor, and kept its other
# private member, is refused.
surface_loses 'a released class that lost its private constructor' \
  core/package/dist/validate.d.ts '    private constructor();' \
  'UserName is declared differently' '- private constructor();'
# How a name is exported is part of what a consumer sees: a copy in which the released value
# systemClock is exported as a type only is refused, because a consumer can no longer use it
# as a value, and the JavaScript export goes with a real change of that kind.
surface_gains 'a released value exported as a type only' \
  core/package/dist/index.d.ts "export type { systemClock } from './system-clock.js';" -- \
  'systemClock is declared differently' '+ (a value exported as a type only)'
# A whole module exported as a namespace has no shape in the check, so it is refused by name
# before a release can record one. The same copy reads a released name through a namespace
# import, which the check follows to the name and does not stop at.
surface_gains 'a module exported as a namespace' \
  core/package/dist/index.d.ts \
  "import * as PackageSurfaceControlInner from './clock.js';" \
  "export * as PackageSurfaceControlNamespace from './clock.js';" \
  'export declare const packageSurfaceControlValue: PackageSurfaceControlInner.Clock;' -- \
  'PackageSurfaceControlNamespace exports a whole module as a namespace'
# The same from the other side: the snapshot says a member was declared another way.
surface_refuses 'a snapshot in which one member of a released interface differs' \
  'Checkpoint is declared differently' \
  "differ()" \
  ' | PackageSurfaceControl;'
# A change that does not hold: without these the table would excuse a declaration nobody
# changed, a name the release never had, a name that is gone, a change with nothing said
# about why, or a second change to a name that is already listed.
surface_refuses 'a change listed for a declaration that did not change' \
  'Checkpoint is listed as changed, but it is declared as' \
  "changed.Checkpoint={reason:'a control',declarationSha256:pin(exported.Checkpoint)}"
surface_refuses 'a change listed for a name the release never exported' \
  'PackageSurfaceControlNeverExported is listed as changed, but' \
  "changed.PackageSurfaceControlNeverExported={reason:'a control',declarationSha256:'0'}"
surface_refuses 'a change listed for a withdrawn name' \
  'PackageSurfaceControlGone is both withdrawn and listed as changed' \
  "exported.PackageSurfaceControlGone=['a control'];withdrawn.PackageSurfaceControlGone='a control';changed.PackageSurfaceControlGone={reason:'a control',declarationSha256:'0'}"
surface_refuses 'a change listed with no reason' \
  'Checkpoint is listed as changed with no reason' \
  "changed.Checkpoint={reason:' ',declarationSha256:differ()}"
surface_refuses 'a second change to a listed name' \
  'Checkpoint is listed as changed, but the sha256 recorded is not the packed declaration' \
  "differ();changed.Checkpoint={reason:'a control',declarationSha256:'0'}"

# --write has refusals of its own. Four come before a tarball is unpacked, so a stand-in
# tarball that holds its own name is enough to show one. A refused write leaves the snapshot.
surface_write_refuses() {
  # $1 what the control shows, $2 the refusal expected, $3 the tarballs that a snapshot of the
  # release "control" records, as JSON, then the stand-in tarballs the directory holds.
  local what="$1" expected="$2" recorded="$3" dir="$PACK_DIR/surface-write" refusal file
  shift 3
  rm -rf "$dir"
  mkdir -p "$dir/tarballs"
  for file in "$@"; do
    printf '%s' "$file" > "$dir/tarballs/$file"
  done
  printf '{"release":"control","assets":%s,"withdrawn":{},"changed":{},"surface":{}}' "$recorded" \
    > "$dir/snapshot.json"
  cp "$dir/snapshot.json" "$dir/snapshot-before.json"
  if refusal="$(node "$ROOT/scripts/package-surface.mjs" --write control "$dir/tarballs" "$dir/snapshot.json" 2>&1)"; then
    echo "package-smoke: package-surface --write accepted $what" >&2
    exit 1
  fi
  if [[ "$refusal" != *"package-surface: "*"$expected"* ]]; then
    echo "package-smoke: package-surface --write refused $what for another reason: $refusal" >&2
    exit 1
  fi
  if ! cmp -s "$dir/snapshot.json" "$dir/snapshot-before.json"; then
    echo "package-smoke: package-surface --write refused $what and changed the snapshot" >&2
    exit 1
  fi
}
stand_in_sha256="$(node -e "process.stdout.write(require('node:crypto').createHash('sha256').update('a.tgz').digest('hex'))")"
surface_write_refuses 'a tarball whose bytes are not the recorded ones' \
  'a.tgz has sha256' '{"a.tgz":"0"}' a.tgz
surface_write_refuses 'a tarball the snapshot does not record' \
  'c.tgz is not a tarball the snapshot of control records' \
  "{\"a.tgz\":\"$stand_in_sha256\"}" a.tgz c.tgz
surface_write_refuses 'a directory that lacks a recorded tarball' \
  'lacks b.tgz, which the snapshot of control records' \
  "{\"a.tgz\":\"$stand_in_sha256\",\"b.tgz\":\"0\"}" a.tgz
surface_write_refuses 'a directory with no tarball' \
  'found no tarball in' '{}'
# The fifth refusal of --write reads what a tarball holds, so its control needs a real one: a
# copy of the packed core package whose index exports a whole module as a namespace. It is
# refused by name, and nothing is written.
surface_namespace="$PACK_DIR/surface-namespace"
rm -rf "$surface_namespace"
mkdir -p "$surface_namespace/tarballs"
cp "$PACK_DIR"/durablerun-*.tgz "$surface_namespace/tarballs/"
core_tarball="$(basename "$PACK_DIR"/durablerun-core-*.tgz)"
tar -xzf "$PACK_DIR/$core_tarball" -C "$surface_namespace"
printf "export * as PackageSurfaceControlNamespace from './clock.js';\n" \
  >> "$surface_namespace/package/dist/index.d.ts"
tar -czf "$surface_namespace/tarballs/$core_tarball" -C "$surface_namespace" package
if refusal="$(node "$ROOT/scripts/package-surface.mjs" --write control "$surface_namespace/tarballs" "$surface_namespace/snapshot.json" 2>&1)"; then
  echo "package-smoke: package-surface --write accepted a tarball that exports a module as a namespace" >&2
  exit 1
fi
if [[ "$refusal" != *"PackageSurfaceControlNamespace exports a whole module as a namespace"* || -e "$surface_namespace/snapshot.json" ]]; then
  echo "package-smoke: package-surface --write refused a tarball that exports a module as a namespace for another reason, or wrote a snapshot: $refusal" >&2
  exit 1
fi
# And --write works, from any directory: a snapshot written from the four packed tarballs by a
# command given elsewhere is laid out as the repository's formatter lays it out, and the packed
# packages pass the check against it with nothing withdrawn and nothing changed.
surface_written="$PACK_DIR/surface-written.json"
(cd "$PACK_DIR" && node "$ROOT/scripts/package-surface.mjs" --write control "$PACK_DIR" "$surface_written")
if ! (cd "$ROOT" && node_modules/.bin/biome format --stdin-file-path=scripts/published-surface.json < "$surface_written" | cmp -s - "$surface_written"); then
  echo "package-smoke: package-surface --write, given in another directory, did not lay the snapshot out as the repository's formatter does" >&2
  exit 1
fi
if ! written="$(node "$ROOT/scripts/package-surface.mjs" "$PACK_DIR/surface" "$surface_written" 2>&1)" || [[ "$written" != *", 0 withdrawn, 0 changed)"* ]]; then
  echo "package-smoke: the packed packages do not pass the snapshot written from their own tarballs: $written" >&2
  exit 1
fi

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
