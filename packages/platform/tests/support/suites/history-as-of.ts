import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, customerSession, type AdminSession, type Answer } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, checkoutOf, type Kernel, type Seeded } from '../kernel.js'
import { deliverCapture, type Started } from '../webhooks.js'
import {
  asJson,
  customerView,
  dataOf,
  detailPath,
  instantAfter,
  orderView,
  productView,
  readAsOf,
  type HistoryKind,
} from '../history.js'

// AC-1 (decisions 1-4): state at t from the log equals the read taken at t, on
// one dialect. A kernel from `src/` served over HTTP; commands from an admin over HTTP, a customer over HTTP, and
// checkouts and reservation releases through the services. After each command the test reads every subject of the
// run live (the product through `product.getById`, which `GET /api/admin/products/:idOrSlug` answers; the order and the
// customer through their admin GETs), records the instant `t` a millisecond after, and starts the next command a
// millisecond after `t`. Afterwards every recorded `GET <detail>?at=t` answers 200 with `record` equal to the view the
// live read gave at t: Decision 3's view, computed here, and equal to the kernel's `to<Kind>AsOf` of the same read.
// Kills: the fold missing an event type or applying one out of seq order; stock taken from the last snapshot rather
// than `inventory.changed`; `customer.*` with no snapshot; refunds double-counted or overwriting a status the guard
// keeps; `paymentIntentId` left null after checkout; `created_at` against t with the wrong inclusivity; a capture that
// lands on a cancelled order (recorded and refunded in full) with its captured or refunded amount missing from the
// fold, or its refund counted twice.

type Json = Record<string, unknown>

const KINDS = [
  // Product
  'rename',
  'shortDescription',
  'categories',
  'publish',
  'unpublish',
  'archive',
  'adjust',
  'reserve',
  'markPaid',
  'release',
  // Order
  'placePaid',
  'confirm',
  'process',
  'ship',
  'deliver',
  'cancel',
  'refundFull',
  'refundPartial',
  'lateCapture',
  // Customer
  'profile',
  'addAddress',
  'deleteAddress',
] as const
type Kind = (typeof KINDS)[number]

interface Step {
  kind: Kind
  pick: number
  text: string
  delta: number
  categories: number[]
}

interface Recorded {
  kind: HistoryKind
  key: string
  t: string
  view: Json
  read: Json
  after: string
}

interface Run {
  productId: string
  seeded: Seeded
  customer: Awaited<ReturnType<typeof customerSession>>
  orders: Array<{ id: string; orderNumber: string; started: Started }>
  product: Json
  customerRead: Json
  orderReads: Map<string, Json>
  records: Recorded[]
  /** The commands answered 4xx or thrown as refusals, in order. */
  refused: string[]
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  kind: fc.constantFrom(...KINDS),
  pick: fc.nat({ max: 7 }),
  text: fc.stringMatching(/^[A-Za-z0-9]{1,12}$/),
  delta: fc.integer({ min: -3, max: 5 }).filter((d) => d !== 0),
  categories: fc.shuffledSubarray([0, 1]),
})

/** Every kind once, in an order that makes each one apply: the deterministic walk before the property. */
const WALK: Kind[] = [
  'rename',
  'shortDescription',
  'categories',
  'adjust',
  'reserve',
  'markPaid',
  'process',
  'ship',
  'deliver',
  'refundPartial',
  'refundFull',
  'reserve',
  'release',
  'cancel',
  'lateCapture',
  'placePaid',
  'confirm',
  'refundFull',
  'unpublish',
  'publish',
  'archive',
  'profile',
  'addAddress',
  'addAddress',
  'deleteAddress',
]

/** A 5xx is a broken fixture; a 4xx is a refused command, noted so the walk can check which ones were. */
function expectOk(run: Run, res: Answer, what: string): void {
  if (res.status >= 500) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`)
  if (res.status >= 400) run.refused.push(what)
}

export function historyAsOfSuite(
  dialect: string,
  start: () => Promise<Kernel>,
  opts: { runs: number; maxSteps: number },
): void {
  describe(`AC-1: state at t from the log equals the admin read taken at t (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let admin: AdminSession
    const categoryIds: string[] = []

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      admin = await adminSession(k, served.baseUrl)
      for (const n of [0, 1]) {
        const tag = randomUUID().slice(0, 8)
        const category = await k.services.category.create({
          slug: `history-${n}-${tag}`,
          name: `History ${n}`,
        })
        categoryIds.push(category.id)
      }
    }, 60_000)

    afterAll(async () => {
      await served?.stop()
    })

    async function readOrder(orderNumber: string): Promise<Json> {
      return dataOf(
        await admin.send<Json>('GET', detailPath('order', orderNumber)),
        `GET order ${orderNumber}`,
      )
    }

    /** Reads every subject of the run live, then records each view at one instant after the reads. */
    async function record(run: Run, after: string): Promise<void> {
      run.product = asJson(await k.services.product.getById(run.productId))
      run.customerRead = dataOf(
        await admin.send<Json>('GET', detailPath('customer', run.customer.customerId)),
        'GET customer',
      )
      for (const order of run.orders)
        run.orderReads.set(order.id, await readOrder(order.orderNumber))
      const t = await instantAfter()
      run.records.push({
        kind: 'product',
        key: run.productId,
        t,
        view: productView(run.product),
        read: run.product,
        after,
      })
      run.records.push({
        kind: 'customer',
        key: run.customer.customerId,
        t,
        view: customerView(run.customerRead),
        read: run.customerRead,
        after,
      })
      for (const order of run.orders) {
        const read = run.orderReads.get(order.id)!
        run.records.push({
          kind: 'order',
          key: order.orderNumber,
          t,
          view: orderView(read),
          read,
          after,
        })
      }
    }

    async function begin(): Promise<Run> {
      const tag = randomUUID().slice(0, 8)
      const created = await admin.send<{ id: string; variants: Array<{ id: string }> }>(
        'POST',
        '/api/admin/products',
        {
          slug: `history-ac1-${tag}`,
          name: `History ${tag}`,
          description: 'A product of one AC-1 run.',
          shortDescription: 'First',
          status: 'active',
          variants: [
            { sku: `P303-${tag}`, name: 'Default', priceMinor: 1000, stock: 40, options: [] },
          ],
        },
      )
      if (created.status !== 201) throw new Error(`create: ${JSON.stringify(created.body)}`)
      const product = created.body.data!
      const run: Run = {
        productId: product.id,
        seeded: {
          productId: product.id,
          variantId: product.variants[0]!.id,
          priceMinor: 1000,
          initialStock: 40,
        },
        customer: await customerSession(served.baseUrl),
        orders: [],
        product: {},
        customerRead: {},
        orderReads: new Map(),
        records: [],
        refused: [],
      }
      await record(run, 'create and register')
      return run
    }

    const statusOf = (run: Run, id: string) => run.orderReads.get(id)?.['status'] as string
    const paymentOf = (run: Run, id: string) =>
      run.orderReads.get(id)?.['payment'] as { capturedMinor: number; refundedMinor: number }

    /** An order for the move: one whose state allows it when there is one, else any (the command is refused). */
    function target(
      run: Run,
      pick: number,
      fits: (id: string) => boolean,
    ): Run['orders'][number] | undefined {
      const fitting = run.orders.filter((o) => fits(o.id))
      const pool = fitting.length > 0 ? fitting : run.orders
      return pool.length === 0 ? undefined : pool[pick % pool.length]
    }

    async function place(run: Run, pending: boolean): Promise<void> {
      const email = `buyer-${randomUUID()}${pending ? '+stub-pending' : ''}@history.test`
      try {
        const placed = await checkoutOf(k, run.seeded, 1, email)
        run.orders.push({ id: placed.orderId, orderNumber: placed.orderNumber, started: placed })
      } catch {
        // Refused (out of stock, or the product is not on sale): the run goes on with the log as it is.
        run.refused.push(pending ? 'reserve' : 'placePaid')
      }
    }

    async function orderCommand(
      run: Run,
      step: Step,
      fits: (id: string) => boolean,
      send: (order: Run['orders'][number]) => Promise<Answer>,
    ): Promise<void> {
      const order = target(run, step.pick, fits)
      if (order === undefined) return place(run, false)
      expectOk(run, await send(order), step.kind)
    }

    async function apply(run: Run, step: Step): Promise<void> {
      const product = `/api/admin/products/${run.productId}`
      const orderPath = (id: string, action: string) => `/api/admin/orders/${id}/${action}`
      switch (step.kind) {
        case 'rename':
          return expectOk(
            run,
            await admin.send('PATCH', product, { name: `History ${step.text}` }),
            'rename',
          )
        case 'shortDescription':
          return expectOk(
            run,
            await admin.send('PATCH', product, { shortDescription: step.text }),
            'shortDescription',
          )
        case 'categories':
          return expectOk(
            run,
            await admin.send('PATCH', product, {
              categoryIds: step.categories.map((i) => categoryIds[i]!),
            }),
            'categories',
          )
        case 'publish':
        case 'unpublish':
        case 'archive':
          return expectOk(run, await admin.send('POST', `${product}/${step.kind}`), step.kind)
        case 'adjust': {
          const variants = run.product['variants'] as Array<{ stock: number }>
          const stock = variants[0]!.stock
          const delta = stock + step.delta < 0 ? 1 : step.delta
          return expectOk(
            run,
            await admin.send('POST', `/api/admin/inventory/${run.seeded.variantId}/adjust`, {
              delta,
              reason: 'manual',
            }),
            'adjust',
          )
        }
        case 'reserve':
          return place(run, true)
        case 'placePaid':
          return place(run, false)
        case 'markPaid':
          return orderCommand(
            run,
            step,
            (id) => statusOf(run, id) === 'pending',
            (o) => admin.send('POST', orderPath(o.id, 'mark-paid'), {}),
          )
        case 'release': {
          const order = target(run, step.pick, (id) => statusOf(run, id) === 'pending')
          if (order === undefined) return place(run, true)
          const found = await k.store.read((tx) => k.repos.order.findById(tx, order.id))
          const ids = (found?.metadata as { reservationIds?: string[] } | undefined)?.reservationIds
          for (const rid of ids ?? []) {
            try {
              await k.services.inventory.releaseReservation(rid, 'expired')
            } catch {
              // Already released or committed: nothing moved.
              run.refused.push('release')
            }
          }
          return
        }
        case 'confirm':
          return orderCommand(
            run,
            step,
            (id) => statusOf(run, id) === 'pending',
            (o) => admin.send('POST', orderPath(o.id, 'confirm'), {}),
          )
        case 'process':
          return orderCommand(
            run,
            step,
            (id) => statusOf(run, id) === 'confirmed',
            (o) => admin.send('POST', orderPath(o.id, 'process'), {}),
          )
        case 'ship':
          return orderCommand(
            run,
            step,
            (id) => statusOf(run, id) === 'processing',
            (o) =>
              admin.send('POST', orderPath(o.id, 'ship'), {
                trackingNumber: `TRK-${step.text}`,
                carrier: 'Royal Mail',
              }),
          )
        case 'deliver':
          return orderCommand(
            run,
            step,
            (id) => statusOf(run, id) === 'shipped',
            (o) => admin.send('POST', orderPath(o.id, 'mark-delivered'), {}),
          )
        case 'cancel':
          return orderCommand(
            run,
            step,
            (id) => ['pending', 'confirmed', 'processing'].includes(statusOf(run, id)),
            (o) => admin.send('POST', orderPath(o.id, 'cancel'), {}),
          )
        case 'refundFull':
        case 'refundPartial': {
          const remaining = (id: string) =>
            paymentOf(run, id).capturedMinor - paymentOf(run, id).refundedMinor
          return orderCommand(
            run,
            step,
            (id) => remaining(id) > 0,
            (o) => {
              const left = Math.max(1, remaining(o.id))
              const amountMinor = step.kind === 'refundPartial' && left >= 2 ? 1 : left
              return admin.send('POST', orderPath(o.id, 'refund'), {
                amountMinor,
                reason: 'AC-1',
              })
            },
          )
        }
        case 'lateCapture': {
          // The shopper's payment lands after the cancel: the kernel records the capture and refunds it in full.
          const order = target(
            run,
            step.pick,
            (id) => statusOf(run, id) === 'cancelled' && paymentOf(run, id).capturedMinor === 0,
          )
          if (order === undefined) return place(run, true)
          const answer = await deliverCapture(served.baseUrl, order.started)
          if (answer.status >= 500) throw new Error(`lateCapture: ${JSON.stringify(answer)}`)
          if (answer.status >= 400) run.refused.push('lateCapture')
          return
        }
        case 'profile':
          return expectOk(
            run,
            await run.customer.send('PATCH', '/api/customers/me', {
              firstName: step.text,
              lastName: `${step.text}son`,
              phone: `+44${String(step.pick).padStart(9, '7')}`,
            }),
            'profile',
          )
        case 'addAddress':
          return expectOk(
            run,
            await run.customer.send('POST', '/api/customers/me/addresses', {
              ...address,
              addressLine1: `${step.text} Street`,
              isDefaultBilling: step.pick % 2 === 0,
              isDefaultShipping: step.pick % 3 === 0,
            }),
            'addAddress',
          )
        case 'deleteAddress': {
          const addresses = (run.customerRead['customer'] as Json)['addresses'] as Array<{
            id: string
          }>
          if (addresses.length < 2) return apply(run, { ...step, kind: 'addAddress' })
          const doomed = addresses[step.pick % addresses.length]!
          return expectOk(
            run,
            await run.customer.send('DELETE', `/api/customers/me/addresses/${doomed.id}`),
            'deleteAddress',
          )
        }
      }
    }

    /** Every recorded `?at=t` answers 200 with the recorded view; then the kernel's to<Kind>AsOf agrees. */
    async function verify(run: Run): Promise<void> {
      for (const rec of run.records) {
        const res = await readAsOf(admin, rec.kind, rec.key, rec.t)
        const context = `${rec.kind} ${rec.key} at ${rec.t}, after ${rec.after}`
        expect(
          { status: res.status, record: res.body.data?.record },
          `${context}: ${JSON.stringify(res.body.error ?? null)}`,
        ).toEqual({ status: 200, record: rec.view })
        expect(new Date(res.body.data!.asOf).getTime(), context).toBe(new Date(rec.t).getTime())
      }
      const history = await import('../../../src/history/index.js')
      const toAsOf: Record<HistoryKind, (read: Json) => unknown> = {
        order: history.toOrderAsOf,
        product: history.toProductAsOf,
        customer: history.toCustomerAsOf,
      }
      for (const rec of run.records) {
        expect(asJson(toAsOf[rec.kind](rec.read)), `to${rec.kind}AsOf after ${rec.after}`).toEqual(
          rec.view,
        )
      }
    }

    async function walk(kinds: Step[]): Promise<Run> {
      const run = await begin()
      for (const step of kinds) {
        await apply(run, step)
        await record(run, step.kind)
      }
      return run
    }

    it('AC-1: every command kind in turn (create, edit, categories, publish, unpublish, archive, adjust, reserve, commit, release; place, every status move, ship, deliver, cancel, mark-paid, full and partial refund, a capture after the cancel; register, profile, add and delete an address): each recorded ?at=t equals the read taken at t', async () => {
      const run = await walk(
        WALK.map((kind, i) => ({
          kind,
          pick: 0,
          text: `Walk${i}`,
          delta: i % 2 === 0 ? 3 : -2,
          categories: i % 2 === 0 ? [1, 0] : [1],
        })),
      )
      expect(run.refused, 'the walk’s fixture: only the unpaid confirm is refused').toEqual([
        'confirm',
      ])
      expect(
        run.orders.map((o) => statusOf(run, o.id)),
        'the walk’s fixture: where its three orders end',
      ).toEqual(['refunded', 'cancelled', 'refunded'])
      const late = run.orders[1]!
      expect(
        paymentOf(run, late.id),
        'the walk’s fixture: the capture after the cancel is recorded and refunded in full',
      ).toMatchObject({
        capturedMinor: late.started.totalMinor,
        refundedMinor: late.started.totalMinor,
      })
      await verify(run)
    }, 180_000)

    it(`AC-1: property (${opts.runs} runs): for generated command sequences across a product, its orders and a customer, every recorded ?at=t equals the admin read taken at t`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(stepArb, { minLength: 1, maxLength: opts.maxSteps }),
          async (steps) => {
            await verify(await walk(steps))
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 600_000)
  })
}
