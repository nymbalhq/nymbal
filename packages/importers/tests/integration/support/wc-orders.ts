import fc from 'fast-check'

// WooCommerce REST v3 order money that adds up, in a currency's own minor units: product lines with a discount and
// tax, shipping lines with tax, positive and negative fee lines, and refunds. Amounts are drawn as integers of minor
// units and written as WooCommerce writes them (a decimal string to the currency's exponent); the tests read them back
// with `parseMinor`, their own exact decimal parse. Imports nothing of the importer or the platform, so a unit test and
// the generated stores of woo-store.ts can both use it.

export type Rec = Record<string, unknown>

/** The currencies the order money is drawn in, and their minor-unit exponents (ISO 4217). */
export const EXPONENT = { GBP: 2, USD: 2, JPY: 0, KWD: 3 } as const
export type TestCurrency = keyof typeof EXPONENT
export const CURRENCIES = Object.keys(EXPONENT) as TestCurrency[]

/** `minor` written to `currency`'s exponent: 1500 JPY is `"1500"`, 1234 KWD is `"1.234"`, -900 GBP is `"-9.00"`. */
export function decimal(minor: number, currency: TestCurrency): string {
  const exp = EXPONENT[currency]
  const sign = minor < 0 ? '-' : ''
  const digits = String(Math.abs(minor)).padStart(exp + 1, '0')
  return exp === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -exp)}.${digits.slice(-exp)}`
}

/** A decimal string written to `currency`'s exponent, as an integer of minor units, by its digits: no float. */
export function parseMinor(value: string, currency: TestCurrency): number {
  const exp = EXPONENT[currency]
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (m === null) throw new Error(`not a decimal: ${JSON.stringify(value)}`)
  const fraction = (m[3] ?? '').padEnd(exp, '0')
  if (fraction.length !== exp) throw new Error(`${value} has more digits than ${currency} keeps`)
  const n = Number(`${m[2]}${fraction}`)
  return m[1] === '-' ? -n : n
}

export interface MoneyDraft {
  lines: Array<{
    unit: number
    qty: number
    discountShare: number
    tax: number
    untaxedShare: number
  }>
  shipping: Array<{ total: number; tax: number }>
  fees: Array<{ amount: number; tax: number; name: string }>
  refundShares: number[]
}

export const moneyDraft: fc.Arbitrary<MoneyDraft> = fc.record({
  lines: fc.array(
    fc.record({
      unit: fc.integer({ min: 0, max: 20_000 }),
      qty: fc.integer({ min: 1, max: 4 }),
      /** The share of the line's subtotal a coupon took off, in hundredths. */
      discountShare: fc.integer({ min: 0, max: 100 }),
      tax: fc.integer({ min: 0, max: 5_000 }),
      /** The tax the discount took off, so a line's `subtotal_tax` is not its `total_tax`. */
      untaxedShare: fc.integer({ min: 0, max: 2_000 }),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  shipping: fc.array(
    fc.record({ total: fc.integer({ min: 0, max: 2_000 }), tax: fc.integer({ min: 0, max: 400 }) }),
    { maxLength: 2 },
  ),
  fees: fc.array(
    fc.record({
      amount: fc.integer({ min: -5_000, max: 5_000 }),
      tax: fc.integer({ min: 0, max: 300 }),
      name: fc.constantFrom('Gift wrap', 'Loyalty credit', 'Card surcharge'),
    }),
    { maxLength: 2 },
  ),
  refundShares: fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 2 }),
})

/** What a product line is of: the WooCommerce product and, for a variable product, the variation bought. */
export interface LineRef {
  productId: number
  variationId: number
  sku: string
}

/**
 * The money fields of an order (`line_items`, `shipping_lines`, `fee_lines`, `tax_lines`, `refunds` and the totals)
 * for `draft` in `currency`, its lines over `refs` (one per draft line, cycled). The order adds up:
 * Σ line.total + Σ shipping.total + Σ fee.total + total_tax = total, and Σ line.subtotal − discount_total =
 * Σ line.total. A negative fee never takes the total below 0, and the refunds never exceed the total.
 */
export function orderMoney(draft: MoneyDraft, currency: TestCurrency, refs: LineRef[]): Rec {
  const d = (minor: number) => decimal(minor, currency)
  const scale = 10 ** EXPONENT[currency]
  let running = 0
  let taxTotal = 0
  let discountTotal = 0

  const lineItems = draft.lines.map((l, n) => {
    const ref = refs.length > 0 ? refs[n % refs.length]! : { productId: 0, variationId: 0, sku: '' }
    const subtotal = l.unit * l.qty
    const discount = Math.floor((subtotal * l.discountShare) / 100)
    const total = subtotal - discount
    running += total + l.tax
    taxTotal += l.tax
    discountTotal += discount
    return {
      id: n + 1,
      name: `line ${n}`,
      product_id: ref.productId,
      variation_id: ref.variationId,
      quantity: l.qty,
      tax_class: '',
      subtotal: d(subtotal),
      subtotal_tax: d(l.tax + l.untaxedShare),
      total: d(total),
      total_tax: d(l.tax),
      taxes: [],
      meta_data: [],
      sku: ref.sku,
      price: l.unit / scale,
    }
  })

  let shippingTax = 0
  const shippingLines = draft.shipping.map((s, n) => {
    running += s.total + s.tax
    shippingTax += s.tax
    return {
      id: 100 + n,
      method_title: 'Flat rate',
      method_id: 'flat_rate',
      total: d(s.total),
      total_tax: d(s.tax),
      taxes: [],
    }
  })

  let feeTax = 0
  const feeLines = draft.fees.map((f, n) => {
    // A credit takes off at most what the order holds so far, and carries no tax.
    const amount = f.amount < 0 ? -Math.min(-f.amount, running) : f.amount
    const tax = amount > 0 ? f.tax : 0
    running += amount + tax
    feeTax += tax
    return {
      id: 200 + n,
      name: f.name,
      tax_class: '',
      tax_status: tax > 0 ? 'taxable' : 'none',
      total: d(amount),
      total_tax: d(tax),
      taxes: [],
    }
  })

  taxTotal += shippingTax + feeTax
  const total = running
  let refundable = total
  const refunds = draft.refundShares.map((share, n) => {
    const amount = Math.min(refundable, Math.floor((total * share) / 100))
    refundable -= amount
    return { id: 300 + n, reason: '', total: d(-amount) }
  })

  return {
    line_items: lineItems,
    shipping_lines: shippingLines,
    fee_lines: feeLines,
    tax_lines: [
      {
        id: 1,
        rate_code: 'TAX-1',
        label: 'Tax',
        compound: false,
        tax_total: d(taxTotal - shippingTax),
        shipping_tax_total: d(shippingTax),
      },
    ],
    refunds,
    discount_total: d(discountTotal),
    discount_tax: d(0),
    shipping_total: d(draft.shipping.reduce((n, s) => n + s.total, 0)),
    shipping_tax: d(shippingTax),
    total_tax: d(taxTotal),
    total: d(total),
  }
}

/** The source order's own figures, read back with `parseMinor`: what the mapped order must agree with. */
export function sourceFigures(order: Rec, currency: TestCurrency) {
  const m = (v: unknown) => parseMinor(String(v), currency)
  const lines = (order['line_items'] as Rec[]) ?? []
  const shipping = (order['shipping_lines'] as Rec[]) ?? []
  const fees = (order['fee_lines'] as Rec[]) ?? []
  return {
    total: m(order['total']),
    totalTax: m(order['total_tax']),
    discount: m(order['discount_total']),
    shippingTotal: shipping.reduce((n, s) => n + m(s['total']), 0),
    shippingTax: shipping.reduce((n, s) => n + m(s['total_tax']), 0),
    lineTaxes: lines.map((l) => m(l['total_tax'])),
    fees: fees.map((f) => ({
      id: f['id'] as number,
      name: String(f['name']),
      total: m(f['total']),
      tax: m(f['total_tax']),
    })),
  }
}
