import {
  CartPromotionError,
  CheckoutError,
  type Address,
  type Cart,
  type CartPromotions,
  type CheckoutTotals,
  type Logger,
  type Order,
  type PromotionEffect,
  type PromotionEvaluation,
  type PromotionSession,
  type PromotionsAdapter,
} from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import type { Repositories } from '../repositories/index.js'
import { settleQuote, settleTotals } from './totals.js'

/** How long any engine not marked `inTransaction` may take before it counts as down. */
export const PROMOTIONS_BOUND_MS = 3000

/** `evaluate`, abandoned at the bound as a failure. An `inTransaction` engine is awaited: a timer would abandon SQL still running in `place`'s transaction. */
export function evaluateBounded(
  engine: PromotionsAdapter,
  session: PromotionSession,
  opts: { dry?: boolean; orderId?: string },
  boundMs: number,
): Promise<PromotionEvaluation> {
  if (engine.inTransaction === true) return engine.evaluate(session, opts)
  let timer: NodeJS.Timeout
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`promotions engine past the ${boundMs} ms bound`)),
      boundMs,
    )
  })
  return Promise.race([engine.evaluate(session, opts), bound]).finally(() => clearTimeout(timer))
}

export interface SessionExtras {
  customerId: string | null
  email?: string
  shipTo?: Address
}

interface SessionSources {
  store: CommandStore
  catalogue: Pick<Repositories, 'variant' | 'productCategory'>
}

async function sessionOf(
  sources: SessionSources,
  cart: Cart,
  codes: readonly string[],
  extras: SessionExtras,
): Promise<PromotionSession> {
  const lines = await sources.store.read(async (tx) => {
    const built = []
    for (const item of cart.items) {
      const variant = await sources.catalogue.variant.findById(tx, item.variantId)
      built.push({
        id: item.variantId,
        variantId: item.variantId,
        sku: variant?.sku ?? '',
        productId: item.productId,
        categoryIds: await sources.catalogue.productCategory.listCategoriesForProduct(
          tx,
          item.productId,
        ),
        unitMinor: item.priceMinor,
        qty: item.qty,
      })
    }
    return built
  })
  return {
    id: cart.token,
    customerId: extras.customerId,
    ...(extras.email !== undefined && { email: extras.email }),
    codes,
    currency: cart.currency,
    lines,
    shipping: null,
    ...(extras.shipTo !== undefined && { shipTo: extras.shipTo }),
  }
}

const linesOf = (cart: Cart) =>
  cart.items.map((i) => ({ id: i.variantId, unitMinor: i.priceMinor, qty: i.qty }))

function settleInput(cart: Cart, effects: readonly PromotionEffect[]) {
  return {
    currency: cart.currency,
    lines: linesOf(cart),
    shipping: null,
    effects,
    tax: null,
    pricesIncludeTax: false,
  }
}

/** The totals a cart shows: its stored effects, none while the engine was down at the last evaluation. */
export function cartTotals(cart: Cart): CheckoutTotals {
  return settleTotals(settleInput(cart, cart.promotions?.effects ?? []))
}

export type CartCodeStatus = {
  code: string
  status: 'accepted' | 'rejected' | 'pending'
  reason?: string
}

/** Each code on a cart with what the engine last said of it, as the cart routes answer it. */
export function cartCodes(promotions: CartPromotions | undefined): {
  codes: CartCodeStatus[]
  unavailable: boolean
} {
  if (promotions === undefined) return { codes: [], unavailable: false }
  const { codes, effects, unavailable } = promotions
  return {
    unavailable,
    codes: codes.map((code): CartCodeStatus => {
      if (unavailable) return { code, status: 'pending' }
      const verdict = effects.find(
        (e) =>
          (e.kind === 'code_accepted' || e.kind === 'code_rejected') &&
          e.code.toLowerCase() === code.toLowerCase(),
      )
      if (verdict?.kind === 'code_rejected')
        return { code, status: 'rejected', reason: verdict.reason }
      if (verdict?.kind === 'code_accepted') return { code, status: 'accepted' }
      // The engine did not answer this code: it moves no money and the shopper is told so.
      return { code, status: 'rejected', reason: 'unanswered' }
    }),
  }
}

export interface CartQuoter {
  /** What to store: fresh effects, `unavailable` when the engine failed; undefined when the cart needs no engine at all. */
  quote(cart: Cart, strict: boolean): Promise<CartPromotions | undefined>
}

export function createCartQuoter(
  deps: SessionSources & {
    engine: PromotionsAdapter
    boundMs: number
    logger: Logger
    now: () => Date
  },
): CartQuoter {
  const { engine, boundMs, logger, now } = deps
  const automatic = engine.capabilities().includes('automatic')
  return {
    async quote(cart, strict) {
      const codes = cart.promotions?.codes ?? []
      if (codes.length === 0 && !automatic) return undefined
      const evaluatedAt = now().toISOString()
      const stored = (effects: PromotionEffect[], unavailable: boolean): CartPromotions => ({
        codes,
        effects,
        provider: engine.providerName,
        evaluatedAt,
        unavailable,
      })
      try {
        const session = await sessionOf(deps, cart, codes, {
          customerId: cart.customerId,
        })
        const evaluation = await evaluateBounded(engine, session, { dry: true }, boundMs)
        const { effects } = settleQuote(settleInput(cart, evaluation.effects))
        if (codes.length === 0 && effects.length === 0) return undefined
        return stored(effects, false)
      } catch (err) {
        logger.warn({ err, cart: cart.token }, 'promotions engine unavailable')
        if (strict) {
          throw new CartPromotionError(
            'cart.promotions_unavailable',
            'The promotions engine could not be reached',
            { cause: err },
          )
        }
        return codes.length === 0 ? undefined : stored([], true)
      }
    },
  }
}

export interface PlaceQuote {
  totals: CheckoutTotals
  /** Every effect the engine answered, code verdicts and all; the money that counted is `totals.applied`. */
  effects: PromotionEffect[]
  evaluationId?: string
  /** The engine was down for a cart with no code and the store chose to proceed at full price. */
  skipped: boolean
}

const acceptedCodes = (effects: readonly PromotionEffect[]): string[] =>
  effects.flatMap((e) => (e.kind === 'code_accepted' ? [e.code] : []))

/** A refusal the engine never wrote through: thrown to abandon a savepoint, carrying what the order should be. */
class FreeOrderRefused extends Error {
  constructor(readonly quote: PlaceQuote) {
    super('free order refused')
  }
}

export interface PlaceQuoter {
  dry(cart: Cart, extras: SessionExtras): Promise<PlaceQuote>
  /** The non-dry evaluation behind a savepoint, so a redemption made for a code then refused does not survive. */
  reserve(cart: Cart, extras: SessionExtras, orderId: string): Promise<PlaceQuote>
}

export function createPlaceQuoter(
  deps: SessionSources & {
    engine: PromotionsAdapter | undefined
    boundMs: number
    onUnavailable: 'proceed' | 'refuse'
    logger: Logger
  },
): PlaceQuoter {
  const { engine, boundMs, onUnavailable, logger, store } = deps
  const automatic = engine?.capabilities().includes('automatic') === true

  function plain(cart: Cart, skipped: boolean): PlaceQuote {
    return { totals: settleTotals(settleInput(cart, [])), effects: [], skipped }
  }

  async function quoted(
    cart: Cart,
    extras: SessionExtras,
    opts: { dry?: boolean; orderId?: string },
  ): Promise<PlaceQuote> {
    const codes = cart.promotions?.codes ?? []
    if (engine === undefined || (codes.length === 0 && !automatic)) return plain(cart, false)
    const session = await sessionOf(deps, cart, codes, extras)
    const evaluation = await evaluateBounded(engine, session, opts, boundMs)
    const { totals, effects, refused } = settleQuote(settleInput(cart, evaluation.effects))
    const quote: PlaceQuote = {
      totals,
      effects,
      ...(evaluation.evaluationId !== undefined && { evaluationId: evaluation.evaluationId }),
      skipped: false,
    }
    if (refused) throw new FreeOrderRefused(quote)
    return quote
  }

  function refuseOutage(cart: Cart, err: unknown): PlaceQuote {
    logger.warn({ err, cart: cart.token }, 'promotions engine unavailable at checkout')
    if ((cart.promotions?.codes.length ?? 0) > 0 || onUnavailable === 'refuse') {
      throw new CheckoutError(
        'promotions_unavailable',
        'The promotions engine could not be reached',
        { cause: err },
      )
    }
    return plain(cart, true)
  }

  return {
    async dry(cart, extras) {
      try {
        return await quoted(cart, extras, { dry: true })
      } catch (err) {
        if (err instanceof FreeOrderRefused) return err.quote
        return refuseOutage(cart, err)
      }
    },
    async reserve(cart, extras, orderId) {
      try {
        return await store.savepoint(() => quoted(cart, extras, { orderId }))
      } catch (err) {
        if (err instanceof FreeOrderRefused) return err.quote
        return refuseOutage(cart, err)
      }
    },
  }
}

/** The promotion record an order keeps, when there is anything to keep. */
export function orderPromotionRecord(
  provider: string,
  sessionId: string,
  quote: PlaceQuote,
): Record<string, unknown> | undefined {
  const codes = acceptedCodes(quote.effects)
  if (codes.length === 0 && quote.totals.applied.length === 0 && quote.evaluationId === undefined) {
    return undefined
  }
  return {
    provider,
    sessionId,
    codes,
    effects: quote.totals.applied,
    ...(quote.evaluationId !== undefined && { evaluationId: quote.evaluationId }),
  }
}

/** The shipping addresses are the same, an absent optional equal to an empty one, in any key order. */
function sameAddress(a: Address, b: Address): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(
    (key) => (left[key] ?? '') === (right[key] ?? ''),
  )
}

/**
 * The pending order is for exactly this cart at exactly this quote: the same lines, quantities and prices, the same
 * accepted codes and discount, and the same shipping address.
 */
export function sameQuote(order: Order, cart: Cart, quote: PlaceQuote, shipTo: Address): boolean {
  if (
    order.totalMinor !== quote.totals.totalMinor ||
    order.discountTotalMinor !== quote.totals.discountTotalMinor ||
    order.currency !== cart.currency ||
    order.lineItems.length !== cart.items.length ||
    !sameAddress(order.shippingAddress, shipTo)
  ) {
    return false
  }
  const onOrder = (
    (order.metadata as { promotions?: { codes?: string[] } }).promotions?.codes ?? []
  )
    .map((c) => c.toLowerCase())
    .sort()
  const quoted = acceptedCodes(quote.effects)
    .map((c) => c.toLowerCase())
    .sort()
  if (onOrder.length !== quoted.length || !onOrder.every((c, i) => c === quoted[i])) return false
  return cart.items.every((item, i) => {
    const line = order.lineItems[i]
    return (
      line?.variantId === item.variantId &&
      line.qty === item.qty &&
      line.unitPriceMinor === item.priceMinor
    )
  })
}
