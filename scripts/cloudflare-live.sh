#!/usr/bin/env bash
# cloudflare-live.sh: the origin lock on a real Cloudflare zone and a deployed app, as the vitest project
# `cloudflare-live`, which exists only under NYMBAL_CLOUDFLARE_LIVE=1 and only this script sets it. Never in CI. It
# writes the zone's rules and the Fly app's NYMBAL_ORIGIN_SECRET, so give it throwaway ones:
#   CLOUDFLARE_LIVE_ZONE_ID     a zone on the free plan
#   CLOUDFLARE_LIVE_API_TOKEN   a token for that zone with Zone › Zone › Read, Zone › Zone WAF › Edit,
#                               Zone › Cache Rules › Edit and Zone › Transform Rules › Edit
#   NYMBAL_LIVE_ORIGIN_URL      the app's direct URL (https://<app>.fly.dev), running this checkout
#   NYMBAL_LIVE_CDN_URL         the same app through the zone
#   NYMBAL_LIVE_FLY_APP         the Fly app, for its secret and its logs (flyctl logged in)
# A missing input is `cloudflare-live: missing <names>` and exit 2, as is a zone not on the free plan, before anything
# is written. It prints no token or secret.
set -euo pipefail

inputs=(
  CLOUDFLARE_LIVE_ZONE_ID
  CLOUDFLARE_LIVE_API_TOKEN
  NYMBAL_LIVE_ORIGIN_URL
  NYMBAL_LIVE_CDN_URL
  NYMBAL_LIVE_FLY_APP
)
missing=()
for name in "${inputs[@]}"; do
  value="${!name:-}"
  [ -n "${value//[[:space:]]/}" ] || missing+=("$name")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "cloudflare-live: missing ${missing[*]}" >&2
  exit 2
fi

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"

for tool in node pnpm flyctl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "cloudflare-live: missing $tool on PATH" >&2
    exit 2
  fi
done

# The plan as the zone reports it, read with the token from the environment and never echoed.
plan="$(
  node --input-type=module -e '
    const zone = encodeURIComponent(process.env.CLOUDFLARE_LIVE_ZONE_ID.trim())
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}`, {
      headers: { authorization: `Bearer ${process.env.CLOUDFLARE_LIVE_API_TOKEN.trim()}` },
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    const body = res === undefined ? undefined : await res.json().catch(() => undefined)
    process.stdout.write(
      res === undefined ? "unreachable" : res.ok ? String(body?.result?.plan?.legacy_id) : `status ${res.status}`,
    )
  '
)"
if [ "$plan" != "free" ]; then
  echo "cloudflare-live: zone $CLOUDFLARE_LIVE_ZONE_ID is not a readable free-plan zone ($plan); nothing was written" >&2
  exit 2
fi

# The run spawns the built CLI.
pnpm build
NYMBAL_CLOUDFLARE_LIVE=1 pnpm vitest run --project cloudflare-live
