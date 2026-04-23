import { runPaymentsContract } from '@nymbal/contract-tests'
import { createNativeStubPaymentsAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runPaymentsContract(() => createNativeStubPaymentsAdapter({ logger }))
