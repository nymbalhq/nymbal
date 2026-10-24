import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_PRODUCT_UPDATED, type NymbalEvent } from '@nymbalhq/types'
import { rebuild } from '../../src/read-models/index.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { openRaw } from '../support/raw.js'
import { ALL_MODELS, rebuildDeps } from '../support/read-models.js'

// AC-10 on SQLite: warm-up writes only derived read models. Boot warm rebuilds every read model with no synthetic
// events. Called directly, on a kernel whose last commands are seconds old (so its catch-up has events to apply), it
// restores a product's document and its search entry after both were removed, while a subscriber that is not derived
// (as the email handler is not) hears nothing from it, and the event log, the processed-event records and the
// product's rows are unchanged; a later real command still reaches that subscriber. Sentinel S009 runs this file.

let k: Kernel
let seeded: Seeded
let productName: string
let productSlug: string

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  seeded = await seedVariant(k, 4)
  const product = await k.services.product.getById(seeded.productId)
  productName = product.name
  productSlug = product.slug
  await k.services.product.update(seeded.productId, { description: 'recent, so catch-up sees it' })
  await k.app.relay.drain()
}, 60_000)

afterAll(async () => {
  await k?.close()
})

async function searchIds(query: string): Promise<string[]> {
  return (await k.app.adapters.search.search(query)).items.map((item) => item.id)
}

/** What a write by warm-up to the command store would change: the event log as stored, processed events, the product. */
async function commandStoreState() {
  const raw = openRaw('sqlite', k.target)
  try {
    return {
      events: await raw.rows(
        'SELECT seq, id, delivered_at, attempts, dead_at FROM events ORDER BY seq',
      ),
      processed: await raw.count('processed_events'),
      product: await raw.rows('SELECT * FROM products WHERE id = ?', [seeded.productId]),
      variants: await raw.rows('SELECT * FROM variants WHERE product_id = ?', [seeded.productId]),
    }
  } finally {
    await raw.close()
  }
}

describe('AC-10: warm-up writes only derived read models', () => {
  it('AC-10: the boot rebuild, called directly, restores a removed product document and search entry, while the non-derived probe hears nothing and the event log, processed events and the product rows are unchanged; a later real command still reaches the non-derived probe', async () => {
    const sideEffect: NymbalEvent<unknown>[] = []
    await k.eventBus.subscribe('*', (event) => {
      sideEffect.push(event)
    })
    const doc = await k.documentStore.get<{ id: string }>('products', productSlug)
    expect(doc?.id, 'the product is projected before the wipe').toBe(seeded.productId)
    await k.documentStore.delete('products', productSlug)
    await k.app.adapters.search.remove([seeded.productId])
    expect(await searchIds(productName), 'the index was cleared').not.toContain(seeded.productId)
    const stateBefore = await commandStoreState()

    await rebuild(ALL_MODELS, rebuildDeps(k))

    expect(
      sideEffect.map((e) => e.type),
      'warm-up reached a subscriber that is not derived',
    ).toEqual([])
    expect(stateBefore, 'warm-up wrote to the command store').toEqual(await commandStoreState())
    expect(doc, 'the product document, rebuilt').toEqual(
      await k.documentStore.get('products', productSlug),
    )
    expect(await searchIds(productName)).toContain(seeded.productId)

    await k.services.product.update(seeded.productId, { name: `${productName} ${randomUUID()}` })

    expect(
      sideEffect
        .filter((e) => e.type === EVT_PRODUCT_UPDATED)
        .map((e) => e.payload as { product?: { id: string }; productId?: string })
        .map((p) => p.product?.id ?? p.productId),
    ).toEqual([seeded.productId])
  })
})
