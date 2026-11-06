import { runReviewsContract } from '@nymbalhq/contract-tests'
import { memoryReviews } from './memory-reviews'

// The control's twin that files a submitted review without its customer and order must fail the submit case, and
// only it.
runReviewsContract('memory reviews, identity dropped', () => memoryReviews({ dropsIdentity: true }))
