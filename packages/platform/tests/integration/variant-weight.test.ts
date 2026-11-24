import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSession, type AdminSession, type Answer } from '../support/audit.js'
import { DEFAULT_GRAMS, parcelGrams, scriptedCarrier, withCarrier } from '../support/carrier.js'
import type { ScriptedCarrier } from '../support/carrier.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { addLine, readCart } from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import { quote } from '../support/shipping.js'

// A variant's weight through the admin API on a carrier-priced store (SQLite): a whole number of grams from 0 to
// 1,000,000, or none, set on create and on update and read back; anything else refused whole before it reaches the
// integer column; and the weight the admin sets is the one the carrier is asked to rate, in place of the store's
// default for a unit with none.

type Json = Record<string, unknown>

interface Store {
  k: Kernel
  served: ServedKernel
  admin: AdminSession
  raw: RawReader
  carrier: ScriptedCarrier
}

let s: Store

beforeAll(async () => {
  const carrier = scriptedCarrier()
  const k = await createKernel({
    dialect: 'sqlite',
    configure: withCarrier(),
    appOptions: { adapters: { shipping: carrier.adapter } },
  })
  const served = await serveKernel(k)
  s = {
    k,
    served,
    admin: await adminSession(k, served.baseUrl),
    raw: openRaw(k.dialect, k.target),
    carrier,
  }
}, 60_000)

afterAll(async () => {
  s?.carrier.recover()
  await s?.raw.close()
  await s?.served.stop()
})

const variantsOf = (snapshot: Json): Json[] => snapshot['variants'] as Json[]
const weightsOf = (snapshot: Json): unknown[] => variantsOf(snapshot).map((v) => v['weightGrams'])

function productBody(tag: string, weights: [unknown, unknown] = [null, null]): Json {
  return {
    slug: `weighed-${tag}`,
    name: `Weighed ${tag}`,
    status: 'active',
    variants: [
      {
        sku: `WG-0-${tag}`,
        name: 'Small',
        priceMinor: 1500,
        stock: 50,
        options: [],
        weightGrams: weights[0],
      },
      {
        sku: `WG-1-${tag}`,
        name: 'Large',
        priceMinor: 1900,
        stock: 50,
        options: [],
        weightGrams: weights[1],
      },
    ],
  }
}

async function made(tag = randomUUID().slice(0, 8)): Promise<Json> {
  const res = await s.admin.send<Json>('POST', '/api/admin/products', productBody(tag))
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data!
}

async function adminRead(id: string): Promise<Json> {
  const res = await s.admin.send<Json>('GET', `/api/admin/products/${id}`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

async function patchWeight(
  product: Json,
  index: number,
  weightGrams: unknown,
): Promise<Answer<Json>> {
  const v = variantsOf(product)[index]!
  return s.admin.send<Json>('PATCH', `/api/admin/products/${String(product['id'])}`, {
    variants: [{ id: v['id'], priceMinor: v['priceMinor'], weightGrams }],
  })
}

/** The refusal's code and its issue paths, joined (`body.variants.0.weightGrams`). */
function refusal(answer: Answer<Json>): [number, string | undefined, string[]] {
  const error = answer.body.error as
    | { code?: string; context?: { issues?: Array<{ path: unknown[] }> } }
    | undefined
  return [answer.status, error?.code, (error?.context?.issues ?? []).map((i) => i.path.join('.'))]
}

/** Not a whole number of grams from 0 to 1,000,000. */
const NOT_WEIGHTS: unknown[] = [-1, 1.5, 1_000_001, '750']

describe('a variant’s weight through the admin API', () => {
  // Kills: the update's variant entry dropping weightGrams, so a weight sent is answered as none with a 200.
  it('AC-2: PATCH /api/admin/products/:id with variants [{ id, priceMinor, weightGrams: 750 }] answers the product with that weight, the other variant keeping none, and GET /api/admin/products/:id reads the same', async () => {
    const product = await made()

    const res = await patchWeight(product, 0, 750)

    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(weightsOf(res.body.data!)).toEqual([750, null])
    expect(weightsOf(await adminRead(String(product['id'])))).toEqual(weightsOf(res.body.data!))
  })

  // Kills: a bound off by one (positive() refusing 0, a max of 999,999), or a null refused instead of clearing.
  it('AC-2: the bounds 0 and 1,000,000 are stored on create and on update, and null on update clears a weight', async () => {
    const tag = randomUUID().slice(0, 8)
    const created = await s.admin.send<Json>(
      'POST',
      '/api/admin/products',
      productBody(tag, [0, 1_000_000]),
    )
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const product = created.body.data!
    const id = String(product['id'])
    expect(weightsOf(product), 'as created').toEqual([0, 1_000_000])

    const steps: Array<[number, number | null, unknown[]]> = [
      [0, 1_000_000, [1_000_000, 1_000_000]],
      [1, 0, [1_000_000, 0]],
      [0, null, [null, 0]],
    ]
    for (const [index, grams, expected] of steps) {
      const res = await patchWeight(product, index, grams)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect(weightsOf(await adminRead(id)), `variant ${index} set to ${String(grams)}`).toEqual(
        expected,
      )
    }
  })

  // Kills: create's "any number" left as it was, so 1.5 reaches the integer column (a 500 on Postgres, a fraction on
  // SQLite), or a weight refused on one route and taken on the other.
  it('AC-2: weightGrams of -1, 1.5, 1,000,001 or "750" is 400 validation.failed naming the variant’s weightGrams on PATCH and on POST, and nothing is stored: the product reads as before, no product is created and no event is written', async () => {
    const product = await made()
    const id = String(product['id'])
    const before = await adminRead(id)

    for (const bad of NOT_WEIGHTS) {
      const label = JSON.stringify(bad)
      const seq = await maxSeq(s.raw)
      const patched = await patchWeight(product, 0, bad)
      expect(refusal(patched), `PATCH ${label}: ${JSON.stringify(patched.body)}`).toEqual([
        400,
        'validation.failed',
        ['body.variants.0.weightGrams'],
      ])
      expect(await adminRead(id), `PATCH ${label}: the product`).toEqual(before)

      const body = productBody(randomUUID().slice(0, 8), [null, bad])
      const posted = await s.admin.send<Json>('POST', '/api/admin/products', body)
      expect(refusal(posted), `POST ${label}: ${JSON.stringify(posted.body)}`).toEqual([
        400,
        'validation.failed',
        ['body.variants.1.weightGrams'],
      ])
      expect(
        await s.raw.count('products', 'slug = ?', [body['slug']]),
        `POST ${label}: products`,
      ).toBe(0)
      expect(
        (await eventRows(s.raw, 'seq > ?', [seq])).map((e) => e.type),
        `${label}: events`,
      ).toEqual([])
    }
  })

  it('a refused weight’s issue names the rule, whole grams from 0 to 1,000,000, on PATCH and on POST', async () => {
    const product = await made()
    const issueOf = (answer: Answer<Json>) =>
      (
        (
          answer.body.error as {
            context?: { issues?: Array<{ path: unknown[]; message: string }> }
          }
        )?.context?.issues ?? []
      ).map((i) => [i.path.join('.'), i.message])

    for (const bad of NOT_WEIGHTS) {
      const label = JSON.stringify(bad)
      const patched = await patchWeight(product, 0, bad)
      expect(issueOf(patched), `PATCH ${label}`).toEqual([
        ['body.variants.0.weightGrams', 'a weight is whole grams from 0 to 1,000,000'],
      ])
      const posted = await s.admin.send<Json>(
        'POST',
        '/api/admin/products',
        productBody(randomUUID().slice(0, 8), [null, bad]),
      )
      expect(issueOf(posted), `POST ${label}`).toEqual([
        ['body.variants.1.weightGrams', 'a weight is whole grams from 0 to 1,000,000'],
      ])
    }
  })
})

/** The parcel weight the carrier is asked to rate for a fresh shopper's cart of `qty` of each variant. */
async function ratedParcel(product: Json, qty: [number, number]): Promise<number | undefined> {
  await s.k.app.relay.drain()
  const shop = await primedShopper(s.served.baseUrl)
  expect((await readCart(shop)).status).toBe(200)
  for (const [i, v] of variantsOf(product).entries()) {
    const added = await addLine(
      shop,
      {
        productId: String(product['id']),
        variantId: String(v['id']),
        priceMinor: 0,
        initialStock: 0,
      },
      qty[i]!,
    )
    expect(added.status, JSON.stringify(added.body)).toBe(200)
  }
  const from = s.carrier.calls.length
  const quoted = await quote(shop, { shippingAddress: address })
  expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
  const calls = s.carrier.calls.slice(from)
  expect(calls.length, 'rate calls for one quote').toBe(1)
  return calls[0]?.parcel.weightGrams
}

describe('the weight the admin sets is the one the carrier rates', () => {
  // Kills: the motivating defect: weights stored by the admin while the rater is still given the store's default.
  it('AC-3: on a carrier store, a weight set through PATCH on one of two variants moves the rated parcel from every unit at the default to qty × that weight plus the other variant’s units at the default', async () => {
    const product = await made()
    const qty: [number, number] = [2, 3]
    const grams = 120

    const before = await ratedParcel(product, qty)
    const patched = await patchWeight(product, 0, grams)
    expect(patched.status, JSON.stringify(patched.body)).toBe(200)
    const after = await ratedParcel(product, qty)

    expect(before, 'before the weight').toBe(
      parcelGrams([
        { weightGrams: null, qty: qty[0] },
        { weightGrams: null, qty: qty[1] },
      ]),
    )
    expect(after, 'after the weight').toBe(
      parcelGrams([
        { weightGrams: grams, qty: qty[0] },
        { weightGrams: null, qty: qty[1] },
      ]),
    )
    expect(after, 'the parcel moved by the weight set').toBe(
      (before ?? 0) - qty[0] * DEFAULT_GRAMS + qty[0] * grams,
    )
  })
})
