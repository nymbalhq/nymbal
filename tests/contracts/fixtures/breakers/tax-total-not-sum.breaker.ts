import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax } from './memory-tax'

// A total the order's lines do not add up to: one more than their sum. It must fail the suite.
runTaxContract('memory tax, a total that is not the sum', () => memoryTax({ totalNotSum: true }))
