import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import * as types from '@nymbalhq/types'
import type { Address } from '@nymbalhq/types'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { address, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { addLine, readCart, type Shop } from '../support/promotions.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import type { CheckoutAnswer, ErrorBody } from '../support/shipping.js'

// The country and US region an address carries on the three routes that take one: POST /api/checkout/quote,
// POST /api/checkout and POST /api/customers/me/addresses. A country is an ISO 3166-1 two-letter code, read in any
// case with spaces around it and kept as the trimmed upper-case code; anything else (UK too: there is no alias) is
// 400 validation.failed at the field and writes nothing. With US, the region is a state's code or name, kept as sent;
// with any other country it is free text. Served over HTTP on SQLite with the native engines and no tables, so every
// country is shipped to and the only refusal is the address's.

const COUNTRY_MESSAGE = 'country takes an ISO 3166-1 two-letter code, such as "GB"'
const REGION_MESSAGE = 'a US region is a state\'s two-letter code or name, such as "CA"'

interface Issue {
  path: Array<string | number>
  message: string
}

interface Saved extends Address {
  id: string
}

interface Customer {
  shop: Shop
  auth: { headers: Record<string, string> }
}

let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

function countryCodes(): readonly string[] {
  const codes = (types as unknown as { COUNTRY_CODES?: readonly string[] }).COUNTRY_CODES
  expect(codes, '@nymbalhq/types exports COUNTRY_CODES').toBeInstanceOf(Array)
  return codes!
}

function usStates(): Readonly<Record<string, string>> {
  const states = (types as unknown as { US_STATES?: Readonly<Record<string, string>> }).US_STATES
  expect(states, '@nymbalhq/types exports US_STATES').toBeInstanceOf(Object)
  return states!
}

/** `word` with each letter in either case and up to two spaces on each side. */
function arbSpelling(word: string): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }),
      fc.constantFrom('', ' ', '  '),
      fc.constantFrom('', ' ', '  '),
    )
    .map(
      ([upper, left, right]) =>
        left +
        [...word].map((ch, i) => (upper[i] ? ch.toUpperCase() : ch.toLowerCase())).join('') +
        right,
    )
}

/** A region the tax table can place for `country`: a state for US, a county elsewhere. */
const regionFor = (country: string): string =>
  country.trim().toUpperCase() === 'US' ? 'CA' : 'Kent'

const addressIn = (country: string, region = regionFor(country)): Address => ({
  ...address,
  region,
  country,
})

/** A shopper of its own whose cart holds one unit of a product of its own. */
async function shopperWithCart(): Promise<{ shop: Shop; cartToken: string }> {
  await k.app.relay.drain()
  const seeded = await seedVariant(k, 50)
  const shop = await primedShopper(served.baseUrl)
  const added = await addLine(shop, seeded, 1)
  expect(added.status, JSON.stringify(added.body)).toBe(200)
  return { shop, cartToken: (await readCart(shop)).body.data!.token }
}

async function registered(): Promise<Customer> {
  const shop = await primedShopper(served.baseUrl)
  const res = await shop.call<{ accessToken: string }>('POST', '/api/auth/register', {
    email: `codes-${randomUUID()}@address-codes.test`,
    password: 'address-codes-horse',
  })
  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { shop, auth: { headers: { authorization: `Bearer ${res.body.data!.accessToken}` } } }
}

const pendingEmail = () => `buyer-${randomUUID()}+stub-pending@address-codes.test`

function quote(shop: Shop, shippingAddress: Address) {
  return shop.call('POST', '/api/checkout/quote', { shippingAddress })
}

function place(shop: Shop, email: string, shippingAddress: Address, billingAddress: Address) {
  return shop.call<CheckoutAnswer>('POST', '/api/checkout', {
    email,
    shippingAddress,
    billingAddress,
  })
}

function save(c: Customer, a: Address) {
  return c.shop.call<Saved>('POST', '/api/customers/me/addresses', a, c.auth)
}

async function savedAddresses(c: Customer): Promise<Saved[]> {
  const res = await c.shop.call<Saved[]>('GET', '/api/customers/me/addresses', undefined, c.auth)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

/** The status, the error code and each issue as `path: message`. */
function refusal(res: { status: number; body: { error?: unknown } }) {
  const error = res.body.error as (ErrorBody & { context?: { issues?: Issue[] } }) | undefined
  return {
    status: res.status,
    code: error?.code,
    issues: (error?.context?.issues ?? []).map((i) => `${i.path.join('.')}: ${i.message}`),
  }
}

const refused = (path: string, message: string) => ({
  status: 400,
  code: 'validation.failed',
  issues: [`${path}: ${message}`],
})

const cartUpdatedAt = async (cartToken: string): Promise<unknown> =>
  (
    await raw.one<{ updated_at: unknown }>('SELECT updated_at FROM carts WHERE token = ?', [
      cartToken,
    ])
  ).updated_at

const ordersBy = (email: string) => raw.count('orders', 'email = ?', [email])

function orderOf(orderId: string) {
  return k.store.read(async (tx) => (await k.repos.order.findById(tx, orderId))!)
}

describe('AC-6: an address’s country is an ISO 3166-1 code', () => {
  // Kills: a current country refused (a list missing one, or a case or spacing a shopper's browser sends).
  it('AC-6: a quote to every COUNTRY_CODES entry, in a generated case with spaces around it, is answered 200, not refused for its country', async () => {
    const codes = countryCodes()
    const { shop } = await shopperWithCart()

    const answered: Array<[string, number]> = []
    for (const code of codes) {
      const [spelled] = fc.sample(arbSpelling(code), 1)
      const res = await quote(shop, addressIn(spelled!))
      answered.push([JSON.stringify(spelled), res.status])
    }

    expect(answered.filter(([, status]) => status !== 200)).toEqual([])
    expect(answered).toHaveLength(codes.length)
  }, 60_000)

  // Kills: a code kept as sent (` gb `), so no tax or shipping row, which name `GB`, matches the order or the saved
  // address it is checked out with.
  it('AC-6: property: a generated code in any case with spaces around it is saved, and placed on the order’s shipping and billing address, as the trimmed upper-case code', async () => {
    const codes = countryCodes()
    const customer = await registered()
    const arbCode = fc.constantFrom(...codes)
    const arbSpelled = arbCode.chain((code) =>
      arbSpelling(code).map((spelled) => ({ code, spelled })),
    )

    await fc.assert(
      fc.asyncProperty(arbSpelled, arbSpelled, arbSpelled, async (saved, ship, bill) => {
        const added = await save(customer, addressIn(saved.spelled))
        expect(added.status, JSON.stringify(added.body)).toBe(201)
        const stored = (await savedAddresses(customer)).find((a) => a.id === added.body.data!.id)
        expect(stored?.country, JSON.stringify(saved.spelled)).toBe(saved.code)

        const { shop } = await shopperWithCart()
        const placed = await place(
          shop,
          pendingEmail(),
          addressIn(ship.spelled),
          addressIn(bill.spelled),
        )
        expect(placed.status, JSON.stringify(placed.body)).toBe(200)
        const order = await orderOf(placed.body.data!.orderId)
        expect([order.shippingAddress.country, order.billingAddress.country]).toEqual([
          ship.code,
          bill.code,
        ])
      }),
      { numRuns: 8 },
    )
  }, 60_000)

  // Kills: a typed UK placed as an order no tax or shipping row matches, or quietly rewritten to GB (an alias the API
  // does not have); a refused address that still writes an order, a saved address or the cart.
  it('AC-6: property: a country not in the list (a generated two-letter string outside it, UK, " uk ", United Kingdom, GBR, "") is 400 validation.failed at body.shippingAddress.country on the quote, body.billingAddress.country on the checkout and body.country on the address book, and nothing is written', async () => {
    const codes = new Set(countryCodes())
    const customer = await registered()
    const { shop, cartToken } = await shopperWithCart()
    const arbOutside = fc
      .stringMatching(/^ ?[A-Za-z]{2} ?$/)
      .filter((text) => !codes.has(text.trim().toUpperCase()))
    const arbBad = fc.oneof(fc.constantFrom('UK', ' uk ', 'United Kingdom', 'GBR', ''), arbOutside)

    await fc.assert(
      fc.asyncProperty(arbBad, async (bad) => {
        const email = pendingEmail()
        const before = {
          cart: await cartUpdatedAt(cartToken),
          saved: await savedAddresses(customer),
        }

        const quoted = await quote(shop, addressIn(bad))
        const placed = await place(shop, email, addressIn('GB'), addressIn(bad))
        const added = await save(customer, addressIn(bad))

        expect([refusal(quoted), refusal(placed), refusal(added)], JSON.stringify(bad)).toEqual([
          refused('body.shippingAddress.country', COUNTRY_MESSAGE),
          refused('body.billingAddress.country', COUNTRY_MESSAGE),
          refused('body.country', COUNTRY_MESSAGE),
        ])
        expect({
          orders: await ordersBy(email),
          cart: await cartUpdatedAt(cartToken),
          saved: await savedAddresses(customer),
        }).toEqual({ orders: 0, ...before })
      }),
      { numRuns: 20 },
    )
  }, 60_000)
})

describe('AC-7: a US region is a state, by code or name', () => {
  // Kills: a state's name, or its code in lower case, refused though the tax table reads it as the state.
  it('AC-7: property: with country US, a state code or name in any case with spaces around it is quoted and saved, kept as sent', async () => {
    const spellings = Object.entries(usStates()).flatMap(([code, name]) => [code, name])
    const customer = await registered()
    const { shop } = await shopperWithCart()
    const arbRegion = fc.constantFrom(...spellings).chain(arbSpelling)

    await fc.assert(
      fc.asyncProperty(arbRegion, async (region) => {
        const quoted = await quote(shop, addressIn('US', region))
        const added = await save(customer, addressIn('US', region))

        expect([quoted.status, added.status], JSON.stringify(region)).toEqual([200, 201])
        const stored = (await savedAddresses(customer)).find((a) => a.id === added.body.data!.id)
        expect(stored?.region).toBe(region)
      }),
      { numRuns: 25 },
    )
  }, 60_000)

  // Kills: Calif. placed and taxed 0 as outside nexus; a territory or a military code taken as a state.
  it('AC-7: property: with country US, a region that is no state’s code or name (Calif., PR, AE, XX, "", a generated one) is 400 validation.failed at the region on each route, and nothing is written', async () => {
    const states = usStates()
    const readable = new Set(
      Object.entries(states).flatMap(([code, name]) => [code, name.toUpperCase()]),
    )
    const customer = await registered()
    const { shop, cartToken } = await shopperWithCart()
    const arbBad = fc.oneof(
      fc.constantFrom('Calif.', 'PR', 'AE', 'XX', ''),
      fc
        .stringMatching(/^[A-Za-z. ]{0,14}$/)
        .filter((text) => !readable.has(text.trim().toUpperCase())),
    )

    await fc.assert(
      fc.asyncProperty(arbBad, async (bad) => {
        const email = pendingEmail()
        const before = {
          cart: await cartUpdatedAt(cartToken),
          saved: await savedAddresses(customer),
        }

        const quoted = await quote(shop, addressIn('US', bad))
        const placed = await place(shop, email, addressIn('GB'), addressIn('US', bad))
        const added = await save(customer, addressIn('US', bad))

        expect([refusal(quoted), refusal(placed), refusal(added)], JSON.stringify(bad)).toEqual([
          refused('body.shippingAddress.region', REGION_MESSAGE),
          refused('body.billingAddress.region', REGION_MESSAGE),
          refused('body.region', REGION_MESSAGE),
        ])
        expect({
          orders: await ordersBy(email),
          cart: await cartUpdatedAt(cartToken),
          saved: await savedAddresses(customer),
        }).toEqual({ orders: 0, ...before })
      }),
      { numRuns: 20 },
    )
  }, 60_000)

  // Kills: a GB shopper's county, or an empty region for a country without one, refused as not a US state.
  it('AC-7: property: with any other country, a region of any text, "" included, is quoted and saved as sent', async () => {
    const others = countryCodes().filter((code) => code !== 'US')
    const customer = await registered()
    const { shop } = await shopperWithCart()

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...others),
        fc.oneof(fc.constant(''), fc.string({ maxLength: 30 })),
        async (country, region) => {
          const quoted = await quote(shop, addressIn(country, region))
          const added = await save(customer, addressIn(country, region))

          expect([quoted.status, added.status], JSON.stringify([country, region])).toEqual([
            200, 201,
          ])
          const stored = (await savedAddresses(customer)).find((a) => a.id === added.body.data!.id)
          expect([stored?.country, stored?.region]).toEqual([country, region])
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)
})
