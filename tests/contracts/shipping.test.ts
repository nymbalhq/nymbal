import { runShippingContract } from '@nymbalhq/contract-tests'
import { createNativeShippingAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runShippingContract('native', () => createNativeShippingAdapter(logger))
