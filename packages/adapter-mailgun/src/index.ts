import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type EmailAdapter,
} from '@nymbalhq/types'
import { createMailgunEmailAdapter, type MailgunEmailAdapterConfig } from './mailgun-adapter.js'

export { createMailgunEmailAdapter, type MailgunEmailAdapterConfig }

/** The fields the admin's Settings may fill; without the signing key the slot runs, degraded, and refuses every post. */
export const settings: AdapterSetting[] = [
  { path: 'smtp.user', label: 'Mailgun SMTP user', secret: false },
  { path: 'smtp.pass', label: 'Mailgun SMTP password', secret: true },
  { path: 'webhookSigningKey', label: 'Webhook signing key', secret: true, optional: true },
]

/** The kernel's entry: `email: { provider: 'mailgun', config: MailgunEmailAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): EmailAdapter {
  if (ctx.slot !== 'email') {
    throw new ConfigError(`@nymbalhq/adapter-mailgun serves email, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createMailgunEmailAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as MailgunEmailAdapterConfig,
  })
}
