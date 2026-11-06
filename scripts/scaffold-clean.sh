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
dev_pid=""
# shellcheck source=local-registry.sh
. "$root/scripts/local-registry.sh"
registry_allow_given=1

now_ms() { node -p 'Date.now()'; }
free_port() { registry_free_port; }
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
  registry_cleanup
  rm -rf "$work" "$parent"
  exit "$status"
}
trap cleanup EXIT

# ─── a registry, and every public package published to it at one snapshot version ──────────────────────────────
registry_start scaffold-clean
registry_publish scaffold
echo "scaffold-clean: snapshot $snapshot on $registry"

# ─── create + install, outside the checkout ─────────────────────────────────────────────────────────────────────
create_start="$(now_ms)"
(cd "$parent" && npx --yes create-nymbal-app shop --template "$template" --yes)
create_seconds="$(seconds_since "$create_start")"
project="$parent/shop"
# The agent proof places an order, which a store's default proposal-only writes would hold back.
node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const path = process.argv[1]
const source = readFileSync(path, "utf8")
const end = source.lastIndexOf("\n})")
if (end < 0) throw new Error(`no closing defineConfig in ${path}`)
writeFileSync(path, `${source.slice(0, end)}\n\n  agents: { mcp: { writes: "apply" } },${source.slice(end)}`)
' "$project/nymbal.config.ts"

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
if [ -f "$parent/mcp-proof" ]; then
  cat "$parent/mcp-proof"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$parent/mcp-proof" >>"$GITHUB_STEP_SUMMARY"; fi
fi
