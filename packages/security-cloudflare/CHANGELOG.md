# @nymbalhq/security-cloudflare

## 1.2.0

- First release: `security.adapter: 'cloudflare'` puts the store's rate limits, geo block, custom rules and managed
  rulesets on a Cloudflare zone. The zone changes only by command (`nymbal security:plan|apply|drift|inspect`), and the
  zone's own rules are kept first.
- `security:apply` adds a cache rule for `/fragments/`. The API token needs Zone › Zone › Read, Zone › Zone WAF › Edit
  and Zone › Cache Rules › Edit.
