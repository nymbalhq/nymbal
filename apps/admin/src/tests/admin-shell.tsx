import { render, type RenderResult } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { CustomersListPage } from '@/pages/CustomersListPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { InventoryPage } from '@/pages/InventoryPage'
import { OrdersListPage } from '@/pages/OrdersListPage'
import { ProductEditPage } from '@/pages/ProductEditPage'
import { ProductsListPage } from '@/pages/ProductsListPage'
import type { orderIn } from '@/tests/order-page'
import { JsdomRequest } from '@/tests/render'

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** One request the fake API answered, its JSON body parsed. */
export interface ShellRequest {
  method: string
  path: string
  body: unknown
}

export interface ShellApi extends ShellData {
  /** Every request, in the order sent. */
  requests: ShellRequest[]
}

/** The product fields the server's update writes (never the slug or the id); of the variants, only their prices. */
const WRITTEN = [
  'name',
  'description',
  'shortDescription',
  'status',
  'type',
  'seoTitle',
  'seoDescription',
  'media',
  'metadata',
]

type Seeded = { id: string; slug: string; name?: string; variants?: Array<{ id: string; priceMinor: number }> }

/**
 * Stubs fetch with the admin API the shell and the list pages read; the lists ignore filters. A product's detail is
 * read by id or slug from `products`; a PATCH writes the fields the server's update writes into a new copy of the
 * product; a POST creates a product under the slug the server makes unique (`<sent>-2`); search matches product names.
 */
export function fakeShellApi(seed: Partial<ShellData> = {}): ShellApi {
  const data: ShellApi = {
    orders: [],
    products: [],
    customers: [],
    inventory: [],
    ...seed,
    requests: [],
  }
  const products = () => data.products as Seeded[]
  const find = (idOrSlug: string) => products().find((p) => p.id === idOrSlug || p.slug === idOrSlug)
  let created = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    data.requests.push({ method, path: url.pathname, body })

    const one = /^\/api\/admin\/products\/([^/]+)$/.exec(url.pathname)
    if (one && method === 'GET') {
      const found = find(decodeURIComponent(one[1]!))
      return found
        ? json({ data: found })
        : json({ error: { code: 'product.not_found', message: 'Product not found' } }, 404)
    }
    if (one && method === 'PATCH') {
      const current = find(decodeURIComponent(one[1]!))
      if (!current) return json({ error: { code: 'product.not_found', message: 'Product not found' } }, 404)
      const sent = body as Record<string, unknown> & { variants?: Array<{ id: string; priceMinor: number }> }
      const written = Object.fromEntries(Object.entries(sent).filter(([field]) => WRITTEN.includes(field)))
      const next: Seeded = {
        ...current,
        ...written,
        variants: (current.variants ?? []).map((v) => ({
          ...v,
          priceMinor: sent.variants?.find((p) => p.id === v.id)?.priceMinor ?? v.priceMinor,
        })),
      }
      data.products = products().map((p) => (p.id === current.id ? next : p))
      return json({ data: next })
    }
    if (url.pathname === '/api/admin/products' && method === 'POST') {
      created += 1
      const sent = body as Record<string, unknown> & { slug: string }
      const product = { ...sent, id: `prod-created-${created}`, slug: `${sent.slug}-2`, createdAt: AT, updatedAt: AT }
      data.products = [...products(), product]
      return json({ data: product }, 201)
    }

    switch (url.pathname) {
      case '/api/csrf':
        return json({ data: { token: 'tok' } })
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
      case '/api/admin/search': {
        const q = (url.searchParams.get('q') ?? '').toLowerCase()
        const found = products().filter((p) => (p.name ?? '').toLowerCase().includes(q))
        return json({ data: { orders: [], products: found, customers: [] } })
      }
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
  router: ReturnType<typeof createMemoryRouter>
}

export interface ShellOptions {
  /** `products/new` and `products/:slug` render the real product page, and `/login` a heading. */
  productPage?: boolean
}

export function renderAdminShell(initialPath: string, { productPage = false }: ShellOptions = {}): Shell {
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
          ...(productPage
            ? [
                { path: 'products/new', element: <ProductEditPage /> },
                { path: 'products/:slug', element: <ProductEditPage /> },
              ]
            : [{ path: 'products/:slug', element: <Stand name="Product" /> }]),
          { path: 'inventory', element: <InventoryPage /> },
          { path: 'customers', element: <CustomersListPage /> },
          { path: 'customers/:id', element: <Stand name="Customer" /> },
          { path: 'activity', element: <Stand name="Activity" /> },
          { path: 'inbox', element: <Stand name="Inbox" /> },
          { path: 'settings', element: <Stand name="Settings" /> },
        ],
      },
      ...(productPage ? [{ path: '/login', element: <Stand name="Sign in" /> }] : []),
    ],
    { initialEntries: [initialPath] },
  )
  const result = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { ...result, queryClient, path: () => router.state.location.pathname, router }
}
