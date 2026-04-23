import { runAnalyticsContract } from '@nymbal/contract-tests'
import { createNativeAnalyticsAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runAnalyticsContract(() => createNativeAnalyticsAdapter(logger))
