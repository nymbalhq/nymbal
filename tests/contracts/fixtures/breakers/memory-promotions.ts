import type { PromotionEffect, PromotionSession, PromotionsAdapter } from '@nymbalhq/types'

// An in-memory promotions adapter that knows no code, and its defective twins: one whose money effect is not a whole
// number of minor units, one whose line effect names a line the session does not have. Each defect shows only for a
// session with a code, so the cases about a session with none stay on topic.

export interface PromotionsFlaws {
  fractionalMoney?: boolean
  unknownLine?: boolean
}

export function memoryPromotions(flaws: PromotionsFlaws = {}): PromotionsAdapter {
  return {
    kind: 'promotions',
    providerName: 'memory-promotions',
    capabilities: () => ['codes'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    async evaluate(session: PromotionSession) {
      const effects: PromotionEffect[] = session.codes.map((code: string) => ({
        kind: 'code_rejected',
        code,
        reason: 'unknown',
      }))
      if (session.codes.length > 0 && flaws.fractionalMoney === true) {
        effects.push({ kind: 'order', amountMinor: 12.5, label: 'broken' })
      }
      if (session.codes.length > 0 && flaws.unknownLine === true) {
        effects.push({
          kind: 'line',
          lineId: 'not-a-session-line',
          amountMinor: 1,
          label: 'broken',
        })
      }
      return { effects }
    },
  } as unknown as PromotionsAdapter
}
