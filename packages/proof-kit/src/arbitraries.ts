import fc from 'fast-check'
import {
  ORDER_STATUS_TRANSITIONS,
  STANDARD_EVENT_TYPES,
  canTransitionOrder,
  type Money,
  type NymbalEvent,
  type OrderStatus,
} from '@nymbalhq/types'

/** Minor-unit digits per currency. Test data: the repo has no currency table. */
export const CURRENCY_EXPONENTS: Readonly<Record<string, 0 | 2 | 3>> = {
  JPY: 0,
  KRW: 0,
  GBP: 2,
  USD: 2,
  EUR: 2,
  KWD: 3,
  BHD: 3,
}

export function arbCurrency(): fc.Arbitrary<string> {
  return fc.constantFrom(...Object.keys(CURRENCY_EXPONENTS))
}

export function arbMoney(
  opts: { currency?: string; min?: number; max?: number } = {},
): fc.Arbitrary<Money> {
  const { min = 0, max = 1_000_000_000 } = opts
  const currency = opts.currency === undefined ? arbCurrency() : fc.constant(opts.currency)
  return fc.record({ amount: fc.integer({ min, max }), currency })
}

export interface CartLine {
  variantId: string
  unitPriceMinor: number
  qty: number
}

/** A cart of one currency whose line totals stay safe integers however many lines are drawn. */
export function arbCart(
  opts: { currency?: string; maxLines?: number } = {},
): fc.Arbitrary<{ currency: string; lines: CartLine[] }> {
  const line = fc.record({
    variantId: fc.uuid(),
    unitPriceMinor: fc.integer({ min: 0, max: 10_000_000 }),
    qty: fc.integer({ min: 1, max: 100 }),
  })
  return fc.record({
    currency: opts.currency === undefined ? arbCurrency() : fc.constant(opts.currency),
    lines: fc.array(line, { minLength: 1, maxLength: opts.maxLines ?? 10 }),
  })
}

const STATUSES = Object.keys(ORDER_STATUS_TRANSITIONS) as OrderStatus[]

/** A walk through ORDER_STATUS_TRANSITIONS from `from`; it ends early at a terminal status. */
export function arbOrderPath(
  opts: { from?: OrderStatus; maxSteps?: number } = {},
): fc.Arbitrary<OrderStatus[]> {
  const { from = 'pending', maxSteps = 8 } = opts
  return fc.array(fc.nat(), { maxLength: maxSteps }).map((choices) => {
    const path: OrderStatus[] = [from]
    for (const choice of choices) {
      const next = ORDER_STATUS_TRANSITIONS[path[path.length - 1]!]
      if (next.length === 0) break
      path.push(next[choice % next.length]!)
    }
    return path
  })
}

const PAIRS = STATUSES.flatMap((from) => STATUSES.map((to) => ({ from, to })))

export function arbOrderTransition(opts: {
  valid: boolean
}): fc.Arbitrary<{ from: OrderStatus; to: OrderStatus }> {
  return fc.constantFrom(...PAIRS.filter((p) => canTransitionOrder(p.from, p.to) === opts.valid))
}

const EPOCH_MS = Date.UTC(2026, 0, 1)

/**
 * Events in delivery order with unique ids and strictly increasing timestamps. `duplicates` redelivers an earlier
 * event (same id and type, a later timestamp); `shuffled` permutes the whole sequence, so timestamps arrive out
 * of order.
 */
export function arbEventSequence(
  opts: { types?: string[]; maxLength?: number; duplicates?: boolean; shuffled?: boolean } = {},
): fc.Arbitrary<NymbalEvent[]> {
  const types = opts.types ?? [...STANDARD_EVENT_TYPES]
  const draw = fc.record({
    id: fc.uuid(),
    type: fc.constantFrom(...types),
    correlationId: fc.uuid(),
    gapMs: fc.integer({ min: 1, max: 60_000 }),
  })
  const base = fc
    .uniqueArray(draw, { maxLength: opts.maxLength ?? 12, selector: (d) => d.id })
    .map((draws) => {
      let at = EPOCH_MS
      return draws.map((d): NymbalEvent => {
        at += d.gapMs
        return {
          id: d.id,
          type: d.type,
          timestamp: new Date(at).toISOString(),
          source: 'proof-kit',
          correlationId: d.correlationId,
          payload: {},
          metadata: { storeId: 'proof-kit', environment: 'development', version: '0.0.0' },
        }
      })
    })

  const withDuplicate = (events: NymbalEvent[]): fc.Arbitrary<NymbalEvent[]> => {
    if (opts.duplicates !== true || events.length < 2) return fc.constant(events)
    return fc
      .tuple(fc.integer({ min: 0, max: events.length - 2 }), fc.nat())
      .map(([original, offset]) => {
        const slot = original + 1 + (offset % (events.length - original - 1))
        return events.map((e, i) =>
          i === slot ? { ...events[original]!, timestamp: e.timestamp } : e,
        )
      })
  }

  const withOrder = (events: NymbalEvent[]): fc.Arbitrary<NymbalEvent[]> =>
    opts.shuffled === true
      ? fc.shuffledSubarray(events, { minLength: events.length, maxLength: events.length })
      : fc.constant(events)

  return base.chain(withDuplicate).chain(withOrder)
}
