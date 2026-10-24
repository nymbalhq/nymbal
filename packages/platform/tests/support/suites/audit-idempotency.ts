import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_INVENTORY_CHANGED, type PaymentsAdapter } from '@nymbalhq/types'
import {
  adminSession,
  auditRows,
  IDEMPOTENCY_KEY,
  outcomesOf,
  rowsOf,
  type AdminSession,
  type Answer,
} from '../audit.js'
import { eventsAfter, payloadOf } from '../correlation.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { maxSeq } from '../outbox.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'

// AC-1 on either dialect: a kernel from `src/` served over HTTP, an admin of its own, and the committed rows read
// through a second connection. n identical keyed adjusts, one after another or all at once, apply once and the other
// n-1 replay the same answer. A keyed create replays its 201. A key reused with another body is refused with 409 and
// changes nothing. A refused command is never replayed. Without a key every request applies. A keyed refund over a
// provider capture commits its pending row before the provider moves money, and a same-key retry moves none.

const adjustPath = (variantId: string) => `/api/admin/inventory/${variantId}/adjust`

async function oneAfterAnother<T>(n: number, send: () => Promise<T>): Promise<T[]> {
  const answers: T[] = []
  for (let i = 0; i < n; i += 1) answers.push(await send())
  return answers
}

/** The answers that did not say they were replays. */
function appliedAnswers(answers: Answer[]): Answer[] {
  return answers.filter((a) => a.replayed !== 'true')
}

export function idempotencySuite(
  dialect: string,
  start: () => Promise<Kernel>,
  opts: { runs: number },
): void {
  describe(`AC-1: a retried admin write applies once (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminSession

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminSession(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    const adjust = (variantId: string, delta: number, key?: string) =>
      admin.send(
        'POST',
        adjustPath(variantId),
        { delta, reason: 'manual' },
        key === undefined ? {} : { [IDEMPOTENCY_KEY]: key },
      )

    it(`AC-1: property (${opts.runs} runs): n = 2-5 identical keyed POST …/adjust, sequential or concurrent, move stock once, append one stock_adjustments row, one inventory.changed, one applied and n-1 replayed entries, and every answer equals the applied one`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.constantFrom('sequential', 'concurrent'),
          fc.integer({ min: -40, max: 40 }).filter((d) => d !== 0),
          async (n, mode, delta) => {
            const seeded = await seedVariant(k, 100)
            const key = `ac1.${randomUUID()}`
            const before = await maxSeq(raw)
            const send = () => adjust(seeded.variantId, delta, key)

            const answers =
              mode === 'concurrent'
                ? await Promise.all(Array.from({ length: n }, send))
                : await oneAfterAnother(n, send)
            const context = `${mode}, n=${n}, delta=${delta}: ${JSON.stringify(answers.map((a) => [a.status, a.replayed, a.body]))}`

            const applied = appliedAnswers(answers)
            expect(applied.length, `answers without Idempotent-Replayed: true (${context})`).toBe(1)
            expect(applied[0]!.status, context).toBe(200)
            for (const answer of answers) {
              expect(answer.status, context).toBe(applied[0]!.status)
              expect(answer.body, context).toEqual(applied[0]!.body)
            }
            expect(await stockOf(raw, seeded.variantId), context).toBe(seeded.initialStock + delta)
            expect(
              await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId]),
              context,
            ).toBe(applied.length)
            const changed = (await eventsAfter(raw, before)).filter(
              (row) =>
                row.type === EVT_INVENTORY_CHANGED &&
                payloadOf(row)['variantId'] === seeded.variantId,
            )
            expect(changed.length, `inventory.changed for the variant (${context})`).toBe(
              applied.length,
            )
            expect(outcomesOf(await auditRows(raw, 'idempotency_key = ?', [key])), context).toEqual(
              ['applied', ...Array.from({ length: n - 1 }, () => 'replayed')],
            )
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 180_000)

    it('AC-1: a keyed product create, sent twice, answers 201 both times with the same body; the second says Idempotent-Replayed and one product exists', async () => {
      const tag = randomUUID()
      const slug = `audit-${tag}`
      const body = {
        slug,
        name: 'Audited Widget',
        description: '',
        status: 'active',
        variants: [
          {
            sku: `P304-${tag}`,
            name: 'Default',
            priceMinor: 1500,
            stock: 5,
            lowStockThreshold: 0,
            options: [],
          },
        ],
      }
      const key = `ac1.create.${tag}`

      const first = await admin.send('POST', '/api/admin/products', body, {
        [IDEMPOTENCY_KEY]: key,
      })
      const second = await admin.send('POST', '/api/admin/products', body, {
        [IDEMPOTENCY_KEY]: key,
      })

      expect(first.status, JSON.stringify(first.body)).toBe(201)
      expect(second.status, JSON.stringify(second.body)).toBe(first.status)
      expect(second.body).toEqual(first.body)
      expect([first.replayed, second.replayed]).toEqual([null, 'true'])
      expect(await raw.count('products', 'slug = ?', [slug])).toBe(1)
      expect(outcomesOf(await auditRows(raw, 'idempotency_key = ?', [key]))).toEqual([
        'applied',
        'replayed',
      ])
    })

    it('AC-1: a keyed refund over a provider capture commits its pending row before the provider is called, and the same-key retry sent while the provider answers calls it no more: one refund row, one applied and one replayed entry, equal answers', async () => {
      const seeded = await seedVariant(k, 3, { priceMinor: 4_000 })
      const order = await checkoutOf(k, seeded, 2, `ac1-refund-${randomUUID()}@audit.test`)
      expect(order.orderStatus).toBe('confirmed')
      const key = `ac1.refund.${randomUUID()}`
      const body = { amountMinor: 1_000 }
      const send = () =>
        admin.send('POST', `/api/admin/orders/${order.orderId}/refund`, body, {
          [IDEMPOTENCY_KEY]: key,
        })
      const pendingAtProvider: number[] = []
      const retries: Answer[] = []
      const payments: PaymentsAdapter = k.app.adapters.payments
      const providerRefund = payments.refund
      let calls = 0
      payments.refund = (async (...args: Parameters<PaymentsAdapter['refund']>) => {
        calls += 1
        const pending = await raw.count('order_refunds', "order_id = ? AND status = 'pending'", [
          order.orderId,
        ])
        pendingAtProvider.push(pending)
        // A retry sent while a transaction holds the refund would wait on it for ever: sent only once the row committed.
        if (calls === 1 && pending === 1) retries.push(await send())
        return providerRefund.apply(payments, args)
      }) as PaymentsAdapter['refund']

      let first: Answer
      try {
        first = await send()
      } finally {
        payments.refund = providerRefund
      }
      const answers = [first, ...retries]
      const context = JSON.stringify(answers.map((a) => [a.status, a.replayed, a.body]))

      expect(
        pendingAtProvider,
        `committed pending rows seen at each provider call (${context})`,
      ).toEqual([1])
      expect(retries.length, context).toBe(1)
      expect(
        answers.map((a) => a.status),
        context,
      ).toEqual([200, 200])
      expect(appliedAnswers(answers).length, context).toBe(1)
      expect(answers[1]!.body, context).toEqual(answers[0]!.body)
      expect(await raw.count('order_refunds', 'order_id = ?', [order.orderId])).toBe(1)
      expect(outcomesOf(await auditRows(raw, 'idempotency_key = ?', [key]))).toEqual([
        'applied',
        'replayed',
      ])
    })

    it('AC-1: the same key with another delta, or on another variant, answers 409 idempotency.key_reused and changes nothing', async () => {
      const seeded = await seedVariant(k, 100)
      const other = await seedVariant(k, 100)
      const key = `ac1.reused.${randomUUID()}`

      const first = await adjust(seeded.variantId, 5, key)
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const stockAfterFirst = await stockOf(raw, seeded.variantId)
      const adjustmentsAfterFirst = await raw.count('stock_adjustments', 'variant_id = ?', [
        seeded.variantId,
      ])

      const otherDelta = await adjust(seeded.variantId, 7, key)
      const otherVariant = await adjust(other.variantId, 5, key)

      expect(
        [otherDelta, otherVariant].map((a) => [a.status, a.body.error?.code]),
        JSON.stringify([otherDelta.body, otherVariant.body]),
      ).toEqual([
        [409, 'idempotency.key_reused'],
        [409, 'idempotency.key_reused'],
      ])
      expect(stockAfterFirst).toBe(seeded.initialStock + 5)
      expect(await stockOf(raw, seeded.variantId)).toBe(stockAfterFirst)
      expect(await stockOf(raw, other.variantId)).toBe(other.initialStock)
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])).toBe(
        adjustmentsAfterFirst,
      )
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [other.variantId])).toBe(0)
      expect(outcomesOf(await auditRows(raw, 'idempotency_key = ?', [key]))).toEqual([
        'applied',
        'refused',
        'refused',
      ])
    })

    it('AC-1: a keyed command its service refused is not replayed: the retry executes again and applies once the stock allows it', async () => {
      const seeded = await seedVariant(k, 10)
      const key = `ac1.refused.${randomUUID()}`

      const refused = await adjust(seeded.variantId, -15, key)
      expect(refused.status, JSON.stringify(refused.body)).toBe(400)
      const restock = await adjust(seeded.variantId, 20)
      expect(restock.status, JSON.stringify(restock.body)).toBe(200)
      const retried = await adjust(seeded.variantId, -15, key)

      expect(retried.status, JSON.stringify(retried.body)).toBe(200)
      expect(retried.replayed === 'true', 'the retry was answered as a replay').toBe(false)
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock + 20 - 15)
      expect(outcomesOf(await auditRows(raw, 'idempotency_key = ?', [key]))).toEqual([
        'applied',
        'refused',
      ])
    })

    it('AC-1: without a key two identical requests apply twice, as today, and each leaves an applied entry with no key', async () => {
      const seeded = await seedVariant(k, 100)
      const delta = 3

      const answers = [await adjust(seeded.variantId, delta), await adjust(seeded.variantId, delta)]

      expect(answers.map((a) => a.status)).toEqual([200, 200])
      expect(answers.map((a) => a.replayed)).toEqual([null, null])
      expect(await stockOf(raw, seeded.variantId)).toBe(seeded.initialStock + 2 * delta)
      expect(await raw.count('stock_adjustments', 'variant_id = ?', [seeded.variantId])).toBe(
        answers.length,
      )
      const rows = [
        ...(await rowsOf(raw, answers[0]!.correlationId)),
        ...(await rowsOf(raw, answers[1]!.correlationId)),
      ]
      expect(rows.map((r) => [r.outcome, r.idempotencyKey])).toEqual(
        answers.map(() => ['applied', null]),
      )
    })
  })
}
