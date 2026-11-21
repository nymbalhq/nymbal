import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { orderIn } from '@/tests/order-page'
import type { AdminOrder } from '@/types'
import { useOrderBulkAction, type OrderBulkOutcome } from './useOrderBulkAction'

// The hook against a fake admin API (fetch stubbed): each POST recorded with its Idempotency-Key and answered as the
// test says. The one unit under test is the run; nothing inside it is replaced.

type Answer = 'ok' | 'refused' | 'throws' | 'garbage'
type Action = 'cancel' | 'process'

const FALLBACK = 'The order could not be changed.'
const refusalOf = (index: number) => `Order NYM-${index} is paid: refund it instead`

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** One event-loop turn, not a wait for time: a parallel run's other POSTs arrive during it, so they overlap. */
const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function ordersOf(k: number): AdminOrder[] {
  return Array.from(
    { length: k },
    (_, i) => orderIn('pending', { id: `o-${i}`, orderNumber: `NYM-${i}` }) as unknown as AdminOrder,
  )
}

function fakeApi(answerOf: (index: number) => Answer, hold: Promise<void> = Promise.resolve()) {
  const posts: Array<{ method: string; path: string; key: string | null }> = []
  let inFlight = 0
  let mostInFlight = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    const index = posts.length
    posts.push({
      method: (init.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      key: new Headers(init.headers).get('idempotency-key'),
    })
    inFlight += 1
    mostInFlight = Math.max(mostInFlight, inFlight)
    await aTurn()
    await hold
    inFlight -= 1
    const answer = answerOf(index)
    if (answer === 'throws') throw new TypeError('Failed to fetch')
    if (answer === 'garbage') return new Response('<html>Bad gateway</html>', { status: 502 })
    if (answer === 'refused') {
      return json({ error: { code: 'order.paid', message: refusalOf(index) } }, 409)
    }
    return json({ data: { id: `o-${index}` } })
  })
  return {
    posts,
    get mostInFlight() {
      return mostInFlight
    },
  }
}

function mount(queryClient = new QueryClient()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return { queryClient, ...renderHook(() => useOrderBulkAction(), { wrapper }) }
}

const route = (action: Action, id: string) => `/api/admin/orders/${id}/${action}`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useOrderBulkAction', () => {
  it('AC-3: one POST per order to the action’s route, the next only after the previous settled, every answer accounted for, and a refusal or a thrown fetch does not stop the rest', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<Action>('cancel', 'process'),
        fc.array(fc.constantFrom<Answer>('ok', 'refused', 'throws', 'garbage'), {
          minLength: 1,
          maxLength: 6,
        }),
        async (action, answers) => {
          const api = fakeApi((index) => answers[index]!)
          const orders = ordersOf(answers.length)
          const { result, unmount } = mount()
          let outcome: OrderBulkOutcome | undefined
          await act(async () => {
            outcome = await result.current.run(action, orders)
          })
          unmount()

          expect(api.posts.map((p) => [p.method, p.path])).toEqual(
            orders.map((o) => ['POST', route(action, o.id)]),
          )
          expect(api.mostInFlight, 'POSTs overlapped').toBe(1)
          expect(outcome!.succeeded.length + outcome!.failed.length).toBe(answers.length)
          expect(outcome!.succeeded).toEqual(
            orders.filter((_, i) => answers[i] === 'ok').map((o) => o.id),
          )
          expect(outcome!.failed).toEqual(
            orders.flatMap((o, i) =>
              answers[i] === 'ok'
                ? []
                : [
                    {
                      orderId: o.id,
                      orderNumber: o.orderNumber,
                      message: answers[i] === 'refused' ? refusalOf(i) : FALLBACK,
                    },
                  ],
            ),
          )
        },
      ),
      { numRuns: 40 },
    )
  })

  it('AC-4: every POST of a run carries an Idempotency-Key and the run’s keys are pairwise distinct', async () => {
    const api = fakeApi(() => 'ok')
    const orders = ordersOf(5)
    const { result } = mount()
    await act(async () => {
      await result.current.run('cancel', orders)
    })

    const keys = api.posts.map((p) => p.key)
    expect(keys.filter((k) => k === null || k === '')).toEqual([])
    expect(new Set(keys).size).toBe(orders.length)
  })

  it.each<[string, Answer]>([
    ['every POST succeeded', 'ok'],
    ['every POST was refused', 'refused'],
    ['every POST threw', 'throws'],
  ])(
    'AC-5: when a run settles the list, detail and dashboard queries go stale, and no other, when %s',
    async (_name, answer) => {
      let release: () => void = () => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const api = fakeApi(() => answer, held)
      const queryClient = new QueryClient()
      const stale = [
        ['orders', 'list', {}],
        ['orders', 'detail', 'NYM-0'],
        ['dashboard', 'stats'],
      ]
      const untouched = [
        ['orders', 'notes', 'o-0'],
        ['orders', 'timeline', 'o-0'],
        ['inventory', 'list', {}],
      ]
      for (const key of [...stale, ...untouched]) queryClient.setQueryData(key, { seeded: true })
      const isStale = (key: unknown[]) => queryClient.getQueryState(key)!.isInvalidated
      const orders = ordersOf(3)
      const { result } = mount(queryClient)

      let run: Promise<OrderBulkOutcome> | undefined
      act(() => {
        run = result.current.run('cancel', orders)
      })
      await waitFor(() => expect(api.posts.length).toBeGreaterThanOrEqual(1))
      expect(stale.map(isStale), 'nothing goes stale before the run settles').toEqual(
        stale.map(() => false),
      )

      await act(async () => {
        release()
        await run
      })

      expect(stale.map(isStale)).toEqual(stale.map(() => true))
      expect(untouched.map(isStale)).toEqual(untouched.map(() => false))
    },
  )

  it('AC-6: run called four times before the first settles sends one POST per order and every call resolves to the same outcome; a later run sends again', async () => {
    const api = fakeApi(() => 'ok')
    const orders = ordersOf(3)
    const { result } = mount()

    let outcomes: OrderBulkOutcome[] = []
    await act(async () => {
      const calls = [1, 2, 3, 4].map(() => result.current.run('cancel', orders))
      outcomes = await Promise.all(calls)
    })

    expect(api.posts.map((p) => p.path)).toEqual(orders.map((o) => route('cancel', o.id)))
    expect(outcomes.map((o) => o.succeeded)).toEqual(outcomes.map(() => outcomes[0]!.succeeded))
    expect(outcomes[0]!.succeeded).toEqual(orders.map((o) => o.id))

    await act(async () => {
      await result.current.run('cancel', orders)
    })
    expect(api.posts.length).toBe(orders.length * 2)
  })
})
