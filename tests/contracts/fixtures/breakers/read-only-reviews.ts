import { ReviewRefusedError, type ReviewsAdapter } from '@nymbalhq/types'
import { memoryReviews } from './memory-reviews'

// A reviews adapter for a provider that takes no review from the store's site (it collects them by invitation or on
// its own pages): its capabilities lack `submit`, its reviews arrive by `seedMemoryReviews`, and it refuses
// submitReview as the kernel's slot says. Its defective twin reports the same capabilities yet stores what it is given.

export function readOnlyReviews(flaws: { storesAnyway?: boolean } = {}): ReviewsAdapter {
  const memory = memoryReviews()
  return {
    ...memory,
    providerName: 'contracts-read-only-reviews',
    capabilities: () => ['aggregate', 'widget'],
    submitReview:
      flaws.storesAnyway === true
        ? memory.submitReview
        : async () => {
            throw new ReviewRefusedError('submit_unsupported')
          },
  }
}
