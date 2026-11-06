import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page on an existing product offers only what its save keeps: SKU, name, stock and status read as text
// (stock a link to the variant in Inventory), price the one input, no Add or Delete Variant; Save sends one PATCH
// whose variants are the loaded product's prices alone. On a new product the table stays editable, and Create sends
// the rows it holds with their stock.

const AT = '2026-10-20T10:00:00.000Z'

function variant(id: string, priceMinor: number, i: number): Variant {
  return {
    id,
    productId: 'prod-1',
    sku: `LIN+${i} S`,
    name: `Size ${i}`,
    priceMinor,
    compareAtPriceMinor: null,
    weightGrams: null,
    dimensions: null,
    stock: 4 + i,
    lowStockThreshold: 2,
    options: [{ name: 'Size', value: `S${i}` }],
    status: i === 0 ? 'active' : 'inactive',
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
  const posts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'tok' } })
    if (method === 'GET' && url.pathname === `/api/admin/products/${PRODUCT.slug}`) {
      return json({ data: PRODUCT })
    }
    if (method === 'POST' && url.pathname === '/api/admin/products') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push(body)
      return json({ data: { ...PRODUCT, ...body, id: 'prod-new' } }, 201)
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
  return { patches, posts }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const SENT_KEYS = ['compareAtPriceMinor', 'id', 'priceMinor']

describe('Product save', () => {
  it('AC-7: on an existing product the Variants tab shows SKU, name, stock and status as text, the stock a link to /inventory?q=<sku>, price the one input, no Add Variant and no delete; a price edit then Save sends one PATCH whose variants are exactly the loaded ids, each { id, priceMinor, compareAtPriceMinor }, the edited one at its new price', async () => {
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
    const [edited, untouched] = PRODUCT.variants as [Variant, Variant]
    const price = await screen.findByTestId(`admin-product-variant-price-${edited.id}`)

    expect(screen.queryAllByRole('button', { name: /Add Variant/ }), 'Add Variant').toEqual([])
    expect(screen.queryAllByRole('button', { name: /remove|delete/i }), 'a delete button').toEqual(
      [],
    )
    for (const v of PRODUCT.variants) {
      const row = screen.getByTestId(`admin-product-variant-row-${v.id}`)
      const inputs = within(row).queryAllByRole('textbox')
      expect(
        inputs.map((el) => el.getAttribute('data-testid')),
        `${v.id}: the row's only input is its price`,
      ).toEqual([`admin-product-variant-price-${v.id}`])
      expect(within(row).queryAllByRole('spinbutton'), `${v.id}: no stock input`).toEqual([])
      expect(within(row).queryAllByRole('combobox'), `${v.id}: no status select`).toEqual([])
      expect(within(row).getByText(v.sku)).toBeInTheDocument()
      expect(within(row).getByText(v.name)).toBeInTheDocument()
      expect(within(row).getByText(new RegExp(`^${v.status}$`, 'i'))).toBeInTheDocument()
      const stock = within(row).getByTestId(`admin-product-variant-stock-${v.id}`)
      expect(stock).toHaveTextContent(String(v.stock))
      const href = new URL(stock.getAttribute('href') ?? '', 'http://admin.test')
      expect([href.pathname, href.searchParams.get('q')], `${v.id}: the stock link`).toEqual([
        '/inventory',
        v.sku,
      ])
    }

    fireEvent.change(price, { target: { value: '21.50' } })
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

    expect(api.patches.length, 'PATCHes sent').toBe(1)
    const sent = api.patches[0] as {
      description: string
      variants: Array<Record<string, unknown>>
    }
    expect(sent.variants.map((v) => v['id'])).toEqual(PRODUCT.variants.map((v) => v.id))
    for (const v of sent.variants) {
      expect(Object.keys(v).sort(), `${String(v['id'])}: the keys sent`).toEqual(SENT_KEYS)
    }
    expect(sent.variants).toEqual([
      { id: edited.id, priceMinor: 2150, compareAtPriceMinor: edited.compareAtPriceMinor },
      {
        id: untouched.id,
        priceMinor: untouched.priceMinor,
        compareAtPriceMinor: untouched.compareAtPriceMinor,
      },
    ])
    expect(sent.description).toBe('Loose, light and repriced.')
  })

  it('AC-7: on /products/new the table keeps Add Variant, the delete button and the stock input, and Create sends the rows added with the stock entered', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: '/products/new' },
    )
    fireEvent.change(await screen.findByTestId('admin-product-name'), {
      target: { value: 'Wool Scarf' },
    })
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    const add = await screen.findByRole('button', { name: /Add Variant/ })
    await user.click(add)
    await user.click(add)
    await user.click(add)
    const rows = () => screen.getAllByTestId(/^admin-product-variant-row-/)
    expect(rows().length, 'rows after three adds').toBe(3)

    await user.click(within(rows()[2]!).getByRole('button', { name: /remove|delete/i }))
    expect(rows().length, 'rows after one delete').toBe(2)
    const stocks = [7, 3]
    rows().forEach((row, i) => {
      fireEvent.change(within(row).getByRole('spinbutton'), {
        target: { value: String(stocks[i]) },
      })
    })

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.posts.length, 'POSTs sent').toBe(1))
    const created = api.posts[0] as { name: string; variants: Array<{ stock: number }> }
    expect(created.name).toBe('Wool Scarf')
    expect(created.variants.map((v) => v.stock)).toEqual(stocks)
  })
})
