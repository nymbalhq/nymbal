import { describe, expect, it } from 'vitest'
import { v7 as uuidv7 } from 'uuid'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from './index.js'
import type { PromotionInsert } from './promotion.js'

// Promotions as rows on a migrated SQLite store: codes are unique in any case, a patch touches only what it names,
// and a use counts against a cap until its order is cancelled.

const CREATED = new Date('2026-06-01T10:00:00.000Z')

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  return { store, repo: repos.promotion, repos }
}
type Env = Awaited<ReturnType<typeof setup>>

function promotion(overrides: Partial<PromotionInsert> = {}): PromotionInsert {
  return {
    id: uuidv7(),
    code: `CODE-${uuidv7().slice(-8)}`,
    kind: 'percent',
    percentBps: 1000,
    amountOffMinor: null,
    currency: null,
    minimumSubtotalMinor: null,
    expiresAt: null,
    usageCap: null,
    active: true,
    createdAt: CREATED,
    ...overrides,
  }
}

const insert = (env: Env, row: PromotionInsert) =>
  env.store.transaction((tx) => env.repo.insert(tx, row))
const byId = (env: Env, id: string) => env.store.read((tx) => env.repo.findById(tx, id))

let sequence = 0
async function order(env: Env, status: 'pending' | 'confirmed' | 'cancelled'): Promise<string> {
  const id = uuidv7()
  sequence += 1
  await env.store.transaction((tx) =>
    env.repos.order.insert(tx, {
      id,
      orderNumber: `OR-${sequence}-${id.slice(-6)}`,
      sequence,
      customerId: null,
      status,
      email: 'o@example.com',
      billingAddress: {} as never,
      shippingAddress: {} as never,
      lineItems: [],
      subtotalMinor: 9000,
      taxTotalMinor: 0,
      shippingTotalMinor: 0,
      discountTotalMinor: 0,
      totalMinor: 9000,
      currency: 'GBP',
      notes: '',
      metadata: {},
      paymentIntentId: null,
      createdAt: CREATED,
      updatedAt: CREATED,
    }),
  )
  return id
}

const redeem = (env: Env, promotionId: string, orderId: string, sessionId: string) =>
  env.store.transaction((tx) =>
    env.repo.addRedemption(tx, { promotionId, orderId, sessionId, createdAt: CREATED }),
  )

describe('PromotionRepository: rows', () => {
  it('insert answers true and stores every field; a code equal in any case answers false and stores nothing', async () => {
    const env = await setup()
    const expiresAt = new Date('2026-07-01T00:00:00.000Z')
    const row = promotion({ code: 'SUMMER', expiresAt, usageCap: 3 })
    expect(await insert(env, row)).toBe(true)
    expect(await byId(env, row.id)).toEqual({
      ...row,
      expiresAt: expiresAt.toISOString(),
      createdAt: CREATED.toISOString(),
      updatedAt: CREATED.toISOString(),
    })

    const clash = promotion({ code: 'summer' })
    expect(await insert(env, clash)).toBe(false)
    expect(await byId(env, clash.id)).toBeNull()
  })

  it('a promotion with no expiry reads back with none', async () => {
    const env = await setup()
    const row = promotion()
    await insert(env, row)
    expect((await byId(env, row.id))?.expiresAt).toBeNull()
  })

  it('findByCodes matches any case, leaves other codes out, and answers nothing for no codes', async () => {
    const env = await setup()
    const [wanted, other] = [promotion({ code: 'Wanted' }), promotion({ code: 'OTHER' })]
    await insert(env, wanted)
    await insert(env, other)
    const found = await env.store.read((tx) => env.repo.findByCodes(tx, ['wANTED', 'absent']))
    expect(found.map((p) => p.id)).toEqual([wanted.id])
    expect(await env.store.read((tx) => env.repo.findByCodes(tx, []))).toEqual([])
  })

  it('update changes what the patch names and the updated time, sets and clears an expiry, and answers null for no row', async () => {
    const env = await setup()
    const row = promotion({ usageCap: 7 })
    await insert(env, row)
    const later = new Date('2026-06-02T10:00:00.000Z')
    const expiresAt = new Date('2026-08-01T00:00:00.000Z')

    const set = await env.store.transaction((tx) =>
      env.repo.update(tx, row.id, { active: false, expiresAt }, later),
    )
    expect(set).toMatchObject({
      active: false,
      expiresAt: expiresAt.toISOString(),
      usageCap: 7,
      code: row.code,
      createdAt: CREATED.toISOString(),
      updatedAt: later.toISOString(),
    })
    expect(await byId(env, row.id)).toEqual(set)

    const untouched = await env.store.transaction((tx) =>
      env.repo.update(tx, row.id, { usageCap: 9 }, later),
    )
    expect(untouched).toEqual({ ...set, usageCap: 9 })

    const cleared = await env.store.transaction((tx) =>
      env.repo.update(tx, row.id, { expiresAt: null }, later),
    )
    expect(cleared).toEqual({ ...untouched, expiresAt: null })

    const missing = await env.store.transaction((tx) =>
      env.repo.update(tx, 'no-such-id', { active: false }, later),
    )
    expect(missing).toBeNull()
  })

  it('delete removes that promotion and leaves another', async () => {
    const env = await setup()
    const [gone, kept] = [promotion(), promotion()]
    await insert(env, gone)
    await insert(env, kept)
    await env.store.transaction((tx) => env.repo.delete(tx, gone.id))
    expect(await byId(env, gone.id)).toBeNull()
    expect((await byId(env, kept.id))?.id).toBe(kept.id)
  })
})

describe('PromotionRepository: uses', () => {
  it('list is newest first within its limit, and counts every use but a cancelled order’s', async () => {
    const env = await setup()
    const oldest = promotion({ createdAt: new Date('2026-06-01T00:00:00.000Z') })
    const middle = promotion({ createdAt: new Date('2026-06-02T00:00:00.000Z') })
    const newest = promotion({ createdAt: new Date('2026-06-03T00:00:00.000Z') })
    for (const row of [oldest, newest, middle]) await insert(env, row)
    await redeem(env, newest.id, await order(env, 'confirmed'), 's1')
    await redeem(env, newest.id, await order(env, 'pending'), 's2')
    await redeem(env, newest.id, await order(env, 'cancelled'), 's3')

    const listed = await env.store.read((tx) => env.repo.list(tx, 2))
    expect(listed.map((p) => [p.id, p.usedCount])).toEqual([
      [newest.id, 2],
      [middle.id, 0],
    ])
    expect(listed[0]).toMatchObject({ code: newest.code, percentBps: 1000 })
  })

  it('redeemed is false before any use and stays true when the only order is cancelled', async () => {
    const env = await setup()
    const [used, unused] = [promotion(), promotion()]
    await insert(env, used)
    await insert(env, unused)
    await redeem(env, used.id, await order(env, 'cancelled'), 's1')
    expect(await env.store.read((tx) => env.repo.redeemed(tx, used.id))).toBe(true)
    expect(await env.store.read((tx) => env.repo.redeemed(tx, unused.id))).toBe(false)
  })

  it('usesAgainstCap leaves out a cancelled order and this session’s own pending one, and counts any other', async () => {
    const env = await setup()
    const row = promotion()
    const other = promotion()
    await insert(env, row)
    await insert(env, other)
    await redeem(env, row.id, await order(env, 'confirmed'), 'mine')
    await redeem(env, row.id, await order(env, 'pending'), 'theirs')
    await redeem(env, row.id, await order(env, 'pending'), 'mine')
    await redeem(env, row.id, await order(env, 'cancelled'), 'theirs')
    await redeem(env, other.id, await order(env, 'confirmed'), 'mine')
    const uses = (session: string) =>
      env.store.read((tx) => env.repo.usesAgainstCap(tx, row.id, session))
    expect(await uses('mine')).toBe(2)
    expect(await uses('theirs')).toBe(2)
    expect(await uses('nobody')).toBe(3)
  })

  it('the same order redeeming again changes nothing', async () => {
    const env = await setup()
    const row = promotion()
    await insert(env, row)
    const paid = await order(env, 'confirmed')
    await redeem(env, row.id, paid, 's1')
    await redeem(env, row.id, paid, 's1')
    expect(await env.store.read((tx) => env.repo.usesAgainstCap(tx, row.id, 's2'))).toBe(1)
  })
})
