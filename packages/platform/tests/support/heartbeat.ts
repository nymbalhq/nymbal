import type { NymbalConfig } from '@nymbalhq/config'
import type { Address } from '@nymbalhq/types'
import { address, type Kernel, type Seeded } from './kernel.js'
import { addLine, type Shop } from './promotions.js'
import { primedShopper } from './security.js'
import { placeOrder, quote, type CheckoutAnswer, type QuoteBody } from './shipping.js'
import type { ShopResponse } from './shopper.js'

// The store check as the kernel sees it: a store with `features.heartbeat` on (or off) and its heartbeat address, a
// shopper that quotes and then checks out at the quoted total and option, and a record of every call the checkout
// could make to the payments provider. Nothing here knows how the kernel recognises the address.

/** The heartbeat address the suites configure; mixed case, so a comparison that is not case-blind shows. */
export const HEARTBEAT_EMAIL = 'Heartbeat.Ops@Shop.Example'

export const HEARTBEAT_ADDRESS: Address = {
  ...address,
  firstName: 'Heartbeat',
  lastName: 'Check',
  addressLine1: '9 Monitor Row',
}

/** The kernel config with `features.heartbeat` set to `on` and the heartbeat block naming `email`. */
export function withHeartbeat(
  email: string = HEARTBEAT_EMAIL,
  on = true,
): (config: NymbalConfig) => NymbalConfig {
  return (config) =>
    ({
      ...config,
      features: { ...config.features, heartbeat: on },
      heartbeat: {
        store: { email, address: HEARTBEAT_ADDRESS },
        card: { amountMinor: 100 },
      },
    }) as NymbalConfig
}

/** The payments calls that move or look at money, as the provider would see them. */
const PROVIDER_CALLS = [
  'createPaymentIntent',
  'capturePayment',
  'refund',
  'listRefunds',
  'getPaymentStatus',
  'getPaymentIntent',
  'cancelPaymentIntent',
] as const

export interface ProviderCall {
  method: (typeof PROVIDER_CALLS)[number]
  args: unknown[]
}

/**
 * Every call the kernel makes to its payments adapter from now on, in order. The checkout looks the methods up on the
 * adapter at call time, so the real (stub) adapter still answers each one.
 */
export function watchProvider(kernel: Kernel): ProviderCall[] {
  const calls: ProviderCall[] = []
  const payments = kernel.app.adapters.payments as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >
  for (const method of PROVIDER_CALLS) {
    const original = payments[method]!.bind(payments)
    payments[method] = async (...args: unknown[]) => {
      calls.push({ method, args: structuredClone(args) })
      return original(...args)
    }
  }
  return calls
}

export interface StoreCheck {
  shop: Shop
  quoted: ShopResponse<QuoteBody>
  answer: ShopResponse<CheckoutAnswer>
}

/** The checkout's refusal context, when it carries one. */
export function contextOf(res: ShopResponse<unknown>): Record<string, unknown> {
  return ((res.body.error as { context?: Record<string, unknown> } | undefined)?.context ??
    {}) as Record<string, unknown>
}

/**
 * One unit of `variant` into a fresh cart, a quote for `email` to `shipTo` (with `optionId` when given), then a
 * checkout with `email` at the quoted total and option: what the heartbeat's store check sends, and what a shopper's
 * page sends. `afterQuote` runs between the two.
 */
export async function quotedCheckout(
  baseUrl: string,
  variant: Seeded,
  email: string,
  opts: { shipTo?: Address; optionId?: string; afterQuote?: () => Promise<void> } = {},
): Promise<StoreCheck> {
  const shipTo = opts.shipTo ?? HEARTBEAT_ADDRESS
  const shop = await primedShopper(baseUrl)
  const added = await addLine(shop, variant, 1)
  if (added.status !== 200) throw new Error(`add to cart: ${JSON.stringify(added.body)}`)
  const quoted = await quote(shop, {
    shippingAddress: shipTo,
    email,
    ...(opts.optionId !== undefined && { shippingOptionId: opts.optionId }),
  })
  if (quoted.status !== 200) throw new Error(`quote: ${JSON.stringify(quoted.body)}`)
  await opts.afterQuote?.()
  const answer = await placeOrder(shop, email, {
    shippingAddress: shipTo,
    shippingOptionId: quoted.body.data!.shippingOptionId,
    expectedTotalMinor: quoted.body.data!.totals.totalMinor,
  })
  return { shop, quoted, answer }
}
