import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type EmailAdapter,
} from '@nymbalhq/types'
import { createSesEmailAdapter, type SesEmailAdapterConfig } from './ses-adapter.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'email'
export const provider = 'ses'

export { createSesEmailAdapter, type SesEmailAdapterConfig }

/** The fields the admin's Settings may fill; without the topic the slot runs, degraded, and refuses every post. */
export const settings: AdapterSetting[] = [
  { path: 'smtp.user', label: 'SES SMTP user name', secret: false },
  { path: 'smtp.pass', label: 'SES SMTP password', secret: true },
  {
    path: 'topicArn',
    label: 'SNS topic ARN for bounces and complaints',
    secret: false,
    optional: true,
  },
]

/** The kernel's entry: `email: { provider: 'ses', config: SesEmailAdapterConfig }`. */
export function createAdapter(ctx: AdapterContext): EmailAdapter {
  if (ctx.slot !== 'email') {
    throw new ConfigError(`@nymbalhq/email-ses serves email, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createSesEmailAdapter({
    logger: ctx.logger,
    config: ctx.config as unknown as SesEmailAdapterConfig,
  })
}
