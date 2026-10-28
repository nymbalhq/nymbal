# @nymbalhq/doc-store-redis

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

- On a dead server a command rejects within seconds, and the client keeps reconnecting.
- Implements `replaceCollection` by staging a hash and renaming it, for `nymbal replay`.

## 1.1.0

- First release: the `redis` document store, configured by `infrastructure.redis` (`url`, `prefix`).
- `healthCheck()` answers with `PING`.
- Ships the `redis` recipe for `nymbal add redis`.
