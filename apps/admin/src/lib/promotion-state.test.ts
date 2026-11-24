import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AdminPromotion } from '@/types'
import { promotionState } from './promotion-state'

// A row's status is the engine's own verdict, in its order of refusals: switched off, then expired (at or before the
// moment), then the cap reached, else it works. A cart in the store's currency with its minimum met is refused for
// exactly the first of these that holds.

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)

function promotion(over: Partial<AdminPromotion>): AdminPromotion {
  return {
    id: 'promo-1',
    code: 'SPRING',
    kind: 'percent',
    percentBps: 1000,
    amountOffMinor: null,
    currency: null,
    minimumSubtotalMinor: null,
    expiresAt: null,
    usageCap: null,
    active: true,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-01T09:00:00.000Z',
    usedCount: 0,
    ...over,
  }
}

/** The engine's order (native-adapter refusal), written out. */
function engineVerdict(p: AdminPromotion, at: Date): 'inactive' | 'expired' | 'used-up' | 'active' {
  if (!p.active) return 'inactive'
  if (p.expiresAt !== null && Date.parse(p.expiresAt) <= at.getTime()) return 'expired'
  if (p.usageCap !== null && p.usedCount >= p.usageCap) return 'used-up'
  return 'active'
}

const promotions = fc.record({
  active: fc.boolean(),
  // Offsets from the moment, the moment itself among them.
  expiresIn: fc.option(
    fc.oneof(fc.constant(0), fc.integer({ min: -86_400_000, max: 86_400_000 })),
    {
      nil: null,
    },
  ),
  usageCap: fc.option(fc.nat({ max: 12 }), { nil: null }),
  usedCount: fc.nat({ max: 15 }),
  kind: fc.constantFrom('percent' as const, 'fixed' as const),
})

const moments = fc.integer({ min: NOW - 400 * 86_400_000, max: NOW + 400 * 86_400_000 })

describe('AC-2: a promotion’s state is the engine’s verdict', () => {
  // Kills: the checks in another order (an expired code that is switched off reads "Expired"; a code at its cap reads
  // "Active" while the cart refuses it); `<` for the expiry, so a code at its last instant reads "Active".
  it('AC-2: property: inactive when switched off, else expired when expiresAt is at or before the moment, else used-up when usedCount ≥ usageCap, else active', () => {
    fc.assert(
      fc.property(promotions, moments, (shape, at) => {
        const p = promotion({
          active: shape.active,
          kind: shape.kind,
          expiresAt: shape.expiresIn === null ? null : new Date(at + shape.expiresIn).toISOString(),
          usageCap: shape.usageCap,
          usedCount: shape.usedCount,
        })
        const now = new Date(at)
        expect(promotionState(p, now), JSON.stringify({ p, now })).toBe(engineVerdict(p, now))
      }),
      { numRuns: 3000 },
    )
  })

  it('AC-2: switched off and expired reads inactive; expiring at the moment reads expired; a cap of 3 used 3 times reads used-up, used twice reads active', () => {
    const now = new Date(NOW)
    const at = now.toISOString()
    const before = new Date(NOW - 1).toISOString()
    expect([
      promotionState(
        promotion({ active: false, expiresAt: before, usageCap: 1, usedCount: 1 }),
        now,
      ),
      promotionState(promotion({ expiresAt: at, usageCap: 1, usedCount: 1 }), now),
      promotionState(promotion({ usageCap: 3, usedCount: 3 }), now),
      promotionState(
        promotion({ usageCap: 3, usedCount: 2, expiresAt: new Date(NOW + 1).toISOString() }),
        now,
      ),
    ]).toEqual(['inactive', 'expired', 'used-up', 'active'])
  })
})
