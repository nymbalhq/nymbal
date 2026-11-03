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
import { startEventRetentionSweeper, type EventArchiveWriter } from '../../src/sweepers/index.js'
import { kernelConfig, MIGRATIONS_ROOT } from '../support/kernel.js'
import { TEST_BUILDER_CONTEXT } from '../../src/tests/publisher.js'
import { openRaw, type RawReader } from '../support/raw.js'

// AC-8 on SQLite: the retention sweeper's tick() deletes delivered events and processed-event records older than the
// 30-day window, and nothing else: younger ones, undelivered ones and dead ones of any age stay. A second tick deletes
// nothing. The rows are dated through the repositories' `at` arguments (markDelivered, recordFailure, markProcessed),
// so the test does not depend on how a dialect stores a timestamp. No relay runs on this store.

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
  dir = mkdtempSync(join(tmpdir(), 'outbox-retention-'))
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

type Mark = 'delivered' | 'undelivered' | 'dead' | 'delivered-and-dead'

/** A store of its own on a file beside the shared one, swept by a sweeper with `archive` or without. */
async function sweptStore(name: string, archive?: EventArchiveWriter) {
  const sqlitePath = join(dir, `${name}.sqlite`)
  const own = createCommandStore(kernelConfig('sqlite'), { sqlitePath })
  await runMigrations(own, { migrationsRoot: MIGRATIONS_ROOT })
  const ownRepos = buildRepositories(own, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const ownRaw = openRaw('sqlite', sqlitePath)
  const sweeper = startEventRetentionSweeper({
    store: own,
    eventLog: ownRepos.eventLog,
    processedEvents: ownRepos.processedEvent,
    logger,
    intervalMs: 3_600_000,
    ...(archive !== undefined && { archive }),
  })
  return {
    store: own,
    repos: ownRepos,
    raw: ownRaw,
    sweeper,
    async close() {
      sweeper.stop()
      await ownRaw.close()
      await own.close()
    },
  }
}

describe('retention by either path', () => {
  let plain: Awaited<ReturnType<typeof sweptStore>>
  let archived: Awaited<ReturnType<typeof sweptStore>>
  const objects = new Map<string, Uint8Array>()

  beforeAll(async () => {
    plain = await sweptStore('plain')
    archived = await sweptStore('archived', {
      async put(key, body) {
        objects.set(key, body)
      },
    })
  })

  afterAll(async () => {
    await plain?.close()
    await archived?.close()
  })

  it('AC-6: property: over random logs of delivered, undelivered, dead and delivered-and-dead events of random ages, a tick with no archive and a tick with an archive each delete exactly the delivered, not-dead events delivered more than 30 days ago, leave the same rows as each other, and a second tick deletes nothing (25 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            mark: fc.constantFrom<Mark>('delivered', 'undelivered', 'dead', 'delivered-and-dead'),
            age: ageDays,
            deadAge: ageDays,
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (specs) => {
          const now = Date.now()
          const events = specs.map(
            (spec) =>
              makeEvent(
                'ac6.retention.v1',
                { n: randomUUID() },
                { timestamp: new Date(now - spec.age * DAY_MS) },
              ) as NymbalEvent<unknown>,
          )
          const goes = (spec: (typeof specs)[number]): boolean =>
            spec.mark === 'delivered' && spec.age > RETENTION_DAYS
          const ids = events.map((e) => e.id)

          const leftBy: Record<string, boolean[]> = {}
          for (const [name, swept] of [
            ['no archive', plain],
            ['archive', archived],
          ] as const) {
            await swept.store.transaction(async (tx) => {
              await swept.repos.eventLog.append(tx, events)
              for (const [i, spec] of specs.entries()) {
                const id = events[i]!.id
                if (spec.mark === 'delivered' || spec.mark === 'delivered-and-dead') {
                  await swept.repos.eventLog.markDelivered(
                    tx,
                    [id],
                    new Date(now - spec.age * DAY_MS),
                  )
                }
                if (spec.mark === 'dead' || spec.mark === 'delivered-and-dead') {
                  await swept.repos.eventLog.recordFailure(
                    tx,
                    id,
                    new Date(now - spec.deadAge * DAY_MS),
                    1,
                  )
                }
              }
            })
            await swept.sweeper.tick()
            const remaining = new Set(
              (
                await swept.raw.rows<{ id: string }>(
                  `SELECT id FROM events WHERE id IN (${ids.map(() => '?').join(', ')})`,
                  ids,
                )
              ).map((r) => r.id),
            )
            leftBy[name] = ids.map((id) => remaining.has(id))

            const afterFirst = await swept.raw.count('events')
            await swept.sweeper.tick()
            expect(await swept.raw.count('events'), `${name}: events after a second tick`).toBe(
              afterFirst,
            )
          }

          const label = JSON.stringify(specs)
          expect(leftBy['no archive'], `no archive: kept, ${label}`).toEqual(
            specs.map((spec) => !goes(spec)),
          )
          expect(leftBy['archive'], `archive: kept, ${label}`).toEqual(
            specs.map((spec) => !goes(spec)),
          )
          expect(leftBy['no archive'], `the two paths, ${label}`).toEqual(leftBy['archive'])
        },
      ),
      {
        numRuns: 25,
        examples: [
          [
            [
              { mark: 'delivered-and-dead', age: 45, deadAge: 44 },
              { mark: 'delivered', age: 45, deadAge: 0 },
              { mark: 'delivered-and-dead', age: 3, deadAge: 3 },
            ],
          ],
        ],
      },
    )
  }, 60_000)
})
