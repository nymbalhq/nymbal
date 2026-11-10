import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '@/pages/DashboardPage'
import { renderWithProviders } from '@/tests/render'

// The dashboard's mail warning against a fake admin API: the text GET /api/admin/mail-health answers, shown as it is,
// and nothing when it answers none.

const WARNING = /(^|-)dashboard-mail-warning$/
const TEXT =
  'Mail from this store may not be arriving. 7 of 12 sign-ups in the last 7 days never confirmed their email. Add SPF and DKIM for your domain, or an email provider (`nymbal add email-resend`).'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function dashboardApi(warning: string | null): { healthReads: () => number } {
  let reads = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/admin/')
    if (url.pathname === '/api/admin/mail-health') {
      reads += 1
      return json({
        data: {
          verification: 'required',
          funnel: { days: 7, started: 12, verified: 5 },
          warning,
        },
      })
    }
    if (url.pathname === '/api/admin/dashboard') {
      return json({
        data: {
          today: { orderCount: 0, revenueMinor: 0, itemsShipped: 0 },
          recentOrders: [],
          lowStock: [],
          agents: {
            since: '2026-11-01T00:00:00.000Z',
            currency: 'GBP',
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
  return { healthReads: () => reads }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-22: the dashboard shows the mail warning the API gives', () => {
  // Defect: the warning is never shown, or something is shown when the API says all is well.
  it('AC-22: with a warning string the dashboard shows it in dashboard-mail-warning; with null, once mail-health has been read, it shows none', async () => {
    const shown: Array<string | null> = []
    for (const warning of [TEXT, null]) {
      const api = dashboardApi(warning)
      const view = renderWithProviders(<DashboardPage />)
      await screen.findByText('Revenue today', undefined, { timeout: 5000 })
      await waitFor(() => expect(api.healthReads()).toBeGreaterThan(0))
      if (warning !== null) await screen.findByTestId(WARNING, undefined, { timeout: 5000 })
      else await new Promise((resolve) => setTimeout(resolve, 0))
      shown.push(screen.queryByTestId(WARNING)?.textContent ?? null)
      view.unmount()
      vi.unstubAllGlobals()
    }

    // The API's text, whole, inside the warning (a heading or an icon beside it is the page's own).
    expect(shown.map((text) => (text === null ? null : text.includes(TEXT)))).toEqual([true, null])
  })
})
