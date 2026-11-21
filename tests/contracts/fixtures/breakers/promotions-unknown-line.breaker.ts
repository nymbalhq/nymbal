import { runPromotionsContract } from '@nymbalhq/contract-tests'
import { memoryPromotions } from './memory-promotions'

// A line effect for a line the session does not have. It must fail the suite.
runPromotionsContract('memory promotions, unknown line', () =>
  memoryPromotions({ unknownLine: true }),
)
