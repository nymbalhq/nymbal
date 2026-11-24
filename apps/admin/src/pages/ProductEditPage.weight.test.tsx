import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// A weight typed on the product page is part of what Save sends: on an existing product the one PATCH carries every own
// variant's weight beside its prices and GTIN, and on a new product the create carries each row's weight. A page that
// shows the field and saves only the prices is a green Save that stores no weight.

const AT = '2026-10-20T10:00:00.000Z'

function variant(id: string, i: number, weightGrams: number | null): Variant {
  return {
    id,
    productId: 'prod-1',
    sku: `LIN-${i}`,
    name: `Size ${i}`,
    priceMinor: 2500 + i * 400,
    compareAtPriceMinor: i === 0 ? 3000 : null,
    weightGrams,
    dimensions: null,
    stock: 4 + i,
    lowStockThreshold: 2,
    options: [{ name: 'Size', value: `S${i}` }],
    status: 'active',
    gtin: null,
    createdAt: AT,
    updatedAt: AT,
  }
}

const PRODUCT = {
  id: 'prod-1',
  slug: 'linen-shirt',
  name: 'Linen Shirt',
  description: 'Loose and light.',
  shortDescription: '',
  status: 'active',
  type: 'variable',
  seoTitle: '',
  seoDescription: '',
  brand: '',
  media: [],
  metadata: {},
  categoryIds: [],
  createdAt: AT,
  updatedAt: AT,
  variants: [variant('var-small', 0, 420), variant('var-large', 1, null)],
} as unknown as ProductSnapshot

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The admin API for this page: the product read, and each PATCH and POST body recorded and answered as stored. */
function fakeApi() {
  const patches: Array<{ variants: Array<Record<string, unknown>> }> = []
  const posts: Array<{ variants: Array<Record<string, unknown>> }> = []
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
    if (method === 'GET' && url.pathname === `/api/admin/products/${PRODUCT.slug}`) {
      return json({ data: PRODUCT })
    }
    if (method === 'POST' && url.pathname === '/api/admin/products') {
      const body = JSON.parse(String(init.body)) as (typeof posts)[number]
      posts.push(body)
      return json({ data: { ...PRODUCT, ...body, id: 'prod-new', slug: 'wool-scarf' } }, 201)
    }
    if (method === 'PATCH' && url.pathname === `/api/admin/products/${PRODUCT.id}`) {
      const body = JSON.parse(String(init.body)) as (typeof patches)[number]
      patches.push(body)
      return json({
        data: {
          ...PRODUCT,
          variants: PRODUCT.variants.map((v) => {
            const sent = body.variants.find((entry) => entry['id'] === v.id)
            return sent === undefined ? v : { ...v, ...sent }
          }),
        },
      })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return { patches, posts }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a variant’s weight saved from the product page', () => {
  // Kills: handleSave mapping a row to its prices and GTIN alone, so the typed weight never leaves the page; or a
  // weight sent for the edited variant only, clearing the other's.
  it('AC-6: on an existing product a weight typed marks Unsaved changes, and Save’s one PATCH carries every own variant as { id, priceMinor, compareAtPriceMinor, gtin, weightGrams }, the typed one at its grams and the other at its stored weight', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: `/products/${PRODUCT.slug}`, dataRouter: true },
    )
    await waitFor(() => expect(screen.getByTestId('admin-product-name')).toHaveValue(PRODUCT.name))
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    const [small, large] = PRODUCT.variants as [Variant, Variant]
    const weight = await screen.findByTestId(`admin-product-variant-weight-${large.id}`)
    const dirtyBefore = screen.queryByText('Unsaved changes') !== null

    fireEvent.change(weight, { target: { value: '750' } })
    const dirtyAfter = screen.queryByText('Unsaved changes') !== null
    expect([dirtyBefore, dirtyAfter], 'Unsaved changes before and after the weight').toEqual([
      false,
      true,
    ])
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

    expect(api.patches.length, 'PATCHes sent').toBe(1)
    const sent = api.patches[0]!.variants
    expect(sent.map((v) => Object.keys(v).sort())).toEqual(
      PRODUCT.variants.map(() => [
        'compareAtPriceMinor',
        'gtin',
        'id',
        'priceMinor',
        'weightGrams',
      ]),
    )
    expect(sent).toEqual(
      [small, large].map((v) => ({
        id: v.id,
        priceMinor: v.priceMinor,
        compareAtPriceMinor: v.compareAtPriceMinor,
        gtin: v.gtin,
        weightGrams: v.id === large.id ? 750 : v.weightGrams,
      })),
    )
  })

  // Kills: the new row's weight input not wired to the form, so create sends the empty row's null for every row.
  it('AC-6: on /products/new the create’s POST carries each row’s weightGrams: the grams typed, and null for a row left empty', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: '/products/new', dataRouter: true },
    )
    fireEvent.change(await screen.findByTestId('admin-product-name'), {
      target: { value: 'Wool Scarf' },
    })
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    const add = await screen.findByRole('button', { name: /Add Variant/ })
    await user.click(add)
    await user.click(add)
    const typed = ['250', '']
    screen.getAllByTestId(/^admin-product-variant-row-/).forEach((row, i) => {
      fireEvent.change(within(row).getByTestId(/^admin-product-variant-weight-/), {
        target: { value: typed[i] },
      })
    })

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.posts.length, 'POSTs sent').toBe(1))
    expect(api.posts[0]!.variants.map((v) => v['weightGrams'])).toEqual([250, null])
  })
})
