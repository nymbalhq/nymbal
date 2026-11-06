import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Product, ProposalView, Variant } from '@nymbalhq/types'
import {
  assistantStore,
  proposalsOf,
  storeState,
  type AssistantStore,
} from '../support/assistant.js'
import { checkoutOf, seedVariant } from '../support/kernel.js'
import { toolSurface } from '../support/mcp.js'

// AC-11: `GET /api/admin/proposals/:id` answers a pending product update, stock adjustment, refund or cancel with a
// preview read from the store at that GET: what the write acts on, by name, and each value it changes now beside the
// value it would set. The current values are held to what the admin's own reads answer at the same moment
// (`GET /api/admin/products/:id`, `/api/admin/inventory`, `/api/admin/orders/:id`), never to the arguments; the
// proposed ones to the arguments (stock and refunded moved by them). A decided proposal, another command and the list
// carry no preview, and reading one changes nothing. Proposals are made through the store's tool surface as an admin,
// so each waits.

interface Change {
  label: string
  kind: 'value' | 'money' | 'collection'
  current: string | number | null
  proposed: string | number | null
  changed?: boolean
}
interface Preview {
  target: { kind: 'product' | 'variant' | 'order'; id: string; label: string } | null
  changes: Change[]
  currency: string
}
type Viewed = ProposalView & { preview?: Preview }
type AdminProduct = Product & { variants: Variant[]; categoryIds: string[] }

const SCALARS = [
  'name',
  'description',
  'shortDescription',
  'status',
  'type',
  'seoTitle',
  'seoDescription',
] as const
const COLLECTIONS = ['media', 'metadata', 'categoryIds'] as const
/** The labels the spec names; the others are the implementation's to word. */
const LABELS: Record<string, string> = { name: 'Name', status: 'Status', media: 'Media' }

let store: AssistantStore
let productId = ''
let foreignVariantId = ''
let paidOrderId = ''
let unpaidOrderId = ''
/** The admin reads an order by its number (`GET /api/admin/orders/:orderNumber`). */
let paidOrderNumber = ''
let unpaidOrderNumber = ''

beforeAll(async () => {
  store = await assistantStore()
  const tag = randomUUID()
  const created = await store.kernel.services.product.create({
    slug: `preview-${tag}`,
    name: `Preview Teapot ${tag.slice(0, 8)}`,
    description: 'A teapot for four.',
    shortDescription: 'Teapot',
    status: 'active',
    seoTitle: 'Teapot',
    seoDescription: 'A teapot.',
    media: [
      { url: 'https://cdn.example.test/teapot-1.jpg', altText: 'Front', position: 0 },
      { url: 'https://cdn.example.test/teapot-2.jpg', altText: 'Side', position: 1 },
    ],
    metadata: { glaze: 'celadon', capacityMl: 900 },
    variants: ['Small', 'Medium', 'Large'].map((name, i) => ({
      sku: `PREVIEW-${name.toUpperCase()}-${tag}`,
      name,
      priceMinor: 1500 + i * 600,
      ...(i === 1 && { compareAtPriceMinor: 2600 }),
      stock: 12 + i,
      lowStockThreshold: 0,
      options: [{ name: 'Size', value: name }],
    })),
  } as Parameters<AssistantStore['kernel']['services']['product']['create']>[0])
  productId = created.id
  foreignVariantId = (await seedVariant(store.kernel, 5)).variantId
  const paid = await seedVariant(store.kernel, 10, { priceMinor: 2500 })
  const placed = await checkoutOf(store.kernel, paid, 2, `preview-${tag}@preview.test`)
  paidOrderId = placed.orderId
  paidOrderNumber = placed.orderNumber
  const unpaid = await seedVariant(store.kernel, 10, { priceMinor: 900 })
  const waiting = await checkoutOf(store.kernel, unpaid, 1)
  unpaidOrderId = waiting.orderId
  unpaidOrderNumber = waiting.orderNumber
  await store.kernel.app.relay.drain()
}, 60_000)

afterAll(async () => {
  await store?.close()
})

async function data<T>(path: string): Promise<T> {
  const res = await store.admin.send<T>('GET', path)
  if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(res.body)}`)
  return res.body.data!
}

/** A pending proposal of `tool` made as the admin through the tool surface; its id. */
async function propose(tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await toolSurface(store.kernel.app).call(tool, args, store.caller)
  const id = result.structuredContent?.['id']
  if (result.structuredContent?.['status'] !== 'proposed' || typeof id !== 'string') {
    throw new Error(`${tool}: ${result.content[0]?.text ?? ''}`)
  }
  return id
}

const viewOf = (id: string) => data<Viewed>(`/api/admin/proposals/${id}`)

/** The list's item for `id`, read now. */
async function listed(id: string): Promise<ProposalView | undefined> {
  return (await proposalsOf(store.admin)).find((p) => p.id === id)
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const countOf = (value: unknown) =>
  Array.isArray(value)
    ? value.length
    : typeof value === 'object' && value !== null
      ? Object.keys(value).length
      : 0

/** The changes a product update's preview must hold, from the product as the admin reads it now. */
function expectedProductChanges(now: AdminProduct, args: Record<string, unknown>) {
  const changes: unknown[] = []
  for (const key of SCALARS) {
    if (!(key in args)) continue
    changes.push(
      expect.objectContaining({
        label: LABELS[key] ?? expect.any(String),
        kind: 'value',
        current: (now as unknown as Record<string, unknown>)[key] ?? null,
        proposed: args[key],
      }),
    )
  }
  for (const key of COLLECTIONS) {
    if (!(key in args)) continue
    const current = (now as unknown as Record<string, unknown>)[key]
    changes.push(
      expect.objectContaining({
        label: LABELS[key] ?? expect.any(String),
        kind: 'collection',
        current: countOf(current),
        proposed: countOf(args[key]),
        changed: !sameJson(current, args[key]),
      }),
    )
  }
  const entries = (args['variants'] ?? []) as Array<{
    id: string
    priceMinor: number
    compareAtPriceMinor?: number | null
  }>
  for (const entry of entries) {
    const variant = now.variants.find((v) => v.id === entry.id)
    if (variant === undefined) {
      changes.push(expect.objectContaining({ label: `Variant ${entry.id}`, current: null }))
      continue
    }
    changes.push(
      expect.objectContaining({
        label: `Price of ${variant.name}`,
        kind: 'money',
        current: variant.priceMinor,
        proposed: entry.priceMinor,
      }),
    )
    if ('compareAtPriceMinor' in entry) {
      changes.push(
        expect.objectContaining({
          label: `Compare-at price of ${variant.name}`,
          kind: 'money',
          current: variant.compareAtPriceMinor ?? null,
          proposed: entry.compareAtPriceMinor ?? null,
        }),
      )
    }
  }
  return changes
}

describe('AC-11: a pending proposal is read with what it would change, from the store as it is', () => {
  it('AC-11: property: for any product update (any subset of the body, any variant prices and compare-at prices, a variant of another product among them), after another price may have been saved, the preview names the product and holds one change per field set, current as GET /api/admin/products/:id answers at that moment and proposed from the arguments, collections as counts with changed; the rest of the body equals the list’s item and the GET changes nothing', async () => {
    const start = await data<AdminProduct>(`/api/admin/products/${productId}`)
    const text = fc.string({ maxLength: 160 })
    const media = fc.array(
      fc.record({
        url: fc.uuid().map((u) => `https://cdn.example.test/${u}.jpg`),
        altText: fc.string({ maxLength: 20 }),
        position: fc.nat(5),
      }),
      { maxLength: 3 },
    )
    const variantEntry = (id: string) =>
      fc.record(
        {
          id: fc.constant(id),
          priceMinor: fc.nat(100_000),
          compareAtPriceMinor: fc.option(fc.nat(100_000), { nil: null }),
        },
        { requiredKeys: ['id', 'priceMinor'] },
      )
    const body = fc.record(
      {
        name: fc.string({ minLength: 1, maxLength: 40 }),
        description: text,
        shortDescription: text,
        status: fc.constantFrom('draft', 'active', 'archived'),
        type: fc.constantFrom('simple', 'variable'),
        seoTitle: text,
        seoDescription: text,
        media: fc.oneof(fc.constant(start.media), media),
        metadata: fc.oneof(
          fc.constant(start.metadata),
          fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.oneof(fc.string(), fc.nat())),
        ),
        categoryIds: fc.oneof(
          fc.constant(start.categoryIds),
          fc.array(fc.uuid(), { minLength: 1, maxLength: 2 }),
        ),
        variants: fc
          .tuple(fc.subarray(start.variants.map((v) => v.id)), fc.boolean())
          .chain(([ids, foreign]) =>
            fc.tuple(...[...ids, ...(foreign ? [foreignVariantId] : [])].map(variantEntry)),
          ),
      },
      { requiredKeys: [] },
    )

    await fc.assert(
      fc.asyncProperty(
        body.filter((b) => Object.keys(b).length > 0),
        fc.option(fc.nat(100_000), { nil: undefined }),
        async (args, savedPrice) => {
          const id = await propose('admin_products_update', { id: productId, ...args })
          if (savedPrice !== undefined) {
            const saved = await store.admin.send('PATCH', `/api/admin/products/${productId}`, {
              variants: [{ id: start.variants[0]!.id, priceMinor: savedPrice }],
            })
            if (saved.status !== 200) throw new Error(`PATCH: ${JSON.stringify(saved.body)}`)
          }
          const now = await data<AdminProduct>(`/api/admin/products/${productId}`)
          const stateBefore = await storeState(store.raw)

          const { preview, ...rest } = await viewOf(id)

          expect(preview?.target).toEqual({ kind: 'product', id: productId, label: now.name })
          expect(preview?.currency).toBe(store.kernel.config.store.currency)
          expect(preview?.changes).toEqual(expectedProductChanges(now, args))
          expect(rest).toEqual(await listed(id))
          expect(await storeState(store.raw)).toEqual(stateBefore)
        },
      ),
      { numRuns: 30 },
    )
  }, 240_000)

  it('AC-11: property: for any stock adjustment, after the stock may have moved, the preview names the variant as "<product>, <variant> (<sku>)" and holds one Stock change, current what GET /api/admin/inventory answers at that moment and proposed current plus delta', async () => {
    const product = await data<AdminProduct>(`/api/admin/products/${productId}`)
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...product.variants),
        fc.integer({ min: -50, max: 50 }),
        fc.option(fc.integer({ min: 1, max: 20 }), { nil: undefined }),
        async (variant, delta, moved) => {
          const id = await propose('admin_inventory_adjust', {
            variantId: variant.id,
            delta,
            reason: 'manual',
          })
          if (moved !== undefined) {
            const adjusted = await store.admin.send(
              'POST',
              `/api/admin/inventory/${variant.id}/adjust`,
              { delta: moved, reason: 'manual' },
            )
            if (adjusted.status !== 200) throw new Error(`adjust: ${JSON.stringify(adjusted.body)}`)
          }
          const rows = await data<Array<{ variantId: string; stock: number }>>(
            `/api/admin/inventory?q=${encodeURIComponent(variant.sku)}`,
          )
          const stock = rows.find((r) => r.variantId === variant.id)!.stock

          const { preview, ...rest } = await viewOf(id)

          expect(preview?.target).toEqual({
            kind: 'variant',
            id: variant.id,
            label: `${product.name}, ${variant.name} (${variant.sku})`,
          })
          expect(preview?.changes).toEqual([
            expect.objectContaining({ label: 'Stock', current: stock, proposed: stock + delta }),
          ])
          expect(rest).toEqual(await listed(id))
        },
      ),
      { numRuns: 15 },
    )
  }, 180_000)

  it('AC-11: property: for any refund up to what is left, the preview names the order #<number> and holds one Refunded money change, current the refunded total GET /api/admin/orders/:orderNumber answers and proposed current plus the amount, in the order’s currency; a cancel holds one Status change from the order’s status to cancelled', async () => {
    type Paid = { orderNumber: string; capturedMinor: number; refundedMinor: number }
    const placed = await data<Paid>(`/api/admin/orders/${paidOrderNumber}`)
    // A part refund that went through, so the refunded total the preview starts from is not zero.
    const refunded = await store.admin.send('POST', `/api/admin/orders/${paidOrderId}/refund`, {
      amountMinor: Math.floor(placed.capturedMinor / 3),
    })
    if (refunded.status >= 300) throw new Error(`refund: ${JSON.stringify(refunded.body)}`)
    await store.kernel.app.relay.drain()
    const paid = await data<Paid>(`/api/admin/orders/${paidOrderNumber}`)
    expect(paid.refundedMinor).toBe(Math.floor(placed.capturedMinor / 3))
    expect(paid.refundedMinor).toBeGreaterThan(0)
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: paid.capturedMinor - paid.refundedMinor }),
        async (amountMinor) => {
          const id = await propose('admin_orders_refund', { id: paidOrderId, amountMinor })
          const order = await data<{
            orderNumber: string
            refundedMinor: number
            currency: string
          }>(`/api/admin/orders/${paidOrderNumber}`)
          expect(order.refundedMinor).toBe(paid.refundedMinor)

          const { preview } = await viewOf(id)

          expect(preview).toEqual({
            target: { kind: 'order', id: paidOrderId, label: `#${order.orderNumber}` },
            changes: [
              expect.objectContaining({
                label: 'Refunded',
                kind: 'money',
                current: order.refundedMinor,
                proposed: order.refundedMinor + amountMinor,
              }),
            ],
            currency: order.currency,
          })
        },
      ),
      { numRuns: 10 },
    )

    const cancel = await propose('admin_orders_cancel', { id: unpaidOrderId })
    const unpaid = await data<{ orderNumber: string; status: string }>(
      `/api/admin/orders/${unpaidOrderNumber}`,
    )
    const { preview } = await viewOf(cancel)
    expect(preview?.target).toEqual({
      kind: 'order',
      id: unpaidOrderId,
      label: `#${unpaid.orderNumber}`,
    })
    expect(preview?.changes).toEqual([
      expect.objectContaining({ label: 'Status', current: unpaid.status, proposed: 'cancelled' }),
    ])
  }, 120_000)

  it('AC-11: a proposal naming a missing product or order answers target null and no changes; a rejected proposal, a product.create proposal and every item of GET /api/admin/proposals carry no preview, while the same update pending does', async () => {
    const missing = randomUUID()
    const ghosts = [
      await propose('admin_products_update', { id: missing, name: 'Nobody' }),
      await propose('admin_inventory_adjust', { variantId: missing, delta: 3, reason: 'manual' }),
      await propose('admin_orders_refund', { id: missing, amountMinor: 100 }),
      await propose('admin_orders_cancel', { id: missing }),
    ]
    const pending = await propose('admin_products_update', { id: productId, name: 'Kept Waiting' })
    const rejected = await propose('admin_products_update', { id: productId, name: 'Turned Down' })
    const refusal = await store.admin.send('POST', `/api/admin/proposals/${rejected}/reject`, {})
    expect(refusal.status, JSON.stringify(refusal.body)).toBe(200)
    const tag = randomUUID()
    const created = await propose('admin_products_create', {
      slug: `preview-new-${tag}`,
      name: 'Proposed Cup',
      status: 'draft',
      variants: [{ sku: `CUP-${tag}`, name: 'Default', priceMinor: 800, stock: 1, options: [] }],
    })

    const read = async (id: string) => {
      const { preview, ...rest } = await viewOf(id)
      return { preview, rest }
    }
    const ghostPreviews = await Promise.all(ghosts.map(async (id) => (await read(id)).preview))
    const [stillPending, decided, create] = await Promise.all([
      read(pending),
      read(rejected),
      read(created),
    ])
    const list = await proposalsOf(store.admin)

    expect(ghostPreviews.map((p) => [p?.target, p?.changes])).toEqual(ghosts.map(() => [null, []]))
    expect(stillPending.preview?.changes.length).toBe(1)
    expect([decided.rest.status, decided.preview]).toEqual(['rejected', undefined])
    expect(create.preview).toBeUndefined()
    expect(list.filter((p) => 'preview' in p).map((p) => p.id)).toEqual([])
  }, 60_000)
})
