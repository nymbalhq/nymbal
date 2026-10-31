import { createSmtpTransportSender, type SmtpTransportConfig } from '@nymbalhq/email-smtp'
import {
  AdapterError,
  boundedHealthCheck,
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  type EmailAdapter,
  type Logger,
} from '@nymbalhq/types'
import { createMailgunWebhookReceiver, MAILGUN_BOUNCED, MAILGUN_COMPLAINED } from './webhook.js'

export interface MailgunEmailAdapterConfig {
  from?: string
  /** Mailgun's SMTP relay: the domain's SMTP login, with the host from `region` and port 587 unless given. */
  smtp?: {
    host?: string
    port?: number
    user?: string
    pass?: string
    secure?: boolean
  }
  region?: 'us' | 'eu'
  /** The domain's HTTP webhook signing key. Without it every webhook post is refused, and health says so. */
  webhookSigningKey?: string
}

const RELAY_HOSTS = { us: 'smtp.mailgun.org', eu: 'smtp.eu.mailgun.org' } as const
const RELAY_PORT = 587
const NO_KEY = 'webhook signing key not set'

/** Mailgun refuses an unauthenticated relay, and nodemailer only logs in with both fields: name each one missing. */
function missingLogin(cfg: MailgunEmailAdapterConfig): string[] {
  const missing: string[] = []
  if (typeof cfg.smtp?.user !== 'string' || cfg.smtp.user === '') missing.push('smtp.user')
  if (typeof cfg.smtp?.pass !== 'string' || cfg.smtp.pass === '') missing.push('smtp.pass')
  return missing
}

function loginText(missing: string[]): string {
  return `Mailgun SMTP login incomplete: ${missing.join(', ')} not set`
}

function transportConfig(cfg: MailgunEmailAdapterConfig): SmtpTransportConfig {
  const smtp = cfg.smtp
  return {
    ...(cfg.from !== undefined && { from: cfg.from }),
    smtp: {
      host: smtp?.host ?? RELAY_HOSTS[cfg.region === 'eu' ? 'eu' : 'us'],
      port: smtp?.port ?? RELAY_PORT,
      ...(smtp?.user !== undefined && { user: smtp.user }),
      ...(smtp?.pass !== undefined && { pass: smtp.pass }),
      ...(smtp?.secure !== undefined && { secure: smtp.secure }),
    },
  }
}

export function createMailgunEmailAdapter(deps: {
  logger: Logger
  config?: MailgunEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'mailgun' })
  let cfg: MailgunEmailAdapterConfig = deps.config ?? {}
  const sender = createSmtpTransportSender(transportConfig(cfg), log)
  const signingKey = () =>
    typeof cfg.webhookSigningKey === 'string' && cfg.webhookSigningKey !== ''
      ? cfg.webhookSigningKey
      : undefined
  const receive = createMailgunWebhookReceiver(signingKey)

  return {
    kind: 'email',
    providerName: 'mailgun',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [MAILGUN_BOUNCED, MAILGUN_COMPLAINED],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as MailgunEmailAdapterConfig) }
      sender.configure(transportConfig(cfg))
    },
    healthCheck: () =>
      boundedHealthCheck(async () => {
        const smtp = await sender.verify()
        const missing = missingLogin(cfg)
        const problems = [
          ...(missing.length > 0 ? [`${loginText(missing)}: Mailgun refuses every send`] : []),
          ...(signingKey() === undefined
            ? [`${NO_KEY}: every Mailgun webhook post is refused`]
            : []),
        ]
        if (problems.length === 0) return smtp
        // A relay that is down, or refuses the login, keeps its status; each missing field is named beside it.
        return smtp.status === 'healthy'
          ? { status: 'degraded', detail: problems.join('; ') }
          : {
              status: smtp.status,
              detail: [smtp.detail ?? 'SMTP verify failed', ...problems].join('; '),
            }
      }),
    sendTransactional: (params) => {
      const missing = missingLogin(cfg)
      if (missing.length > 0) {
        return Promise.reject(
          new AdapterError('email.misconfigured', loginText(missing), { context: { missing } }),
        )
      }
      return sender.sendTransactional(params)
    },
    syncCustomerToList: (customer) => sender.syncCustomerToList(customer),
    removeCustomerFromList: (customerId) => sender.removeCustomerFromList(customerId),
    receiveWebhook: (rawBody) => receive(rawBody),
  }
}
