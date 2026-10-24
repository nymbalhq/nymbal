import { runEventBusContract } from '@nymbalhq/contract-tests'
import { createLogger, InProcessEventBus } from '@nymbalhq/platform'

// runEventBusContract from the published package on the in-process bus: the cases, the delivery contract and the
// health case. One process, so no `second` (named and unnamed are the same) and no dependency to lose, so no
// `unreachable`.

const make = async () =>
  new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'silent' }) })

runEventBusContract('in-process', make)
