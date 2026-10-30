// The client without its store namespaces: a page imports the `@nymbalhq/sdk/ns/<module>` of each store it reads.
export { createNymbalClient, onStoreBuilt } from './client.js'
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

export { NymbalApiError } from './adapter/fetch-client.js'
