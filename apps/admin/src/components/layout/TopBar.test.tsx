import { act, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearToken, setToken } from '@/lib/auth'
import { DashboardPage } from '@/pages/DashboardPage'
import { RealtimeProvider } from '@/realtime/provider'
import { TopBar } from './TopBar'

// The top bar and the dashboard under the realtime provider, with a fake EventSource the test drives frame by frame.

type Listener = (event: MessageEvent<string>) => void

/** An EventSource double: a named event reaches only listeners for that name; `error` also reaches `onerror`. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  onerror: ((event: Event) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  closed = false
  private readonly listeners = new Map<string, Listener[]>()

  constructor(readonly url: string | URL) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener),
    )
  }

  close(): void {
    this.closed = true
  }

  emit(name: string, data: string): void {
    const event = new MessageEvent(name, { data })
    for (const listener of this.listeners.get(name) ?? []) listener(event)
    if (name === 'error') this.onerror?.(event)
    if (name === 'open') this.onopen?.(event)
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  let tickets = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (url.pathname === '/api/admin/events/ticket') {
      tickets += 1
      return json({ data: { ticket: `ticket-${tickets}` } })
    }
    if (url.pathname === '/api/admin/dashboard')
      return json({
        data: {
          today: { orderCount: 0, revenueMinor: 0, itemsShipped: 0 },
          recentOrders: [],
          lowStock: [],
        },
      })
    return json({ data: [] })
  })
  setToken('access-token')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearToken()
})

function renderShell() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <RealtimeProvider>
            <TopBar navOpen={false} onToggleNav={() => {}} />
            <DashboardPage />
          </RealtimeProvider>
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

/** Steps the backoff clock until the client has opened `n` streams; fails after 60 s. */
async function streams(n: number): Promise<FakeEventSource> {
  await act(() => vi.advanceTimersByTimeAsync(0))
  let waited = 0
  while (FakeEventSource.instances.length < n && waited < 60_000) {
    await act(() => vi.advanceTimersByTimeAsync(250))
    waited += 250
  }
  expect(FakeEventSource.instances.length, `stream ${n} within 60 s`).toBe(n)
  return FakeEventSource.instances.at(-1)!
}

/** What a Live badge says: its `data-state` and its text. */
function badge(testId: string): [string | null, string] {
  const el = screen.getByTestId(testId)
  return [el.getAttribute('data-state'), (el.textContent ?? '').trim()]
}

const connectedFrame = () => JSON.stringify({ at: '2026-11-01T10:00:00.000Z' })

describe('the Live badges', () => {
  // Kills: a badge (the top bar's or the dashboard header's) as static markup that reads Live through an outage; a
  // state never reset when the provider unmounts (sign-out), so the next session says Live before its stream is
  // confirmed.
  it('AC-9: the top bar’s and the dashboard’s each read Offline before the first `connected` frame, Live after it, Offline after an error, Live again after the reconnect’s `connected` frame, and Offline in the next session before its stream is confirmed', async () => {
    // Each step, and whether the stream it leaves is confirmed: both badges must say exactly that.
    const seen: Array<{
      step: string
      topBar: [string | null, string]
      dashboard: [string | null, string]
    }> = []
    const read = (step: string) =>
      seen.push({
        step,
        topBar: badge('admin-topbar-live'),
        dashboard: badge('admin-dashboard-live'),
      })

    const view = renderShell()
    const first = await streams(1)
    read('before the first connected frame')
    act(() => first.emit('connected', connectedFrame()))
    read('after the connected frame')
    act(() => first.emit('error', ''))
    read('after the stream errored')
    const second = await streams(2)
    read('while reconnecting')
    act(() => second.emit('connected', connectedFrame()))
    read('after the reconnect’s connected frame')
    view.unmount()
    renderShell()
    await streams(3)
    read('the next session, before its stream is confirmed')

    const confirmed = [false, true, false, false, true, false]
    expect(seen).toEqual(
      seen.map(({ step }, i) => {
        const expected = confirmed[i] ? ['live', 'Live'] : ['offline', 'Offline']
        return { step, topBar: expected, dashboard: expected }
      }),
    )
  })
})
