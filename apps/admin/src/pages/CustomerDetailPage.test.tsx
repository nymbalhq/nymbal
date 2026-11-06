import { screen } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { orderIn } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { CustomerDetailPage } from './CustomerDetailPage'

// The customer page against a fake admin API that answers each route in its real envelope.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const CUSTOMER = {
  id: 'c-1',
  email: 'grace.orders@customers.test',
  firstName: 'Grace',
  lastName: 'Buyer',
  phone: '',
  addresses: [],
  orderCount: 3,
  totalSpentMinor: 6500,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
}

const ORDERS = [
  orderIn('delivered', { id: 'o-31', orderNumber: 'NYM-1031' }),
  orderIn('partially_refunded', { id: 'o-32', orderNumber: 'NYM-1032' }),
  orderIn('pending', { id: 'o-33', orderNumber: 'NYM-1033' }),
].map((o) => ({ ...o, customerId: CUSTOMER.id }))

function fakeApi() {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === `/api/admin/customers/${CUSTOMER.id}`) {
      return json({
        data: {
          customer: CUSTOMER,
          stats: {
            orderCount: 3,
            lifetimeRevenueMinor: 3500,
            avgOrderValueMinor: 1750,
            firstOrderAt: ORDERS[0]!.createdAt,
            lastOrderAt: ORDERS[2]!.createdAt,
          },
        },
      })
    }
    // GET /api/admin/customers/:id/orders answers `ok(orders)`: the array is the envelope's data.
    if (url.pathname === `/api/admin/customers/${CUSTOMER.id}/orders`) return json({ data: ORDERS })
    return json({ data: {} })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the customer’s Order History', () => {
  // Kills: the hook reading `.orders` of the route's array, which is undefined, so the tab says "No orders".
  it('AC-2: with the orders route answering { data: [order, …] }, Order History shows one row per order, each with its order number', async () => {
    fakeApi()
    renderWithProviders(
      <Routes>
        <Route path="/customers/:id" element={<CustomerDetailPage />} />
      </Routes>,
      { initialPath: `/customers/${CUSTOMER.id}` },
    )

    for (const order of ORDERS) {
      const row = await screen.findByTestId(`admin-customer-orders-row-${order.id}`, undefined, {
        timeout: 3000,
      })
      expect(row).toHaveTextContent(order.orderNumber)
    }
    const rows = [...document.querySelectorAll('[data-testid^="admin-customer-orders-row-"]')]
    expect(rows.map((r) => r.getAttribute('data-testid')).sort(), 'Order History rows').toEqual(
      ORDERS.map((o) => `admin-customer-orders-row-${o.id}`).sort(),
    )
  })
})
