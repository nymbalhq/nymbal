import { afterAll, describe, expect, it } from 'vitest'
import { PROVIDER_PACKAGES } from '../../src/adapters/loader.js'
import { kernelConfig } from '../support/kernel.js'
import {
  cleanupGraphDirs,
  inPackage,
  PRIMITIVE_PACKAGES,
  runGraphChild,
  underModule,
  withInfrastructure,
} from '../support/primitive-graph.js'

// AC-5, the cases that need no Redis: with in-memory and in-process the child-process module graph holds no Redis SDK,
// no primitive package and no `pg` beyond the command store's own import; with @nymbalhq/doc-store-redis hidden,
// createApp fails adapter.package_missing with the install line. The Redis-backed load is
// tests/primitives/primitive-graph.test.ts. Needs `pnpm build`.

afterAll(cleanupGraphDirs)

describe('AC-5: the loader knows the infrastructure packages', () => {
  it('AC-5: PROVIDER_PACKAGES maps documentStore redis and postgres-jsonb, and eventBus redis-streams, to their packages and SDKs', () => {
    const packages = PROVIDER_PACKAGES as Record<
      string,
      Record<string, { package: string; sdk: string }> | undefined
    >
    expect(packages['documentStore']?.['redis']).toEqual({
      package: '@nymbalhq/doc-store-redis',
      sdk: 'ioredis',
    })
    expect(packages['documentStore']?.['postgres-jsonb']).toEqual({
      package: '@nymbalhq/doc-store-postgres-jsonb',
      sdk: 'pg',
    })
    expect(packages['eventBus']?.['redis-streams']).toEqual({
      package: '@nymbalhq/event-bus-redis-streams',
      sdk: 'ioredis',
    })
    // The native primitives are built in: no package entry, so nothing is imported for them.
    expect(Object.keys(packages['documentStore'] ?? {}).sort()).toEqual(['postgres-jsonb', 'redis'])
    expect(Object.keys(packages['eventBus'] ?? {})).toEqual(['redis-streams'])
  })
})

describe('AC-5: with in-memory and in-process, no primitive SDK or package is resolved', () => {
  it('AC-5: createApp starts on SQLite, in-memory and in-process; no URL is under ioredis or a primitive package, and every import of pg is the command store’s', async () => {
    const { resolutions, outcome } = await runGraphChild(kernelConfig('sqlite'))

    expect(outcome.error, JSON.stringify(outcome.error)).toBeUndefined()
    expect(resolutions.length).toBeGreaterThan(0)
    expect(resolutions.filter((r) => underModule(r.url, 'ioredis')).map((r) => r.url)).toEqual([])
    expect(
      resolutions
        .filter((r) => PRIMITIVE_PACKAGES.some((dir) => inPackage(r.url, dir)))
        .map((r) => r.url),
    ).toEqual([])
    const pgImports = resolutions.filter(
      (r) => r.specifier === 'pg' || r.specifier.startsWith('pg/'),
    )
    // The command store's own: the kernel's dist, and the drizzle-orm node-postgres driver it runs on.
    const commandStores = (parent: string | null): boolean =>
      (parent ?? '').includes('/packages/platform/dist/') ||
      (parent ?? '').includes('/node_modules/drizzle-orm/')
    expect(pgImports.length).toBeGreaterThan(0)
    expect(pgImports.filter((r) => !commandStores(r.parent))).toEqual([])
    const report = outcome.started!.report
    expect(report.documentStore).toEqual({
      provider: 'in-memory',
      capabilities: outcome.started!.own.documentStore,
    })
    expect(report.eventBus).toEqual({
      provider: 'in-process',
      capabilities: outcome.started!.own.eventBus,
    })
  }, 90_000)
})

describe('AC-5: a missing primitive package fails with the install line', () => {
  it('AC-5: documentStore redis with @nymbalhq/doc-store-redis not installed fails createApp adapter.package_missing, naming the slot and "npm install @nymbalhq/doc-store-redis ioredis"', async () => {
    const config = withInfrastructure(kernelConfig('sqlite'), {
      commandStore: 'sqlite',
      documentStore: 'redis',
      eventBus: 'in-process',
      // Never connected to: the package is missing before any connection is made.
      redis: { url: 'redis://127.0.0.1:1', prefix: 'primitives-hidden' },
    })

    const { resolutions, outcome } = await runGraphChild(config, {
      hide: ['@nymbalhq/doc-store-redis'],
    })

    expect(outcome.started, JSON.stringify(outcome.started)).toBeUndefined()
    expect(outcome.error?.code, outcome.error?.message).toBe('adapter.package_missing')
    expect(outcome.error?.message).toContain('npm install @nymbalhq/doc-store-redis ioredis')
    expect(outcome.error?.message).toMatch(/\bdocumentStore\b/)
    expect(resolutions.filter((r) => underModule(r.url, 'ioredis')).length).toBe(0)
  }, 90_000)
})
