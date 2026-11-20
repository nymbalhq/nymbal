import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CheckoutError,
  type Address,
  type TaxAdapter,
  type TaxQuote,
  type TaxQuoteLine,
  type TaxQuoteParams,
} from '@nymbalhq/types'
import { createNativeTaxAdapter } from '../adapters/tax/native-adapter.js'
import { createLogger } from '../logger.js'
import { createTaxQuoter, TAX_BOUND_MS, validQuote } from './tax-quote.js'
import { quoteNative } from './tax-rates.js'

// The quoter between place and a tax engine: what it takes as a tax and what it treats as the engine being down. A
// valid quote is the port's rule (`validQuote`); a throw, an answer past the bound or an invalid quote is an outage,
// refused or answered from the native table as the store chose. The checkout's wiring of it is the integration suites'.

const logger = createLogger({ pretty: false, level: 'error' })

const SHIP_TO: Address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const RATES = [{ country: 'GB', percent: 20, codes: { food: 0 } }]

function paramsOf(lines: TaxQuoteParams['lines'], pricesIncludeTax: boolean): TaxQuoteParams {
  return {
    currency: 'GBP',
    shipTo: SHIP_TO,
    customer: { id: null },
    lines,
    shipping: null,
    pricesIncludeTax,
    reference: 'cart-token',
  }
}

const sum = (values: readonly number[]): number => values.reduce((total, v) => total + v, 0)

/** Request lines with distinct ids, each with at least one unit of money so a corruption can move it. */
const arbRequestLines = fc.uniqueArray(
  fc.record({
    id: fc.uuid(),
    sku: fc.constant('SKU-1'),
    amountMinor: fc.integer({ min: 2, max: 1_000_000 }),
    qty: fc.integer({ min: 1, max: 9 }),
  }),
  { minLength: 2, maxLength: 5, selector: (line) => line.id },
)

/**
 * A request and a quote the port accepts for it: each line's tax at most its amount, so it is valid either way, and
 * shipping sent and at least its tax whenever the quote taxes shipping (no shipping sent only with no shipping tax).
 */
const arbValid = fc
  .tuple(
    arbRequestLines,
    fc.boolean(),
    fc.integer({ min: 0, max: 5_000 }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.boolean(),
  )
  .chain(([lines, inclusive, shippingTaxMinor, above, sendNone]) =>
    fc.tuple(...lines.map((l) => fc.integer({ min: 1, max: l.amountMinor }))).map((taxes) => {
      const shipping =
        shippingTaxMinor === 0 && sendNone ? null : { amountMinor: shippingTaxMinor + above }
      const params = { ...paramsOf(lines, inclusive), shipping }
      const quote: TaxQuote = {
        provider: 'stub',
        inclusive,
        lines: lines.map((l, i) => ({
          id: l.id,
          taxableMinor: l.amountMinor,
          taxMinor: taxes[i]!,
        })),
        shippingTaxMinor,
        totalTaxMinor: sum(taxes) + shippingTaxMinor,
      }
      return { params, quote }
    }),
  )

type Line = TaxQuote['lines'][number]

/** Each corruption of a valid quote the port refuses, named; a line amount moved keeps the total the sum. */
function corruptions(params: TaxQuoteParams, quote: TaxQuote): Array<[string, TaxQuote]> {
  const [first, second, ...rest] = quote.lines as [Line, Line, ...Line[]]
  const withLines = (lines: Line[]): TaxQuote => ({
    ...quote,
    lines,
    totalTaxMinor: sum(lines.map((l) => l.taxMinor)) + quote.shippingTaxMinor,
  })
  const moved = (to: number): TaxQuote => {
    const delta = to - first.taxMinor
    return {
      ...quote,
      lines: [
        { ...first, taxMinor: to },
        { ...second, taxMinor: second.taxMinor - delta },
        ...rest,
      ],
    }
  }
  const out: Array<[string, TaxQuote]> = [
    ['a missing line id', withLines([second, ...rest])],
    ['a repeated line id', withLines([first, second, ...rest, first])],
    [
      'a line id replaced by a repeat',
      withLines([first, { ...first, taxMinor: second.taxMinor }, ...rest]),
    ],
    ['an unknown line id', withLines([first, { ...second, id: 'no-such-line' }, ...rest])],
    ['an extra unknown line', withLines([...quote.lines, { ...first, id: 'no-such-line' }])],
    ['a negative line tax', moved(-1)],
    ['a fractional line tax', moved(first.taxMinor - 0.5)],
    [
      'a negative shipping tax',
      {
        ...quote,
        shippingTaxMinor: -1,
        totalTaxMinor: quote.totalTaxMinor - quote.shippingTaxMinor - 1,
      },
    ],
    [
      'a fractional shipping tax',
      {
        ...quote,
        shippingTaxMinor: 0.5,
        totalTaxMinor: quote.totalTaxMinor - quote.shippingTaxMinor + 0.5,
      },
    ],
    ['a negative total', { ...quote, totalTaxMinor: -1 }],
    ['a fractional total', { ...quote, totalTaxMinor: quote.totalTaxMinor + 0.5 }],
    ['a total that is not the sum', { ...quote, totalTaxMinor: quote.totalTaxMinor + 1 }],
    ['the wrong inclusive flag', { ...quote, inclusive: !params.pricesIncludeTax }],
  ]
  if (params.pricesIncludeTax) {
    const amount = params.lines[0]!.amountMinor
    out.push([
      'an inclusive line tax above its amount',
      withLines([{ ...first, taxMinor: amount + 1 }, second, ...rest]),
    ])
  }
  return out
}

describe('AC-24: validQuote', () => {
  // Kills: a corrupt answer taken as the tax: a line dropped or doubled, money in fractions, a total off the sum.
  it('AC-24: property: true for a valid quote, and false for each corruption of it', () => {
    fc.assert(
      fc.property(arbValid, ({ params, quote }) => {
        expect(validQuote(params, quote)).toBe(true)
        for (const [what, corrupt] of corruptions(params, quote)) {
          expect(validQuote(params, corrupt), what).toBe(false)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-24: an exclusive line taxed above its amount is still valid: only an inclusive line is bounded by its amount', () => {
    const params = paramsOf([{ id: 'a', sku: 'SKU-1', amountMinor: 100, qty: 1 }], false)
    const quote: TaxQuote = {
      provider: 'stub',
      inclusive: false,
      lines: [{ id: 'a', taxableMinor: 100, taxMinor: 150 }],
      shippingTaxMinor: 0,
      totalTaxMinor: 150,
    }

    expect(validQuote(params, quote)).toBe(true)
    expect(validQuote({ ...params, pricesIncludeTax: true }, { ...quote, inclusive: true })).toBe(
      false,
    )
  })
})

describe('AC-4: validQuote and shipping', () => {
  /** The quote with its shipping tax moved to `to`, the total kept the sum. */
  const withShippingTax = (quote: TaxQuote, to: number): TaxQuote => ({
    ...quote,
    shippingTaxMinor: to,
    totalTaxMinor: quote.totalTaxMinor - quote.shippingTaxMinor + to,
  })

  // Kills: a provider's tax on shipping that was never sent reaching the order.
  it('AC-4: property: a quote taxing shipping by any whole amount above 0 is refused when the request sent no shipping', () => {
    fc.assert(
      fc.property(arbValid, fc.integer({ min: 1, max: 5_000 }), ({ params, quote }, tax) => {
        const none = { ...params, shipping: null }
        expect(validQuote(none, withShippingTax(quote, 0))).toBe(true)
        expect(validQuote(none, withShippingTax(quote, tax))).toBe(false)
      }),
      { numRuns: 300 },
    )
  })

  // Kills: an inclusive shipping tax above the shipping it is inside, so the order's net shipping is negative.
  it('AC-4: property: an inclusive quote’s shipping tax is valid up to the shipping amount and refused one unit above it; an exclusive one is not bounded by it', () => {
    fc.assert(
      fc.property(arbValid, fc.integer({ min: 0, max: 5_000 }), ({ params, quote }, amount) => {
        const shipping = { amountMinor: amount }
        const inclusive = { ...params, pricesIncludeTax: true, shipping }
        const exclusive = { ...params, pricesIncludeTax: false, shipping }
        const asInclusive = { ...quote, inclusive: true }
        const asExclusive = { ...quote, inclusive: false }
        // Line taxes are within their amounts in arbValid, so only the shipping tax decides.
        expect(validQuote(inclusive, withShippingTax(asInclusive, amount))).toBe(true)
        expect(validQuote(inclusive, withShippingTax(asInclusive, amount + 1))).toBe(false)
        expect(validQuote(exclusive, withShippingTax(asExclusive, amount + 1))).toBe(true)
      }),
      { numRuns: 300 },
    )
  })
})

type Outage = 'throws' | 'bound' | 'invalid'
const OUTAGES: readonly Outage[] = ['throws', 'bound', 'invalid']

/** A provider that answers `answer`, or fails in the named way: a rejection, an answer that never comes, a corrupt quote. */
function stubAdapter(behaviour: Outage | { answer: TaxQuote }): TaxAdapter {
  return {
    kind: 'tax',
    providerName: 'stub-tax',
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    capabilities: () => ['quote', 'inclusive'],
    async quote(params: TaxQuoteParams): Promise<TaxQuote> {
      if (typeof behaviour === 'object') return behaviour.answer
      if (behaviour === 'throws') throw new Error('tax provider unreachable')
      if (behaviour === 'bound') return new Promise<TaxQuote>(() => undefined)
      return {
        provider: 'stub-tax',
        inclusive: params.pricesIncludeTax,
        lines: params.lines.map((l: TaxQuoteLine) => ({
          id: l.id,
          taxableMinor: l.amountMinor,
          taxMinor: 1,
        })),
        shippingTaxMinor: 0,
        totalTaxMinor: params.lines.length + 1,
      }
    },
  }
}

const LINES: TaxQuoteParams['lines'] = [
  { id: 'v-1', sku: 'SKU-1', amountMinor: 4_999, qty: 2 },
  { id: 'v-2', sku: 'SKU-2', taxCode: 'food', amountMinor: 1_250, qty: 1 },
]

function quoter(
  adapter: TaxAdapter,
  onUnavailable: 'refuse' | 'native',
  pricesIncludeTax: boolean,
) {
  return createTaxQuoter({
    adapter,
    fallback: createNativeTaxAdapter({ logger, rates: RATES }),
    onUnavailable,
    pricesIncludeTax,
    boundMs: TAX_BOUND_MS,
    logger,
  })
}

/** What the quoter answers or throws for one outage, the bound passed on the fake clock where that is the outage. */
async function outcome(outage: Outage, onUnavailable: 'refuse' | 'native', inclusive: boolean) {
  const params = paramsOf(LINES, inclusive)
  const settled = quoter(stubAdapter(outage), onUnavailable, inclusive)
    .quote(params)
    .then(
      (value: { quote: TaxQuote; fallback: boolean }) => ({ value }),
      (error: unknown) => ({ error }),
    )
  if (outage === 'bound') await vi.advanceTimersByTimeAsync(TAX_BOUND_MS)
  return { params, result: await settled }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-24: createTaxQuoter', () => {
  it('AC-24: a valid answer within the bound is the tax, not a fallback, under either setting', async () => {
    for (const onUnavailable of ['refuse', 'native'] as const) {
      for (const inclusive of [false, true]) {
        const params = paramsOf(LINES, inclusive)
        const answer: TaxQuote = {
          provider: 'stub-tax',
          inclusive,
          lines: LINES.map((l: TaxQuoteLine) => ({
            id: l.id,
            taxableMinor: l.amountMinor,
            taxMinor: 7,
            ratePpm: 1,
          })),
          shippingTaxMinor: 0,
          totalTaxMinor: 14,
          quoteId: 'q-1',
        }

        const got = await quoter(stubAdapter({ answer }), onUnavailable, inclusive).quote(params)

        expect(got, `${onUnavailable}, inclusive ${inclusive}`).toEqual({
          quote: answer,
          fallback: false,
        })
      }
    }
  })

  // Kills: an outage answered as a zero or partial tax; the fallback used when the store chose to refuse.
  it.each(OUTAGES)(
    'AC-24: an outage (%s) under refuse throws CheckoutError checkout.tax_unavailable',
    async (outage) => {
      vi.useFakeTimers()
      for (const inclusive of [false, true]) {
        const { result } = await outcome(outage, 'refuse', inclusive)

        expect('error' in result, JSON.stringify(result)).toBe(true)
        const error = (result as { error: unknown }).error
        expect(error).toBeInstanceOf(CheckoutError)
        expect(error).toMatchObject({ code: 'checkout.tax_unavailable' })
      }
    },
  )

  it.each(OUTAGES)(
    'AC-24: an outage (%s) under native answers the native table’s quote, marked fallback',
    async (outage) => {
      vi.useFakeTimers()
      for (const inclusive of [false, true]) {
        const { params, result } = await outcome(outage, 'native', inclusive)

        expect(result, `inclusive ${inclusive}`).toEqual({
          value: { quote: quoteNative(RATES, params), fallback: true },
        })
        const value = (result as { value: { quote: TaxQuote } }).value
        expect(value.quote.totalTaxMinor).toBeGreaterThan(0)
      }
    },
  )

  it('AC-24: an answer that has not come is not an outage one tick before the bound, and is at the bound', async () => {
    vi.useFakeTimers()
    let state: 'pending' | 'refused' = 'pending'
    const settled = quoter(stubAdapter('bound'), 'refuse', false)
      .quote(paramsOf(LINES, false))
      .catch((err: unknown) => {
        state = 'refused'
        throw err
      })
    settled.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(TAX_BOUND_MS - 1)
    const before = state
    await vi.advanceTimersByTimeAsync(1)

    expect([before, state]).toEqual(['pending', 'refused'])
    await expect(settled).rejects.toMatchObject({ code: 'checkout.tax_unavailable' })
    expect(TAX_BOUND_MS).toBe(3000)
  })

  // Kills: a provider that throws before returning a promise leaving the bound's timer to reject unheld and end the
  // process.
  it('AC-24: a provider that throws synchronously is an outage at once, and leaves no timer behind', async () => {
    vi.useFakeTimers()
    const throwing: TaxAdapter = {
      ...stubAdapter('throws'),
      quote: (): Promise<TaxQuote> => {
        throw new Error('tax provider threw before answering')
      },
    }
    const params = paramsOf(LINES, false)

    const refused = quoter(throwing, 'refuse', false).quote(params)
    await expect(refused).rejects.toMatchObject({ code: 'checkout.tax_unavailable' })
    const timersAfterRefusal = vi.getTimerCount()
    const fellBack = await quoter(throwing, 'native', false).quote(params)

    expect([timersAfterRefusal, vi.getTimerCount()]).toEqual([0, 0])
    expect(fellBack).toEqual({ quote: quoteNative(RATES, params), fallback: true })
  })

  // Kills: the native engine raced against a timer, so a slow table read is refused or swapped for itself as a fallback.
  it('AC-24: the native adapter as the engine is never raced against the bound: an answer long past it is the tax, not an outage', async () => {
    vi.useFakeTimers()
    const native = createNativeTaxAdapter({ logger, rates: RATES })
    const answer = native.quote.bind(native)
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    native.quote = async (params: TaxQuoteParams) => {
      await gate
      return answer(params)
    }
    const params = paramsOf(LINES, false)
    const settled = createTaxQuoter({
      adapter: native,
      fallback: native,
      onUnavailable: 'refuse',
      pricesIncludeTax: false,
      boundMs: TAX_BOUND_MS,
      logger,
    })
      .quote(params)
      .then(
        (value: { quote: TaxQuote; fallback: boolean }) => ({ value }),
        (error: unknown) => ({ error }),
      )

    await vi.advanceTimersByTimeAsync(TAX_BOUND_MS * 10)
    release()

    expect(await settled).toEqual({ value: { quote: quoteNative(RATES, params), fallback: false } })
  })
})
