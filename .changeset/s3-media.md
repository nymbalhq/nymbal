---
'@nymbalhq/media-s3': minor
'@nymbalhq/platform': minor
'@nymbalhq/config': minor
'nymbal': patch
'@nymbalhq/importers': minor
---

A store can keep its media in an S3-compatible bucket: `infrastructure.media: 's3'`. Each stored object is
`<prefix>/<key>` in the bucket, and its URL is the bucket's public URL. The storage is the new `@nymbalhq/media-s3`
package, which the kernel imports only when the config names it: `npm install @nymbalhq/media-s3 @aws-sdk/client-s3`.
A missing package fails `createApp` with `adapter.package_missing` and that install line.

- An optional `infrastructure.s3` block takes `bucket`, `region`, `endpoint`, `prefix`, `publicUrl` and
  `forcePathStyle`. Each falls back to the environment: `S3_BUCKET`, `AWS_REGION`, `S3_ENDPOINT`, `NYMBAL_S3_PREFIX`
  and `S3_PUBLIC_URL`. The region defaults to `us-east-1`, there is no prefix by default, and requests are path-style
  when an endpoint is set.
- With no bucket in the block or `S3_BUCKET`, `createApp` fails `config.s3_bucket_missing` before anything is loaded.
- Credentials are never config keys: the AWS SDK's default chain provides them (`AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY`, a profile or a role). Any other key inside the block, and an `s3` block while `media` is
  not `'s3'`, fail `loadConfig` naming the key.
- A URL is `publicUrl` when it is set, else `endpoint/bucket`, else `https://<bucket>.s3.<region>.amazonaws.com`.
  The object key follows it, with each path segment percent-encoded. The storage never creates buckets or sets
  policies: the bucket must already serve its objects publicly.

`nymbal import` now writes product images to the store's media storage. With `local-fs` (the default) that is the
same files under `public/imported-media` with the same `/imported-media/...` URLs as before. The import no longer
crashes at start on `p.bold is not a function`.

**Breaking for code that calls the importer (`@nymbalhq/importers`).** `WooCommerceImporterDeps` takes a required
`media: MediaStorage`, and `runWooCommerceImport` builds no storage of its own: pass `app.platform.media`.
`WooCommerceImportOptions.projectRoot` stays, but media no longer uses it. A `put` that rejects is now reported, not
dropped: the product is created with the images that did store, the report's `errors` gets
`{ phase: 'media', id: <WooCommerce product id>, error }`, and an `error` progress event matches it.
