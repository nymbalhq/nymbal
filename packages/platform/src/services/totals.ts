import type { CheckoutTotals, PromotionEffect, TotalsLine, TotalsTax } from '@nymbalhq/types'

// The one place a total is computed. Whatever an engine returned is clamped here, so the shopper's total, the order's
// columns and the amount charged cannot disagree.

export interface SettleInput {
  currency: string
  lines: readonly TotalsLine[]
  shipping: { amountMinor: number } | null
  effects: readonly PromotionEffect[]
  tax: TotalsTax | null
  pricesIncludeTax: boolean
}

type MoneyEffect = Extract<PromotionEffect, { amountMinor: number }>

function isMoney(effect: PromotionEffect): effect is MoneyEffect {
  return effect.kind === 'line' || effect.kind === 'order' || effect.kind === 'shipping'
}

/** A whole, non-negative amount; a hostile value (NaN, ∞, negative, a fraction of a unit) counts for nothing past it. */
function whole(amount: number): number {
  return Number.isFinite(amount) && amount > 0 ? Math.floor(amount) : 0
}

/** `amount` split over `weights` by largest remainder, ties to the lower index. BigInt: the products overflow doubles. */
function allocate(amount: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0)
  if (total === 0) return weights.map(() => 0)
  const denominator = BigInt(total)
  const shares = weights.map((w) => BigInt(amount) * BigInt(w))
  const floors = shares.map((s) => Number(s / denominator))
  const ranked = shares
    .map((s, index) => ({ index, remainder: s % denominator }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    )
  let left = amount - floors.reduce((sum, f) => sum + f, 0)
  for (let i = 0; left > 0; i += 1, left -= 1) floors[ranked[i]!.index]! += 1
  return floors
}

/**
 * Totals from lines and an engine's effects. `line` effects first, each clamped to what its line has left, then
 * `shipping`, then `order` effects, each allocated over the lines' remaining subtotals by largest remainder. `applied`
 * lists each effect at the amount that counted, in that order, so settling `applied` again changes nothing.
 */
export function settleTotals(input: SettleInput): CheckoutTotals {
  const remaining = input.lines.map((l) => l.unitMinor * l.qty)
  const discounts = input.lines.map(() => 0)
  const indexOf = new Map(input.lines.map((l, i) => [l.id, i]))
  const shippingTotalMinor = whole(input.shipping?.amountMinor ?? 0)
  let shippingLeft = shippingTotalMinor
  const applied: PromotionEffect[] = []

  const effects = input.effects.filter(isMoney)
  const counted = (effect: MoneyEffect, amountMinor: number): void => {
    if (amountMinor > 0) applied.push({ ...effect, amountMinor })
  }

  for (const effect of effects.filter((e) => e.kind === 'line')) {
    const index = indexOf.get(effect.lineId)
    if (index === undefined) continue
    const amount = Math.min(whole(effect.amountMinor), remaining[index]!)
    remaining[index]! -= amount
    discounts[index]! += amount
    counted(effect, amount)
  }

  for (const effect of effects.filter((e) => e.kind === 'shipping')) {
    const amount = Math.min(whole(effect.amountMinor), shippingLeft)
    shippingLeft -= amount
    counted(effect, amount)
  }

  for (const effect of effects.filter((e) => e.kind === 'order')) {
    const available = remaining.reduce((sum, r) => sum + r, 0)
    const amount = Math.min(whole(effect.amountMinor), available)
    allocate(amount, remaining).forEach((share, index) => {
      remaining[index]! -= share
      discounts[index]! += share
    })
    counted(effect, amount)
  }

  const inclusive = input.pricesIncludeTax
  const lineTax = new Map(input.tax?.lines.map((t) => [t.id, whole(t.taxMinor)]))
  const lines = input.lines.map((line, i) => {
    const subtotalMinor = line.unitMinor * line.qty
    const taxMinor = lineTax.get(line.id) ?? 0
    return {
      id: line.id,
      subtotalMinor,
      discountMinor: discounts[i]!,
      taxMinor,
      totalMinor: subtotalMinor - discounts[i]! + (inclusive ? 0 : taxMinor),
    }
  })

  const shippingTaxMinor = whole(input.tax?.shippingTaxMinor ?? 0)
  const sum = (pick: (l: (typeof lines)[number]) => number) =>
    lines.reduce((total, l) => total + pick(l), 0)
  const subtotalMinor = sum((l) => l.subtotalMinor)
  const lineDiscount = sum((l) => l.discountMinor)
  const shippingDiscountMinor = shippingTotalMinor - shippingLeft
  const discountTotalMinor = lineDiscount + shippingDiscountMinor
  const taxTotalMinor = sum((l) => l.taxMinor) + shippingTaxMinor

  return {
    currency: input.currency,
    subtotalMinor,
    discountTotalMinor,
    shippingTotalMinor,
    shippingDiscountMinor,
    taxTotalMinor,
    totalMinor:
      subtotalMinor - discountTotalMinor + shippingTotalMinor + (inclusive ? 0 : taxTotalMinor),
    pricesIncludeTax: inclusive,
    lines,
    applied,
  }
}

export interface Quote {
  totals: CheckoutTotals
  effects: PromotionEffect[]
  /** The free-order rule rejected every accepted code and dropped the money. */
  refused: boolean
}

/**
 * The kernel's free-order rule over `settleTotals`: a discount that would leave a cart with money in it owing nothing
 * is refused, every accepted code rejected, the totals settled without its money. Cart and place come through here so
 * a refused code is refused the same in both.
 */
export function settleQuote(input: SettleInput): Quote {
  const totals = settleTotals(input)
  if (totals.subtotalMinor === 0 || totals.totalMinor !== 0) {
    return { totals, effects: [...input.effects], refused: false }
  }
  const effects = input.effects
    .filter((e) => !isMoney(e))
    .map(
      (e): PromotionEffect =>
        e.kind === 'code_accepted'
          ? { kind: 'code_rejected', code: e.code, reason: 'free_order_unsupported' }
          : e,
    )
  return { totals: settleTotals({ ...input, effects }), effects, refused: true }
}
