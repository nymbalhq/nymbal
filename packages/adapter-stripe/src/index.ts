import { ConfigError, type AdapterContext, type PaymentsAdapter } from '@nymbalhq/types'
import { createStripePaymentsAdapter, type StripePaymentsConfig } from './stripe-adapter.js'

export { createStripePaymentsAdapter, type StripePaymentsConfig }

/** The kernel's entry: `payments: { provider: 'stripe', config: StripePaymentsConfig }`. */
export function createAdapter(ctx: AdapterContext): PaymentsAdapter {
  if (ctx.slot !== 'payments') {
    throw new ConfigError(`@nymbalhq/adapter-stripe serves payments, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const config = ctx.config as unknown as StripePaymentsConfig
  const publishableKey = config.publishableKey ?? ctx.env['STRIPE_PUBLISHABLE_KEY']
  return createStripePaymentsAdapter({
    logger: ctx.logger,
    config: { ...config, ...(publishableKey !== undefined && { publishableKey }) },
  })
}
