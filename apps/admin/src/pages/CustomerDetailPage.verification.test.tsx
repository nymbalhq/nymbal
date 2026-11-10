import { act, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/tests/render'
import { CustomerDetailPage } from './CustomerDetailPage'

// The customer page for an address waiting to be confirmed, against a fake admin API that answers each route in its
// real envelope: support sends the link again or marks the address confirmed, each press one request however fast the
// clicks; a confirmed or never-asked customer shows no panel.

const PANEL = /(^|-)customer-verification$/
const SEND = /(^|-)customer-send-verification$/
const MARK = /(^|-)customer-mark-verified$/

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const customerOf = (emailVerification: 'pending' | 'verified' | undefined) => ({
  id: 'c-verify',
  email: 'grace.pending@customers.test',
  firstName: 'Grace',
  lastName: 'Pending',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  ...(emailVerification !== undefined && { emailVerification }),
  createdAt: '2026-11-09T10:00:00.000Z',
  updatedAt: '2026-11-09T10:00:00.000Z',
})

interface Api {
  /** The POSTs sent to each action, by the path's last segment. */
  posts: (action: string) => number
  release(): void
}

/** A fake admin API whose POSTs are held until `release`, so a second click lands while the first is in flight. */
function fakeApi(emailVerification: 'pending' | 'verified' | undefined): Api {
  const customer = customerOf(emailVerification)
  const sent: string[] = []
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/admin/')
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const base = `/api/admin/customers/${customer.id}`
    // The admin sends its CSRF token with every POST (src/lib/api.ts), read once from this route.
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-token' } })
    if (method === 'POST' && url.pathname.startsWith(`${base}/`)) {
      const action = url.pathname.slice(base.length + 1)
      sent.push(action)
      await held
      if (action === 'send-verification') return json({ data: { sent: true } }, 202)
      if (action === 'mark-verified') {
        return json({ data: { customer: { ...customer, emailVerification: 'verified' } } })
      }
    }
    if (url.pathname === base) {
      return json({
        data: {
          customer,
          stats: {
            orderCount: 0,
            lifetimeRevenueMinor: 0,
            avgOrderValueMinor: 0,
            firstOrderAt: null,
            lastOrderAt: null,
          },
        },
      })
    }
    if (url.pathname === `${base}/orders`) return json({ data: [] })
    return json({ data: {} })
  })
  return { posts: (action) => sent.filter((a) => a === action).length, release }
}

function renderPage(): void {
  renderWithProviders(
    <Routes>
      <Route path="/customers/:id" element={<CustomerDetailPage />} />
    </Routes>,
    { initialPath: '/customers/c-verify' },
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-22: the customer page’s confirmation panel', () => {
  // Defect: support has no button for a pending customer, or one is shown for a customer with nothing to confirm.
  it('AC-22: a pending customer’s page shows the panel with both buttons; a confirmed and a never-asked customer’s page show none', async () => {
    const shown: boolean[] = []
    for (const state of ['pending', 'verified', undefined] as const) {
      fakeApi(state)
      renderPage()
      await screen.findByTestId('admin-customer-detail', undefined, { timeout: 5000 })
      const panel = screen.queryByTestId(PANEL)
      shown.push(
        panel !== null &&
          screen.queryByTestId(SEND) !== null &&
          screen.queryByTestId(MARK) !== null,
      )
      document.body.innerHTML = ''
      vi.unstubAllGlobals()
    }

    expect(shown).toEqual([true, false, false])
  })

  for (const [label, testId, action] of [
    ['send the link again', SEND, 'send-verification'],
    ['mark verified', MARK, 'mark-verified'],
  ] as const) {
    // Defect: a double click mails twice, or confirms twice.
    it(`AC-22: two clicks on ${label} before the page re-renders send one POST, also once it has settled`, async () => {
      const api = fakeApi('pending')
      renderPage()
      const button = (await screen.findByTestId(testId, undefined, { timeout: 3000 })) as HTMLButtonElement

      act(() => {
        button.click()
        button.click()
      })
      await waitFor(() => expect(api.posts(action)).toBeGreaterThan(0))
      const inFlight = api.posts(action)
      api.release()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })

      expect(inFlight, `${action} POSTs from two clicks`).toBe(1)
      expect(api.posts(action), `${action} POSTs once settled`).toBe(inFlight)
    })
  }
})
