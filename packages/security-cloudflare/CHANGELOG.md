# @nymbalhq/security-cloudflare

## 1.4.0

### Patch Changes

- Updated dependencies [8e06b03]
- Updated dependencies [295dab6]
- Updated dependencies [d724fd2]
- Updated dependencies [6f73872]
- Updated dependencies [ff6559d]
- Updated dependencies [8e06b03]
- Updated dependencies [75989c8]
- Updated dependencies [dbf1425]
- Updated dependencies [c8588b2]
  - @nymbalhq/types@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- First release: `security.adapter: 'cloudflare'` puts the store's rate limits, geo block, custom rules and managed
  rulesets on a Cloudflare zone. The zone changes only by command (`nymbal security:plan|apply|drift|inspect`), and the
  zone's own rules are kept first.
- `security:apply` adds a cache rule for `/fragments/`. The API token needs Zone › Zone › Read, Zone › Zone WAF › Edit
  and Zone › Cache Rules › Edit.
