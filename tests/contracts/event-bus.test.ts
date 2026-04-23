import { runEventBusContract } from '@nymbal/contract-tests'
import { InProcessEventBus } from '@nymbal/platform'
import { createLogger } from '@nymbal/platform'

runEventBusContract(() => new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'error' }) }))
