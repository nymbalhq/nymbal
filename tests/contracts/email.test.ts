import { runEmailContract } from '@nymbalhq/contract-tests'
import { createNativeEmailAdapter, createLogger } from '@nymbalhq/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runEmailContract('native-console', () =>
  createNativeEmailAdapter({ logger, config: { transport: 'console' } }),
)
