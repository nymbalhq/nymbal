import { runAnalyticsContract } from '@nymbalhq/contract-tests'
import { createNativeAnalyticsAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runAnalyticsContract('native', () => createNativeAnalyticsAdapter(logger))
