import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Address, Parcel, ShippingAdapter } from '@nymbalhq/types'
import { createEasyPostShippingAdapter } from './index.js'
import {
  FAKE_EASYPOST_API_KEY,
  startFakeEasyPost,
  type FakeEasyPost,
  type FakeRate,
  type RecordedRequest,
} from './tests/fake-easypost.js'
import { codeOf, FROM, outcomeOf, silent, TO } from './tests/support.js'

// Rates and labels through EasyPost's API (the in-process fake): the addresses mapped field by field, the parcel in
// ounces and inches rounded up to 0.1 (never under-declared), each Rate's decimal amount read exactly into minor units
// by its currency's digits (never rounded: an amount finer than the currency is refused), a parcel with one or two
// dimensions refused before any request, and a rate id that buys its own shipment's rate, once.

const GRAMS_PER_OUNCE = 28.349523125
const MM_PER_INCH = 25.4
/** Room for binary floating point in the comparisons only; the adapter's rounding is to 0.1. */
const EPSILON = 1e-9

let fake: FakeEasyPost

beforeAll(async () => {
  fake = await startFakeEasyPost()
})
afterEach(() => {
  fake.rates(null)
  fake.clear()
})
afterAll(async () => {
  await fake.close()
})

const easypost = (): ShippingAdapter =>
  createEasyPostShippingAdapter({
    logger: silent,
    config: { apiKey: FAKE_EASYPOST_API_KEY, apiBase: fake.apiBase, timeoutMs: 2000 },
  })

/** The requests the fake has seen since `from`. */
const since = (from: number): RecordedRequest[] => fake.requests.slice(from)

const word = (min: number, max: number) =>
  fc.stringMatching(new RegExp(`^[A-Z][a-z]{${min - 1},${max - 1}}$`))

const arbAddress: fc.Arbitrary<Address> = fc.record(
  {
    firstName: word(2, 10),
    lastName: word(2, 12),
    company: fc.stringMatching(/^[A-Z][a-z]{2,10} (Ltd|Inc|Co)$/),
    addressLine1: fc.stringMatching(/^[1-9]\d{0,3} [A-Z][a-z]{2,10} (Street|Road|Ave)$/),
    addressLine2: fc.stringMatching(/^(Unit|Floor|Apt) [1-9]\d?$/),
    city: word(3, 14),
    region: fc.oneof(fc.stringMatching(/^[A-Z]{2}$/), fc.constant('')),
    postalCode: fc.stringMatching(/^\d{5}$/),
    country: fc.stringMatching(/^[A-Z]{2}$/),
    phone: fc.stringMatching(/^\d{10}$/),
  },
  {
    requiredKeys: [
      'firstName',
      'lastName',
      'addressLine1',
      'city',
      'region',
      'postalCode',
      'country',
    ],
  },
)

const arbParcel: fc.Arbitrary<Parcel> = fc.oneof(
  fc.record({ weightGrams: fc.integer({ min: 1, max: 70_000 }) }),
  fc.record({
    weightGrams: fc.integer({ min: 1, max: 70_000 }),
    lengthMm: fc.integer({ min: 1, max: 2000 }),
    widthMm: fc.integer({ min: 1, max: 2000 }),
    heightMm: fc.integer({ min: 1, max: 2000 }),
  }),
)

/** An Address as EasyPost's fields, the optional ones left out when absent. */
function easypostAddress(a: Address): Record<string, string> {
  const mapped: Record<string, string | undefined> = {
    name: `${a.firstName} ${a.lastName}`,
    company: a.company,
    street1: a.addressLine1,
    street2: a.addressLine2,
    city: a.city,
    state: a.region,
    zip: a.postalCode,
    country: a.country,
    phone: a.phone,
  }
  return Object.fromEntries(
    Object.entries(mapped).filter((e): e is [string, string] => e[1] !== undefined),
  )
}

/** The mapped fields as sent, those sent empty-handed (null or absent) left out. */
function sentAddress(sent: unknown): Record<string, unknown> {
  const fields = (sent ?? {}) as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(easypostAddress(FROM))
      .concat(['company', 'street2', 'phone'])
      .filter((k, i, all) => all.indexOf(k) === i)
      .filter((k) => fields[k] !== undefined && fields[k] !== null)
      .map((k) => [k, fields[k]]),
  )
}

/** `sent` is `exact` rounded up to the next 0.1: at least it, under it + 0.1, and a whole number of tenths. */
function roundedUp(sent: unknown, exact: number): boolean {
  return (
    typeof sent === 'number' &&
    sent >= exact - EPSILON &&
    sent < exact + 0.1 + EPSILON &&
    Math.abs(sent * 10 - Math.round(sent * 10)) < 1e-6
  )
}

/** The shipment the fake made for the one create since `from`. */
function created(from: number): { id: string; rates: Array<Record<string, unknown>> } {
  const create = since(from).filter((r) => r.route === 'shipments.create')
  expect(create.length, 'shipment creates').toBe(1)
  return create[0]!.response as { id: string; rates: Array<Record<string, unknown>> }
}

describe('AC-8: rate posts the addresses and a parcel never under-declared', () => {
  it('AC-8: property: over generated addresses and parcels, rate posts one /v2/shipments with the addresses mapped field by field and the parcel in ounces and inches each rounded up to 0.1', async () => {
    const a = easypost()
    await fc.assert(
      fc.asyncProperty(arbAddress, arbAddress, arbParcel, async (from, to, parcel) => {
        const before = fake.requests.length

        await a.rate!({ from, to, parcel })

        const sent = since(before)
        expect(sent.map((r) => [r.method, r.path])).toEqual([['POST', '/v2/shipments']])
        const shipment = (sent[0]!.body as { shipment: Record<string, Record<string, unknown>> })
          .shipment
        expect(sentAddress(shipment['from_address'])).toEqual(easypostAddress(from))
        expect(sentAddress(shipment['to_address'])).toEqual(easypostAddress(to))
        const box = shipment['parcel']!
        const ounces = parcel.weightGrams / GRAMS_PER_OUNCE
        expect(
          roundedUp(box['weight'], ounces),
          `${String(box['weight'])} oz for ${parcel.weightGrams} g`,
        ).toBe(true)
        // Each dimension rounded up from its millimetres, or, for a parcel without them, none sent.
        const inches =
          parcel.lengthMm !== undefined
            ? [parcel.lengthMm, parcel.widthMm, parcel.heightMm].map((mm) => mm / MM_PER_INCH)
            : null
        const given = [box['length'], box['width'], box['height']]
        expect(
          given.map((v, i) => (inches === null ? v == null : roundedUp(v, inches[i]!))),
          `${JSON.stringify(given)} in for ${JSON.stringify(parcel)}`,
        ).toEqual([true, true, true])
      }),
      { numRuns: 60 },
    )
  })

  it('AC-8: property: a parcel with one or two of its three dimensions rejects adapter.shipping.refused, and no request is made', async () => {
    const a = easypost()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 70_000 }),
        fc.subarray(['lengthMm', 'widthMm', 'heightMm'] as const, { minLength: 1, maxLength: 2 }),
        fc.integer({ min: 1, max: 2000 }),
        async (weightGrams, dimensions, mm) => {
          const partial = {
            weightGrams,
            ...Object.fromEntries(dimensions.map((d) => [d, mm])),
          } as unknown as Parcel
          const before = fake.requests.length

          const { value, error } = await outcomeOf(() =>
            a.rate!({ from: FROM, to: TO, parcel: partial }),
          )

          expect(value, JSON.stringify(partial)).toBeUndefined()
          expect(codeOf(error)).toBe('adapter.shipping.refused')
          expect(since(before)).toEqual([])
        },
      ),
      { numRuns: 30 },
    )
  })
})

/** An amount as EasyPost may write it: `minor` in `digits` places, then `zeros` trailing zeros past them. */
function written(minor: number, digits: number, shown: number, zeros: number): string {
  const whole = Math.floor(minor / 10 ** digits)
  const fraction = String(minor % 10 ** digits)
    .padStart(digits, '0')
    .slice(0, shown)
  const places = fraction + '0'.repeat(zeros)
  return places === '' ? String(whole) : `${whole}.${places}`
}

const CURRENCIES = [
  { currency: 'USD', digits: 2 },
  { currency: 'GBP', digits: 2 },
  { currency: 'JPY', digits: 0 },
] as const

describe('AC-8: an amount is read exactly, never rounded', () => {
  // Kills: parseFloat × 100 drifting a cent; a JPY amount scaled as if it had cents; '1500.00' JPY refused.
  it('AC-8: property: over generated amounts in USD, GBP and JPY written with up to the currency’s digits, and for USD and JPY with trailing zeros past them, amountMinor × 10^-digits equals the decimal string exactly', async () => {
    const a = easypost()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 99_999_999 }),
        fc.nat({ max: 2 }),
        fc.nat({ max: 3 }),
        async ({ currency, digits }, raw, cut, extra) => {
          const shown = Math.max(0, digits - cut)
          // Only what the shown places can hold: the digits past them are zero.
          const minor = raw - (raw % 10 ** (digits - shown))
          const zeros = currency === 'GBP' ? 0 : extra
          const amount = written(minor, digits, shown, zeros)
          fake.rates([{ rate: amount, currency, delivery_days: 3 }])

          const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } })

          expect(
            rates.map((r) => [r.amountMinor, r.currency]),
            amount,
          ).toEqual([[minor, currency]])
          expect(Number.isInteger(rates[0]!.amountMinor)).toBe(true)
        },
      ),
      { numRuns: 120 },
    )
  })

  it('AC-8: property: an amount with a non-zero digit past its currency’s (JPY 1500.5, USD 9.225) rejects adapter.shipping.refused naming the amount, never a rounded rate', async () => {
    const a = easypost()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom({ currency: 'USD', digits: 2 }, { currency: 'JPY', digits: 0 }),
        fc.integer({ min: 0, max: 9_999_999 }),
        fc.stringMatching(/^\d{0,2}[1-9]$/),
        async ({ currency, digits }, minor, past) => {
          const amount =
            digits === 0 ? `${minor}.${past}` : `${written(minor, digits, digits, 0)}${past}`
          fake.rates([{ rate: amount, currency }])

          const { value, error } = await outcomeOf(() =>
            a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } }),
          )

          expect(value, amount).toBeUndefined()
          expect(codeOf(error), amount).toBe('adapter.shipping.refused')
          expect((error as Error).message).toContain(amount)
        },
      ),
      { numRuns: 40 },
    )
    fake.rates([{ rate: '1500.5', currency: 'JPY' }])
    const jpy = await outcomeOf(() => a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } }))
    fake.rates([{ rate: '9.225', currency: 'USD' }])
    const usd = await outcomeOf(() => a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } }))
    expect([codeOf(jpy.error), codeOf(usd.error)]).toEqual([
      'adapter.shipping.refused',
      'adapter.shipping.refused',
    ])
  })

  it('AC-8: estimatedDays is delivery_days, else est_delivery_days, else null', async () => {
    const a = easypost()
    const offered: FakeRate[] = [
      { rate: '5.00', currency: 'USD', delivery_days: 2, est_delivery_days: 4 },
      { rate: '6.00', currency: 'USD', delivery_days: null, est_delivery_days: 4 },
      { rate: '7.00', currency: 'USD', delivery_days: null, est_delivery_days: null },
    ]
    fake.rates(offered)

    const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 500 } })

    expect(rates.map((r) => r.estimatedDays)).toEqual(
      offered.map((r) => r.delivery_days ?? r.est_delivery_days ?? null),
    )
  })
})

const arbRates: fc.Arbitrary<FakeRate[]> = fc.array(
  fc.record({
    carrier: fc.constantFrom('USPS', 'UPS', 'FedEx'),
    service: fc.constantFrom('Priority', 'Ground', 'Express'),
    rate: fc.integer({ min: 1, max: 99_999 }).map((m) => written(m, 2, 2, 0)),
    currency: fc.constant('USD'),
    delivery_days: fc.option(fc.integer({ min: 0, max: 9 }), { nil: null }),
  }),
  { minLength: 1, maxLength: 4 },
)

describe('AC-8: a rate id buys its own shipment’s rate, once', () => {
  // Kills: an id the kernel cannot hand back unchanged; a buy of the wrong rate or shipment; a label answered from
  // anything but what EasyPost bought.
  it('AC-8: property: createLabel({ rateId: id }) of each generated rate posts /v2/shipments/<shipment>/buy { rate: { id: <rate> } } for that rate and answers the bought label_url, tracking_code, carrier, service, amount and currency', async () => {
    const a = easypost()
    await fc.assert(
      fc.asyncProperty(arbRates, fc.nat(), async (offered, pick) => {
        fake.rates(offered)
        const before = fake.requests.length
        const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 900 } })
        const shipment = created(before)
        const i = pick % rates.length
        const chosen = shipment.rates[i]!
        const afterRate = fake.requests.length

        const label = await a.createLabel!({ rateId: rates[i]!.id })

        const buys = since(afterRate).filter((r) => r.route === 'shipments.buy')
        expect(buys.map((r) => [r.path, r.body])).toEqual([
          [`/v2/shipments/${shipment.id}/buy`, { rate: { id: chosen['id'] } }],
        ])
        const bought = buys[0]!.response as {
          tracking_code: string
          postage_label: { label_url: string }
          selected_rate: { carrier: string; service: string }
        }
        expect(label).toEqual({
          labelUrl: bought.postage_label.label_url,
          trackingNumber: bought.tracking_code,
          carrier: bought.selected_rate.carrier,
          service: bought.selected_rate.service,
          amountMinor: rates[i]!.amountMinor,
          currency: 'USD',
        })
        expect(rates[i]!.amountMinor).toBe(Math.round(Number(offered[i]!.rate) * 100))
      }),
      { numRuns: 20 },
    )
  })

  it('AC-8: a buy refused because the shipment was already bought with that rate answers the bought label, and EasyPost sells no second', async () => {
    const a = easypost()
    const before = fake.requests.length
    const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 900 } })
    const shipment = created(before)

    const first = await a.createLabel!({ rateId: rates[0]!.id })
    const retry = await outcomeOf(() => a.createLabel!({ rateId: rates[0]!.id }))

    expect(retry.error).toBeUndefined()
    expect(retry.value).toEqual(first)
    const sold = since(before).filter(
      (r) => r.path === `/v2/shipments/${shipment.id}/buy` && r.status >= 200 && r.status < 300,
    )
    expect(sold.length).toBe(1)
  })

  it('AC-8: a buy refused because the shipment was bought with another rate rejects adapter.shipping.refused, and the first label stays the only one sold', async () => {
    const a = easypost()
    const before = fake.requests.length
    const rates = await a.rate!({ from: FROM, to: TO, parcel: { weightGrams: 900 } })
    const shipment = created(before)
    expect(rates.length, 'the fake offers two rates by default').toBe(2)
    await a.createLabel!({ rateId: rates[0]!.id })

    const other = await outcomeOf(() => a.createLabel!({ rateId: rates[1]!.id }))

    expect(other.value).toBeUndefined()
    expect(codeOf(other.error)).toBe('adapter.shipping.refused')
    const sold = since(before).filter(
      (r) => r.path === `/v2/shipments/${shipment.id}/buy` && r.status >= 200 && r.status < 300,
    )
    expect(sold.map((r) => r.body)).toEqual([{ rate: { id: shipment.rates[0]!['id'] } }])
  })
})
