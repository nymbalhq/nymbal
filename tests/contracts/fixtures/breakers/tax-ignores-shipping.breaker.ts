import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

// No tax on delivery, whatever was sent: a provider that under-collects on every shipped order. It must fail the suite.
runTaxContract(
  'memory tax, ignores shipping',
  () => memoryTax({ ignoresShipping: true }),
  TAXED_SHIPPING,
)
