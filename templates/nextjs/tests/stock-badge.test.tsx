// @vitest-environment jsdom
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createNymbalClient, type DenormalisedProduct, type NymbalClient } from '@nymbalhq/sdk'
import { NymbalProvider } from '@nymbalhq/react'
import * as types from '@nymbalhq/types'
import { registerClient, registerComponents } from '@nymbalhq/web-components'
import { ProductInteractive } from '../components/client/ProductInteractive'

// P2-12 AC-4 (Next): the PDP's interactive half, `components/client/ProductInteractive.tsx`, with the real
// @nymbalhq/react provider and SDK store over a fake `fetch`. For any stock, negatives included, its `stock-badge`
// carries `data-level` = stockLevel(stock) and the label STOCK_LABELS[level], for `variants[0]` on the first render
// and for the variant the product store selects after; add-to-cart is disabled exactly at stock <= 0. Kills: Next's
// own rule (`=== 0` out, so a negative stock shows "Low" with add-to-cart enabled), its "Low Stock — N left" label,
// and the unused third rule of components/server/StockBadge.tsx.

vi.mock('@/styles/pages/pdp.module.css', () => ({ default: {} }))

type Level = 'out' | 'low' | 'in'

const { stockLevel, STOCK_LABELS } = types as unknown as {
  stockLevel?: (stock: number) => Level
  STOCK_LABELS?: Record<Level, string>
}

const API = 'http://api.test'

function productWith(stocks: [number, number]): DenormalisedProduct {
  return {
    id: 'prod-p2-12-next',
    slug: 'stock-rule',
    name: 'Stock Rule',
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'variable',
    media: [],
    variantCount: 2,
    inStock: stocks.some((s) => s > 0),
    priceRange: { minMinor: 1500, maxMinor: 2500 },
    currency: 'GBP',
    priceMinor: 1500,
    categoryIds: [],
    categories: [],
    createdAt: '',
    updatedAt: '',
    variants: stocks.map((stock, i) => ({
      id: `var-p2-12-${i}`,
      sku: `P212-${i}`,
      name: `Variant ${i}`,
      priceMinor: 1500 + 1000 * i,
      stock,
      options: [{ name: 'Size', value: String(i) }],
    })),
  } as unknown as DenormalisedProduct
}

function fakeFetch(product: DenormalisedProduct) {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  return async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === `/api/products/${product.slug}`) return json(200, { data: product })
    if (url.pathname === '/api/cart') {
      return json(200, { data: { token: 'c', items: [], subtotalMinor: 0, currency: 'GBP' } })
    }
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
}

const clients: NymbalClient[] = []

beforeAll(() => {
  registerComponents()
})

afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.destroy()
  vi.unstubAllGlobals()
})

/** The badge's level and label, and whether add-to-cart is disabled, as the page shows them. */
function shown(container: HTMLElement) {
  const badge = container.querySelector('[data-testid="stock-badge"]')
  return {
    level: badge?.getAttribute('data-level') ?? null,
    label: badge?.textContent?.trim() ?? '',
    disabled: container.querySelector('nymbal-add-to-cart')?.hasAttribute('disabled') ?? null,
  }
}

const expected = (stock: number) => ({
  level: stockLevel!(stock),
  label: STOCK_LABELS![stockLevel!(stock)],
  disabled: stock <= 0,
})

describe('P2-12: the Next stock badge renders the one rule', () => {
  it('AC-4: ProductInteractive renders data-level = stockLevel(stock) and STOCK_LABELS[level] for variants[0] and then the selected variant, for any stock, with add-to-cart disabled exactly at stock <= 0', async () => {
    expect(typeof stockLevel, '@nymbalhq/types exports stockLevel').toBe('function')
    const arbStock = fc.oneof(fc.integer({ min: -20, max: 20 }), fc.integer())
    await fc.assert(
      fc.asyncProperty(arbStock, arbStock, async (first, second) => {
        const product = productWith([first, second])
        vi.stubGlobal('fetch', vi.fn(fakeFetch(product)))
        const sdk = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
        clients.push(sdk)
        registerClient(sdk)

        const { container, unmount } = render(
          <NymbalProvider client={sdk}>
            <ProductInteractive product={product} />
          </NymbalProvider>,
        )
        await vi.waitFor(() => expect(sdk.product.getState().product).not.toBeNull())
        await vi.waitFor(() => expect(shown(container)).toEqual(expected(first)))

        act(() => sdk.product.selectVariant(product.variants[1]!))
        await vi.waitFor(() => expect(shown(container)).toEqual(expected(second)))
        unmount()
      }),
      { numRuns: 40 },
    )
  })
})
