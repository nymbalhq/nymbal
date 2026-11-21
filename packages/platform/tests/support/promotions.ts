import type { Cart, CheckoutTotals } from '@nymbalhq/types'
import { promotionRow, type PromotionSeed } from '../../src/tests/promotions.js'
import type { Kernel, Seeded } from './kernel.js'
import { writeRaw } from './raw.js'
import type { primedShopper } from './security.js'
import type { ShopResponse } from './shopper.js'

export {
  acceptFirstCode,
  isMoneyEffect,
  promotionRow,
  scriptedEngine,
  uniqueCode,
  type EngineAnswer,
  type PromotionSeed,
  type ScriptedEngine,
} from '../../src/tests/promotions.js'

// Promotions as a test sets them up: rows written to the `promotions` table as a second connection would, so a cart or
// checkout test depends on the table and not on the admin routes; the priced cart a cart route answers; and an engine
// a test scripts, for the `custom` slot.

export type Shop = Awaited<ReturnType<typeof primedShopper>>

export interface SeededPromotion {
  id: string
  code: string
}

const insertPromotion =
  'INSERT INTO promotions (id, code, kind, percent_bps, amount_off_minor, currency, minimum_subtotal_minor, ' +
  'expires_at, usage_cap, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'

/** One row of `promotions`, written directly. */
export async function seedPromotion(
  k: Pick<Kernel, 'dialect' | 'target'>,
  seed: PromotionSeed,
): Promise<SeededPromotion> {
  const { id, params } = promotionRow(k.dialect, seed)
  await writeRaw(k.dialect, k.target, insertPromotion, params)
  return { id, code: seed.code }
}

/** A column of one promotion set to a new value, for a promotion changed after a cart took it. */
export async function updatePromotion(
  k: Pick<Kernel, 'dialect' | 'target'>,
  id: string,
  column: 'percent_bps' | 'expires_at' | 'active',
  value: unknown,
): Promise<void> {
  await writeRaw(k.dialect, k.target, `UPDATE promotions SET ${column} = ? WHERE id = ?`, [
    value,
    id,
  ])
}

export interface PricedCart extends Omit<Cart, 'promotions'> {
  totals: CheckoutTotals
  promotions: {
    codes: { code: string; status: 'accepted' | 'rejected' | 'pending'; reason?: string }[]
    unavailable: boolean
  }
}

export async function addLine(
  shop: Shop,
  seeded: Seeded,
  qty: number,
): Promise<ShopResponse<PricedCart>> {
  return shop.call<PricedCart>('POST', '/api/cart/items', { variantId: seeded.variantId, qty })
}

export async function putCode(shop: Shop, code: string): Promise<ShopResponse<PricedCart>> {
  return shop.call<PricedCart>('POST', '/api/cart/codes', { code })
}

export async function readCart(shop: Shop): Promise<ShopResponse<PricedCart>> {
  return shop.call<PricedCart>('GET', '/api/cart')
}

/** Σ unit × qty over the cart's lines, as a shopper adds it up from what they were shown. */
export function linesSubtotal(cart: Pick<Cart, 'items'>): number {
  return cart.items.reduce((sum, item) => sum + item.priceMinor * item.qty, 0)
}
