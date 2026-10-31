import nodemailer, { type Transporter } from 'nodemailer'
import {
  AdapterError,
  errorText,
  renderEmailTemplate,
  type CustomerProfile,
  type EmailSendResult,
  type HealthReport,
  type Logger,
  type TransactionalEmail,
} from '@nymbalhq/types'

const SMTP_TIMEOUT_MS = 4000

export interface SmtpTransportConfig {
  from?: string
  smtp?: {
    host: string
    port: number
    user?: string
    pass?: string
    secure?: boolean
  }
}

/** The send path an email adapter that relays over SMTP shares: one lazily built nodemailer transport. */
export interface SmtpTransportSender {
  /** Merges `config` over what the sender was built with and builds the transport, as `initialize` does. */
  configure(config: SmtpTransportConfig): void
  /** The SMTP login checked, unbounded: the caller wraps it in `boundedHealthCheck`. */
  verify(): Promise<HealthReport>
  sendTransactional(params: TransactionalEmail): Promise<EmailSendResult>
  syncCustomerToList(customer: CustomerProfile): Promise<void>
  removeCustomerFromList(customerId: string): Promise<void>
}

export function createSmtpTransportSender(
  config: SmtpTransportConfig,
  logger: Logger,
): SmtpTransportSender {
  let cfg: SmtpTransportConfig = config
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
      // nodemailer waits two minutes to connect by default; a host that drops packets must fail inside the 6 s bound.
      connectionTimeout: SMTP_TIMEOUT_MS,
      greetingTimeout: SMTP_TIMEOUT_MS,
      socketTimeout: SMTP_TIMEOUT_MS,
      ...(cfg.smtp.user !== undefined && cfg.smtp.pass !== undefined
        ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } }
        : {}),
    })
    return transporter
  }

  return {
    configure(next) {
      cfg = { ...cfg, ...next }
      ensureTransport()
    },

    async verify() {
      try {
        await ensureTransport().verify()
        return { status: 'healthy', detail: 'SMTP verified' }
      } catch (err) {
        // A server that answers and refuses the login is there but unusable; one that cannot be reached is down.
        const reachable = (err as { code?: unknown } | null)?.code === 'EAUTH'
        return {
          status: reachable ? 'degraded' : 'down',
          detail: `SMTP verify failed: ${errorText(err)}`,
        }
      }
    },

    async sendTransactional(params) {
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

    async syncCustomerToList(customer) {
      logger.debug({ customerId: customer.customerId }, 'email.syncCustomerToList (stub)')
    },

    async removeCustomerFromList(customerId) {
      logger.debug({ customerId }, 'email.removeCustomerFromList (stub)')
    },
  }
}
