import { runSecurityContract } from '@nymbal/contract-tests'
import { createMiddlewareSecurityAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runSecurityContract(() => createMiddlewareSecurityAdapter({ logger }))
