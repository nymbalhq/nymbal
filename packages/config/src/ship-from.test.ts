import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfigInput } from './schema.js'

// `store.shipFrom`, the address a store ships from: optional, and when given a whole Address the schema checks (a
// two-upper-case-letter country, every required field, `region` allowed empty for countries without one), kept as
// given. Read by nobody yet; checkout rates will take it as `from`.

function config(shipFrom?: unknown): NymbalConfigInput {
  return {
    store: {
      name: 'Test',
      currency: 'GBP',
      locale: 'en-GB',
      timezone: 'Europe/London',
      ...(shipFrom !== undefined && { shipFrom }),
    },
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
      tax: { provider: 'native' },
      ai: { provider: 'none' },
    },
    http: { adapter: 'fastify', port: 3001, host: '0.0.0.0' },
    deployment: { strategy: 'standard' },
  } as NymbalConfigInput
}

const WAREHOUSE = {
  firstName: 'Nymbal',
  lastName: 'Warehouse',
  company: 'Nymbal Ltd',
  addressLine1: '1 Dock Road',
  addressLine2: 'Unit 4',
  city: 'Leeds',
  region: 'West Yorkshire',
  postalCode: 'LS1 4AP',
  country: 'GB',
  phone: '+441130000000',
}

/** The issue paths a refusal names, joined with dots. */
function refusedAt(shipFrom: unknown): string[] {
  const result = nymbalConfigSchema.safeParse(config(shipFrom))
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'))
}

const arbAddress = fc.record(
  {
    firstName: fc.stringMatching(/^[A-Z][a-z]{1,10}$/),
    lastName: fc.stringMatching(/^[A-Z][a-z]{1,12}$/),
    company: fc.stringMatching(/^[A-Z][a-z]{2,10} Ltd$/),
    addressLine1: fc.stringMatching(/^[1-9]\d{0,3} [A-Z][a-z]{2,10} Road$/),
    addressLine2: fc.stringMatching(/^Unit [1-9]$/),
    city: fc.stringMatching(/^[A-Z][a-z]{2,12}$/),
    region: fc.oneof(fc.constant(''), fc.stringMatching(/^[A-Z][a-z]{2,12}$/)),
    postalCode: fc.stringMatching(/^[A-Z0-9]{2,4} ?[A-Z0-9]{0,3}$/),
    country: fc.stringMatching(/^[A-Z]{2}$/),
    phone: fc.stringMatching(/^\+?\d{6,14}$/),
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

const shipFromOf = (shipFrom?: unknown): unknown =>
  (nymbalConfigSchema.parse(config(shipFrom)).store as { shipFrom?: unknown }).shipFrom

describe('AC-15: store.shipFrom', () => {
  // Kills: an origin dropped or reshaped on the way in, so rates would be asked from somewhere else; shipFrom made
  // required, so every existing config stops loading.
  it('AC-15: property: a whole generated Address, region empty or not, validates and is kept as given, and a config without shipFrom validates with none', () => {
    fc.assert(
      fc.property(arbAddress, (address) => {
        expect(shipFromOf(address)).toEqual(address)
      }),
      { numRuns: 100 },
    )
    expect(shipFromOf()).toBeUndefined()
  })

  it("AC-15: region '' validates and is kept, for a country without regions", () => {
    const singapore = { ...WAREHOUSE, region: '', country: 'SG' }

    expect([refusedAt(singapore), shipFromOf(singapore)]).toEqual([[], singapore])
  })

  it.each([
    [
      'postalCode missing',
      'store.shipFrom.postalCode',
      (({ postalCode: _p, ...rest }) => rest)(WAREHOUSE),
    ],
    ["country 'gb'", 'store.shipFrom.country', { ...WAREHOUSE, country: 'gb' }],
    ["country 'GBR'", 'store.shipFrom.country', { ...WAREHOUSE, country: 'GBR' }],
  ])('AC-15: a shipFrom with %s is refused naming %s', (_what, field, shipFrom) => {
    expect(refusedAt(shipFrom)).toEqual([field])
    expect(refusedAt(WAREHOUSE)).toEqual([])
  })
})
