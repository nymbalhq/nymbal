import { runShippingContract } from '@nymbal/contract-tests'
import { createNativeShippingAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runShippingContract(() => createNativeShippingAdapter(logger))
