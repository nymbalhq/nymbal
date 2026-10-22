import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import {
  EVT_ORDER_PARTIALLY_REFUNDED,
  EVT_ORDER_REFUNDED,
  EVT_PAYMENT_REFUNDED,
  NotFoundError,
  OrderConflictError,
  PaymentError,
  StatusTransitionError,
  ValidationError,
  type Address,
  type CaptureMethod,
  type OrderStatus,
  type Refund,
  type RefundOptions,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createNativeStubPaymentsAdapter } from '../adapters/payments/native-stub.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'
import { formatMoney } from '../money.js'
import { createOrderService } from './order-service.js'
import { createRefundService, settlementOf, PROVIDER_REFUND_REASON } from './refund-service.js'

// Unit tests for P1-13 (spec P1-13-admin-truth-about-money) decision 4, "a refund moves money": the hold under the
// lock (requestId reuse, not_captured, exceeds_captured), the provider call (key = row id, outcome mapping, manual and
// import captures move nothing) and the settlement (only on a matching answer, Σ recomputed, a status that no longer
// allows the move kept). The integration suites pin the same through the route; Stryker sees only these.

const addr: Address = {
  firstName: 'Jane',
  lastName: 'Doe',
  addressLine1: '1 Test St',
  city: 'London',
  region: 'England',
  postalCode: 'SW1A 1AA',
  country: 'GB',
}

interface RefundCall {
  paymentId: string
  amountMinor: number | undefined
  reason: string | undefined
  opts: RefundOptions | undefined
}

/** The provider echoes the refund it was asked for unless `answer` says otherwise. */
type Answer = (call: RefundCall) => Promise<Refund>
const echo: Answer = async (call) => ({
  refundId: `re_${uuidv7()}`,
  paymentId: call.paymentId,
  amountMinor: call.amountMinor ?? 0,
  currency: call.opts?.currency ?? 'GBP',
  reason: call.reason ?? null,
  status: 'succeeded',
})

async function setup(answer: Answer = echo) {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'silent' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  ).publisher
  const orders = createOrderService({
    store,
    repos,
    publisher,
    logger,
    orderNumberPrefix: 'TEST',
    orderNumberStart: 1000,
  })
  const calls: RefundCall[] = []
  const script = { answer }
  const payments = {
    ...createNativeStubPaymentsAdapter({ logger }),
    async refund(paymentId: string, amountMinor?: number, reason?: string, opts?: RefundOptions) {
      const call = { paymentId, amountMinor, reason, opts }
      calls.push(call)
      return script.answer(call)
    },
  }
  const refunds = createRefundService({ store, repos, publisher, logger, payments })
  return { store, repos, orders, refunds, calls, script }
}
type Env = Awaited<ReturnType<typeof setup>>

/** A captured order as the services leave one: the whole total captured by `method`. */
async function paidOrder(
  env: Env,
  opts: {
    totalMinor?: number
    capturedMinor?: number
    method?: CaptureMethod | null
    status?: OrderStatus
    intent?: string | null
    customerId?: string | null
  } = {},
) {
  const totalMinor = opts.totalMinor ?? 10_000
  const method = opts.method === undefined ? 'provider' : opts.method
  const capturedMinor = opts.capturedMinor ?? (method === null ? 0 : totalMinor)
  const intent =
    opts.intent === undefined ? (method === 'provider' ? `pi_${uuidv7()}` : null) : opts.intent
  return env.orders.importOrder({
    orderId: uuidv7(),
    orderNumber: `R-${uuidv7().slice(-12)}`,
    status: opts.status ?? 'confirmed',
    customerId: opts.customerId ?? null,
    email: 'r@example.com',
    billingAddress: addr,
    shippingAddress: addr,
    lineItems: [],
    subtotalMinor: totalMinor,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor,
    currency: 'GBP',
    createdAt: new Date(),
    capturedMinor,
    ...(method !== null && { captureMethod: method }),
    ...(intent !== null && { paymentIntentId: intent }),
  })
}

const orderOf = async (env: Env, id: string) =>
  (await env.store.read((tx) => env.repos.order.findById(tx, id)))!
const rowsOf = (env: Env, id: string) =>
  env.store.read((tx) => env.repos.orderRefund.listByOrder(tx, id))
const historyOf = (env: Env, id: string) =>
  env.store.read((tx) => env.repos.orderHistory.listByOrder(tx, id))
async function events(env: Env, type: string, orderId: string) {
  const all = await env.store.read((tx) => env.repos.eventLog.listAll(tx))
  return all
    .map((l) => l.event)
    .filter((e) => e.type === type)
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => p.orderId === orderId)
}
const refusal = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e)

describe('settlementOf: a provider answer settles a row only for its amount and currency', () => {
  // Defect: the amount or currency comparison is dropped or made case-sensitive, so a provider that refunded another
  // amount settles the row as succeeded; or a failed answer is read as a mismatch and left pending.
  it('decision 4 step 3: succeeded or pending only on a matching answer, failed always failed, mismatch otherwise pending', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.constantFrom('GBP', 'gbp', 'EUR', 'eur'),
        fc.constantFrom('GBP', 'gbp', 'EUR'),
        fc.constantFrom<Refund['status']>('succeeded', 'pending', 'failed'),
        (rowAmount, answerAmount, rowCurrency, answerCurrency, status) => {
          const s = settlementOf(
            {
              refundId: 're_x',
              paymentId: 'pi_x',
              amountMinor: answerAmount,
              currency: answerCurrency,
              reason: null,
              status,
            },
            { amountMinor: rowAmount, currency: rowCurrency },
          )
          const matches =
            rowAmount === answerAmount && rowCurrency.toUpperCase() === answerCurrency.toUpperCase()
          expect(s.providerRefundId).toBe('re_x')
          const expected =
            status === 'failed'
              ? { status: 'failed', mismatch: false }
              : matches
                ? { status, mismatch: false }
                : { status: 'pending', mismatch: true }
          expect(s).toEqual({ ...expected, providerRefundId: 're_x' })
        },
      ),
      { examples: [[5, 5, 'gbp', 'GBP', 'succeeded']] },
    )
  })
})

describe('RefundService: P1-13 decision 4', () => {
  // Defect: the amount guard accepts zero, a negative or a fraction, and a refund of nothing reaches the provider.
  it('AC-3: an amount that is not a positive whole number is a ValidationError, with no row and no provider call', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.integer({ min: -1000, max: 0 }),
          fc.double({ min: 0.01, max: 100, noNaN: true }).filter((n) => !Number.isInteger(n)),
        ),
        async (amountMinor) => {
          const err = await refusal(
            env.refunds.refund({ orderId: order.id, amountMinor, actor: 'a' }),
          )
          expect(err).toBeInstanceOf(ValidationError)
        },
      ),
      { numRuns: 30, examples: [[0], [-1], [0.5]] },
    )
    expect(await rowsOf(env, order.id)).toHaveLength(0)
    expect(env.calls).toHaveLength(0)
    expect(
      (await env.refunds.refund({ orderId: order.id, amountMinor: 1, actor: 'a' })).refund.status,
    ).toBe('succeeded')
    await env.store.close()
  })

  // Defect: the lock's missing row falls through to a TypeError instead of a 404.
  it('AC-3: a refund of an unknown order is NotFoundError and moves nothing', async () => {
    const env = await setup()
    await expect(
      env.refunds.refund({ orderId: uuidv7(), amountMinor: 100, actor: 'a' }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(env.calls).toHaveLength(0)
    await env.store.close()
  })

  // Defect: the provider is called without the intent, the amount, the provider reason, the row id as key or the
  // order's currency; or the Σ, the status move, the events or the customer's spend are not kept with the refund.
  it('AC-4: a provider refund calls the adapter once per refund with the row id as key, and the order keeps Σ, status, history and spend', async () => {
    const env = await setup()
    const customerId = uuidv7()
    const now = new Date()
    await env.store.transaction((tx) =>
      env.repos.customer.insert(tx, {
        id: customerId,
        email: 'c@example.com',
        passwordHash: 'x',
        createdAt: now,
        updatedAt: now,
      }),
    )
    await env.store.transaction((tx) =>
      env.repos.customer.incrementStats(tx, customerId, 1, 10_000, now),
    )
    const order = await paidOrder(env, { totalMinor: 10_000, customerId })
    const spent = async () =>
      (await env.store.read((tx) => env.repos.customer.findById(tx, customerId)))!.totalSpentMinor

    const amounts = [3000, 1500, 5500]
    const results = []
    for (const [i, amountMinor] of amounts.entries()) {
      results.push(
        await env.refunds.refund({
          orderId: order.id,
          amountMinor,
          actor: `admin:${i}`,
          ...(i === 0 && { reason: 'damaged' }),
        }),
      )
    }

    expect(env.calls).toEqual(
      results.map((r, i) => ({
        paymentId: order.paymentIntentId,
        amountMinor: amounts[i],
        reason: PROVIDER_REFUND_REASON,
        opts: { idempotencyKey: r.refund.id, currency: order.currency },
      })),
    )
    expect(new Set(results.map((r) => r.refund.id)).size).toBe(amounts.length)
    expect(results.map((r) => r.order.status)).toEqual([
      'partially_refunded',
      'partially_refunded',
      'refunded',
    ])
    expect(results.map((r) => r.order.refundedMinor)).toEqual([3000, 4500, 10_000])
    expect(results.map((r) => r.payment.refundableMinor)).toEqual([7000, 5500, 0])
    expect(results.at(-1)!.payment.state).toBe('refunded')
    for (const r of results) {
      expect(r.refund.status).toBe('succeeded')
      expect(r.refund.providerRefundId).toMatch(/^re_/)
      expect(r.refund.currency).toBe(order.currency)
    }
    expect(results[0]!.refund.reason).toBe('damaged')
    expect(results[1]!.refund.reason).toBeNull()

    const history = (await historyOf(env, order.id)).slice(-3)
    expect(history.map((h) => [h.fromStatus, h.toStatus, h.actor])).toEqual([
      ['confirmed', 'partially_refunded', 'admin:0'],
      ['partially_refunded', 'partially_refunded', 'admin:1'],
      ['partially_refunded', 'refunded', 'admin:2'],
    ])
    expect(history[0]!.note).toBe(`refund of ${formatMoney(3000, 'GBP')}: damaged`)
    expect(history[1]!.note).toBe(`refund of ${formatMoney(1500, 'GBP')}`)

    expect(await spent()).toBe(10_000 - amounts.reduce((a, b) => a + b, 0))
    const partial = await events(env, EVT_ORDER_PARTIALLY_REFUNDED, order.id)
    const full = await events(env, EVT_ORDER_REFUNDED, order.id)
    expect(partial.map((p) => p.refundId)).toEqual([results[0]!.refund.id, results[1]!.refund.id])
    expect(full).toEqual([
      {
        orderId: order.id,
        refundId: results[2]!.refund.id,
        amountMinor: 5500,
        currency: 'GBP',
        reason: '',
      },
    ])
    expect(partial[0]!.reason).toBe('damaged')
    const moved = await events(env, EVT_PAYMENT_REFUNDED, order.id)
    expect(moved.map((p) => [p.paymentId, p.refundId, p.amountMinor, p.currency])).toEqual(
      results.map((r, i) => [order.paymentIntentId, r.refund.id, amounts[i], 'GBP']),
    )
    await env.store.close()
  })

  // Defect (B3): a manual or imported capture is sent to the provider (which never took that money), or its refund
  // is not settled at once, or payment.refunded names an intent the provider never captured.
  it('AC-4 (B3): a manual or import capture refunds with no adapter call and settles succeeded at once', async () => {
    const env = await setup()
    for (const method of ['manual', 'import'] as const) {
      // An intent left on a manually paid order names no money the provider holds.
      const order = await paidOrder(env, { method, intent: 'pi_left_open' })
      const r = await env.refunds.refund({ orderId: order.id, amountMinor: 2500, actor: 'a' })
      expect(r.refund).toMatchObject({ status: 'succeeded', providerRefundId: null })
      expect(r.order.refundedMinor).toBe(2500)
      const [moved] = await events(env, EVT_PAYMENT_REFUNDED, order.id)
      expect(moved!.paymentId).toBe('')
    }
    expect(env.calls).toHaveLength(0)
    await env.store.close()
  })

  // Defect (B2): a definite refusal is left pending (blocking the rest forever) or counted as refunded, or an unknown
  // outcome is settled failed, so the shop refunds the same money twice.
  it('AC-4 (B2): refund_rejected settles failed and frees the amount; refund_unknown or any other fault stays pending and held', async () => {
    const env = await setup()
    const throws =
      (err: Error): Answer =>
      async () => {
        throw err
      }
    const cases = [
      { err: new PaymentError('refund_rejected', 'card closed'), status: 'failed' },
      { err: new PaymentError('refund_unknown', 'timeout'), status: 'pending' },
      { err: new PaymentError('capture_failed', 'odd'), status: 'pending' },
      { err: new Error('socket hang up'), status: 'pending' },
    ] as const
    for (const c of cases) {
      const order = await paidOrder(env, { totalMinor: 8000 })
      env.script.answer = throws(c.err)
      const r = await env.refunds.refund({ orderId: order.id, amountMinor: 3000, actor: 'a' })
      expect(r.refund.status).toBe(c.status)
      expect(r.refund.providerRefundId).toBeNull()
      expect(r.order.refundedMinor).toBe(0)
      expect(r.order.status).toBe('confirmed')
      expect(await events(env, EVT_PAYMENT_REFUNDED, order.id)).toHaveLength(0)
      const held = c.status === 'pending' ? 3000 : 0
      expect(r.payment.refundableMinor).toBe(order.capturedMinor - held)
      // The rest, and no more, can still be refunded.
      env.script.answer = echo
      const over = await refusal(
        env.refunds.refund({ orderId: order.id, amountMinor: 8000 - held + 1, actor: 'a' }),
      )
      expect(over).toMatchObject({
        code: 'refund.exceeds_captured',
        context: { amountMinor: 8000 - held + 1, refundableMinor: 8000 - held },
      })
      const rest = await env.refunds.refund({
        orderId: order.id,
        amountMinor: 8000 - held,
        actor: 'a',
      })
      expect(rest.order.refundedMinor).toBe(8000 - held)
    }
    await env.store.close()
  })

  // Defect: a provider answer for another amount or currency, or a provider `pending`, settles the row succeeded and
  // counts money the provider may not have moved; or a `failed` answer is left pending.
  it('AC-4: a provider pending, failed or mismatched answer never counts as refunded, and the provider id is kept', async () => {
    const env = await setup()
    const answers: Array<[string, (c: RefundCall) => Partial<Refund>, string]> = [
      ['pending', () => ({ status: 'pending' }), 'pending'],
      ['failed', () => ({ status: 'failed' }), 'failed'],
      ['another amount', (c) => ({ amountMinor: (c.amountMinor ?? 0) + 1 }), 'pending'],
      ['another currency', () => ({ currency: 'EUR' }), 'pending'],
      ['the same currency in lower case', () => ({ currency: 'gbp' }), 'succeeded'],
    ]
    for (const [, change, status] of answers) {
      const order = await paidOrder(env, { totalMinor: 5000 })
      env.script.answer = async (c) => ({ ...(await echo(c)), refundId: 're_kept', ...change(c) })
      const r = await env.refunds.refund({ orderId: order.id, amountMinor: 2000, actor: 'a' })
      expect(r.refund.status).toBe(status)
      expect(r.refund.providerRefundId).toBe('re_kept')
      expect(r.order.refundedMinor).toBe(status === 'succeeded' ? 2000 : 0)
      expect(r.payment.refundableMinor).toBe(order.capturedMinor - (status === 'failed' ? 0 : 2000))
    }
    await env.store.close()
  })

  // Defect: a repeated request (the double click) moves money twice, a reused key with another amount refunds anyway,
  // or the key is matched across orders so one order's request answers another's.
  it('store walk: a repeated requestId answers the first refund and moves no money; another amount is refund.request_reused', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 6000 })
    const requestId = uuidv7()
    const first = await env.refunds.refund({
      orderId: order.id,
      amountMinor: 1000,
      actor: 'a',
      requestId,
    })
    const again = await env.refunds.refund({
      orderId: order.id,
      amountMinor: 1000,
      actor: 'a',
      requestId,
    })
    expect(again.refund.id).toBe(first.refund.id)
    expect(again.order.refundedMinor).toBe(first.order.refundedMinor)
    expect(again.payment.refunds).toHaveLength(1)
    expect(env.calls).toHaveLength(1)

    const reused = await refusal(
      env.refunds.refund({ orderId: order.id, amountMinor: 1001, actor: 'a', requestId }),
    )
    expect(reused).toBeInstanceOf(OrderConflictError)
    expect(reused).toMatchObject({
      code: 'refund.request_reused',
      context: { amountMinor: 1001, earlierAmountMinor: 1000 },
    })
    expect(await rowsOf(env, order.id)).toHaveLength(1)
    expect(env.calls).toHaveLength(1)

    const other = await paidOrder(env, { totalMinor: 6000 })
    const elsewhere = await env.refunds.refund({
      orderId: other.id,
      amountMinor: 1000,
      actor: 'a',
      requestId,
    })
    expect(elsewhere.refund.id).not.toBe(first.refund.id)
    expect(env.calls).toHaveLength(2)
    await env.store.close()
  })

  // Defect: an order with nothing captured, or a provider capture with no intent to refund against, reaches the
  // provider (or a refund row is written for money nobody holds).
  it('AC-3: refund.not_captured on an uncaptured order and on a provider capture without an intent, with nothing written', async () => {
    const env = await setup()
    const unpaid = await paidOrder(env, { method: null, status: 'pending' })
    const noIntent = await paidOrder(env, { method: 'provider', intent: null })
    for (const order of [unpaid, noIntent]) {
      const err = await refusal(
        env.refunds.refund({ orderId: order.id, amountMinor: 1, actor: 'a' }),
      )
      expect(err).toBeInstanceOf(OrderConflictError)
      expect((err as OrderConflictError).code).toBe('refund.not_captured')
      expect(await rowsOf(env, order.id)).toHaveLength(0)
    }
    expect(env.calls).toHaveLength(0)
    await env.store.close()
  })

  // Defect: the status check is dropped, so an order whose status allows no refund (cancelled) gets one.
  it('decision 4 statuses: an order whose status cannot move to refunded refuses with StatusTransitionError and writes nothing', async () => {
    const env = await setup()
    const order = await paidOrder(env, { method: 'manual', status: 'cancelled' })
    const err = await refusal(env.refunds.refund({ orderId: order.id, amountMinor: 1, actor: 'a' }))
    expect(err).toBeInstanceOf(StatusTransitionError)
    expect(await rowsOf(env, order.id)).toHaveLength(0)
    await env.store.close()
  })

  // Defect (B1): step 3 throws on a status that no longer allows the move, leaving money moved and the row unsettled.
  it('AC-6 (B1): a status moved during the provider call is kept and logged, while the row and Σ are still written', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 4000 })
    env.script.answer = async (c) => {
      await env.store.transaction((tx) =>
        env.repos.order.setStatus(tx, order.id, 'cancelled', new Date()),
      )
      return echo(c)
    }
    const r = await env.refunds.refund({ orderId: order.id, amountMinor: 4000, actor: 'a' })
    expect(r.refund.status).toBe('succeeded')
    expect(r.order.status).toBe('cancelled')
    expect(r.order.refundedMinor).toBe(r.order.capturedMinor)
    const last = (await historyOf(env, order.id)).at(-1)!
    expect([last.fromStatus, last.toStatus]).toEqual(['cancelled', 'cancelled'])
    expect(await events(env, EVT_ORDER_REFUNDED, order.id)).toHaveLength(1)
    await env.store.close()
  })

  // Defect: refundable ignores pending rows or earlier refunds, Σ is taken from step 1's read or counts failed rows,
  // or the status disagrees with the amounts.
  it('AC-3: over any sequence of refunds, Σ succeeded = refundedMinor <= capturedMinor, and the status is refunded exactly when refunded = captured', async () => {
    const env = await setup()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5000 }),
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 3000 }),
            outcome: fc.constantFrom('ok', 'rejected', 'unknown'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (captured, steps) => {
          const order = await paidOrder(env, { totalMinor: captured })
          let refunded = 0
          let pending = 0
          for (const step of steps) {
            env.script.answer =
              step.outcome === 'ok'
                ? echo
                : async () => {
                    throw new PaymentError(
                      step.outcome === 'rejected' ? 'refund_rejected' : 'refund_unknown',
                      'no',
                    )
                  }
            const refundable = captured - refunded - pending
            const r = await refusal(
              env.refunds.refund({ orderId: order.id, amountMinor: step.amount, actor: 'a' }),
            )
            const over = step.amount > refundable
            expect((r as { code?: string } | null)?.code).toBe(
              over ? 'refund.exceeds_captured' : undefined,
            )
            if (over) continue
            if (step.outcome === 'ok') refunded += step.amount
            if (step.outcome === 'unknown') pending += step.amount
          }
          const after = await orderOf(env, order.id)
          const rows = await rowsOf(env, order.id)
          const sum = (s: string) =>
            rows.filter((x) => x.status === s).reduce((a, x) => a + x.amountMinor, 0)
          expect(after.refundedMinor).toBe(sum('succeeded'))
          expect(after.refundedMinor).toBe(refunded)
          expect(sum('pending')).toBe(pending)
          expect(after.refundedMinor).toBeLessThanOrEqual(after.capturedMinor)
          expect(after.status === 'refunded').toBe(after.refundedMinor === after.capturedMinor)
          expect(after.status === 'confirmed').toBe(after.refundedMinor === 0)
        },
      ),
      { numRuns: 40 },
    )
    await env.store.close()
  })
})

// P3-04 Decision 2: a service notes the command it runs and the records it touches into the open command, and writes
// no row itself. Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
const importer = { kind: 'import', id: 'woocommerce' } as const
const admin = { kind: 'admin', id: 'admin-1' } as const

const noted = async (commandStore: CommandStore) =>
  (await commandStore.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))).map(
    (e) => ({
      actor: e.actor,
      command: e.command,
      subjects: e.subjects,
      outcome: e.outcome,
      status: e.responseStatus,
    }),
  )

describe('RefundService: audit notes', () => {
  it('AC-2: under an actor with no opener, a refund leaves one applied entry naming the order', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const { refund } = await runAsActor(importer, () =>
      env.refunds.refund({ orderId: order.id, amountMinor: 100, actor: 'a' }),
    )
    expect(refund.status).toBe('succeeded')
    expect(await noted(env.store)).toEqual([
      {
        actor: importer,
        command: 'order.refund',
        subjects: [{ type: 'order', id: order.id }],
        outcome: 'applied',
        status: null,
      },
    ])
    await env.store.close()
  })

  it('AC-2: a refund refused before its transaction is recorded as order.refund refused, naming the order', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    await expect(
      runAsActor(admin, () =>
        auditedCommand(env.store, undefined, () =>
          env.refunds.refund({ orderId: order.id, amountMinor: 0, actor: 'a' }),
        ),
      ),
    ).rejects.toThrow(ValidationError)
    expect(env.calls).toHaveLength(0)
    expect(await noted(env.store)).toEqual([
      {
        actor: admin,
        command: 'order.refund',
        subjects: [{ type: 'order', id: order.id }],
        outcome: 'refused',
        status: 400,
      },
    ])
    await env.store.close()
  })
})
