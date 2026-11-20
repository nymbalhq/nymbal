import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

// Money an order column cannot hold: a line's tax in half a unit. It must fail the suite.
runTaxContract('memory tax, a fractional amount', () => memoryTax({ fractionalAmount: true }), TAXED_SHIPPING)
