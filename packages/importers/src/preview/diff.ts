import { currencyExponent } from '../woocommerce/mappers/money.js'
import type { DiffField, ProductDiff } from './types.js'

type Rec = Record<string, unknown>

export interface ServedProduct {
  name: string
  priceRange: { minMinor: number; maxMinor: number }
  variantCount: number
  media: unknown[]
  categories: Array<{ slug: string }>
}

/** A decimal as `digits / 10^scale`, exactly. */
interface Exact {
  text: string
  digits: bigint
  scale: number
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/

function exact(text: string): Exact | null {
  const m = DECIMAL.exec(text.trim())
  if (m === null) return null
  const whole = m[2] ?? ''
  const fraction = m[3] ?? ''
  if (whole === '' && fraction === '') return null
  const magnitude = BigInt(`${whole}${fraction}` || '0')
  return { text, digits: m[1] === '-' ? -magnitude : magnitude, scale: fraction.length }
}

/** Below zero when `a < b`: both brought to one scale, so no digit is lost. */
function compare(a: Exact, b: Exact): number {
  const scale = Math.max(a.scale, b.scale)
  const x = a.digits * 10n ** BigInt(scale - a.scale)
  const y = b.digits * 10n ** BigInt(scale - b.scale)
  return x < y ? -1 : x > y ? 1 : 0
}

const minor = (amount: number, exp: number): Exact => ({
  text: '',
  digits: BigInt(amount),
  scale: exp,
})

/** Minor units written to the currency's exponent: 500 at 2 is `5.00`, 1500 at 0 is `1500`. */
function atExponent(amount: number, exp: number): string {
  if (exp === 0) return String(amount)
  const sign = amount < 0 ? '-' : ''
  const abs = String(Math.abs(amount)).padStart(exp + 1, '0')
  return `${sign}${abs.slice(0, -exp)}.${abs.slice(-exp)}`
}

/** WooCommerce's prices a shopper can buy at: a simple product's own, or each published, priced variation's. */
function sellablePrices(product: Rec, variations: Rec[]): Exact[] {
  const texts =
    product['type'] === 'variable'
      ? variations
          .filter(
            (v) => v['status'] === 'publish' && typeof v['price'] === 'string' && v['price'] !== '',
          )
          .map((v) => v['price'] as string)
      : typeof product['price'] === 'string' && product['price'] !== ''
        ? [product['price']]
        : []
  return texts.map(exact).filter((e): e is Exact => e !== null)
}

const range = (min: string, max: string, same: boolean) => (same ? min : `${min}–${max}`)

/**
 * The fields where what the preview serves differs from what WooCommerce sells, in the order name, price, variants,
 * images, categories. Prices are compared as exact decimals against the served minor units: a source price the
 * currency cannot hold shows as a difference, in WooCommerce's own digits.
 */
export function diffProduct(
  source: { product: Rec; variations: Rec[] },
  served: ServedProduct,
  currency: string,
): ProductDiff['changes'] {
  const changes: ProductDiff['changes'] = []
  const add = (field: DiffField, from: string, to: string) => {
    if (from !== to) changes.push({ field, source: from, preview: to })
  }
  const { product, variations } = source

  add('name', String(product['name'] ?? ''), served.name)

  const prices = sellablePrices(product, variations)
  if (prices.length > 0) {
    const exp = currencyExponent(currency)
    const low = prices.reduce((a, b) => (compare(b, a) < 0 ? b : a))
    const high = prices.reduce((a, b) => (compare(b, a) > 0 ? b : a))
    const { minMinor, maxMinor } = served.priceRange
    const equal =
      compare(low, minor(minMinor, exp)) === 0 && compare(high, minor(maxMinor, exp)) === 0
    if (!equal) {
      changes.push({
        field: 'price',
        source: range(low.text, high.text, compare(low, high) === 0),
        preview: range(atExponent(minMinor, exp), atExponent(maxMinor, exp), minMinor === maxMinor),
      })
    }
  }

  add('variants', String(prices.length), String(served.variantCount))

  const images = Array.isArray(product['images'])
    ? (product['images'] as Rec[]).filter((i) => typeof i['src'] === 'string' && i['src'] !== '')
    : []
  add('images', String(images.length), String(served.media.length))

  const slugs = (xs: unknown) =>
    (Array.isArray(xs) ? (xs as Rec[]) : [])
      .map((c) => String(c['slug']))
      .sort()
      .join(', ')
  add('categories', slugs(product['categories']), slugs(served.categories))

  return changes
}
