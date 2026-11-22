import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_ORDER_PAID, type TaxQuote, type TransactionalEmail } from '@nymbalhq/types'
import { createLogger } from '../../src/logger.js'
import { startTaxDocumentSweeper } from '../../src/sweepers/index.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import {
  adminClient,
  storedMoney,
  storedRefunds,
  type AdminClient,
  type AdminOrder,
} from '../support/money.js'
import { eventRows } from '../support/outbox.js'
import { openRaw, writeRaw, type RawReader } from '../support/raw.js'
import {
  RATES,
  scriptedDocumentId,
  scriptedTax,
  withTax,
  type ScriptedTax,
} from '../support/tax.js'
import { deliverCapture } from '../support/webhooks.js'
import { unaudited } from '../support/write-audit.js'

// Filing with the store's tax provider through the kernel on SQLite: a scripted `custom` provider that declares commit
// and refund, orders paid by a provider capture (the payment webhook, `finalize`) and by the admin, refunds through the
// admin route, the relay delivering `order.paid` and the refund events to the filing handler, and the sweep retrying
// what is owed. Records and events are read through a second connection; the provider records every call.

const FILING = 'filing-tax'

interface Logged {
  lines: string[]
  logger: Kernel['logger']
}

function capturing(): Logged {
  const lines: string[] = []
  const logger = createLogger({
    pretty: false,
    level: 'warn',
    destination: { write: (line: string) => void lines.push(line) },
  })
  return { lines, logger }
}

/** Lines logged at warn (pino level 40) since `from` that carry every one of `words`. */
const warningsNaming = (logged: Logged, from: number, words: string[]): string[] =>
  logged.lines
    .slice(from)
    .filter(
      (line) =>
        (JSON.parse(line) as { level: number }).level === 40 &&
        words.every((word) => line.includes(word)),
    )

interface DocRow {
  order_id: string
  provider: string
  status: string
  document_id: string | null
  refunded_minor: number
  filed_refund_ids: string[]
  attempts: number
  last_error: string | null
  due_since: unknown
}

async function docRows(raw: RawReader, orderId: string): Promise<DocRow[]> {
  const rows = await raw.rows<Omit<DocRow, 'filed_refund_ids'> & { filed_refund_ids: string }>(
    'SELECT * FROM order_tax_documents WHERE order_id = ?',
    [orderId],
  )
  return rows.map((row) => ({
    ...row,
    refunded_minor: Number(row.refunded_minor),
    attempts: Number(row.attempts),
    filed_refund_ids: JSON.parse(row.filed_refund_ids) as string[],
  }))
}

/** A record's failure fields: what a recorded outage leaves. */
const failureOf = (row: DocRow) => ({ attempts: row.attempts, lastError: row.last_error })

const commitsFor = (tax: ScriptedTax, orderId: string) =>
  tax.commits.filter((c) => c.ref.orderId === orderId)

const refundsFor = (tax: ScriptedTax, orderId: string) =>
  tax.refunds.filter((c) => c.doc.documentId === scriptedDocumentId(orderId))

/** One sweep of what is owed, at once (no minimum age), with a sweeper of the test's own. */
async function sweep(k: Kernel, providerName: string): Promise<void> {
  const sweeper = startTaxDocumentSweeper({
    store: k.store,
    repo: k.repos.orderTaxDocument,
    documents: k.services.taxDocuments,
    providerName,
    logger: k.logger,
    intervalMs: 3_600_000,
    minAgeMs: 0,
  })
  try {
    await sweeper.tick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await sweeper.tick()
  } finally {
    sweeper.stop()
  }
}

/** A `+stub-pending` checkout: a pending order quoted by the store's engine, its intent set, nothing captured. */
async function pendingOrder(k: Kernel) {
  const seeded = await seedVariant(k, 4, { priceMinor: 2_500 })
  return checkoutOf(k, seeded, 2, `buyer-${randomUUID()}+stub-pending@tax-documents.test`)
}

const metadataTax = async (k: Kernel, orderId: string) =>
  (await k.store.read((tx) => k.repos.order.findById(tx, orderId)))!.metadata['tax'] as
    | (TaxQuote & { fallback?: boolean })
    | undefined

describe('filing through the kernel (sqlite)', () => {
  let tax: ScriptedTax
  let logged: Logged
  let k: Kernel
  let served: ServedKernel
  let raw: RawReader
  let admin: AdminClient
  const sent: TransactionalEmail[] = []

  beforeAll(async () => {
    tax = scriptedTax({
      providerName: FILING,
      capabilities: ['quote', 'inclusive', 'commit', 'refund'],
    })
    logged = capturing()
    k = await createKernel({
      dialect: 'sqlite',
      configure: withTax({
        provider: 'custom',
        pricesIncludeTax: true,
        onUnavailable: 'native',
        rates: RATES,
      }),
      appOptions: { adapters: { tax: tax.adapter } },
      logger: logged.logger,
    })
    served = await serveKernel(k)
    raw = openRaw(k.dialect, k.target)
    admin = await adminClient(k, served.baseUrl)
    const email = k.app.adapters.email
    const send = email.sendTransactional.bind(email)
    email.sendTransactional = async (message) => {
      sent.push(message)
      return send(message)
    }
  }, 60_000)

  afterAll(async () => {
    tax?.recover()
    tax?.failFiling(null)
    await raw?.close()
    await served?.stop()
  })

  function markPaid(orderId: string) {
    return admin.call<AdminOrder>('POST', `/api/admin/orders/${orderId}/mark-paid`, {})
  }

  function refund(orderId: string, amountMinor: number) {
    return admin.call<{ refund: { id: string } }>('POST', `/api/admin/orders/${orderId}/refund`, {
      amountMinor,
    })
  }

  describe('AC-7: a paid order and its refunds are filed once each', () => {
    // Kills: a paid order never filed (no subscription to order.paid, or one path of payment missed), or filed with a
    // quote or reference other than the order's.
    it('AC-7: an order paid by a provider capture and one marked paid by the admin each have one committed record with the provider’s document, and commit got the order’s quote and reference', async () => {
      const captured = await pendingOrder(k)
      const marked = await pendingOrder(k)

      const answer = await deliverCapture(served.baseUrl, captured)
      const paid = await markPaid(marked.orderId)
      await k.app.relay.drain()

      expect([answer.status, answer.data?.['finalized']]).toEqual([200, true])
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)
      for (const order of [captured, marked]) {
        const rows = await docRows(raw, order.orderId)
        expect(rows.map((r) => [r.status, r.provider, r.document_id])).toEqual([
          ['committed', FILING, scriptedDocumentId(order.orderId)],
        ])
        const commits = commitsFor(tax, order.orderId)
        expect(commits).toHaveLength(1)
        expect(commits[0]!.quote).toEqual(await metadataTax(k, order.orderId))
        expect(commits[0]!.ref).toEqual({
          orderId: order.orderId,
          orderNumber: order.orderNumber,
          currency: order.currency,
        })
      }
    })

    // Kills: no subscription to the order refund events, a refund filed twice, or with another amount or currency.
    it('AC-7: a partial then a full refund through the admin route each reach refund once with the refund’s id, amount and currency, under the order’s document', async () => {
      const order = await pendingOrder(k)
      expect((await deliverCapture(served.baseUrl, order)).status).toBe(200)
      await k.app.relay.drain()
      const part = 1_000

      const partial = await refund(order.orderId, part)
      await k.app.relay.drain()
      const afterPartial = refundsFor(tax, order.orderId).length
      const full = await refund(order.orderId, order.totalMinor - part)
      await k.app.relay.drain()

      expect([partial.status, full.status]).toEqual([200, 200])
      const rows = await storedRefunds(raw, order.orderId)
      expect(rows.map((r) => r.status)).toEqual(['succeeded', 'succeeded'])
      expect(afterPartial).toBe(1)
      expect(refundsFor(tax, order.orderId)).toEqual(
        rows.map((r) => ({
          doc: { provider: FILING, documentId: scriptedDocumentId(order.orderId) },
          refund: { refundId: r.id, amountMinor: r.amountMinor, currency: r.currency },
        })),
      )
      const [doc] = await docRows(raw, order.orderId)
      expect(doc!.filed_refund_ids).toEqual(rows.map((r) => r.id))
      expect(doc!.refunded_minor).toBe((await storedMoney(raw, order.orderId)).refundedMinor)
    })

    // Kills: a filing keyed per delivery rather than per order, so a redelivered order.paid files the order again.
    it('AC-7: order.paid delivered again for a filed order makes no second commit', async () => {
      const order = await pendingOrder(k)
      expect((await markPaid(order.orderId)).status).toBe(200)
      await k.app.relay.drain()
      const before = commitsFor(tax, order.orderId).length

      await unaudited(() =>
        k.publisher.publish(EVT_ORDER_PAID, {
          orderId: order.orderId,
          paymentIntentId: order.paymentIntent.id,
          amountMinor: order.totalMinor,
          currency: order.currency,
        }),
      )
      await k.app.relay.drain()

      expect(before).toBe(1)
      expect(commitsFor(tax, order.orderId)).toHaveLength(before)
      expect((await docRows(raw, order.orderId)).map((r) => r.status)).toEqual(['committed'])
    })
  })

  describe('AC-8: filing never holds up an order', () => {
    // Kills: filing inside the command (a derived subscription, or file awaited from confirm): the answer then waits
    // for the provider, or comes only once the bound has abandoned it with a failure recorded.
    it.each(['mark-paid', 'finalize'] as const)(
      'AC-8: %s answers confirmed while commit is held, with no failure recorded; released and drained, the order is committed',
      async (path) => {
        const order = await pendingOrder(k)
        const held = tax.holdNextCommit()

        const answered =
          path === 'mark-paid'
            ? await markPaid(order.orderId).then((r) => ({
                status: r.status,
                state: r.body.data?.status,
              }))
            : await deliverCapture(served.baseUrl, order).then((r) => ({
                status: r.status,
                state: r.data?.['finalized'] === true ? 'confirmed' : 'not confirmed',
              }))
        const atAnswer = await docRows(raw, order.orderId)
        await vi.waitFor(() => expect(held.isEntered()).toBe(true), {
          timeout: 10_000,
          interval: 10,
        })
        const whileHeld = await docRows(raw, order.orderId)
        held.release()
        await k.app.relay.drain()

        expect(answered).toEqual({ status: 200, state: 'confirmed' })
        expect((await storedMoney(raw, order.orderId)).status).toBe('confirmed')
        expect(
          atAnswer.map(failureOf).filter((f) => f.attempts !== 0 || f.lastError !== null),
        ).toEqual([])
        expect(
          whileHeld.map(failureOf).filter((f) => f.attempts !== 0 || f.lastError !== null),
        ).toEqual([])
        expect((await docRows(raw, order.orderId)).map((r) => [r.status, r.document_id])).toEqual([
          ['committed', scriptedDocumentId(order.orderId)],
        ])
      },
    )

    // Kills: a provider outage thrown into the relay (order.paid retried for every subscription, mail included, then
    // dead), an order cancelled or failed by it, or an outage never retried.
    it('AC-8: with a commit that throws, the order is confirmed, order.paid is delivered with no failure, the confirmation is mailed, the record holds one failure, and a sweep with the provider back commits it', async () => {
      const order = await pendingOrder(k)
      tax.failFiling('throws')
      try {
        expect((await markPaid(order.orderId)).status).toBe(200)
        await k.app.relay.drain()
      } finally {
        tax.failFiling(null)
      }

      const paidEvents = (await eventRows(raw, 'type = ?', ['order.paid.v1'])).filter(
        (r) => (r.envelope.payload as { orderId: string }).orderId === order.orderId,
      )
      expect((await storedMoney(raw, order.orderId)).status).toBe('confirmed')
      expect(
        paidEvents.map((r) => ({
          delivered: r.deliveredAt != null,
          attempts: r.attempts,
          dead: r.deadAt != null,
        })),
      ).toEqual([{ delivered: true, attempts: 0, dead: false }])
      expect(
        sent
          .filter((m) => m.template === 'order-placed' && m.to === order.email)
          .map((m) => m.vars['orderNumber']),
      ).toEqual([order.orderNumber])
      const [owed] = await docRows(raw, order.orderId)
      expect({ status: owed!.status, ...failureOf(owed!) }).toEqual({
        status: 'pending',
        attempts: 1,
        lastError: 'scripted tax filing unreachable',
      })

      await sweep(k, FILING)

      const [filed] = await docRows(raw, order.orderId)
      expect({ status: filed!.status, ...failureOf(filed!), due: filed!.due_since }).toEqual({
        status: 'committed',
        attempts: 0,
        lastError: null,
        due: null,
      })
      expect(commitsFor(tax, order.orderId)).toHaveLength(2)
    })
  })

  describe('AC-9: what the kernel never files', () => {
    // Kills: an order quoted by the native table (the provider was down at checkout) filed with the provider.
    it('AC-9: an order quoted by the native fallback, paid with the provider back, has no record and no call after the relay and a sweep', async () => {
      tax.fail('throws')
      const order = await pendingOrder(k).finally(() => tax.recover())
      expect((await metadataTax(k, order.orderId))?.fallback).toBe(true)

      expect((await markPaid(order.orderId)).status).toBe(200)
      await k.app.relay.drain()
      await sweep(k, FILING)

      expect(await docRows(raw, order.orderId)).toEqual([])
      expect([
        commitsFor(tax, order.orderId).length,
        refundsFor(tax, order.orderId).length,
      ]).toEqual([0, 0])
    })

    // Kills: an order another provider quoted filed with this one.
    it('AC-9: an order whose quote names another provider has no record and no call, and one warning names both providers and the order number', async () => {
      const order = await pendingOrder(k)
      await k.app.relay.drain()
      await writeRaw(
        k.dialect,
        k.target,
        "UPDATE orders SET metadata = json_set(metadata, '$.tax.provider', 'old-tax') WHERE id = ?",
        [order.orderId],
      )
      const from = logged.lines.length

      expect((await markPaid(order.orderId)).status).toBe(200)
      await k.app.relay.drain()
      await sweep(k, FILING)

      expect(await docRows(raw, order.orderId)).toEqual([])
      expect(commitsFor(tax, order.orderId)).toEqual([])
      expect(warningsNaming(logged, from, ['old-tax', FILING, order.orderNumber])).toHaveLength(1)
    })

    // Kills: the money of a cancelled order filed, from its refunded capture.
    it('AC-9: an order cancelled and then captured, its capture refunded, has no record and no call', async () => {
      const order = await pendingOrder(k)
      await k.services.checkout.cancel(order.orderId, 'shopper changed their mind')

      const answer = await deliverCapture(served.baseUrl, order)
      await k.app.relay.drain()
      await sweep(k, FILING)

      expect(answer.data?.['reason']).toBe('order_cancelled_refunded')
      const money = await storedMoney(raw, order.orderId)
      expect([money.status, money.capturedMinor]).toEqual(['cancelled', order.totalMinor])
      expect(await docRows(raw, order.orderId)).toEqual([])
      expect([
        commitsFor(tax, order.orderId).length,
        refundsFor(tax, order.orderId).length,
      ]).toEqual([0, 0])
    })
  })
})

describe('AC-9: stores whose provider files nothing (sqlite)', () => {
  // Kills: the native engine's quote treated as a provider's, so the kernel makes records nothing ever files.
  it('AC-9: on the native engine a paid order has no record after the relay and a sweep', async () => {
    const k = await createKernel({
      dialect: 'sqlite',
      configure: withTax({ rates: RATES, pricesIncludeTax: true }),
    })
    const raw = openRaw(k.dialect, k.target)
    try {
      const order = await pendingOrder(k)
      expect((await metadataTax(k, order.orderId))?.provider).toBe('native')

      await k.services.checkout.markPaid(order.orderId, 'admin:test')
      await k.app.relay.drain()
      await sweep(k, 'native')

      expect((await storedMoney(raw, order.orderId)).status).toBe('confirmed')
      expect(await raw.count('order_tax_documents')).toBe(0)
    } finally {
      await raw.close()
      await k.close()
    }
  })

  // Kills: an adapter declaring commit without the method subscribed anyway (every order.paid failing), or booting
  // silently so the merchant never learns their provider files nothing.
  it('AC-9: an adapter that declares commit without the method warns once at boot naming it, and a paid order has no record', async () => {
    const methodless = scriptedTax({
      providerName: 'methodless-tax',
      capabilities: ['quote', 'inclusive', 'commit', 'refund'],
      filingMethods: false,
    })
    const logged = capturing()
    const k = await createKernel({
      dialect: 'sqlite',
      configure: withTax({ provider: 'custom', pricesIncludeTax: true }),
      appOptions: { adapters: { tax: methodless.adapter } },
      logger: logged.logger,
    })
    const raw = openRaw(k.dialect, k.target)
    try {
      const atBoot = warningsNaming(logged, 0, ['methodless-tax'])
      const order = await pendingOrder(k)

      await k.services.checkout.markPaid(order.orderId, 'admin:test')
      await k.app.relay.drain()

      expect(atBoot).toHaveLength(1)
      expect(atBoot[0]).toMatch(/commit/)
      expect((await storedMoney(raw, order.orderId)).status).toBe('confirmed')
      expect(await raw.count('order_tax_documents')).toBe(0)
      expect(warningsNaming(logged, 0, ['methodless-tax'])).toHaveLength(atBoot.length)
    } finally {
      await raw.close()
      await k.close()
    }
  })
})
