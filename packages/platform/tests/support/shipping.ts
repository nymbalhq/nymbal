import type { NymbalConfig } from '@nymbalhq/config'
import type { Address, CheckoutTotals } from '@nymbalhq/types'
import { address } from './kernel.js'
import type { ShopResponse } from './shopper.js'

// Shipping as a checkout test sets it up: the store's rate table, destinations it does and does not ship to, the rule
// a shopper's options are held to (written here, not imported, so the kernel's own rule is what the tests check), and
// the quote and checkout calls a storefront makes.

export interface ShippingRow {
  id: string
  name: string
  countries?: string[]
  amountMinor: number
  freeOverMinor?: number
  estimatedDays?: number
}

export interface ShippingOptionBody {
  id: string
  name: string
  amountMinor: number
  estimatedDays: number | null
}

export interface QuoteBody {
  currency: string
  options: ShippingOptionBody[]
  shippingOptionId: string
  totals: CheckoutTotals
}

export interface CheckoutAnswer {
  orderId: string
  orderNumber: string
  totalMinor: number
  orderKey?: string
  paymentIntent: { id: string; amountMinor: number }
}

export interface ErrorBody {
  code: string
  message: string
  context?: Record<string, unknown>
}

/** The kernel config with the store's shipping table set to `rates`. */
export function withShipping(
  rates: readonly ShippingRow[],
): (config: NymbalConfig) => NymbalConfig {
  return (config) =>
    ({
      ...config,
      commerce: {
        ...config.commerce,
        shipping: { ...config.commerce.shipping, rates: [...rates] },
      },
    }) as NymbalConfig
}

/** Config reshapers applied left to right. */
export function both(
  ...steps: ReadonlyArray<(config: NymbalConfig) => NymbalConfig>
): (config: NymbalConfig) => NymbalConfig {
  return (config) => steps.reduce((c, step) => step(c), config)
}

/**
 * A table with options a GB shopper chooses between (one free over £50, one paid, one free), Europe free over £200,
 * and the US and Japan at a flat rate. Nothing reaches Australia.
 */
export const TABLE: ShippingRow[] = [
  {
    id: 'standard',
    name: 'Standard',
    countries: ['GB'],
    amountMinor: 399,
    freeOverMinor: 5_000,
    estimatedDays: 3,
  },
  { id: 'express', name: 'Express', countries: ['GB'], amountMinor: 999, estimatedDays: 1 },
  { id: 'collect', name: 'Click and collect', countries: ['GB'], amountMinor: 0 },
  {
    id: 'europe',
    name: 'Europe',
    countries: ['DE', 'FR'],
    amountMinor: 1_299,
    freeOverMinor: 20_000,
    estimatedDays: 5,
  },
  { id: 'world', name: 'International', countries: ['US', 'JP'], amountMinor: 2_499 },
]

/** No row of TABLE ships here. */
export const UNSHIPPED: Address = {
  ...address,
  city: 'Sydney',
  region: 'NSW',
  postalCode: '2000',
  country: 'AU',
}

/** The options a table offers `country` for goods of `goodsMinor`: the documented rule. */
export function offered(
  rates: readonly ShippingRow[],
  country: string,
  goodsMinor: number,
): ShippingOptionBody[] {
  if (rates.length === 0) {
    return [{ id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: null }]
  }
  const code = country.trim().toUpperCase()
  const naming = rates.filter((r) => r.countries?.includes(code))
  const rows = naming.length > 0 ? naming : rates.filter((r) => r.countries === undefined)
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    amountMinor: r.freeOverMinor !== undefined && r.freeOverMinor <= goodsMinor ? 0 : r.amountMinor,
    estimatedDays: r.estimatedDays ?? null,
  }))
}

interface Caller {
  call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { headers?: Record<string, string> },
  ): Promise<ShopResponse<T>>
}

/** `POST /api/checkout/quote` as a storefront calls it. */
export function quote(
  shop: Caller,
  body: { shippingAddress: unknown; shippingOptionId?: string; email?: string },
  headers: Record<string, string> = {},
): Promise<ShopResponse<QuoteBody>> {
  return shop.call<QuoteBody>('POST', '/api/checkout/quote', body, { headers })
}

/** `POST /api/checkout` with the given shipping address, option and acknowledged total. */
export function placeOrder(
  shop: Caller,
  email: string,
  over: { shippingAddress?: Address; shippingOptionId?: string; expectedTotalMinor?: number } = {},
  headers: Record<string, string> = {},
): Promise<ShopResponse<CheckoutAnswer>> {
  const shipTo = over.shippingAddress ?? address
  return shop.call<CheckoutAnswer>(
    'POST',
    '/api/checkout',
    {
      email,
      billingAddress: shipTo,
      shippingAddress: shipTo,
      ...(over.shippingOptionId !== undefined && { shippingOptionId: over.shippingOptionId }),
      ...(over.expectedTotalMinor !== undefined && { expectedTotalMinor: over.expectedTotalMinor }),
    },
    { headers },
  )
}

/** The shipping tax inside a quote's totals: its tax total less its lines' tax. */
export function shippingTaxOf(totals: CheckoutTotals): number {
  return totals.taxTotalMinor - totals.lines.reduce((sum, l) => sum + l.taxMinor, 0)
}
