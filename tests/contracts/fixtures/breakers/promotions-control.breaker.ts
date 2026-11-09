import { runPromotionsContract } from '@nymbalhq/contract-tests'
import { memoryPromotions } from './memory-promotions'

runPromotionsContract('memory promotions', () => memoryPromotions())
