import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

runTaxContract('memory tax', () => memoryTax(), TAXED_SHIPPING)
