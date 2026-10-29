import {
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
import { okHealth } from '../base.js'

/** The native provider logs mail to the console; SMTP is the `smtp` provider (@nymbalhq/email-smtp). */
export interface NativeEmailAdapterConfig {
  transport?: 'console'
  from?: string
}

export function createNativeEmailAdapter(deps: {
  logger: Logger
  config?: NativeEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'native' })

  return {
    kind: 'email',
    providerName: 'native',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize() {
      // the console transport has nothing to set up
    },
    healthCheck: () => okHealth('console transport'),

    async sendTransactional(params: TransactionalEmail) {
      const rendered = renderEmailTemplate(params.template, params.vars)
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
