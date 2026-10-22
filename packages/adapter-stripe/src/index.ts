import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type PaymentsAdapter,
} from '@nymbalhq/types'
import { createStripePaymentsAdapter, type StripePaymentsConfig } from './stripe-adapter.js'

export { createStripePaymentsAdapter, type StripePaymentsConfig }

/** The fields the admin's Settings may fill when the config and these variables leave them unset. */
export const settings: AdapterSetting[] = [
  { path: 'secretKey', label: 'Secret key', secret: true, env: 'STRIPE_SECRET_KEY' },
  {
    path: 'webhookSecret',
    label: 'Webhook signing secret',
    secret: true,
    env: 'STRIPE_WEBHOOK_SECRET',
  },
  {
    path: 'publishableKey',
    label: 'Publishable key',
    secret: false,
    env: 'STRIPE_PUBLISHABLE_KEY',
  },
]

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
