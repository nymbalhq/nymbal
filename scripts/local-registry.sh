# local-registry.sh: sourced by scaffold-clean.sh, scaffold-image.sh and quickstart.sh. A local Verdaccio and every
# public package published to it at one snapshot version, so a store scaffolds from what this checkout would release
# with nothing sent to npmjs and no token.
#
# The caller sets `root` (this checkout) and `work` (a scratch directory), and calls `registry_cleanup` from its exit
# trap. `registry_start <name>` starts the registry (or takes NYMBAL_REGISTRY when `registry_allow_given=1`) and points
# every npm and pnpm call at it; `registry_publish <label>` stamps the versions, builds and publishes, and sets
# `snapshot`. The stamped manifests, the generated scaffold and the lockfile are restored by `registry_cleanup`.

registry=""
registry_container=""
registry_restore=0
snapshot=""

registry_free_port() { node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})'; }

registry_cleanup() {
  [ -n "$registry_container" ] && docker rm -f "$registry_container" >/dev/null 2>&1
  if [ "$registry_restore" -eq 1 ]; then tar -xf "$work/backup.tar" -C "$root"; fi
  return 0
}

registry_start() {
  local name="$1" port host
  registry="${NYMBAL_REGISTRY:-}"
  if [ -z "$registry" ] || [ "${registry_allow_given:-0}" != 1 ]; then
    port="$(registry_free_port)"
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
    curl -fs "$registry/-/ping" >/dev/null || { echo "$name: registry did not start" >&2; return 1; }
  fi
  registry="${registry%/}"
  host="${registry#*://}"
  # One userconfig for every npm and pnpm call, so nothing reads the caller's ~/.npmrc.
  cat > "$work/npmrc" <<EOF
registry=$registry/
//$host/:_authToken=$name
EOF
  export npm_config_userconfig="$work/npmrc" NPM_CONFIG_USERCONFIG="$work/npmrc"
  export npm_config_registry="$registry/"
  export npm_config_cache="$work/npm-cache"
}

registry_publish() {
  local label="$1"
  # One list of member manifests, at any depth, for both the backup and the stamping, so the exit trap restores
  # exactly what was stamped. The lockfile too: pnpm rewrites it for the stamped versions.
  (cd "$root" && node scripts/workspace-packages.ts --manifests) > "$work/manifests"
  # shellcheck disable=SC2046
  tar -cf "$work/backup.tar" -C "$root" $(cat "$work/manifests") packages/create-app/scaffold pnpm-lock.yaml
  registry_restore=1

  snapshot="$(cd "$root" && MANIFESTS="$work/manifests" LABEL="$label" node -e '
const { readFileSync, writeFileSync } = require("node:fs")
const paths = readFileSync(process.env.MANIFESTS, "utf8").split("\n").filter(Boolean)
const manifests = paths.map((path) => ({ path, pkg: JSON.parse(readFileSync(path, "utf8")) }))
const stack = manifests.find((m) => m.pkg.name === "@nymbalhq/stack").pkg
const version = `${stack.version}-${process.env.LABEL}.${Math.floor(Date.now() / 1000)}`
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

  # The root build covers packages/** only; the admin publishes its dist, which the CLI serves.
  (cd "$root" && pnpm build >/dev/null && pnpm --filter @nymbalhq/admin build >/dev/null \
    && pnpm -r publish --no-git-checks --access public --tag latest --registry "$registry/" >"$work/publish.log" 2>&1) \
    || { tail -30 "$work/publish.log" >&2; echo "publish to $registry failed" >&2; return 1; }
}
