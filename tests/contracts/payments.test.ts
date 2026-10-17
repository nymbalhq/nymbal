import { runPaymentsContract } from '@nymbalhq/contract-tests'
import { createNativeStubPaymentsAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runPaymentsContract(() => createNativeStubPaymentsAdapter({ logger }))
