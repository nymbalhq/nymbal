import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// P2-13 AC-3: the control's twin that ignores the cursor must fail the pagination case, and only it.
runReviewsContract('memory reviews, cursor ignored', () => memoryReviews({ ignoreCursor: true }))
