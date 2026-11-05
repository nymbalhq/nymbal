import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { anonymisedCustomerEmail, mapCustomer } from '../../src/woocommerce/mappers/customer.js'
import type { WcCustomer } from '../../src/woocommerce/client.js'

function makeCustomer(overrides: Partial<WcCustomer> = {}): WcCustomer {
  return {
    id: 1,
    email: 'test@example.com',
    first_name: 'Alice',
    last_name: 'Smith',
    username: 'alice',
    billing: {
      first_name: 'Alice',
      last_name: 'Smith',
      company: '',
      address_1: '1 Main St',
      address_2: '',
      city: 'London',
      state: 'England',
      postcode: 'E1 6AN',
      country: 'GB',
      phone: '07700900000',
      email: 'test@example.com',
    },
    shipping: {
      first_name: 'Alice',
      last_name: 'Smith',
      company: '',
      address_1: '1 Main St',
      address_2: '',
      city: 'London',
      state: 'England',
      postcode: 'E1 6AN',
      country: 'GB',
      phone: '',
    },
    meta_data: [],
    date_created: '2024-01-01T00:00:00',
    ...overrides,
  }
}

describe('mapCustomer', () => {
  it('maps full customer in non-GDPR mode', () => {
    const result = mapCustomer(makeCustomer(), false)
    expect(result.email).toBe('test@example.com')
    expect(result.firstName).toBe('Alice')
    expect(result.lastName).toBe('Smith')
    expect(result.addresses).toHaveLength(1)
    const addr = result.addresses?.[0]
    expect(addr?.city).toBe('London')
    expect(addr?.isDefaultBilling).toBe(true)
  })

  it('anonymises email in GDPR mode', () => {
    const result = mapCustomer(makeCustomer(), true)
    expect(result.email).toContain('@imported.nymbal.local')
    expect(result.email).not.toContain('test@example.com')
  })

  it('drops name and addresses in GDPR mode', () => {
    const result = mapCustomer(makeCustomer(), true)
    expect(result.firstName).toBeUndefined()
    expect(result.lastName).toBeUndefined()
    expect(result.addresses).toBeUndefined()
  })

  it('produces consistent anonymised email for same customer id', () => {
    const a = mapCustomer(makeCustomer({ id: 42 }), true)
    const b = mapCustomer(makeCustomer({ id: 42 }), true)
    expect(a.email).toBe(b.email)
  })

  it('produces different anonymised emails for different customers', () => {
    const a = mapCustomer(makeCustomer({ id: 1 }), true)
    const b = mapCustomer(makeCustomer({ id: 2 }), true)
    expect(a.email).not.toBe(b.email)
  })

  it('stores WC customer id in metadata', () => {
    const result = mapCustomer(makeCustomer({ id: 99 }), false)
    const meta = result.metadata?.['woocommerce'] as Record<string, unknown>
    expect(meta['customerId']).toBe(99)
  })

  it('omits addresses when billing is empty', () => {
    const result = mapCustomer(
      makeCustomer({ billing: { ...makeCustomer().billing, address_1: '' } }),
      false,
    )
    expect(result.addresses).toBeUndefined()
  })

  it('carries the billing address line by line, defaulting only the country', () => {
    const billing = {
      ...makeCustomer().billing,
      address_2: 'Flat 3',
      company: 'Acme Ltd',
      phone: '07700900001',
      country: '',
    }
    const addr = mapCustomer(makeCustomer({ billing }), false).addresses?.[0]
    expect(addr).toMatchObject({
      firstName: 'Alice',
      lastName: 'Smith',
      addressLine1: '1 Main St',
      addressLine2: 'Flat 3',
      company: 'Acme Ltd',
      phone: '07700900001',
      city: 'London',
      region: 'England',
      postalCode: 'E1 6AN',
      country: 'US',
      isDefaultBilling: true,
      isDefaultShipping: false,
    })
  })

  it('leaves out an empty second line, company and phone, and keeps a given country', () => {
    const billing = { ...makeCustomer().billing, address_2: '', company: '', phone: '' }
    const addr = mapCustomer(makeCustomer({ billing }), false).addresses?.[0]
    expect(addr?.country).toBe('GB')
    expect(
      Object.keys(addr ?? {}).filter((k) => ['addressLine2', 'company', 'phone'].includes(k)),
    ).toEqual([])
  })

  it('leaves out an empty first or last name', () => {
    const result = mapCustomer(makeCustomer({ first_name: '', last_name: '' }), false)
    expect('firstName' in result).toBe(false)
    expect('lastName' in result).toBe(false)
  })

  it("anonymises to the first 12 hex digits of the id's SHA-256, and keeps the id and sync time", () => {
    const before = Date.now()
    const result = mapCustomer(makeCustomer({ id: 42 }), true)
    const hash = createHash('sha256').update('42').digest('hex').slice(0, 12)
    expect(result.email).toBe(`customer-${hash}@imported.nymbal.local`)
    expect(anonymisedCustomerEmail(42)).toBe(result.email)
    const meta = result.metadata?.['woocommerce'] as Record<string, unknown>
    expect(meta['customerId']).toBe(42)
    expect(Date.parse(String(meta['syncedAt']))).toBeGreaterThanOrEqual(before - 1000)
  })
})
