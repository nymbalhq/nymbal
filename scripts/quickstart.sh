#!/usr/bin/env bash
# quickstart.sh <astro|nextjs>: the quickstart page (apps/docs/src/content/docs/quickstart.md), run. Its commands are
# the page's, in the page's order (a test holds the two together). Untimed setup: every public package of this
# checkout published to a local registry at one snapshot version (local-registry.sh), so nothing reaches npmjs. Timed:
#   scaffold  create-nymbal-app, installed and seeded
#   deploy    Postgres in a container, `nymbal add postgres` and `stripe` (placeholder test keys: an agent's call takes
#             no payment), the image, migrate and seed in it, `nymbal start` in a container on port 8080
#   mcp       an agent's calls through the store's own `nymbal mcp` (the `quickstart` vitest project)
# The last line is `quickstart: <template> scaffold <s> s, deploy <s> s, mcp <s> s, total <s> s`, or
# `quickstart: crash <what>` or `quickstart: failed <step>` with exit 1. Needs Docker, and port 8080 free.
#
# It edits package versions and the generated scaffold in this checkout while it runs, and restores them on exit.
set -euo pipefail

template="${1:-}"
case "$template" in
  astro | nextjs) ;;
  *) echo "usage: quickstart.sh <astro|nextjs>" >&2; exit 2 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# One Node for every step, as scaffold-clean.sh: better-sqlite3 is built for one ABI.
PATH="$(dirname "$(cd "$root" && node -p process.execPath)"):$PATH"
export PATH
work="$(mktemp -d)"
parent="$(mktemp -d)"
# shellcheck source=local-registry.sh
. "$root/scripts/local-registry.sh"

BUDGET_S=900
step="setup"
reported=0
started=0

now_ms() { node -p 'Date.now()'; }
seconds_since() { node -p "((Date.now() - $1) / 1000).toFixed(1)"; }
report() { echo "quickstart: $*"; reported=1; }

cleanup() {
  local status=$?
  set +e
  if [ "$status" -ne 0 ] && [ "$reported" -eq 0 ]; then
    docker logs my-store 2>&1 | tail -40 >&2
    report "failed $step"
  fi
  docker rm -f my-store my-store-db >/dev/null 2>&1
  docker network rm my-store >/dev/null 2>&1
  [ "$started" -eq 1 ] && docker image rm -f my-store >/dev/null 2>&1
  registry_cleanup
  rm -rf "$work" "$parent"
  exit "$status"
}
trap cleanup EXIT

for name in my-store my-store-db; do
  if docker container inspect "$name" >/dev/null 2>&1; then
    echo "quickstart: a container named $name exists; remove it first" >&2
    exit 2
  fi
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://localhost:8080/ || true)" != "000" ]; then
  echo "quickstart: port 8080 is in use" >&2
  exit 2
fi

# ─── untimed: the packages this checkout would release, on a local registry ─────────────────────────────────────
registry_start quickstart
registry_publish quickstart
echo "quickstart: snapshot $snapshot on $registry"
# npx installs create-nymbal-app without asking, as it does for a reader who answers yes.
export npm_config_yes=true
# The image installs from the lockfile, whose packages are on this host's loopback: on Linux the build shares the
# host's network; Docker Desktop reaches the host only as host.docker.internal, so the build's npm is told that name.
port="${registry##*:}"
build_network=""
[ "$(uname -s)" = Linux ] && build_network="--network host"

total_start="$(now_ms)"
started=1
cd "$parent"

# ─── scaffold ────────────────────────────────────────────────────────────────────────────────────────────────────
step="scaffold"
scaffold_start="$(now_ms)"
npx create-nymbal-app my-store --template "$template" --yes
cd my-store
scaffold_seconds="$(seconds_since "$scaffold_start")"

# ─── deploy ──────────────────────────────────────────────────────────────────────────────────────────────────────
step="deploy"
deploy_start="$(now_ms)"
docker network create my-store
docker run -d --name my-store-db --network my-store -e POSTGRES_PASSWORD=nymbal postgres:16-alpine
npx nymbal add postgres
npx nymbal add stripe
cp .env .env.production
cat >> .env.production <<'EOF'
DATABASE_URL=postgres://postgres:nymbal@my-store-db:5432/postgres
NYMBAL_PUBLIC_URL=http://localhost:8080
NYMBAL_STOREFRONT_URL=http://localhost:8080
STRIPE_SECRET_KEY=sk_test_quickstart
STRIPE_WEBHOOK_SECRET=whsec_quickstart
STRIPE_PUBLISHABLE_KEY=pk_test_quickstart
EOF
if [ -z "$build_network" ]; then
  cp .npmrc "$work/npmrc.project"
  printf 'registry=http://host.docker.internal:%s/\nreplace-registry-host=always\n' "$port" >> .npmrc
fi
# shellcheck disable=SC2086
npx nymbal build --image -- $build_network
[ -z "$build_network" ] && cp "$work/npmrc.project" .npmrc
for _ in $(seq 60); do docker exec my-store-db pg_isready -U postgres && break; sleep 1; done
docker exec my-store-db pg_isready -U postgres >/dev/null || { report "failed deploy (database never ready)"; exit 1; }
docker run --rm --network my-store --env-file .env.production my-store node node_modules/nymbal/bin/nymbal.mjs migrate
docker run --rm --network my-store --env-file .env.production my-store node node_modules/nymbal/bin/nymbal.mjs seed
docker run -d --name my-store --network my-store --env-file .env.production -p 8080:3001 my-store
step="deploy (waiting for /ready)"
ready=0
for _ in $(seq 1 240); do
  if [ "$(docker inspect -f '{{.State.Running}}' my-store)" != "true" ]; then
    docker logs my-store 2>&1 | tail -40 >&2
    report "crash the store's container exited while starting"
    exit 1
  fi
  # Connection refused (000) until the port opens, which it does only once the store can answer: a 5xx is a crash.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:8080/ready || true)"
  if [ "$code" = "200" ]; then
    ready=1
    break
  fi
  case "$code" in 5*) report "crash GET /ready answered $code"; exit 1 ;; esac
  sleep 0.5
done
[ "$ready" -eq 1 ] || exit 1
deploy_seconds="$(seconds_since "$deploy_start")"

# ─── an agent's call over MCP ────────────────────────────────────────────────────────────────────────────────────
step="mcp"
mcp_start="$(now_ms)"
NYMBAL_MCP_URL=http://localhost:8080/api/mcp npx nymbal mcp tools
project="$(pwd -P)"
if ! (cd "$root" && NYMBAL_SCAFFOLD_DIR="$project" NYMBAL_STORE_URL=http://localhost:8080 NYMBAL_CONTAINER=my-store \
  pnpm vitest run --project quickstart); then
  if [ -s "$parent/quickstart-crash" ]; then
    report "crash $(paste -sd ';' "$parent/quickstart-crash")"
  fi
  exit 1
fi
mcp_seconds="$(seconds_since "$mcp_start")"
total_seconds="$(seconds_since "$total_start")"

# ─── clean up, as the page does (the exit trap does it on any failure) ──────────────────────────────────────────
step="clean up"
docker rm -f my-store my-store-db
docker network rm my-store

line="$template scaffold $scaffold_seconds s, deploy $deploy_seconds s, mcp $mcp_seconds s, total $total_seconds s"
if node -e "process.exit(Number(process.argv[1]) < $BUDGET_S ? 0 : 1)" "$total_seconds"; then
  report "$line"
else
  report "failed total over $BUDGET_S s: $line"
  exit 1
fi
