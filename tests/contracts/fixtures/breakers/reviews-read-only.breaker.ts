import { runReviewsContract } from '@nymbalhq/contract-tests'
import { seedMemoryReviews } from './memory-reviews'
import { readOnlyReviews } from './read-only-reviews'

// The control for the no-submit breaker: an adapter without submit that refuses submitReview passes every case of the
// published reviews suite, its reviews put in its store by `seed`.
runReviewsContract('memory reviews, read-only', () => readOnlyReviews(), { seed: seedMemoryReviews })
