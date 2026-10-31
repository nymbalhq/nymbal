#!/usr/bin/env bash
# scaffold-image.sh <astro|nextjs>: the image proof. Publishes every public package to a local registry at one
# snapshot version (as scaffold-clean.sh does), scaffolds a store outside this checkout, puts it on Postgres, the Redis
# document store and the Redis Streams bus with `nymbal add`, builds its image with `nymbal build --image`, runs
# `nymbal migrate` and `nymbal seed` in it, starts `nymbal start` in a container on PORT=8080, and runs the
# `scaffold-image` vitest project against the container's port. Needs Docker, and a Postgres and a Redis the containers
# reach on the host: NYMBAL_TEST_POSTGRES_URL and NYMBAL_TEST_REDIS_URL, else this worktree's compose stack.
#
# It edits package versions, the generated scaffold and the lockfile in this checkout while it runs, and restores them
# on exit.
set -euo pipefail

template="${1:-}"
case "$template" in
  astro | nextjs) ;;
  *) echo "usage: scaffold-image.sh <astro|nextjs>" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PATH="$(dirname "$(cd "$root" && node -p process.execPath)"):$PATH"
export PATH
work="$(mktemp -d)"
parent="$(mktemp -d)"
registry_container=""
store_container=""
image=""
database=""
restore=0

if [ -z "${NYMBAL_TEST_POSTGRES_URL:-}" ] || [ -z "${NYMBAL_TEST_REDIS_URL:-}" ]; then
  eval "$(cd "$root" && pnpm --silent stack env)"
fi
postgres_url="${NYMBAL_TEST_POSTGRES_URL:-postgres://postgres:nymbal@localhost:${NYMBAL_POSTGRES_PORT:-54329}/nymbal}"
redis_url="${NYMBAL_TEST_REDIS_URL:-redis://localhost:${NYMBAL_REDIS_PORT:-63799}}"

now_ms() { node -p 'Date.now()'; }
free_port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }
seconds_since() { node -p "((Date.now() - $1) / 1000).toFixed(1)"; }
# The same server, as a container reaches the host.
from_container() { printf '%s' "$1" | sed -E 's#@(localhost|127\.0\.0\.1):#@host.docker.internal:#; s#//(localhost|127\.0\.0\.1):#//host.docker.internal:#'; }
# `url` with its database replaced by `name`.
with_database() { node -e 'const u=new URL(process.argv[1]); u.pathname="/"+process.argv[2]; console.log(u.toString())' "$1" "$2"; }
# Runs `sql` on the server at NYMBAL_TEST_POSTGRES_URL, with the platform's own pg client.
psql_run() {
  (cd "$root/packages/platform" && node -e '
const { Client } = require("pg")
const client = new Client({ connectionString: process.argv[1] })
client.connect().then(() => client.query(process.argv[2])).finally(() => client.end())
  .catch((error) => { console.error(error.message); process.exit(1) })' "$postgres_url" "$1")
}

cleanup() {
  local status=$?
  set +e
  [ -n "$store_container" ] && docker rm -f "$store_container" >/dev/null 2>&1
  [ -n "$image" ] && docker image rm -f "$image" >/dev/null 2>&1
  [ -n "$database" ] && psql_run "DROP DATABASE IF EXISTS \"$database\" WITH (FORCE)" >/dev/null 2>&1
  [ -n "$registry_container" ] && docker rm -f "$registry_container" >/dev/null 2>&1
  if [ "$restore" -eq 1 ]; then tar -xf "$work/backup.tar" -C "$root"; fi
  rm -rf "$work" "$parent"
  exit "$status"
}
trap cleanup EXIT

# ─── a registry ──────────────────────────────────────────────────────────────────────────────────────────────────
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
registry_container="$(docker run -d --rm -p "127.0.0.1:$port:4873" \
  -v "$work/verdaccio.yaml:/verdaccio/conf/config.yaml:ro" verdaccio/verdaccio:6)"
registry="http://localhost:$port"
for _ in $(seq 1 60); do curl -fs "$registry/-/ping" >/dev/null 2>&1 && break; sleep 1; done
curl -fs "$registry/-/ping" >/dev/null || { echo "scaffold-image: registry did not start" >&2; exit 1; }

cat > "$work/npmrc" <<EOF
registry=$registry/
//localhost:$port/:_authToken=scaffold-image
EOF
export npm_config_userconfig="$work/npmrc" NPM_CONFIG_USERCONFIG="$work/npmrc"
export npm_config_registry="$registry/"
export npm_config_cache="$work/npm-cache"

# ─── publish every public package at one snapshot version ───────────────────────────────────────────────────────
(cd "$root" && node scripts/workspace-packages.ts --manifests) > "$work/manifests"
tar -cf "$work/backup.tar" -C "$root" $(cat "$work/manifests") packages/create-app/scaffold pnpm-lock.yaml
restore=1

snapshot="$(cd "$root" && MANIFESTS="$work/manifests" node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const paths = readFileSync(process.env.MANIFESTS, "utf8").split("\n").filter(Boolean)
const manifests = paths.map((path) => ({ path, pkg: JSON.parse(readFileSync(path, "utf8")) }))
const stack = manifests.find((m) => m.pkg.name === "@nymbalhq/stack").pkg
const version = `${stack.version}-image.${Math.floor(Date.now() / 1000)}`
for (const { path, pkg } of manifests) {
  if (pkg.private) continue
  pkg.version = version
  if (pkg.name === "@nymbalhq/stack") {
    for (const name of Object.keys(pkg.dependencies)) pkg.dependencies[name] = version
  }
  if (pkg.peerDependencies?.["@nymbalhq/types"]) pkg.peerDependencies["@nymbalhq/types"] = `^${version}`
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n")
}
console.log(version)
')"
echo "scaffold-image: snapshot $snapshot on $registry"

(cd "$root" && pnpm build >/dev/null && pnpm --filter @nymbalhq/admin build >/dev/null && pnpm -r publish --no-git-checks --access public --tag latest --registry "$registry/" >"$work/publish.log" 2>&1) \
  || { tail -30 "$work/publish.log" >&2; echo "scaffold-image: publish failed" >&2; exit 1; }

# ─── create, on Postgres and Redis ──────────────────────────────────────────────────────────────────────────────
(cd "$parent" && npx --yes create-nymbal-app shop --template "$template" --yes)
project="$parent/shop"
# Config is code and bakes into the image, so the store's infrastructure is set before the build.
(cd "$project" && npx nymbal add postgres && npx nymbal add redis)

# ─── the image ──────────────────────────────────────────────────────────────────────────────────────────────────
image="nymbal-scaffold-image-$template:${snapshot##*.}"
build_start="$(now_ms)"
# The lockfile resolves packages at the local registry on the host's loopback.
(cd "$project" && node node_modules/nymbal/bin/nymbal.mjs build --image --tag "$image" -- --network host)
build_seconds="$(seconds_since "$build_start")"
image_mb="$(docker image inspect -f '{{.Size}}' "$image" | node -p 'Math.round(Number(require("fs").readFileSync(0, "utf8")) / 1e6)')"

# ─── migrate, seed, start ───────────────────────────────────────────────────────────────────────────────────────
database="scaffold_image_${template}_$(date +%s)"
psql_run "CREATE DATABASE \"$database\""
host_database_url="$(with_database "$postgres_url" "$database")"
secrets_key="$(sed -n 's/^NYMBAL_SECRETS_KEY=//p' "$project/.env")"
admin_email="$(sed -n 's/^NYMBAL_ADMIN_EMAIL=//p' "$project/.env")"
admin_password="$(sed -n 's/^NYMBAL_ADMIN_PASSWORD=//p' "$project/.env")"
store_port="$(free_port)"
store_url="http://localhost:$store_port"
cat > "$work/container.env" <<EOF
DATABASE_URL=$(from_container "$host_database_url")
REDIS_URL=$(from_container "$redis_url")
NYMBAL_REDIS_PREFIX=$database
NYMBAL_SECRETS_KEY=$secrets_key
NYMBAL_ADMIN_EMAIL=$admin_email
NYMBAL_ADMIN_PASSWORD=$admin_password
NYMBAL_PUBLIC_URL=$store_url
PORT=8080
NODE_ENV=staging
EOF
# NODE_ENV=staging: in production the app refuses a fresh scaffold's stub payments and default JWT secret.
in_image() { docker run --rm --add-host host.docker.internal:host-gateway --env-file "$work/container.env" "$image" "$@"; }
in_image node node_modules/nymbal/bin/nymbal.mjs migrate
in_image node node_modules/nymbal/bin/nymbal.mjs seed

ready_start="$(now_ms)"
store_container="$(docker run -d --add-host host.docker.internal:host-gateway --env-file "$work/container.env" \
  -p "127.0.0.1:$store_port:8080" "$image")"
ready=0
for _ in $(seq 1 240); do
  [ "$(docker inspect -f '{{.State.Running}}' "$store_container")" = "true" ] \
    || { docker logs "$store_container" 2>&1 | tail -40 >&2; echo "scaffold-image: the container exited" >&2; exit 1; }
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$store_url/ready" || true)" = "200" ] \
    && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$store_url/" || true)" = "200" ]; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" -eq 1 ] || { docker logs "$store_container" 2>&1 | tail -40 >&2; echo "scaffold-image: no 200 from $store_url" >&2; exit 1; }
ready_seconds="$(seconds_since "$ready_start")"

# ─── the check ───────────────────────────────────────────────────────────────────────────────────────────────────
if ! (cd "$root" && NYMBAL_SCAFFOLD_DIR="$project" NYMBAL_IMAGE="$image" NYMBAL_CONTAINER="$store_container" \
  NYMBAL_STORE_URL="$store_url" NYMBAL_IMAGE_DATABASE_URL="$host_database_url" \
  pnpm vitest run --project scaffold-image); then
  docker logs "$store_container" 2>&1 | tail -40 >&2
  exit 1
fi

echo "scaffold-image: $template image $image_mb MB, build $build_seconds s, first ready $ready_seconds s"
