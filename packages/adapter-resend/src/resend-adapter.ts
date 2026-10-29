import { createSmtpTransportSender, type SmtpTransportConfig } from '@nymbalhq/adapter-smtp'
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
import {
  createResendWebhookReceiver,
  RESEND_BOUNCED,
  RESEND_COMPLAINED,
  signingKey,
} from './webhook.js'

export interface ResendEmailAdapterConfig {
  from?: string
  /** Resend's SMTP relay: `smtp.resend.com`, port 587 and user `resend` unless given; the password is the API key. */
  smtp?: {
    host?: string
    port?: number
    user?: string
    pass?: string
    secure?: boolean
  }
  /**
   * The webhook's signing secret (`whsec_…`). Without it, or with one that decodes to no key, every webhook post is
   * refused, and health says so.
   */
  webhookSecret?: string
}

const RELAY_HOST = 'smtp.resend.com'
const RELAY_PORT = 587
const RELAY_USER = 'resend'
const NO_SECRET = 'webhookSecret not set, or not a base64 key'
const NO_PASS = 'Resend SMTP login incomplete: smtp.pass (the API key) not set'

const set = (value: unknown): value is string => typeof value === 'string' && value !== ''

function transportConfig(cfg: ResendEmailAdapterConfig): SmtpTransportConfig {
  const smtp = cfg.smtp
  return {
    ...(cfg.from !== undefined && { from: cfg.from }),
    smtp: {
      host: smtp?.host ?? RELAY_HOST,
      port: smtp?.port ?? RELAY_PORT,
      user: smtp?.user ?? RELAY_USER,
      ...(smtp?.pass !== undefined && { pass: smtp.pass }),
      ...(smtp?.secure !== undefined && { secure: smtp.secure }),
    },
  }
}

export function createResendEmailAdapter(deps: {
  logger: Logger
  config?: ResendEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'resend' })
  let cfg: ResendEmailAdapterConfig = deps.config ?? {}
  const sender = createSmtpTransportSender(transportConfig(cfg), log)
  const secret = () =>
    set(cfg.webhookSecret) && signingKey(cfg.webhookSecret) !== undefined
      ? cfg.webhookSecret
      : undefined
  const receive = createResendWebhookReceiver(secret)

  return {
    kind: 'email',
    providerName: 'resend',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [RESEND_BOUNCED, RESEND_COMPLAINED],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as ResendEmailAdapterConfig) }
      sender.configure(transportConfig(cfg))
    },
    healthCheck: () =>
      boundedHealthCheck(async () => {
        const smtp = await sender.verify()
        const problems = [
          ...(set(cfg.smtp?.pass) ? [] : [`${NO_PASS}: Resend refuses every send`]),
          ...(secret() === undefined ? [`${NO_SECRET}: every Resend webhook post is refused`] : []),
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
      if (!set(cfg.smtp?.pass)) {
        return Promise.reject(
          new AdapterError('email.misconfigured', NO_PASS, { context: { missing: ['smtp.pass'] } }),
        )
      }
      return sender.sendTransactional(params)
    },
    syncCustomerToList: (customer) => sender.syncCustomerToList(customer),
    removeCustomerFromList: (customerId) => sender.removeCustomerFromList(customerId),
    receiveWebhook: (rawBody, headers) => receive(rawBody, headers),
  }
}
