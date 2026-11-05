import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type ShippingAdapter,
} from '@nymbalhq/types'
import {
  createAfterShipShippingAdapter,
  type AfterShipShippingAdapterConfig,
} from './aftership-adapter.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'shipping'
export const provider = 'aftership'

export { createAfterShipShippingAdapter, type AfterShipShippingAdapterConfig }

/**
 * The fields the admin's Settings may fill. Without the API key no tracking number is registered; without the secret
 * the slot runs, degraded, and refuses every post.
 */
export const settings: AdapterSetting[] = [
  { path: 'apiKey', label: 'API key', secret: true, optional: true },
  { path: 'webhookSecret', label: 'Webhook secret', secret: true, optional: true },
]

/** The kernel's entry: `shipping: { provider: 'aftership', config: AfterShipShippingAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): ShippingAdapter {
  if (ctx.slot !== 'shipping') {
    throw new ConfigError(`@nymbalhq/shipping-aftership serves shipping, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createAfterShipShippingAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as AfterShipShippingAdapterConfig,
  })
}
