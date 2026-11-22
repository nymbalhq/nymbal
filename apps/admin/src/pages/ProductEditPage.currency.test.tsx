import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import type { ProductSnapshot } from '@nymbalhq/types'
import { toMoneyInput } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'
import { ProductEditPage } from './ProductEditPage'

// The product editor's price input is in the store's currency, which the signed-in session answer names: it shows a
// variant's price with that currency's digits and Save sends what the merchant typed in that currency's minor units.
// Until the answer is in, no price input is offered, so none mounts in a guessed currency's digits.

const AT = '2026-11-20T10:00:00.000Z'
const CURRENCIES = ['GBP', 'USD', 'JPY', 'KWD']
const VARIANT_ID = 'var-tea'

function product(priceMinor: number): ProductSnapshot {
  return {
    id: 'prod-tea',
    slug: 'green-tea',
    name: 'Green Tea',
    description: 'Steamed leaves.',
    shortDescription: '',
    status: 'active',
    type: 'simple',
    seoTitle: '',
    seoDescription: '',
    media: [],
    metadata: {},
    categoryIds: [],
    createdAt: AT,
    updatedAt: AT,
    variants: [
      {
        id: VARIANT_ID,
        productId: 'prod-tea',
        sku: 'TEA-1',
        name: 'Default',
        priceMinor,
        compareAtPriceMinor: null,
        weightGrams: null,
        dimensions: null,
        stock: 7,
        lowStockThreshold: 1,
        options: [],
        status: 'active',
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Session = { currency: string } | 'held' | 'refused'
type Patch = { variants?: Array<{ id: string; priceMinor: number }> }

/** The product read and its PATCH (recorded, answered as the server would), and the session answer as `session`. */
function fakeApi(session: Session, stored: ProductSnapshot) {
  const patches: Patch[] = []
  let release: (currency: string) => void = () => {
    throw new Error('the session answer is not held')
  }
  const answer = (currency: string) =>
    json({
      data: {
        userId: 'admin-1',
        roles: ['admin'],
        storeName: 'Test Store',
        environment: 'development',
        currency,
      },
    })
  const held = new Promise<Response>((resolve) => {
    release = (currency) => resolve(answer(currency))
  })
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'tok' } })
    if (url.pathname === '/api/admin/me') {
      if (session === 'held') return held
      if (session === 'refused') {
        return json({ error: { code: 'internal', message: 'Something went wrong' } }, 500)
      }
      return answer(session.currency)
    }
    if (method === 'GET' && url.pathname === `/api/admin/products/${stored.slug}`) {
      return json({ data: stored })
    }
    if (method === 'PATCH' && url.pathname === `/api/admin/products/${stored.id}`) {
      const body = JSON.parse(String(init.body)) as Patch
      patches.push(body)
      return json({
        data: {
          ...stored,
          variants: stored.variants.map((v) => ({
            ...v,
            priceMinor: body.variants?.find((sent) => sent.id === v.id)?.priceMinor ?? v.priceMinor,
          })),
        },
      })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return { patches, release }
}

function renderEditor(slug: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/products/:slug" element={<ProductEditPage />} />
    </Routes>,
    { initialPath: `/products/${slug}` },
  )
}

const priceInputs = () =>
  screen
    .queryAllByTestId(/^admin-product-variant-price-/)
    .map((el) => (el as HTMLInputElement).value)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the product editor’s price in the store currency', () => {
  it('AC-6: the Variants tab shows the stored price in the store currency’s digits and Save sends the typed amount in its minor units: 1500 then 1800 for GBP, USD, JPY and KWD, and generated prices', async () => {
    const user = userEvent.setup()
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...CURRENCIES),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        async (currency, storedMinor, typedMinor) => {
          const stored = product(storedMinor)
          const api = fakeApi({ currency }, stored)
          const view = renderEditor(stored.slug)
          try {
            expect(await screen.findByTestId('admin-product-name')).toHaveValue(stored.name)
            await user.click(screen.getByTestId('admin-product-tab-variants'))
            const input = await screen.findByTestId(`admin-product-variant-price-${VARIANT_ID}`)
            expect((input as HTMLInputElement).value, `${currency} shows`).toBe(
              toMoneyInput(storedMinor, currency),
            )

            fireEvent.change(input, { target: { value: toMoneyInput(typedMinor, currency) } })
            await user.click(screen.getByTestId('admin-product-save'))
            await waitFor(() => expect(api.patches.length, 'PATCHes sent').toBe(1))

            expect(
              api.patches[0]!.variants?.map((v) => [v.id, v.priceMinor]),
              `${currency}: the minor units sent`,
            ).toEqual([[VARIANT_ID, typedMinor]])
          } finally {
            view.unmount()
            vi.unstubAllGlobals()
          }
        },
      ),
      {
        numRuns: 12,
        examples: CURRENCIES.map((currency) => [currency, 1500, 1800] as [string, number, number]),
      },
    )
  })

  it('AC-7: until the session answer is in, the Variants tab offers no price input while the product’s name and Save are there; once it answers JPY the input reads 1500 for 1500 minor units', async () => {
    const stored = product(1500)
    const api = fakeApi('held', stored)
    const user = userEvent.setup()
    renderEditor(stored.slug)
    expect(await screen.findByTestId('admin-product-name')).toHaveValue(stored.name)
    const tab = screen.getByTestId('admin-product-tab-variants')
    await user.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')

    expect(priceInputs(), 'price inputs before the session answer').toEqual([])
    expect(screen.getByTestId('admin-product-save')).toBeEnabled()

    api.release('JPY')

    await waitFor(() => expect(priceInputs()).toEqual([toMoneyInput(1500, 'JPY')]))
    expect(priceInputs()).toEqual(['1500'])
  })

  it('AC-7: with the session answer refused, the Variants tab offers no price input while the product’s name is there', async () => {
    const stored = product(1500)
    fakeApi('refused', stored)
    const user = userEvent.setup()
    const view = renderEditor(stored.slug)
    expect(await screen.findByTestId('admin-product-name')).toHaveValue(stored.name)
    const tab = screen.getByTestId('admin-product-tab-variants')
    await user.click(tab)
    expect(tab).toHaveAttribute('aria-selected', 'true')

    expect(priceInputs(), 'price inputs while the session answer is out').toEqual([])
    await waitFor(() => expect(view.queryClient.getQueryState(['me'])?.status).toBe('error'))
    expect(priceInputs(), 'price inputs after the session answer failed').toEqual([])
    await user.click(screen.getByRole('tab', { name: 'General' }))
    expect(screen.getByTestId('admin-product-name')).toHaveValue(stored.name)
  })
})
