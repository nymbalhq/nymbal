import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { QueryClient } from '@tanstack/react-query'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page while its product changes elsewhere: a new copy of the product reaches the detail query as a stream
// frame's invalidation brings it (the query refetched against a fake admin API whose product the test changes). The
// routes are laid out as the admin's router lays them out: `products/new` and `products/:slug` siblings rendering one
// page with no key, so a navigation between products keeps the page instance.

const AT = '2026-11-19T10:00:00.000Z'

function variant(productId: string, i: number, stock: number): Variant {
  return {
    id: `${productId}-var-${i}`,
    productId,
    sku: `${productId.toUpperCase()}-${i}`,
    name: `Size ${i}`,
    priceMinor: 2500 + 100 * i,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock,
    lowStockThreshold: 2,
    options: [{ name: 'Size', value: `S${i}` }],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  }
}

function product(id: string, slug: string, name: string, description: string): ProductSnapshot {
  return {
    id,
    slug,
    name,
    description,
    shortDescription: '',
    status: 'active',
    type: 'variable',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    categoryIds: [],
    createdAt: AT,
    updatedAt: AT,
    variants: [variant(id, 0, 5), variant(id, 1, 3)],
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Patch = Partial<ProductSnapshot> & { variants?: Array<{ id: string; priceMinor: number }> }

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

/**
 * The admin products API over `products`, by id or slug. A PATCH writes the product fields the server's update writes,
 * and of its variants only the prices; a POST creates a product under a slug the server makes unique. `change` is an edit made elsewhere.
 */
function fakeApi(products: ProductSnapshot[]) {
  const byId = new Map(products.map((p) => [p.id, p]))
  const patches: Array<{ id: string; body: Patch }> = []
  const posts: Array<Record<string, unknown>> = []
  const find = (idOrSlug: string) =>
    byId.get(idOrSlug) ?? [...byId.values()].find((p) => p.slug === idOrSlug)

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'tok' } })
    if (url.pathname === '/api/admin/me') {
      return json({
        data: {
          userId: 'admin-1',
          roles: ['admin'],
          storeName: 'Test Store',
          environment: 'development',
          currency: 'GBP',
        },
      })
    }
    const one = /^\/api\/admin\/products\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && one) {
      const found = find(decodeURIComponent(one[1]!))
      return found
        ? json({ data: found })
        : json({ error: { code: 'product.not_found', message: 'Product not found' } }, 404)
    }
    if (method === 'PATCH' && one) {
      const id = decodeURIComponent(one[1]!)
      const body = JSON.parse(String(init.body)) as Patch
      patches.push({ id, body })
      const current = byId.get(id)!
      const prices = body.variants ?? []
      // The fields the update writes (services/product-service.ts): never the slug or the id.
      const written = Object.fromEntries(
        Object.entries(body).filter(([field]) => WRITTEN.includes(field)),
      )
      const next: ProductSnapshot = {
        ...current,
        ...written,
        variants: current.variants.map((v) => ({
          ...v,
          priceMinor: prices.find((sent) => sent.id === v.id)?.priceMinor ?? v.priceMinor,
        })),
      }
      byId.set(id, next)
      return json({ data: next })
    }
    if (method === 'POST' && url.pathname === '/api/admin/products') {
      const body = JSON.parse(String(init.body)) as ProductSnapshot
      posts.push(body as unknown as Record<string, unknown>)
      const created: ProductSnapshot = {
        ...product('prod-new', `${body.slug}-2`, body.name, 'Written by the server.'),
        variants: [],
      }
      byId.set(created.id, created)
      return json({ data: created }, 201)
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })

  return {
    patches,
    posts,
    current: (id: string) => byId.get(id)!,
    change: (id: string, edit: (p: ProductSnapshot) => ProductSnapshot) => {
      byId.set(id, edit(byId.get(id)!))
    },
  }
}

/** What a product frame does to the page's cache: invalidate the products queries, then wait for the refetch. */
async function streamBringsNewCopy(qc: QueryClient, slug: string): Promise<void> {
  const key = ['products', 'detail', slug]
  const before = qc.getQueryState(key)?.dataUpdatedAt ?? 0
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['products'] })
  })
  await waitFor(() => {
    const state = qc.getQueryState(key)
    expect(state?.fetchStatus, 'the detail refetch').toBe('idle')
    expect(state?.dataUpdatedAt ?? 0, 'a new copy in the detail query').toBeGreaterThan(before)
  })
}

function renderAt(initialPath: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/products/new" element={<ProductEditPage />} />
      <Route path="/products/:slug" element={<ProductEditPage />} />
    </Routes>,
    { initialPath, dataRouter: true },
  )
}

const nameField = () => screen.getByTestId('admin-product-name')
const descriptionField = () => screen.getByPlaceholderText('Describe this product...')
const slugField = () => screen.getByPlaceholderText('classic-white-t-shirt')
/** The Summary's Total stock, which reads the detail query's copy, not the form. */
const totalStockShown = () => Number(screen.getByText('Total stock').nextElementSibling?.textContent)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-10: a new copy of the product never replaces an unsaved edit, and an edit belongs to one product', () => {
  it('AC-10: a new copy shows while the form is clean; after typing, a new copy leaves every typed field as typed and Save sends them; after the save the form shows the PATCH answer and takes new copies again', async () => {
    const linen = product('prod-a', 'linen-shirt', 'Linen Shirt', 'Loose and light.')
    const api = fakeApi([linen])
    const user = userEvent.setup()
    const { queryClient } = renderAt(`/products/${linen.slug}`)
    await waitFor(() => expect(nameField()).toHaveValue(linen.name))

    api.change(linen.id, (p) => ({
      ...p,
      name: 'Linen Shirt, renamed elsewhere',
      variants: p.variants.map((v) => ({ ...v, stock: v.stock + 4 })),
    }))
    await streamBringsNewCopy(queryClient, linen.slug)
    await waitFor(() => expect(nameField()).toHaveValue('Linen Shirt, renamed elsewhere'))

    fireEvent.change(nameField(), { target: { value: 'Linen Shirt, typed here' } })
    fireEvent.change(descriptionField(), { target: { value: 'Typed here too.' } })
    api.change(linen.id, (p) => ({
      ...p,
      name: 'Renamed elsewhere again',
      description: 'Described elsewhere.',
      variants: p.variants.map((v) => ({ ...v, stock: 1 })),
    }))
    await streamBringsNewCopy(queryClient, linen.slug)
    await waitFor(() => expect(totalStockShown(), 'the page has the new copy').toBe(2))
    expect(nameField(), 'the typed name after a new copy').toHaveValue('Linen Shirt, typed here')
    expect(descriptionField(), 'the typed description after a new copy').toHaveValue(
      'Typed here too.',
    )

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())
    expect(
      api.patches.map((p) => p.id),
      'PATCHes sent',
    ).toEqual([linen.id])
    const sent = api.patches[0]!.body
    expect([sent.name, sent.description], 'the values Save sent').toEqual([
      'Linen Shirt, typed here',
      'Typed here too.',
    ])
    expect(sent.variants?.map((v) => v.id)).toEqual(linen.variants.map((v) => v.id))

    const answered = api.current(linen.id)
    await waitFor(() => expect(nameField(), 'the name after the save').toHaveValue(answered.name))
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    for (const v of answered.variants) {
      expect(
        await screen.findByTestId(`admin-product-variant-stock-${v.id}`),
        `${v.id}: the stock as the PATCH answered it`,
      ).toHaveTextContent(String(v.stock))
    }

    await user.click(screen.getByRole('tab', { name: 'General' }))
    api.change(linen.id, (p) => ({ ...p, name: 'Renamed elsewhere after the save' }))
    await streamBringsNewCopy(queryClient, linen.slug)
    await waitFor(() => expect(nameField()).toHaveValue('Renamed elsewhere after the save'))
  })

  it('AC-10: on /products/new, Create then shows the created product as GET /api/admin/products/:slug answers it, with no unsaved mark', async () => {
    const api = fakeApi([])
    const user = userEvent.setup()
    renderAt('/products/new')

    fireEvent.change(await screen.findByTestId('admin-product-name'), {
      target: { value: 'Cotton Tote' },
    })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.posts.length, 'POSTs sent').toBe(1))

    const created = api.current('prod-new')
    await waitFor(() => expect(slugField(), 'the slug the server gave').toHaveValue(created.slug))
    expect(descriptionField()).toHaveValue(created.description)
    expect(screen.queryByText('Unsaved changes'), 'the unsaved mark after Create').toBeNull()
  })
})
