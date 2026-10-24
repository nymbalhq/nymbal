# @nymbalhq/media-s3

## 1.3.0

### Patch Changes

- Updated dependencies [0cfbcf2]
  - @nymbalhq/types@1.3.0

## 1.2.0

- `createS3ObjectWriter` writes private objects, for the event archive.

## 1.1.0

- First release: S3-compatible media storage for `infrastructure.media: 's3'`. Install it with `@aws-sdk/client-s3`; the
  bucket must already serve its objects publicly.
- `healthCheck()` checks the bucket with `HeadBucket`.
- Ships the `s3` recipe for `nymbal add s3`.
