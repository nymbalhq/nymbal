import { runReviewsContract } from '@nymbalhq/contract-tests'
import { seedMemoryReviews } from './memory-reviews'
import { readOnlyReviews } from './read-only-reviews'

// The read-only control's twin that reports no submit capability yet stores a submitted review must fail the submit
// case, and only it.
runReviewsContract(
  'memory reviews, no submit but stores',
  () => readOnlyReviews({ storesAnyway: true }),
  { seed: seedMemoryReviews },
)
