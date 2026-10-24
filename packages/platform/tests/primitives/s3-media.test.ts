import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  anonymousGet,
  createPublicBucket,
  s3Credentials,
  s3Endpoint,
  type TestBucket,
} from '../../../../tests/support/s3'
import { createLogger } from '../../src/logger.js'
import { resolvePrimitives } from '../../src/platform.js'
import { createKernel, kernelConfig, type Kernel } from '../support/kernel.js'

// AC-2, the MinIO-backed load: with media 's3', a put returns a URL under the bucket's URL that an anonymous GET
// serves, the object is in the bucket under its key, and app.capabilities() reports media as 's3' with ['put'].
// Credentials come from the SDK's default chain (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), never from the config.
// Needs `pnpm build` and MinIO (NYMBAL_TEST_S3_ENDPOINT).

const endpoint = s3Endpoint()
const logger = createLogger({ pretty: false, level: 'error' })
let bucket: TestBucket
const kernels: Kernel[] = []

beforeAll(async () => {
  bucket = await createPublicBucket('resolve')
  const { accessKeyId, secretAccessKey } = s3Credentials()
  vi.stubEnv('AWS_ACCESS_KEY_ID', accessKeyId)
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', secretAccessKey)
})

afterAll(async () => {
  for (const k of kernels.splice(0)) await k.close()
  vi.unstubAllEnvs()
  await bucket?.remove()
})

/** The config with media 's3' on this run's bucket; unparsed, so a case reaches the platform's own handling of it. */
function withS3(config: NymbalConfig): NymbalConfig {
  return {
    ...config,
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
      media: 's3',
      s3: { bucket: bucket.name, endpoint, region: bucket.region },
    },
  } as unknown as NymbalConfig
}

describe("AC-2: media 's3' resolves to the S3 storage on the configured bucket", () => {
  it("AC-2: resolvePrimitives(...).media puts into the bucket: each URL is under the bucket's URL, an anonymous GET serves the bytes, and the object is in the bucket at its key", async () => {
    const config = withS3(kernelConfig('sqlite'))
    // No S3_* variables: the block alone names the bucket and the endpoint.
    const { media, documentStore, eventBus } = await resolvePrimitives(config, { env: {}, logger })
    try {
      const bodies = new Map<string, Uint8Array>([
        ['products/s3-resolve/front.png', Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])],
        ['products/s3-resolve/back side ü.jpg', new TextEncoder().encode('jpeg bytes, s3')],
      ])
      const urls = new Set<string>()
      for (const [key, body] of bodies) {
        const { url } = await media.put(key, body, 'image/png')
        urls.add(url)

        expect(url.startsWith(`${bucket.url}/`), `${url} is not under ${bucket.url}/`).toBe(true)
        const got = await anonymousGet(url)
        expect(got.status, url).toBe(200)
        expect([...got.bytes]).toEqual([...body])
      }
      expect(urls.size).toBe(bodies.size)
      expect((await bucket.keys()).sort()).toEqual([...bodies.keys()].sort())
    } finally {
      await eventBus.close()
      await documentStore.close()
    }
  })

  it("AC-2: app.capabilities().media is { provider: 's3', capabilities: ['put'] }, and is the instance's own answer", async () => {
    const k = await createKernel({
      dialect: 'sqlite',
      configure: withS3,
    })
    kernels.push(k)

    const report = k.app.capabilities().media
    expect(report).toEqual({ provider: 's3', capabilities: ['put'] })
    expect(report.capabilities).toEqual([...k.app.platform.media.capabilities()])
  })
})
