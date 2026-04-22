import nodemailer, { type Transporter } from 'nodemailer'
import {
  AdapterError,
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  type CustomerProfile,
  type EmailAdapter,
  type Logger,
  type TransactionalEmail,
} from '@nymbal/types'
import { okHealth } from '../base.js'
import { renderTemplate } from './templates.js'

export interface NativeEmailAdapterConfig {
  transport?: 'console' | 'smtp'
  from?: string
  smtp?: {
    host: string
    port: number
    user?: string
    pass?: string
    secure?: boolean
  }
}

export function createNativeEmailAdapter(deps: {
  logger: Logger
  config?: NativeEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'native' })
  let cfg: NativeEmailAdapterConfig = deps.config ?? { transport: 'console' }
  let transporter: Transporter | null = null

  function ensureTransport(): void {
    if (cfg.transport !== 'smtp') return
    if (transporter) return
    if (!cfg.smtp) {
      throw new AdapterError('email.misconfigured', 'SMTP transport selected but smtp.host not set')
    }
    transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure ?? cfg.smtp.port === 465,
      ...(cfg.smtp.user !== undefined && cfg.smtp.pass !== undefined
        ? { auth: { user: cfg.smtp.user, pass: cfg.smtp.pass } }
        : {}),
    })
  }

  return {
    kind: 'email',
    providerName: 'native',
    capabilities: ['transactional', 'list-sync'],
    producesEvents: [],
    consumesEvents: [
      EVT_ORDER_PLACED,
      EVT_ORDER_SHIPPED,
      EVT_CUSTOMER_CREATED,
      EVT_CART_ABANDONED,
    ],
    async initialize(rawConfig) {
      cfg = { ...cfg, ...(rawConfig as NativeEmailAdapterConfig) }
      if (cfg.transport === 'smtp') ensureTransport()
    },
    async healthCheck() {
      if (cfg.transport === 'smtp' && transporter) {
        try {
          await transporter.verify()
          return { status: 'healthy', detail: 'SMTP verified' }
        } catch (err) {
          return {
            status: 'degraded',
            detail: `SMTP verify failed: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }
      return okHealth('console transport')
    },

    async sendTransactional(params: TransactionalEmail) {
      const rendered = renderTemplate(params.template, params.vars)
      if (cfg.transport === 'smtp') {
        ensureTransport()
        if (!transporter) {
          throw new AdapterError('email.transport_missing', 'SMTP transport not initialised')
        }
        const info = await transporter.sendMail({
          from: cfg.from ?? 'no-reply@nymbal.dev',
          to: params.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        })
        return { messageId: info.messageId ?? null, accepted: (info.accepted ?? []).length > 0 }
      }
      log.info(
        { to: params.to, subject: rendered.subject, template: params.template },
        'email.sent (console)',
      )
      log.debug({ body: rendered.text }, 'email body')
      return { messageId: null, accepted: true }
    },

    async syncCustomerToList(customer: CustomerProfile) {
      log.debug({ customerId: customer.customerId }, 'email.syncCustomerToList (stub)')
    },

    async removeCustomerFromList(customerId: string) {
      log.debug({ customerId }, 'email.removeCustomerFromList (stub)')
    },
  }
}
