import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient, type NymbalClient } from '@nymbalhq/sdk'
import { registerClient } from '../registry.js'

// AC-1: <nymbal-add-to-cart qty> adds the quantity it is given. For any `qty` attribute (an integer inside or outside
// 1-99, a non-integer, a non-number, or none), set before or after the element connects, one click sends one
// `POST /api/cart/items` whose body `qty` is the attribute's integer, or 1 for anything else, clamped to 1-99, and
// emits `nymbal:cart:item-added` with `{ variantId, qty }` of the same quantity. The real SDK client over a fake
// `fetch`, so the request body is the one the API would receive.
//
// A non-integer becomes 1, so a fractional value ("3.7") is 1, not 4. Spellings whose integer-ness is a parsing choice
// ("1e2", "5.0", " 5 ", "0x10") are not generated.

const API = 'http://api.test'
const VARIANT = 'var-variants-qty'
const POLL = { interval: 1, timeout: 1000 }

interface ItemPost {
  variantId: unknown
  qty: unknown
}

/** The quantity an attribute value gives (null: the attribute is absent). */
function expectedQty(attr: string | null): number {
  const n = attr === null || attr.trim() === '' ? Number.NaN : Number(attr)
  const whole = Number.isInteger(n) ? n : 1
  return Math.min(99, Math.max(1, whole))
}

function fakeApi() {
  const posts: ItemPost[] = []
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const cart = (items: unknown[]) => ({
    data: { token: 'cart-variants', items, subtotalMinor: 0, currency: 'GBP' },
  })
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-variants' } })
    if (url.pathname === '/api/cart/items' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as ItemPost
      posts.push(body)
      return json(
        200,
        cart([
          {
            variantId: body.variantId,
            productId: 'prod-variants',
            productName: 'Quantity Widget',
            variantName: 'Default',
            priceMinor: 1000,
            imageUrl: '',
            qty: body.qty,
          },
        ]),
      )
    }
    if (url.pathname === '/api/cart') return json(200, cart([]))
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
  return { posts, fetchImpl }
}

/** Every kind of `qty` value: integers inside and outside 1-99, non-integers, non-numbers, and absent (null). */
const arbQtyAttr: fc.Arbitrary<string | null> = fc.oneof(
  fc.integer({ min: 1, max: 99 }).map(String),
  fc.integer({ min: -1000, max: 1000 }).map(String),
  fc.integer().map(String),
  fc
    .double({ min: -500, max: 500, noNaN: true })
    .filter((x) => !Number.isInteger(x))
    .map(String),
  fc.constantFrom('', 'abc', 'three', 'NaN', 'Infinity', '-Infinity', '2x'),
  fc.constant(null),
)

// The element is a Lit element in an open shadow root; its button is read through `shadowRoot`, once its render has
// settled (`updateComplete`).
function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

let api: ReturnType<typeof fakeApi>
let client: NymbalClient

beforeEach(() => {
  api = fakeApi()
  vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
  client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
  registerClient(client)
})

afterEach(() => {
  client.destroy()
  vi.unstubAllGlobals()
})

describe('add-to-cart takes a quantity', () => {
  it('AC-1: for any qty attribute, one click sends one POST /api/cart/items with qty = the integer or 1, clamped to 1-99, and emits item-added with the same qty', async () => {
    await fc.assert(
      fc.asyncProperty(arbQtyAttr, fc.boolean(), async (attr, setAfterConnect) => {
        const sentBefore = api.posts.length
        const added: unknown[] = []
        const el = document.createElement('nymbal-add-to-cart')
        el.setAttribute('variant-id', VARIANT)
        if (attr !== null && !setAfterConnect) el.setAttribute('qty', attr)
        el.addEventListener('nymbal:cart:item-added', (e) => added.push((e as CustomEvent).detail))
        document.body.appendChild(el)
        await settled(el)
        if (attr !== null && setAfterConnect) el.setAttribute('qty', attr)
        await settled(el)

        // The event follows an async POST; a 1 ms poll keeps 100 runs from costing 100 x waitFor's 50 ms default.
        const root = shadow(el)
        const button = () => root.querySelector('button')!
        await vi.waitFor(() => expect(button().disabled).toBe(false), POLL)
        button().click()
        await vi.waitFor(() => expect(added.length).toBeGreaterThan(0), POLL)
        el.remove()

        const want = expectedQty(attr)
        expect(api.posts.slice(sentBefore).map((p) => p.qty)).toEqual([want])
        expect(added).toEqual([{ variantId: VARIANT, qty: want }])
      }),
      { numRuns: 100 },
    )
  })
})
