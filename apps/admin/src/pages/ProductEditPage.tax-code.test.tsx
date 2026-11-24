import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot } from '@nymbalhq/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page's Tax code field against a fake admin API (fetch stubbed): the product's detail holds a code, and a
// PATCH or a POST records its body. What the field shows is the product's code; what the merchant types is what the
// save sends, and an emptied field sends no code (null), never '' (which the route refuses, and with it the whole save).

const AT = '2026-11-24T10:00:00.000Z'

const PRODUCT = {
  id: 'prod-1',
  slug: 'oat-milk',
  name: 'Oat Milk',
  description: 'Creamy.',
  shortDescription: '',
  status: 'active',
  type: 'simple',
  seoTitle: '',
  seoDescription: '',
  media: [],
  metadata: {},
  categoryIds: [],
  taxCode: 'reduced',
  createdAt: AT,
  updatedAt: AT,
  variants: [],
} as unknown as ProductSnapshot

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function fakeApi() {
  const patches: Array<Record<string, unknown>> = []
  const posts: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
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
    if (method === 'PATCH' && url.pathname === `/api/admin/products/${PRODUCT.id}`) {
      patches.push(body)
      return json({ data: { ...PRODUCT, ...body, variants: PRODUCT.variants } })
    }
    if (method === 'POST' && url.pathname === '/api/admin/products') {
      posts.push(body)
      return json({ data: { ...PRODUCT, ...body, id: 'prod-new', slug: 'made-here' } }, 201)
    }
    return json({ data: [] })
  })
  return { patches, posts }
}

function renderProduct(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/products/new" element={<ProductEditPage />} />
      <Route path="/products/:slug" element={<ProductEditPage />} />
    </Routes>,
    { initialPath: path, dataRouter: true },
  )
}

const field = () => screen.getByTestId('admin-product-tax-code')
const marked = () => screen.queryByText('Unsaved changes') !== null

async function openExisting() {
  await waitFor(() => expect(screen.getByTestId('admin-product-name')).toHaveValue(PRODUCT.name), {
    timeout: 3000,
  })
}

/** Types `value` over the field's content and saves; answers the one body the save sent. */
async function saveWith(
  value: string,
  sent: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  fireEvent.change(field(), { target: { value } })
  fireEvent.click(screen.getByTestId('admin-product-save'))
  await waitFor(() => expect(sent).toHaveLength(1))
  return sent[0]!
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the product page shows a product’s tax code and saves the one typed', () => {
  // Kills: a field that shows nothing of the product's code, or one held outside the form so Save sends the old code.
  it('AC-5: on a product whose taxCode is reduced the field shows it; typing marks "Unsaved changes" and Save’s one PATCH carries the typed code', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    renderProduct(`/products/${PRODUCT.slug}`)
    await openExisting()

    expect(await screen.findByTestId('admin-product-tax-code')).toHaveValue(PRODUCT.taxCode)
    expect(marked(), 'Unsaved changes on a fresh load').toBe(false)
    await user.clear(field())
    await user.type(field(), 'zero')

    expect(marked(), 'Unsaved changes after typing').toBe(true)
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.patches).toHaveLength(1))
    expect(api.patches[0]!['taxCode']).toBe('zero')
  })

  // Kills: an emptied field sent as '' (refused by the route with the whole save) or left out (so the code stays).
  it('AC-5: clearing the field, or leaving blanks only, sends taxCode: null', async () => {
    for (const emptied of ['', '   ']) {
      const api = fakeApi()
      const { unmount } = renderProduct(`/products/${PRODUCT.slug}`)
      try {
        await openExisting()
        await screen.findByTestId('admin-product-tax-code')
        const sent = await saveWith(emptied, api.patches)
        expect(
          Object.hasOwn(sent, 'taxCode') ? sent['taxCode'] : 'absent',
          JSON.stringify(emptied),
        ).toBeNull()
      } finally {
        unmount()
        vi.unstubAllGlobals()
      }
    }
  })

  // Kills: a typed code sent changed (cut, or another field's value), or blanks sent as a code.
  it('AC-5: property: for any text typed, Save’s PATCH carries null when it is blank, else that code', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.stringMatching(/^ {0,3}[a-z0-9_-]{1,64} {0,3}$/),
          fc.stringMatching(/^[ \t]{0,4}$/),
        ),
        async (typed) => {
          const api = fakeApi()
          const { unmount } = renderProduct(`/products/${PRODUCT.slug}`)
          try {
            await openExisting()
            await screen.findByTestId('admin-product-tax-code')
            const sent = await saveWith(typed, api.patches)
            const code = Object.hasOwn(sent, 'taxCode') ? sent['taxCode'] : 'absent'
            const expected = typed.trim() === '' ? null : typed.trim()
            expect(typeof code === 'string' ? code.trim() : code, JSON.stringify(typed)).toBe(
              expected,
            )
          } finally {
            unmount()
            vi.unstubAllGlobals()
          }
        },
      ),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 6, endOnFailure: true },
    )
  }, 30_000)

  // Kills: a new product's typed code dropped from the create, or an untouched field sent as ''.
  it('AC-5: on /products/new the create’s POST carries the code typed, and no code when none was', async () => {
    const typed = fakeApi()
    const user = userEvent.setup()
    const first = renderProduct('/products/new')
    fireEvent.change(await screen.findByTestId('admin-product-name'), {
      target: { value: 'Rice Milk' },
    })
    await user.type(await screen.findByTestId('admin-product-tax-code'), 'reduced')
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(typed.posts).toHaveLength(1))
    first.unmount()
    vi.unstubAllGlobals()

    const untouched = fakeApi()
    renderProduct('/products/new')
    fireEvent.change(await screen.findByTestId('admin-product-name'), {
      target: { value: 'Soy Milk' },
    })
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(untouched.posts).toHaveLength(1))

    expect(typed.posts[0]!['taxCode']).toBe('reduced')
    expect(untouched.posts[0]!['taxCode'] ?? null).toBeNull()
  })
})
