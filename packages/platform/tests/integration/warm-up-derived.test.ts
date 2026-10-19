import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_PRODUCT_CREATED, EVT_PRODUCT_UPDATED, type NymbalEvent } from '@nymbalhq/types'
import { warmDocumentStore } from '../../src/warm-document-store.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'

// P1-03 AC-10 on SQLite, no Mailpit: warm-up hands its synthetic events only to subscriptions registered as derived
// (SubscriptionConfig.derived), through EventBusAdapter.replay, never through publish/publishBatch. A probe that is
// not derived (as the email handler is not) hears nothing from warm-up but still hears real commands; a derived probe
// and the search index (a derived subscriber) are rebuilt. Sentinel S009 runs this file.

let k: Kernel
let seeded: Seeded
let productName: string

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  seeded = await seedVariant(k, 4)
  productName = (await k.services.product.getById(seeded.productId)).name
}, 60_000)

afterAll(async () => {
  await k?.close()
})

async function searchIds(query: string): Promise<string[]> {
  return (await k.app.adapters.search.search(query)).items.map((item) => item.id)
}

describe('AC-10: warm-up feeds derived state only', () => {
  it('AC-10: warmDocumentStore called directly reaches the derived probe and rebuilds the search index, but not the non-derived probe; a later real command still reaches the non-derived probe', async () => {
    const sideEffect: NymbalEvent<unknown>[] = []
    const derived: NymbalEvent<unknown>[] = []
    await k.eventBus.subscribe('*', (event) => {
      sideEffect.push(event)
    })
    await k.eventBus.subscribe(
      '*',
      (event) => {
        derived.push(event)
      },
      { name: 'ac10-derived-probe', derived: true },
    )
    await k.app.adapters.search.remove([seeded.productId])
    expect(await searchIds(productName), 'the index was cleared').not.toContain(seeded.productId)

    await warmDocumentStore({
      config: k.config,
      repos: k.app.repos,
      eventBus: k.eventBus,
      logger: k.logger,
      version: '0.0.0',
    })

    expect(
      sideEffect.map((e) => e.type),
      'warm-up reached a subscriber that is not derived',
    ).toEqual([])
    const warmedProducts = derived
      .filter((e) => e.type === EVT_PRODUCT_CREATED)
      .map((e) => (e.payload as { product: { id: string } }).product.id)
    // One synthetic product.created.v1 per product row, the seeded one among them.
    expect(warmedProducts).toContain(seeded.productId)
    expect(warmedProducts.slice().sort()).toEqual(
      (await k.store.read((tx) => k.repos.product.list(tx))).map((p) => p.id).sort(),
    )
    expect(await searchIds(productName)).toContain(seeded.productId)

    await k.services.product.update(seeded.productId, { name: `${productName} ${randomUUID()}` })

    expect(
      sideEffect
        .filter((e) => e.type === EVT_PRODUCT_UPDATED)
        .map((e) => (e.payload as { product: { id: string } }).product.id),
    ).toEqual([seeded.productId])
  })
})
