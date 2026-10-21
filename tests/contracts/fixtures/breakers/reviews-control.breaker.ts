import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// The control for the reviews breakers: a correct in-memory adapter passes every case of the published reviews suite.
runReviewsContract('memory reviews', () => memoryReviews())
