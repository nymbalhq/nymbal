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
