import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PromotionEffect, PromotionSession, PromotionsAdapter } from '@nymbalhq/types'
import { createCommandStore, rawClients, type CommandStore } from '../../db/command-store.js'
import { runMigrations } from '../../db/migrate.js'
import { InMemoryDocumentStore } from '../../document-store/in-memory.js'
import { createLogger } from '../../logger.js'
import { buildRepositories, type Repositories } from '../../repositories/index.js'
import {
  isMoneyEffect,
  promotionRow,
  uniqueCode,
  type PromotionSeed,
} from '../../tests/promotions.js'
import { createNativePromotionsAdapter } from './native-adapter.js'

// The native engine against a migrated SQLite store: promotions and redemptions are written as rows, the clock is
// injected, and every evaluation here is dry except where a test says otherwise.

const NOW = new Date('2026-06-15T12:00:00.000Z')
const logger = createLogger({ pretty: false, level: 'error' })

let store: CommandStore
let repos: Repositories

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../../migrations', import.meta.url).pathname,
  })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
})

afterAll(async () => {
  await store?.close()
})

function raw() {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('expected the SQLite store')
  return clients.raw
}

const INSERT_PROMOTION =
  'INSERT INTO promotions (id, code, kind, percent_bps, amount_off_minor, currency, minimum_subtotal_minor, ' +
  'expires_at, usage_cap, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

function seed(row: PromotionSeed): string {
  const { id, params } = promotionRow('sqlite', row)
  raw()
    .prepare(INSERT_PROMOTION)
    .run(...params)
  return id
}

let orderSequence = 1_000_000

/** An order row of `status` placed under `sessionId`, answering its id. */
function seedOrder(status: string, sessionId: string): string {
  const orderId = randomUUID()
  orderSequence += 1
  const now = NOW.toISOString()
  raw()
    .prepare(
      'INSERT INTO orders (id, order_number, sequence, status, email, billing_address, shipping_address, line_items, ' +
        'subtotal_minor, total_minor, currency, cart_token, created_at, updated_at) VALUES ' +
        '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      orderId,
      `T-${orderSequence}`,
      orderSequence,
      status,
      'shopper@example.com',
      '{}',
      '{}',
      '[]',
      5000,
      5000,
      'GBP',
      sessionId,
      now,
      now,
    )
  return orderId
}

/** A redemption of `promotionId` held by an order of `status`, placed under `sessionId`. */
function seedRedemption(promotionId: string, status: string, sessionId: string): void {
  raw()
    .prepare(
      'INSERT INTO promotion_redemptions (promotion_id, order_id, session_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(promotionId, seedOrder(status, sessionId), sessionId, NOW.toISOString())
}

function engine(now: Date = NOW): PromotionsAdapter {
  return createNativePromotionsAdapter({ repos, logger, now: () => now })
}

function session(
  codes: readonly string[],
  subtotal: number,
  over: Partial<PromotionSession> = {},
): PromotionSession {
  return {
    id: over.id ?? `cart-${randomUUID()}`,
    customerId: null,
    codes,
    currency: 'GBP',
    lines: [
      {
        id: 'v-1',
        variantId: 'v-1',
        sku: 'SKU-1',
        productId: 'p-1',
        categoryIds: [],
        unitMinor: subtotal,
        qty: 1,
      },
    ],
    shipping: null,
    ...over,
  }
}

const rejections = (effects: readonly PromotionEffect[]) =>
  effects.flatMap((e) => (e.kind === 'code_rejected' ? [[e.code, e.reason]] : []))
const accepted = (effects: readonly PromotionEffect[]) =>
  effects.flatMap((e) => (e.kind === 'code_accepted' ? [e.code] : []))
const money = (effects: readonly PromotionEffect[]) => effects.filter(isMoneyEffect)

/** The whole of one dry evaluation of a single code. */
async function evaluateOne(code: string, subtotal: number, adapter = engine()) {
  const { effects } = await adapter.evaluate(session([code], subtotal), { dry: true })
  return effects
}

/** What an evaluation decided, in one comparable value. */
function outcome(effects: readonly PromotionEffect[]) {
  return {
    accepted: accepted(effects),
    rejected: rejections(effects),
    money: money(effects).map((e) => [e.kind, e.amountMinor]),
  }
}

const rejectedOnly = (code: string, reason: string) => ({
  accepted: [],
  rejected: [[code, reason]],
  money: [],
})

describe('AC-4: what a native code takes', () => {
  it('AC-4: a percent code takes floor(subtotal × bps / 10000) as one order effect and its code_accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 9999 }),
        fc.integer({ min: 1, max: 5_000_000 }),
        async (bps, subtotal) => {
          const code = uniqueCode('PCT')
          seed({ code, kind: 'percent', percentBps: bps })

          const effects = await evaluateOne(code, subtotal)

          expect(accepted(effects)).toEqual([code])
          expect(money(effects).map((e) => [e.kind, e.amountMinor])).toEqual([
            ['order', Number((BigInt(subtotal) * BigInt(bps)) / 10_000n)],
          ])
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-4: a fixed code takes min(amount, subtotal) as one order effect and its code_accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 500_000 }),
        fc.integer({ min: 1, max: 500_000 }),
        async (amount, subtotal) => {
          const code = uniqueCode('FIX')
          seed({ code, kind: 'fixed', amountOffMinor: amount, currency: 'GBP' })

          const effects = await evaluateOne(code, subtotal)

          expect(accepted(effects)).toEqual([code])
          expect(money(effects).map((e) => [e.kind, e.amountMinor])).toEqual([
            ['order', Math.min(amount, subtotal)],
          ])
        },
      ),
      { numRuns: 100 },
    )
  })

  const KINDS = ['good', 'unknown', 'inactive', 'expired', 'below_minimum'] as const
  type Kind = (typeof KINDS)[number]
  const SUBTOTAL = 5000

  function seedOfKind(kind: Kind): string {
    const code = uniqueCode(kind.toUpperCase())
    if (kind === 'unknown') return code
    seed({
      code,
      kind: 'percent',
      percentBps: 1000,
      ...(kind === 'inactive' && { active: false }),
      ...(kind === 'expired' && { expiresAt: new Date(NOW.getTime() - 1000) }),
      ...(kind === 'below_minimum' && {
        minimumSubtotalMinor: SUBTOTAL + 1,
        currency: 'GBP',
      }),
    })
    return code
  }

  it('AC-4: codes are taken in order: the first the engine would accept applies, alone; every other carries its own reason, one_code_per_order only when it would itself be accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 5 }),
        async (kinds) => {
          const codes = kinds.map(seedOfKind)
          const firstGood = kinds.indexOf('good')

          const { effects } = await engine().evaluate(session(codes, SUBTOTAL), { dry: true })

          const applied = firstGood === -1 ? [] : [codes[firstGood]]
          expect(accepted(effects)).toEqual(applied)
          expect(money(effects).map((e) => [e.kind, e.amountMinor])).toEqual(
            applied.map(() => ['order', Math.floor((SUBTOTAL * 1000) / 10_000)]),
          )
          expect(rejections(effects)).toEqual(
            codes.flatMap((code, i) => {
              if (i === firstGood) return []
              return [[code, kinds[i] === 'good' ? 'one_code_per_order' : kinds[i]]]
            }),
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})

describe('AC-5: the native engine’s reasons', () => {
  it('AC-5: a code that does not exist is unknown; a stored code matches in any case after trim', async () => {
    const typed = uniqueCode('NOPE')
    expect(outcome(await evaluateOne(typed, 5000))).toEqual(rejectedOnly(typed, 'unknown'))

    const code = uniqueCode('Case')
    seed({ code, kind: 'percent', percentBps: 1000 })
    for (const entered of [code.toLowerCase(), code.toUpperCase(), `  ${code}  `]) {
      const effects = await evaluateOne(entered, 5000)
      expect(accepted(effects), entered).toHaveLength(1)
      expect(
        money(effects).map((e) => e.amountMinor),
        entered,
      ).toEqual([500])
    }
  })

  it('AC-5: an inactive code is rejected inactive and takes no money', async () => {
    const code = uniqueCode('OFF')
    seed({ code, kind: 'percent', percentBps: 1000, active: false })

    expect(outcome(await evaluateOne(code, 5000))).toEqual(rejectedOnly(code, 'inactive'))
  })

  it('AC-5: a code is expired at and after expires_at by the injected clock, and valid one millisecond before', async () => {
    const code = uniqueCode('EXP')
    seed({ code, kind: 'percent', percentBps: 1000, expiresAt: NOW })

    expect(outcome(await evaluateOne(code, 5000, engine(NOW)))).toEqual(
      rejectedOnly(code, 'expired'),
    )
    expect(outcome(await evaluateOne(code, 5000, engine(new Date(NOW.getTime() + 1))))).toEqual(
      rejectedOnly(code, 'expired'),
    )

    const before = await evaluateOne(code, 5000, engine(new Date(NOW.getTime() - 1)))
    expect(accepted(before)).toEqual([code])
    expect(money(before).map((e) => e.amountMinor)).toEqual([500])
  })

  it('AC-5: below the minimum subtotal a code is below_minimum, and at the minimum it applies', async () => {
    const code = uniqueCode('MIN')
    seed({ code, kind: 'percent', percentBps: 1000, minimumSubtotalMinor: 2000, currency: 'GBP' })

    expect(outcome(await evaluateOne(code, 1999))).toEqual(rejectedOnly(code, 'below_minimum'))

    const at = await evaluateOne(code, 2000)
    expect(accepted(at)).toEqual([code])
    expect(money(at).map((e) => e.amountMinor)).toEqual([200])
  })

  it('AC-5: a live redemption of a capped code is cap_reached; a cancelled order’s, or the evaluating session’s own pending order’s, does not count', async () => {
    const capped = uniqueCode('CAP')
    const id = seed({ code: capped, kind: 'percent', percentBps: 1000, usageCap: 1 })
    const evaluating = `cart-${randomUUID()}`
    const evaluate = async (sessionId: string) => {
      const { effects } = await engine().evaluate(session([capped], 5000, { id: sessionId }), {
        dry: true,
      })
      return effects
    }

    seedRedemption(id, 'cancelled', `cart-${randomUUID()}`)
    expect(accepted(await evaluate(evaluating))).toEqual([capped])

    seedRedemption(id, 'pending', evaluating)
    expect(accepted(await evaluate(evaluating)), 'its own pending use does not count').toEqual([
      capped,
    ])
    const other = await evaluate(`cart-${randomUUID()}`)
    expect(rejections(other)).toEqual([[capped, 'cap_reached']])
    expect(money(other)).toEqual([])
  })

  it('AC-5: a confirmed order’s redemption counts against the cap for every session', async () => {
    const capped = uniqueCode('CONF')
    const id = seed({ code: capped, kind: 'percent', percentBps: 1000, usageCap: 1 })
    const buyer = `cart-${randomUUID()}`
    seedRedemption(id, 'confirmed', buyer)

    for (const sessionId of [buyer, `cart-${randomUUID()}`]) {
      const { effects } = await engine().evaluate(session([capped], 5000, { id: sessionId }), {
        dry: true,
      })
      expect(rejections(effects)).toEqual([[capped, 'cap_reached']])
      expect(money(effects)).toEqual([])
    }
  })
})

describe('AC-6: a code’s money has a currency', () => {
  it('AC-6: a fixed code applies only in its own currency; otherwise it is wrong_currency with no money', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GBP', 'USD', 'EUR'),
        fc.constantFrom('GBP', 'USD', 'EUR'),
        async (codeCurrency, cartCurrency) => {
          const code = uniqueCode('FX')
          seed({ code, kind: 'fixed', amountOffMinor: 400, currency: codeCurrency })

          const { effects } = await engine().evaluate(
            session([code], 5000, { currency: cartCurrency }),
            { dry: true },
          )

          const expected =
            codeCurrency === cartCurrency
              ? { accepted: [code], rejected: [], money: [['order', 400]] }
              : rejectedOnly(code, 'wrong_currency')
          expect(outcome(effects)).toEqual(expected)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('AC-6: a percent code with a minimum spend applies only in the minimum’s currency', async () => {
    const code = uniqueCode('MINFX')
    seed({ code, kind: 'percent', percentBps: 1000, minimumSubtotalMinor: 100, currency: 'USD' })

    const inGbp = await engine().evaluate(session([code], 5000, { currency: 'GBP' }), { dry: true })
    expect(rejections(inGbp.effects)).toEqual([[code, 'wrong_currency']])
    expect(money(inGbp.effects)).toEqual([])

    const inUsd = await engine().evaluate(session([code], 5000, { currency: 'USD' }), { dry: true })
    expect(accepted(inUsd.effects)).toEqual([code])
    expect(money(inUsd.effects).map((e) => e.amountMinor)).toEqual([500])
  })

  it('AC-6: a percent code with no minimum applies in any session currency', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('GBP', 'USD', 'EUR', 'JPY'), async (currency) => {
        const code = uniqueCode('ANY')
        seed({ code, kind: 'percent', percentBps: 2500 })

        const { effects } = await engine().evaluate(session([code], 8000, { currency }), {
          dry: true,
        })

        expect(accepted(effects)).toEqual([code])
        expect(money(effects).map((e) => e.amountMinor)).toEqual([2000])
      }),
      { numRuns: 12 },
    )
  })
})

describe('a reserving evaluation', () => {
  const redemptionsOf = (promotionId: string) =>
    raw()
      .prepare(
        'SELECT order_id AS orderId, session_id AS sessionId FROM promotion_redemptions WHERE promotion_id = ?',
      )
      .all(promotionId) as { orderId: string; sessionId: string }[]

  /** The engine over a promotion repository whose `lock` is recorded and may be replaced. */
  function lockingEngine(lock: Repositories['promotion']['lock'] = repos.promotion.lock) {
    const locked: string[] = []
    const adapter = createNativePromotionsAdapter({
      repos: {
        promotion: {
          ...repos.promotion,
          lock: (tx, id) => {
            locked.push(id)
            return lock(tx, id)
          },
        },
      },
      logger,
      now: () => NOW,
    })
    return { adapter, locked }
  }

  it('records one redemption for the order and the session, and answers what a dry evaluation answers', async () => {
    const code = uniqueCode('RESERVE')
    const id = seed({ code, kind: 'percent', percentBps: 1000 })
    const sessionId = `cart-${randomUUID()}`
    const orderId = seedOrder('pending', sessionId)
    const reserving = session([code], 5000, { id: sessionId })
    const dry = await engine().evaluate(reserving, { dry: true })
    const reserved = await engine().evaluate(reserving, { orderId })
    expect(reserved).toEqual(dry)
    expect(redemptionsOf(id)).toEqual([{ orderId, sessionId }])
  })

  it('a dry evaluation given an order id, and one with no order id, reserve nothing and lock nothing', async () => {
    const code = uniqueCode('DRY')
    const id = seed({ code, kind: 'percent', percentBps: 1000 })
    const sessionId = `cart-${randomUUID()}`
    const { adapter, locked } = lockingEngine()
    await adapter.evaluate(session([code], 5000, { id: sessionId }), {
      dry: true,
      orderId: seedOrder('pending', sessionId),
    })
    await adapter.evaluate(session([code], 5000, { id: sessionId }), {})
    expect(redemptionsOf(id)).toEqual([])
    expect(locked).toEqual([])
  })

  it('redeems only the winner of two valid codes', async () => {
    const [first, second] = [uniqueCode('WIN'), uniqueCode('LOSE')]
    const winner = seed({ code: first, kind: 'percent', percentBps: 1000 })
    const loser = seed({ code: second, kind: 'percent', percentBps: 2000 })
    const sessionId = `cart-${randomUUID()}`
    await engine().evaluate(session([first, second], 5000, { id: sessionId }), {
      orderId: seedOrder('pending', sessionId),
    })
    expect(redemptionsOf(winner)).toHaveLength(1)
    expect(redemptionsOf(loser)).toEqual([])
  })

  it('property: every code is locked once, in id order, however the session lists them', async () => {
    const seeded = ['A', 'B', 'C', 'D'].map((tag) => {
      const code = uniqueCode(`LOCK${tag}`)
      return { code, id: seed({ code, kind: 'percent', percentBps: 1000 }) }
    })
    const ids = seeded.map((s) => s.id).sort((a, b) => a.localeCompare(b))
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(seeded, { minLength: 4 }), async (listed) => {
        const sessionId = `cart-${randomUUID()}`
        const { adapter, locked } = lockingEngine()
        await adapter.evaluate(
          session(
            listed.map((s) => s.code),
            5000,
            { id: sessionId },
          ),
          {
            orderId: seedOrder('pending', sessionId),
          },
        )
        expect(locked).toEqual(ids)
      }),
      { numRuns: 8 },
    )
  })

  it('a row gone between the find and the lock reads as unknown and redeems nothing', async () => {
    const code = uniqueCode('GONE')
    const id = seed({ code, kind: 'percent', percentBps: 1000 })
    const sessionId = `cart-${randomUUID()}`
    const { adapter } = lockingEngine(async () => null)
    const { effects } = await adapter.evaluate(session([code], 5000, { id: sessionId }), {
      orderId: seedOrder('pending', sessionId),
    })
    expect(outcome(effects)).toEqual(rejectedOnly(code, 'unknown'))
    expect(redemptionsOf(id)).toEqual([])
  })

  it('the use a reservation takes is the one the next session is refused for, at the cap and not before', async () => {
    const code = uniqueCode('CAP')
    seed({ code, kind: 'percent', percentBps: 1000, usageCap: 2 })
    const reserve = async () => {
      const sessionId = `cart-${randomUUID()}`
      return engine().evaluate(session([code], 5000, { id: sessionId }), {
        orderId: seedOrder('pending', sessionId),
      })
    }
    expect(outcome((await reserve()).effects).accepted).toEqual([code])
    expect(outcome((await reserve()).effects).accepted).toEqual([code])
    expect(outcome((await reserve()).effects)).toEqual(rejectedOnly(code, 'cap_reached'))
  })
})
