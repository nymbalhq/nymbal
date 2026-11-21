import { runPromotionsContract } from '@nymbalhq/contract-tests'
import { memoryPromotions } from './memory-promotions'

// A money effect a settlement would have to guess at: a fraction of a minor unit. It must fail the suite.
runPromotionsContract('memory promotions, fractional money', () =>
  memoryPromotions({ fractionalMoney: true }),
)
