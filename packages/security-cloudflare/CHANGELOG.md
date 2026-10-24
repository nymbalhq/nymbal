# @nymbalhq/security-cloudflare

## 1.2.0

### Minor Changes

- eaa120c: `nymbal security:apply` puts one cache rule on the zone, so Cloudflare caches the storefronts' fragment routes, which
  it does not do for HTML without a rule.
  - The rule is in the `http_request_cache_settings` phase, ref `nymbal:cache:fragments`: requests whose path starts
    with `/fragments/` are cached, with the edge and browser TTLs the origin's `Cache-Control` sets (`respect_origin`).
    The zone's own cache rules are kept, unchanged and first, and `security:plan`, `security:drift` and
    `security:inspect` cover the phase like the others.
  - `validate` checks the plan's cache-rule limit (Free 10, Pro 25, Business 50, Enterprise 300) over the whole phase,
    the zone's own rules included.

  **After upgrading,** the API token needs a third permission on the zone, Zone › Cache Rules › Edit, beside Zone › Zone
  › Read and Zone › Zone WAF › Edit. Without it `security:plan` answers `cloudflare.credentials` (exit 2) and names the
  three permissions.

- b836370: A store can put its security rules on its Cloudflare zone: `security.adapter: 'cloudflare'`. The adapter is the new
  `@nymbalhq/security-cloudflare` package (`nymbal add cloudflare`), which the kernel imports only when the config names
  it: `npm install @nymbalhq/security-cloudflare`. It talks to the Cloudflare API with `fetch`, so there is no SDK to
  install beside it.
  - `security.cloudflare` takes `zoneId` and `apiToken` (both required with the `cloudflare` adapter, read with `env()`)
    and an optional `apiBase`. New, all optional: `geo.block` (ISO 3166 alpha-2 codes), `customRules` (`name`,
    `expression`, `action`; names unique) and `managedRulesets` (`'cloudflare'`, `'owasp'`). A `middleware` store parses
    as before.
  - The zone changes only by command, never at boot: `nymbal security:plan [--json]` shows what would change,
    `security:apply` writes it, `security:drift [--json]` reports a dashboard edit (exit 1), and `security:inspect` lists
    the live rules. Exit 2 is a config, credential or API error, and every command exits 2 on a store whose adapter is
    not `cloudflare`. The token is never printed.
  - Each `rateLimit` entry becomes a rate limiting rule (`eq` for an exact path, `wildcard` for `*` and `**`), the geo
    block one custom rule, and each managed ruleset one execute rule. Every rule Nymbal writes has a `nymbal:` ref; the
    zone's own rules are kept, unchanged and first. `validate` checks the zone's plan limits over every rule in a phase,
    the zone's own included.
  - In process, the adapter sets the same response headers as `middleware`.

  **Breaking:** `security.adapter: 'aws-waf'` or `'akamai'` now fails `createApp` with a `ConfigError` naming the
  adapters that exist (`middleware, cloudflare`); before, both silently ran `middleware`. `ProviderPackage.sdk` is
  optional, and `Slot` includes `security`. `buildSecurityHeaders` is exported from `@nymbalhq/types` as well.

### Patch Changes

- Updated dependencies [45b8128]
- Updated dependencies [b836370]
- Updated dependencies [3591951]
- Updated dependencies [7a4e472]
- Updated dependencies [0fe6563]
  - @nymbalhq/types@1.2.0
