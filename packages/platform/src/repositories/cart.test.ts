import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { createCartRepository } from './cart.js'

// Cart rows on the SQLite command store: what each query answers for carts at known times relative to `at`.

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  return { store, carts: createCartRepository(store) }
}
type Env = Awaited<ReturnType<typeof setup>>

const AT = Date.parse('2026-06-01T12:00:00.000Z')
const iso = (offsetMinutes: number): string => new Date(AT + offsetMinutes * 60_000).toISOString()

let sequence = 0
function cartAt(
  fields: { customerId?: string | null; updated?: number; expires?: number; lines?: number } = {},
): Cart {
  sequence += 1
  const lines = fields.lines ?? 1
  const items = Array.from({ length: lines }, (_, n) => ({
    variantId: `v-${n}`,
    productId: `p-${n}`,
    productName: 'Widget',
    variantName: 'Default',
    priceMinor: 250,
    imageUrl: '',
    qty: n + 1,
  }))
  return {
    token: `cart-${String(sequence).padStart(6, '0')}`,
    customerId: fields.customerId ?? null,
    items,
    subtotalMinor: items.reduce((s, i) => s + i.priceMinor * i.qty, 0),
    currency: 'GBP',
    createdAt: iso((fields.updated ?? -10) - 5),
    updatedAt: iso(fields.updated ?? -10),
    expiresAt: iso(fields.expires ?? 60),
  }
}

const put = (env: Env, ...carts: Cart[]) =>
  env.store.transaction(async (tx) => {
    for (const cart of carts) await env.carts.put(tx, cart)
  })
const read = (env: Env, token: string) => env.store.read((tx) => env.carts.findByToken(tx, token))

describe('cart repository (sqlite)', () => {
  it('put then findByToken answers the cart as written, its customer included', async () => {
    const env = await setup()
    const owned = cartAt({ customerId: 'cust-1', lines: 2 })
    const guest = cartAt({ customerId: null })
    await put(env, owned, guest)
    expect(await read(env, owned.token)).toEqual(owned)
    expect(await read(env, guest.token)).toEqual(guest)
  })

  it('create inserts a new token, replaces an expired row, and leaves a live row as it was with created false', async () => {
    const env = await setup()
    const live = cartAt({ customerId: 'cust-live', expires: 30 })
    const expired = cartAt({ customerId: 'cust-old', expires: -30 })
    await put(env, live, expired)
    const fresh = cartAt({ updated: 0 })
    const create = (cart: Cart) => env.store.transaction((tx) => env.carts.create(tx, cart))

    const onFresh = await create(fresh)
    const onLive = await create({ ...cartAt({ updated: 0 }), token: live.token })
    const replacing = { ...cartAt({ updated: 0 }), token: expired.token }
    const onExpired = await create(replacing)

    expect(onFresh).toEqual({ cart: fresh, created: true })
    expect(onLive).toEqual({ cart: live, created: false })
    expect(onExpired).toEqual({ cart: replacing, created: true })
    expect(await read(env, live.token)).toEqual(live)
  })

  it("property: findLiveByCustomer answers the customer's most recently written cart live at `at`, never another's, null for none", async () => {
    const env = await setup()
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            mine: fc.boolean(),
            expires: fc.integer({ min: -60, max: 60 }),
          }),
          { maxLength: 6 },
        ),
        async (shapes) => {
          run += 1
          const me = `cust-${run}`
          // Distinct write times, oldest first, so "most recent" has one answer.
          const carts = shapes.map((s, n) =>
            cartAt({
              customerId: s.mine ? me : `other-${run}`,
              updated: -100 + n,
              expires: s.expires,
            }),
          )
          await put(env, ...carts)

          const found = await env.store.read((tx) =>
            env.carts.findLiveByCustomer(tx, me, new Date(AT)),
          )

          const candidates = carts.filter(
            (c) => c.customerId === me && Date.parse(c.expiresAt) > AT,
          )
          expect(found).toEqual(candidates.at(-1) ?? null)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('clearIfLive empties a live cart and keeps its expiry; an expired or missing cart answers false and is left as it was', async () => {
    const env = await setup()
    const live = cartAt({ lines: 3, expires: 30 })
    const expired = cartAt({ lines: 2, expires: 0 })
    await put(env, live, expired)
    const clear = (token: string) =>
      env.store.transaction((tx) => env.carts.clearIfLive(tx, token, new Date(AT)))

    const answers = [await clear(live.token), await clear(expired.token), await clear('no-such')]

    expect(answers).toEqual([true, false, false])
    expect(await read(env, live.token)).toEqual({
      ...live,
      items: [],
      subtotalMinor: 0,
      updatedAt: iso(0),
    })
    expect(await read(env, expired.token)).toEqual(expired)
  })

  it('deleteExpired deletes exactly the carts whose expiry is at or before `at`, and answers how many', async () => {
    const env = await setup()
    const carts = [-30, -1, 0, 1, 30].map((expires) => cartAt({ expires }))
    await put(env, ...carts)

    const deleted = await env.store.transaction((tx) => env.carts.deleteExpired(tx, new Date(AT)))

    const gone = carts.filter((c) => Date.parse(c.expiresAt) <= AT)
    expect(deleted).toBe(gone.length)
    for (const c of carts) {
      expect(await read(env, c.token), c.expiresAt).toEqual(gone.includes(c) ? null : c)
    }
  })

  it('listAbandoned pages through, in token order, exactly the live carts with lines unwritten since the cutoff and not yet claimed; claimAbandoned claims each once', async () => {
    const env = await setup()
    const window = { cutoff: new Date(AT - 30 * 60_000), at: new Date(AT) }
    const due = [cartAt({ updated: -40 }), cartAt({ updated: -90 }), cartAt({ updated: -31 })]
    const notDue = [
      cartAt({ updated: -30 }), // written at the cutoff
      cartAt({ updated: -5 }),
      cartAt({ updated: -40, lines: 0 }),
      cartAt({ updated: -40, expires: 0 }),
    ]
    await put(env, ...due, ...notDue)
    const list = async (): Promise<string[]> => {
      const tokens: string[] = []
      let after: string | undefined
      for (;;) {
        const page = await env.store.read((tx) =>
          env.carts.listAbandoned(tx, window, { after, limit: 2 }),
        )
        tokens.push(...page)
        if (page.length < 2) return tokens
        after = page.at(-1)
      }
    }

    expect(await list()).toEqual(due.map((c) => c.token).sort())

    const claim = (token: string) =>
      env.store.transaction((tx) => env.carts.claimAbandoned(tx, token, window))
    const [first] = due
    const claims = [
      await claim(first!.token),
      await claim(first!.token),
      await claim(notDue[0]!.token),
    ]
    expect(claims).toEqual([{ token: first!.token, lastActivityAt: first!.updatedAt }, null, null])
    expect(await list()).toEqual(
      due
        .slice(1)
        .map((c) => c.token)
        .sort(),
    )

    // A write starts a new inactivity period: the claim is cleared.
    await put(env, first!)
    expect(await list()).toEqual(due.map((c) => c.token).sort())
  })
})
