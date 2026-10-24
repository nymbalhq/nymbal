import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MediaStorage } from '../../packages/types/src/adapters/media.js'
import {
  runMediaStorageContract,
  type MediaStorageContractOptions,
} from '../../packages/contract-tests/src/index.js'
import { createS3MediaStorage, s3ObjectUrl } from '../../packages/media-s3/src/index.js'
import {
  anonymousGet,
  createPublicBucket,
  S3_TEST_REGION,
  s3Credentials,
  s3Endpoint,
  uniqueBucketName,
  type TestBucket,
} from '../support/s3'
import { closedPort } from '../support/tcp-proxy'

// AC-3, the MinIO half: runMediaStorageContract from the package's index passes on the S3 storage with `fetchUrl` an
// anonymous HTTP GET of the returned URL, so each URL really serves its bytes to anyone; a HEAD of each object answers
// the content type it was put with; and with a prefix, the object is stored at `<prefix>/<key>` (the prefix's edge
// slashes trimmed) and its URL is s3ObjectUrl's. `unreachable` is the storage on an endpoint nobody listens on, so
// the downtime cases run here too; the recording wrapper forwards healthCheck, which the suite requires of every
// primitive. The bucket is this run's own, made public-read here and removed afterwards. Needs MinIO
// (NYMBAL_TEST_S3_ENDPOINT).

const endpoint = s3Endpoint()
const name = uniqueBucketName('contract')
let bucket: TestBucket

beforeAll(async () => {
  bucket = await createPublicBucket('contract', name)
})
afterAll(async () => {
  await bucket?.remove()
})

const options = (more: { prefix?: string; endpoint?: string } = {}) => ({
  bucket: name,
  endpoint,
  region: S3_TEST_REGION,
  credentials: s3Credentials(),
  ...more,
})

/** Every put the contract makes, by URL, with the content type of the last put to it. */
const lastContentType = new Map<string, string>()
function recorded(storage: MediaStorage): MediaStorage {
  return {
    capabilities: () => storage.capabilities(),
    ...(storage.healthCheck !== undefined && { healthCheck: () => storage.healthCheck!() }),
    async put(key, body, contentType) {
      const result = await storage.put(key, body, contentType)
      lastContentType.set(result.url, contentType)
      return result
    },
  }
}

const fetchUrl = async (url: string): Promise<Uint8Array> => {
  const got = await anonymousGet(url)
  if (got.status !== 200) throw new Error(`anonymous GET ${url} answered ${got.status}`)
  return got.bytes
}

const contractOptions: MediaStorageContractOptions = {
  fetchUrl,
  unreachable: async () =>
    createS3MediaStorage(options({ endpoint: `http://127.0.0.1:${await closedPort()}` })),
}

runMediaStorageContract('s3', () => recorded(createS3MediaStorage(options())), contractOptions)

async function headContentType(url: string): Promise<string | null> {
  const res = await fetch(url, { method: 'HEAD' })
  expect(res.status, `HEAD ${url}`).toBe(200)
  return res.headers.get('content-type')
}

describe('AC-3: the S3 storage keeps the content type and the prefix', () => {
  it('AC-3: a HEAD of each object answers the content type it was put with, for the contract’s puts and for one per type', async () => {
    const storage = createS3MediaStorage(options())
    const types = ['image/png', 'image/webp', 'image/gif', 'application/pdf', 'image/svg+xml']
    const puts = new Map<string, string>()
    for (const [i, type] of types.entries()) {
      const { url } = await storage.put(`types/s3-${i}`, Uint8Array.from([i, 1, 2]), type)
      puts.set(url, type)
    }
    expect(puts.size).toBe(types.length)

    for (const [url, type] of [...puts, ...lastContentType]) {
      expect(await headContentType(url), url).toBe(type)
    }
  })

  it('AC-3: with a prefix that has stray slashes, the object is at <prefix>/<key> in the bucket, its URL is s3ObjectUrl’s, and it serves the bytes', async () => {
    const prefix = '//s3/store-a/'
    const storage = createS3MediaStorage(options({ prefix }))
    const key = 'products/tee/front image.png'
    const body = new TextEncoder().encode('prefixed bytes, s3')

    const { url } = await storage.put(key, body, 'image/png')

    expect(await bucket.keys()).toContain(`s3/store-a/${key}`)
    expect(url).toBe(s3ObjectUrl(options({ prefix }), key))
    expect([...(await fetchUrl(url))]).toEqual([...body])
  })
})
