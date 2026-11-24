import type { AdminPromotion } from '@/types'

export type PromotionState = 'inactive' | 'expired' | 'used-up' | 'active'

/** Whether a code works at `now`, by the engine's order of refusals: switched off, expired, then its cap reached. */
export function promotionState(p: AdminPromotion, now: Date): PromotionState {
  if (!p.active) return 'inactive'
  if (p.expiresAt !== null && Date.parse(p.expiresAt) <= now.getTime()) return 'expired'
  if (p.usageCap !== null && p.usedCount >= p.usageCap) return 'used-up'
  return 'active'
}
