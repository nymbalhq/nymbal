import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runEventBusContract } from '@nymbalhq/contract-tests'
import { createLogger, InProcessEventBus } from '@nymbalhq/platform'
import type { Logger } from '@nymbalhq/types'

// runEventBusContract from the published package on the in-process bus: the cases, the delivery contract, the
// handler-failure cases and the health case. One process, so no `second` (named and unnamed are the same) and no
// dependency to lose, so no `unreachable`. Beside it, what the bus logs for an unnamed handler's throw: the contract
// cannot read an adapter's logger, so this runner does.

const make = async () =>
  new InProcessEventBus({ logger: createLogger({ pretty: false, level: 'silent' }) })

runEventBusContract('in-process', make)

function keeping(logged: unknown[][]): Logger {
  const logger: Logger = {
    trace: (...args) => void logged.push(args),
    debug: (...args) => void logged.push(args),
    info: (...args) => void logged.push(args),
    warn: (...args) => void logged.push(args),
    error: (...args) => void logged.push(args),
    child: () => logger,
  }
  return logger
}

describe('in-process bus: an unnamed handler failure', () => {
  it('AC-1: a throwing unnamed handler leaves each of two publishes resolved, the named handler beside it handled each event once, and for each exactly one log line names the unnamed subscription and that event', async () => {
    const logged: unknown[][] = []
    const bus = new InProcessEventBus({ logger: keeping(logged) })
    try {
      const type = 'contract.failure-unnamed.v1'
      const named: string[] = []
      await bus.subscribe(type, async (e) => void named.push(e.id), { name: 'contract-named' })
      const tab = await bus.subscribe(type, async () => {
        throw new Error('contract admin tab refused')
      })
      const events = [0, 1].map(() => ({
        id: `evt-${randomUUID()}`,
        type,
        timestamp: new Date().toISOString(),
        source: 'contract-failure',
        correlationId: `corr-${randomUUID()}`,
        payload: {},
        metadata: { storeId: 'contract', environment: 'development' as const, version: '0.0.0' },
      }))

      for (const e of events) await expect(bus.publish(e)).resolves.toBeUndefined()

      expect(named).toEqual(events.map((e) => e.id))
      const lines = logged.map((args) => JSON.stringify(args))
      for (const e of events) {
        const naming = lines.filter((text) => text.includes(tab.id) && text.includes(e.id))
        expect(naming, `log lines naming the unnamed subscription and ${e.id}`).toHaveLength(1)
      }
    } finally {
      await bus.close()
    }
  })
})
