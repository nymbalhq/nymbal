import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import { loadConfig, nymbalConfigSchema } from './index.js'

// Acceptance tests for P3-01 AC-8 and AC-9, the config half (spec P3-01-event-log-surface, decision 8): `events`
// sets the retention period (default 30, at least 1) and an optional archive; an archive in the bucket `media: 's3'`
// serves publicly is refused with a ConfigError naming both keys. The sweeper half is
// tests/stores/event-archive.test.ts. Kills: a period that cannot be set or that accepts 0, an archive block dropped
// on load, and archives allowed into the public media bucket.

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function configWith(more: Record<string, unknown>, infrastructure: Record<string, unknown> = {}) {
  return {
    store: { name: 'P3-01', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: 'in-memory',
      eventBus: 'in-process',
      ...infrastructure,
    },
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
    ...more,
  }
}

function project(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'p3-01-config-'))
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  return dir
}

/** loadConfig's rejection message, or null when it loaded. */
function rejectionOf(config: unknown): Promise<string | null> {
  return loadConfig(project(config)).then(
    () => null,
    (error: unknown) => {
      expect(error, String(error)).toBeInstanceOf(ConfigError)
      return (error as ConfigError).message
    },
  )
}

describe('P3-01 AC-8 (decision 8): events.retentionDays', () => {
  it('AC-8: without an events block the retention period is 30 days and no archive is set', () => {
    const parsed = nymbalConfigSchema.parse(configWith({}))
    expect(parsed.events?.retentionDays).toBe(30)
    expect(parsed.events?.archive).toBeUndefined()
  })

  it('AC-8: property: any whole number of days from 1 is kept as given', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3650 }), (days) => {
        const parsed = nymbalConfigSchema.parse(configWith({ events: { retentionDays: days } }))
        expect(parsed.events?.retentionDays).toBe(days)
      }),
      { numRuns: 100 },
    )
  })

  it('AC-8: a period below 1 day fails loadConfig with a ConfigError naming events.retentionDays', async () => {
    for (const days of [0, -1, -30]) {
      const message = await rejectionOf(configWith({ events: { retentionDays: days } }))
      expect(message?.includes('events.retentionDays'), `${days}: ${message}`).toBe(true)
    }
  })

  it('AC-8: an archive block is kept with every field it is given', async () => {
    const archive = {
      adapter: 's3',
      bucket: 'shop-event-archive',
      prefix: 'store-a/',
      region: 'eu-west-2',
      endpoint: 'http://localhost:59000',
      forcePathStyle: true,
    }
    const loaded = await loadConfig(project(configWith({ events: { retentionDays: 7, archive } })))
    expect(loaded.config.events).toEqual({ retentionDays: 7, archive })
  })
})

describe('P3-01 AC-9 (decision 8): archives never share the public media bucket', () => {
  const media = { media: 's3', s3: { bucket: 'shop-media', endpoint: 'http://localhost:59000' } }

  it('AC-9: events.archive.bucket equal to infrastructure.s3.bucket with media s3 fails loadConfig with a ConfigError naming both keys; a bucket of its own loads', async () => {
    const same = await rejectionOf(
      configWith({ events: { archive: { adapter: 's3', bucket: 'shop-media' } } }, media),
    )
    const own = await rejectionOf(
      configWith({ events: { archive: { adapter: 's3', bucket: 'shop-media-archive' } } }, media),
    )

    expect(own, 'a bucket of its own').toBeNull()
    expect(
      ['events.archive.bucket', 'infrastructure.s3.bucket'].map(
        (key) => same?.includes(key) === true,
      ),
      String(same),
    ).toEqual([true, true])
  })
})
