import nodemailer, { type Transporter } from 'nodemailer'
import {
  AdapterError,
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  renderEmailTemplate,
  type CustomerProfile,
  type EmailAdapter,
  type Logger,
  type TransactionalEmail,
} from '@nymbalhq/types'

export interface SmtpEmailAdapterConfig {
  from?: string
  smtp?: {
    host: string
    port: number
    user?: string
    pass?: string
    secure?: boolean
  }
}

export function createSmtpEmailAdapter(deps: {
  logger: Logger
  config?: SmtpEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'smtp' })
  let cfg: SmtpEmailAdapterConfig = deps.config ?? {}
  let transporter: Transporter | null = null

  function ensureTransport(): Transporter {
    if (transporter) return transporter
    if (!cfg.smtp) {
      throw new AdapterError('email.misconfigured', 'SMTP provider selected but smtp.host not set')
    }
    transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure ?? cfg.smtp.port === 465,
      ...(cfg.smtp.user !== undefined && cfg.smtp.pass !== undefined
        ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } }
        : {}),
    })
    return transporter
  }

  return {
    kind: 'email',
    providerName: 'smtp',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as SmtpEmailAdapterConfig) }
      ensureTransport()
    },
    async healthCheck() {
      try {
        await ensureTransport().verify()
        return { status: 'healthy', detail: 'SMTP verified' }
      } catch (err) {
        return {
          status: 'degraded',
          detail: `SMTP verify failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },

    async sendTransactional(params: TransactionalEmail) {
      const rendered = renderEmailTemplate(params.template, params.vars)
      const info = await ensureTransport().sendMail({
        from: cfg.from ?? 'no-reply@nymbal.dev',
        to: params.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      })
      return { messageId: info.messageId ?? null, accepted: (info.accepted ?? []).length > 0 }
    },

    async syncCustomerToList(customer: CustomerProfile) {
      log.debug({ customerId: customer.customerId }, 'email.syncCustomerToList (stub)')
    },

    async removeCustomerFromList(customerId: string) {
      log.debug({ customerId }, 'email.removeCustomerFromList (stub)')
    },
  }
}
