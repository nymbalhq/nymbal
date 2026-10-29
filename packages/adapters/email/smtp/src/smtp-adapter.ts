import {
  boundedHealthCheck,
  EVT_CART_ABANDONED,
  EVT_CUSTOMER_CREATED,
  EVT_ORDER_PLACED,
  EVT_ORDER_SHIPPED,
  type EmailAdapter,
  type Logger,
} from '@nymbalhq/types'
import { createSmtpTransportSender, type SmtpTransportConfig } from './smtp-transport-sender.js'

export type SmtpEmailAdapterConfig = SmtpTransportConfig

export function createSmtpEmailAdapter(deps: {
  logger: Logger
  config?: SmtpEmailAdapterConfig
}): EmailAdapter {
  const log = deps.logger.child({ adapter: 'email', provider: 'smtp' })
  const sender = createSmtpTransportSender(deps.config ?? {}, log)

  return {
    kind: 'email',
    providerName: 'smtp',
    capabilities: () => ['transactional', 'list-sync'],
    producesEvents: [],
    consumesEvents: [EVT_ORDER_PLACED, EVT_ORDER_SHIPPED, EVT_CUSTOMER_CREATED, EVT_CART_ABANDONED],
    async initialize(rawConfig) {
      sender.configure(rawConfig as SmtpEmailAdapterConfig)
    },
    healthCheck: () => boundedHealthCheck(() => sender.verify()),
    sendTransactional: (params) => sender.sendTransactional(params),
    syncCustomerToList: (customer) => sender.syncCustomerToList(customer),
    removeCustomerFromList: (customerId) => sender.removeCustomerFromList(customerId),
  }
}
