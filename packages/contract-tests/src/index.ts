import type { Slot } from '@nymbalhq/types'
import { runAnalyticsContract } from './analytics.js'
import type { Build } from './common.js'
import { runDocumentStoreContract } from './document-store.js'
import { runEmailContract } from './email.js'
import { runEventBusContract } from './event-bus.js'
import type { CONTRACT_KINDS } from './kinds.js'
import { runMediaStorageContract, type MediaStorageContractOptions } from './media-storage.js'
import { runPaymentsContract } from './payments.js'
import { runReviewsContract } from './reviews.js'
import { runSearchContract } from './search.js'
import { runShippingContract } from './shipping.js'
import { runTaxContract } from './tax.js'

export { adapterContext } from './adapter-context.js'
export { BOUND_MS, type Build, type ContractOptions } from './common.js'
export { CONTRACT_KINDS } from './kinds.js'
export { runDocumentStoreContract, type DocumentStoreContractOptions } from './document-store.js'
export { runEventBusContract, type EventBusContractOptions } from './event-bus.js'
export { runMediaStorageContract, type MediaStorageContractOptions } from './media-storage.js'
export { runPaymentsContract, type PaymentsContractOptions } from './payments.js'
export { runEmailContract } from './email.js'
export { runReviewsContract } from './reviews.js'
export { runSearchContract, type SearchContractOptions } from './search.js'
export {
  matchesQuery,
  searchTerms,
  toSearchDocument,
  type ContractProduct,
} from './search-oracle.js'
export { runAnalyticsContract } from './analytics.js'
export { runShippingContract } from './shipping.js'
export { runTaxContract } from './tax.js'
export { runWebhookContract, type WebhookContractOptions, type WebhookRequest } from './webhook.js'
export {
  runEmailFeedbackContract,
  type EmailFeedbackContractOptions,
  type EmailFeedbackSample,
} from './email-feedback.js'
export {
  runShippingTrackingContract,
  type ShippingTrackingContractOptions,
  type ShippingTrackingSample,
} from './shipping-tracking.js'
export { runSecurityContract } from './security.js'
export { runProjectionContract } from './projection.js'
export type { ProjectionContractOptions } from './projection.js'

/** What a suite certifies: a commerce slot or an infrastructure primitive. */
export type ContractKind = Slot

/** A kind's suite, as `nymbal test:contracts` calls it: `build` makes a fresh adapter for each case. */
export type ContractSuite = (
  name: string,
  build: Build<unknown>,
  options?: Record<string, unknown>,
) => void

/** A URL's bytes over HTTP: how a media storage's public URL is read back when the caller names no `fetchUrl`. */
async function fetchOverHttp(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

const suites = {
  payments: runPaymentsContract as ContractSuite,
  email: runEmailContract as ContractSuite,
  reviews: runReviewsContract as ContractSuite,
  search: runSearchContract as ContractSuite,
  analytics: runAnalyticsContract as ContractSuite,
  shipping: runShippingContract as ContractSuite,
  tax: runTaxContract as ContractSuite,
  documentStore: runDocumentStoreContract as ContractSuite,
  eventBus: runEventBusContract as ContractSuite,
  media: (name, build, options = {}) =>
    runMediaStorageContract(
      name,
      build as Parameters<typeof runMediaStorageContract>[1],
      {
        fetchUrl: fetchOverHttp,
        ...options,
      } as MediaStorageContractOptions,
    ),
} satisfies Record<(typeof CONTRACT_KINDS)[number], ContractSuite>

/** Each kind's suite, one for every kind in CONTRACT_KINDS. Each is typed here, at the CLI's boundary. */
export const contractSuites: Partial<Record<ContractKind, ContractSuite>> = suites
