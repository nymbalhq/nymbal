import { runSecurityContract } from '@nymbalhq/contract-tests'
import { createMiddlewareSecurityAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runSecurityContract('middleware', () => createMiddlewareSecurityAdapter({ logger }))
