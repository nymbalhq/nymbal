import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { OrderStatus } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'

// AC-4: boot warm is complete. A second kernel on the same file, with the native index emptied and a fresh in-memory
// document store, answers the catalogue, product pages, category listings, orders and search exactly as the first did.

const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]
const WORDS = ['aurora', 'basalt', 'cinder'] as const

const dir = mkdtempSync(join(tmpdir(), 'replay-boot-warm-'))
const sqlitePath = join(dir, 'store.sqlite')
const tag = randomUUID().slice(0, 8)

let served: ServedKernel | undefined
let token = ''
const products: Array<{ id: string; slug: string }> = []
const categorySlugs: string[] = []
const orderNumbers: string[] = []
let productRows = 0

/** Every read AC-4 names, keyed by path: the response body's `data`, or the status when it is not 200. */
async function reads(baseUrl: string): Promise<Map<string, unknown>> {
  const paths = [
    '/api/products?limit=100',
    ...products.map((p) => `/api/products/${p.slug}`),
    ...categorySlugs.map((slug) => `/api/products?category=${slug}&limit=100`),
    ...WORDS.map((w) => `/api/products/search?q=${w}`),
  ]
  const out = new Map<string, unknown>()
  for (const path of paths) out.set(path, await read(baseUrl, path))
  for (const n of orderNumbers) {
    out.set(`/api/orders/${n}`, await read(baseUrl, `/api/orders/${n}`, token))
  }
  return out
}

async function read(baseUrl: string, path: string, bearer?: string): Promise<unknown> {
  const res = await fetch(new URL(path, baseUrl), {
    headers: {
      accept: 'application/json',
      ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }),
    },
  })
  const body = (await res.json()) as { data?: unknown }
  return res.status === 200 ? body.data : { status: res.status, body }
}

async function buildStore(k: Kernel): Promise<void> {
  const s = k.services
  const c1 = await s.category.create({ slug: `warm-a-${tag}`, name: `warm a ${tag}` })
  const c2 = await s.category.create({ slug: `warm-b-${tag}`, name: `warm b ${tag}` })
  categorySlugs.push(c1.slug, c2.slug)
  const make = async (word: string, categoryIds: string[], stock: number) => {
    const p = await s.product.create({
      slug: `warm-${word}-${tag}`,
      name: `${word} ${tag}`,
      description: `a ${word} piece`,
      status: 'active',
      categoryIds,
      variants: [
        {
          sku: `WARM-${word}-${tag}`,
          name: 'Default',
          priceMinor: 2500,
          stock,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    products.push({ id: p.id, slug: p.slug })
    return p
  }
  const moved = await make(WORDS[0], [c1.id], 5)
  const stocked = await make(WORDS[1], [c1.id, c2.id], 100)
  const emptied = await make(WORDS[2], [c2.id], 3)

  await s.product.update(moved.id, { categoryIds: [c2.id], name: `${WORDS[0]} moved ${tag}` })
  await s.product.update(stocked.id, { description: `a ${WORDS[1]} piece, revised` })
  await s.category.update(c1.id, { name: `warm a renamed ${tag}` })
  await s.inventory.adjustStock(emptied.variants[0]!.id, -3, 'manual', 'replay')

  const { customer, tokens } = await s.auth.register({
    email: `owner-${tag}@replay.test`,
    password: 'correct-horse-battery',
  })
  token = tokens.accessToken
  const checkout = async (pending: boolean) => {
    const cart = await s.cart.getOrCreate(undefined, customer.id)
    await s.cart.addItem(cart.token, {
      variantId: stocked.variants[0]!.id,
      productId: stocked.id,
      productName: stocked.name,
      variantName: 'Default',
      priceMinor: 2500,
      imageUrl: '',
      qty: 1,
    })
    const started = await s.checkout.beginCheckout({
      cartToken: cart.token,
      customerId: customer.id,
      email: `owner-${tag}${pending ? '+stub-pending' : ''}@replay.test`,
      billingAddress: address,
      shippingAddress: address,
    })
    orderNumbers.push(started.orderNumber)
    return started
  }
  for (const status of STATUSES) {
    const order = await checkout(status === 'pending' || status === 'cancelled')
    if (status === 'cancelled') await s.order.cancel(order.orderId, 'changed mind', 'replay')
    if (['processing', 'shipped', 'delivered'].includes(status)) {
      await s.order.updateStatus(order.orderId, 'processing', 'replay')
    }
    if (['shipped', 'delivered'].includes(status)) {
      await s.order.markShipped(order.orderId, `TRK-${tag}`, 'royal-mail', 'replay')
    }
    if (status === 'delivered') await s.order.markDelivered(order.orderId, 'replay')
    if (status === 'refunded' || status === 'partially_refunded') {
      const amountMinor =
        status === 'refunded' ? order.totalMinor : Math.floor(order.totalMinor / 2)
      await s.refund.refund({ orderId: order.orderId, amountMinor, actor: 'replay' })
    }
    expect((await s.order.getById(order.orderId)).status, `the ${status} order`).toBe(status)
  }
  await k.app.relay.drain()
  productRows = (await k.store.read((tx) => k.repos.product.list(tx))).length
}

/** Empties migration 0007's index on the file: the base table, then the external-content FTS index. */
function emptyNativeIndex(path: string): void {
  const raw = new Database(path)
  try {
    raw.prepare('DELETE FROM search_documents').run()
    raw
      .prepare(`INSERT INTO search_documents_fts(search_documents_fts) VALUES ('delete-all')`)
      .run()
  } finally {
    raw.close()
  }
}

let before: Map<string, unknown>
let after: Map<string, unknown>

beforeAll(async () => {
  const first = await serveKernel(await createKernel({ dialect: 'sqlite', sqlitePath }))
  try {
    await buildStore(first.kernel)
    before = await reads(first.baseUrl)
  } finally {
    await first.stop()
  }
  emptyNativeIndex(sqlitePath)
  served = await serveKernel(await createKernel({ dialect: 'sqlite', sqlitePath }))
  after = await reads(served.baseUrl)
}, 120_000)

afterAll(async () => {
  await served?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('AC-4: a fresh process serves what the long-running one served', () => {
  it('AC-4: after a restart on a wiped document store and index, /api/products, each /api/products/:slug, each /api/products?category=, each /api/orders/:n as its owner and /api/products/search?q= answer exactly what they answered before', () => {
    const listed = (v: unknown) => (v as { items?: unknown[] }).items?.length
    expect(listed(before.get('/api/products?limit=100')), 'the catalogue before').toBe(productRows)
    const statuses = orderNumbers.map(
      (n) => (before.get(`/api/orders/${n}`) as { status?: string }).status,
    )
    expect(statuses, 'the orders before, as their owner reads them').toEqual(STATUSES)

    expect([...after.keys()]).toEqual([...before.keys()])
    for (const [path, answer] of before) {
      expect(after.get(path), path).toEqual(answer)
    }
  })
})
