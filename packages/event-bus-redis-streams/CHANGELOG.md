# @nymbalhq/event-bus-redis-streams

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- On a dead server the command client rejects within seconds, and keeps reconnecting.

## 1.1.0

- First release: the `redis-streams` event bus. A named subscription is one consumer group across instances, so it needs
  a shared document store.
- `healthCheck()` answers with `PING`.
