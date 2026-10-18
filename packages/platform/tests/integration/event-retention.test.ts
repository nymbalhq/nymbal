import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalEvent } from '@nymbalhq/types'
import { createCommandStore, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import { createEventBuilder } from '../../src/events/builder.js'
import { createLogger } from '../../src/logger.js'
import { buildRepositories, type Repositories } from '../../src/repositories/index.js'
import { startEventRetentionSweeper } from '../../src/sweepers/index.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import { TEST_BUILDER_CONTEXT } from '../support/publisher.js'
import { openRaw, type RawReader } from '../support/raw.js'

// P1-03 AC-8 on SQLite: the retention sweeper's tick() deletes delivered events and processed-event records older than
// the 30-day window, and nothing else: younger ones, undelivered ones and dead ones of any age stay. A second tick
// deletes nothing. The rows are dated through the repositories' `at` arguments (markDelivered, recordFailure,
// markProcessed), so the test does not depend on how a dialect stores a timestamp. No relay runs on this store.

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_DAYS = 30

type Kind = 'delivered' | 'undelivered' | 'dead'

let dir: string
let store: CommandStore
let repos: Repositories
let raw: RawReader
const logger = createLogger({ pretty: false, level: 'error' })
const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p1-03-retention-'))
  const sqlitePath = join(dir, 'store.sqlite')
  store = createCommandStore(kernelConfig('sqlite'), { sqlitePath })
  await runMigrations(store, { migrationsRoot: MIGRATIONS_ROOT })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  raw = openRaw('sqlite', sqlitePath)
})

afterAll(async () => {
  await raw?.close()
  await store?.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Ages either side of the window, never on its edge. */
const ageDays = fc.oneof(fc.integer({ min: 0, max: 29 }), fc.integer({ min: 31, max: 400 }))

function kept(kind: Kind, age: number): boolean {
  return kind !== 'delivered' || age < RETENTION_DAYS
}

describe('AC-8: retention', () => {
  it('AC-8: property: tick() deletes exactly the delivered events and processed records older than 30 days; undelivered and dead events of any age stay; a second tick deletes nothing (25 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            kind: fc.constantFrom<Kind>('delivered', 'undelivered', 'dead'),
            age: ageDays,
          }),
          {
            minLength: 1,
            maxLength: 8,
          },
        ),
        fc.array(ageDays, { minLength: 1, maxLength: 6 }),
        async (eventSpecs, processedAges) => {
          const now = Date.now()
          const events = eventSpecs.map((spec) => ({
            ...spec,
            event: makeEvent(
              'ac8.retention.v1',
              { n: randomUUID() },
              {
                timestamp: new Date(now - spec.age * DAY_MS),
              },
            ) as NymbalEvent<unknown>,
          }))
          const processed = processedAges.map((age) => ({
            age,
            handler: 'ac8:handler',
            eventId: randomUUID(),
          }))

          await store.transaction(async (tx) => {
            await repos.eventLog.append(
              tx,
              events.map((e) => e.event),
            )
            for (const e of events) {
              const at = new Date(now - e.age * DAY_MS)
              if (e.kind === 'delivered') await repos.eventLog.markDelivered(tx, [e.event.id], at)
              if (e.kind === 'dead') await repos.eventLog.recordFailure(tx, e.event.id, at, 1)
            }
            for (const p of processed) {
              await repos.processedEvent.markProcessed(
                tx,
                p.handler,
                p.eventId,
                new Date(now - p.age * DAY_MS),
              )
            }
          })

          const sweeper = startEventRetentionSweeper({
            store,
            eventLog: repos.eventLog,
            processedEvents: repos.processedEvent,
            logger,
            intervalMs: 3_600_000,
          })
          try {
            await sweeper.tick()

            const ids = events.map((e) => e.event.id)
            const remaining = new Set(
              (
                await raw.rows<{ id: string }>(
                  `SELECT id FROM events WHERE id IN (${ids.map(() => '?').join(', ')})`,
                  ids,
                )
              ).map((r) => r.id),
            )
            for (const e of events) {
              expect(remaining.has(e.event.id), `${e.kind} event aged ${e.age} days`).toBe(
                kept(e.kind, e.age),
              )
            }
            const seen = await store.read(async (tx) =>
              Promise.all(
                processed.map((p) => repos.processedEvent.seen(tx, p.handler, p.eventId)),
              ),
            )
            processed.forEach((p, i) => {
              expect(seen[i], `processed record aged ${p.age} days`).toBe(p.age < RETENTION_DAYS)
            })

            const afterFirst = {
              events: await raw.count('events'),
              processed: await raw.count('processed_events'),
            }
            await sweeper.tick()
            expect({
              events: await raw.count('events'),
              processed: await raw.count('processed_events'),
            }).toEqual(afterFirst)
          } finally {
            sweeper.stop()
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 60_000)
})
