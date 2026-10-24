import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { infrastructureSchema, loadConfig } from './index.js'

// AC-1, the config half: `media: 's3'` parses with and without an `infrastructure.s3` block and keeps every field;
// any other key in the block fails naming it (credentials are never config keys); an `s3` block without media 's3'
// fails. The resolvePrimitives half is packages/platform/tests/integration/s3-media.test.ts.

const S3_FIELDS = ['bucket', 'region', 'endpoint', 'prefix', 'publicUrl', 'forcePathStyle'] as const

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const BASE = { commandStore: 'sqlite', documentStore: 'in-memory', eventBus: 'in-process' }

function configWith(infrastructure: Record<string, unknown>): Record<string, unknown> {
  return {
    store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure,
    security: { adapter: 'middleware' },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001 },
    deployment: { strategy: 'standard' },
  }
}

function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 's3-config-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

/** loadConfig's rejection message, or null when it loaded. */
async function rejectionOf(infrastructure: Record<string, unknown>): Promise<string | null> {
  return loadConfig(project(configWith(infrastructure))).then(
    () => null,
    (error: unknown) => {
      expect(error, String(error)).toBeInstanceOf(ConfigError)
      return (error as ConfigError).message
    },
  )
}

function quoted(message: string, value: string): boolean {
  return [`'${value}'`, `"${value}"`, `\`${value}\``].some((q) => message.includes(q))
}

const word = fc.stringMatching(/^[a-z0-9][a-z0-9-]{1,20}$/)
const url = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    fc.constantFrom('localhost:59000', 'minio.internal', 'cdn.example.com'),
    fc.constantFrom('', '/media', '/a/b'),
  )
  .map(([scheme, host, path]) => `${scheme}://${host}${path}`)

/** Any subset of the block's fields, each with a value of its type. */
const s3Block = fc.record(
  {
    bucket: word,
    region: fc.constantFrom('us-east-1', 'eu-west-2', 'auto'),
    endpoint: url,
    prefix: fc.stringMatching(/^\/{0,2}[a-z0-9]{1,8}(\/[a-z0-9]{1,8}){0,2}\/{0,2}$/),
    publicUrl: url,
    forcePathStyle: fc.boolean(),
  },
  { requiredKeys: [] },
)

/** Key-shaped strings the block does not know: random names, near-misses, and credentials. */
const unknownS3Key = fc
  .oneof(
    fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/),
    fc.constantFrom(
      'buckets',
      'Bucket',
      'publicURL',
      'public_url',
      'pathStyle',
      'accessKeyId',
      'secretAccessKey',
      'credentials',
      'sessionToken',
    ),
  )
  .filter((k) => !(S3_FIELDS as readonly string[]).includes(k) && !(k in {}))

describe("AC-1: media 's3' and the infrastructure.s3 block", () => {
  it("AC-1: media 's3' loads with no s3 block, and with a full one whose every field is kept", async () => {
    const bare = await loadConfig(project(configWith({ ...BASE, media: 's3' })))
    expect(bare.config.infrastructure.media).toBe('s3')

    const block = {
      bucket: 'shop-media',
      region: 'eu-west-2',
      endpoint: 'http://localhost:59000',
      prefix: 'store-a',
      publicUrl: 'https://cdn.example.com/media',
      forcePathStyle: true,
    }
    const full = await loadConfig(project(configWith({ ...BASE, media: 's3', s3: block })))
    const infra = full.config.infrastructure as Record<string, unknown>
    expect(infra['media']).toBe('s3')
    expect(infra['s3']).toEqual(block)
  })

  it("AC-1: infrastructureSchema accepts media 's3' with any subset of the block's fields and keeps exactly those given", () => {
    fc.assert(
      fc.property(s3Block, (block) => {
        const parsed = infrastructureSchema.safeParse({ ...BASE, media: 's3', s3: block })
        expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
        const s3 = (parsed.data as Record<string, unknown> | undefined)?.['s3'] as
          | Record<string, unknown>
          | undefined
        for (const field of Object.keys(block) as Array<keyof typeof block>) {
          expect(s3?.[field], field).toEqual(block[field])
        }
      }),
      { numRuns: 60 },
    )
  })

  it('AC-1: any other key inside infrastructure.s3 fails loadConfig with a ConfigError that quotes the key', async () => {
    // The same block without the stray key loads, so the key alone is what fails.
    expect(await rejectionOf({ ...BASE, media: 's3', s3: { bucket: 'b' } })).toBeNull()
    await fc.assert(
      fc.asyncProperty(unknownS3Key, async (key) => {
        const message = await rejectionOf({ ...BASE, media: 's3', s3: { bucket: 'b', [key]: 'x' } })

        expect(message, `infrastructure.s3.${key} was accepted`).not.toBeNull()
        expect(quoted(message!, key), `the message quotes ${key}: ${message}`).toBe(true)
        expect(message!).toMatch(/\bs3\b/)
      }),
      { numRuns: 15 },
    )
  })

  it('AC-1: credentials are never config keys: accessKeyId and secretAccessKey inside infrastructure.s3 fail, naming each', async () => {
    const message = await rejectionOf({
      ...BASE,
      media: 's3',
      s3: { bucket: 'b', accessKeyId: 'AKIA-TEST', secretAccessKey: 's3-secret' },
    })

    expect(message, 'credentials were accepted as config keys').not.toBeNull()
    expect(quoted(message!, 'accessKeyId'), message!).toBe(true)
    expect(quoted(message!, 'secretAccessKey'), message!).toBe(true)
  })

  it("AC-1: the block that loads with media 's3' fails, naming s3, with media 'local-fs' and with media left to its default", async () => {
    const s3 = { bucket: 'shop-media', endpoint: 'http://localhost:59000' }

    expect(await rejectionOf({ ...BASE, media: 's3', s3 })).toBeNull()
    for (const infrastructure of [
      { ...BASE, media: 'local-fs', s3 },
      { ...BASE, s3 },
    ]) {
      const message = await rejectionOf(infrastructure)
      expect(message, `${JSON.stringify(infrastructure)} loaded`).not.toBeNull()
      expect(message!, message!).toMatch(/\bs3\b/)
    }
  })
})
