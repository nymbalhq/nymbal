import { describe, expect, it } from 'vitest'
import type { PromotionEffect, PromotionSession, PromotionsAdapter } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

const NO_CODES: PromotionSession = {
  id: 'contract-session',
  customerId: null,
  codes: [],
  currency: 'GBP',
  lines: [
    {
      id: 'line-1',
      variantId: 'variant-1',
      sku: 'SKU-1',
      productId: 'product-1',
      categoryIds: [],
      unitMinor: 2500,
      qty: 2,
    },
  ],
  shipping: null,
}

const UNKNOWN = 'NO-SUCH-CODE-CONTRACT'
const WITH_CODE: PromotionSession = { ...NO_CODES, codes: [UNKNOWN] }

const moneyEffects = (effects: readonly PromotionEffect[]) =>
  effects.filter(
    (e): e is Extract<PromotionEffect, { amountMinor: number }> =>
      e.kind === 'line' || e.kind === 'order' || e.kind === 'shipping',
  )

export function runPromotionsContract(
  name: string,
  build: Build<PromotionsAdapter>,
  options: ContractOptions<PromotionsAdapter> = {},
): void {
  describe(`PromotionsAdapter contract: ${name}`, () => {
    it(
      'a session with no codes yields no money effects',
      async () => {
        const adapter = await build()
        const { effects } = await adapter.evaluate(NO_CODES, { dry: true })
        expect(moneyEffects(effects)).toEqual([])
      },
      CASE_MS,
    )

    it(
      'an unknown code is code_rejected',
      async () => {
        const adapter = await build()
        const { effects } = await adapter.evaluate(WITH_CODE, { dry: true })
        expect(effects).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: 'code_rejected', code: UNKNOWN }),
          ]),
        )
        expect(effects.some((e) => e.kind === 'code_accepted' && e.code === UNKNOWN)).toBe(false)
      },
      CASE_MS,
    )

    it(
      'repeated dry evaluations of one session give the same effects',
      async () => {
        const adapter = await build()
        const first = await adapter.evaluate(WITH_CODE, { dry: true })
        const second = await adapter.evaluate(WITH_CODE, { dry: true })
        expect(second.effects).toEqual(first.effects)
      },
      CASE_MS,
    )

    it(
      'every money effect is a non-negative integer',
      async () => {
        const adapter = await build()
        for (const session of [NO_CODES, WITH_CODE]) {
          const { effects } = await adapter.evaluate(session, { dry: true })
          for (const effect of moneyEffects(effects)) {
            expect(Number.isSafeInteger(effect.amountMinor) && effect.amountMinor >= 0).toBe(true)
          }
        }
      },
      CASE_MS,
    )

    it(
      'a line effect names a line in the session',
      async () => {
        const adapter = await build()
        for (const session of [NO_CODES, WITH_CODE]) {
          const { effects } = await adapter.evaluate(session, { dry: true })
          const ids = new Set(session.lines.map((l) => l.id))
          for (const effect of effects) {
            if (effect.kind === 'line') expect(ids.has(effect.lineId)).toBe(true)
          }
        }
      },
      CASE_MS,
    )

    healthAndDowntime(build, options.unreachable, 'evaluate()', (adapter) =>
      adapter.evaluate(NO_CODES, { dry: true }),
    )
  })
}
