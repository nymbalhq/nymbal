import type { StoreCapabilities } from '@nymbalhq/sdk'

/** The review form only where the store's reviews adapter takes reviews on the site (`submit`). */
export function acceptsReviews(capabilities: StoreCapabilities | null | undefined): boolean {
  return capabilities?.reviews?.capabilities.includes('submit') === true
}
