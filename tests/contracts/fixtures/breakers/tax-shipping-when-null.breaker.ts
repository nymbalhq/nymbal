import { runTaxContract } from '@nymbalhq/contract-tests'
import { memoryTax, TAXED_SHIPPING } from './memory-tax'

// Tax on a delivery the request never sent: an order charged tax on shipping it does not have. It must fail the suite.
runTaxContract(
  'memory tax, taxes shipping that was not sent',
  () => memoryTax({ shippingWhenNull: true }),
  TAXED_SHIPPING,
)
