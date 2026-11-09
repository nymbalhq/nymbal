import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { adminAccount, listedNames, toolSurface } from '../support/mcp.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { addLine, putCode, readCart, uniqueCode } from '../support/promotions.js'
import { openRaw, writeRaw, type RawReader } from '../support/raw.js'
import { login, primedShopper } from '../support/security.js'

// AC-26: the admin routes for promotions, over HTTP on a served kernel (SQLite).

interface AdminPromotion {
  id: string
  code: string
  active: boolean
  usedCount: number
}

/** The list answer: the array itself, or an object naming it, as the admin's lists do either way. */
type PromotionList = AdminPromotion[] | { promotions?: AdminPromotion[]; items?: AdminPromotion[] }

function itemsOf(list: PromotionList | undefined): AdminPromotion[] {
  if (list === undefined) throw new Error('the list answered no data')
  const items = Array.isArray(list) ? list : (list.promotions ?? list.items)
  if (items === undefined) throw new Error(`no promotions in ${JSON.stringify(list)}`)
  return items
}

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const valid = (over: Record<string, unknown> = {}) => ({
  code: uniqueCode('ADM'),
  kind: 'percent',
  percentBps: 1000,
  ...over,
})

async function create(body: Record<string, unknown>) {
  return admin.call<AdminPromotion>('POST', '/api/admin/promotions', body)
}

async function createOk(over: Record<string, unknown> = {}): Promise<AdminPromotion> {
  const res = await create(valid(over))
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status)
  return res.body.data!
}

async function listed(): Promise<AdminPromotion[]> {
  const res = await admin.call<PromotionList>('GET', '/api/admin/promotions?limit=200')
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return itemsOf(res.body.data)
}

describe('AC-26: admin promotions', () => {
  it('AC-26: the routes refuse a non-admin and change nothing', async () => {
    const shop = await primedShopper(served.baseUrl)
    const email = `shopper-${randomUUID()}@promo.test`
    const password = 'admin-promo-correct-horse'
    await k.services.auth.register({ email, password })
    const answer = await login(served.baseUrl, shop.jar, { email, password })
    expect(answer.status).toBe(200)
    const token = answer.body.data!.accessToken
    const bearer = { headers: { authorization: `Bearer ${token}` } }
    const before = await raw.count('promotions')

    const responses = await Promise.all([
      shop.call('GET', '/api/admin/promotions', undefined, bearer),
      shop.call('POST', '/api/admin/promotions', valid(), bearer),
      shop.call('PATCH', `/api/admin/promotions/${randomUUID()}`, { active: false }, bearer),
      shop.call('DELETE', `/api/admin/promotions/${randomUUID()}`, undefined, bearer),
    ])

    expect(responses.map((r) => r.status)).toEqual([403, 403, 403, 403])
    expect(await raw.count('promotions')).toBe(before)
  })

  it('AC-26: a promotion body outside the rules is promotion.invalid and stores nothing', async () => {
    const before = await raw.count('promotions')
    const bad: Record<string, unknown>[] = [
      valid({ percentBps: 0 }),
      valid({ percentBps: 10_000 }),
      valid({ percentBps: 1.5 }),
      valid({ kind: 'fixed', percentBps: undefined, amountOffMinor: 0, currency: 'GBP' }),
      valid({ kind: 'fixed', percentBps: undefined, amountOffMinor: 500 }),
      valid({ minimumSubtotalMinor: 1000 }),
      valid({ code: 'has space' }),
      valid({ code: 'x'.repeat(65) }),
      valid({ code: '' }),
      valid({ kind: 'bogo' }),
    ]

    for (const body of bad) {
      const res = await create(body)
      expect(res.status, JSON.stringify({ body, answer: res.body })).toBe(400)
      expect(res.body.error?.code).toBe('promotion.invalid')
    }
    expect(await raw.count('promotions')).toBe(before)
  })

  it('AC-26: the limits of a valid promotion are stored: percent_bps 1 and 9999, a fixed amount with its currency, a minimum with a currency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(1, 9999, 2500),
        fc.integer({ min: 1, max: 100_000 }),
        async (bps, amount) => {
          const percent = await createOk({ percentBps: bps })
          const fixed = await createOk({
            kind: 'fixed',
            percentBps: undefined,
            amountOffMinor: amount,
            currency: 'USD',
          })
          const minimum = await createOk({ minimumSubtotalMinor: amount, currency: 'EUR' })

          const row = await raw.one<{ percent_bps: number }>(
            'SELECT percent_bps FROM promotions WHERE id = ?',
            [percent.id],
          )
          expect(row.percent_bps).toBe(bps)
          const fixedRow = await raw.one<{ amount_off_minor: number; currency: string }>(
            'SELECT amount_off_minor, currency FROM promotions WHERE id = ?',
            [fixed.id],
          )
          expect(fixedRow).toEqual({ amount_off_minor: amount, currency: 'USD' })
          const minRow = await raw.one<{ minimum_subtotal_minor: number; currency: string }>(
            'SELECT minimum_subtotal_minor, currency FROM promotions WHERE id = ?',
            [minimum.id],
          )
          expect(minRow).toEqual({ minimum_subtotal_minor: amount, currency: 'EUR' })
        },
      ),
      { numRuns: 4 },
    )
  })

  it('AC-26: a code equal to another in any case is promotion.code_taken and stores nothing', async () => {
    const code = uniqueCode('Taken')
    await createOk({ code })
    const before = await raw.count('promotions')

    const res = await create(
      valid({ code: code.toUpperCase() === code ? code.toLowerCase() : code.toUpperCase() }),
    )

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error?.code).toBe('promotion.code_taken')
    expect(await raw.count('promotions')).toBe(before)
  })

  it('AC-26: a promotion with a redemption cannot be deleted, keeps its row, and can be set inactive', async () => {
    const promotion = await createOk()
    await writeRaw(
      k.dialect,
      k.target,
      'INSERT INTO promotion_redemptions (promotion_id, order_id, session_id, created_at) VALUES (?, ?, ?, ?)',
      [promotion.id, randomUUID(), 'cart-x', new Date().toISOString()],
    )

    const res = await admin.call('DELETE', `/api/admin/promotions/${promotion.id}`)

    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body.error?.code).toBe('promotion.in_use')
    expect(await raw.count('promotions', 'id = ?', [promotion.id])).toBe(1)

    const off = await admin.call<AdminPromotion>('PATCH', `/api/admin/promotions/${promotion.id}`, {
      active: false,
    })
    expect(off.status, JSON.stringify(off.body)).toBe(200)
    expect(off.body.data!.active).toBe(false)
    const row = await raw.one<{ active: number | boolean }>(
      'SELECT active FROM promotions WHERE id = ?',
      [promotion.id],
    )
    expect(Boolean(row.active)).toBe(false)
  })

  it('AC-26: a promotion with no redemption can be deleted, and an unknown id is 404', async () => {
    const promotion = await createOk()

    const res = await admin.call('DELETE', `/api/admin/promotions/${promotion.id}`)

    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300)
    expect(await raw.count('promotions', 'id = ?', [promotion.id])).toBe(0)
    expect((await admin.call('DELETE', `/api/admin/promotions/${randomUUID()}`)).status).toBe(404)
    expect(
      (await admin.call('PATCH', `/api/admin/promotions/${randomUUID()}`, { active: false }))
        .status,
    ).toBe(404)
  })

  it('AC-26: usedCount is the code’s redemptions whose order is not cancelled', async () => {
    const promotion = await createOk({ code: uniqueCode('Used') })
    const usedCount = async () => (await listed()).find((p) => p.id === promotion.id)!.usedCount

    expect(await usedCount()).toBe(0)
    const seeded = await seedVariant(k, 10, { priceMinor: 1000 })
    const orders: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const shop = await primedShopper(served.baseUrl)
      expect((await readCart(shop)).status).toBe(200)
      expect((await addLine(shop, seeded, 1)).status).toBe(200)
      expect((await putCode(shop, promotion.code)).status).toBe(200)
      const placed = await shop.call<{ orderId: string }>('POST', '/api/checkout', {
        email: `used-${randomUUID()}+stub-pending@promo.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      orders.push(placed.body.data!.orderId)
    }
    expect(await usedCount()).toBe(2)

    await k.services.checkout.cancel(orders[0]!, 'merchant cancelled')

    expect(await usedCount()).toBe(1)
  })

  it('AC-26: the list is newest first, limit defaults to 50 and is at most 200', async () => {
    const created: string[] = []
    for (let i = 0; i < 3; i += 1) created.push((await createOk()).id)

    const limited = await admin.call<PromotionList>('GET', '/api/admin/promotions?limit=2')

    expect(limited.status, JSON.stringify(limited.body)).toBe(200)
    expect(itemsOf(limited.body.data).map((p) => p.id)).toEqual([created[2], created[1]])
    const defaulted = await admin.call<PromotionList>('GET', '/api/admin/promotions')
    expect(itemsOf(defaulted.body.data).length).toBeLessThanOrEqual(50)
    const over = await admin.call<PromotionList>('GET', '/api/admin/promotions?limit=500')
    expect(itemsOf(over.body.data).length).toBeLessThanOrEqual(200)
  })

  it('AC-26: no promotion route is an agent tool, for an admin caller either', async () => {
    const account = await adminAccount(k, served.baseUrl)
    await createOk()

    const names = await listedNames(toolSurface(k.app), account.caller)

    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => /promotion|cart_code|codes/i.test(name))).toEqual([])
  })
})
