import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { renderWithProviders } from '@/tests/render'
import type { InventoryRow } from '@/types'
import { InventoryPage } from './InventoryPage'

// The product page's stock link lands on Inventory with the variant's SKU in `?q`: the search field starts from it,
// so the table is that variant, not every variant.

const AT = '2026-10-20T10:00:00.000Z'

const ROWS: InventoryRow[] = ['LIN+0 S', 'LIN+1 M', 'WOOL-2'].map((sku, i) => ({
  variantId: `var-${i}`,
  productId: `prod-${i}`,
  productName: `Product ${i}`,
  sku,
  options: [],
  stock: 10 + i,
  threshold: 2,
  status: 'in_stock',
  updatedAt: AT,
}))

/** `GET /api/admin/inventory` as the server answers it: the rows whose SKU or product name contains `q`. */
function fakeApi() {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    if (url.pathname === '/api/admin/inventory') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const data = ROWS.filter(
        (r) => r.sku.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q),
      )
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked', message: url.pathname } }), {
      status: 404,
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Inventory search from the URL', () => {
  it('AC-8: /inventory?q=<sku> opens with the search field holding the SKU and the table showing only that variant', async () => {
    fakeApi()
    const target = ROWS[0]!
    renderWithProviders(
      <Routes>
        <Route path="/inventory" element={<InventoryPage />} />
      </Routes>,
      { initialPath: `/inventory?q=${encodeURIComponent(target.sku)}` },
    )

    expect(await screen.findByPlaceholderText('Search SKU or product...')).toHaveValue(target.sku)
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId(/^admin-inventory-row-/)
          .map((row) => row.getAttribute('data-testid')),
      ).toEqual(
        ROWS.filter((r) => r.sku.includes(target.sku)).map(
          (r) => `admin-inventory-row-${r.variantId}`,
        ),
      ),
    )
  })
})
