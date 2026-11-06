import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  freshState,
  ImportSinceError,
  loadState,
  resolveSince,
  type ImportEntity,
  type ImportState,
} from '@nymbalhq/importers'
import { ALL_ENTITIES, clockPast, openStoreApp } from './support/store-app.js'
import { fixtureStore, type WooStore } from './support/woo-store.js'
import {
  CHANGED_AT,
  dateParams,
  resourceOf,
  review,
  runOver,
  stateOf,
  toSecond,
} from './support/woo-delta.js'

// What `--since` resolves to: `resolveSince` over states written by hand, and, through `runWooCommerceImport` over a
// whole store, what each pass records as covered and so what the next `--since last` sends for each entity.

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What `nymbal import` imports when `--entities` is not given. */
const DEFAULT_ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders']

type Run = { startedAt: string; finishedAt: string; entities: ImportEntity[] }

/** A state whose last pass finished, with `runs` as given. */
function finished(runs: Run[]): ImportState {
  return { ...freshState(), startedAt: runs[0]!.startedAt, phase: 'done', runs } as ImportState
}

const everyEntityCovered = () =>
  finished([
    {
      startedAt: '2026-11-01T09:00:00.000Z',
      finishedAt: '2026-11-01T09:30:00.000Z',
      entities: [...ALL_ENTITIES],
    },
  ])

/** Each entity's resolved value, an entity left out read as unfiltered. */
const byEntity = (resolved: Partial<Record<ImportEntity, string | null>>) =>
  ALL_ENTITIES.map((e) => [e, resolved[e] ?? null])

/** The refusal `fn` throws, as its class and reason. */
function refusal(fn: () => unknown): { sinceError: boolean; reason: unknown } {
  try {
    fn()
  } catch (err) {
    return {
      sinceError: err instanceof ImportSinceError,
      reason: (err as { reason?: unknown }).reason,
    }
  }
  return { sinceError: false, reason: 'did not throw' }
}

describe('AC-4: resolveSince', () => {
  it('AC-4: last resolves each entity to the start, floored to the second, of the last finished pass that covered it, and an entity no pass covered to unfiltered', () => {
    const passes = fc.array(
      fc.record({
        gapMs: fc.integer({ min: 1, max: 3 * 86_400_000 }),
        lengthMs: fc.integer({ min: 1, max: 86_400_000 }),
        entities: fc.subarray(ALL_ENTITIES),
      }),
      { minLength: 1, maxLength: 4 },
    )
    fc.assert(
      fc.property(passes, (drawn) => {
        let t = Date.parse('2026-01-01T00:00:00.000Z')
        const runs: Run[] = drawn.map((d) => {
          t += d.gapMs
          const startedAt = new Date(t).toISOString()
          t += d.lengthMs
          return { startedAt, finishedAt: new Date(t).toISOString(), entities: d.entities }
        })
        const want = ALL_ENTITIES.map((e) => {
          const last = runs.filter((r) => r.entities.includes(e)).at(-1)
          return [e, last === undefined ? null : toSecond(last.startedAt)]
        })

        expect(byEntity(resolveSince('last', finished(runs)))).toEqual(want)
      }),
    )
  })

  it('AC-4: a state saved before runs existed, its last pass done, resolves every entity it imported to its startedAt and reviews, which it never imported, to unfiltered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'since-legacy-'))
    try {
      const statePath = join(dir, '.nymbal-migration.json')
      const { runs: _runs, ...legacy } = {
        ...freshState(),
        startedAt: '2026-10-20T08:15:42.678Z',
        rollbackSince: '2026-10-20T08:15:42.678Z',
        phase: 'done',
        importedIds: {
          categories: ['c1'],
          products: ['p1'],
          customers: ['u1'],
          orders: ['o1'],
          reviews: [],
        },
        runs: undefined,
      }
      writeFileSync(statePath, JSON.stringify(legacy))
      const state = await loadState(statePath)

      expect(byEntity(resolveSince('last', state))).toEqual([
        ['categories', '2026-10-20T08:15:42Z'],
        ['products', '2026-10-20T08:15:42Z'],
        ['customers', '2026-10-20T08:15:42Z'],
        ['orders', '2026-10-20T08:15:42Z'],
        ['reviews', null],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('AC-4: a date is UTC midnight and a zoned date-time is that instant in UTC to the second, for every entity', () => {
    const state = everyEntityCovered()
    const each = (v: string) => ALL_ENTITIES.map((e) => [e, v])

    expect(byEntity(resolveSince('2026-10-01', state))).toEqual(each('2026-10-01T00:00:00Z'))
    expect(byEntity(resolveSince('2026-10-01T02:00:00+02:00', state))).toEqual(
      each('2026-10-01T00:00:00Z'),
    )
    fc.assert(
      fc.property(
        fc.integer({
          min: Date.parse('2000-01-01T00:00:00Z') / 1000,
          max: Date.parse('2099-01-01T00:00:00Z') / 1000,
        }),
        fc.integer({ min: -12 * 4, max: 14 * 4 }),
        fc.boolean(),
        (seconds, quarters, zulu) => {
          const offsetMin = quarters * 15
          const local = new Date(seconds * 1000 + offsetMin * 60_000).toISOString().slice(0, 19)
          const abs = Math.abs(offsetMin)
          const hhmm = `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
          const zone = offsetMin === 0 && zulu ? 'Z' : `${offsetMin < 0 ? '-' : '+'}${hhmm}`
          const utc = `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`

          expect(byEntity(resolveSince(`${local}${zone}`, state))).toEqual(each(utc))
        },
      ),
    )
  })

  it('AC-4: a value that is not last, a date or a zoned date-time is refused as invalid, a zone-less date-time among them', () => {
    const state = everyEntityCovered()
    const values = [
      'yesterday',
      '2026-10-01T10:00:00',
      '2026-10-01 10:00',
      '2026-13-01',
      '01/10/2026',
      '',
    ]

    expect(values.map((v) => [v, refusal(() => resolveSince(v, state))])).toEqual(
      values.map((v) => [v, { sinceError: true, reason: 'invalid' }]),
    )
  })

  it('AC-4: last with no state is refused as no-state, and on a state whose pass has not finished as no-finished-run', () => {
    const unfinished = { ...freshState(), phase: 'products', runs: [] } as unknown as ImportState

    expect([
      refusal(() => resolveSince('last', null)),
      refusal(() => resolveSince('last', unfinished)),
    ]).toEqual([
      { sinceError: true, reason: 'no-state' },
      { sinceError: true, reason: 'no-finished-run' },
    ])
  })
})

/** The fixture store with two reviews, both published long before any `since`. */
const withReviews = (): WooStore => fixtureStore({ reviews: [review(1, 100), review(2, 101)] })

/** The store with every product and order changed after any `since`. */
function changed(s: WooStore): WooStore {
  return {
    ...s,
    products: s.products.map((p) => ({
      ...p,
      name: `${String(p['name'])} v2`,
      date_modified_gmt: CHANGED_AT,
    })),
    orders: s.orders.map((o) => ({ ...o, date_modified_gmt: CHANGED_AT })),
  }
}

/** Waits until the wall clock is in a later second than `iso`. */
const nextSecond = (iso: string) =>
  clockPast(toSecond(new Date(Date.parse(iso) + 1000).toISOString()))

describe('AC-4: what each pass covers and so what --since last sends', () => {
  it('AC-4: after a default import, a products-only delta and then a delta of the default entities sends products the delta’s start and orders the import’s start', async () => {
    const env = await openStoreApp()
    try {
      const a = withReviews()
      await runOver(env, { store: a, entities: DEFAULT_ENTITIES })
      await nextSecond((await stateOf(env)).startedAt)
      const b = changed(a)
      await runOver(env, {
        store: b,
        entities: ['products'],
        since: resolveSince('last', await stateOf(env)),
      })
      const state = await stateOf(env)
      const [importRun, productsRun] = state.runs ?? []

      const { requests } = await runOver(env, {
        store: b,
        entities: DEFAULT_ENTITIES,
        since: resolveSince('last', state),
      })

      const sent = (resource: string) => [
        ...new Set(
          requests
            .filter((r) => resourceOf(r) === resource)
            .map((r) => dateParams(r).modified_after),
        ),
      ]
      expect([sent('/products'), sent('/orders')]).toEqual([
        [toSecond(productsRun!.startedAt)],
        [toSecond(importRun!.startedAt)],
      ])
      expect(toSecond(productsRun!.startedAt)).not.toBe(toSecond(importRun!.startedAt))
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-4: after a default import, --since last with products and reviews reads reviews with no after and imports every review', async () => {
    const env = await openStoreApp()
    try {
      const a = withReviews()
      await runOver(env, { store: a, entities: DEFAULT_ENTITIES })

      const { requests } = await runOver(env, {
        store: changed(a),
        entities: ['products', 'reviews'],
        since: resolveSince('last', await stateOf(env)),
      })

      const reviewReads = requests.filter((r) => resourceOf(r) === '/products/reviews')
      expect(reviewReads.map((r) => dateParams(r).after)).toEqual(reviewReads.map(() => null))
      expect(Object.keys((await stateOf(env)).wcToNymbalReview).sort()).toEqual(
        a.reviews.map((r) => String(r['id'])).sort(),
      )
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-4: an import stopped on products and resumed with products and reviews records one run from the first run’s start covering only the entities whose loops ended', async () => {
    const env = await openStoreApp()
    try {
      const a = withReviews()
      await runOver(env, {
        store: a,
        entities: DEFAULT_ENTITIES,
        hold: (u) => u.pathname.endsWith('/products/101/variations'),
      })
      const firstStart = (await stateOf(env)).startedAt
      await nextSecond(firstStart)

      await runOver(env, { store: a, entities: ['products', 'reviews'] })

      const runs = (await stateOf(env)).runs
      expect(runs?.map((r) => [r.startedAt, [...(r.entities ?? [])].sort()])).toEqual([
        [firstStart, ['categories', 'products', 'reviews']],
      ])
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-4: a finished products import and then a plain run of orders records a pass covering orders, so --since last gives orders that pass’s start', async () => {
    const env = await openStoreApp()
    try {
      const a = withReviews()
      await runOver(env, { store: a, entities: ['products'] })
      const before = (await stateOf(env)).runs ?? []
      const secondRunStart = toSecond(new Date().toISOString())

      await runOver(env, { store: a, entities: ['orders'] })

      const state = await stateOf(env)
      const runs = state.runs ?? []
      const since = resolveSince('last', state)
      expect(runs.slice(0, before.length)).toEqual(before)
      expect(runs.slice(before.length).map((r) => r.entities?.includes('orders'))).toEqual([true])
      expect(since.orders).toBe(toSecond(runs.at(-1)!.startedAt))
      // Never later than when the orders run began: a later `since` would miss what changed during it.
      expect(Date.parse(since.orders!)).toBeLessThanOrEqual(Date.parse(secondRunStart))
    } finally {
      await env.close()
    }
  }, 120_000)

  it('AC-4: after a default import and a products-only delta, a plain run of the default entities reads no list and records no pass', async () => {
    const env = await openStoreApp()
    try {
      const a = withReviews()
      await runOver(env, { store: a, entities: DEFAULT_ENTITIES })
      await nextSecond((await stateOf(env)).startedAt)
      await runOver(env, {
        store: changed(a),
        entities: ['products'],
        since: resolveSince('last', await stateOf(env)),
      })
      const before = (await stateOf(env)).runs ?? []

      const { requests } = await runOver(env, { store: changed(a), entities: DEFAULT_ENTITIES })

      const lists = ['/products', '/orders', '/customers', '/products/categories']
      expect(requests.map(resourceOf).filter((r) => r !== null && lists.includes(r))).toEqual([])
      expect((await stateOf(env)).runs ?? []).toEqual(before)
    } finally {
      await env.close()
    }
  }, 120_000)
})
