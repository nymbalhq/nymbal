import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  Address,
  Logger,
  Parcel,
  ShippingAdapter,
  ShippingRate as CarrierRate,
  ShippingRateParams,
} from '@nymbalhq/types'
import {
  carrierOptionId,
  carrierOptions,
  createCarrierRater,
  parcelOf,
  shippingOptions,
} from './shipping-quote.js'

// The native shipping table: which rows an address is offered, in the merchant's order, and what each costs for the
// goods in the cart. The oracle below is the rule as the store's documentation states it.

interface Row {
  id: string
  name: string
  countries?: string[]
  amountMinor: number
  freeOverMinor?: number
  estimatedDays?: number
}

const COUNTRIES = ['GB', 'FR', 'DE', 'US', 'IE'] as const

function addressIn(country: string): Address {
  return {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    city: 'Town',
    region: '',
    postalCode: '00000',
    country,
  }
}

const arbRow: fc.Arbitrary<Row> = fc.record(
  {
    id: fc.stringMatching(/^[a-z0-9_-]{1,12}$/),
    name: fc.string({ minLength: 1, maxLength: 20 }),
    countries: fc.uniqueArray(fc.constantFrom(...COUNTRIES), { minLength: 1, maxLength: 3 }),
    amountMinor: fc.integer({ min: 0, max: 100_000 }),
    freeOverMinor: fc.integer({ min: 1, max: 200_000 }),
    estimatedDays: fc.integer({ min: 0, max: 30 }),
  },
  { requiredKeys: ['id', 'name', 'amountMinor'] },
)

const arbTable = fc.uniqueArray(arbRow, { minLength: 1, maxLength: 7, selector: (r) => r.id })

/** A country as a shopper may type it: any case, with spaces around. */
const arbTyped = fc
  .tuple(
    fc.constantFrom(...COUNTRIES, 'AU'),
    fc.boolean(),
    fc.constantFrom('', ' ', '  '),
    fc.constantFrom('', ' ', '\t'),
  )
  .map(([code, lower, before, after]) => ({
    code,
    typed: `${before}${lower ? code.toLowerCase() : code}${after}`,
  }))

const arbGoods = fc.integer({ min: 0, max: 250_000 })

/** The rule: the rows naming the country, else the rows naming none, else nothing; free from the threshold up. */
function oracle(rates: readonly Row[], country: string, goodsMinor: number) {
  const naming = rates.filter((r) => r.countries?.includes(country))
  const rows = naming.length > 0 ? naming : rates.filter((r) => r.countries === undefined)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    amountMinor: r.freeOverMinor !== undefined && r.freeOverMinor <= goodsMinor ? 0 : r.amountMinor,
    estimatedDays: r.estimatedDays ?? null,
  }))
}

/** An option as the tests read it. */
interface Offered {
  id: string
  amountMinor: number
}

const FREE_STANDARD = [{ id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: null }]

describe('AC-2: native shipping options', () => {
  // Kills: a table-less store charging for or renaming the one free option ACP and the element already show.
  it('AC-2: property: with no table every address is offered exactly the free standard option', () => {
    fc.assert(
      fc.property(arbTyped, arbGoods, ({ typed }, goods) => {
        expect(shippingOptions([], addressIn(typed), goods)).toEqual(FREE_STANDARD)
      }),
      { numRuns: 200 },
    )
  })

  // Kills: rest-of-world rows offered beside a country's own, the table reordered, the threshold compared the wrong
  // way round (free below it, or charged exactly at it), a country typed in lower case or with spaces missing its row.
  it('AC-2: property: the rows naming the country, else the rows naming none, else none, in the table’s order, each free exactly when freeOverMinor ≤ goods', () => {
    fc.assert(
      fc.property(arbTable, arbTyped, arbGoods, (rates, { code, typed }, goods) => {
        const options = shippingOptions(rates, addressIn(typed), goods)
        expect(options).toEqual(oracle(rates, code, goods))
      }),
      { numRuns: 1000 },
    )
  })

  // Kills: a threshold that charges more as the basket grows (an inverted comparison), or an id set that changes
  // with the goods, so the shopper's chosen option disappears when a line is added.
  it('AC-2: property: raising the goods never raises an option’s amount and never changes which options are offered', () => {
    fc.assert(
      fc.property(
        arbTable,
        arbTyped,
        arbGoods,
        fc.integer({ min: 1, max: 100_000 }),
        (rates, { typed }, goods, more) => {
          const before = shippingOptions(rates, addressIn(typed), goods)
          const after = shippingOptions(rates, addressIn(typed), goods + more)
          expect(after.map((o: Offered) => o.id)).toEqual(before.map((o: Offered) => o.id))
          after.forEach((option: Offered, i: number) => {
            expect(option.amountMinor).toBeLessThanOrEqual(before[i]!.amountMinor)
          })
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-2: a GB shopper is offered the GB rows only, a shopper elsewhere the rest-of-world row, and a country no row reaches nothing', () => {
    const rates: Row[] = [
      { id: 'uk-standard', name: 'Standard', countries: ['GB'], amountMinor: 0 },
      { id: 'world', name: 'International', amountMinor: 1500, estimatedDays: 10 },
      { id: 'uk-express', name: 'Express', countries: ['GB', 'IE'], amountMinor: 499 },
    ]
    expect(shippingOptions(rates, addressIn(' gb '), 1000).map((o: Offered) => o.id)).toEqual([
      'uk-standard',
      'uk-express',
    ])
    expect(shippingOptions(rates, addressIn('FR'), 1000)).toEqual([
      { id: 'world', name: 'International', amountMinor: 1500, estimatedDays: 10 },
    ])
    const gbOnly = rates.filter((r) => r.countries !== undefined)
    expect(shippingOptions(gbOnly, addressIn('FR'), 1000)).toEqual([])
  })

  it('AC-2: an option is free at exactly its threshold and charged one unit below it', () => {
    const rates: Row[] = [{ id: 'std', name: 'Standard', amountMinor: 399, freeOverMinor: 5000 }]
    expect(shippingOptions(rates, addressIn('GB'), 5000)[0]!.amountMinor).toBe(0)
    expect(shippingOptions(rates, addressIn('GB'), 4999)[0]!.amountMinor).toBe(399)
  })
})

// --- Carrier pricing ----------------------------------------------------------------------------------------------
// The parcel a cart is rated as, and the options a carrier's answer becomes. The oracles are the rules as the store's
// documentation states them, written here.

interface WeighedLine {
  weightGrams: number | null
  qty: number
}

/** A weight as a variant may hold it: none, zero, negative, fractional (in quarters, exact in binary) or up to 30 kg. */
const arbWeight: fc.Arbitrary<number | null> = fc.oneof(
  fc.constant(null),
  fc.constant(0),
  fc.integer({ min: -5_000, max: -1 }),
  fc.integer({ min: 1, max: 120_000 }).map((quarters) => quarters / 4),
  fc.integer({ min: 1, max: 30_000 }),
)

const arbLine: fc.Arbitrary<WeighedLine> = fc.record({
  weightGrams: arbWeight,
  qty: fc.integer({ min: 1, max: 50 }),
})

const arbLines = fc.array(arbLine, { minLength: 0, maxLength: 6 })

/** A store's weight for a unit with none: a positive whole number of grams, as the config requires. */
const arbDefault = fc.integer({ min: 1, max: 30_000 })

/** The documented parcel: the sum of each line's weight (none: the default; below 0: 0) times its qty, rounded up, at least 1 g. */
function parcelOracle(lines: readonly WeighedLine[], defaultGrams: number): number {
  const sum = lines.reduce(
    (total, l) => total + Math.max(0, l.weightGrams ?? defaultGrams) * l.qty,
    0,
  )
  return Math.max(1, Math.ceil(sum))
}

describe('AC-3: the parcel a cart is rated as', () => {
  // Kills: quantity ignored, a weightless cart sent as 0 g (which EasyPost refuses), a negative weight subtracted, a
  // fractional sum rounded down, or dimensions invented for a parcel the store never measured.
  it('AC-3: property: parcelOf is max(1, ceil(Σ max(0, weight ?? default) × qty)) grams with no dimensions', () => {
    fc.assert(
      fc.property(arbLines, arbDefault, (lines, defaultGrams) => {
        const parcel = parcelOf(lines, defaultGrams)

        expect(parcel).toEqual({ weightGrams: parcelOracle(lines, defaultGrams) })
        expect(Object.keys(parcel)).toEqual(['weightGrams'])
      }),
      { numRuns: 1000 },
    )
  })

  // Kills: a heavier cart rated as a lighter parcel (a max where a sum belongs, a line dropped, qty read as 1).
  it('AC-3: property: adding a line or a unit never lowers the parcel', () => {
    fc.assert(
      fc.property(
        fc.array(arbLine, { minLength: 1, maxLength: 6 }),
        arbLine,
        arbDefault,
        fc.nat(),
        (lines, extra, defaultGrams, pick) => {
          const before = parcelOf(lines, defaultGrams).weightGrams
          const at = pick % lines.length
          const oneMore = lines.map((l, i) => (i === at ? { ...l, qty: l.qty + 1 } : l))

          expect(parcelOf([...lines, extra], defaultGrams).weightGrams).toBeGreaterThanOrEqual(
            before,
          )
          expect(parcelOf(oneMore, defaultGrams).weightGrams).toBeGreaterThanOrEqual(before)
        },
      ),
      { numRuns: 500 },
    )
  })

  // Kills: a variant with no weight weighed as 0 (every cart of such variants rated at the lightest parcel) or
  // refused, so the cart is unratable.
  it('AC-3: property: a line with no weight weighs exactly as one at the default weight', () => {
    fc.assert(
      fc.property(
        arbLines,
        arbDefault,
        fc.integer({ min: 1, max: 50 }),
        (lines, defaultGrams, qty) => {
          expect(parcelOf([...lines, { weightGrams: null, qty }], defaultGrams)).toEqual(
            parcelOf([...lines, { weightGrams: defaultGrams, qty }], defaultGrams),
          )
        },
      ),
      { numRuns: 300 },
    )
  })
})

/** The documented id rule for one part: lower-cased, each run outside a-z and 0-9 made `_`, `_` trimmed. */
function idPart(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function idOracle(carrier: string, service: string): string {
  const [c, s] = [idPart(carrier), idPart(service)]
  return c === '' || s === '' ? '' : `${c}-${s}`.slice(0, 64)
}

interface OracleOption {
  id: string
  name: string
  amountMinor: number
  estimatedDays: number | null
  carrier: string
  service: string
}

/**
 * The documented options: rates in the store's currency (either in any case) whose id is not empty, the cheapest per
 * id (the first answered among equals), named carrier and service, cheapest first and then by id.
 */
function optionsOracle(rates: readonly CarrierRate[], currency: string): OracleOption[] {
  const byId = new Map<string, CarrierRate>()
  for (const rate of rates) {
    if (rate.currency.toUpperCase() !== currency.toUpperCase()) continue
    const id = idOracle(rate.carrier, rate.service)
    if (id === '') continue
    const held = byId.get(id)
    if (held === undefined || rate.amountMinor < held.amountMinor) byId.set(id, rate)
  }
  return [...byId.entries()]
    .map(([id, r]) => ({
      id,
      name: `${r.carrier} ${r.service}`.trim(),
      amountMinor: r.amountMinor,
      estimatedDays: r.estimatedDays,
      carrier: r.carrier,
      service: r.service,
    }))
    .sort((a, b) => a.amountMinor - b.amountMinor || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Carrier and service names as accounts answer them: mixed case, spaces, punctuation, copies, and nothing at all. */
const CARRIERS = [
  'USPS',
  'usps',
  ' U.S.P.S. ',
  'Royal Mail',
  'royal_mail',
  'DHL Express',
  'Ünïon',
  '',
  '---',
]
const SERVICES = [
  'Priority',
  'priority',
  'Ground Advantage',
  'GroundAdvantage',
  'Next-Day',
  'Tracked 24',
  'x'.repeat(70),
  '',
  '!!!',
]

const arbRate: fc.Arbitrary<CarrierRate> = fc.record({
  id: fc.uuid(),
  carrier: fc.constantFrom(...CARRIERS),
  service: fc.constantFrom(...SERVICES),
  amountMinor: fc.integer({ min: 0, max: 5_000 }),
  currency: fc.constantFrom('GBP', 'gbp', 'USD'),
  estimatedDays: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
})

const arbAnswer = fc.array(arbRate, { minLength: 0, maxLength: 12 })

/** The answer with every opaque id replaced, as the carrier mints them on each call. */
const freshIds = (rates: readonly CarrierRate[]): CarrierRate[] =>
  rates.map((r, i) => ({ ...r, id: `fresh-${i}-${r.id.slice(0, 8)}` }))

describe('AC-4: carrier options keep their ids from one rating call to the next', () => {
  it('AC-4: carrierOptionId lower-cases each part, makes each run of other characters `_`, trims `_`, joins them with `-`, cuts to 64, and answers empty when a part is empty', () => {
    expect(carrierOptionId('USPS', 'Priority')).toBe('usps-priority')
    expect(carrierOptionId(' Royal  Mail ', 'Tracked 24')).toBe('royal_mail-tracked_24')
    expect(carrierOptionId('DHL', '!!!')).toBe('')
    expect(carrierOptionId('', 'Priority')).toBe('')
    expect(carrierOptionId('UPS', 'x'.repeat(100))).toBe(`ups-${'x'.repeat(60)}`)
  })

  // Kills: an id built from the provider's per-call rate id, or one that keeps case or punctuation, so the option a
  // shopper chose is never found at place, or ids a caller cannot send back.
  it('AC-4: property: carrierOptionId follows the rule for any names, and is a valid option id or empty', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 80 }),
        fc.string({ maxLength: 80 }),
        (carrier, service) => {
          const id = carrierOptionId(carrier, service)
          expect(id).toBe(idOracle(carrier, service))
          expect(id === '' || /^[a-z0-9_-]{1,64}$/.test(id), id).toBe(true)
        },
      ),
      { numRuns: 1000 },
    )
  })

  // Kills: a USD amount charged as pence on a GBP store; two accounts' copies of one service shown twice, or the
  // dearer copy charged; a rate with no usable name offered under an empty id; options in the carrier's order.
  it('AC-4: property: the options are the cheapest rate in the store currency per id, named carrier and service, cheapest first then by id, with ids valid and unique', () => {
    fc.assert(
      fc.property(arbAnswer, fc.constantFrom('GBP', 'gbp'), (rates, currency) => {
        const options: OracleOption[] = carrierOptions(rates, currency)

        expect(options).toEqual(optionsOracle(rates, currency))
        const ids = options.map((o) => o.id)
        expect(new Set(ids).size).toBe(ids.length)
        for (const option of options) {
          expect(option.id).toMatch(/^[a-z0-9_-]{1,64}$/)
          for (const rate of rates) {
            if (rate.currency.toUpperCase() !== 'GBP') continue
            if (carrierOptionId(rate.carrier, rate.service) !== option.id) continue
            expect(option.amountMinor).toBeLessThanOrEqual(rate.amountMinor)
          }
        }
        for (const [a, b] of options.slice(1).map((o, i) => [options[i]!, o] as const)) {
          expect(a.amountMinor).toBeLessThanOrEqual(b.amountMinor)
        }
      }),
      { numRuns: 1000 },
    )
  })

  // Kills: the options depending on the order the carrier answered in or on its opaque ids, so a second quote (or the
  // place) offers ids or amounts the first did not.
  it('AC-4: property: the ids and amounts do not move when the answer is permuted, and nothing moves when only its opaque ids are new', () => {
    fc.assert(
      fc.property(
        arbAnswer.chain((rates) =>
          fc.tuple(
            fc.constant(rates),
            fc.shuffledSubarray(rates, { minLength: rates.length, maxLength: rates.length }),
          ),
        ),
        ([rates, permuted]) => {
          const options: OracleOption[] = carrierOptions(rates, 'GBP')
          const idsAndAmounts = (list: OracleOption[]) => list.map((o) => [o.id, o.amountMinor])

          expect(idsAndAmounts(carrierOptions(permuted, 'GBP'))).toEqual(idsAndAmounts(options))
          expect(carrierOptions(freshIds(rates), 'GBP')).toEqual(options)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('AC-4: a GBP store offers its GBP rates whatever their case and drops the USD ones and the ones with no usable name; equal copies keep the first answered', () => {
    const rates: CarrierRate[] = [
      {
        id: 'r1',
        carrier: 'Royal Mail',
        service: 'Tracked 24',
        amountMinor: 450,
        currency: 'gbp',
        estimatedDays: 1,
      },
      {
        id: 'r2',
        carrier: 'USPS',
        service: 'Priority',
        amountMinor: 100,
        currency: 'USD',
        estimatedDays: 2,
      },
      {
        id: 'r3',
        carrier: 'royal mail',
        service: 'tracked-24',
        amountMinor: 450,
        currency: 'GBP',
        estimatedDays: 3,
      },
      {
        id: 'r4',
        carrier: 'DHL',
        service: '',
        amountMinor: 10,
        currency: 'GBP',
        estimatedDays: null,
      },
      {
        id: 'r5',
        carrier: 'Evri',
        service: 'Standard',
        amountMinor: 299,
        currency: 'GBP',
        estimatedDays: null,
      },
    ]

    expect(carrierOptions(rates, 'GBP')).toEqual([
      {
        id: 'evri-standard',
        name: 'Evri Standard',
        amountMinor: 299,
        estimatedDays: null,
        carrier: 'Evri',
        service: 'Standard',
      },
      {
        id: 'royal_mail-tracked_24',
        name: 'Royal Mail Tracked 24',
        amountMinor: 450,
        estimatedDays: 1,
        carrier: 'Royal Mail',
        service: 'Tracked 24',
      },
    ])
  })
})

interface Warned {
  obj: Record<string, unknown>
  msg: string | undefined
}

/** A logger that keeps every warn it is given. */
function recordingLogger(): { logger: Logger; warns: Warned[] } {
  const warns: Warned[] = []
  const logger: Logger = {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    error: () => undefined,
    warn: (obj, msg) => {
      warns.push({ obj: obj as Record<string, unknown>, msg })
    },
    child: () => logger,
  }
  return { logger, warns }
}

/** A shipping adapter that declares rates but has no `rate` function. */
function bareCarrier(providerName: string): ShippingAdapter {
  return {
    kind: 'shipping',
    providerName,
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    capabilities: () => ['rates'],
  }
}

/** A carrier answering whatever `answer` gives (or throws), every call's params kept. */
function fakeCarrier(answer: (params: ShippingRateParams) => unknown, providerName = 'fake-ship') {
  const calls: ShippingRateParams[] = []
  const adapter: ShippingAdapter = {
    ...bareCarrier(providerName),
    rate: async (params) => {
      calls.push(params)
      return (await answer(params)) as CarrierRate[]
    },
  }
  return { adapter, calls }
}

const SHIP_FROM = addressIn('GB')
const SHIP_TO = addressIn('FR')
const PARCEL: Parcel = { weightGrams: 1_250 }

function raterFor(adapter: ShippingAdapter, opts: { currency?: string; boundMs?: number } = {}) {
  const { logger, warns } = recordingLogger()
  const rater = createCarrierRater({
    adapter,
    shipFrom: SHIP_FROM,
    currency: opts.currency ?? 'GBP',
    boundMs: opts.boundMs ?? 1_000,
    logger,
  })
  return { rater, warns }
}

/** A rate the kernel can charge, with the fields `over` replaces (any value, as a carrier may answer anything). */
const rateOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'rate_1',
  carrier: 'Royal Mail',
  service: 'Tracked 24',
  amountMinor: 450,
  currency: 'GBP',
  estimatedDays: 1,
  ...over,
})

/**
 * Rates the parcel with a carrier answering `answer` (or with `adapter`): what the rating rejected with, the providers
 * its warns named, and the adapter's own provider name.
 */
async function rejectionOf(answer: unknown, adapter?: ShippingAdapter) {
  const carrier = adapter ?? fakeCarrier(() => answer, 'flaky-ship').adapter
  const { rater, warns } = raterFor(carrier)
  const error = await rater.rate(SHIP_TO, PARCEL).then(
    () => undefined,
    (err: unknown) => err as Error,
  )
  return {
    error,
    warnedProviders: warns.map((w) => w.obj['provider']),
    provider: carrier.providerName,
  }
}

const arbChargeable: fc.Arbitrary<CarrierRate> = fc.record({
  id: fc.uuid(),
  carrier: fc.constantFrom(...CARRIERS.filter((c) => idPart(c) !== '')),
  service: fc.constantFrom(...SERVICES.filter((s) => idPart(s) !== '')),
  amountMinor: fc.integer({ min: 0, max: 5_000 }),
  currency: fc.constant('GBP'),
  estimatedDays: fc.option(fc.integer({ min: 0, max: 20 }), { nil: null }),
})

describe('AC-9: the carrier is asked once per rating and never priced around', () => {
  // Kills: the carrier asked from the wrong address or for another parcel, its answer reshaped other than by
  // carrierOptions, or a warn logged though nothing was dropped.
  it('AC-9: property: a chargeable answer in the store currency is exactly carrierOptions of it, asked from shipFrom to the address for the parcel, with no warn', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbChargeable, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 30_000 }),
        async (answer, grams) => {
          const { adapter, calls } = fakeCarrier(() => structuredClone(answer))
          const { rater, warns } = raterFor(adapter)

          const options = await rater.rate(SHIP_TO, { weightGrams: grams })

          expect(options).toEqual(carrierOptions(answer, 'GBP'))
          expect(calls).toEqual([{ from: SHIP_FROM, to: SHIP_TO, parcel: { weightGrams: grams } }])
          expect(warns).toEqual([])
        },
      ),
      { numRuns: 100 },
    )
  })

  // Kills: a free rate (amount 0) refused as an outage.
  it('AC-9: a rate of amount 0 is charged as a free option', async () => {
    const answer = [rateOf({ amountMinor: 0 })]
    const { adapter } = fakeCarrier(() => answer)
    const { rater, warns } = raterFor(adapter)

    const options = await rater.rate(SHIP_TO, PARCEL)

    expect(options).toEqual(carrierOptions(answer as unknown as CarrierRate[], 'GBP'))
    expect(options.map((o) => o.amountMinor)).toEqual([0])
    expect(warns).toEqual([])
  })

  // Kills: a negative, fractional, unbounded or textual amount charged (or the answer kept because another rate in it
  // is valid).
  it.each([
    { label: '-1', amountMinor: -1 },
    { label: '1.5', amountMinor: 1.5 },
    { label: 'NaN', amountMinor: Number.NaN },
    { label: 'Infinity', amountMinor: Number.POSITIVE_INFINITY },
    { label: '2**53', amountMinor: 2 ** 53 },
    { label: "'300'", amountMinor: '300' },
  ])(
    'AC-9: an answer holding a rate of amountMinor $label is an outage with one warn naming the provider',
    async ({ amountMinor }) => {
      const { error, warnedProviders, provider } = await rejectionOf([
        rateOf(),
        rateOf({ id: 'rate_2', service: 'Tracked 48', amountMinor }),
      ])

      expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
      expect(warnedProviders).toEqual([provider])
    },
  )

  // Kills: a currency compared loosely, so a lower-case, short, long or non-text code is charged as the store's.
  it.each([
    { label: "'gbp'", currency: 'gbp' },
    { label: "'GB'", currency: 'GB' },
    { label: "'GBPP'", currency: 'GBPP' },
    { label: '42', currency: 42 },
    { label: "['GBP'], text only once coerced", currency: ['GBP'] },
  ])(
    'AC-9: an answer holding a rate in currency $label is an outage with one warn naming the provider',
    async ({ currency }) => {
      const { error, warnedProviders, provider } = await rejectionOf([
        rateOf(),
        rateOf({ id: 'rate_2', service: 'Tracked 48', currency }),
      ])

      expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
      expect(warnedProviders).toEqual([provider])
      // Refused as the carrier's answer, not failing later on a code that only passed the pattern once coerced.
      expect((error?.cause as Error).message).toMatch(/rates the port refuses/)
    },
  )

  // Kills: a rate with no carrier or service names, or no rate at all, reaching the id rule and failing there as a
  // TypeError instead of being refused as the carrier's fault.
  it.each([
    { label: 'carrier undefined', bad: rateOf({ carrier: undefined }) },
    { label: 'carrier a number', bad: rateOf({ carrier: 7 }) },
    { label: 'service undefined', bad: rateOf({ service: undefined }) },
    { label: 'service a number', bad: rateOf({ service: 7 }) },
    { label: 'a null rate', bad: null },
    { label: 'an undefined rate', bad: undefined },
    { label: 'a number for a rate', bad: 42 },
  ])('AC-9: an answer holding $label is an outage, not a TypeError', async ({ bad }) => {
    const { error, warnedProviders, provider } = await rejectionOf([rateOf(), bad])

    expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
    expect(warnedProviders).toEqual([provider])
    expect(error?.cause).not.toBeInstanceOf(TypeError)
    expect((error?.cause as Error).message).toMatch(/rates the port refuses/)
  })

  // Kills: an answer that is not a list (or an adapter with no rate function) read as one.
  it.each([
    { label: 'an object holding the rates', answer: { rates: [rateOf()] }, adapter: undefined },
    { label: 'null', answer: null, adapter: undefined },
    {
      label: 'nothing, from an adapter with no rate function',
      answer: undefined,
      adapter: bareCarrier('no-rate-ship'),
    },
  ])(
    'AC-9: a carrier answering $label is an outage, not a TypeError',
    async ({ answer, adapter }) => {
      const { error, warnedProviders, provider } = await rejectionOf(answer, adapter)

      expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
      expect(warnedProviders).toEqual([provider])
      expect(error?.cause).not.toBeInstanceOf(TypeError)
    },
  )

  // Kills: the carrier's own error dropped from the outage, so the log and the caller lose why it was down.
  it('AC-9: a carrier that throws is an outage whose cause is the error it threw', async () => {
    const thrown = new Error('carrier account suspended')
    const { error, warnedProviders, provider } = await rejectionOf(
      undefined,
      fakeCarrier(() => {
        throw thrown
      }).adapter,
    )

    expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
    expect(warnedProviders).toEqual([provider])
    expect(error?.cause).toBe(thrown)
  })

  // Kills: the outage reaching the shopper or the operator's log with a blank message, so neither can tell what failed.
  it('AC-9: an outage tells the shopper the delivery price failed and logs that the carrier was unavailable', async () => {
    const refused = await rejectionOf([rateOf({ amountMinor: -1 })])
    const thrown = new Error('carrier account suspended')
    const threw = await rejectionOf(
      undefined,
      fakeCarrier(() => {
        throw thrown
      }).adapter,
    )
    const { rater, warns } = raterFor(fakeCarrier(() => [rateOf({ amountMinor: -1 })]).adapter)
    await rater.rate(SHIP_TO, PARCEL).catch(() => undefined)

    for (const { error } of [refused, threw]) {
      expect(error?.message).toBe('The delivery price could not be worked out')
    }
    expect((refused.error?.cause as Error).message).toMatch(/rates the port refuses/)
    expect(warns.map((w) => w.msg)).toEqual(['carrier unavailable at checkout'])
  })
})

describe('AC-16: the carrier is down past its bound', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // Kills: a bound longer or shorter than boundMs, or no bound at all.
  it('AC-16: a carrier that never answers is still pending one millisecond before the bound and an outage at it', async () => {
    vi.useFakeTimers()
    const boundMs = 200
    const { adapter, calls } = fakeCarrier(() => new Promise(() => undefined), 'silent-ship')
    const { rater, warns } = raterFor(adapter, { boundMs })
    let state: 'pending' | 'resolved' | 'rejected' = 'pending'
    let error: unknown
    void rater.rate(SHIP_TO, PARCEL).then(
      () => {
        state = 'resolved'
      },
      (err: unknown) => {
        state = 'rejected'
        error = err
      },
    )

    await vi.advanceTimersByTimeAsync(boundMs - 1)
    const before = state
    await vi.advanceTimersByTimeAsync(1)

    expect(before).toBe('pending')
    expect(state).toBe('rejected')
    expect(error).toMatchObject({ code: 'checkout.shipping_unavailable' })
    // The log says how long the carrier was given.
    expect(((error as Error).cause as Error).message).toContain(`${boundMs} ms`)
    expect(warns.map((w) => w.obj['provider'])).toEqual([adapter.providerName])
    expect(calls.length).toBe(1)
  })

  // Kills: the bound's timer left running after the carrier answered, holding the process for boundMs per rating.
  it('AC-16: an answer inside the bound leaves no timer behind', async () => {
    vi.useFakeTimers()
    const answer = [rateOf()]
    const { adapter } = fakeCarrier(() => answer)
    const { rater } = raterFor(adapter, { boundMs: 5_000 })
    const timersBefore = vi.getTimerCount()

    const options = await rater.rate(SHIP_TO, PARCEL)

    expect(options).toEqual(carrierOptions(answer as unknown as CarrierRate[], 'GBP'))
    expect(vi.getTimerCount()).toBe(timersBefore)
    expect(timersBefore).toBe(0)
  })
})

describe('AC-9: rates the store cannot offer are dropped with a warn', () => {
  // Kills: a dropped rate not logged, logged with the wrong names, or a kept one logged as dropped.
  it('AC-9: a GBP store answered GBP, USD and a nameless service offers the one option and warns once listing the other two', async () => {
    const kept = rateOf({ id: 'a', carrier: 'Royal Mail', service: 'Tracked 24' })
    const usd = rateOf({ id: 'b', carrier: 'USPS', service: 'Priority', currency: 'USD' })
    const nameless = rateOf({ id: 'c', carrier: 'DHL', service: '---' })
    const { adapter } = fakeCarrier(() => [kept, usd, nameless])
    const { rater, warns } = raterFor(adapter)

    const options = await rater.rate(SHIP_TO, PARCEL)

    expect(options).toEqual(carrierOptions([kept] as unknown as CarrierRate[], 'GBP'))
    expect(warns.map((w) => w.obj['dropped'])).toEqual([
      [
        { carrier: usd['carrier'], service: usd['service'], currency: usd['currency'] },
        {
          carrier: nameless['carrier'],
          service: nameless['service'],
          currency: nameless['currency'],
        },
      ],
    ])
    expect(warns[0]?.obj['provider']).toBe(adapter.providerName)
    expect(warns[0]?.msg).toMatch(/^carrier rates dropped: /)
  })

  // Kills: the store currency compared as written, so a store configured in lower case drops its own rates.
  it('AC-9: a store whose currency is written in lower case keeps its upper-case rates without a warn', async () => {
    const answer = [rateOf()]
    const { adapter } = fakeCarrier(() => answer)
    const { rater, warns } = raterFor(adapter, { currency: 'gbp' })

    const options = await rater.rate(SHIP_TO, PARCEL)

    expect(options).toEqual(carrierOptions(answer as unknown as CarrierRate[], 'gbp'))
    expect(options.length).toBe(answer.length)
    expect(warns).toEqual([])
  })

  // Kills: an answer with nothing left in the store currency refused as an outage, or dropped without a warn.
  it('AC-9: an answer with nothing in the store currency offers nothing and warns once', async () => {
    const usd = rateOf({ currency: 'USD' })
    const { adapter } = fakeCarrier(() => [usd])
    const { rater, warns } = raterFor(adapter)

    const options = await rater.rate(SHIP_TO, PARCEL)

    expect(options).toEqual([])
    expect(warns.map((w) => w.obj['dropped'])).toEqual([
      [{ carrier: usd['carrier'], service: usd['service'], currency: usd['currency'] }],
    ])
  })
})
