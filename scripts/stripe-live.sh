#!/usr/bin/env bash
# stripe-live.sh: the live proof of agentic checkout on Stripe test mode. An ACP session is paid with a Shared Payment
# Token minted by Stripe's test helper, and Stripe is asked whether the order's PaymentIntent succeeded.
#
# The keys come from the environment (STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY), else from .env.local at this
# checkout's root, then at the main checkout's. Only those two lines are read, and neither is ever printed. Only test
# keys run it, and no keys is a failure, never a skip. It prints `acp-stripe-live: <payment intent> <seconds>s`.
set -euo pipefail
set +x

root="$(git rev-parse --show-toplevel)"
main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"

# The value of `name` on its first line in `file`, unquoted; nothing when the file or the line is missing.
read_key() {
  local name="$1" file="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^${name}=" "$file" | head -n 1 || true)"
  value="${line#"${name}="}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

find_key() {
  local name="$1" value="${!1:-}" file
  for file in "$root/.env.local" "$main/.env.local"; do
    [ -n "$value" ] && break
    value="$(read_key "$name" "$file")"
  done
  printf '%s' "$value"
}

secret="$(find_key STRIPE_SECRET_KEY)"
publishable="$(find_key STRIPE_PUBLISHABLE_KEY)"

for name in STRIPE_SECRET_KEY STRIPE_PUBLISHABLE_KEY; do
  value="$secret"; [ "$name" = STRIPE_PUBLISHABLE_KEY ] && value="$publishable"
  if [ -z "$value" ]; then
    echo "stripe-live: no Stripe test keys: no $name in the environment or .env.local" >&2
    exit 1
  fi
done
case "$secret" in sk_test_*) ;; *) echo "stripe-live: only Stripe test keys run this proof (STRIPE_SECRET_KEY is not sk_test_)" >&2; exit 2 ;; esac
case "$publishable" in pk_test_*) ;; *) echo "stripe-live: only Stripe test keys run this proof (STRIPE_PUBLISHABLE_KEY is not pk_test_)" >&2; exit 2 ;; esac

cd "$root"
STRIPE_SECRET_KEY="$secret" STRIPE_PUBLISHABLE_KEY="$publishable" NYMBAL_STRIPE_LIVE=1 \
  exec pnpm vitest run --project stripe-live
