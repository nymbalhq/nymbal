import fc from 'fast-check'
import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Order, OrderStatus } from '@nymbalhq/types'
import { createEventHandlers } from '@/realtime/handlers'
import { renderWithProviders } from '@/tests/render'
import { Sidebar } from './Sidebar'

// The sidebar's Orders badge against a fake admin API (fetch stubbed): `GET /api/admin/orders` answers at most one
// order of the page asked for and `meta.total`, the count under the request's status filter, which a test may change.

const AT = '2026-11-19T10:00:00.000Z'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

function order(id: string, status: OrderStatus): Order {
  return {
    id,
    orderNumber: `NYM-${id}`,
    sequence: 1,
    customerId: null,
    status,
    email: `${id}@orders.test`,
    billingAddress: ADDRESS,
    shippingAddress: ADDRESS,
    lineItems: [],
    subtotalMinor: 1000,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 1000,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    capturedMinor: 0,
    capturedAt: null,
    refundedMinor: 0,
    captureMethod: null,
    source: 'storefront',
    createdAt: AT,
    updatedAt: AT,
  }
}

/** The API with `pending` pending orders; any other filter counts many more, so a wrong filter shows a wrong count. */
function fakeApi(pending: number) {
  const counts = { pending, orderGets: 0 }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (url.pathname === '/api/admin/orders') {
      counts.orderGets += 1
      const total =
        url.searchParams.get('status') === 'pending' ? counts.pending : counts.pending + 1000
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const rows = Array.from({ length: Math.min(total, limit) }, (_, i) =>
        order(`o-${i}`, 'pending'),
      )
      return json({ data: rows, meta: { total } })
    }
    if (url.pathname === '/api/admin/proposals') {
      return json({ data: { proposals: [], pending: 0 } })
    }
    if (url.pathname === '/api/admin/me') {
      return json({ data: { userId: 'admin-1', storeName: 'Test Store', environment: 'test' } })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return counts
}

const badgeText = (total: number) => (total > 99 ? '99+' : String(total))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the sidebar’s pending orders badge', () => {
  it('AC-6: property: the badge reads the server’s pending total (99+ above 99, nothing at 0) and the Orders link is named "<total> pending"', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.constantFrom(0, 1, 2, 99, 100, 101), fc.integer({ min: 0, max: 5000 })),
        async (total) => {
          const api = fakeApi(total)
          const { queryClient, unmount } = renderWithProviders(<Sidebar open onClose={() => {}} />)
          try {
            const link = screen.getByTestId('admin-nav-orders')
            await waitFor(() => expect(api.orderGets).toBeGreaterThan(0))
            await waitFor(() => expect(queryClient.isFetching()).toBe(0))
            const badge = () => screen.queryByTestId('admin-orders-pending-count')

            await waitFor(() =>
              expect(badge()?.textContent ?? null, 'the badge').toBe(
                total === 0 ? null : badgeText(total),
              ),
            )
            expect(badge()?.getAttribute('aria-hidden') ?? null).toBe(total === 0 ? null : 'true')
            expect(link).toHaveAccessibleName(
              total === 0 ? /^(?![\s\S]*pending)/ : new RegExp(`\\b${total} pending\\b`),
            )
          } finally {
            unmount()
            vi.unstubAllGlobals()
          }
        },
      ),
      // Each run renders the sidebar; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 12, endOnFailure: true },
    )
  }, 30_000)

  it('AC-7: an order placed, then one paid, elsewhere moves the badge to the server’s new count without a reload', async () => {
    const api = fakeApi(3)
    const { queryClient } = renderWithProviders(<Sidebar open onClose={() => {}} />)
    const link = screen.getByTestId('admin-nav-orders')
    await waitFor(() =>
      expect(screen.getByTestId('admin-orders-pending-count').textContent).toBe(
        badgeText(api.pending),
      ),
    )
    const handle = createEventHandlers(queryClient)

    api.pending += 1
    handle('order.placed.v1', { order: order('new', 'pending') })
    await waitFor(() =>
      expect(screen.getByTestId('admin-orders-pending-count').textContent).toBe(
        badgeText(api.pending),
      ),
    )
    expect(link).toHaveAccessibleName(new RegExp(`\\b${api.pending} pending\\b`))

    api.pending -= 1
    handle('order.paid.v1', {
      orderId: 'o-0',
      paymentIntentId: 'pi_1',
      amountMinor: 1000,
      currency: 'GBP',
    })
    await waitFor(() =>
      expect(link).toHaveAccessibleName(new RegExp(`\\b${api.pending} pending\\b`)),
    )
    expect(screen.getByTestId('admin-orders-pending-count').textContent).toBe(
      badgeText(api.pending),
    )
  })
})
