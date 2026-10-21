import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// P2-13 AC-5: the control's twin whose healthCheck never settles must fail the health case, and only it.
runReviewsContract('memory reviews, health hangs', () => memoryReviews({ healthHangs: true }))
