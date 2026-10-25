import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cart } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Seeded } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { primedShopper } from '../support/security.js'

// Orders placed over HTTP, by a guest and by a signed-in customer, left pending or paid: the cart token each checkout
// records on its order is read back by no shopper route, by its owner or with the order's key. A stranger with no key
// is not told the order exists. The admin read keeps the token.

const ORDER_KEY_HEADER = 'x-nymbal-order-key'

const CART_COOKIE = 'nymbal.cart'

interface Placed {
  orderNumber: string
  orderKey: string
  cartToken: string
  bearer?: string
}

let served: ServedKernel
let admin: AdminClient
let seeded: Seeded
const placed: Placed[] = []

async function place(opts: { signedIn: boolean; pending: boolean }): Promise<Placed> {
  const shop = await primedShopper(served.baseUrl)
  let bearer: string | undefined
  if (opts.signedIn) {
    const registered = await shop.call<{ accessToken: string }>('POST', '/api/auth/register', {
      email: `owner-${randomUUID()}@orders.test`,
      password: 'orders-correct-horse',
    })
    expect(registered.status, JSON.stringify(registered.body)).toBe(201)
    bearer = registered.body.data!.accessToken
  }
  const auth = bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }
  expect((await shop.call<Cart>('GET', '/api/cart', undefined, auth)).status).toBe(200)
  const added = await shop.call<Cart>(
    'POST',
    '/api/cart/items',
    { variantId: seeded.variantId, qty: 1 },
    auth,
  )
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  const cartToken = shop.jar.get(CART_COOKIE)
  expect(cartToken, 'the cart cookie').toBeDefined()
  const checkout = await shop.call<{ orderNumber: string; orderStatus: string; orderKey: string }>(
    'POST',
    '/api/checkout',
    {
      email: `buyer-${randomUUID()}${opts.pending ? '+stub-pending' : ''}@orders.test`,
      billingAddress: address,
      shippingAddress: address,
    },
    auth,
  )
  expect(checkout.status, JSON.stringify(checkout.body)).toBe(200)
  expect(checkout.body.data!.orderStatus).toBe(opts.pending ? 'pending' : 'confirmed')
  return {
    orderNumber: checkout.body.data!.orderNumber,
    orderKey: checkout.body.data!.orderKey,
    cartToken: cartToken!,
    ...(bearer !== undefined && { bearer }),
  }
}

beforeAll(async () => {
  served = await serveKernel(await createKernel({ dialect: 'sqlite' }))
  admin = await adminClient(served.kernel, served.baseUrl)
  seeded = await seedVariant(served.kernel, 20)
  for (const signedIn of [false, true]) {
    for (const pending of [true, false]) placed.push(await place({ signedIn, pending }))
  }
  await served.kernel.app.relay.drain()
}, 60_000)

afterAll(async () => {
  await served?.stop()
})

async function text(
  path: string,
  bearer?: string,
  key?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(new URL(path, served.baseUrl), {
    headers: {
      accept: 'application/json',
      ...(bearer !== undefined && { authorization: `Bearer ${bearer}` }),
      ...(key !== undefined && { [ORDER_KEY_HEADER]: key }),
    },
  })
  return { status: res.status, text: await res.text() }
}

describe('a placed order’s cart token', () => {
  it('is in no shopper response: not GET /api/orders/:orderNumber read with its key or by its owner, nor GET /api/orders; a stranger with no key gets the not-found answer of a number no order has; the admin order read still carries it', async () => {
    const reads: Array<{ label: string; path: string; bearer?: string; key?: string }> = []
    for (const o of placed) {
      reads.push({
        label: `${o.orderNumber} read with its key`,
        path: `/api/orders/${o.orderNumber}`,
        key: o.orderKey,
      })
      if (o.bearer !== undefined) {
        reads.push(
          {
            label: `its owner reads ${o.orderNumber}`,
            path: `/api/orders/${o.orderNumber}`,
            bearer: o.bearer,
          },
          { label: `its owner lists ${o.orderNumber}`, path: '/api/orders', bearer: o.bearer },
        )
      }
    }
    const tokens = placed.map((o) => o.cartToken)
    for (const { label, path, bearer, key } of reads) {
      const answer = await text(path, bearer, key)
      expect(answer.status, `${label}: ${answer.text}`).toBe(200)
      for (const token of tokens)
        expect(answer.text.includes(token), `${label} carries a cart token`).toBe(false)
    }
    for (const o of placed) {
      const unknown = `NONE-${randomUUID().slice(0, 8)}`
      const missing = await text(`/api/orders/${unknown}`)
      const stranger = await text(`/api/orders/${o.orderNumber}`)
      expect(stranger.status, `a stranger reads ${o.orderNumber}`).toBe(missing.status)
      expect(JSON.parse(stranger.text), `a stranger reads ${o.orderNumber}`).toEqual(
        JSON.parse(missing.text.replaceAll(unknown, o.orderNumber)),
      )
    }
    const listed = await Promise.all(
      placed
        .filter((o) => o.bearer !== undefined)
        .map(async (o) => {
          const answer = await text('/api/orders', o.bearer)
          return (JSON.parse(answer.text) as { data: Array<{ orderNumber: string }> }).data.map(
            (x) => x.orderNumber,
          )
        }),
    )
    expect(listed, 'each owner lists their order').toEqual(
      placed.filter((o) => o.bearer !== undefined).map((o) => [o.orderNumber]),
    )

    for (const o of placed) {
      const read = await admin.call<{ metadata: { cartToken?: string } }>(
        'GET',
        `/api/admin/orders/${o.orderNumber}`,
      )
      expect(read.status, JSON.stringify(read.body)).toBe(200)
      expect(read.body.data!.metadata.cartToken, `the admin read of ${o.orderNumber}`).toBe(
        o.cartToken,
      )
    }
  })
})
