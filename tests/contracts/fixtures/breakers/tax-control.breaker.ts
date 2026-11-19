import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax } from './memory-tax'

runTaxContract('memory tax', () => memoryTax())
