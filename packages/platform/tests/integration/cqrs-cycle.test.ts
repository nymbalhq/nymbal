import { describe, it, expect } from 'vitest'
import { EVT_PRODUCT_CREATED, EVT_PRODUCT_PUBLISHED } from '@nymbal/types'
import { createTestEnv } from './setup.js'

describe('CQRS cycle: write → event → projection → query', () => {
  it('product create emits event and projection reflects new product', async () => {
    const env = await createTestEnv()
    const emitted: unknown[] = []
    await env.eventBus.subscribe(EVT_PRODUCT_CREATED, (e) => { emitted.push(e.payload) })

    const snap = await env.product.create({
      slug: 'cqrs-widget',
      name: 'CQRS Widget',
      description: 'Desc',
      status: 'active',
      variants: [{ sku: 'CQ-1', name: 'Default', priceMinor: 1000, stock: 10, options: [] }],
    })

    // event was emitted
    expect(emitted).toHaveLength(1)

    // query reads the projection
    const fetched = await env.product.getById(snap.id)
    expect(fetched.name).toBe('CQRS Widget')
    expect(fetched.variants).toHaveLength(1)
    await env.commandStore.close()
  })

  it('product publish transitions status and emits published event', async () => {
    const env = await createTestEnv()
    const published: unknown[] = []
    await env.eventBus.subscribe(EVT_PRODUCT_PUBLISHED, (e) => { published.push(e.payload) })

    const snap = await env.product.create({ slug: 'draft-product', name: 'Draft', status: 'draft' })
    await env.product.publish(snap.id)

    const fresh = await env.product.getById(snap.id)
    expect(fresh.status).toBe('active')
    expect(published).toHaveLength(1)
    await env.commandStore.close()
  })
})
