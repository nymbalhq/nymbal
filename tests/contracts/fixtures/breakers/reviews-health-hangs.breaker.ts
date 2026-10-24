import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// The control's twin whose healthCheck never settles must fail the health case, and only it.
runReviewsContract('memory reviews, health hangs', () => memoryReviews({ healthHangs: true }))
