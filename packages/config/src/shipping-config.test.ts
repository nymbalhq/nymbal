import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// `commerce.shipping`'s rate table and a tax row's `taxShipping`: what every config written before them parses to,
// and each refusal named at its path, so a merchant reading the error finds the row and field to fix.

function config(shipping: unknown, tax: unknown = { provider: 'native' }): NymbalConfigInput {
  return {
    store: { name: 'Test', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
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
      shipping,
      tax,
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  } as NymbalConfigInput
}

/** The issue paths a refusal names, joined with dots, beside its messages; none when the config parses. */
function refused(shipping: unknown): { paths: string[]; messages: string } {
  const result = nymbalConfigSchema.safeParse(config(shipping))
  return result.success
    ? { paths: [], messages: '' }
    : {
        paths: result.error.issues.map((i) => i.path.join('.')),
        messages: result.error.message,
      }
}

const STANDARD = { id: 'standard', name: 'Standard', amountMinor: 0 }
const EXPRESS = { id: 'express', name: 'Express', countries: ['GB'], amountMinor: 499 }

const arbRow = fc.record(
  {
    id: fc.stringMatching(/^[a-z0-9_-]{1,64}$/),
    name: fc.string({ minLength: 1, maxLength: 64 }),
    countries: fc.uniqueArray(fc.constantFrom('GB', 'FR', 'DE', 'US', 'IE', 'AU'), {
      minLength: 1,
      maxLength: 4,
    }),
    amountMinor: fc.integer({ min: 0, max: 1_000_000 }),
    freeOverMinor: fc.integer({ min: 1, max: 1_000_000 }),
    estimatedDays: fc.integer({ min: 0, max: 60 }),
  },
  { requiredKeys: ['id', 'name', 'amountMinor'] },
)

const arbTable = fc.uniqueArray(arbRow, { minLength: 1, maxLength: 6, selector: (row) => row.id })

describe('AC-1: the shipping config', () => {
  // Kills: a config written before the table stops booting, or reads as anything but "no table".
  it('AC-1: every commerce.shipping block written before the table parses as written with rates []', () => {
    for (const block of [
      { provider: 'native' },
      { provider: 'native', config: {} },
      { provider: 'easypost', config: { webhookSecret: 'whsec' } },
      { provider: 'easypost', config: { apiKey: 'EZTK_x', webhookSecret: 'whsec' } },
    ]) {
      const parsed = nymbalConfigSchema.parse(config(block))
      expect(parsed.commerce.shipping, JSON.stringify(block)).toEqual({ ...block, rates: [] })
    }
  })

  it('AC-1: every tax row written before taxShipping parses to taxShipping true, and false stays false', () => {
    const rows = [
      { country: 'GB', percent: 20 },
      { country: 'US', region: 'NY', percent: 8.875, codes: { food: 0 } },
    ]
    const parsed = nymbalConfigSchema.parse(
      config({ provider: 'native' }, { provider: 'native', rates: rows }),
    )
    expect(parsed.commerce.tax.rates).toEqual(rows.map((row) => ({ ...row, taxShipping: true })))
    const exempt = nymbalConfigSchema.parse(
      config(
        { provider: 'native' },
        { provider: 'native', rates: [{ country: 'GB', percent: 20, taxShipping: false }] },
      ),
    )
    expect(exempt.commerce.tax.rates.map((row) => row.taxShipping)).toEqual([false])
  })

  it('AC-1: property: a table of rows with distinct ids, two-letter countries and whole amounts parses as written, under any provider', () => {
    fc.assert(
      fc.property(arbTable, fc.constantFrom('native', 'easypost'), (rates, provider) => {
        const parsed = nymbalConfigSchema.parse(config({ provider, rates }))
        expect(parsed.commerce.shipping.rates).toEqual(rates)
      }),
      { numRuns: 200 },
    )
  })

  // The bad row is the third, so the path must carry its index.
  it.each([
    ['an id with an upper-case letter', 'id', { ...STANDARD, id: 'Next-day' }],
    ['an id with a space', 'id', { ...STANDARD, id: 'next day' }],
    ['an empty id', 'id', { ...STANDARD, id: '' }],
    ['an id of 65 characters', 'id', { ...STANDARD, id: 'a'.repeat(65) }],
    ['an empty name', 'name', { ...STANDARD, id: 'collect', name: '' }],
    ['a name of 65 characters', 'name', { ...STANDARD, id: 'collect', name: 'n'.repeat(65) }],
    ['a lower-case country', 'countries.0', { ...STANDARD, id: 'eu', countries: ['fr'] }],
    ['a three-letter country', 'countries.1', { ...STANDARD, id: 'eu', countries: ['FR', 'DEU'] }],
    ['an empty countries list', 'countries', { ...STANDARD, id: 'eu', countries: [] }],
    ['a negative amount', 'amountMinor', { ...STANDARD, id: 'eu', amountMinor: -1 }],
    ['a fractional amount', 'amountMinor', { ...STANDARD, id: 'eu', amountMinor: 4.99 }],
    ['a freeOverMinor of 0', 'freeOverMinor', { ...STANDARD, id: 'eu', freeOverMinor: 0 }],
    ['a negative freeOverMinor', 'freeOverMinor', { ...STANDARD, id: 'eu', freeOverMinor: -100 }],
    ['a fractional freeOverMinor', 'freeOverMinor', { ...STANDARD, id: 'eu', freeOverMinor: 0.5 }],
    ['a negative estimatedDays', 'estimatedDays', { ...STANDARD, id: 'eu', estimatedDays: -1 }],
  ])('AC-1: %s is refused at commerce.shipping.rates.2.%s', (_what, field, row) => {
    expect(refused({ provider: 'native', rates: [STANDARD, EXPRESS, row] }).paths).toEqual([
      `commerce.shipping.rates.2.${field}`,
    ])
  })

  // Kills: two options sharing an id, so a caller's choice names either.
  it('AC-1: a repeated id is refused under commerce.shipping.rates with the id in the message; the same name under two ids is not', () => {
    const { paths, messages } = refused({
      provider: 'native',
      rates: [STANDARD, EXPRESS, { ...EXPRESS, countries: ['FR'] }],
    })
    expect(paths.length).toBe(1)
    expect(paths[0]!.startsWith('commerce.shipping.rates'), paths[0]).toBe(true)
    expect(messages).toContain('express')
    expect(
      refused({
        provider: 'native',
        rates: [STANDARD, EXPRESS, { ...EXPRESS, id: 'express-fr', countries: ['FR'] }],
      }).paths,
    ).toEqual([])
  })
})
