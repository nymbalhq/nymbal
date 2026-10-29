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
  createSnsWebhookReceiver,
  fetchCertificateText,
  SES_BOUNCED,
  SES_COMPLAINED,
} from './webhook.js'

export interface SesEmailAdapterConfig {
  from?: string
  /** The SES region the sending identity is verified in: `us-east-1`, `eu-west-1`. */
  region: string
  /** SES's SMTP interface: `email-smtp.<region>.amazonaws.com`, port 587 unless given, with SES SMTP credentials. */
  smtp?: {
    user?: string
    pass?: string
    host?: string
    port?: number
    secure?: boolean
  }
  /**
   * The SNS topic SES publishes bounces and complaints to. Any AWS account can sign a message to its own topic, so
   * without it every SNS post is refused, and health says so.
   */
  topicArn?: string
}

const RELAY_PORT = 587
const NO_TOPIC = 'topicArn not set'

const set = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** SES refuses an unauthenticated relay, and nodemailer only logs in with both fields: name each one missing. */
function missingLogin(cfg: SesEmailAdapterConfig): string[] {
  return [
    ...(set(cfg.smtp?.user) ? [] : ['smtp.user']),
    ...(set(cfg.smtp?.pass) ? [] : ['smtp.pass']),
  ]
}

function loginText(missing: string[]): string {
  return `SES SMTP login incomplete: ${missing.join(', ')} not set`
}

function transportConfig(cfg: SesEmailAdapterConfig): SmtpTransportConfig {
  const smtp = cfg.smtp
  return {
    ...(cfg.from !== undefined && { from: cfg.from }),
    smtp: {
      host: smtp?.host ?? `email-smtp.${cfg.region}.amazonaws.com`,
      port: smtp?.port ?? RELAY_PORT,
      ...(smtp?.user !== undefined && { user: smtp.user }),
      ...(smtp?.pass !== undefined && { pass: smtp.pass }),
      ...(smtp?.secure !== undefined && { secure: smtp.secure }),
    },
  }
}

export function createSesEmailAdapter(deps: {
  logger: Logger
  config?: SesEmailAdapterConfig
  /** The body of an SNS certificate URL, as text; by default a bounded `fetch` with no redirect followed. */
  fetchCertificate?: (url: string) => Promise<string>
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'ses' })
  let cfg = (deps.config ?? {}) as SesEmailAdapterConfig
  const sender = createSmtpTransportSender(transportConfig(cfg), log)
  const topicArn = () => (set(cfg.topicArn) ? cfg.topicArn : undefined)
  const receive = createSnsWebhookReceiver({
    topicArn,
    fetchCertificate: deps.fetchCertificate ?? fetchCertificateText,
    log,
  })

  return {
    kind: 'email',
    providerName: 'ses',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [SES_BOUNCED, SES_COMPLAINED],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as Partial<SesEmailAdapterConfig>) }
      sender.configure(transportConfig(cfg))
    },
    healthCheck: () =>
      boundedHealthCheck(async () => {
        const smtp = await sender.verify()
        const missing = missingLogin(cfg)
        const problems = [
          ...(missing.length > 0 ? [`${loginText(missing)}: SES refuses every send`] : []),
          ...(topicArn() === undefined ? [`${NO_TOPIC}: every SNS post is refused`] : []),
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
