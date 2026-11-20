import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// `commerce.tax`'s rate table and outage setting, and `store.pricesIncludeTax`: what every config written before them
// parses to, and each refusal named at its path, so a merchant reading the error finds the row and field to fix.

function config(tax: unknown, store: Record<string, unknown> = {}): NymbalConfigInput {
  return {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London', ...store },
    template: 'astro',
    infrastructure: {
      commandStore: 'sqlite',
      documentStore: { provider: 'in-memory' },
      eventBus: { provider: 'in-process' },
    },
    security: { adapter: 'middleware', rateLimit: {}, csrf: true },
    commerce: {
      payments: { provider: 'native' },
      email: { provider: 'native' },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax,
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  } as NymbalConfigInput
}

/** The issue paths a refusal names, joined with dots; none when the config parses. */
function refusedAt(tax: unknown, store: Record<string, unknown> = {}): string[] {
  const result = nymbalConfigSchema.safeParse(config(tax, store))
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
}

const STATE_CODES = ['AL', 'CA', 'DC', 'NY', 'TX', 'WA', 'WY'] as const

/** A percent from 0 to 100 with at most four decimals. */
const arbPercent = fc.integer({ min: 0, max: 1_000_000 }).map((t) => t / 10_000)

const arbRow = fc.oneof(
  fc.record(
    {
      country: fc.constantFrom('GB', 'FR', 'DE', 'CA', 'AU'),
      region: fc.stringMatching(/^[A-Z][a-z]{2,10}$/),
      percent: arbPercent,
      codes: fc.dictionary(fc.constantFrom('food', 'books', 'clothing'), arbPercent),
    },
    { requiredKeys: ['country', 'percent'] },
  ),
  fc.record(
    {
      country: fc.constant('US'),
      region: fc.constantFrom(...STATE_CODES),
      percent: arbPercent,
      codes: fc.dictionary(fc.constantFrom('food', 'books', 'clothing'), arbPercent),
    },
    { requiredKeys: ['country', 'region', 'percent'] },
  ),
)

const arbTable = fc.uniqueArray(arbRow, {
  minLength: 1,
  maxLength: 6,
  selector: (row) => `${row.country}/${row.region ?? ''}`,
})

const GB = { country: 'GB', percent: 20 }
const NY = { country: 'US', region: 'NY', percent: 8.875 }
const GB_BLOCK = { provider: 'native', rates: [GB] }

describe('AC-6: the tax config', () => {
  // Kills: a config written before the table stops booting, or reads as anything but "no tax, refuse when down".
  it('AC-6: every commerce.tax block written before the table parses to rates [] and onUnavailable refuse, and an absent store.pricesIncludeTax to false', () => {
    for (const block of [
      { provider: 'native' },
      { provider: 'native', config: {} },
      { provider: 'custom' },
      { provider: 'custom', config: { region: 'eu' } },
    ]) {
      const parsed = nymbalConfigSchema.parse(config(block))
      expect(parsed.commerce.tax, JSON.stringify(block)).toEqual({
        ...block,
        onUnavailable: 'refuse',
        rates: [],
      })
      expect(parsed.store.pricesIncludeTax).toBe(false)
    }
    expect(
      nymbalConfigSchema.parse(config(GB_BLOCK, { pricesIncludeTax: true })).store.pricesIncludeTax,
    ).toBe(true)
  })

  it('AC-6: property: a table of distinct rows with two-letter countries, US state codes and percents of up to four decimals parses as written, with taxShipping defaulted to true, under either outage setting', () => {
    fc.assert(
      fc.property(arbTable, fc.constantFrom('refuse', 'native'), (rates, onUnavailable) => {
        const parsed = nymbalConfigSchema.parse(
          config({ provider: 'native', onUnavailable, rates }),
        )
        expect(parsed.commerce.tax).toEqual({
          provider: 'native',
          onUnavailable,
          rates: rates.map((row) => ({ ...row, taxShipping: true })),
        })
      }),
      { numRuns: 200 },
    )
  })

  // The bad row is the third, so the path must carry its index.
  it.each([
    ['a lower-case country', 'country', { country: 'gb', percent: 20 }],
    ['a three-letter country', 'country', { country: 'GBR', percent: 20 }],
    ['a US region given as a name', 'region', { country: 'US', region: 'California', percent: 7 }],
    ['a US region that is no state', 'region', { country: 'US', region: 'XX', percent: 7.25 }],
    ['a US territory', 'region', { country: 'US', region: 'PR', percent: 7.25 }],
    ['a percent below 0', 'percent', { country: 'FR', percent: -0.0001 }],
    ['a percent above 100', 'percent', { country: 'FR', percent: 100.0001 }],
    ['a percent with five decimals', 'percent', { country: 'FR', percent: 7.12345 }],
    ['a code rate below 0', 'codes.food', { country: 'FR', percent: 20, codes: { food: -1 } }],
    ['a code rate above 100', 'codes.food', { country: 'FR', percent: 20, codes: { food: 101 } }],
    [
      'a code rate with five decimals',
      'codes.food',
      { country: 'FR', percent: 20, codes: { food: 5.00001 } },
    ],
  ])('AC-6: %s is refused at commerce.tax.rates.2.%s', (_what, field, row) => {
    expect(refusedAt({ provider: 'native', rates: [GB, NY, row] })).toEqual([
      `commerce.tax.rates.2.${field}`,
    ])
  })

  // Kills: a duplicate row silently picking one rate.
  it('AC-6: two rows for one country, or for one US state, are refused under commerce.tax.rates; a country’s row beside a row for one of its regions is not a duplicate', () => {
    for (const rates of [
      [GB, NY, { country: 'GB', percent: 5 }],
      [GB, NY, { country: 'US', region: 'NY', percent: 4 }],
    ]) {
      const paths = refusedAt({ provider: 'native', rates })
      expect(paths.length, JSON.stringify(rates)).toBe(1)
      expect(paths[0]!.startsWith('commerce.tax.rates'), paths[0]).toBe(true)
    }
    expect(
      refusedAt({ provider: 'native', rates: [GB, { country: 'US', percent: 0 }, NY] }),
    ).toEqual([])
  })

  it('AC-6: an onUnavailable outside refuse and native is refused at commerce.tax.onUnavailable', () => {
    for (const word of ['proceed', 'skip', 'NATIVE', '']) {
      expect(refusedAt({ provider: 'custom', onUnavailable: word, rates: [GB] }), word).toEqual([
        'commerce.tax.onUnavailable',
      ])
    }
  })

  // Kills: a fallback with no table guessing a zero tax.
  it('AC-6: onUnavailable native with no rates, written or defaulted, is refused at commerce.tax.rates; with a table it parses', () => {
    expect(refusedAt({ provider: 'custom', onUnavailable: 'native', rates: [] })).toEqual([
      'commerce.tax.rates',
    ])
    expect(refusedAt({ provider: 'custom', onUnavailable: 'native' })).toEqual([
      'commerce.tax.rates',
    ])
    expect(refusedAt({ provider: 'custom', onUnavailable: 'native', rates: [GB] })).toEqual([])
  })
})
