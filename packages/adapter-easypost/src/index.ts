import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type ShippingAdapter,
} from '@nymbalhq/types'
import {
  createEasyPostShippingAdapter,
  type EasyPostShippingAdapterConfig,
} from './easypost-adapter.js'

export { createEasyPostShippingAdapter, type EasyPostShippingAdapterConfig }

/** The fields the admin's Settings may fill; without the secret the slot runs, degraded, and refuses every post. */
export const settings: AdapterSetting[] = [
  { path: 'webhookSecret', label: 'Webhook secret', secret: true, optional: true },
]

/** The kernel's entry: `shipping: { provider: 'easypost', config: EasyPostShippingAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): ShippingAdapter {
  if (ctx.slot !== 'shipping') {
    throw new ConfigError(`@nymbalhq/adapter-easypost serves shipping, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createEasyPostShippingAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as EasyPostShippingAdapterConfig,
  })
}
