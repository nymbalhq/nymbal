---
'@nymbalhq/security-cloudflare': minor
---

`nymbal security:apply` puts one cache rule on the zone, so Cloudflare caches the storefronts' fragment routes, which
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
