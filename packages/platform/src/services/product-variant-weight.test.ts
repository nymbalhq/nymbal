import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EVT_PRODUCT_UPDATED,
  EVT_PRODUCT_VARIANT_PRICE_CHANGED,
  type Variant,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'

// A variant's weight on a product update: an entry that names its stored price and a weight stores that weight (none
// to clear it, left out to keep it), and a weight is not a price: it raises no price alert. A weight dropped because
// the entry's prices did not change is a Save that reports success and stores nothing.

interface Seen {
  type: string
  payload: Record<string, unknown>
}

async function setup() {
  const config = {
    infrastructure: { commandStore: 'sqlite' as const },
    store: { name: 'test', currency: 'GBP' },
  }
  const commandStore = createCommandStore(
    // @ts-expect-error: the command store reads only its infrastructure and store
    config,
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const { publisher, relay } = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  )
  const service = createProductService({
    store: commandStore,
    repos,
    publisher,
    logger,
    currency: 'GBP',
  })
  const seen: Seen[] = []
  await eventBus.subscribe([EVT_PRODUCT_VARIANT_PRICE_CHANGED, EVT_PRODUCT_UPDATED], (event) => {
    seen.push({ type: event.type, payload: event.payload as Record<string, unknown> })
  })
  /** The events delivered since the last call. */
  const drained = async (): Promise<Seen[]> => {
    await relay.drain()
    return seen.splice(0)
  }
  return { service, commandStore, drained }
}

const priceEvents = (events: Seen[]) =>
  events.filter((e) => e.type === EVT_PRODUCT_VARIANT_PRICE_CHANGED)
const updatedSnapshots = (events: Seen[]) =>
  events
    .filter((e) => e.type === EVT_PRODUCT_UPDATED)
    .map((e) => e.payload['product'] as { variants: Variant[] })

type Choice = { kind: 'omit' } | { kind: 'clear' } | { kind: 'set'; grams: number }

const gramsArb = fc.integer({ min: 0, max: 1_000_000 })
const choiceArb: fc.Arbitrary<Choice> = fc.oneof(
  fc.constant<Choice>({ kind: 'omit' }),
  fc.constant<Choice>({ kind: 'clear' }),
  gramsArb.map((grams): Choice => ({ kind: 'set', grams })),
)
const variantArb = fc.record({
  stored: fc.option(gramsArb, { nil: null }),
  priceMinor: fc.integer({ min: 0, max: 100_000 }),
  compareAtPriceMinor: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: null }),
  choice: choiceArb,
})

describe('a variant’s weight on a product update', () => {
  // Kills: an entry whose prices are unchanged skipped before its weight is written, a null read as "keep", an
  // omitted weight read as a clear, or a weight change published as a price change.
  it('AC-1: property: for 1-3 variants each left at its stored prices with a weight omitted, cleared or set to 0..1,000,000 g, update stores exactly the chosen weights (omitted keeps the stored one), changes no price, and publishes one product.updated carrying those weights and no price event', async () => {
    const { service, commandStore, drained } = await setup()
    let made = 0

    await fc.assert(
      fc.asyncProperty(fc.array(variantArb, { minLength: 1, maxLength: 3 }), async (rows) => {
        made += 1
        const created = await service.create({
          slug: `weighed-${made}`,
          name: `Weighed ${made}`,
          variants: rows.map((r, i) => ({
            sku: `W-${made}-${i}`,
            name: `Variant ${i}`,
            priceMinor: r.priceMinor,
            compareAtPriceMinor: r.compareAtPriceMinor,
            weightGrams: r.stored,
            stock: 1,
            options: [],
          })),
        })
        const before = created.variants
        expect(
          before.map((v) => v.weightGrams),
          'the weights as created',
        ).toEqual(rows.map((r) => r.stored))
        await drained()

        await service.update(created.id, {
          variants: before.map((v, i) => {
            const choice = rows[i]!.choice
            return {
              id: v.id,
              priceMinor: v.priceMinor,
              compareAtPriceMinor: v.compareAtPriceMinor,
              ...(choice.kind === 'clear' && { weightGrams: null }),
              ...(choice.kind === 'set' && { weightGrams: choice.grams }),
            }
          }),
        })

        const expected = rows.map((r) =>
          r.choice.kind === 'omit' ? r.stored : r.choice.kind === 'clear' ? null : r.choice.grams,
        )
        const stored = (await service.getById(created.id)).variants
        const byId = new Map(stored.map((v) => [v.id, v]))
        const label = JSON.stringify(rows)
        expect(
          before.map((v) => byId.get(v.id)?.weightGrams),
          `${label}: the weights stored`,
        ).toEqual(expected)
        expect(
          before.map((v) => [byId.get(v.id)?.priceMinor, byId.get(v.id)?.compareAtPriceMinor]),
          `${label}: the prices stored`,
        ).toEqual(before.map((v) => [v.priceMinor, v.compareAtPriceMinor]))

        const events = await drained()
        expect(priceEvents(events), `${label}: price events`).toEqual([])
        const snaps = updatedSnapshots(events)
        expect(snaps.length, `${label}: product.updated`).toBe(1)
        expect(
          before.map((v) => snaps[0]!.variants.find((s) => s.id === v.id)?.weightGrams),
          `${label}: the weights product.updated carries`,
        ).toEqual(expected)
      }),
      {
        numRuns: 40,
        examples: [
          [
            [
              {
                stored: null,
                priceMinor: 1000,
                compareAtPriceMinor: null,
                choice: { kind: 'set', grams: 750 },
              },
            ],
          ],
          [
            [
              {
                stored: 400,
                priceMinor: 1000,
                compareAtPriceMinor: 1200,
                choice: { kind: 'clear' },
              },
            ],
          ],
          [
            [
              {
                stored: 400,
                priceMinor: 1000,
                compareAtPriceMinor: null,
                choice: { kind: 'set', grams: 0 },
              },
            ],
          ],
          [
            [
              { stored: 250, priceMinor: 900, compareAtPriceMinor: null, choice: { kind: 'omit' } },
              {
                stored: null,
                priceMinor: 1900,
                compareAtPriceMinor: null,
                choice: { kind: 'set', grams: 1_000_000 },
              },
            ],
          ],
        ],
      },
    )
    await commandStore.close()
  })

  // Kills: a weight written only on the price path's skip, or a price change in the same entry dropped or alerted twice.
  it('AC-1: an entry changing both price and weight stores both and publishes exactly one price event, naming the old and new price', async () => {
    const { service, commandStore, drained } = await setup()
    const created = await service.create({
      slug: 'priced-and-weighed',
      name: 'Priced and weighed',
      variants: [
        { sku: 'PW-0', name: 'Zero', priceMinor: 1000, weightGrams: 300, stock: 1, options: [] },
        { sku: 'PW-1', name: 'One', priceMinor: 2000, weightGrams: 500, stock: 1, options: [] },
      ],
    })
    const [zero, one] = created.variants as [Variant, Variant]
    await drained()

    await service.update(created.id, {
      variants: [
        { id: zero.id, priceMinor: 800, weightGrams: 450 },
        { id: one.id, priceMinor: one.priceMinor },
      ],
    })
    const stored = new Map((await service.getById(created.id)).variants.map((v) => [v.id, v]))
    const events = await drained()

    expect(
      [zero, one].map((v) => [stored.get(v.id)?.priceMinor, stored.get(v.id)?.weightGrams]),
    ).toEqual([
      [800, 450],
      [one.priceMinor, one.weightGrams],
    ])
    expect(
      priceEvents(events).map((e) => [
        e.payload['variantId'],
        e.payload['previousPriceMinor'],
        e.payload['priceMinor'],
      ]),
    ).toEqual([[zero.id, zero.priceMinor, 800]])
    expect(
      updatedSnapshots(events).map((s) =>
        [zero, one].map((v) => s.variants.find((x) => x.id === v.id)?.weightGrams),
      ),
    ).toEqual([[450, one.weightGrams]])
    await commandStore.close()
  })
})
