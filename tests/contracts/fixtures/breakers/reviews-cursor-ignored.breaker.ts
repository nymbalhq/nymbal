import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// The control's twin that ignores the cursor must fail the pagination case, and only it.
runReviewsContract('memory reviews, cursor ignored', () => memoryReviews({ ignoreCursor: true }))
