#!/usr/bin/env bash
# scaffold-clean.sh <astro|nextjs>: the clean-machine proof. Publishes every public package to a local registry at one
# snapshot version, scaffolds a store outside this checkout with `npx create-nymbal-app`, serves it with
# `npx nymbal dev`, and runs the `scaffold-clean` vitest project against it. Nothing reaches npmjs and no token is
# needed. Needs Docker (Verdaccio) unless NYMBAL_REGISTRY points at a registry that accepts anonymous publishes.
#
# It edits package versions and the generated scaffold in this checkout while it runs, and restores them on exit.
set -euo pipefail

template="${1:-}"
case "$template" in
  astro) default_store_port=4321 ;;
  nextjs) default_store_port=3000 ;;
  *) echo "usage: scaffold-clean.sh <astro|nextjs>" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# One Node for every step: a version manager that follows .node-version would otherwise pick another inside the
# scaffolded project than outside it, and better-sqlite3 is built for one ABI.
PATH="$(dirname "$(cd "$root" && node -p process.execPath)"):$PATH"
export PATH
work="$(mktemp -d)"
parent="$(mktemp -d)"
registry="${NYMBAL_REGISTRY:-}"
container=""
dev_pid=""
restore=0

now_ms() { node -p 'Date.now()'; }
free_port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
seconds_since() { node -p "((Date.now() - $1) / 1000).toFixed(1)"; }

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

cleanup() {
  local status=$?
  set +e
  [ -n "$dev_pid" ] && kill_tree "$dev_pid"
  [ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1
  if [ "$restore" -eq 1 ]; then tar -xf "$work/backup.tar" -C "$root"; fi
  rm -rf "$work" "$parent"
  exit "$status"
}
trap cleanup EXIT

# ─── a registry ──────────────────────────────────────────────────────────────────────────────────────────────────
if [ -z "$registry" ]; then
  port="$(free_port)"
  cat > "$work/verdaccio.yaml" <<'YAML'
storage: /verdaccio/storage/data
max_body_size: 200mb
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@nymbalhq/*':
    access: $all
    publish: $all
  'nymbal':
    access: $all
    publish: $all
  'create-nymbal-app':
    access: $all
    publish: $all
  '**':
    access: $all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML
  container="$(docker run -d --rm -p "127.0.0.1:$port:4873" \
    -v "$work/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" verdaccio/verdaccio:6)"
  registry="http://localhost:$port"
  for _ in $(seq 1 60); do curl -fs "$registry/-/ping" >/dev/null 2>&1 && break; sleep 1; done
  curl -fs "$registry/-/ping" >/dev/null || { echo "scaffold-clean: registry did not start" >&2; exit 1; }
fi
registry="${registry%/}"
host="${registry#*://}"

# One userconfig for every npm and pnpm call below, so nothing reads the caller's ~/.npmrc.
cat > "$work/npmrc" <<EOF
registry=$registry/
//$host/:_authToken=scaffold-clean
EOF
export npm_config_userconfig="$work/npmrc" NPM_CONFIG_USERCONFIG="$work/npmrc"
export npm_config_registry="$registry/"
export npm_config_cache="$work/npm-cache"

# ─── publish every public package at one snapshot version ───────────────────────────────────────────────────────
# One list of member manifests, at any depth, for both the backup and the stamping, so the exit trap restores exactly
# what was stamped. The lockfile too: pnpm rewrites it for the stamped versions.
(cd "$root" && node scripts/workspace-packages.ts --manifests) > "$work/manifests"
tar -cf "$work/backup.tar" -C "$root" $(cat "$work/manifests") packages/create-app/scaffold pnpm-lock.yaml
restore=1

snapshot="$(cd "$root" && MANIFESTS="$work/manifests" node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const paths = readFileSync(process.env.MANIFESTS, "utf8").split("\n").filter(Boolean)
const manifests = paths.map((path) => ({ path, pkg: JSON.parse(readFileSync(path, "utf8")) }))
const stack = manifests.find((m) => m.pkg.name === "@nymbalhq/stack").pkg
const version = `${stack.version}-scaffold.${Math.floor(Date.now() / 1000)}`
for (const { path, pkg } of manifests) {
  if (pkg.private) continue
  pkg.version = version
  if (pkg.name === "@nymbalhq/stack") {
    for (const name of Object.keys(pkg.dependencies)) pkg.dependencies[name] = version
  }
  // An adapter peers types at a literal floor of the coming release, which no snapshot prerelease satisfies.
  if (pkg.peerDependencies?.["@nymbalhq/types"]) pkg.peerDependencies["@nymbalhq/types"] = `^${version}`
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
}
console.log(version)
')"
echo "scaffold-clean: snapshot $snapshot on $registry"

# The root build covers packages/** only; the admin publishes its dist, which `nymbal dev` serves.
(cd "$root" && pnpm build >/dev/null && pnpm --filter @nymbalhq/admin build >/dev/null && pnpm -r publish --no-git-checks --access public --tag latest --registry "$registry/" >"$work/publish.log" 2>&1) \
  || { tail -30 "$work/publish.log" >&2; echo "scaffold-clean: publish failed" >&2; exit 1; }

# ─── create + install, outside the checkout ─────────────────────────────────────────────────────────────────────
create_start="$(now_ms)"
(cd "$parent" && npx --yes create-nymbal-app shop --template "$template" --yes)
create_seconds="$(seconds_since "$create_start")"
project="$parent/shop"

# ─── first serve ─────────────────────────────────────────────────────────────────────────────────────────────────
store_port="$(free_port)"
store_url="http://localhost:$store_port"
api_port="$(free_port)"
# Each draw's port is closed before the next, so the OS can hand out the store's again.
while [ "$api_port" = "$store_port" ]; do api_port="$(free_port)"; done
api_url="http://localhost:$api_port"
serve_start="$(now_ms)"
(cd "$project" && exec npx nymbal dev --port "$api_port" --storefront-port "$store_port") >"$work/dev.log" 2>&1 &
dev_pid=$!

served=0
for _ in $(seq 1 600); do
  kill -0 "$dev_pid" 2>/dev/null || { tail -40 "$work/dev.log" >&2; echo "scaffold-clean: nymbal dev exited" >&2; exit 1; }
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 "$store_url/" || true)" = "200" ]; then served=1; break; fi
  sleep 0.5
done
[ "$served" -eq 1 ] || { tail -40 "$work/dev.log" >&2; echo "scaffold-clean: no 200 from $store_url" >&2; exit 1; }
serve_seconds="$(seconds_since "$serve_start")"

# ─── the check ───────────────────────────────────────────────────────────────────────────────────────────────────
if ! (cd "$root" && NYMBAL_SCAFFOLD_DIR="$project" NYMBAL_STORE_URL="$store_url" NYMBAL_API_URL="$api_url" \
  pnpm vitest run --project scaffold-clean); then
  tail -40 "$work/dev.log" >&2
  exit 1
fi

echo "scaffold-clean: $template create+install $create_seconds s, first serve $serve_seconds s"
