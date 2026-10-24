# @nymbalhq/http

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0
  - @nymbalhq/config@1.3.0

## 1.2.0

- Every response carries `x-correlation-id`, Fastify's own 404 and 400 included.
- CORS exposes `x-correlation-id` and `Idempotent-Replayed`.

## 1.1.0

- The listening line logs at debug.

## 1.0.0

- `stop()` ends open event streams and closes their connections, so stopping the store no longer hangs with the admin
  open.

## 0.2.0

- First release under `@nymbalhq`.
- Every route passes one CSRF and rate-limit guard before auth. **Breaking:** `trustProxy` defaults to `false`.
- Routes registered with `rawBody: true` keep the exact request bytes, for webhook signatures.
