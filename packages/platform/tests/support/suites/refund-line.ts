import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PaymentsAdapter, ProposalView, Refund } from '@nymbalhq/types'
import { adminSession } from '../audit-http.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, createKernel, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { adminAccount, contentOf, toolSurface } from '../mcp.js'
import {
  adminClient,
  adminOrder,
  storedMoney,
  storedRefunds,
  sumOf,
  type AdminClient,
  type AdminOrder,
  type RefundCall,
} from '../money.js'
import { answerListWith, listed, reconcileOrder } from '../provider-refunds.js'
import { openRaw, type RawReader } from '../raw.js'

// A refund may name the order line it is for. The line is a label: it is stored with the refund, read back by the
// admin, refused when the order never held it, and never changes what money moves. A kernel from `src/` served over
// HTTP, the admin's refund route and the agent tool over it, the stub payments adapter (wrapped to record each call),
// and the committed rows read through a second connection.

type RefundImpl = (...args: unknown[]) => Promise<Refund>

/** A refund as the admin reads it, with the line it names. */
interface RefundView {
  id: string
  amountMinor: number
  status: string
  variantId: string | null
  productId: string | null
}

interface RefundAnswer {
  order: AdminOrder
  payment: NonNullable<AdminOrder['payment']>
  refund: RefundView
}

interface RefundBody {
  amountMinor: number
  variantId?: string
  requestId?: string
}

const DESCRIPTION =
  'The variant of the order line this refund is for. Leave it out for a refund not tied to one product, such as shipping.'

export function refundLineSuite(
  dialect: Kernel['dialect'],
  /** A fresh, empty database: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`a refund names its order line (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient
    let payments: PaymentsAdapter
    let stubRefund: RefundImpl
    let calls: RefundCall[] = []

    beforeAll(async () => {
      db = await fresh()
      k = await createKernel(
        dialect === 'sqlite'
          ? { dialect, sqlitePath: db.target }
          : { dialect, postgresUrl: db.target },
      )
      served = await serveKernel(k)
      raw = openRaw(dialect, db.target)
      admin = await adminClient(k, served.baseUrl)
      payments = k.app.adapters.payments
      stubRefund = payments.refund.bind(payments) as RefundImpl
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
      await db?.drop()
    })

    /** The provider's refund, every call recorded. */
    function provider(): void {
      calls = []
      payments.refund = (async (...args: unknown[]) => {
        calls.push(args as RefundCall)
        return stubRefund(...args)
      }) as PaymentsAdapter['refund']
    }

    function restoreProvider(): void {
      payments.refund = stubRefund as PaymentsAdapter['refund']
    }

    /** A checkout the stub pays inline: a confirmed order of one unit of each of two products. */
    async function twoLineOrder(prices: [number, number] = [3_000, 2_000]) {
      const lines: Seeded[] = []
      for (const priceMinor of prices) lines.push(await seedVariant(k, 3, { priceMinor }))
      const cart = await k.services.cart.getOrCreate()
      for (const line of lines) {
        await k.services.cart.addItem(cart.token, {
          variantId: line.variantId,
          productId: line.productId,
          productName: 'Transactional Widget',
          variantName: 'Default',
          priceMinor: line.priceMinor,
          imageUrl: '',
          qty: 1,
        })
      }
      const started = await k.services.checkout.beginCheckout({
        cartToken: cart.token,
        email: `refund-line-${randomUUID()}@money.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      expect(started.orderStatus).toBe('confirmed')
      return {
        orderId: started.orderId,
        orderNumber: started.orderNumber,
        intentId: started.paymentIntent.id,
        totalMinor: started.totalMinor,
        lines: lines as [Seeded, Seeded],
      }
    }

    function refund(orderId: string, body: RefundBody) {
      return admin.call<RefundAnswer>('POST', `/api/admin/orders/${orderId}/refund`, body)
    }

    /** The line columns of one committed refund row. */
    async function storedLine(refundId: string) {
      const row = await raw.one<{ variant_id: string | null; product_id: string | null }>(
        'SELECT variant_id, product_id FROM order_refunds WHERE id = ?',
        [refundId],
      )
      return { variantId: row.variant_id, productId: row.product_id }
    }

    const lineOf = (line: Seeded | null) =>
      line === null
        ? { variantId: null, productId: null }
        : { variantId: line.variantId, productId: line.productId }

    // Kills: the line dropped between the route, the row and the admin read, and a refund nobody labelled (one sent
    // without a line, one the provider reports) given one.
    it(`AC-1: a refund sent with the second line's variantId stores that variantId and the line's productId and the admin read answers both; one sent without a line and one the provider reconcile records answer both as null (${dialect})`, async () => {
      const order = await twoLineOrder()
      const [, second] = order.lines
      const named = await refund(order.orderId, { amountMinor: 500, variantId: second.variantId })
      const plain = await refund(order.orderId, { amountMinor: 300 })
      expect(named.status, JSON.stringify(named.body)).toBe(200)
      expect(plain.status, JSON.stringify(plain.body)).toBe(200)

      const providerList = payments.listRefunds.bind(payments)
      const listing = answerListWith(payments, async (paymentId) => [
        ...(await providerList(paymentId)),
        listed(paymentId, { refundId: `re_dashboard_${randomUUID()}`, amountMinor: 200 }),
      ])
      try {
        expect(await reconcileOrder(k, order.orderId)).toMatchObject({ recorded: 1 })
      } finally {
        listing.restore()
      }

      const namedId = named.body.data!.refund.id
      const plainId = plain.body.data!.refund.id
      const refunds = (await adminOrder(admin, order.orderNumber)).payment!
        .refunds as unknown as RefundView[]
      const lines = (r: RefundView | undefined) => ({
        variantId: r?.variantId,
        productId: r?.productId,
      })
      const recorded = refunds.filter((r) => r.id !== namedId && r.id !== plainId)
      expect(recorded.map((r) => r.amountMinor)).toEqual([200])
      expect(lines(refunds.find((r) => r.id === namedId))).toEqual(lineOf(second))
      expect(lines(refunds.find((r) => r.id === plainId))).toEqual(lineOf(null))
      expect(lines(recorded[0])).toEqual(lineOf(null))
      expect(await storedLine(namedId)).toEqual(lineOf(second))
      expect(await storedLine(plainId)).toEqual(lineOf(null))
      expect(await storedLine(recorded[0]!.id)).toEqual(lineOf(null))
    })

    // Kills: a refund labelled with a product the order never held, and money moved on a refused request.
    it(`AC-2: a variantId that is not on the order is refused 409 refund.line_unknown naming the order, with no refund row, no request to the provider, and captured, refunded and refundable as they were (${dialect})`, async () => {
      const order = await twoLineOrder()
      const elsewhere = await seedVariant(k, 1)
      const before = (await adminOrder(admin, order.orderNumber)).payment!

      provider()
      let answer: Awaited<ReturnType<typeof refund>>
      try {
        answer = await refund(order.orderId, { amountMinor: 500, variantId: elsewhere.variantId })
      } finally {
        restoreProvider()
      }

      expect(answer.status, JSON.stringify(answer.body)).toBe(409)
      expect(answer.body.error?.code).toBe('refund.line_unknown')
      expect(answer.body.error?.message).toBe(
        `Order ${order.orderNumber} has no line for that variant`,
      )
      expect(calls).toEqual([])
      expect(await raw.count('order_refunds', 'order_id = ?', [order.orderId])).toBe(0)
      const after = (await adminOrder(admin, order.orderNumber)).payment!
      expect([after.capturedMinor, after.refundedMinor, after.refundableMinor]).toEqual([
        before.capturedMinor,
        before.refundedMinor,
        before.refundableMinor,
      ])
    })

    // Kills: the line capping, splitting or otherwise changing an amount, the refundable remainder, the payment state
    // or what the provider is asked for; and labels that never reach the row, which would make the comparison empty.
    it(`AC-3: property, money: any sequence of accepted refunds, each naming one of the order's lines or none, leaves refundedMinor, refundableMinor, the payment state and the provider's refunded total equal to the same sequence sent with no variantId on a twin order; Σ refunds = refundedMinor ≤ capturedMinor (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.tuple(fc.integer({ min: 2, max: 9_000 }), fc.integer({ min: 2, max: 9_000 })),
          fc.array(
            fc.record({
              line: fc.option(fc.integer({ min: 0, max: 1 }), { nil: null }),
              pct: fc.integer({ min: 1, max: 60 }),
            }),
            { minLength: 1, maxLength: 5 },
          ),
          async (prices, steps) => {
            const labelled = await twoLineOrder(prices)
            const twin = await twoLineOrder(prices)
            const named: Array<{ id: string; line: Seeded | null }> = []
            let refundable = labelled.totalMinor

            provider()
            try {
              for (const { line, pct } of steps) {
                if (refundable === 0) break
                const amountMinor = Math.max(1, Math.floor((refundable * pct) / 100))
                const chosen = line === null ? null : labelled.lines[line]!
                const a = await refund(labelled.orderId, {
                  amountMinor,
                  ...(chosen !== null && { variantId: chosen.variantId }),
                })
                const b = await refund(twin.orderId, { amountMinor })
                expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200])
                named.push({ id: a.body.data!.refund.id, line: chosen })
                refundable = a.body.data!.payment.refundableMinor
              }
            } finally {
              restoreProvider()
            }

            const [readA, readB] = [
              (await adminOrder(admin, labelled.orderNumber)).payment!,
              (await adminOrder(admin, twin.orderNumber)).payment!,
            ]
            const askedFor = (intentId: string) =>
              calls.filter((c) => c[0] === intentId).reduce((sum, c) => sum + (c[1] ?? 0), 0)
            expect([readA.refundedMinor, readA.refundableMinor, readA.state]).toEqual([
              readB.refundedMinor,
              readB.refundableMinor,
              readB.state,
            ])
            expect(askedFor(labelled.intentId)).toBe(askedFor(twin.intentId))
            const rows = await storedRefunds(raw, labelled.orderId)
            const stored = await storedMoney(raw, labelled.orderId)
            expect(sumOf(rows, 'succeeded')).toBe(stored.refundedMinor)
            expect(stored.refundedMinor).toBeLessThanOrEqual(stored.capturedMinor)
            for (const { id, line } of named) expect(await storedLine(id)).toEqual(lineOf(line))
          },
        ),
        { numRuns: 6 },
      )
    }, 180_000)

    // Kills: a retry relabelling a settled refund, or a repeat with another line read as a new refund.
    it(`AC-4: a repeat of a requestId with the same amount and the other line's variantId answers the first refund with its first line, leaves one row and moves no money (${dialect})`, async () => {
      const order = await twoLineOrder()
      const [first, second] = order.lines
      const requestId = randomUUID()

      provider()
      let a: Awaited<ReturnType<typeof refund>>
      let b: Awaited<ReturnType<typeof refund>>
      let afterFirst: Awaited<ReturnType<typeof storedMoney>>
      try {
        a = await refund(order.orderId, { amountMinor: 700, variantId: first.variantId, requestId })
        afterFirst = await storedMoney(raw, order.orderId)
        b = await refund(order.orderId, {
          amountMinor: 700,
          variantId: second.variantId,
          requestId,
        })
      } finally {
        restoreProvider()
      }

      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200])
      const firstRefund = a.body.data!.refund
      const repeat = b.body.data!.refund
      expect(repeat.id).toBe(firstRefund.id)
      expect({ variantId: repeat.variantId, productId: repeat.productId }).toEqual(lineOf(first))
      expect(await storedLine(firstRefund.id)).toEqual(lineOf(first))
      const rows = await storedRefunds(raw, order.orderId)
      const stored = await storedMoney(raw, order.orderId)
      expect(rows.map((r) => r.id)).toEqual([firstRefund.id])
      expect(calls).toHaveLength(rows.length)
      expect(stored.refundedMinor).toBe(afterFirst.refundedMinor)
      expect(stored.refundedMinor).toBe(sumOf(rows, 'succeeded'))
    })

    // Kills: the tool hiding the argument (the assistant cannot name a line) or the proposal path dropping it between
    // the agent's call and the approved command.
    it(`AC-5: admin_orders_refund lists variantId as an optional, described argument, and a refund proposed with it over MCP and approved stores the line (${dialect})`, async () => {
      const tools = toolSurface(k.app)
      const proposer = await adminAccount(k, served.baseUrl)
      const approver = await adminSession(k, served.baseUrl)
      const listed = await Promise.resolve(tools.list(proposer.caller))
      const schema = listed.find((t) => t.name === 'admin_orders_refund')?.inputSchema as
        | {
            properties?: Record<string, { type?: unknown; description?: unknown }>
            required?: string[]
          }
        | undefined
      const required = schema?.required ?? []

      expect(schema?.properties?.['variantId']).toMatchObject({
        type: 'string',
        description: DESCRIPTION,
      })
      expect(required).toContain('amountMinor')
      expect(required).not.toContain('variantId')

      const order = await twoLineOrder()
      const [, second] = order.lines
      const proposed = await tools.call(
        'admin_orders_refund',
        { id: order.orderId, amountMinor: 400, variantId: second.variantId },
        proposer.caller,
      )
      const id = contentOf(proposed).structured['id'] as string
      const approved = await approver.send<ProposalView>(
        'POST',
        `/api/admin/proposals/${encodeURIComponent(id)}/approve`,
      )

      expect(approved.status, JSON.stringify(approved.body)).toBe(200)
      expect(approved.body.data?.status).toBe('applied')
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => r.amountMinor)).toEqual([400])
      expect(await storedLine(rows[0]!.id)).toEqual(lineOf(second))
    })
  })
}
