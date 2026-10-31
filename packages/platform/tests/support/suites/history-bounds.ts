import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { adminSession, customerSession, type AdminSession } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'
import { startEventRetentionSweeper } from '../../../src/sweepers/index.js'
import type { LoggedEvent } from '../../../src/repositories/event-log.js'
import {
  asJson,
  contextOf,
  customerView,
  dataOf,
  detailPath,
  historyPath,
  instantAfter,
  orderView,
  productView,
  readAsOf,
  readHistory,
  untilDelivered,
  type HistoryKind,
} from '../history.js'
import { unaudited } from '../write-audit.js'

// AC-2 on one dialect: the bounds of `?at=` and history.
// A seeded product (rows with no event) answers 409 `history.before_start` with `historyStartsAt: null`; t before a
// record's first event answers 409 with that event's time, and t at it answers (inclusive); a product deleted at or
// before t answers 410 `history.deleted {deletedAt}`, and before its deletion answers by id; an unparsable `at` is 400
// `history.invalid_at`; an unknown id 404; a future t the live view; no `at` the current body; no admin session 401.
// Then the retention sweep, run with a clock past the horizon, deletes the first part of the log: `historyStartsAt`
// moves to the earliest retained base event, every recorded t from it still matches, an earlier t answers 409, and an
// order whose base event went answers `historyStartsAt: null` rather than a fold of its later events.

type Json = Record<string, unknown>

const DAY_MS = 24 * 60 * 60 * 1000
const KINDS: HistoryKind[] = ['product', 'order', 'customer']

interface Subjects {
  product: { id: string; variantId: string; slug: string }
  order: { id: string; orderNumber: string }
  customer: Awaited<ReturnType<typeof customerSession>>
}

/** The detail key `?at=` takes per kind (an order by its number) and the id history takes. */
function keyOf(s: Subjects, kind: HistoryKind): { key: string; id: string } {
  if (kind === 'product') return { key: s.product.id, id: s.product.id }
  if (kind === 'order') return { key: s.order.orderNumber, id: s.order.id }
  return { key: s.customer.customerId, id: s.customer.customerId }
}

/** The subject table, as this test reads it. */
function subjectIs(row: LoggedEvent, kind: HistoryKind, id: string): boolean {
  const type = row.event.type
  const p = row.event.payload as Record<string, unknown>
  const nested = (key: string) => (p[key] as { id?: unknown } | undefined)?.id
  if (kind === 'product')
    return type.startsWith('product.') && (nested('product') ?? p['productId']) === id
  if (kind === 'order') {
    return (
      (type.startsWith('order.') || type.startsWith('payment.')) &&
      (nested('order') ?? p['orderId']) === id
    )
  }
  return type.startsWith('customer.') && p['customerId'] === id
}

function ms(value: unknown): number {
  return new Date(String(value)).getTime()
}

export function historyBoundsSuite(dialect: string, start: () => Promise<Kernel>): void {
  describe(`AC-2: the bounds of ?at= and history (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminSession

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminSession(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    async function createProduct(stock = 20): Promise<Subjects['product']> {
      const tag = randomUUID().slice(0, 8)
      const res = await admin.send<{ id: string; slug: string; variants: Array<{ id: string }> }>(
        'POST',
        '/api/admin/products',
        {
          slug: `history-ac2-${tag}`,
          name: `Bounded ${tag}`,
          description: '',
          shortDescription: 'Before',
          status: 'active',
          variants: [{ sku: `AC2-${tag}`, name: 'Default', priceMinor: 1500, stock, options: [] }],
        },
      )
      if (res.status !== 201) throw new Error(`create: ${JSON.stringify(res.body)}`)
      const data = res.body.data!
      return { id: data.id, slug: data.slug, variantId: data.variants[0]!.id }
    }

    async function subjects(): Promise<Subjects> {
      const product = await createProduct()
      const seeded: Seeded = {
        productId: product.id,
        variantId: product.variantId,
        priceMinor: 1500,
        initialStock: 20,
      }
      const placed = await checkoutOf(k, seeded, 1, `paid-${randomUUID()}@history.test`)
      const customer = await customerSession(served.baseUrl)
      return { product, order: { id: placed.orderId, orderNumber: placed.orderNumber }, customer }
    }

    async function liveView(s: Subjects, kind: HistoryKind): Promise<Json> {
      if (kind === 'product')
        return productView(asJson(await k.services.product.getById(s.product.id)))
      const read = dataOf(
        await admin.send<Json>('GET', detailPath(kind, keyOf(s, kind).key)),
        `GET ${kind}`,
      )
      return kind === 'order' ? orderView(read) : customerView(read)
    }

    /** The rows the subject table gives the subject `id` of `kind` (a product's own rows, not its variant's), by seq. */
    async function rowsOf(kind: HistoryKind, id: string): Promise<LoggedEvent[]> {
      const all = await k.store.read((tx) => k.repos.eventLog.listAll(tx))
      return all.filter((row) => subjectIs(row, kind, id))
    }

    it('AC-2: a seeded product, with rows and no event, answers 409 history.before_start with historyStartsAt null, and its history lists nothing from a null start', async () => {
      const id = randomUUID()
      const now = new Date()
      await unaudited(() =>
        k.store.transaction(async (tx) => {
          await k.repos.product.insert(tx, {
            id,
            slug: `history-seeded-${id.slice(0, 8)}`,
            name: 'Seeded',
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })
          await k.repos.variant.insert(tx, {
            id: randomUUID(),
            productId: id,
            sku: `SEED-${id.slice(0, 8)}`,
            name: 'Default',
            priceMinor: 900,
            stock: 3,
            options: [],
            createdAt: now,
            updatedAt: now,
          })
        }),
      )
      expect(await rowsOf('product', id), 'the fixture: no event names the seeded product').toEqual(
        [],
      )

      const res = await readAsOf(admin, 'product', id, new Date().toISOString())
      expect([res.status, res.body.error?.code]).toEqual([409, 'history.before_start'])
      expect(contextOf(res)['historyStartsAt']).toBeNull()

      const history = await readHistory(admin, 'product', id)
      expect(history.status, JSON.stringify(history.body)).toBe(200)
      expect(history.body.data?.historyStartsAt).toBeNull()
      expect(history.body.data?.entries).toEqual([])
    })

    it('AC-2: t a millisecond before each kind’s first event answers 409 with that event’s time; t at it answers 200 (created_at ≤ t)', async () => {
      const s = await subjects()
      for (const kind of KINDS) {
        const { key, id } = keyOf(s, kind)
        const [first] = await rowsOf(kind, id)
        expect(first, `${kind}: the fixture's first event`).not.toBeUndefined()
        const startsAt = first!.createdAt.getTime()

        const before = await readAsOf(admin, kind, key, new Date(startsAt - 1).toISOString())
        expect([before.status, before.body.error?.code], kind).toEqual([
          409,
          'history.before_start',
        ])
        expect(ms(contextOf(before)['historyStartsAt']), kind).toBe(startsAt)

        const at = await readAsOf(admin, kind, key, new Date(startsAt).toISOString())
        expect(at.status, `${kind}: ${JSON.stringify(at.body)}`).toBe(200)
        expect(ms(at.body.data?.historyStartsAt), kind).toBe(startsAt)
      }
    })

    it('AC-2: a deleted product answers by id before its deletion, 410 history.deleted {deletedAt} at and after it, and its history by id', async () => {
      const product = await createProduct()
      const renamed = await admin.send('PATCH', `/api/admin/products/${product.id}`, {
        name: 'Renamed before deletion',
      })
      expect(renamed.status).toBe(200)
      const view = productView(asJson(await k.services.product.getById(product.id)))
      const beforeDeletion = await instantAfter()
      const deleted = await admin.send('DELETE', `/api/admin/products/${product.id}`)
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
      const deletion = (await rowsOf('product', product.id)).find((row) =>
        row.event.type.startsWith('product.deleted'),
      )
      expect(deletion, 'the fixture: the product.deleted row').not.toBeUndefined()
      const deletedAt = deletion!.createdAt.getTime()

      const earlier = await readAsOf(admin, 'product', product.id, beforeDeletion)
      expect({ status: earlier.status, record: earlier.body.data?.record }).toEqual({
        status: 200,
        record: view,
      })
      for (const t of [deletedAt, Date.now() + DAY_MS]) {
        const gone = await readAsOf(admin, 'product', product.id, new Date(t).toISOString())
        expect([gone.status, gone.body.error?.code], new Date(t).toISOString()).toEqual([
          410,
          'history.deleted',
        ])
        expect(ms(contextOf(gone)['deletedAt'])).toBe(deletedAt)
      }
      const history = await readHistory(admin, 'product', product.id)
      expect(history.status, JSON.stringify(history.body)).toBe(200)
      expect(history.body.data?.entries.length ?? 0).toBeGreaterThanOrEqual(2)
    })

    it('AC-2: an unparsable at answers 400 history.invalid_at; an unknown id 404; a future t the live view; no at today’s body', async () => {
      const s = await subjects()
      for (const kind of KINDS) {
        const { key } = keyOf(s, kind)
        for (const at of ['not-a-time', '2026-10-24T25:61:00Z']) {
          const res = await readAsOf(admin, kind, key, at)
          expect([res.status, res.body.error?.code], `${kind} at=${at}`).toEqual([
            400,
            'history.invalid_at',
          ])
        }
        const unknown = kind === 'order' ? `NYM-UNKNOWN-${randomUUID()}` : randomUUID()
        const missing = await readAsOf(admin, kind, unknown, new Date().toISOString())
        expect(missing.status, `${kind} unknown`).toBe(404)

        const future = await readAsOf(admin, kind, key, new Date(Date.now() + DAY_MS).toISOString())
        expect({ status: future.status, record: future.body.data?.record }, kind).toEqual({
          status: 200,
          record: await liveView(s, kind),
        })
      }

      const order = dataOf(
        await admin.send<Json>('GET', detailPath('order', s.order.orderNumber)),
        'order',
      )
      expect(order['orderNumber']).toBe(s.order.orderNumber)
      expect(Array.isArray(order['history']), 'the order read keeps its history').toBe(true)
      expect('record' in order, 'the order read without at is not an as-of body').toBe(false)
      const customer = dataOf(
        await admin.send<Json>('GET', detailPath('customer', s.customer.customerId)),
        'customer',
      )
      expect((customer['customer'] as Json)['id']).toBe(s.customer.customerId)
      expect(typeof customer['stats'], 'the customer read keeps its stats').toBe('object')
      expect('record' in customer).toBe(false)
    })

    it('AC-2: ?at= and history answer 401 without an admin session', async () => {
      const s = await subjects()
      for (const kind of KINDS) {
        const { key, id } = keyOf(s, kind)
        const at = encodeURIComponent(new Date().toISOString())
        for (const path of [`${detailPath(kind, key)}?at=${at}`, historyPath(kind, id)]) {
          const res = await fetch(new URL(path, served.baseUrl))
          expect(res.status, path).toBe(401)
        }
      }
    })

    describe('retention', () => {
      let rk: Kernel
      let rserved: ServedKernel
      let radmin: AdminSession
      let raw: RawReader

      beforeAll(async () => {
        rk = await start()
        rserved = await serveKernel(rk)
        radmin = await adminSession(rk, rserved.baseUrl)
        raw = openRaw(rk.dialect, rk.target)
      }, 60_000)

      afterAll(async () => {
        await raw?.close()
        await rserved?.stop()
      })

      it('AC-2: after the retention sweep with a clock past the horizon, historyStartsAt is the earliest retained base event, every recorded t from it still matches, an earlier t answers 409, and an order whose base event went has a null start', async () => {
        const retentionDays = rk.config.events?.retentionDays ?? 30
        const tag = randomUUID().slice(0, 8)
        const created = await radmin.send<{ id: string; variants: Array<{ id: string }> }>(
          'POST',
          '/api/admin/products',
          {
            slug: `history-ret-${tag}`,
            name: `Retained ${tag}`,
            description: '',
            status: 'active',
            variants: [
              { sku: `RET-${tag}`, name: 'Default', priceMinor: 700, stock: 30, options: [] },
            ],
          },
        )
        expect(created.status).toBe(201)
        const productId = created.body.data!.id
        const variantId = created.body.data!.variants[0]!.id
        const placed = await checkoutOf(
          rk,
          { productId, variantId, priceMinor: 700, initialStock: 30 },
          1,
          `paid-${randomUUID()}@history.test`,
        )
        const customer = await customerSession(rserved.baseUrl)
        const productView0 = productView(asJson(await rk.services.product.getById(productId)))
        const early = await instantAfter()

        // The first part of the log is delivered before the cut, so the sweep may delete it.
        await untilDelivered(raw)
        const cut = Date.now()
        await instantAfter()

        expect(
          (await radmin.send('PATCH', `/api/admin/products/${productId}`, { name: `Kept ${tag}` }))
            .status,
        ).toBe(200)
        const kept: Array<{ t: string; view: Json }> = []
        kept.push({
          t: await instantAfter(),
          view: productView(asJson(await rk.services.product.getById(productId))),
        })
        expect(
          (
            await radmin.send('POST', `/api/admin/inventory/${variantId}/adjust`, {
              delta: 4,
              reason: 'manual',
            })
          ).status,
        ).toBe(200)
        kept.push({
          t: await instantAfter(),
          view: productView(asJson(await rk.services.product.getById(productId))),
        })
        expect(
          (await radmin.send('POST', `/api/admin/orders/${placed.orderId}/process`, {})).status,
        ).toBe(200)
        expect(
          (await customer.send('PATCH', '/api/customers/me', { firstName: 'Kept' })).status,
        ).toBe(200)
        const customerRead = dataOf(
          await radmin.send<Json>('GET', detailPath('customer', customer.customerId)),
          'customer',
        )
        const customerT = await instantAfter()

        const rowsBefore = await raw.count('events', 'created_at < ?', [
          rk.dialect === 'sqlite' ? new Date(cut).toISOString() : new Date(cut),
        ])
        vi.useFakeTimers({ toFake: ['Date'], now: cut + retentionDays * DAY_MS })
        try {
          const sweeper = startEventRetentionSweeper({
            store: rk.store,
            eventLog: rk.repos.eventLog,
            processedEvents: rk.repos.processedEvent,
            logger: rk.logger,
            retentionDays,
            intervalMs: 3_600_000,
          })
          try {
            await sweeper.tick()
          } finally {
            sweeper.stop()
          }
        } finally {
          vi.useRealTimers()
        }
        const rowsAfter = await raw.count('events', 'created_at < ?', [
          rk.dialect === 'sqlite' ? new Date(cut).toISOString() : new Date(cut),
        ])
        expect(rowsBefore, 'the fixture: events before the cut').toBeGreaterThan(0)
        expect(rowsAfter, 'the fixture: the sweep deleted every event before the cut').toBe(0)

        const retained = await rk.store.read((tx) => rk.repos.eventLog.listAll(tx))
        const baseOf = (kind: HistoryKind, id: string, types: string[]) =>
          retained.find(
            (row) =>
              types.some((type) => row.event.type.startsWith(type)) && subjectIs(row, kind, id),
          )
        const productBase = baseOf('product', productId, ['product.created', 'product.updated'])
        const customerBase = baseOf('customer', customer.customerId, [
          'customer.created',
          'customer.updated',
        ])
        expect(productBase?.event.type, 'the fixture: the rename is retained').toMatch(
          /^product\.updated/,
        )

        const productHistory = dataOf(await readHistory(radmin, 'product', productId), 'history')
        expect(ms(productHistory.historyStartsAt)).toBe(productBase!.createdAt.getTime())
        expect(productHistory.retentionDays).toBe(retentionDays)
        for (const { t, view } of kept) {
          const res = await readAsOf(radmin, 'product', productId, t)
          expect({ status: res.status, record: res.body.data?.record }, t).toEqual({
            status: 200,
            record: view,
          })
        }
        const lost = await readAsOf(radmin, 'product', productId, early)
        expect([lost.status, lost.body.error?.code]).toEqual([409, 'history.before_start'])
        expect(ms(contextOf(lost)['historyStartsAt'])).toBe(productBase!.createdAt.getTime())
        expect(productView0['name'], 'the fixture: the early view is not the kept one').not.toBe(
          kept[0]!.view['name'],
        )

        const orderHistory = dataOf(await readHistory(radmin, 'order', placed.orderId), 'history')
        expect(orderHistory.historyStartsAt, 'an order whose order.placed went').toBeNull()
        const orderNow = await readAsOf(
          radmin,
          'order',
          placed.orderNumber,
          new Date().toISOString(),
        )
        expect([orderNow.status, orderNow.body.error?.code]).toEqual([409, 'history.before_start'])
        expect(contextOf(orderNow)['historyStartsAt']).toBeNull()

        expect(customerBase?.event.type).toMatch(/^customer\.updated/)
        const customerAt = await readAsOf(radmin, 'customer', customer.customerId, customerT)
        expect({ status: customerAt.status, record: customerAt.body.data?.record }).toEqual({
          status: 200,
          record: customerView(customerRead),
        })
        expect(ms(customerAt.body.data?.historyStartsAt)).toBe(customerBase!.createdAt.getTime())
      }, 60_000)
    })
  })
}
