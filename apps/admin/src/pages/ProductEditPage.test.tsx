import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page's save: the PATCH carries the variants the loaded product has, with their edited prices, whatever
// rows the table added, so a server that refuses an id the product does not have never fails the save.

const AT = '2026-10-20T10:00:00.000Z'

function variant(id: string, priceMinor: number, i: number): Variant {
  return {
    id,
    productId: 'prod-1',
    sku: `SKU-${i}`,
    name: `Size ${i}`,
    priceMinor,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: 4 + i,
    lowStockThreshold: 2,
    options: [{ name: 'Size', value: `S${i}` }],
    status: 'active',
    createdAt: AT,
    updatedAt: AT,
  }
}

const PRODUCT: ProductSnapshot = {
  id: 'prod-1',
  slug: 'linen-shirt',
  name: 'Linen Shirt',
  description: 'Loose and light.',
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
  variants: [variant('var-small', 2500, 0), variant('var-large', 2900, 1)],
} as unknown as ProductSnapshot

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** The admin API for this page: the product read, and each PATCH body recorded and answered as the server would. */
function fakeApi() {
  const patches: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'tok' } })
    if (method === 'GET' && url.pathname === `/api/admin/products/${PRODUCT.slug}`) {
      return json({ data: PRODUCT })
    }
    if (method === 'PATCH' && url.pathname === `/api/admin/products/${PRODUCT.id}`) {
      const body = JSON.parse(String(init.body)) as {
        description?: string
        variants?: Array<{ id: string; priceMinor: number }>
      }
      patches.push(body)
      const unknown = (body.variants ?? []).find(
        (v) => !PRODUCT.variants.some((own) => own.id === v.id),
      )
      if (unknown !== undefined) {
        return json(
          {
            error: {
              code: 'product.variant_unknown',
              message: `Variant ${unknown.id} is not this product's`,
            },
          },
          400,
        )
      }
      return json({
        data: {
          ...PRODUCT,
          description: body.description ?? PRODUCT.description,
          variants: PRODUCT.variants.map((v) => ({
            ...v,
            priceMinor: body.variants?.find((sent) => sent.id === v.id)?.priceMinor ?? v.priceMinor,
          })),
        },
      })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return { patches }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Product save', () => {
  it('AC-2: after Add Variant, a description edit and a price edit on an existing variant, Save sends one PATCH whose variants are exactly the loaded product’s, the edited one at its new price and no new-* row, and the page settles as saved', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: `/products/${PRODUCT.slug}` },
    )
    expect(await screen.findByTestId('admin-product-name')).toHaveValue(PRODUCT.name)

    fireEvent.change(screen.getByPlaceholderText('Describe this product...'), {
      target: { value: 'Loose, light and repriced.' },
    })
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    await user.click(await screen.findByRole('button', { name: /Add Variant/ }))
    const [edited, untouched] = PRODUCT.variants as [Variant, Variant]
    fireEvent.change(screen.getByTestId(`admin-product-variant-price-${edited.id}`), {
      target: { value: '21.50' },
    })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

    expect(api.patches.length, 'PATCHes sent').toBe(1)
    const sent = api.patches[0] as {
      description: string
      variants: Array<{ id: string; priceMinor: number }>
    }
    expect(sent.variants.map((v) => v.id)).toEqual(PRODUCT.variants.map((v) => v.id))
    expect(sent.variants.filter((v) => v.id.startsWith('new-'))).toEqual([])
    expect(Object.fromEntries(sent.variants.map((v) => [v.id, v.priceMinor]))).toEqual({
      [edited.id]: 2150,
      [untouched.id]: untouched.priceMinor,
    })
    expect(sent.description).toBe('Loose, light and repriced.')
  })
})
