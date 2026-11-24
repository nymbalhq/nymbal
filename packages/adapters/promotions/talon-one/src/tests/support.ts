import type {
  Logger,
  PromotionEffect,
  PromotionSession,
  PromotionSessionLine,
  PromotionsAdapter,
} from '@nymbalhq/types'
import { createTalonOnePromotionsAdapter, type TalonOnePromotionsAdapterConfig } from '../index.js'
import { FAKE_TALON_ONE_API_KEY, type FakeTalonOne } from './fake-talon-one.js'

// What the Talon.One unit tests share: loggers, a session, the adapter built and initialized against the fake, an
// answer scripted as Talon.One would send it, and the strings anything reachable from a value holds (key-leak checks).

export const silent: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
}

export interface LogLine {
  level: string
  bindings: unknown
  obj: unknown
  msg: unknown
}

/** A logger that keeps every call's arguments, its children's too. */
export function recordingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = []
  const make = (bindings: unknown): Logger => {
    const at = (level: string) => (obj: unknown, msg?: string) => {
      lines.push({ level, bindings, obj, msg })
    }
    return {
      trace: at('trace'),
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
      child: (more) => make({ bindings, more }),
    }
  }
  return { logger: make({}), lines }
}

export const line = (
  n: number,
  over: Partial<PromotionSessionLine> = {},
): PromotionSessionLine => ({
  id: `line-${n}`,
  variantId: `variant-${n}`,
  sku: `SKU-${n}`,
  productId: `product-${n}`,
  categoryIds: [],
  unitMinor: 1250,
  qty: 1,
  ...over,
})

export const session = (over: Partial<PromotionSession> = {}): PromotionSession => ({
  id: 'cart-token-1',
  customerId: null,
  codes: [],
  currency: 'GBP',
  lines: [line(1)],
  shipping: null,
  ...over,
})

/** The adapter as the kernel has it: built with the config block, then initialized with it. */
export async function talonOne(
  fake: { baseUrl: string },
  over: Partial<TalonOnePromotionsAdapterConfig> = {},
  logger: Logger = silent,
): Promise<PromotionsAdapter> {
  const config: TalonOnePromotionsAdapterConfig = {
    baseUrl: fake.baseUrl,
    apiKey: FAKE_TALON_ONE_API_KEY,
    currency: 'GBP',
    ...over,
  }
  const adapter = createTalonOnePromotionsAdapter({ logger, config })
  await adapter.initialize(config)
  return adapter
}

let ruleCounter = 0

/** One effect as Talon.One sends it. */
export function effect(
  effectType: string,
  props: Record<string, unknown>,
  over: { campaignId?: number; triggeredByCoupon?: number } = {},
): Record<string, unknown> {
  ruleCounter += 1
  return {
    campaignId: over.campaignId ?? 7,
    rulesetId: 70,
    ruleIndex: ruleCounter,
    ruleName: `rule ${ruleCounter}`,
    effectType,
    ...(over.triggeredByCoupon !== undefined && { triggeredByCoupon: over.triggeredByCoupon }),
    props,
  }
}

/** A 200 the fake answers to every request from now on: these effects, and these coupons. */
export function scripted(
  fake: FakeTalonOne,
  effects: Record<string, unknown>[],
  coupons: { id: number; value: string }[] = [],
): void {
  fake.answer({
    status: 200,
    body: { customerSession: { state: 'open' }, effects, coupons, createdCoupons: [] },
  })
}

export const isMoney = (
  e: PromotionEffect,
): e is Extract<PromotionEffect, { amountMinor: number }> =>
  e.kind === 'line' || e.kind === 'order' || e.kind === 'shipping'

/** What a call left behind: its value, or the error it rejected or threw with, and how long it took. */
export async function outcomeOf<T>(
  call: () => Promise<T> | T,
): Promise<{ value?: T; error?: unknown; ms: number }> {
  const started = Date.now()
  try {
    return { value: await call(), ms: Date.now() - started }
  } catch (error) {
    return { error, ms: Date.now() - started }
  }
}

/** Every string reachable from `values`: keys and values, deeply, Errors' message, stack, cause and own properties. */
export function stringsIn(values: unknown[]): string[] {
  const out: string[] = []
  const seen = new WeakSet<object>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 12) return
    if (typeof value === 'string') return void out.push(value)
    if (typeof value !== 'object' || value === null) return
    if (seen.has(value)) return
    seen.add(value)
    const keys =
      value instanceof Error
        ? [...new Set(['message', 'stack', 'cause', ...Object.getOwnPropertyNames(value)])]
        : value instanceof Headers
          ? [...value.keys()]
          : Object.keys(value)
    for (const key of keys) {
      out.push(key)
      visit(
        value instanceof Headers ? value.get(key) : (value as Record<string, unknown>)[key],
        depth + 1,
      )
    }
  }
  for (const value of values) visit(value, 0)
  return out
}
