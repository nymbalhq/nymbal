import { afterAll } from 'vitest'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { createKernel } from '../support/kernel.js'
import { withInfrastructure } from '../support/primitive-graph.js'
import { adminTabsSuite } from '../support/suites/admin-tabs.js'

// AC-3 at the admin SSE route on Redis Streams: a SQLite command store, the Redis document store and the Redis
// Streams bus on the composed Redis, under a prefix of this run. On the in-process bus every subscription is handed
// every event whatever its name, so only a shared bus can fail.

const url = redisServerUrl()
const prefix = uniquePrefix('admin-tabs')

afterAll(async () => {
  await deleteUnder(url, prefix)
})

adminTabsSuite('redis-streams', () =>
  createKernel({
    dialect: 'sqlite',
    configure: (config) =>
      withInfrastructure(config, {
        commandStore: 'sqlite',
        documentStore: { provider: 'redis' },
        eventBus: { provider: 'redis-streams' },
        redis: { url, prefix, ackTimeoutMs: 4000, claimIdleMs: 400 },
      }),
  }),
)
