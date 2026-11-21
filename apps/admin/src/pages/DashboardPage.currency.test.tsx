import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '@/pages/DashboardPage'
import { formatMoney, formatMoneyCompact } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'

// The dashboard's revenue tile against a fake admin API: its money is in the store's currency, whichever that is.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function dashboardApi(currency: string, revenueMinor: number) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/admin/dashboard') {
      return json({
        data: {
          today: { orderCount: 3, revenueMinor, itemsShipped: 1 },
          recentOrders: [],
          lowStock: [],
          agents: {
            since: '2026-11-01T00:00:00.000Z',
            currency,
            surfaces: [],
            mcp: { enabled: false, writes: 'proposal' },
            profilePath: null,
            orders: { count: 0, revenueMinor: 0 },
            bySource: [],
          },
        },
      })
    }
    return json({ data: {} })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the dashboard’s revenue tile', () => {
  it('AC-16: with a dashboard answer in USD, and in any other currency, the revenue tile is formatted in that currency and not in GBP', async () => {
    const revenueMinor = 123_456
    for (const currency of ['USD', 'EUR', 'JPY']) {
      dashboardApi(currency, revenueMinor)
      const view = renderWithProviders(<DashboardPage />)

      const label = await screen.findByText('Revenue today', undefined, { timeout: 5000 })

      const expected = `${formatMoneyCompact(revenueMinor, currency)}Revenue today${formatMoney(revenueMinor, currency)}`
      await waitFor(() => expect(label.parentElement!.textContent).toBe(expected))
      expect(expected).not.toContain(formatMoney(revenueMinor, 'GBP'))
      view.unmount()
      vi.unstubAllGlobals()
    }
  })
})
