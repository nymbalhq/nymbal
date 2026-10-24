import { runTaxContract } from '@nymbalhq/contract-tests'
import { createNativeTaxAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runTaxContract('native', () => createNativeTaxAdapter(logger, 0.2))
