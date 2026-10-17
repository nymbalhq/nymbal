import { runEventBusContract } from '@nymbalhq/contract-tests'
import { InProcessEventBus } from '@nymbalhq/platform'
import { createLogger } from '@nymbalhq/platform'

runEventBusContract(() => new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'error' }) }))
