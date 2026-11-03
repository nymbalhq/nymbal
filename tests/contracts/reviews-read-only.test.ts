import { runReviewsContract } from '@nymbalhq/contract-tests'
import { seedMemoryReviews } from './fixtures/breakers/memory-reviews'
import { readOnlyReviews } from './fixtures/breakers/read-only-reviews'

// A store whose reviews provider takes no on-site reviews can certify its adapter: the published reviews suite, given
// `seed`, is green on an in-memory adapter whose capabilities lack submit and which refuses submitReview with
// ReviewRefusedError reviews.submit_unsupported.
runReviewsContract('read-only memory reviews', () => readOnlyReviews(), { seed: seedMemoryReviews })
