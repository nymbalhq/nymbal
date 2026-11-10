import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Customer } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { CustomerDetailPage } from './CustomerDetailPage'

// Once support marks a pending customer confirmed, the page must not offer to confirm them again: the panel's actions
// would then answer that the customer is not pending. The cached customer is what the page reads on a tab switch or a
// reopen within the cache's stale time, so the confirmation has to reach it.

const PANEL = /(^|-)customer-verification$/
const MARK = /(^|-)customer-mark-verified$/
const CONFIRMED = /(^|-)customer-verification-confirmed$/
const ID = 'c-mark'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** A fake admin API holding one pending customer, whom a mark-verified POST confirms; it returns what the POST answered. */
function fakeApi(): { answered: () => unknown } {
  let emailVerification: 'pending' | 'verified' = 'pending'
  let updatedAt = '2026-11-09T10:00:00.000Z'
  let answered: unknown = null
  const customer = () => ({
    id: ID,
    email: 'ada.pending@customers.test',
    firstName: 'Ada',
    lastName: 'Pending',
    phone: '',
    addresses: [],
    orderCount: 0,
    totalSpentMinor: 0,
    metadata: {},
    roles: ['customer'],
    requiresPasswordReset: false,
    emailVerification,
    createdAt: '2026-11-09T10:00:00.000Z',
    updatedAt,
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const base = `/api/admin/customers/${ID}`
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-token' } })
    if (method === 'POST' && url.pathname === `${base}/mark-verified`) {
      emailVerification = 'verified'
      updatedAt = '2026-11-10T09:00:00.000Z'
      answered = customer()
      return json({ data: { customer: answered } })
    }
    if (url.pathname === base) {
      return json({
        data: {
          customer: customer(),
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
    if (url.pathname === `${base}/history`) {
      return json({
        data: {
          historyStartsAt: '2026-11-09T10:00:00.000Z',
          retentionDays: 90,
          entries: [],
          nextCursor: null,
        },
      })
    }
    return json({ data: {} })
  })
  return { answered: () => answered }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the customer page after support marks the email confirmed', () => {
  it('the cached customer reads verified, the page says so, and the panel does not return on a tab switch', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    const { queryClient } = renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialPath: `/customers/${ID}` },
    )
    // The app's own client keeps a customer fresh for 30 s, so a remount reads the cache rather than the API.
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 30_000 } })

    await user.click(await screen.findByTestId(MARK, undefined, { timeout: 5000 }))

    await waitFor(() =>
      expect(
        queryClient.getQueryData<{ customer: Customer }>(['customers', 'detail', ID])?.customer
          .emailVerification,
        'the cached customer once the POST answers',
      ).toBe('verified'),
    )
    const cached = queryClient.getQueryData<{ customer: Customer }>(['customers', 'detail', ID])
    expect(cached?.customer, 'the cached customer is the one the POST answered').toEqual(
      api.answered(),
    )
    await waitFor(() => expect(screen.queryByTestId(PANEL)).toBeNull())

    await user.click(screen.getByTestId('admin-customer-tab-history'))
    await user.click(screen.getByTestId('admin-customer-tab-overview'))

    expect(screen.queryByTestId(PANEL), 'the panel after a tab switch').toBeNull()
    expect(screen.getByTestId(CONFIRMED).textContent).toMatch(/marked confirmed/)
  })
})
