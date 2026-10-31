import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EVT_CART_UPDATED, type EventBusAdapter, type NymbalEvent } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import {
  createCommandStore,
  rawClients,
  sqliteTurn,
  type CommandStore,
} from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import type { EventLogRepository } from '../repositories/event-log.js'
import { createLogger } from '../logger.js'
import { TEST_BUILDER_CONTEXT } from '../tests/publisher.js'
import { createEventBuilder } from './builder.js'
import type { OutageReport } from './outage.js'
import { createRelay } from './relay.js'

// The relay under an outage probe: a delivery that fails while the probe reports an outage leaves the event's attempts
// and dead_at alone and waits as the next counted failure would, and each pass that found the outage logs one line
// naming every down subject (AC-1); once the probe reports none, failures count as they always have. The probe is
// asked at most once a pass, a probe that throws or never settles is an outage, and neither holds the pass or stop()
// (AC-2). The bus is a stub whose publish rejects; the events row is read on the store's own connection.

const START = Date.parse('2026-03-01T09:00:00.000Z')
const HEALTHY: OutageReport = { outage: false, down: [] }

let store: CommandStore
let eventLog: EventLogRepository
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'relay', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  eventLog = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })).eventLog
})

afterAll(async () => {
  await store?.close()
})

interface Row {
  attempts: number
  deadAt: string | null
  retryAt: number | null
  delivered: boolean
}

function sqlite() {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('expected a SQLite store')
  return clients.raw
}

async function rowOf(id: string): Promise<Row> {
  const row = await sqliteTurn(
    sqlite(),
    () =>
      sqlite()
        .prepare('SELECT attempts, dead_at, retry_at, delivered_at FROM events WHERE id = ?')
        .get(id) as {
        attempts: number
        dead_at: string | null
        retry_at: string | null
        delivered_at: string | null
      },
  )
  return {
    attempts: Number(row.attempts),
    deadAt: row.dead_at,
    retryAt: row.retry_at === null ? null : Date.parse(row.retry_at),
    delivered: row.delivered_at !== null,
  }
}

/** Takes every open row out of the log, so a pass sees only what the test appends next. */
async function settleEarlierRows(): Promise<void> {
  await sqliteTurn(sqlite(), () =>
    sqlite()
      .prepare('UPDATE events SET delivered_at = ? WHERE delivered_at IS NULL AND dead_at IS NULL')
      .run(new Date(START).toISOString()),
  )
}

async function append(n: number): Promise<string[]> {
  const events = Array.from({ length: n }, (_, i) =>
    makeEvent(EVT_CART_UPDATED, { cartId: `cart-${i}`, itemCount: i, totalMinor: 0 }),
  )
  await store.transaction((tx) => eventLog.append(tx, events))
  return events.map((e) => e.id)
}

interface Harness {
  clock: { at: number }
  /** Ids handed to the bus, one entry per attempt. */
  published: string[]
  lines: string[]
  bus: EventBusAdapter
}

function harness(): Harness {
  const published: string[] = []
  const bus = {
    async publish(event: NymbalEvent<unknown>) {
      published.push(event.id)
      throw new Error('the bus refused the event')
    },
  } as unknown as EventBusAdapter
  return { clock: { at: START }, published, lines: [], bus }
}

function loggerOf(lines: string[]) {
  return createLogger({
    pretty: false,
    level: 'warn',
    destination: { write: (line: string) => void lines.push(line) },
  })
}

/** The relay's warn lines that report an outage, by message. */
function outageLines(lines: string[]): string[] {
  return lines
    .map((line) => JSON.parse(line) as { level: number; msg?: string })
    .filter((e) => e.level === 40 && (e.msg ?? '').startsWith('outage:'))
    .map((e) => e.msg!)
}

const outageMessage = (report: OutageReport) =>
  `outage: ${report.down.map((d: { name: string; detail: string }) => `${d.name} (${d.detail})`).join(', ')}`

const subject = fc.record({
  name: fc.constantFrom(
    'payments',
    'email',
    'shipping',
    'search',
    'media',
    'eventBus',
    'documentStore',
  ),
  detail: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 :.-]{0,30}$/),
})

describe('AC-1: failures during an outage are not counted', () => {
  it('AC-1: property: with the probe reporting an outage, k failed deliveries (k from 1 to 3 × maxAttempts, after h counted ones) leave attempts and dead_at as they were and set retry_at to the failure time + retryDelayMs × 2^attempts, each pass logging one warn line naming every down subject with its detail; once the probe reports none, failures count, back off and reach dead at maxAttempts with no outage line, and a dead event is never handed to the bus again', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 1, max: 3_600_000 }),
        fc.nat(),
        fc.nat(),
        fc.uniqueArray(subject, { minLength: 1, maxLength: 3, selector: (s) => s.name }),
        async (maxAttempts, retryDelayMs, hSeed, kSeed, down) => {
          const h = hSeed % maxAttempts
          const k = 1 + (kSeed % (3 * maxAttempts))
          const outage: OutageReport = { outage: true, down }
          let report = HEALTHY
          const t = harness()
          await settleEarlierRows()
          const relay = createRelay({
            store,
            eventLog,
            eventBus: t.bus,
            logger: loggerOf(t.lines),
            maxAttempts,
            retryDelayMs,
            now: () => new Date(t.clock.at),
            outage: async () => report,
          })
          const [id] = await append(1)

          // h failures counted as a healthy relay counts them, to start the outage from a non-zero attempts.
          for (let failure = 1; failure <= h; failure += 1) {
            await relay.drain()
            const row = await rowOf(id!)
            expect(row.attempts).toBe(failure)
            t.clock.at = row.retryAt!
          }

          report = outage
          for (let failure = 1; failure <= k; failure += 1) {
            const handed = t.published.length
            const failedAt = t.clock.at
            await relay.drain()
            const row = await rowOf(id!)
            expect(t.published.length, 'the event was handed to the bus again').toBe(handed + 1)
            expect(
              [row.attempts, row.deadAt, row.delivered],
              `attempts, dead_at and delivered after outage failure ${failure} of ${k}`,
            ).toEqual([h, null, false])
            expect(row.retryAt).toBe(failedAt + retryDelayMs * 2 ** h)
            expect(outageLines(t.lines)).toEqual(Array(failure).fill(outageMessage(outage)))
            t.clock.at = row.retryAt!
          }

          report = HEALTHY
          for (let attempts = h + 1; attempts <= maxAttempts; attempts += 1) {
            const failedAt = t.clock.at
            await relay.drain()
            const row = await rowOf(id!)
            expect(row.attempts).toBe(attempts)
            expect(row.deadAt !== null, `dead after ${attempts} of ${maxAttempts}`).toBe(
              attempts === maxAttempts,
            )
            // A dead event waits for nothing; every other failure waits retryDelayMs × 2^(attempts − 1).
            const waits = attempts < maxAttempts
            expect(waits ? row.retryAt : null).toBe(
              waits ? failedAt + retryDelayMs * 2 ** (attempts - 1) : null,
            )
            t.clock.at = row.retryAt ?? t.clock.at
          }
          expect(outageLines(t.lines).length, 'outage lines once the probe is healthy').toBe(k)

          const handed = t.published.length
          t.clock.at += 1000 * retryDelayMs * 2 ** maxAttempts
          await relay.drain()
          expect(t.published.length, 'a dead event was handed to the bus').toBe(handed)
        },
      ),
      { numRuns: 40 },
    )
  })
})

describe('AC-2: the probe is bounded', () => {
  it('AC-2: a pass over 150 failing events (two pages) asks the probe once and logs one outage line, leaving every one uncounted; the next pass asks it once more', async () => {
    const t = harness()
    await settleEarlierRows()
    let asked = 0
    const down = [{ name: 'documentStore', detail: 'redis: connect ECONNREFUSED' }]
    const relay = createRelay({
      store,
      eventLog,
      eventBus: t.bus,
      logger: loggerOf(t.lines),
      maxAttempts: 1,
      retryDelayMs: 1000,
      now: () => new Date(t.clock.at),
      outage: async () => {
        asked += 1
        return { outage: true, down }
      },
    })
    const ids = await append(150)

    await relay.drain()
    expect(t.published.length, 'deliveries in the pass').toBe(ids.length)
    expect(asked, 'probes in one pass').toBe(1)
    expect(outageLines(t.lines).length).toBe(asked)
    const rows = await Promise.all(ids.map(rowOf))
    expect(rows.filter((r) => r.attempts !== 0 || r.deadAt !== null).length).toBe(0)

    t.clock.at += 1000
    await relay.drain()
    expect(t.published.length).toBe(2 * ids.length)
    expect(asked, 'probes in two passes').toBe(2)
  })

  it('AC-2: a probe that throws is an outage: the failure is not counted (maxAttempts 1 leaves the event alive) and the pass finishes', async () => {
    const t = harness()
    await settleEarlierRows()
    const relay = createRelay({
      store,
      eventLog,
      eventBus: t.bus,
      logger: loggerOf(t.lines),
      maxAttempts: 1,
      retryDelayMs: 500,
      now: () => new Date(t.clock.at),
      outage: async () => {
        throw new Error('the probe itself failed')
      },
    })
    const [id] = await append(1)

    await relay.drain()

    expect(t.published).toEqual([id])
    const row = await rowOf(id!)
    expect([row.attempts, row.deadAt]).toEqual([0, null])
    expect(row.retryAt).toBe(t.clock.at + 500)
  })

  it('AC-2: a probe that never settles is an outage once outageTimeoutMs (50 ms) passes: the pass finishes, the failure is not counted, and the line names the probe and the bound', async () => {
    const t = harness()
    await settleEarlierRows()
    const relay = createRelay({
      store,
      eventLog,
      eventBus: t.bus,
      logger: loggerOf(t.lines),
      maxAttempts: 1,
      retryDelayMs: 500,
      now: () => new Date(t.clock.at),
      outage: () => new Promise<OutageReport>(() => undefined),
      outageTimeoutMs: 50,
    })
    const [id] = await append(1)

    const outcome = await settleWithin(relay.drain(), 3000)

    expect(outcome).toBe('resolved')
    const row = await rowOf(id!)
    expect([row.attempts, row.deadAt]).toEqual([0, null])
    expect(row.retryAt).toBe(t.clock.at + 500)
    expect(outageLines(t.lines)).toEqual(['outage: probe (timed out after 50 ms)'])
  })

  it('AC-2: relay.stop() called while a pass waits on a probe that never settles resolves once outageTimeoutMs passes', async () => {
    const t = harness()
    await settleEarlierRows()
    let asked = 0
    const relay = createRelay({
      store,
      eventLog,
      eventBus: t.bus,
      logger: loggerOf(t.lines),
      maxAttempts: 1,
      retryDelayMs: 500,
      now: () => new Date(t.clock.at),
      outage: () => {
        asked += 1
        return new Promise<OutageReport>(() => undefined)
      },
      outageTimeoutMs: 50,
    })
    const [id] = await append(1)

    const pass = relay.drain()
    await vi.waitFor(() => expect(asked, 'the pass is waiting on the probe').toBe(1), {
      timeout: 2000,
      interval: 5,
    })
    const [stopped, drained] = await Promise.all([
      settleWithin(relay.stop(), 3000),
      settleWithin(pass, 3000),
    ])

    expect([stopped, drained]).toEqual(['resolved', 'resolved'])
    expect((await rowOf(id!)).deadAt).toBe(null)
  })
})

/** How `call` settled within `ms`: `hung` when it had not. */
async function settleWithin(
  call: Promise<unknown>,
  ms: number,
): Promise<'resolved' | 'rejected' | 'hung'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'hung'>((resolve) => {
        timer = setTimeout(() => resolve('hung'), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
