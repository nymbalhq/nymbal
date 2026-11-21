import { runTaxContract } from '../../packages/contract-tests/src/index.js'
import { createNativeTaxAdapter } from '../../packages/platform/src/adapters/tax/native-adapter.js'
import { createLogger } from '../../packages/platform/src/logger.js'
import { memoryTax, TAXED_SHIPPING } from './fixtures/breakers/memory-tax.js'

// AC-19, AC-27: the published tax suite runs on the native engine with a rate table that taxes shipping, and on a
// scripted provider that files documents (commit and refund) and taxes shipping. The half that says the suite can fail
// is in contract-breakers.test.ts (tax-*).

const logger = createLogger({ pretty: false, level: 'error' })

runTaxContract(
  'native',
  () =>
    createNativeTaxAdapter({
      logger,
      rates: [
        { country: 'GB', percent: 20, codes: { food: 0 }, taxShipping: true },
        { country: 'US', region: 'CA', percent: 7.25, taxShipping: true },
      ],
    }),
  { taxedShipping: { amountMinor: 499 } },
)

runTaxContract('scripted provider with commit and refund', () => memoryTax(), TAXED_SHIPPING)
