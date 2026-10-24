import { afterAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { createLogger } from '../../src/logger.js'
import { resolvePrimitives } from '../../src/platform.js'
import { kernelConfig } from '../support/kernel.js'
import {
  cleanupGraphDirs,
  inPackage,
  runGraphChild,
  underModule,
} from '../support/primitive-graph.js'

// AC-1 (the resolvePrimitives half) and AC-2 (the missing package). Neither needs an S3 server: a missing bucket fails
// before anything is loaded or connected, and a missing @nymbalhq/media-s3 before any connection, with an install
// line. The MinIO-backed load is tests/primitives/s3-media.test.ts. Needs `pnpm build`.

afterAll(cleanupGraphDirs)

const logger = createLogger({ pretty: false, level: 'error' })

/** Never connected to: every case here fails or resolves before a request is made. */
const NOWHERE = 'http://127.0.0.1:1'

/** The S3 variables a store reads, cleared so the developer's shell cannot leak into a case. */
const NO_S3_ENV = {
  S3_BUCKET: undefined,
  S3_ENDPOINT: undefined,
  S3_PUBLIC_URL: undefined,
  NYMBAL_S3_PREFIX: undefined,
}

/**
 * The kernel config with media 's3'. Not parsed here: the platform must hold its own line on a config it is handed
 * (the child process parses it again, as createApp's callers do), so these cases reach resolvePrimitives itself.
 */
function s3Config(s3?: Record<string, unknown>, more: Record<string, unknown> = {}): NymbalConfig {
  return {
    ...kernelConfig('sqlite'),
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
      media: 's3',
      ...(s3 !== undefined && { s3 }),
      ...more,
    },
  } as unknown as NymbalConfig
}

/** resolvePrimitives' rejection, or null when it resolved (and then closes what it built). */
async function rejectionOf(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
): Promise<{ code?: unknown; message: string } | null> {
  try {
    const primitives = await resolvePrimitives(config, { env, logger })
    await primitives.eventBus.close()
    await primitives.documentStore.close()
    return null
  } catch (error) {
    return { code: (error as { code?: unknown }).code, message: String((error as Error).message) }
  }
}

describe('AC-1: a missing bucket fails resolvePrimitives with config.s3_bucket_missing', () => {
  it("AC-1: media 's3' with no bucket in the block or in S3_BUCKET (unset or empty) rejects config.s3_bucket_missing, naming infrastructure.s3.bucket and S3_BUCKET", async () => {
    const cases: Array<[string, NymbalConfig, NodeJS.ProcessEnv]> = [
      ['no block, no S3_BUCKET', s3Config(), {}],
      ['a block without a bucket, no S3_BUCKET', s3Config({ endpoint: NOWHERE }), {}],
      ['no block, S3_BUCKET empty', s3Config(), { S3_BUCKET: '' }],
    ]
    for (const [label, config, env] of cases) {
      const error = await rejectionOf(config, env)

      expect(error, `${label}: resolved`).not.toBeNull()
      expect(error?.code, `${label}: ${error?.message}`).toBe('config.s3_bucket_missing')
      expect(error?.message, label).toContain('infrastructure.s3.bucket')
      expect(error?.message, label).toContain('S3_BUCKET')
    }
  })

  it('AC-1: a bucket in either place is enough: S3_BUCKET alone, or the block alone, never fails config.s3_bucket_missing', async () => {
    const fromEnv = await rejectionOf(s3Config({ endpoint: NOWHERE }), { S3_BUCKET: 's3-env' })
    const fromBlock = await rejectionOf(s3Config({ bucket: 's3-block', endpoint: NOWHERE }), {})
    const neither = await rejectionOf(s3Config({ endpoint: NOWHERE }), {})

    // The contrast: only the bucket differs between these and the case that fails.
    expect(neither?.code).toBe('config.s3_bucket_missing')
    expect(fromEnv?.code, fromEnv?.message).not.toBe(neither?.code)
    expect(fromBlock?.code, fromBlock?.message).not.toBe(neither?.code)
  })

  it('AC-1: the missing bucket fails createApp before any package is imported: no @nymbalhq/media-s3, no @aws-sdk, and not the Redis store configured beside it', async () => {
    // A Redis document store beside it, on a port nothing listens on: had the check come after the other
    // primitives, the failure would be a Redis one, or the Redis package would have been imported first.
    const config = s3Config(undefined, {
      documentStore: 'redis',
      redis: { url: 'redis://127.0.0.1:1', prefix: 's3-early' },
    })

    const { resolutions, outcome } = await runGraphChild(config, { env: NO_S3_ENV })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('config.s3_bucket_missing')
    expect(resolutions.length).toBeGreaterThan(0)
    const loaded = resolutions
      .filter(
        (r) =>
          inPackage(r.url, 'media-s3') ||
          underModule(r.url, '@aws-sdk') ||
          r.specifier.startsWith('@aws-sdk/') ||
          r.specifier === '@nymbalhq/media-s3' ||
          inPackage(r.url, 'doc-store-redis') ||
          underModule(r.url, 'ioredis'),
      )
      .map((r) => r.url)
    expect(loaded).toEqual([])
  }, 90_000)
})

describe('AC-2: a missing @nymbalhq/media-s3 fails with the install line', () => {
  it('AC-2: media \'s3\' with @nymbalhq/media-s3 not installed fails createApp adapter.package_missing, naming the media slot and "npm install @nymbalhq/media-s3 @aws-sdk/client-s3"', async () => {
    const config = s3Config({ bucket: 's3-hidden', endpoint: NOWHERE })

    const { resolutions, outcome } = await runGraphChild(config, {
      hide: ['@nymbalhq/media-s3'],
      env: NO_S3_ENV,
    })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/media-s3 @aws-sdk/client-s3')
    expect(outcome.error?.message).toMatch(/\bmedia\b/)
    expect(resolutions.filter((r) => underModule(r.url, '@aws-sdk')).length).toBe(0)
  }, 90_000)
})
