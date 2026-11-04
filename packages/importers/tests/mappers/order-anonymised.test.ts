import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mapOrder } from '../../src/woocommerce/mappers/order.js'
import { anonymisedCustomerEmail, mapCustomer } from '../../src/woocommerce/mappers/customer.js'
import type { WcCustomer, WcOrder } from '../../src/woocommerce/client.js'

// The order mapper under `gdpr`: what an imported order keeps of its buyer. Every personal value in these orders is a
// token no other string holds, so a value that leaks is found wherever it lands.

type Rec = Record<string, unknown>

const hash12 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12)

const STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
]

const drawn = fc.record({
  id: fc.integer({ min: 1, max: 10_000_000 }),
  customerId: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 1_000_000 })),
  salt: fc.string({
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    minLength: 6,
    maxLength: 6,
  }),
  billTo: fc.constantFrom(['GB', 'yorkshire'], ['US', 'CA'], ['DE', 'BE']),
  /** Shipping's country is empty now and then, with or without a region. */
  shipTo: fc.constantFrom(['', ''], ['', 'kent'], ['FR', 'IDF'], ['GB', 'cornwall']),
  status: fc.constantFrom(...STATUSES),
})

type Drawn = typeof drawn extends fc.Arbitrary<infer T> ? T : never

/** An order whose every personal value is `Tok<field><salt>X`; region and country are plain. */
function personalOrder(d: Drawn): { wc: WcOrder; tokens: string[] } {
  const tokens: string[] = []
  const tok = (field: string) => {
    const t = `Tok${field}${d.salt}X`
    tokens.push(t)
    return t
  }
  const address = (side: string, [country, region]: readonly string[], email?: string): Rec => ({
    first_name: tok(`${side}First`),
    last_name: tok(`${side}Last`),
    company: tok(`${side}Company`),
    address_1: tok(`${side}StreetA`),
    address_2: tok(`${side}StreetB`),
    city: tok(`${side}City`),
    state: region,
    postcode: tok(`${side}Postcode`),
    country,
    phone: tok(`${side}Phone`),
    ...(email !== undefined && { email }),
  })
  const order: Rec = {
    id: d.id,
    number: String(d.id),
    status: d.status,
    currency: 'GBP',
    date_created: '2024-02-01T12:00:00',
    customer_id: d.customerId,
    billing: address('Bill', d.billTo, `${tok('Email')}@example.com`),
    shipping: address('Ship', d.shipTo),
    line_items: [
      {
        id: 1,
        product_id: 100,
        variation_id: 0,
        name: 'Plain tee',
        quantity: 1,
        price: 20,
        subtotal: '20.00',
        subtotal_tax: '4.00',
        total: '20.00',
        total_tax: '4.00',
        sku: 'TEE-1',
        meta_data: [{ id: 1, key: 'Engraving', value: tok('Engraving') }],
      },
    ],
    shipping_lines: [{ method_title: 'Flat rate', total: '5.00', total_tax: '1.00' }],
    tax_lines: [{ label: 'VAT', tax_total: '5.00' }],
    discount_total: '0.00',
    shipping_total: '5.00',
    total_tax: '5.00',
    total: '30.00',
    customer_note: tok('Note'),
    customer_ip_address: tok('Ip'),
    customer_user_agent: tok('Agent'),
    meta_data: [{ id: 2, key: 'gift_message', value: tok('Gift') }],
    payment_method: 'stripe',
  }
  return { wc: order as unknown as WcOrder, tokens }
}

function customer(id: number): WcCustomer {
  const address = {
    first_name: 'Ann',
    last_name: 'Other',
    company: '',
    address_1: '1 Lane',
    address_2: '',
    city: 'York',
    state: 'yorkshire',
    postcode: 'YO1 1AA',
    country: 'GB',
    phone: '',
  }
  return {
    id,
    email: `ann${id}@example.com`,
    first_name: 'Ann',
    last_name: 'Other',
    username: `ann${id}`,
    billing: { ...address, email: `ann${id}@example.com` },
    shipping: address,
    meta_data: [],
    date_created: '2024-01-01T00:00:00',
  }
}

describe('AC-2: an order mapped under gdpr keeps nothing personal', () => {
  it("AC-2: under gdpr both addresses are blank but for region and country (shipping's own when it names a country, else billing's), there is no note, the email is the customer's anonymised one or a guest address of the order, and metadata holds no personal value", () => {
    fc.assert(
      fc.property(drawn, (d) => {
        const { wc, tokens } = personalOrder(d)
        const mapped = mapOrder(
          wc,
          d.customerId > 0 ? 'nymbal-customer' : null,
          { 100: 'p-100' },
          'GBP',
          {
            gdpr: true,
          },
        )

        const blank = ([country, region]: readonly string[]) => ({
          firstName: '',
          lastName: '',
          addressLine1: '—',
          city: '—',
          postalCode: '',
          region,
          country,
        })
        const shipTo = d.shipTo[0] !== '' ? d.shipTo : d.billTo
        const email =
          d.customerId > 0
            ? mapCustomer(customer(d.customerId), true).email
            : `order-${hash12(String(d.id))}@imported.nymbal.local`

        expect({
          billing: mapped.billingAddress,
          shipping: mapped.shippingAddress,
          email: mapped.email,
          notes: mapped.notes ?? 'none',
          personalInMetadata: tokens.filter((t) => JSON.stringify(mapped.metadata).includes(t)),
        }).toEqual({
          billing: blank(d.billTo),
          shipping: blank(shipTo),
          email,
          notes: 'none',
          personalInMetadata: [],
        })
      }),
      { numRuns: 200 },
    )
  })

  it('AC-2: two guest orders under gdpr get two different addresses, each the hash of its own order id', () => {
    fc.assert(
      fc.property(drawn, fc.integer({ min: 1, max: 10_000_000 }), (d, otherId) => {
        fc.pre(otherId !== d.id)
        const guest = { ...d, customerId: 0 }
        const a = mapOrder(personalOrder(guest).wc, null, {}, 'GBP', { gdpr: true })
        const b = mapOrder(personalOrder({ ...guest, id: otherId }).wc, null, {}, 'GBP', {
          gdpr: true,
        })

        expect([a.email, b.email]).toEqual([
          `order-${hash12(String(d.id))}@imported.nymbal.local`,
          `order-${hash12(String(otherId))}@imported.nymbal.local`,
        ])
        expect(a.email).not.toBe(b.email)
      }),
    )
  })

  it('AC-2: anonymisedCustomerEmail(id) is the email mapCustomer gives that customer under gdpr', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000 }), (id) => {
        expect(anonymisedCustomerEmail(id)).toBe(mapCustomer(customer(id), true).email)
      }),
    )
  })

  it('AC-2: without gdpr a billing email that is empty or blank becomes wc-<id>@unknown.nymbal.local', () => {
    fc.assert(
      fc.property(drawn, fc.constantFrom('', '  '), (d, blankEmail) => {
        const { wc } = personalOrder(d)
        const order = { ...wc, billing: { ...wc.billing, email: blankEmail } }

        expect(mapOrder(order, null, {}, 'GBP').email).toBe(`wc-${d.id}@unknown.nymbal.local`)
      }),
    )
  })
})
