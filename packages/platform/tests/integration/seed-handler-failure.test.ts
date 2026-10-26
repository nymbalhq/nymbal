import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { EVT_CUSTOMER_CREATED, type EmailAdapter, type NymbalEvent } from '@nymbalhq/types'
import { createLogger } from '../../src/logger.js'
import { seedProducts } from '../../src/seed/data.js'
import { runSeed, type SeedResult } from '../../src/seed/run.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'

// AC-9 on SQLite: the demo seed on a store whose email refuses every send. The seed publishes its events to the bus
// with the store's handlers subscribed, so its welcome emails fail; it still finishes, says once which events and
// subscriptions failed, and its catalogue is served.

const refusing: EmailAdapter = {
  kind: 'email',
  providerName: 'seed-refusing',
  capabilities: () => ['transactional'],
  producesEvents: [],
  consumesEvents: [],
  initialize: async () => undefined,
  healthCheck: async () => ({ status: 'healthy' }),
  sendTransactional: async (message) => {
    throw new Error(`the mail host refuses ${message.to}`)
  },
  syncCustomerToList: async () => undefined,
  removeCustomerFromList: async () => undefined,
}

const lines: string[] = []
let k: Kernel
let served: ServedKernel
const welcomed: string[] = []
let outcome: { state: 'resolved'; result: SeedResult } | { state: 'rejected'; error: unknown }

beforeAll(async () => {
  k = await createKernel({
    dialect: 'sqlite',
    configure: (config) =>
      ({
        ...config,
        commerce: { ...config.commerce, email: { provider: 'custom' } },
      }) as NymbalConfig,
    appOptions: { adapters: { email: refusing } },
    logger: createLogger({
      pretty: false,
      level: 'warn',
      destination: { write: (line: string) => void lines.push(line) },
    }),
  })
  await k.eventBus.subscribe(EVT_CUSTOMER_CREATED, async (e: NymbalEvent<unknown>) => {
    welcomed.push(e.id)
  })
  served = await serveKernel(k)
  try {
    const result = await runSeed({
      config: k.config,
      commandStore: k.store,
      documentStore: k.documentStore,
      eventBus: k.eventBus,
      logger: k.logger,
      version: '0.0.0',
    })
    outcome = { state: 'resolved', result }
  } catch (error) {
    outcome = { state: 'rejected', error }
  }
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

describe('AC-9: the seed survives a failing handler', () => {
  it('AC-9: runSeed on a store whose email refuses every send resolves, logs one warn naming every failed customer.created.v1 and its subscription, and GET /api/products serves the seeded products', async () => {
    expect(outcome.state, outcome.state === 'rejected' ? String(outcome.error) : '').toBe(
      'resolved',
    )
    const result = (outcome as { result: SeedResult }).result
    expect(result.alreadySeeded).toBe(false)

    expect(welcomed.length, 'the seed’s customer.created.v1 events').toBe(
      result.customers + result.admins,
    )
    const warns = lines
      .map((line) => JSON.parse(line) as { level: number })
      .filter((entry) => entry.level === 40)
      .map((entry) => JSON.stringify(entry))
      .filter((text) => welcomed.every((id) => text.includes(id)))
    expect(warns.length, 'warn lines naming every failed event').toBe(1)
    expect(warns[0]).toContain('email-customer-created')

    const res = await fetch(new URL('/api/products?limit=100', served.baseUrl))
    const body = (await res.json()) as { data?: { items: Array<{ slug: string }> } }
    expect(res.status).toBe(200)
    const sorted = (slugs: string[]) => [...slugs].sort()
    expect(sorted((body.data?.items ?? []).map((p) => p.slug))).toEqual(
      sorted(seedProducts.map((p) => p.slug)),
    )
    expect(body.data?.items.length).toBe(result.products)
  })
})
