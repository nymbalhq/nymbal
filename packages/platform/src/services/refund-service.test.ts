import { afterEach, describe, expect, it, vi } from 'vitest'
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
  type Logger,
  type OrderStatus,
  type ProviderRefund,
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
import {
  createRefundService,
  settlementOf,
  PROVIDER_REFUND_REASON,
  REFUND_UNKNOWN_AFTER_MS,
} from './refund-service.js'
import type { OrderRefundInsert } from '../repositories/order-refund.js'

// A refund moves money: the hold under the lock (requestId reuse, not_captured, exceeds_captured), the provider call
// (key = row id, outcome mapping, manual and import captures move nothing) and the settlement (only on a matching
// answer, Σ recomputed, the status never written). The integration suites pin the same through the route; Stryker sees
// only these.

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

/** What the provider lists for a payment; an empty list unless a test says otherwise. */
type Listing = (paymentId: string) => Promise<ProviderRefund[]>

interface LogLine {
  level: 'warn' | 'error'
  fields: unknown
  msg: string | undefined
}

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
  const listCalls: string[] = []
  const script = { answer, list: (async () => []) as Listing }
  const payments = {
    ...createNativeStubPaymentsAdapter({ logger }),
    async refund(paymentId: string, amountMinor?: number, reason?: string, opts?: RefundOptions) {
      const call = { paymentId, amountMinor, reason, opts }
      calls.push(call)
      return script.answer(call)
    },
    async listRefunds(paymentId: string) {
      listCalls.push(paymentId)
      return script.list(paymentId)
    },
  }
  const logs: LogLine[] = []
  const recording: Logger = {
    ...logger,
    warn: (fields, msg) => logs.push({ level: 'warn', fields, msg }),
    error: (fields, msg) => logs.push({ level: 'error', fields, msg }),
  }
  const refunds = createRefundService({ store, repos, publisher, logger: recording, payments })
  return { store, repos, orders, refunds, calls, listCalls, script, logs }
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
  it('succeeded or pending only on a matching answer, failed always failed, mismatch otherwise pending', () => {
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

describe('RefundService: a refund moves money', () => {
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
    expect(results.map((r) => r.order.status)).toEqual(['confirmed', 'confirmed', 'confirmed'])
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
      ['confirmed', 'confirmed', 'admin:0'],
      ['confirmed', 'confirmed', 'admin:1'],
      ['confirmed', 'confirmed', 'admin:2'],
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
  it('a repeated requestId answers the first refund and moves no money; another amount is refund.request_reused', async () => {
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

  // Defect: the status check is dropped, so an order canRefund refuses (cancelled) gets a refund.
  it('an order canRefund refuses refuses with StatusTransitionError and writes nothing', async () => {
    const env = await setup()
    const order = await paidOrder(env, { method: 'manual', status: 'cancelled' })
    const err = await refusal(env.refunds.refund({ orderId: order.id, amountMinor: 1, actor: 'a' }))
    expect(err).toBeInstanceOf(StatusTransitionError)
    expect(await rowsOf(env, order.id)).toHaveLength(0)
    await env.store.close()
  })

  // Defect: step 3 reads the status again and refuses or rewrites it, leaving money moved and the row unsettled.
  it('a status moved during the provider call stands, with one same-status refund row, the row and Σ written', async () => {
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
  it('AC-3: over any sequence of refunds, Σ succeeded = refundedMinor <= capturedMinor, and the status stays where it was', async () => {
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
          expect(after.status).toBe('confirmed')
        },
      ),
      { numRuns: 40 },
    )
    await env.store.close()
  })
})

// A service notes the command it runs and the records it touches into the open command, and writes no row itself.
// Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const UNCHANGED = { recorded: 0, settled: 0, failed: 0 }
const lines = (env: Env, level: LogLine['level']) => env.logs.filter((l) => l.level === level)

function listedRefund(paymentId: string, over: Partial<ProviderRefund> = {}): ProviderRefund {
  return {
    refundId: `re_${uuidv7()}`,
    paymentId,
    amountMinor: 1500,
    currency: 'GBP',
    reason: null,
    status: 'succeeded',
    idempotencyKey: null,
    ...over,
  }
}

async function heldRow(env: Env, orderId: string, over: Partial<OrderRefundInsert> = {}) {
  const row: OrderRefundInsert = {
    id: uuidv7(),
    orderId,
    amountMinor: 1500,
    currency: 'GBP',
    providerRefundId: null,
    status: 'pending',
    reason: null,
    actor: 'admin:1',
    createdAt: new Date(Date.now() - 10 * MINUTE),
    requestId: null,
    ...over,
  }
  await env.store.transaction((tx) => env.repos.orderRefund.insert(tx, row))
  return row
}

const storedRow = async (env: Env, orderId: string, id: string) =>
  (await rowsOf(env, orderId)).find((r) => r.id === id)!

const lists =
  (...refunds: ProviderRefund[]): Listing =>
  async () =>
    refunds

async function customerWhoSpent(env: Env, spentMinor: number) {
  const id = uuidv7()
  const now = new Date()
  await env.store.transaction((tx) =>
    env.repos.customer.insert(tx, {
      id,
      email: `${id}@example.com`,
      passwordHash: 'x',
      createdAt: now,
      updatedAt: now,
    }),
  )
  await env.store.transaction((tx) => env.repos.customer.incrementStats(tx, id, 1, spentMinor, now))
  return id
}

const spentBy = async (env: Env, customerId: string) =>
  (await env.store.read((tx) => env.repos.customer.findById(tx, customerId)))!.totalSpentMinor

describe('RefundService: reconcile guards', () => {
  // Defect: a refund on a shared provider account for something this store never sold reaches the list call, or is
  // recorded against some other order.
  it('an intent no order holds answers unknown_order and never asks the provider', async () => {
    const env = await setup()
    env.script.list = lists(listedRefund('pi_elsewhere'))

    expect(await env.refunds.reconcilePayment('pi_elsewhere')).toEqual({ ignored: 'unknown_order' })
    expect(env.listCalls).toEqual([])
    await env.store.close()
  })

  // Defect: a manual or imported capture is matched against the provider, which never took that money.
  it('a manual or import capture answers not_provider_captured and changes nothing', async () => {
    const env = await setup()
    for (const method of ['manual', 'import'] as const) {
      const intent = `pi_${uuidv7()}`
      const order = await paidOrder(env, { method, intent })
      env.script.list = lists(listedRefund(intent, { amountMinor: 700 }))

      expect(await env.refunds.reconcilePayment(intent)).toEqual({
        ignored: 'not_provider_captured',
      })
      expect(await rowsOf(env, order.id)).toEqual([])
      expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    }
    expect(env.listCalls).toEqual([])
    await env.store.close()
  })

  // Defect: a refund that overtook its capture is answered as handled, so the webhook is not retried once it lands.
  it('a pending order with no capture throws capture_not_recorded, naming the order', async () => {
    const env = await setup()
    const intent = `pi_${uuidv7()}`
    const order = await paidOrder(env, { method: null, intent, status: 'pending' })

    const err = await refusal(env.refunds.reconcilePayment(intent))

    expect(err).toBeInstanceOf(PaymentError)
    expect(err).toMatchObject({
      code: 'payment.capture_not_recorded',
      message: `Order ${order.orderNumber} has a refund before its capture`,
      context: { orderId: order.id },
    })
    expect(env.listCalls).toEqual([])
    await env.store.close()
  })

  // Defect: an order that moved on with no capture throws, so one event holds the endpoint failing for three days; or
  // nothing is logged and the lost capture goes unseen.
  it('any other status with no capture answers capture_never_recorded and logs one error', async () => {
    const env = await setup()
    for (const status of ['confirmed', 'cancelled'] as const) {
      env.logs.length = 0
      const intent = `pi_${uuidv7()}`
      const order = await paidOrder(env, { method: null, intent, status })

      expect(await env.refunds.reconcilePayment(intent)).toEqual({
        ignored: 'capture_never_recorded',
      })
      expect(env.logs).toEqual([
        {
          level: 'error',
          fields: { orderId: order.id, status },
          msg: 'a provider refund for an order with no recorded capture; ignored',
        },
      ])
    }
    expect(env.listCalls).toEqual([])
    await env.store.close()
  })

  // Defect: a failed list reads as "no refunds", so every old pending row is aged out during a provider outage.
  it('a list that throws is refund_lookup_failed with its cause, and leaves an old pending row pending', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const row = await heldRow(env, order.id, {
      createdAt: new Date(Date.now() - 3 * HOUR),
    })
    const cause = new Error('provider down')
    env.script.list = async () => {
      throw cause
    }

    const err = await refusal(env.refunds.reconcilePayment(order.paymentIntentId!))

    expect(err).toBeInstanceOf(PaymentError)
    expect(err).toMatchObject({
      code: 'payment.refund_lookup_failed',
      message: `Could not list the refunds of payment ${order.paymentIntentId}`,
      cause,
      context: { orderId: order.id },
    })
    expect((await storedRow(env, order.id, row.id)).status).toBe('pending')
    await env.store.close()
  })

  // Defect: an order with no intent, or an order id that is no order, reaches the provider or throws.
  it('reconcileOrder answers no_payment with no intent and no order, and otherwise reads that order', async () => {
    const env = await setup()
    const unpaid = await paidOrder(env, { method: 'manual', intent: null })

    expect(await env.refunds.reconcileOrder(unpaid.id)).toEqual({ ignored: 'no_payment' })
    expect(await env.refunds.reconcileOrder(uuidv7())).toEqual({ ignored: 'no_payment' })
    expect(env.listCalls).toEqual([])

    const paid = await paidOrder(env)
    env.script.list = lists(listedRefund(paid.paymentIntentId!, { amountMinor: 700 }))
    expect(await env.refunds.reconcileOrder(paid.id)).toEqual({ ...UNCHANGED, recorded: 1 })
    expect(env.listCalls).toEqual([paid.paymentIntentId])
    expect((await orderOf(env, paid.id)).refundedMinor).toBe(700)
    await env.store.close()
  })
})

describe('RefundService: applying the list', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Defect: the key is read before the provider id, so a listed refund settles the row its key names.
  it('a listed refund settles the row holding its provider id before the row its key names', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const named = await heldRow(env, order.id, {
      amountMinor: 2000,
      createdAt: new Date(Date.now() - 30 * MINUTE),
    })
    const held = await heldRow(env, order.id, { amountMinor: 1000, providerRefundId: 're_held' })
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_held',
        amountMinor: 1000,
        idempotencyKey: named.id,
      }),
    )

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, settled: 1 })

    expect((await storedRow(env, order.id, held.id)).status).toBe('succeeded')
    expect(await storedRow(env, order.id, named.id)).toMatchObject({
      status: 'pending',
      providerRefundId: null,
    })
    expect((await orderOf(env, order.id)).refundedMinor).toBe(1000)
    await env.store.close()
  })

  // Defect: a key match settles the wrong row of the order, or a settled row runs no effects.
  it('a listed refund with no provider id on any row settles the row its key names, with the row actor on its history', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const other = await heldRow(env, order.id, {
      amountMinor: 2000,
      createdAt: new Date(Date.now() - 30 * MINUTE),
    })
    const named = await heldRow(env, order.id, { amountMinor: 1500, actor: 'admin:7' })
    const historyBefore = (await historyOf(env, order.id)).length
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_new',
        amountMinor: 1500,
        idempotencyKey: named.id,
      }),
    )

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, settled: 1 })

    expect(await storedRow(env, order.id, named.id)).toMatchObject({
      status: 'succeeded',
      providerRefundId: 're_new',
    })
    expect((await storedRow(env, order.id, other.id)).status).toBe('pending')
    expect((await orderOf(env, order.id)).refundedMinor).toBe(1500)
    const history = await historyOf(env, order.id)
    expect(history).toHaveLength(historyBefore + 1)
    expect(history.at(-1)!.actor).toBe('admin:7')
    await env.store.close()
  })

  // Defect: a refund carrying this store's key on no row of the order is recorded as the provider's own, adding money
  // the order never refunded (a key from another order, or a row removed since).
  it('a listed refund whose key names no row of the order warns, writes no row and leaves the sum alone', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    await env.refunds.refund({ orderId: order.id, amountMinor: 1000, actor: 'a' })
    const rowsBefore = await rowsOf(env, order.id)
    const key = uuidv7()
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_foreign',
        amountMinor: 500,
        idempotencyKey: key,
      }),
    )

    expect(await env.refunds.reconcileOrder(order.id)).toEqual(UNCHANGED)

    expect(await rowsOf(env, order.id)).toEqual(rowsBefore)
    expect((await orderOf(env, order.id)).refundedMinor).toBe(1000)
    expect(env.logs).toEqual([
      {
        level: 'warn',
        fields: { orderId: order.id, refundId: 're_foreign', key },
        msg: "this store's key on no row of the order",
      },
    ])
    await env.store.close()
  })

  // Defect: a dashboard refund that failed is recorded, holding money that never moved against the capture.
  it('a listed failed refund with no key writes no row and logs nothing', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    env.script.list = lists(listedRefund(order.paymentIntentId!, { status: 'failed' }))

    expect(await env.refunds.reconcileOrder(order.id)).toEqual(UNCHANGED)

    expect(await rowsOf(env, order.id)).toEqual([])
    expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    expect(env.logs).toEqual([])
    await env.store.close()
  })

  // Defect: the capture check counts pending or failed rows, is off by one at the capture, is case-sensitive on the
  // currency, stops the pass at the first refusal, or does not move on as refunds are counted.
  it('a refund the order cannot hold is refused with an error while the next listed one applies, up to the capture exactly', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 10_000 })
    await env.refunds.refund({ orderId: order.id, amountMinor: 3000, actor: 'a' })
    await heldRow(env, order.id, { amountMinor: 4000, status: 'failed' })
    await heldRow(env, order.id, { amountMinor: 2000 })
    const intent = order.paymentIntentId!
    const euro = listedRefund(intent, { amountMinor: 100, currency: 'EUR' })
    const over = listedRefund(intent, { amountMinor: 7001 })
    const fits = listedRefund(intent, { amountMinor: 7000, currency: 'gbp' })
    const past = listedRefund(intent, { amountMinor: 1 })
    env.script.list = lists(euro, over, fits, past)

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, recorded: 1 })

    const recorded = (await rowsOf(env, order.id)).filter((r) => r.actor === 'system:provider')
    expect(recorded.map((r) => r.providerRefundId)).toEqual([fits.refundId])
    expect((await orderOf(env, order.id)).refundedMinor).toBe(10_000)
    const refused = 'provider refund refused: the order cannot hold it'
    expect(env.logs).toEqual(
      [euro, over, past].map((r) => ({
        level: 'error',
        fields: {
          orderId: order.id,
          refundId: r.refundId,
          amountMinor: r.amountMinor,
          currency: r.currency,
        },
        msg: refused,
      })),
    )
    await env.store.close()
  })

  // Defect: the row takes the provider's casing of the currency or another actor, or a pending refund counts as
  // refunded.
  it('an inserted row has the provider actor, the listed status and the order currency, and only a succeeded one moves the sum', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 10_000 })
    const historyBefore = (await historyOf(env, order.id)).length
    const startedAt = Date.now()
    const waiting = listedRefund(order.paymentIntentId!, {
      status: 'pending',
      amountMinor: 400,
      currency: 'gbp',
      reason: 'goodwill',
    })
    const done = listedRefund(order.paymentIntentId!, { amountMinor: 600 })
    env.script.list = lists(waiting, done)

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, recorded: 2 })

    const rows = await rowsOf(env, order.id)
    const pendingRow = rows.find((r) => r.providerRefundId === waiting.refundId)!
    const doneRow = rows.find((r) => r.providerRefundId === done.refundId)!
    expect(pendingRow).toMatchObject({
      status: 'pending',
      amountMinor: 400,
      currency: 'GBP',
      reason: 'goodwill',
      actor: 'system:provider',
    })
    expect(doneRow).toMatchObject({
      status: 'succeeded',
      amountMinor: 600,
      currency: 'GBP',
      reason: null,
      actor: 'system:provider',
    })
    expect(new Date(doneRow.createdAt).getTime()).toBeGreaterThanOrEqual(startedAt)
    expect(pendingRow.id).not.toBe(doneRow.id)
    expect((await orderOf(env, order.id)).refundedMinor).toBe(600)
    const partial = await events(env, EVT_ORDER_PARTIALLY_REFUNDED, order.id)
    expect(partial.map((p) => p.refundId)).toEqual([doneRow.id])
    const history = await historyOf(env, order.id)
    expect(history).toHaveLength(historyBefore + 1)
    expect(history.at(-1)!.actor).toBe('system:provider')
    await env.store.close()
  })

  // Defect: a pending listing writes the row on every sweep, one audit entry every five minutes per stuck refund; or
  // the provider id is never stored and later passes cannot match the row by it.
  it('a pending row listed pending stores the provider id once, and a second pass writes no audit note', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const row = await heldRow(env, order.id)
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_waiting',
        amountMinor: row.amountMinor,
        status: 'pending',
        idempotencyKey: row.id,
      }),
    )

    const pass = () => runAsActor(importer, () => env.refunds.reconcileOrder(order.id))
    expect(await pass()).toEqual(UNCHANGED)

    expect(await storedRow(env, order.id, row.id)).toMatchObject({
      status: 'pending',
      providerRefundId: 're_waiting',
    })
    const first = await noted(env.store)
    expect(first).toEqual([
      {
        actor: importer,
        command: 'order.reconcileRefunds',
        subjects: [{ type: 'order', id: order.id }],
        outcome: 'applied',
        status: null,
      },
    ])

    expect(await pass()).toEqual(UNCHANGED)
    expect(await noted(env.store)).toEqual(first)
    await env.store.close()
  })

  // Defect: a mismatch stores the provider id, so the key no longer matches the row; or it counts as refunded; or every
  // sweep logs at error, 288 errors a day for one stuck row; or the first row seen silences the alarm for the rest.
  it('a mismatch stores no provider id and logs error once per row, then warn', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const old = () => new Date(Date.now() - 2 * HOUR)
    const stuck = await heldRow(env, order.id, { createdAt: old() })
    const offBy = (row: OrderRefundInsert) =>
      listedRefund(order.paymentIntentId!, {
        refundId: `re_off_${row.id}`,
        amountMinor: row.amountMinor + 1,
        idempotencyKey: row.id,
      })
    env.script.list = lists(offBy(stuck))
    const line = (level: string, row: OrderRefundInsert) => ({
      level,
      fields: { orderId: order.id, refundId: `re_off_${row.id}`, rowId: row.id },
      msg: 'provider refund differs from the row; left pending',
    })

    expect(await env.refunds.reconcileOrder(order.id)).toEqual(UNCHANGED)
    expect(await storedRow(env, order.id, stuck.id)).toMatchObject({
      status: 'pending',
      providerRefundId: null,
    })
    expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    expect(env.logs).toEqual([line('error', stuck)])

    env.logs.length = 0
    expect(await env.refunds.reconcileOrder(order.id)).toEqual(UNCHANGED)
    expect(env.logs).toEqual([line('warn', stuck)])

    env.logs.length = 0
    const second = await heldRow(env, order.id, { createdAt: old() })
    env.script.list = lists(offBy(stuck), offBy(second))
    await env.refunds.reconcileOrder(order.id)
    expect(env.logs).toEqual([line('warn', stuck), line('error', second)])
    await env.store.close()
  })

  // Defect: a provider failure leaves the row pending, or counts as money moved.
  it('a pending row listed failed settles failed with the provider id, and moves no money', async () => {
    const env = await setup()
    const order = await paidOrder(env)
    const row = await heldRow(env, order.id, {
      createdAt: new Date(Date.now() - 2 * HOUR),
    })
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_refused',
        amountMinor: row.amountMinor,
        status: 'failed',
        idempotencyKey: row.id,
      }),
    )

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, failed: 1 })

    expect(await storedRow(env, order.id, row.id)).toMatchObject({
      status: 'failed',
      providerRefundId: 're_refused',
    })
    expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    expect(await events(env, EVT_PAYMENT_REFUNDED, order.id)).toEqual([])
    await env.store.close()
  })

  // Defect: a settled row is rewritten by a later listing, or a real disagreement passes silently.
  it('a settled row is never rewritten, and only a real disagreement with the provider logs an error', async () => {
    const env = await setup()
    const cases = [
      { row: 'succeeded', listed: 'failed', logged: true },
      { row: 'failed', listed: 'succeeded', logged: true },
      { row: 'succeeded', listed: 'succeeded', logged: false },
      { row: 'succeeded', listed: 'pending', logged: false },
      { row: 'failed', listed: 'pending', logged: false },
    ] as const
    for (const c of cases) {
      env.logs.length = 0
      const order = await paidOrder(env)
      const refundId = `re_${uuidv7()}`
      const row = await heldRow(env, order.id, { status: c.row, providerRefundId: refundId })
      env.script.list = lists(
        listedRefund(order.paymentIntentId!, {
          refundId,
          amountMinor: row.amountMinor,
          status: c.listed,
        }),
      )

      expect(await env.refunds.reconcileOrder(order.id)).toEqual(UNCHANGED)

      expect((await storedRow(env, order.id, row.id)).status).toBe(c.row)
      expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
      expect(lines(env, 'error')).toEqual(
        c.logged
          ? [
              {
                level: 'error',
                fields: {
                  orderId: order.id,
                  refundId,
                  rowId: row.id,
                  row: c.row,
                  provider: c.listed,
                },
                msg: 'a settled refund row disagrees with the provider',
              },
            ]
          : [],
      )
    }
    await env.store.close()
  })

  // Defect: a refund still in flight is failed and its amount freed, so the shop refunds it again; or a row with a
  // provider id is failed by a list that omits it.
  it('a pending row fails only when older than an hour with no provider id and unmatched', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 10_000 })
    const now = new Date('2026-11-09T12:00:00.000Z')
    const aged = (ms: number) => new Date(now.getTime() - ms)
    const expired = await heldRow(env, order.id, {
      amountMinor: 100,
      createdAt: aged(REFUND_UNKNOWN_AFTER_MS + 1),
    })
    const atHour = await heldRow(env, order.id, {
      amountMinor: 200,
      createdAt: aged(REFUND_UNKNOWN_AFTER_MS),
    })
    const withId = await heldRow(env, order.id, {
      amountMinor: 300,
      providerRefundId: 're_held',
      createdAt: aged(3 * HOUR),
    })
    const matched = await heldRow(env, order.id, {
      amountMinor: 400,
      createdAt: aged(3 * HOUR),
    })
    const settled = await heldRow(env, order.id, {
      amountMinor: 500,
      status: 'succeeded',
      providerRefundId: 're_done',
      createdAt: aged(3 * HOUR),
    })
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_off',
        amountMinor: matched.amountMinor + 1,
        idempotencyKey: matched.id,
      }),
    )
    vi.useFakeTimers({ toFake: ['Date'], now })

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({ ...UNCHANGED, failed: 1 })

    const statusOf = async (row: OrderRefundInsert) =>
      (await storedRow(env, order.id, row.id)).status
    expect(await storedRow(env, order.id, expired.id)).toMatchObject({
      status: 'failed',
      providerRefundId: null,
    })
    expect(await statusOf(atHour)).toBe('pending')
    expect(await statusOf(withId)).toBe('pending')
    expect(await statusOf(matched)).toBe('pending')
    expect(await statusOf(settled)).toBe('succeeded')
    expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    expect(await events(env, EVT_PAYMENT_REFUNDED, order.id)).toEqual([])
    await env.store.close()
  })

  // Defect: a cancelled order, which already netted to zero, takes the order's refund effects as well.
  it('a refund on a cancelled order publishes payment.refunded alone: no order event, no history row, no spend', async () => {
    const env = await setup()
    const customerId = await customerWhoSpent(env, 10_000)
    const order = await paidOrder(env, { status: 'cancelled', customerId })
    const held = await heldRow(env, order.id, { amountMinor: 900 })
    const historyBefore = (await historyOf(env, order.id)).length
    const dashboard = listedRefund(order.paymentIntentId!, { amountMinor: 600 })
    env.script.list = lists(
      listedRefund(order.paymentIntentId!, {
        refundId: 're_held',
        amountMinor: 900,
        idempotencyKey: held.id,
      }),
      dashboard,
    )

    expect(await env.refunds.reconcileOrder(order.id)).toEqual({
      ...UNCHANGED,
      recorded: 1,
      settled: 1,
    })

    expect((await orderOf(env, order.id)).refundedMinor).toBe(1500)
    const moved = await events(env, EVT_PAYMENT_REFUNDED, order.id)
    expect(moved.map((p) => [p.paymentId, p.amountMinor, p.currency])).toEqual([
      [order.paymentIntentId, 900, 'GBP'],
      [order.paymentIntentId, 600, 'GBP'],
    ])
    expect(await events(env, EVT_ORDER_REFUNDED, order.id)).toEqual([])
    expect(await events(env, EVT_ORDER_PARTIALLY_REFUNDED, order.id)).toEqual([])
    expect(await historyOf(env, order.id)).toHaveLength(historyBefore)
    expect(await spentBy(env, customerId)).toBe(10_000)
    await env.store.close()
  })
})

describe('RefundService: a row another writer settled first', () => {
  // Defect: the settle's answer is ignored, so a row a webhook settled during the provider call runs its effects twice.
  it('the request runs no effects and answers the row as stored', async () => {
    const env = await setup()
    const order = await paidOrder(env, { totalMinor: 5000 })
    const historyBefore = (await historyOf(env, order.id)).length
    env.script.answer = async (call) => {
      await env.store.transaction((tx) =>
        env.repos.orderRefund.settle(tx, call.opts!.idempotencyKey!, {
          status: 'succeeded',
          providerRefundId: 're_webhook',
        }),
      )
      return { ...(await echo(call)), refundId: 're_answer', status: 'failed' as const }
    }

    const r = await env.refunds.refund({ orderId: order.id, amountMinor: 2000, actor: 'a' })

    expect(r.refund).toMatchObject({ status: 'succeeded', providerRefundId: 're_webhook' })
    expect(r.order.refundedMinor).toBe(0)
    expect((await orderOf(env, order.id)).refundedMinor).toBe(0)
    expect(await historyOf(env, order.id)).toHaveLength(historyBefore)
    expect(await events(env, EVT_PAYMENT_REFUNDED, order.id)).toEqual([])
    expect(await events(env, EVT_ORDER_PARTIALLY_REFUNDED, order.id)).toEqual([])
    await env.store.close()
  })
})
