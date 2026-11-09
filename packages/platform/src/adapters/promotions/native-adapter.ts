import type { Logger, PromotionEffect, PromotionSession, PromotionsAdapter } from '@nymbalhq/types'
import type { ReadTx, Tx } from '../../db/command-store.js'
import type { Promotion, Repositories } from '../../repositories/index.js'
import { noopInitialize, okHealth } from '../base.js'

export interface NativePromotionsDeps {
  repos: Pick<Repositories, 'promotion'>
  logger: Logger
  now?: () => Date
}

const normal = (code: string): string => code.trim().toLowerCase()

/** Percent off rounds down: a 10% code never takes more than 10%. */
function amountOff(promotion: Promotion, subtotalMinor: number): number {
  if (promotion.kind === 'fixed') return Math.min(promotion.amountOffMinor ?? 0, subtotalMinor)
  return Number((BigInt(subtotalMinor) * BigInt(promotion.percentBps ?? 0)) / 10_000n)
}

export function createNativePromotionsAdapter(deps: NativePromotionsDeps): PromotionsAdapter {
  const { repos, logger } = deps
  const now = deps.now ?? (() => new Date())
  const promotions = repos.promotion

  /** Why `promotion` does not apply to the session, or null when it does. */
  async function refusal(
    tx: ReadTx,
    promotion: Promotion | undefined,
    session: PromotionSession,
    subtotalMinor: number,
    at: Date,
  ): Promise<string | null> {
    if (promotion === undefined) return 'unknown'
    if (!promotion.active) return 'inactive'
    if (promotion.expiresAt !== null && Date.parse(promotion.expiresAt) <= at.getTime()) {
      return 'expired'
    }
    const money = promotion.kind === 'fixed' || promotion.minimumSubtotalMinor !== null
    if (money && promotion.currency !== session.currency) return 'wrong_currency'
    if (promotion.minimumSubtotalMinor !== null && subtotalMinor < promotion.minimumSubtotalMinor) {
      return 'below_minimum'
    }
    if (promotion.usageCap !== null) {
      const used = await promotions.usesAgainstCap(tx, promotion.id, session.id)
      if (used >= promotion.usageCap) return 'cap_reached'
    }
    return null
  }

  /** The rows of the session's codes, each locked in id order so two checkouts of one code cannot deadlock. */
  async function lockedRows(tx: Tx, codes: readonly string[]): Promise<Promotion[]> {
    const found = await promotions.findByCodes(tx, codes)
    const locked: Promotion[] = []
    for (const row of [...found].sort((a, b) => a.id.localeCompare(b.id))) {
      const held = await promotions.lock(tx, row.id)
      if (held !== null) locked.push(held)
    }
    return locked
  }

  async function run(
    tx: ReadTx,
    rows: readonly Promotion[],
    session: PromotionSession,
    reserve: { tx: Tx; orderId: string } | undefined,
  ): Promise<PromotionEffect[]> {
    const byCode = new Map(rows.map((row) => [row.code.toLowerCase(), row]))
    const subtotalMinor = session.lines.reduce((sum, l) => sum + l.unitMinor * l.qty, 0)
    const at = now()
    const effects: PromotionEffect[] = []
    let winner: Promotion | undefined
    for (const code of session.codes) {
      const promotion = byCode.get(normal(code))
      const reason = await refusal(tx, promotion, session, subtotalMinor, at)
      if (reason !== null) {
        effects.push({ kind: 'code_rejected', code, reason })
        continue
      }
      if (winner !== undefined) {
        effects.push({ kind: 'code_rejected', code, reason: 'one_code_per_order' })
        continue
      }
      winner = promotion
      effects.push(
        { kind: 'code_accepted', code },
        {
          kind: 'order',
          amountMinor: amountOff(promotion!, subtotalMinor),
          label: promotion!.code,
          code: promotion!.code,
        },
      )
    }
    if (winner !== undefined && reserve !== undefined) {
      await promotions.addRedemption(reserve.tx, {
        promotionId: winner.id,
        orderId: reserve.orderId,
        sessionId: session.id,
        createdAt: at,
      })
      logger.debug({ promotionId: winner.id, orderId: reserve.orderId }, 'promotion reserved')
    }
    return effects
  }

  return {
    kind: 'promotions',
    providerName: 'native',
    capabilities: () => ['codes'],
    inTransaction: true,
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),
    async evaluate(session, opts) {
      const { store } = promotions
      const codes = session.codes.map(normal)
      const orderId = opts?.orderId
      if (opts?.dry === true || orderId === undefined) {
        return store.read(async (tx) => ({
          effects: await run(tx, await promotions.findByCodes(tx, codes), session, undefined),
        }))
      }
      return store.transaction(async (tx) => ({
        effects: await run(tx, await lockedRows(tx, codes), session, { tx, orderId }),
      }))
    },
  }
}
