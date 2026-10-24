import { afterAll } from 'vitest'
import { deleteUnder, redisServerUrl, uniquePrefix } from '../../../../tests/support/redis'
import { createKernel } from '../support/kernel.js'
import { withInfrastructure } from '../support/primitive-graph.js'
import { deliveryMarkerSuite } from '../support/suites/delivery-marker.js'

// AC-3 on Redis Streams, through createApp: a SQLite command store, the Redis document store and the Redis Streams bus
// on the composed Redis, under a prefix of this run. ackTimeoutMs is 4000, so a handler whose drain waited on its own
// delivery would hold the outer create for about 4 s; the bound is half of it.

const url = redisServerUrl()
const prefix = uniquePrefix('kernel-drain')
const ACK_TIMEOUT_MS = 4000

afterAll(async () => {
  await deleteUnder(url, prefix)
})

deliveryMarkerSuite(
  'redis-streams',
  () =>
    createKernel({
      dialect: 'sqlite',
      configure: (config) =>
        withInfrastructure(config, {
          commandStore: 'sqlite',
          documentStore: 'redis',
          eventBus: 'redis-streams',
          redis: { url, prefix, ackTimeoutMs: ACK_TIMEOUT_MS, claimIdleMs: 400 },
        }),
    }),
  ACK_TIMEOUT_MS / 2,
)
