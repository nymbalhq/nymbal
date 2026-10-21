import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runWooCommerceImport } from '../../packages/importers/src/index.js'
import { createS3MediaStorage } from '../../packages/media-s3/src/index.js'
import {
  buildImportEnv,
  importedMedia,
  importOptions,
  sourceCatalogue,
  wooFetch,
} from '../../packages/importers/tests/integration/support/import-env.js'
import { anonymousGet, createPublicBucket, type TestBucket } from '../support/s3'

// Acceptance test for P2-11 AC-4, the MinIO case (spec P2-11-s3-media, decision 5): the WooCommerce fixture import
// (fetch mock) with `deps.media` the S3 storage on this run's bucket leaves every product image in the bucket: each
// media URL is under the bucket's URL, and an anonymous GET of it returns the bytes the mock served for that image,
// with its content type. Requests the mock does not own (MinIO's) go to the real fetch.
// Needs MinIO (NYMBAL_TEST_S3_ENDPOINT). Kills: an importer that writes anywhere but the storage it was given.

let bucket: TestBucket
let tmpDir: string
const realFetch = globalThis.fetch
const catalogue = sourceCatalogue(3)
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

beforeAll(async () => {
  bucket = await createPublicBucket('import')
  tmpDir = await mkdtemp(join(tmpdir(), 'p2-11-import-s3-'))
  vi.stubGlobal('fetch', wooFetch(catalogue, realFetch))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await rm(tmpDir, { recursive: true, force: true })
  await bucket?.remove()
})

describe('P2-11 AC-4: an import into the S3 storage leaves every image in the bucket', () => {
  it('AC-4: every product image URL is under the bucket’s URL, and an anonymous GET of each returns the bytes and content type its source served', async () => {
    const env = await buildImportEnv()
    try {
      const media = createS3MediaStorage({
        bucket: bucket.name,
        endpoint: bucket.endpoint,
        region: bucket.region,
        credentials: bucket.credentials,
      })
      const opts = importOptions(tmpDir)

      const report = await runWooCommerceImport(opts, {
        services: env.services,
        repos: env.repos,
        adapters: env.adapters,
        media,
      })

      expect(report.errors).toEqual([])
      const imported = await importedMedia(env, opts.statePath)
      expect(imported.size).toBe(catalogue.products.length)
      for (const product of catalogue.products) {
        const urls = imported.get(product.id) ?? []
        expect(urls.length, `product ${product.id}`).toBe(product.images.length)
        for (const [i, url] of urls.entries()) {
          const source = product.images[i]!
          expect(url.startsWith(`${bucket.url}/`), `${url} is not under ${bucket.url}/`).toBe(true)
          const got = await anonymousGet(url)
          expect(got.status, url).toBe(200)
          expect(hex(got.bytes), url).toBe(hex(source.bytes))
          expect(got.contentType, url).toBe(source.contentType)
        }
      }
      expect((await bucket.keys()).length).toBe(catalogue.images.size)
    } finally {
      await env.close()
    }
  })
})
