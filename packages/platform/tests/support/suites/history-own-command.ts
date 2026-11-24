import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  adminSession,
  auditRows,
  CORRELATION,
  IDEMPOTENCY_KEY,
  type AdminSession,
  type AuditRow,
} from '../audit.js'
import { readHistory, type HistoryEntry, type HistoryKind } from '../history.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, type Dialect, type Kernel } from '../kernel.js'
import { openRaw, writeRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'

// A record's history names, for each entry, the actor and command of the command that emitted its event, read from
// the event log's `command_id` and the `audit_entries` row with that id, on one dialect through the served kernel. A
// payment recorded after checkout (by an admin, or by the provider's webhook in a request of its own) shares the
// checkout's correlation id, so a rule that reads the correlation's first `applied` row names the guest's checkout
// instead. Rows with no `command_id` keep that correlation rule.

export interface HistoryOwnCommandOptions {
  /** A kernel on a database of its own. */
  open(): Promise<Kernel>
  propertyRuns: number
}

interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  paymentIntent: { id: string }
  totalMinor: number
  currency: string
  orderStatus: string
}

interface EventRow {
  seq: number
  type: string
  commandId: string | null
  subjectType: string | null
  subjectId: string | null
  correlationId: string
}

function correlationOf(res: { headers: Headers }): string {
  const id = res.headers.get(CORRELATION)
  if (id === null) throw new Error('the response carried no x-correlation-id')
  return id
}

function typeOf(entry: { type: string }): string {
  return entry.type.split('.v')[0]!
}

function attributionOf(row: AuditRow | undefined) {
  return row === undefined
    ? { actor: null, command: null }
    : { actor: { kind: row.actorKind, id: row.actorId }, command: row.command }
}

export function historyOwnCommandSuite(dialect: Dialect, options: HistoryOwnCommandOptions): void {
  describe(`history names each event’s own command and actor (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminSession

    beforeAll(async () => {
      k = await options.open()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminSession(k, served.baseUrl)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    function keyed(on: boolean): Record<string, string> {
      return on ? { [IDEMPOTENCY_KEY]: `history-${randomUUID()}` } : {}
    }

    /** A product made by the admin over HTTP, with its creation's correlation id. */
    async function newProduct(stock = 50, priceMinor = 5000) {
      const tag = randomUUID().slice(0, 8)
      const res = await admin.send<{ id: string; variants: Array<{ id: string }> }>(
        'POST',
        '/api/admin/products',
        {
          slug: `own-command-${tag}`,
          name: `Own command ${tag}`,
          description: '',
          status: 'active',
          variants: [{ sku: `OWN-${tag}`, name: 'Default', priceMinor, stock, options: [] }],
        },
      )
      if (res.status !== 201) throw new Error(`create product: ${JSON.stringify(res.body)}`)
      return {
        productId: res.body.data!.id,
        variantId: res.body.data!.variants[0]!.id,
        correlationId: correlationOf(res),
      }
    }

    /** A guest's checkout of one unit over HTTP; a `+stub-pending` email leaves the order pending. */
    async function guestCheckout(variantId: string, email: string) {
      const guest = await primedShopper(served.baseUrl)
      const added = await guest.call('POST', '/api/cart/items', { variantId, qty: 1 })
      if (added.status !== 200) throw new Error(`add to cart: ${JSON.stringify(added.body)}`)
      const res = await guest.call<CheckoutAnswer>('POST', '/api/checkout', {
        email,
        billingAddress: address,
        shippingAddress: address,
      })
      if (res.status !== 200) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`)
      return { ...res.body.data!, correlationId: correlationOf(res) }
    }

    async function pendingOrder() {
      const product = await newProduct()
      const order = await guestCheckout(
        product.variantId,
        `guest-${randomUUID()}+stub-pending@history.test`,
      )
      expect(order.orderStatus, 'the stub leaves a +stub-pending order pending').toBe('pending')
      return order
    }

    async function entriesOf(kind: HistoryKind, id: string): Promise<HistoryEntry[]> {
      const res = await readHistory(admin, kind, id, { limit: 200 })
      if (res.status !== 200) {
        throw new Error(`GET ${kind} history: ${res.status} ${JSON.stringify(res.body)}`)
      }
      return res.body.data!.entries
    }

    /** The `applied` audit rows of a correlation, earliest first. */
    function appliedOf(correlationId: string): Promise<AuditRow[]> {
      return auditRows(raw, "correlation_id = ? AND outcome = 'applied'", [correlationId])
    }

    /** The event log's rows for these subjects, oldest first, with the command each was appended under. */
    async function eventRows(subjects: Array<{ type: string; id: string }>): Promise<EventRow[]> {
      const where = subjects.map(() => '(subject_type = ? AND subject_id = ?)').join(' OR ')
      const rows = await raw.rows<{
        seq: number | string
        type: string
        command_id: string | null
        subject_type: string | null
        subject_id: string | null
        correlation_id: string
      }>(
        `SELECT seq, type, command_id, subject_type, subject_id, correlation_id FROM events WHERE ${where} ORDER BY seq`,
        subjects.flatMap((s) => [s.type, s.id]),
      )
      return rows.map((r) => ({
        seq: Number(r.seq),
        type: r.type,
        commandId: r.command_id,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        correlationId: r.correlation_id,
      }))
    }

    /** The entries a command added to a record's history: those absent from the earlier read. */
    function added(before: HistoryEntry[], after: HistoryEntry[]): HistoryEntry[] {
      const seen = new Set(before.map((e) => e.seq))
      return after.filter((e) => !seen.has(e.seq))
    }

    it('AC-1: a payment an admin records on a guest’s pending order is listed under that admin and order.markPaid, the checkout under the guest and checkout.place, all in the checkout’s correlation', async () => {
      const order = await pendingOrder()
      const before = await entriesOf('order', order.orderId)

      const paid = await admin.send('POST', `/api/admin/orders/${order.orderId}/mark-paid`, {})
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)

      const after = await entriesOf('order', order.orderId)
      const payment = added(before, after)
      expect(payment.map(typeOf), 'the payment’s entries').toEqual(
        expect.arrayContaining(['payment.captured', 'order.paid']),
      )
      expect(
        payment.map((e) => [typeOf(e), e.actor, e.command, e.correlationId]),
        'each payment entry under the admin’s mark-paid, in the checkout’s correlation',
      ).toEqual(
        payment.map((e) => [
          typeOf(e),
          { kind: 'admin', id: admin.userId },
          'order.markPaid',
          order.correlationId,
        ]),
      )

      const [placed] = await appliedOf(order.correlationId)
      expect([placed?.actorKind, placed?.command]).toEqual(['guest', 'checkout.place'])
      const base = after.find((e) => e.base)
      expect([base?.actor, base?.command, base?.correlationId], 'the base entry').toEqual([
        { kind: 'guest', id: placed!.actorId },
        'checkout.place',
        order.correlationId,
      ])
    })

    it('AC-2: a payment a provider’s webhook delivers in a request of its own is listed under the system and that delivery’s own command, not checkout.place', async () => {
      const order = await pendingOrder()
      const before = await entriesOf('order', order.orderId)

      const res = await fetch(new URL('/api/webhooks/stripe', served.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'unverified-by-stub' },
        body: JSON.stringify({
          id: `evt_${randomUUID()}`,
          kind: 'payment.captured',
          paymentIntentId: order.paymentIntent.id,
          amountMinor: order.totalMinor,
          currency: order.currency,
        }),
      })
      expect(res.status, await res.clone().text()).toBe(200)
      const delivery = await appliedOf(correlationOf(res))
      expect(
        delivery.map((row) => [row.actorKind, row.command]),
        'the delivery’s own applied entry',
      ).toEqual([['system', 'payment.finalize']])

      const after = await entriesOf('order', order.orderId)
      const payment = added(before, after)
      expect(payment.map(typeOf), 'the payment’s entries').toEqual(
        expect.arrayContaining(['payment.captured', 'order.paid']),
      )
      expect(
        payment.map((e) => [typeOf(e), e.actor, e.command]),
        'each payment entry under the delivery',
      ).toEqual(payment.map((e) => [typeOf(e), ...Object.values(attributionOf(delivery[0]))]))
      expect(
        payment.filter((e) => e.command === 'checkout.place').map(typeOf),
        'payment entries named after the checkout',
      ).toEqual([])
    })

    it('AC-4: an event row with no command_id keeps the earliest applied entry of its correlation, and one whose correlation has none reads no actor and no command', async () => {
      const product = await newProduct()
      const tag = randomUUID().slice(0, 8)
      const first = await admin.send('PATCH', `/api/admin/products/${product.productId}`, {
        name: `First ${tag}`,
      })
      expect(first.status, JSON.stringify(first.body)).toBe(200)
      const second = await admin.send('PATCH', `/api/admin/products/${product.productId}`, {
        name: `Second ${tag}`,
      })
      expect(second.status, JSON.stringify(second.body)).toBe(200)

      /** Appends a copy of the correlation's update row as a row written before the column: `command_id` null. */
      async function legacyCopy(of: string, correlationId: string): Promise<void> {
        const row = await raw.one<{
          type: string
          envelope: string | Record<string, unknown>
          subject_type: string
          subject_id: string
        }>(
          "SELECT type, envelope, subject_type, subject_id FROM events WHERE correlation_id = ? AND subject_type = 'product' AND subject_id = ? ORDER BY seq",
          [of, product.productId],
        )
        const envelope = typeof row.envelope === 'string' ? JSON.parse(row.envelope) : row.envelope
        const id = randomUUID()
        const at = new Date().toISOString()
        await writeRaw(
          k.dialect,
          k.target,
          `INSERT INTO events (id, type, envelope, correlation_id, subject_type, subject_id, created_at, delivered_at, command_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            id,
            row.type,
            JSON.stringify({ ...envelope, id, correlationId }),
            correlationId,
            row.subject_type,
            row.subject_id,
            at,
            at,
          ],
        )
      }

      const firstCorrelation = correlationOf(first)
      const orphanCorrelation = randomUUID()
      // Back to the first name in the first edit's correlation, then forward again in one no command ran under.
      await legacyCopy(firstCorrelation, firstCorrelation)
      await legacyCopy(correlationOf(second), orphanCorrelation)

      const entries = await entriesOf('product', product.productId)
      const [orphan, legacy] = entries
      expect(
        [orphan?.correlationId, legacy?.correlationId],
        'the two legacy rows are the newest entries',
      ).toEqual([orphanCorrelation, firstCorrelation])
      const [earliest] = await appliedOf(firstCorrelation)
      expect([earliest?.actorKind, earliest?.command]).toEqual(['admin', 'product.update'])
      expect({ actor: legacy!.actor, command: legacy!.command }, 'the legacy row').toEqual(
        attributionOf(earliest),
      )
      expect({ actor: orphan!.actor, command: orphan!.command }, 'the orphan row').toEqual({
        actor: null,
        command: null,
      })
    })

    it('AC-5: a keyed mark-paid lists the payment under that admin and order.markPaid, and the same key again adds no event and no applied entry', async () => {
      const order = await pendingOrder()
      const before = await entriesOf('order', order.orderId)
      const key = keyed(true)
      const appliedFor = async () =>
        (await auditRows(raw, "outcome = 'applied'")).filter((row) =>
          row.subjects.some((s) => s.type === 'order' && s.id === order.orderId),
        ).length
      const eventsFor = () =>
        raw.count('events', "subject_type = 'order' AND subject_id = ?", [order.orderId])

      const paid = await admin.send('POST', `/api/admin/orders/${order.orderId}/mark-paid`, {}, key)
      expect(paid.status, JSON.stringify(paid.body)).toBe(200)

      const after = await entriesOf('order', order.orderId)
      const payment = added(before, after)
      expect(payment.map(typeOf), 'the payment’s entries').toEqual(
        expect.arrayContaining(['payment.captured', 'order.paid']),
      )
      expect(
        payment.map((e) => [typeOf(e), e.actor, e.command]),
        'each payment entry under the admin’s keyed mark-paid',
      ).toEqual(
        payment.map((e) => [typeOf(e), { kind: 'admin', id: admin.userId }, 'order.markPaid']),
      )

      const counts = { events: await eventsFor(), applied: await appliedFor() }
      const again = await admin.send(
        'POST',
        `/api/admin/orders/${order.orderId}/mark-paid`,
        {},
        key,
      )
      expect(again.status, JSON.stringify(again.body)).toBe(paid.status)
      expect({ events: await eventsFor(), applied: await appliedFor() }, 'after the retry').toEqual(
        counts,
      )
    })

    type Step =
      | { op: 'edit'; keyed: boolean; n: number }
      | { op: 'adjust'; keyed: boolean; delta: number }
      | { op: 'process'; keyed: boolean }
      | { op: 'refund'; keyed: boolean; amountMinor: number }
      | { op: 'profile'; n: number }
      | { op: 'checkout' }

    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({ op: fc.constant('edit' as const), keyed: fc.boolean(), n: fc.nat({ max: 999 }) }),
      fc.record({
        op: fc.constant('adjust' as const),
        keyed: fc.boolean(),
        delta: fc.integer({ min: 1, max: 5 }),
      }),
      fc.record({ op: fc.constant('process' as const), keyed: fc.boolean() }),
      fc.record({
        op: fc.constant('refund' as const),
        keyed: fc.boolean(),
        amountMinor: fc.integer({ min: 1, max: 400 }),
      }),
      fc.record({ op: fc.constant('profile' as const), n: fc.nat({ max: 999 }) }),
      fc.record({ op: fc.constant('checkout' as const) }),
    )

    it('AC-3: over any sequence of commands by different actors on one product, order and customer, every event appended in a command carries that command’s id, which names an applied audit entry about the event’s subject whose actor and command its history entry shows', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 6 }), async (steps) => {
          /** Every request this run made: each one's events were appended inside its command. */
          const ours = new Set<string>()
          const track = <T extends { status: number; headers: Headers; body: unknown }>(
            what: string,
            res: T,
            status = 200,
          ): T => {
            if (res.status !== status) {
              throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`)
            }
            ours.add(correlationOf(res))
            return res
          }

          const product = await newProduct()
          ours.add(product.correlationId)
          const order = await guestCheckout(product.variantId, `paid-${randomUUID()}@history.test`)
          ours.add(order.correlationId)
          expect(order.orderStatus, 'the stub pays a plain email inline').toBe('confirmed')

          const shop = await primedShopper(served.baseUrl)
          const registered = track(
            'register',
            await shop.call<{ customer: { id: string }; accessToken: string }>(
              'POST',
              '/api/auth/register',
              { email: `own-${randomUUID()}@history.test`, password: 'history-correct-horse' },
            ),
            201,
          )
          const customerId = registered.body.data!.customer.id
          const bearer = { authorization: `Bearer ${registered.body.data!.accessToken}` }

          let processed = false
          let refundableMinor = order.totalMinor
          for (const s of steps) {
            switch (s.op) {
              case 'edit':
                track(
                  'edit',
                  await admin.send(
                    'PATCH',
                    `/api/admin/products/${product.productId}`,
                    { name: `Edited ${s.n} ${randomUUID().slice(0, 4)}` },
                    keyed(s.keyed),
                  ),
                )
                break
              case 'adjust':
                track(
                  'adjust',
                  await admin.send(
                    'POST',
                    `/api/admin/inventory/${product.variantId}/adjust`,
                    { delta: s.delta, reason: 'manual' },
                    keyed(s.keyed),
                  ),
                )
                break
              case 'process':
                if (processed || refundableMinor !== order.totalMinor) break
                track(
                  'process',
                  await admin.send(
                    'POST',
                    `/api/admin/orders/${order.orderId}/process`,
                    {},
                    keyed(s.keyed),
                  ),
                )
                processed = true
                break
              case 'refund':
                if (s.amountMinor >= refundableMinor) break
                track(
                  'refund',
                  await admin.send(
                    'POST',
                    `/api/admin/orders/${order.orderId}/refund`,
                    { amountMinor: s.amountMinor, reason: 'history' },
                    keyed(s.keyed),
                  ),
                )
                refundableMinor -= s.amountMinor
                break
              case 'profile':
                track(
                  'profile',
                  await shop.call(
                    'PATCH',
                    '/api/customers/me',
                    { firstName: `Grace${s.n}` },
                    { headers: bearer },
                  ),
                )
                break
              case 'checkout':
                ours.add(
                  (await guestCheckout(product.variantId, `again-${randomUUID()}@history.test`))
                    .correlationId,
                )
                break
            }
          }

          const records: Array<{
            kind: HistoryKind
            id: string
            subjects: Array<{ type: string; id: string }>
          }> = [
            {
              kind: 'product',
              id: product.productId,
              subjects: [
                { type: 'product', id: product.productId },
                { type: 'variant', id: product.variantId },
              ],
            },
            { kind: 'order', id: order.orderId, subjects: [{ type: 'order', id: order.orderId }] },
            { kind: 'customer', id: customerId, subjects: [{ type: 'customer', id: customerId }] },
          ]
          for (const record of records) {
            const rows = await eventRows(record.subjects)
            const inCommands = rows.filter((r) => ours.has(r.correlationId))
            expect(
              inCommands.length,
              `${record.kind}: rows this run's commands appended`,
            ).toBeGreaterThan(0)
            expect(
              inCommands.filter((r) => r.commandId === null).map((r) => `${r.seq} ${r.type}`),
              `${record.kind}: rows appended in a command with no command_id`,
            ).toEqual([])

            const commands = new Map<string, AuditRow | undefined>()
            for (const row of rows) {
              if (row.commandId === null) continue
              const found = await auditRows(raw, 'id = ?', [row.commandId])
              expect(
                found.map((a) => a.outcome),
                `${record.kind} row ${row.seq} (${row.type}): the audit entry its command_id names`,
              ).toEqual(['applied'])
              expect(
                found[0]!.subjects,
                `${record.kind} row ${row.seq} (${row.type}): the entry is about the row's subject`,
              ).toContainEqual({ type: row.subjectType, id: row.subjectId })
              commands.set(row.commandId, found[0])
            }

            const bySeq = new Map(rows.map((r) => [r.seq, r]))
            const entries = await entriesOf(record.kind, record.id)
            expect(
              entries.map((e) => e.seq).filter((seq) => !bySeq.has(seq)),
              `${record.kind}: entries with no row among the record's subjects`,
            ).toEqual([])
            for (const entry of entries) {
              const row = bySeq.get(entry.seq)!
              if (row.commandId === null) continue
              expect(
                { actor: entry.actor, command: entry.command },
                `${record.kind} entry ${entry.seq} (${entry.type})`,
              ).toEqual(attributionOf(commands.get(row.commandId)))
            }
          }
        }),
        { numRuns: options.propertyRuns },
      )
    }, 300_000)
  })
}
