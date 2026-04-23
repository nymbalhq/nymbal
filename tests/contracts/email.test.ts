import { runEmailContract } from '@nymbal/contract-tests'
import { createNativeEmailAdapter, createLogger } from '@nymbal/platform'

const logger = createLogger({ pretty: false, level: 'error' })
runEmailContract(() => createNativeEmailAdapter({ logger, config: { transport: 'console' } }))
