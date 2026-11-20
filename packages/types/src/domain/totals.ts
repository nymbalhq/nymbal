/** One line of a settlement; its `id` is the cart line's variant id. */
export interface TotalsLine {
  id: string
  unitMinor: number
  qty: number
}

export interface TotalsTax {
  lines: readonly { id: string; taxMinor: number }[]
  shippingTaxMinor: number
}

export type PromotionEffect =
  | { kind: 'line'; lineId: string; amountMinor: number; label: string; code?: string }
  | { kind: 'order'; amountMinor: number; label: string; code?: string }
  | { kind: 'shipping'; amountMinor: number; label: string; code?: string }
  | { kind: 'code_accepted'; code: string }
  | { kind: 'code_rejected'; code: string; reason: string }
  | { kind: 'notice'; text: string }
  /** What the engine answered and the kernel does not act on; logged and ignored. */
  | { kind: 'unsupported'; detail: string }

export interface CheckoutTotalsLine {
  id: string
  subtotalMinor: number
  discountMinor: number
  taxMinor: number
  totalMinor: number
}

export interface CheckoutTotals {
  currency: string
  subtotalMinor: number
  discountTotalMinor: number
  shippingTotalMinor: number
  shippingDiscountMinor: number
  taxTotalMinor: number
  totalMinor: number
  pricesIncludeTax: boolean
  lines: CheckoutTotalsLine[]
  /** The effects that moved money, each at the amount that counted. */
  applied: PromotionEffect[]
}

/** A delivery the checkout offers an address, priced for the cart. */
export interface ShippingOption {
  /** Stable across quotes: what a caller sends back to choose it. */
  id: string
  name: string
  /** What this cart pays for it now: 0 when the goods reach its free-over threshold. */
  amountMinor: number
  estimatedDays: number | null
}

/** The checkout priced for an address and a delivery option, before anything is reserved. */
export interface CheckoutQuote {
  currency: string
  /** In the table's order; never empty in an answer. */
  options: ShippingOption[]
  /** The option the totals use. */
  shippingOptionId: string
  totals: CheckoutTotals
}
