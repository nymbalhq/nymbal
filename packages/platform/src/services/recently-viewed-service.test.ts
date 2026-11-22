import { EVT_PRODUCT_VIEWED, EVT_VISITOR_MERGED, type NymbalEvent } from '@nymbalhq/types'
import { describe, expect, it } from 'vitest'
import { createLogger } from '../logger.js'
import {
  foldEvent,
  type RecentlyViewedDoc,
  type ViewerDocuments,
} from '../read-models/recently-viewed.js'
import {
  createRecentlyViewedService,
  type RecentlyViewedServiceDeps,
} from './recently-viewed-service.js'

// A view and a sign-in merge stamped in the same millisecond: the projection may see the view before the merge is
// delivered again, a rebuild folds them in log order, and both must give the same lists.

const T = new Date('2026-11-21T12:00:00.000Z')

function service(now: () => Date) {
  const events: NymbalEvent<unknown>[] = []
  const deps = {
    store: { read: async (fn: (tx: unknown) => unknown) => fn({}) },
    repos: {
      product: { findById: async (_tx: unknown, id: string) => ({ id, status: 'active' }) },
    },
    publisher: {
      publish: async (type: string, payload: unknown, opts: { timestamp: Date }) => {
        events.push({
          id: `e-${events.length}`,
          type,
          payload,
          timestamp: opts.timestamp.toISOString(),
        } as NymbalEvent<unknown>)
      },
    },
    logger: createLogger({ pretty: false, level: 'error' }),
    now,
  } as unknown as RecentlyViewedServiceDeps
  return { svc: createRecentlyViewedService(deps), events }
}

function documents(): { docs: ViewerDocuments; held: Map<string, RecentlyViewedDoc> } {
  const held = new Map<string, RecentlyViewedDoc>()
  return {
    held,
    docs: {
      get: async (key) => held.get(key) ?? null,
      put: async (key, doc) => void held.set(key, doc),
      delete: async (key) => void held.delete(key),
    },
  }
}

async function foldAll(order: NymbalEvent<unknown>[]): Promise<Map<string, RecentlyViewedDoc>> {
  const { docs, held } = documents()
  for (const event of order) await foldEvent(docs, event)
  return held
}

describe('recently-viewed stamps', () => {
  it('stamps every view and merge strictly after the one before, even when the clock stands still or steps back', async () => {
    const ticks = [T, T, T, new Date(T.getTime() - 5)]
    let i = 0
    const { svc, events } = service(() => ticks[Math.min(i++, ticks.length - 1)]!)
    await svc.record({ kind: 'visitor', id: 'v1' }, 'p1')
    await svc.fold('v1', 'c1')
    await svc.record({ kind: 'visitor', id: 'v1' }, 'p2')
    await svc.record({ kind: 'visitor', id: 'v1' }, 'p3')
    const stamps = events.map((e) => Date.parse(e.timestamp))
    for (let k = 1; k < stamps.length; k++) expect(stamps[k]).toBeGreaterThan(stamps[k - 1]!)
    expect(stamps[0]).toBe(T.getTime())
  })

  it('a view in the merge’s millisecond lands on the same list whether the merge is folded after it (a redelivery) or before it (a rebuild in log order)', async () => {
    const { svc, events } = service(() => T)
    await svc.record({ kind: 'visitor', id: 'v1' }, 'p1')
    await svc.fold('v1', 'c1')
    await svc.record({ kind: 'visitor', id: 'v1' }, 'p2')
    const [before, merge, after] = events
    expect(events.map((e) => e.type)).toEqual([
      EVT_PRODUCT_VIEWED,
      EVT_VISITOR_MERGED,
      EVT_PRODUCT_VIEWED,
    ])

    const rebuild = await foldAll([before!, merge!, after!])
    const live = await foldAll([before!, after!, merge!])
    expect(live).toEqual(rebuild)
    expect(rebuild.get('visitor:v1')?.items.map((i) => i.productId)).toEqual(['p2'])
    expect(rebuild.get('customer:c1')?.items.map((i) => i.productId)).toEqual(['p1'])
  })
})
