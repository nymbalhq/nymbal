import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot, Variant } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page on an existing product offers only what its save keeps: SKU, name, stock and status read as text
// (stock a link to the variant in Inventory), price, GTIN and weight the inputs, no Add or Delete Variant; Save sends one
// PATCH whose variants are the loaded product's prices, GTINs and weights alone. On a new product the table stays
// editable, and Create sends the rows it holds with their stock. The product's brand is an input of the form, saved with
// it.

const AT = '2026-10-20T10:00:00.000Z'
const GTIN_A = '4006381333931'
const GTIN_B = '036000291452'
/** A GTIN-13 with a wrong check digit: the server refuses it. */
const NOT_A_GTIN = '4006381333932'
const GTIN_ISSUE = 'a GTIN is 8, 12, 13 or 14 digits ending in its check digit'

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
    gtin: i === 0 ? GTIN_A : null,
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
  brand: 'Acme',
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
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push(body)
      return json({ data: { ...PRODUCT, ...body, id: 'prod-new' } }, 201)
    }
    if (method === 'PATCH' && url.pathname === `/api/admin/products/${PRODUCT.id}`) {
      const body = JSON.parse(String(init.body)) as {
        description?: string
        brand?: string
        variants?: Array<{ id: string; priceMinor: number; gtin?: string | null }>
      }
      patches.push(body)
      const refused = (body.variants ?? []).findIndex((v) => v.gtin === NOT_A_GTIN)
      if (refused >= 0) {
        return json(
          {
            error: {
              code: 'validation.failed',
              message: 'The request input is invalid',
              context: {
                issues: [{ path: ['body', 'variants', refused, 'gtin'], message: GTIN_ISSUE }],
              },
            },
          },
          400,
        )
      }
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
          brand: body.brand ?? PRODUCT.brand,
          variants: PRODUCT.variants.map((v) => {
            const sent = body.variants?.find((entry) => entry.id === v.id)
            return {
              ...v,
              priceMinor: sent?.priceMinor ?? v.priceMinor,
              gtin: sent === undefined || sent.gtin === undefined ? v.gtin : sent.gtin || null,
            }
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

const SENT_KEYS = ['compareAtPriceMinor', 'gtin', 'id', 'priceMinor', 'weightGrams']

describe('Product save', () => {
  it('AC-7: on an existing product the Variants tab shows SKU, name, stock and status as text, the stock a link to /inventory?q=<sku>, price, GTIN and weight the inputs, no Add Variant and no delete; a price edit then Save sends one PATCH whose variants are exactly the loaded ids, each { id, priceMinor, compareAtPriceMinor, gtin, weightGrams }, the edited one at its new price', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: `/products/${PRODUCT.slug}`, dataRouter: true },
    )
    // The form renders one commit before the loaded product fills it, so wait for the value, not the input.
    await waitFor(() => expect(screen.getByTestId('admin-product-name')).toHaveValue(PRODUCT.name))

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
        inputs.map((el) => el.getAttribute('data-testid')).sort(),
        `${v.id}: the row's inputs are its price, its GTIN and its weight`,
      ).toEqual([
        `admin-product-variant-gtin-${v.id}`,
        `admin-product-variant-price-${v.id}`,
        `admin-product-variant-weight-${v.id}`,
      ])
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
      {
        id: edited.id,
        priceMinor: 2150,
        compareAtPriceMinor: edited.compareAtPriceMinor,
        gtin: edited.gtin,
        weightGrams: edited.weightGrams,
      },
      {
        id: untouched.id,
        priceMinor: untouched.priceMinor,
        compareAtPriceMinor: untouched.compareAtPriceMinor,
        gtin: untouched.gtin,
        weightGrams: untouched.weightGrams,
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
      { initialPath: '/products/new', dataRouter: true },
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

/** The element with this test id, on whichever tab of the form holds it (tabs render only their active panel). */
async function onSomeTab(
  user: ReturnType<typeof userEvent.setup>,
  testId: string,
): Promise<HTMLElement> {
  const here = screen.queryByTestId(testId)
  if (here !== null) return here
  for (const tab of screen.getAllByRole('tab')) {
    await user.click(tab)
    const found = screen.queryByTestId(testId)
    if (found !== null) return found
  }
  throw new Error(`no tab of the product form holds ${testId}`)
}

const existingPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/products/:slug" element={<ProductEditPage />} />
    </Routes>,
    { initialPath: `/products/${PRODUCT.slug}`, dataRouter: true },
  )

describe('Brand and GTIN on the product form', () => {
  it("AC-10: an existing product shows its brand and each variant's GTIN; changing the brand, clearing one GTIN and setting another, then Save, sends one PATCH holding the brand, each own variant's entry holding gtin beside id, priceMinor and compareAtPriceMinor, the cleared one blank or null", async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    existingPage()
    expect(await screen.findByTestId('admin-product-name')).toHaveValue(PRODUCT.name)
    const [small, large] = PRODUCT.variants as [Variant, Variant]

    const brand = await onSomeTab(user, 'admin-product-brand')
    expect(brand).toHaveValue('Acme')
    fireEvent.change(brand, { target: { value: 'Northwind' } })

    await user.click(screen.getByTestId('admin-product-tab-variants'))
    const smallGtin = await screen.findByTestId(`admin-product-variant-gtin-${small.id}`)
    const largeGtin = screen.getByTestId(`admin-product-variant-gtin-${large.id}`)
    expect([smallGtin, largeGtin].map((el) => (el as HTMLInputElement).value)).toEqual([GTIN_A, ''])
    fireEvent.change(smallGtin, { target: { value: '' } })
    fireEvent.change(largeGtin, { target: { value: GTIN_B } })

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(screen.queryByText('Unsaved changes')).toBeNull())

    expect(api.patches.length, 'PATCHes sent').toBe(1)
    const sent = api.patches[0] as { brand?: unknown; variants: Array<Record<string, unknown>> }
    expect(sent.brand).toBe('Northwind')
    for (const v of sent.variants) {
      expect(Object.keys(v).sort(), `${String(v['id'])}: the keys sent`).toEqual(SENT_KEYS)
    }
    const byId = new Map(sent.variants.map((v) => [v['id'], v]))
    expect([byId.get(large.id)?.['gtin'], byId.get(large.id)?.['priceMinor']]).toEqual([
      GTIN_B,
      large.priceMinor,
    ])
    expect(['', null], 'a cleared GTIN is sent blank or null, never left out').toContain(
      byId.get(small.id)?.['gtin'],
    )
  })

  it("AC-10: a new product's Create sends its brand and each new variant's GTIN", async () => {
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
    fireEvent.change(await onSomeTab(user, 'admin-product-brand'), {
      target: { value: 'Highland Mills' },
    })
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    const add = await screen.findByRole('button', { name: /Add Variant/ })
    await user.click(add)
    await user.click(add)
    const gtins = [GTIN_A, GTIN_B]
    screen.getAllByTestId(/^admin-product-variant-row-/).forEach((row, i) => {
      fireEvent.change(within(row).getByTestId(/^admin-product-variant-gtin-/), {
        target: { value: gtins[i] },
      })
    })

    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.posts.length, 'POSTs sent').toBe(1))
    const created = api.posts[0] as { brand?: unknown; variants: Array<{ gtin?: unknown }> }
    expect([created.brand, created.variants.map((v) => v.gtin)]).toEqual(['Highland Mills', gtins])
  })

  it('AC-10: when the server refuses a GTIN with 400, the form keeps the typed GTIN and brand and shows the refusal', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    existingPage()
    expect(await screen.findByTestId('admin-product-name')).toHaveValue(PRODUCT.name)
    const large = PRODUCT.variants[1]!

    fireEvent.change(await onSomeTab(user, 'admin-product-brand'), {
      target: { value: 'Northwind' },
    })
    await user.click(screen.getByTestId('admin-product-tab-variants'))
    fireEvent.change(await screen.findByTestId(`admin-product-variant-gtin-${large.id}`), {
      target: { value: NOT_A_GTIN },
    })
    await user.click(screen.getByTestId('admin-product-save'))

    expect(await screen.findByText(GTIN_ISSUE, { exact: false })).toBeInTheDocument()
    expect(api.patches.length, 'PATCHes sent').toBe(1)
    expect(screen.getByTestId(`admin-product-variant-gtin-${large.id}`)).toHaveValue(NOT_A_GTIN)
    expect(await onSomeTab(user, 'admin-product-brand')).toHaveValue('Northwind')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })
})
