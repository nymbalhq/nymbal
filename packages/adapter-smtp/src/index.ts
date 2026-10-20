import { ConfigError, type AdapterContext, type EmailAdapter } from '@nymbalhq/types'
import { createSmtpEmailAdapter, type SmtpEmailAdapterConfig } from './smtp-adapter.js'

export { createSmtpEmailAdapter, type SmtpEmailAdapterConfig }

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
