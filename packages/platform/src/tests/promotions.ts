import { randomUUID } from 'node:crypto'
import type {
  PromotionEffect,
  PromotionEvaluation,
  PromotionSession,
  PromotionsAdapter,
} from '@nymbalhq/types'

// Promotion fixtures that need nothing but the types, so unit tests under Stryker's mutate set can import them.

export interface PromotionSeed {
  code: string
  kind: 'percent' | 'fixed'
  percentBps?: number | null
  amountOffMinor?: number | null
  currency?: string | null
  minimumSubtotalMinor?: number | null
  expiresAt?: Date | null
  usageCap?: number | null
  active?: boolean
}

/** A code no other test in the run holds. */
export function uniqueCode(prefix: string): string {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 10)}`
}

export function promotionRow(
  dialect: 'sqlite' | 'postgres',
  seed: PromotionSeed,
): { id: string; params: unknown[] } {
  const id = randomUUID()
  const now = new Date().toISOString()
  const active = seed.active ?? true
  return {
    id,
    params: [
      id,
      seed.code,
      seed.kind,
      seed.percentBps ?? null,
      seed.amountOffMinor ?? null,
      seed.currency ?? null,
      seed.minimumSubtotalMinor ?? null,
      seed.expiresAt?.toISOString() ?? null,
      seed.usageCap ?? null,
      dialect === 'postgres' ? active : active ? 1 : 0,
      now,
      now,
    ],
  }
}

export type EngineAnswer = (
  session: PromotionSession,
  opts: { dry?: boolean; orderId?: string } | undefined,
) => PromotionEvaluation | Promise<PromotionEvaluation>

/** Accepts the first code and takes a tenth of the subtotal as one `order` effect. */
export const acceptFirstCode: EngineAnswer = (session) => {
  const [code] = session.codes
  if (code === undefined) return { effects: [] }
  const subtotal = session.lines.reduce(
    (sum: number, line: PromotionSession['lines'][number]) => sum + line.unitMinor * line.qty,
    0,
  )
  return {
    effects: [
      { kind: 'code_accepted', code },
      { kind: 'order', amountMinor: Math.floor(subtotal / 10), label: code, code },
    ],
  }
}

export interface ScriptedEngine {
  adapter: PromotionsAdapter
  /** Every call the kernel made, oldest first. */
  calls: { session: PromotionSession; opts: { dry?: boolean; orderId?: string } | undefined }[]
  /** Replaces what each call answers. */
  answer(next: EngineAnswer): void
  /** From now on every call throws, until `recover`. */
  fail(): void
  recover(): void
}

/** A promotions engine of the test's own, for a slot whose provider is `custom`. */
export function scriptedEngine(
  opts: {
    providerName?: string
    capabilities?: ReturnType<PromotionsAdapter['capabilities']>
    inTransaction?: boolean
  } = {},
): ScriptedEngine {
  const calls: ScriptedEngine['calls'] = []
  let answer: EngineAnswer = acceptFirstCode
  let down = false
  const adapter = {
    kind: 'promotions',
    providerName: opts.providerName ?? 'scripted-promotions',
    capabilities: () => opts.capabilities ?? ['codes'],
    producesEvents: [],
    consumesEvents: [],
    ...(opts.inTransaction === undefined ? {} : { inTransaction: opts.inTransaction }),
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' as const }),
    async evaluate(session: PromotionSession, evaluateOpts?: { dry?: boolean; orderId?: string }) {
      calls.push({ session, opts: evaluateOpts })
      if (down) throw new Error('the promotions engine is unreachable')
      return answer(session, evaluateOpts)
    },
  } as unknown as PromotionsAdapter
  return {
    adapter,
    calls,
    answer: (next) => {
      answer = next
    },
    fail: () => {
      down = true
    },
    recover: () => {
      down = false
    },
  }
}

export function isMoneyEffect(
  effect: PromotionEffect,
): effect is Extract<PromotionEffect, { amountMinor: number }> {
  return effect.kind === 'line' || effect.kind === 'order' || effect.kind === 'shipping'
}
