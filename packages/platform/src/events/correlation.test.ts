import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_UPDATED } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createLogger } from '../logger.js'
import type { EventPublisher } from './publisher.js'
import { currentCorrelationId, isValidCorrelationId, runWithCorrelation } from './correlation.js'

// The unit half of AC-2 and AC-3: the correlation scope and the inbound-id rule. The HTTP halves are
// packages/platform/tests/integration/correlation-http.test.ts.

const DECISION_3 = /^[A-Za-z0-9._:-]{1,128}$/

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

let store: CommandStore
let publisher: EventPublisher

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'events', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store, eventLog: repos.eventLog, eventBus: new InProcessEventBus({ logger }), logger },
  ).publisher
})

afterAll(async () => {
  await store?.close()
})

const payload = { cartId: 'c', itemCount: 0, totalMinor: 0 }

describe('AC-3: isValidCorrelationId', () => {
  it('AC-3: property: over arbitrary strings, and over strings near the pattern, isValidCorrelationId(s) is exactly ^[A-Za-z0-9._:-]{1,128}$', () => {
    const near = fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9._:-]{0,130}$/),
      fc
        .tuple(
          fc.stringMatching(/^[A-Za-z0-9._:-]{0,64}$/),
          fc.constantFrom(' ', '\n', '\r', '\t', '<', '>', '/', 'é', '\u0000', '😀', '"'),
          fc.stringMatching(/^[A-Za-z0-9._:-]{0,64}$/),
        )
        .map(([a, bad, b]) => `${a}${bad}${b}`),
    )
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 140 }), near), (s) => {
        expect(isValidCorrelationId(s), JSON.stringify(s)).toBe(DECISION_3.test(s))
      }),
      { numRuns: 500 },
    )
  })

  it('AC-3: the edges: 128 characters is valid and 129 is not; empty, a space, a newline, <script> and non-ASCII are not', () => {
    const edge = ['a'.repeat(128), 'a'.repeat(129), '', 'a b', 'a\nb', '<script>', 'café']
    expect(edge.map(isValidCorrelationId)).toEqual(edge.map((s) => DECISION_3.test(s)))
    expect(isValidCorrelationId('a'.repeat(128))).toBe(true)
  })
})

describe('AC-2: the correlation scope', () => {
  it('AC-2: property: concurrent scopes each see their own id after every await, and none is visible outside them', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{4,12}$/), { minLength: 2, maxLength: 8 }),
        fc.array(fc.nat({ max: 4 }), { minLength: 8, maxLength: 8 }),
        async (ids, awaits) => {
          const seen: Array<Array<string | undefined>> = await Promise.all(
            ids.map((id, i) =>
              runWithCorrelation(id, async () => {
                const views: Array<string | undefined> = [currentCorrelationId()]
                for (let n = 0; n < awaits[i]! + 1; n += 1) {
                  await tick()
                  views.push(currentCorrelationId())
                }
                return views
              }),
            ),
          )
          seen.forEach((views, i) => {
            expect(new Set(views), `scope ${ids[i]}`).toEqual(new Set([ids[i]!]))
          })
          expect(currentCorrelationId()).toBeUndefined()
        },
      ),
      { numRuns: 50 },
    )
  })

  it('AC-2: runWithCorrelation returns what its function returns', async () => {
    const id = `ret-${Date.now()}`
    expect(runWithCorrelation(id, () => `${currentCorrelationId()}!`)).toBe(`${id}!`)
    await expect(runWithCorrelation(id, async () => currentCorrelationId())).resolves.toBe(id)
  })

  it('AC-2: a publish inside a scope carries the scope’s id; an explicit correlationId wins over a correlated() publisher’s, which wins over the scope’s; outside any scope the event is its own id', async () => {
    const scope = `scope-${Date.now()}`
    const bound = `bound-${Date.now()}`
    const explicit = `explicit-${Date.now()}`
    const [inScope, boundInScope, explicitInScope] = await runWithCorrelation(scope, async () => [
      await publisher.publish(EVT_CART_UPDATED, payload),
      await publisher.correlated(bound).publish(EVT_CART_UPDATED, payload),
      await publisher.correlated(bound).publish(EVT_CART_UPDATED, payload, {
        correlationId: explicit,
      }),
    ])
    const outside = await publisher.publish(EVT_CART_UPDATED, payload)

    expect([
      inScope!.correlationId,
      boundInScope!.correlationId,
      explicitInScope!.correlationId,
    ]).toEqual([scope, bound, explicit])
    expect(outside.correlationId).toBe(outside.id)
  })
})
