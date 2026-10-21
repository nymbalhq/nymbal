import { runEventBusContract } from '@nymbalhq/contract-tests'
import { createLogger, InProcessEventBus } from '@nymbalhq/platform'

// P2-02 AC-3 on the in-process bus (spec P2-02-primitives-are-protocols), and P2-13 AC-2 (spec
// P2-13-contract-tests-public): runEventBusContract from the published package runs the old cases and the delivery
// contract that moved into it (decision 2), plus the health case. One process, so no `second` (named and unnamed are
// the same) and no dependency to lose, so no `unreachable`.

const make = async () =>
  new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'silent' }) })

runEventBusContract('in-process', make)
