import { runEventBusContract } from '@nymbalhq/contract-tests'
import { createLogger, InProcessEventBus } from '@nymbalhq/platform'
import { eventBusAcceptance } from './suites/event-bus'

// P2-02 AC-3 on the in-process bus (spec P2-02-primitives-are-protocols): the extended runEventBusContract and the
// delivery contract of decision 3 (./suites/event-bus.ts). One process, so no `second`: named and unnamed are the same.

const make = async () =>
  new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'silent' }) })

runEventBusContract('in-process', make)
eventBusAcceptance('in-process', make)
