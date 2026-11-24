import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type PromotionsAdapter,
} from '@nymbalhq/types'
import {
  createTalonOnePromotionsAdapter,
  type TalonOnePromotionsAdapterConfig,
} from './talon-one-adapter.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'promotions'
export const provider = 'talon-one'

export { createTalonOnePromotionsAdapter, type TalonOnePromotionsAdapterConfig }

/** The fields the admin's Settings may fill: the API key alone, so no saved value can send it to another host. */
export const settings: AdapterSetting[] = [{ path: 'apiKey', label: 'API key', secret: true }]

/** The kernel's entry: `promotions: { provider: 'talon-one', config: TalonOnePromotionsAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): PromotionsAdapter {
  if (ctx.slot !== 'promotions') {
    throw new ConfigError(`@nymbalhq/promotions-talon-one serves promotions, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createTalonOnePromotionsAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as TalonOnePromotionsAdapterConfig,
  })
}
