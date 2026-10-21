import { afterAll, describe, expect, it } from 'vitest'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { kernelConfig } from '../support/kernel.js'
import {
  cleanupGraphDirs,
  inPackage,
  runGraphChild,
  underModule,
  withInfrastructure,
} from '../support/primitive-graph.js'

// Acceptance test for P2-02 AC-5 (spec P2-02-primitives-are-protocols), the Redis-backed case: with the Redis document
// store and the Redis Streams bus configured, createApp loads each from its package (decision 2) and app.capabilities()
// reports each instance's own capabilities(). The child replaces the document store instance's answer after start, so
// a report that is hard-coded, or read from anywhere but the instance, shows. Needs `pnpm build` and Redis.

const url = redisServerUrl()
const prefix = uniquePrefix('graph')

afterAll(async () => {
  cleanupGraphDirs()
  await deleteUnder(url, prefix)
})

describe('P2-02 AC-5: redis and redis-streams load from their packages', () => {
  it('AC-5: createApp loads @nymbalhq/doc-store-redis and @nymbalhq/event-bus-redis-streams (and ioredis through them), and reports each instance’s own capabilities()', async () => {
    const config = withInfrastructure(kernelConfig('sqlite'), {
      commandStore: 'sqlite',
      documentStore: 'redis',
      eventBus: 'redis-streams',
      redis: { url, prefix },
    })

    const { resolutions, outcome } = await runGraphChild(config)

    expect(outcome.error, JSON.stringify(outcome.error)).toBeUndefined()
    expect(resolutions.filter((r) => inPackage(r.url, 'doc-store-redis')).length).toBeGreaterThan(0)
    expect(
      resolutions.filter((r) => inPackage(r.url, 'event-bus-redis-streams')).length,
    ).toBeGreaterThan(0)
    expect(resolutions.filter((r) => underModule(r.url, 'ioredis')).length).toBeGreaterThan(0)
    expect(resolutions.filter((r) => inPackage(r.url, 'doc-store-postgres-jsonb'))).toEqual([])

    const { report, own, probed } = outcome.started!
    expect(report.documentStore).toEqual({ provider: 'redis', capabilities: own.documentStore })
    expect(report.eventBus).toEqual({ provider: 'redis-streams', capabilities: own.eventBus })
    expect(probed).toEqual(['p2-02-probe'])
  }, 90_000)
})
