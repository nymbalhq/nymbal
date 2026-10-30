import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type EmailAdapter,
} from '@nymbalhq/types'
import { createResendEmailAdapter, type ResendEmailAdapterConfig } from './resend-adapter.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'email'
export const provider = 'resend'

export { createResendEmailAdapter, type ResendEmailAdapterConfig }

/** The fields the admin's Settings may fill; without the webhook secret the slot runs, degraded, and refuses every post. */
export const settings: AdapterSetting[] = [
  { path: 'smtp.pass', label: 'Resend API key', secret: true },
  { path: 'webhookSecret', label: 'Webhook signing secret', secret: true, optional: true },
]

/** The kernel's entry: `email: { provider: 'resend', config: ResendEmailAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): EmailAdapter {
  if (ctx.slot !== 'email') {
    throw new ConfigError(`@nymbalhq/email-resend serves email, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createResendEmailAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as ResendEmailAdapterConfig,
  })
}
