import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider, hashKey, type QueryKey } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StockStatus } from '@nymbalhq/types'
import { ApiError } from '@/lib/api'
import { createEventHandlers } from '@/realtime/handlers'
import type { InventoryRow } from '@/types'
import { useAdjustStock, useInventory } from './useInventory'

// The stock adjust's optimistic write and its settle, against a fake admin API (fetch stubbed): `GET
// /api/admin/inventory` serves the stock the server has committed, and each adjust POST is held until the test
// answers it. Nothing inside the hook is replaced.

const AT = '2026-11-19T10:00:00.000Z'
const REFUSAL = 'Cannot reduce stock below zero (variant v-a)'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The server's status for a stock (routes/admin-inventory.ts), written out independently. */
function statusFor(stock: number, threshold: number): StockStatus {
  if (stock <= 0) return 'out_of_stock'
  if (stock <= threshold) return 'low_stock'
  return 'in_stock'
}

function row(variantId: string, stock: number, threshold: number): InventoryRow {
  return {
    variantId,
    productId: `p-${variantId}`,
    productName: `Product ${variantId}`,
    sku: `SKU-${variantId}`,
    options: [],
    stock,
    threshold,
    status: statusFor(stock, threshold),
    updatedAt: AT,
  }
}

type Outcome = 'applied' | 'refused'

interface Post {
  variantId: string
  delta: number
  answer: (outcome: Outcome) => void
}

/**
 * The admin inventory API over `rows`. A POST commits only when `commit` or an `applied` answer says so; a GET
 * reads the committed stock when it is sent and, while `hold` is on, answers only on `release`.
 */
function fakeServer(rows: InventoryRow[]) {
  const committed = new Map(rows.map((r) => [r.variantId, r.stock]))
  const applied = new Set<Post>()
  const posts: Post[] = []
  const held: Array<() => void> = []
  let gets = 0
  let holding = false

  const served = () =>
    rows.map((r) => {
      const stock = committed.get(r.variantId)!
      return { ...r, stock, status: statusFor(stock, r.threshold) }
    })
  const commit = (post: Post) => {
    if (applied.has(post)) return
    applied.add(post)
    committed.set(post.variantId, committed.get(post.variantId)! + post.delta)
  }

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && url.pathname === '/api/admin/inventory') {
      gets += 1
      const snapshot = served()
      if (holding) await new Promise<void>((resolve) => held.push(resolve))
      return json({ data: snapshot })
    }
    const adjust = /^\/api\/admin\/inventory\/([^/]+)\/adjust$/.exec(url.pathname)
    if (method === 'POST' && adjust) {
      const { delta } = JSON.parse(String(init.body)) as { delta: number }
      return new Promise<Response>((resolve) => {
        const post: Post = {
          variantId: adjust[1]!,
          delta,
          answer: (outcome) => {
            if (outcome === 'refused') {
              resolve(json({ error: { code: 'validation.failed', message: REFUSAL } }, 400))
              return
            }
            commit(post)
            resolve(
              json({ data: { newQty: committed.get(post.variantId), variantId: post.variantId } }),
            )
          },
        }
        posts.push(post)
      })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })

  return {
    posts,
    get gets() {
      return gets
    },
    stockOf: (variantId: string) => committed.get(variantId)!,
    post: (variantId: string) => posts.find((p) => p.variantId === variantId)!,
    commit: (variantId: string) => commit(posts.find((p) => p.variantId === variantId)!),
    hold: (on: boolean) => {
      holding = on
    },
    release: () => held.splice(0).forEach((open) => open()),
    get held() {
      return held.length
    },
  }
}

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  })
}

function wrapperFor(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

/** One event-loop turn: the promise chains an act started run first. */
const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Waits until no query is fetching. */
async function fetchesSettled(qc: QueryClient): Promise<void> {
  await aTurn()
  await waitFor(() => expect(qc.isFetching(), 'queries still fetching').toBe(0), {
    interval: 1,
    timeout: 3000,
  })
}

const listKey = (filters: object): QueryKey => ['inventory', 'list', filters]

/** The filters as the inventory page sends them (InventoryPage.tsx), with `q` and `status` unset or set. */
const pageFilters = fc.record({
  q: fc.constantFrom(undefined, 'SKU', 'Product'),
  status: fc.constantFrom(undefined, 'in_stock', 'low_stock', 'out_of_stock'),
  sort: fc.constant('urgency'),
  limit: fc.constant(200),
})
const otherFilters = fc.record(
  {
    q: fc.constantFrom('SKU-v', 'wool'),
    status: fc.constantFrom('in_stock', 'out_of_stock'),
    sort: fc.constant('urgency'),
    limit: fc.constant(50),
  },
  { requiredKeys: [] },
)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-5: the optimistic write reaches every cached inventory list the page can show', () => {
  it('AC-5: before the POST settles, every cached list holding the variant reads stock + delta with the server status when the stock can take it and is unchanged otherwise; every other row and list is as it was, no list is created, and no row is negative (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            filters: fc.oneof(pageFilters, otherFilters),
            holds: fc.boolean(),
            at: fc.nat(2),
          }),
          { minLength: 1, maxLength: 4, selector: (l) => hashKey(listKey(l.filters)) },
        ),
        fc.nat(30),
        fc.nat(10),
        fc.integer({ min: -40, max: 40 }).filter((d) => d !== 0),
        fc.nat(30),
        async (lists, stock, threshold, delta, otherStock) => {
          const target = row('v-a', stock, threshold)
          const others = [row('v-b', otherStock, 3), row('v-c', 0, 0)]
          const server = fakeServer([target, ...others])
          const qc = client()
          const emptyCachedBefore = lists.some(
            (l) => hashKey(listKey(l.filters)) === hashKey(listKey({})),
          )
          const before = new Map<string, InventoryRow[]>()
          for (const { filters, holds, at } of lists) {
            const data = holds ? [...others.slice(0, at), target, ...others.slice(at)] : others
            qc.setQueryData(listKey(filters), data)
            before.set(hashKey(listKey(filters)), data)
          }
          const { result, unmount } = renderHook(() => useAdjustStock(), {
            wrapper: wrapperFor(qc),
          })

          act(() => {
            result.current.mutate({
              variantId: 'v-a',
              delta,
              reason: 'manual',
              idempotencyKey: 'k-1',
            })
          })
          await waitFor(() => expect(server.posts.length, 'the POST is sent').toBe(1))

          const takes = stock + delta >= 0
          // The adjusted row is judged on its stock and status alone; every other row whole.
          const judged = (rows: InventoryRow[]) =>
            rows.map((r) =>
              r.variantId === 'v-a' ? { variantId: r.variantId, stock: r.stock, status: r.status } : r,
            )
          for (const { filters, holds } of lists) {
            const key = listKey(filters)
            const was = before.get(hashKey(key))!
            const now = qc.getQueryData<InventoryRow[]>(key)!
            const label = `${JSON.stringify(filters)} stock ${stock} delta ${delta}`
            const expected = was.map((r) =>
              holds && takes && r.variantId === 'v-a'
                ? { ...r, stock: stock + delta, status: statusFor(stock + delta, threshold) }
                : r,
            )
            expect(judged(now), `${label}: the list`).toEqual(judged(expected))
            expect(Math.min(...now.map((r) => r.stock)), `${label}: lowest stock`).toBeGreaterThanOrEqual(0)
          }
          expect(
            emptyCachedBefore ||
              qc.getQueryCache().find({ queryKey: listKey({}), exact: true }) === undefined,
            'no list under the key {} that was never cached',
          ).toBe(true)

          server.post('v-a').answer('applied')
          await waitFor(() => expect(qc.isMutating()).toBe(0))
          unmount()
          qc.clear()
          vi.unstubAllGlobals()
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)
})

describe('AC-6: a refusal rolls back its own row, and only the last adjust to settle refetches', () => {
  it('AC-6: with A refused while B is in flight, A reads as before its click, B keeps its optimistic value and no GET is sent; once B settles, applied or refused, a GET is sent, inventory and products queries are invalidated, and every row reads the server stock (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(pageFilters, {
          minLength: 1,
          maxLength: 3,
          selector: (f) => hashKey(listKey(f)),
        }),
        fc.record({
          stock: fc.nat(20),
          threshold: fc.nat(5),
          delta: fc.integer({ min: -25, max: 25 }),
        }),
        fc.record({
          stock: fc.nat(20),
          threshold: fc.nat(5),
          delta: fc.integer({ min: -25, max: 25 }),
        }),
        fc.constantFrom<Outcome>('applied', 'refused'),
        async (filters, a, b, bOutcome) => {
          fc.pre(a.delta !== 0 && b.delta !== 0)
          fc.pre(bOutcome === 'refused' || b.stock + b.delta >= 0)
          const rowA = row('v-a', a.stock, a.threshold)
          const rowB = row('v-b', b.stock, b.threshold)
          const server = fakeServer([rowA, rowB, row('v-c', 9, 2)])
          const qc = client()
          const wrapper = wrapperFor(qc)
          const views = filters.map((f) => renderHook(() => useInventory(f), { wrapper }))
          // Queries no observer holds: what an invalidate leaves on them is visible after the refetch.
          const unobserved: QueryKey[] = [
            ['inventory', 'list', { q: 'not on screen', sort: 'urgency', limit: 200 }],
            ['inventory', 'history', 'v-a'],
            ['products', 'list', {}],
            ['products', 'detail', 'p-v-a'],
          ]
          unobserved.forEach((key) => qc.setQueryData(key, []))
          const { result, unmount } = renderHook(() => useAdjustStock(), { wrapper })
          await waitFor(() =>
            expect(filters.every((f) => qc.getQueryData(listKey(f)) !== undefined)).toBe(true),
          )
          await fetchesSettled(qc)
          const getsAtClicks = server.gets

          let settledA!: Promise<unknown>
          let settledB!: Promise<unknown>
          act(() => {
            settledA = result.current.mutateAsync({
              variantId: 'v-a',
              delta: a.delta,
              reason: 'manual',
              idempotencyKey: 'k-a',
            })
          })
          await waitFor(() => expect(server.posts.length).toBe(1))
          act(() => {
            settledB = result.current.mutateAsync({
              variantId: 'v-b',
              delta: b.delta,
              reason: 'manual',
              idempotencyKey: 'k-b',
            })
          })
          await waitFor(() => expect(server.posts.length).toBe(2))

          server.post('v-a').answer('refused')
          await act(async () => {
            await expect(settledA).rejects.toBeInstanceOf(ApiError)
          })
          await aTurn()
          await aTurn()

          const optimisticB = b.stock + b.delta >= 0 ? b.stock + b.delta : b.stock
          const rowsIn = (f: object) => qc.getQueryData<InventoryRow[]>(listKey(f))!
          for (const f of filters) {
            const label = JSON.stringify(f)
            expect(
              rowsIn(f).find((r) => r.variantId === 'v-a'),
              `${label}: A as before its click`,
            ).toEqual(rowA)
            expect(
              rowsIn(f).find((r) => r.variantId === 'v-b')!.stock,
              `${label}: B's optimistic stock while B is in flight`,
            ).toBe(optimisticB)
          }
          expect(server.gets, 'inventory GETs sent between the two settles').toBe(getsAtClicks)

          server.post('v-b').answer(bOutcome)
          await act(async () => {
            await settledB.catch(() => undefined)
          })
          await fetchesSettled(qc)

          expect(server.gets, 'a GET once the last adjust settled').toBeGreaterThan(getsAtClicks)
          for (const key of unobserved) {
            expect(qc.getQueryState(key)?.isInvalidated, `${hashKey(key)} invalidated`).toBe(true)
          }
          for (const f of filters) {
            for (const variantId of ['v-a', 'v-b']) {
              expect(
                rowsIn(f).find((r) => r.variantId === variantId)!.stock,
                `${JSON.stringify(f)}: ${variantId} after B ${bOutcome}`,
              ).toBe(server.stockOf(variantId))
            }
          }
          expect(server.stockOf('v-b')).toBe(bOutcome === 'applied' ? b.stock + b.delta : b.stock)

          unmount()
          views.forEach((v) => v.unmount())
          qc.clear()
          vi.unstubAllGlobals()
        },
      ),
      { numRuns: 25 },
    )
  }, 30_000)
})

describe('AC-7: an applied adjust reads its new stock throughout, whichever of its frame and its answer comes first', () => {
  const ORDERS = ['frame first', 'answer first'] as const

  it('AC-7: from the click on, in both orders of the stream frame and the POST answer, the row reads s + delta: never s and never s + 2 delta (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ORDERS),
        pageFilters,
        fc.nat(30),
        fc.integer({ min: -30, max: 30 }),
        fc.nat(5),
        async (order, filters, s, delta, threshold) => {
          fc.pre(delta !== 0 && s + delta >= 0)
          const server = fakeServer([row('v-a', s, threshold), row('v-b', 4, 1)])
          const qc = client()
          const wrapper = wrapperFor(qc)
          const view = renderHook(() => useInventory(filters), { wrapper })
          const { result, unmount } = renderHook(() => useAdjustStock(), { wrapper })
          await waitFor(() => expect(qc.getQueryData(listKey(filters))).not.toBeUndefined())
          await fetchesSettled(qc)
          server.hold(true)

          const seen: Array<[string, number]> = []
          const look = (point: string) => {
            const stock = qc
              .getQueryData<InventoryRow[]>(listKey(filters))!
              .find((r) => r.variantId === 'v-a')!.stock
            seen.push([point, stock])
          }
          /** Answers every GET sent so far and waits for the cache to take them. */
          const answerGets = async () => {
            await aTurn()
            server.release()
            await fetchesSettled(qc)
          }
          const frame = async () => {
            createEventHandlers(qc)('inventory.changed.v1', {
              variantId: 'v-a',
              previousQty: s,
              newQty: s + delta,
              reason: 'manual',
            })
            await answerGets()
            look("after the frame's refetch answers")
          }

          let applied!: Promise<unknown>
          act(() => {
            applied = result.current.mutateAsync({
              variantId: 'v-a',
              delta,
              reason: 'manual',
              idempotencyKey: 'k-a',
            })
          })
          await waitFor(() => expect(server.posts.length).toBe(1))
          look('after the click')

          server.commit('v-a')
          if (order === 'frame first') await frame()
          server.post('v-a').answer('applied')
          await act(async () => {
            await applied
          })
          look('after the answer')
          await answerGets()
          look("after the settle's refetch answers")
          if (order === 'answer first') await frame()

          expect(seen, `${order}: s ${s}, delta ${delta}`).toEqual(
            seen.map(([point]) => [point, s + delta]),
          )

          server.hold(false)
          server.release()
          unmount()
          view.unmount()
          qc.clear()
          vi.unstubAllGlobals()
        },
      ),
      { numRuns: 30 },
    )
  }, 30_000)
})
