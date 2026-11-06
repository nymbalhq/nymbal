// The client without its store namespaces: a page imports the `@nymbalhq/sdk/ns/<module>` of each store it reads.
export { createNymbalClient, onStoreBuilt, resumeSession } from './client.js'
export type {
  NymbalClient,
  NymbalClientOptions,
  CustomerAccount,
  GuestOrders,
  RecentlyViewed,
  StoreCapabilitiesReader,
} from './client.js'

export { registerPaymentDriver, getPaymentDriver } from './payment-drivers.js'
export type {
  PaymentDriver,
  PaymentConfirmation,
  PaymentConfirmContext,
} from './payment-drivers.js'

export { SESSION_HINT_KEY } from './auth/session.js'
export { NymbalApiError } from './adapter/fetch-client.js'
