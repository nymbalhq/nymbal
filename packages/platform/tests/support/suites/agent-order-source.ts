import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handoffPath } from '../../../src/agents/catalog.js'
import {
  agentCaller,
  cartTokenOf,
  openContinueUrl,
  serveWithAgents,
  storedCartSource,
  ucpCheckout,
  type AgentStore,
} from '../agents.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { adminAccount, type Account } from '../mcp.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'
import { unaudited } from '../write-audit.js'

// AC-4 on one dialect: an order carries the source of the cart it was placed from, through the buyer's sign-in. Each
// run opens one to four carts, by an agent's tool call (one of three agents) or over HTTP, and hands each agent cart to
// a buyer's browser through its continue_url. Some buyers sign in: the guest cart folds into a customer cart of either
// source, or is claimed, or is merged into a customer token whose cart has expired. Then each cart is checked out up
// to twice (twice only while its order is pending, so the second reuses it). The reference: a cart keeps the source it
// was opened with; a fold gives the merged cart the guest cart's source when the guest cart had lines and leaves the
// kept cart's otherwise; a claim and a merge into an expired token keep the guest's.

const AGENTS = ['shopper-one.example', 'shopper-two', 'shopper-three'] as const
const PASSWORD = 'source-correct-horse'

type Shop = Awaited<ReturnType<typeof primedShopper>>

const source = fc.oneof(
  fc.constant('storefront'),
  fc.constantFrom(...AGENTS).map((name) => `agent:${name}`),
)
const signIn = fc.oneof(
  fc.constant({ kind: 'none' as const }),
  fc.constant({ kind: 'claim' as const }),
  fc.record({
    kind: fc.constant('fold' as const),
    customer: source,
    customerLines: fc.integer({ min: 0, max: 2 }),
  }),
  fc.record({ kind: fc.constant('merge' as const), customer: source }),
)
const plan = fc.record({
  opened: source,
  lines: fc.integer({ min: 0, max: 2 }),
  signIn,
  checkouts: fc.integer({ min: 0, max: 2 }),
  pays: fc.boolean(),
})

interface PlanShape {
  opened: string
  lines: number
  signIn:
    | { kind: 'none' }
    | { kind: 'claim' }
    | { kind: 'fold'; customer: string; customerLines: number }
    | { kind: 'merge'; customer: string }
  checkouts: number
  pays: boolean
}

function describePlan(p: PlanShape): string {
  const how =
    p.signIn.kind === 'fold'
      ? `fold into ${p.signIn.customer} (${p.signIn.customerLines} lines)`
      : p.signIn.kind === 'merge'
        ? `merge into an expired ${p.signIn.customer} token`
        : p.signIn.kind
  return `${p.opened} (${p.lines} lines), ${how}, ${p.checkouts} checkout(s)${p.pays ? ', paying' : ''}`
}

/** What one cart was observed to be, in the shape the reference states it. */
interface Seen {
  plan: string
  /** The cart's source read through the repository once the sign-in is done: at placement. */
  atPlacement: string | undefined
  /** Distinct orders the checkouts answered. */
  orders: number
  /** Order rows naming the cart. */
  rowsForCart: number
  sources: Array<string | undefined>
  adminSources: Array<string | undefined>
}

export interface AgentOrderSourceSuiteOptions {
  /** fast-check runs of the property. */
  runs: number
}

export function agentOrderSourceSuite(
  dialect: Kernel['dialect'],
  start: () => Promise<Kernel>,
  opts: AgentOrderSourceSuiteOptions,
): void {
  describe(`AC-4: an order carries its cart's source (${dialect})`, () => {
    let store: AgentStore
    let k: Kernel
    let raw: RawReader
    let admin: Account
    let pool: Seeded[]

    beforeAll(async () => {
      k = await start()
      store = await serveWithAgents(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminAccount(k, store.baseUrl)
      pool = []
      for (let i = 0; i < 3; i += 1)
        pool.push(await seedVariant(k, 1_000_000, { priceMinor: 1200 + i * 75 }))
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await store?.stop()
    })

    const lineOf = (seeded: Seeded) => ({
      variantId: seeded.variantId,
      productId: seeded.productId,
      productName: 'Transactional Widget',
      variantName: 'Default',
      priceMinor: seeded.priceMinor,
      imageUrl: '',
      qty: 1,
    })

    /** The guest cart as the plan opens it, in a browser of its own that holds its cookie. */
    async function open(p: PlanShape): Promise<Shop> {
      const shop = await primedShopper(store.baseUrl)
      const variants = pool.slice(0, p.lines)
      if (p.opened === 'storefront') {
        await shop.call('GET', '/api/cart')
        for (const v of variants) {
          const added = await shop.call('POST', '/api/cart/items', {
            variantId: v.variantId,
            qty: 1,
          })
          if (added.status !== 200) throw new Error(`add: ${JSON.stringify(added.body)}`)
        }
        return shop
      }
      const caller = agentCaller(p.opened.slice('agent:'.length))
      if (variants.length > 0) {
        const checkout = await ucpCheckout(
          store,
          caller,
          variants.map((v) => v.variantId),
        )
        await openContinueUrl(checkout.continueUrl, shop.jar)
        return shop
      }
      const opened = await store.mcp.call('cart_get', {}, caller)
      const handle = opened.structuredContent?.['cartHandle']
      if (typeof handle !== 'string') throw new Error(`cart_get: ${JSON.stringify(opened)}`)
      await openContinueUrl(`${store.baseUrl}${handoffPath(handle)}`, shop.jar)
      return shop
    }

    async function customer(): Promise<{ id: string; email: string }> {
      const email = `source-${randomUUID()}@orders.test`
      const { customer: c } = await k.services.auth.register({ email, password: PASSWORD })
      return { id: c.id, email }
    }

    async function login(shop: Shop, email: string): Promise<string> {
      const res = await shop.call<{ accessToken: string }>('POST', '/api/auth/login', {
        email,
        password: PASSWORD,
      })
      if (res.status !== 200) throw new Error(`login: ${JSON.stringify(res.body)}`)
      return res.body.data!.accessToken
    }

    /** A customer's own cart opened with `cartSource`, holding `lines` lines. */
    async function customerCart(customerId: string, cartSource: string, lines: number) {
      const cart = await k.services.cart.getOrCreate(
        undefined,
        customerId,
        cartSource as 'storefront' | `agent:${string}`,
      )
      for (const v of pool.slice(1, 1 + lines)) await k.services.cart.addItem(cart.token, lineOf(v))
      return cart
    }

    /** Runs the plan's sign-in; answers the bearer, if any, and the source the reference gives the cart. */
    async function signInFor(
      shop: Shop,
      p: PlanShape,
    ): Promise<{ bearer: string | undefined; expected: string }> {
      const s = p.signIn
      if (s.kind === 'none') return { bearer: undefined, expected: p.opened }
      const who = await customer()
      if (s.kind === 'claim') return { bearer: await login(shop, who.email), expected: p.opened }
      if (s.kind === 'fold') {
        await customerCart(who.id, s.customer, s.customerLines)
        return {
          bearer: await login(shop, who.email),
          expected: p.lines > 0 ? p.opened : s.customer,
        }
      }
      const own = await customerCart(who.id, s.customer, 0)
      const lapsed = new Date(Date.now() - 60_000).toISOString()
      await unaudited(() =>
        k.store.transaction((tx) => k.repos.cart.put(tx, { ...own, expiresAt: lapsed })),
      )
      await k.services.cart.merge(cartTokenOf(shop.jar), own.token)
      shop.jar.set('nymbal.cart', own.token)
      return { bearer: undefined, expected: p.opened }
    }

    async function checkout(shop: Shop, bearer: string | undefined, email: string) {
      const res = await shop.call<{ orderId: string; orderNumber: string }>(
        'POST',
        '/api/checkout',
        { email, billingAddress: address, shippingAddress: address },
        bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } },
      )
      if (res.status !== 200) throw new Error(`checkout: ${res.status} ${JSON.stringify(res.body)}`)
      return res.body.data!
    }

    async function adminSource(orderNumber: string): Promise<string | undefined> {
      const res = await fetch(
        new URL(`/api/admin/orders/${encodeURIComponent(orderNumber)}`, store.baseUrl),
        { headers: { accept: 'application/json', authorization: `Bearer ${admin.token}` } },
      )
      const body = (await res.json()) as { data?: { source?: string } }
      if (res.status !== 200) throw new Error(`admin order: ${res.status} ${JSON.stringify(body)}`)
      return body.data?.source
    }

    async function run(plans: PlanShape[]): Promise<{ seen: Seen[]; want: Seen[] }> {
      const seen: Seen[] = []
      const want: Seen[] = []
      for (const p of plans) {
        const shop = await open(p)
        const { bearer, expected } = await signInFor(shop, p)
        const token = cartTokenOf(shop.jar)
        const atPlacement = await storedCartSource(k, token)
        const lines = (await k.services.cart.get(token))?.items.length ?? 0
        const attempts = lines > 0 ? p.checkouts : 0
        const tag = randomUUID()
        const answers: Array<{ orderId: string; orderNumber: string }> = []
        for (let i = 0; i < attempts; i += 1) {
          // Twice only while pending, so the second meets the first's order.
          const pending = attempts === 2 || !p.pays
          answers.push(
            await checkout(
              shop,
              bearer,
              pending ? `source-${tag}+stub-pending@orders.test` : `source-${tag}@orders.test`,
            ),
          )
        }
        const distinct = [...new Map(answers.map((a) => [a.orderId, a])).values()]
        const sources: Array<string | undefined> = []
        const adminSources: Array<string | undefined> = []
        for (const a of distinct) {
          sources.push((await k.services.order.getById(a.orderId)).source)
          adminSources.push(await adminSource(a.orderNumber))
        }
        const placed = attempts > 0 ? 1 : 0
        const label = describePlan(p)
        seen.push({
          plan: label,
          atPlacement,
          orders: distinct.length,
          rowsForCart: await raw.count('orders', 'cart_token = ?', [token]),
          sources,
          adminSources,
        })
        want.push({
          plan: label,
          atPlacement: expected,
          orders: placed,
          rowsForCart: placed,
          sources: placed === 1 ? [expected] : [],
          adminSources: placed === 1 ? [expected] : [],
        })
      }
      return { seen, want }
    }

    // Kills: the order inserted without its cart's source, a fold that keeps the customer cart's source over a guest
    // cart with lines (or takes an empty guest cart's), a merge write that leaves the expired row's source, a reused
    // pending order that becomes a second order, an admin answer that drops the field.
    it(`AC-4: property: every order's source is its cart's at placement (the guest cart's after a fold when it had lines), each cart has at most one order, and GET /api/admin/orders/:orderNumber answers the same source (${dialect})`, async () => {
      const agent = `agent:${AGENTS[0]}`
      await fc.assert(
        fc.asyncProperty(fc.array(plan, { minLength: 1, maxLength: 4 }), async (plans) => {
          const { seen, want } = await run(plans)
          expect(seen).toEqual(want)
        }),
        {
          numRuns: opts.runs,
          examples: [
            [
              [
                {
                  opened: agent,
                  lines: 2,
                  signIn: { kind: 'fold', customer: 'storefront', customerLines: 1 },
                  checkouts: 2,
                  pays: false,
                },
                {
                  opened: 'storefront',
                  lines: 0,
                  signIn: { kind: 'fold', customer: `agent:${AGENTS[1]}`, customerLines: 2 },
                  checkouts: 1,
                  pays: true,
                },
                {
                  opened: `agent:${AGENTS[2]}`,
                  lines: 1,
                  signIn: { kind: 'merge', customer: 'storefront' },
                  checkouts: 1,
                  pays: true,
                },
                {
                  opened: agent,
                  lines: 1,
                  signIn: { kind: 'claim' },
                  checkouts: 1,
                  pays: false,
                },
              ],
            ],
          ],
        },
      )
    }, 300_000)
  })
}
