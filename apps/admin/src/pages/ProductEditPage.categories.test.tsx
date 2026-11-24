import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { Route, Routes } from 'react-router-dom'
import type { Category, ProductSnapshot } from '@nymbalhq/types'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product page's Categories card against a fake admin API (fetch stubbed): `GET /api/admin/categories` answers the
// store's categories, the product's detail names the ones it is in, and a PATCH or a POST records its body. What the
// card shows checked is what the product is in; what the merchant checks is what the save sends.

const AT = '2026-11-24T10:00:00.000Z'

function category(id: string, name: string, parentId: string | null, position: number): Category {
  return {
    id,
    name,
    slug: id.replace(/^cat-/, ''),
    description: '',
    parentId,
    position,
    createdAt: AT,
  }
}

const GARDEN = category('cat-garden', 'Garden', null, 0)
const SHOES = category('cat-shoes', 'Shoes', null, 1)
const BOOTS = category('cat-boots', 'Boots', SHOES.id, 0)
const CATEGORIES = [GARDEN, SHOES, BOOTS]

const PRODUCT = {
  id: 'prod-1',
  slug: 'linen-shirt',
  name: 'Linen Shirt',
  description: 'Loose and light.',
  shortDescription: '',
  status: 'active',
  type: 'simple',
  seoTitle: '',
  seoDescription: '',
  media: [],
  metadata: {},
  categoryIds: [SHOES.id],
  createdAt: AT,
  updatedAt: AT,
  variants: [],
} as unknown as ProductSnapshot

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function fakeApi(categories: Category[]) {
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
    if (method === 'GET' && url.pathname === '/api/admin/categories') {
      return json({ data: categories })
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

const box = (id: string) => screen.getByTestId(`admin-product-category-${id}`)
/** A native checkbox's state, or a checkbox role's. */
const isChecked = (el: HTMLElement) =>
  el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true'
const checkedIds = () =>
  CATEGORIES.filter((c) => screen.queryByTestId(`admin-product-category-${c.id}`) !== null)
    .filter((c) => isChecked(box(c.id)))
    .map((c) => c.id)
const sorted = (ids: unknown) => [...(ids as string[])].sort()
const marked = () => screen.queryByText('Unsaved changes') !== null

async function openExisting() {
  await waitFor(() => expect(screen.getByTestId('admin-product-name')).toHaveValue(PRODUCT.name), {
    timeout: 3000,
  })
  await screen.findByTestId(`admin-product-category-${BOOTS.id}`, undefined, { timeout: 3000 })
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the product page says which categories the product is in and changes them', () => {
  // Kills: a product's categories seen nowhere, or the card checked from something other than the product's own ids.
  it('AC-7: on a product in one of three categories, the card shows a checkbox per category, labelled with its name, and only that one is checked', async () => {
    fakeApi(CATEGORIES)
    renderProduct(`/products/${PRODUCT.slug}`)
    await openExisting()

    const card = screen.getByTestId('admin-product-categories')
    const boxes = within(card).queryAllByTestId(/^admin-product-category-/)
    expect(boxes.map((el) => el.getAttribute('data-testid')).sort()).toEqual(
      CATEGORIES.map((c) => `admin-product-category-${c.id}`).sort(),
    )
    for (const c of CATEGORIES) expect(box(c.id)).toHaveAccessibleName(c.name)
    expect(checkedIds()).toEqual(PRODUCT.categoryIds)
    expect(marked(), 'Unsaved changes on a fresh load').toBe(false)
  })

  // Kills: a toggle kept outside the form, so the save sends the product's old categories; a toggle that does not
  // mark the form unsaved, so the merchant may leave without saving it.
  it('AC-7: checking a second category marks "Unsaved changes", and Save’s one PATCH carries categoryIds equal to the two checked ids', async () => {
    const api = fakeApi(CATEGORIES)
    const user = userEvent.setup()
    renderProduct(`/products/${PRODUCT.slug}`)
    await openExisting()
    expect(marked(), 'Unsaved changes before the toggle').toBe(false)

    await user.click(box(GARDEN.id))

    expect(marked(), 'Unsaved changes after the toggle').toBe(true)
    expect(sorted(checkedIds())).toEqual(sorted([SHOES.id, GARDEN.id]))
    await user.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.patches).toHaveLength(1))
    expect(sorted(api.patches[0]!['categoryIds'])).toEqual(sorted([SHOES.id, GARDEN.id]))
  })

  // Kills: a card that adds on check but never removes, or sends the ids toggled rather than the ids checked.
  it('AC-7: property: after any sequence of toggles, the PATCH’s categoryIds are exactly the ids then checked', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...CATEGORIES.map((c) => c.id)), { minLength: 1, maxLength: 6 }),
        async (toggles) => {
          const api = fakeApi(CATEGORIES)
          const { unmount } = renderProduct(`/products/${PRODUCT.slug}`)
          try {
            await openExisting()
            const model = new Set(PRODUCT.categoryIds)
            for (const id of toggles) {
              fireEvent.click(box(id))
              if (model.has(id)) model.delete(id)
              else model.add(id)
            }
            expect(sorted(checkedIds()), `toggles ${JSON.stringify(toggles)}`).toEqual(
              sorted([...model]),
            )
            fireEvent.click(screen.getByTestId('admin-product-save'))
            await waitFor(() => expect(api.patches).toHaveLength(1))
            expect(
              sorted(api.patches[0]!['categoryIds']),
              `toggles ${JSON.stringify(toggles)}`,
            ).toEqual(sorted([...model]))
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

  // Kills: a new product's checked categories dropped from the create, so it is made in none.
  it('AC-7: on /products/new the create’s POST carries the checked ids', async () => {
    const api = fakeApi(CATEGORIES)
    const user = userEvent.setup()
    renderProduct('/products/new')
    await screen.findByTestId(`admin-product-category-${BOOTS.id}`, undefined, { timeout: 3000 })
    expect(checkedIds(), 'a new product’s card').toEqual([])

    fireEvent.change(screen.getByTestId('admin-product-name'), { target: { value: 'Rain Boots' } })
    await user.click(box(BOOTS.id))
    await user.click(box(GARDEN.id))
    await user.click(screen.getByTestId('admin-product-save'))

    await waitFor(() => expect(api.posts).toHaveLength(1))
    expect(sorted(api.posts[0]!['categoryIds'])).toEqual(sorted([BOOTS.id, GARDEN.id]))
  })

  // Kills: an empty card that leaves the merchant nowhere to make a category.
  it('AC-7: with no categories the card reads "No categories yet." with a link to /categories and holds no checkbox', async () => {
    fakeApi([])
    renderProduct(`/products/${PRODUCT.slug}`)
    await waitFor(
      () => expect(screen.getByTestId('admin-product-name')).toHaveValue(PRODUCT.name),
      {
        timeout: 3000,
      },
    )

    const card = await screen.findByTestId('admin-product-categories', undefined, { timeout: 3000 })
    await waitFor(() => expect(card.textContent ?? '').toContain('No categories yet.'))
    const links = within(card).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/categories'])
    expect(within(card).queryAllByTestId(/^admin-product-category-/)).toEqual([])
  })
})
