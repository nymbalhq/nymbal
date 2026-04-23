import { runTaxContract } from '@nymbal/contract-tests'
import { createNativeTaxAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runTaxContract(() => createNativeTaxAdapter(logger, 0.2))
