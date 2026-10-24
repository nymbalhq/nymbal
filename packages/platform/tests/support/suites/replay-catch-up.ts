import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_ORDER_PLACED,
  type DocumentStoreAdapter,
  type NymbalEvent,
  type SearchDocument,
} from '@nymbalhq/types'
import { createEventBuilder } from '../../../src/events/builder.js'
import { rebuild, type RebuildReport } from '../../../src/read-models/index.js'
import { address, type Kernel } from '../kernel.js'
import { queryOnce } from '../postgres.js'
import {
  ALL_MODELS,
  DOCUMENT_COLLECTIONS,
  documentModelsOf,
  gate,
  nativeSearchDocuments,
  pagesOf,
  rebuildDeps,
  rebuildFresh,
} from '../read-models.js'

// AC-3 on one dialect: no write is lost to a rebuild. The rebuild of every model runs against the kernel's own read
// models with a small page size and is paused by its `onPage` hook at a generated page; while it waits, writes go
// through the services and the in-process relay delivers them to the old set; then the rebuild swaps and catches up.
// Some runs restamp those events' `delivered_at` up to five minutes before the rebuild started, as a relay on a slower
// clock would. After each run the live read models equal a fresh rebuild, and each write is there. On Postgres a
// lower-seq transaction that commits after the rebuild's reads is caught up too (SQLite serialises writers, so it
// cannot happen there). A catch-up handler that fails is reported with the event's seq, the model is swapped all the
// same, and catch-up carries on past it.
// `listForCatchUp` is checked directly: non-dead, delivered at or after `since` or never, by seq.

const PAGE_SIZE = 2
const SKEW_MAX_MS = 5 * 60_000

interface Item {
  id: string
  slug: string
  variantId: string
  priceMinor: number
}

/** Loads the driver on the SQLite file a second time, writable, for what a test does behind the kernel's back. */
async function onSqlite(path: string, sql: string, params: unknown[]): Promise<void> {
  const db = new Database(path)
  try {
    db.pragma('busy_timeout = 5000')
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

/** Sets `delivered_at` of every event above `afterSeq` to `at`, as a relay on another clock would have stamped it. */
async function restampDelivered(k: Kernel, afterSeq: number, at: Date): Promise<void> {
  if (k.dialect === 'sqlite') {
    await onSqlite(k.target, 'UPDATE events SET delivered_at = ? WHERE seq > ?', [
      at.toISOString(),
      afterSeq,
    ])
  } else {
    await queryOnce(k.target, 'UPDATE events SET delivered_at = $1 WHERE seq > $2', [at, afterSeq])
  }
}

const maxSeq = (k: Kernel) => k.store.read((tx) => k.repos.eventLog.maxSeq(tx))

async function product(k: Kernel, categoryIds: string[], stock = 5): Promise<Item> {
  const tag = randomUUID().slice(0, 8)
  const p = await k.services.product.create({
    slug: `catchup-${tag}`,
    name: `catchup ${tag}`,
    status: 'active',
    categoryIds,
    variants: [
      {
        sku: `CU-${tag}`,
        name: 'Default',
        priceMinor: 1500,
        stock,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  return { id: p.id, slug: p.slug, variantId: p.variants[0]!.id, priceMinor: 1500 }
}

async function pendingOrder(
  k: Kernel,
  item: Item,
  customerId: string | null,
): Promise<{ id: string; orderNumber: string }> {
  const cart = await k.services.cart.getOrCreate(undefined, customerId)
  await k.services.cart.addItem(cart.token, {
    variantId: item.variantId,
    productId: item.id,
    productName: 'catchup',
    variantName: 'Default',
    priceMinor: item.priceMinor,
    imageUrl: '',
    qty: 1,
  })
  const started = await k.services.checkout.beginCheckout({
    cartToken: cart.token,
    customerId,
    email: `catchup-${randomUUID()}+stub-pending@replay.test`,
    billingAddress: address,
    shippingAddress: address,
  })
  return { id: started.orderId, orderNumber: started.orderNumber }
}

/** Live read models against a fresh rebuild of the same tables: equal collection by collection and in the index. */
async function expectLiveEqualsRebuild(k: Kernel): Promise<void> {
  await k.app.relay.drain()
  const live = await documentModelsOf(k.documentStore)
  const index = await nativeSearchDocuments(k)
  const fresh = await rebuildFresh(k)
  for (const name of DOCUMENT_COLLECTIONS) {
    expect(live[name], `live ${name} after the rebuild`).toEqual(fresh.documents[name])
  }
  expect(index, 'the live index after the rebuild').toEqual(fresh.search)
}

const searchDoc = (index: SearchDocument[], id: string) => index.find((d) => d.id === id)

/**
 * A rebuild of every model on the kernel's own read models that stops at its `pauseAt`th `onPage` call (0-based) until
 * `resume()`. `paused` resolves when it stops, or rejects if the rebuild ended without reaching it.
 */
function pausedRebuild(
  k: Kernel,
  pauseAt: number,
  documentStore: DocumentStoreAdapter = k.documentStore,
) {
  const stopped = gate()
  const go = gate()
  let calls = 0
  const done: Promise<RebuildReport> = rebuild(
    ALL_MODELS,
    rebuildDeps(k, {
      documentStore,
      pageSize: PAGE_SIZE,
      onPage: async () => {
        const call = calls
        calls += 1
        if (call !== pauseAt) return
        stopped.open()
        await go.opened
      },
    }),
  )
  const paused = Promise.race([
    stopped.opened,
    done.then(() => {
      throw new Error(
        `the rebuild ended after ${calls} onPage calls without reaching call ${pauseAt}`,
      )
    }),
  ])
  return { paused, resume: go.open, done }
}

export function replayCatchUpSuite(
  dialect: Kernel['dialect'],
  open: () => Promise<{ kernel: Kernel; drop(): Promise<void> }>,
  opts: { runs: number },
): void {
  describe(`AC-3: writes during a rebuild survive the swap (${dialect})`, () => {
    let k: Kernel
    let drop: () => Promise<void>

    beforeAll(async () => {
      ;({ kernel: k, drop } = await open())
    }, 60_000)

    afterAll(async () => {
      await k?.close()
      await drop?.()
    })

    it('AC-3: over generated pause points and relay clock skews (0 to 5 min before T0), a product renamed, stock moved, a product created, an order paid and a customer updated while the rebuild waits are all in the live read models after the swap, which equal a fresh rebuild; catch-up reports the events it applied', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            point: fc.nat({ max: 1_000 }),
            skewed: fc.boolean(),
            skewMs: fc.integer({ min: 0, max: SKEW_MAX_MS }),
          }),
          async ({ point, skewed, skewMs }) => {
            const tag = randomUUID().slice(0, 8)
            const category = await k.services.category.create({
              slug: `catchup-${tag}`,
              name: `catchup ${tag}`,
            })
            const items: Item[] = []
            for (let i = 0; i < 5; i++) items.push(await product(k, [category.id]))
            const { customer } = await k.services.auth.register({
              email: `catchup-${tag}@replay.test`,
              password: 'correct-horse-battery',
            })
            const order = await pendingOrder(k, items[0]!, customer.id)
            await k.app.relay.drain()

            const pages = await pagesOf(k, PAGE_SIZE)
            expect(pages, 'a rebuild of every model reads at least one page').toBeGreaterThan(0)
            const run = pausedRebuild(k, point % pages)
            await run.paused

            const before = await maxSeq(k)
            const renamed = `renamed ${randomUUID().slice(0, 8)}`
            await k.services.product.update(items[1]!.id, { name: renamed })
            await k.services.inventory.adjustStock(items[2]!.variantId, -2, 'manual', 'replay')
            const added = await product(k, [category.id])
            await k.services.checkout.markPaid(order.id, 'replay')
            await k.services.customer.updateProfile(customer.id, { firstName: `Ada ${tag}` })
            await k.app.relay.drain()
            if (skewed) await restampDelivered(k, before, new Date(Date.now() - skewMs))

            run.resume()
            const report = await run.done

            const live = await documentModelsOf(k.documentStore)
            const bySlug = (slug: string) =>
              (live['products'] as Array<{ slug: string }>).find((p) => p.slug === slug) as
                | { name: string; variants: Array<{ id: string; stock: number }> }
                | undefined
            expect(bySlug(items[1]!.slug)?.name, 'the rename').toBe(renamed)
            const stock = await k.services.inventory.getStockStatus(items[2]!.variantId)
            expect(
              bySlug(items[2]!.slug)?.variants.find((v) => v.id === items[2]!.variantId)?.stock,
              'the stock move',
            ).toBe(stock.stock)
            expect(bySlug(added.slug), 'the product created').toBeDefined()
            const paid = await k.services.order.getById(order.id)
            const orderDoc = (
              live['orders'] as Array<{ orderNumber: string; status: string }>
            ).find((o) => o.orderNumber === order.orderNumber)
            expect(orderDoc?.status, 'the payment').toBe(paid.status)
            const index = await nativeSearchDocuments(k)
            expect(searchDoc(index, items[1]!.id)?.fields['name'], 'the rename, in the index').toBe(
              renamed,
            )
            expect(searchDoc(index, added.id)?.id, 'the product created, in the index').toBe(
              added.id,
            )

            const caughtUp = report.reduce((n, e) => n + e.caughtUpEvents, 0)
            expect(caughtUp, 'events delivered after T0 are caught up').toBeGreaterThan(0)
            await expectLiveEqualsRebuild(k)
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 300_000)

    if (dialect === 'postgres') {
      it('AC-3 (a): a transaction that took a lower seq, held open until the rebuild has read every page, commits and is delivered before the swap: catch-up applies it although a higher seq was delivered before the rebuild began', async () => {
        const category = await k.services.category.create({
          slug: `late-${randomUUID().slice(0, 8)}`,
          name: 'late commit',
        })
        const early = await product(k, [category.id])
        const other = await product(k, [category.id])
        await k.app.relay.drain()
        const pages = await pagesOf(k, PAGE_SIZE)

        const held = gate()
        const inside = gate()
        const lateName = `late ${randomUUID().slice(0, 8)}`
        const lateCommit = k.store.transaction(async () => {
          await k.services.product.update(early.id, { name: lateName })
          inside.open()
          await held.opened
        })
        await inside.opened
        await k.services.product.update(other.id, { name: `other ${randomUUID().slice(0, 8)}` })
        const delivered = await maxSeq(k)

        const run = pausedRebuild(k, pages - 1)
        await run.paused
        held.open()
        await lateCommit
        await k.app.relay.drain()
        const logged = await k.store.read((tx) => k.repos.eventLog.listAll(tx))
        const lateSeqs = logged
          .filter(
            (e) => e.event.type.startsWith('product.updated') && aboutProduct(e.event, early.id),
          )
          .map((e) => e.seq)
        expect(lateSeqs.length, 'the held transaction logged its product.updated').toBeGreaterThan(
          0,
        )
        expect(
          Math.min(...lateSeqs),
          'its seq is below one delivered before the rebuild began',
        ).toBeLessThan(delivered)
        run.resume()
        await run.done

        const doc = await k.documentStore.get<{ name: string }>('products', early.slug)
        expect(doc?.name, 'the late commit after the swap').toBe(lateName)
        expect(searchDoc(await nativeSearchDocuments(k), early.id)?.fields['name']).toBe(lateName)
        await expectLiveEqualsRebuild(k)
      }, 120_000)
    }

    it('AC-3: a catch-up event whose handler fails is reported with its seq; the orders model is swapped all the same (a hand-edited order document is rebuilt) and catch-up goes on (a rename made at the same pause is applied)', async () => {
      const item = await product(k, [])
      const drifted = await pendingOrder(k, item, null)
      await k.app.relay.drain()
      const stored = await k.documentStore.get<Record<string, unknown>>(
        'orders',
        drifted.orderNumber,
      )
      expect(stored?.['orderNumber']).toBe(drifted.orderNumber)
      await k.documentStore.put('orders', drifted.orderNumber, { ...stored, notes: 'hand-edited' })
      const pages = await pagesOf(k, PAGE_SIZE)

      const poison = { key: '' }
      const target = withFailingPut(k.documentStore, 'orders', poison)
      const run = pausedRebuild(k, pages - 1, target)
      await run.paused
      const placed = await pendingOrder(k, item, null)
      poison.key = placed.orderNumber
      const renamed = `after failure ${randomUUID().slice(0, 8)}`
      await k.services.product.update(item.id, { name: renamed })
      await k.app.relay.drain()
      run.resume()
      const report = await run.done

      const logged = await k.store.read((tx) => k.repos.eventLog.listAll(tx))
      const ofPlaced = new Set(
        logged.filter((e) => refersToOrder(e.event, placed.id)).map((e) => e.seq),
      )
      const placedSeq = logged.find(
        (e) =>
          e.event.type === EVT_ORDER_PLACED &&
          (e.event.payload as { order: { id: string } }).order.id === placed.id,
      )?.seq
      expect(placedSeq, 'the order.placed of the order placed at the pause').toBeDefined()
      const failures = report.find((e) => e.model === 'orders')?.failures ?? []
      expect(failures.map((f) => f.seq)).toContain(placedSeq)
      for (const f of failures) {
        expect(
          ofPlaced.has(f.seq),
          `failure at seq ${f.seq} is an event of the poisoned order`,
        ).toBe(true)
      }
      const rebuiltDrift = await k.documentStore.get<Record<string, unknown>>(
        'orders',
        drifted.orderNumber,
      )
      expect(rebuiltDrift?.['notes'], 'the hand edit is gone: the orders model was swapped').toBe(
        stored?.['notes'],
      )
      const doc = await k.documentStore.get<{ name: string }>('products', item.slug)
      expect(doc?.name, 'catch-up went on past the failure').toBe(renamed)
    }, 120_000)

    it('AC-3: listForCatchUp returns the non-dead events delivered at or after `since`, or never delivered, by seq; one delivered a millisecond before `since` and a dead one are left out', async () => {
      const make = createEventBuilder({
        storeId: k.config.store.name,
        environment: 'development',
        version: '0.0.0',
        source: 'replay-probe',
      })
      const events = Array.from({ length: 5 }, (_, i) => make('replay.probe.v1', { i }))
      const ids = events.map((e) => e.id)
      const since = new Date(Date.now() - 60 * 60_000)
      await k.store.transaction(async (tx) => {
        await k.repos.eventLog.append(tx, events)
        await k.repos.eventLog.markDelivered(tx, [ids[0]!], new Date(since.getTime() - 1))
        await k.repos.eventLog.markDelivered(tx, [ids[1]!], since)
        await k.repos.eventLog.markDelivered(tx, [ids[2]!], new Date(since.getTime() + 1000))
        await k.repos.eventLog.recordFailure(tx, ids[4]!, new Date(), 1)
      })

      const listed = await k.store.read((tx) => k.repos.eventLog.listForCatchUp(tx, since))
      const ours = listed.filter((e) => ids.includes(e.event.id)).map((e) => e.event.id)
      expect(ours).toEqual([ids[1], ids[2], ids[3]])
      const seqs = listed.map((e) => e.seq)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!)
    })
  })
}

/** A product event about `productId`: its payload names it as `productId` or carries the product. */
function aboutProduct(event: NymbalEvent<unknown>, productId: string): boolean {
  const payload = event.payload as { productId?: string; product?: { id?: string } }
  return payload.productId === productId || payload.product?.id === productId
}

/** An event about `orderId`: its payload names it as `orderId` or carries the order. */
function refersToOrder(event: NymbalEvent<unknown>, orderId: string): boolean {
  const payload = event.payload as { orderId?: string; order?: { id?: string } }
  return payload.orderId === orderId || payload.order?.id === orderId
}

/** `inner`, except that a put (or a batch holding it) of `poison.key` in `collection` throws. */
function withFailingPut(
  inner: DocumentStoreAdapter,
  collection: string,
  poison: { key: string },
): DocumentStoreAdapter {
  const hit = (c: string, key: string) =>
    c === collection && poison.key !== '' && key === poison.key
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'put') {
        return async (c: string, key: string, doc: unknown, options?: unknown) => {
          if (hit(c, key)) throw new Error(`replay: the document store refused ${c}/${key}`)
          return target.put(c, key, doc, options as never)
        }
      }
      if (prop === 'batchPut') {
        return async (c: string, items: Map<string, unknown>) => {
          for (const key of items.keys()) {
            if (hit(c, key)) throw new Error(`replay: the document store refused ${c}/${key}`)
          }
          return target.batchPut(c, items)
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    },
  })
}
