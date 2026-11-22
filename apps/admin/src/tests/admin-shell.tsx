import { render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { CustomersListPage } from '@/pages/CustomersListPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { InventoryPage } from '@/pages/InventoryPage'
import { OrdersListPage } from '@/pages/OrdersListPage'
import { ProductsListPage } from '@/pages/ProductsListPage'
import type { orderIn } from '@/tests/order-page'

// The signed-in admin as the router frames it: the layout around the real list pages and the dashboard, against a
// fake admin API whose lists a test can change. Pages a test only navigates to are a heading.

const AT = '2026-10-20T10:00:00.000Z'

export interface ShellData {
  orders: Array<ReturnType<typeof orderIn>>
  products: unknown[]
  customers: unknown[]
  inventory: unknown[]
}

export function product(id: string, name: string, slug: string) {
  return {
    id,
    slug,
    name,
    status: 'active',
    type: 'simple',
    media: [],
    variants: [
      { id: `${id}-v`, sku: `${slug}-sku`, priceMinor: 2500, stock: 10, lowStockThreshold: 2 },
    ],
    updatedAt: AT,
  }
}

export function customer(
  id: string,
  email: string,
  firstName: string | null,
  lastName: string | null,
) {
  return {
    id,
    email,
    firstName,
    lastName,
    orderCount: 2,
    totalSpentMinor: 5000,
    createdAt: AT,
    updatedAt: AT,
  }
}

export function inventoryRow(i: number) {
  return {
    variantId: `var-${i}`,
    productId: `prod-${i}`,
    productName: `Product ${i}`,
    sku: `SKU-${i}`,
    options: [],
    stock: 10 + i,
    threshold: 2,
    status: 'in_stock',
    updatedAt: AT,
  }
}

const DASHBOARD = {
  today: { day: '2026-01-01', timezone: 'UTC', paidOrders: 0, units: 0, money: [] },
  recentOrders: [],
  lowStock: [],
  agents: {
    since: AT,
    currency: 'GBP',
    surfaces: [],
    mcp: { enabled: false, writes: 'proposal' },
    profilePath: null,
    orders: { count: 0, revenueMinor: 0 },
    bySource: [],
  },
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

/** Stubs fetch with the admin API the shell and the list pages read; the lists ignore filters. */
export function fakeShellApi(seed: Partial<ShellData> = {}): ShellData {
  const data: ShellData = { orders: [], products: [], customers: [], inventory: [], ...seed }
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    switch (url.pathname) {
      case '/api/admin/orders':
        return json({ data: data.orders, meta: { total: data.orders.length } })
      case '/api/admin/products':
        return json({ data: data.products, meta: { total: data.products.length } })
      case '/api/admin/customers':
        return json({ data: { customers: data.customers } })
      case '/api/admin/inventory':
        return json({ data: data.inventory })
      case '/api/admin/dashboard':
        return json({ data: DASHBOARD })
      case '/api/admin/search':
        return json({ data: { orders: [], products: [], customers: [] } })
      case '/api/admin/proposals':
        return json({ data: { items: [], pending: 0 } })
      case '/api/admin/me':
        return json({ data: { userId: 'admin-1', roles: ['owner'], storeName: 'Test Store', environment: 'development' } })
      case '/api/admin/mail-health':
        return json({ data: { warning: null } })
      default:
        return json({ data: [] })
    }
  })
  return data
}

function Stand({ name }: { name: string }) {
  return <h1>{name}</h1>
}

export interface Shell extends RenderResult {
  queryClient: QueryClient
  /** The router's current path. */
  path: () => string
}

/** The data router builds a `Request` per navigation with jsdom's AbortSignal, which Node's `Request` refuses, so
 * every navigation would reject. These routes have no loaders, so the signal is dropped. */
class JsdomRequest extends Request {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {}
    super(input, rest)
  }
}

export function renderAdminShell(initialPath: string): Shell {
  vi.stubGlobal('Request', JsdomRequest)
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  })
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <AdminLayout />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'orders', element: <OrdersListPage /> },
          { path: 'orders/:orderNumber', element: <Stand name="Order" /> },
          { path: 'products', element: <ProductsListPage /> },
          { path: 'products/:slug', element: <Stand name="Product" /> },
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'customers', element: <CustomersListPage /> },
          { path: 'customers/:id', element: <Stand name="Customer" /> },
          { path: 'activity', element: <Stand name="Activity" /> },
          { path: 'inbox', element: <Stand name="Inbox" /> },
          { path: 'settings', element: <Stand name="Settings" /> },
        ],
      },
    ],
    { initialEntries: [initialPath] },
  )
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient, path: () => router.state.location.pathname }
}
