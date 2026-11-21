import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

// A quote the kernel cannot put on the order's lines: the first line answered twice, the second lost. It must fail.
runTaxContract('memory tax, a repeated line id', () => memoryTax({ repeatedLineId: true }), TAXED_SHIPPING)
