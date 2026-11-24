import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

// Quotes that name another provider than the adapter's own: the kernel would never file an order it quoted. It must
// fail the suite.
runTaxContract(
  'memory tax, a quote naming another provider',
  () => memoryTax({ namesOtherProvider: true }),
  TAXED_SHIPPING,
)
