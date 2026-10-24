import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type EmailAdapter,
} from '@nymbalhq/types'
import { createSmtpEmailAdapter, type SmtpEmailAdapterConfig } from './smtp-adapter.js'

export { createSmtpEmailAdapter, type SmtpEmailAdapterConfig }

/** The SMTP login the admin's Settings may fill; a server that takes mail without one needs neither. */
export const settings: AdapterSetting[] = [
  { path: 'smtp.user', label: 'SMTP user', secret: true, optional: true },
  { path: 'smtp.pass', label: 'SMTP password', secret: true, optional: true },
]

/** The kernel's entry: `email: { provider: 'smtp', config: SmtpEmailAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): EmailAdapter {
  if (ctx.slot !== 'email') {
    throw new ConfigError(`@nymbalhq/adapter-smtp serves email, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createSmtpEmailAdapter({
    logger: ctx.logger,
    config: ctx.config as SmtpEmailAdapterConfig,
  })
}
