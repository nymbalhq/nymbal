import { describe, expect, it } from 'vitest'
import { EVT_PRODUCT_CREATED, EVT_PRODUCT_PUBLISHED } from '@nymbal/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher } from '../events/publisher.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'

async function setup() {
  const config = {
    infrastructure: { commandStore: 'sqlite' as const },
    store: { name: 'test', currency: 'GBP' },
  }
  const commandStore = createCommandStore(
    // @ts-expect-error — minimal config for test
    config,
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const publisher = createEventPublisher({
    eventBus,
    builderContext: {
      storeId: 'test',
      environment: 'development',
      version: '0.0.0-test',
      source: 'test',
    },
  })
  const service = createProductService({ store: commandStore, repos, publisher, logger })
  return { service, repos, eventBus, commandStore, documentStore, publisher, logger }
}

describe('ProductService', () => {
  it('create emits product.created.v1 with snapshot', async () => {
    const { service, eventBus, commandStore } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_PRODUCT_CREATED, (event) => {
      received.push(event.payload)
    })
    const snap = await service.create({
      slug: 'test-product',
      name: 'Test Product',
      description: 'desc',
      status: 'active',
      variants: [
        {
          sku: 'TEST-1',
          name: 'Default',
          priceMinor: 1500,
          stock: 10,
          options: [],
        },
      ],
    })
    expect(snap.slug).toBe('test-product')
    expect(snap.variants).toHaveLength(1)
    expect(snap.variants[0]!.priceMinor).toBe(1500)
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('publish transitions status and emits product.published.v1', async () => {
    const { service, eventBus, commandStore } = await setup()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_PRODUCT_PUBLISHED, (event) => {
      received.push(event.payload)
    })
    const created = await service.create({
      slug: 'draft',
      name: 'Draft Product',
      description: '',
      status: 'draft',
    })
    await service.publish(created.id)
    const fresh = await service.getById(created.id)
    expect(fresh.status).toBe('active')
    expect(received).toHaveLength(1)
    await commandStore.close()
  })

  it('rejects duplicate slugs', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'dup', name: 'A' })
    await expect(service.create({ slug: 'dup', name: 'B' })).rejects.toThrow(/already exists/)
    await commandStore.close()
  })
})
