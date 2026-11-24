import { screen } from '@testing-library/react'
import fc from 'fast-check'
import type { TodayFigures, TodayMoney } from '@nymbalhq/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from '@/pages/DashboardPage'
import { formatMoney, formatMoneyCompact } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'

// The dashboard's three today tiles against a fake admin API: what the answer's `today` holds, in each row's own
// currency, for the store's own day. The Agents tile's currency is deliberately another one.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const AGENTS_CURRENCY = 'USD'
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

function moneyRow(currency: string, netCapturedMinor: number): TodayMoney {
  const refundedMinor = netCapturedMinor < 0 ? -netCapturedMinor : 0
  const capturedMinor = netCapturedMinor + refundedMinor
  return {
    currency,
    capturedMinor,
    refundedMinor,
    netCapturedMinor,
    paidOrders: 1,
    bySource: [
      {
        source: 'storefront',
        currency,
        capturedMinor,
        refundedMinor,
        netCapturedMinor,
        paidOrders: 1,
      },
    ],
  }
}

function dashboardApi(today: TodayFigures) {
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname === '/api/admin/dashboard') {
      return json({
        data: {
          today,
          recentOrders: [],
          lowStock: [],
          agents: {
            since: '2026-11-01T00:00:00.000Z',
            currency: AGENTS_CURRENCY,
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

const figures = fc
  .record({
    store: fc.constantFrom('GBP', 'EUR', 'JPY'),
    storeNet: fc.integer({ min: -5_000_000, max: 5_000_000 }),
    others: fc.uniqueArray(
      fc.record({
        currency: fc.constantFrom('CHF', 'SEK', AGENTS_CURRENCY),
        net: fc.integer({ min: -200_000, max: 900_000 }),
      }),
      { selector: (o) => o.currency, maxLength: 3 },
    ),
    paidOrders: fc.integer({ min: 0, max: 99_999 }),
    units: fc.integer({ min: 0, max: 999_999 }),
    timezone: fc.constantFrom(
      'Pacific/Auckland',
      'Pacific/Chatham',
      'America/St_Johns',
      'Asia/Kathmandu',
    ),
  })
  .filter((f) => f.timezone !== BROWSER_ZONE)

type Figures = typeof figures extends fc.Arbitrary<infer T> ? T : never

function todayOf(f: Figures): TodayFigures {
  const others = [...f.others].sort((a, b) => a.currency.localeCompare(b.currency))
  return {
    day: '2026-11-22',
    timezone: f.timezone,
    paidOrders: f.paidOrders,
    units: f.units,
    money: [moneyRow(f.store, f.storeNet), ...others.map((o) => moneyRow(o.currency, o.net))],
  }
}

// A negative day in a store whose currency is not the Agents tile's, with the Agents tile's currency among the others.
const NEGATIVE_DAY: Figures = {
  store: 'GBP',
  storeNet: -123_456,
  others: [
    { currency: 'SEK', net: 98_765 },
    { currency: AGENTS_CURRENCY, net: 4_321 },
  ],
  paidOrders: 4_817,
  units: 9_263,
  timezone: 'Pacific/Chatham',
}

describe('the dashboard’s today tiles', () => {
  // Kills: money formatted in agents.currency, other currencies dropped, a negative day shown as positive, the tiles
  // reading the removed fields, the header in the browser's zone.
  it('AC-8: Paid orders shows paidOrders, Sales the store currency row in its own currency (compact, full subtext, data-minor, data-currency, minus sign kept) with each other currency row in its own currency, Items sold shows units, and the header reads Today in <timezone>', async () => {
    await fc.assert(
      fc.asyncProperty(figures, async (f) => {
        const today = todayOf(f)
        const store = today.money[0]!
        dashboardApi(today)
        const view = renderWithProviders(<DashboardPage />)
        try {
          const paid = await screen.findByTestId('admin-dashboard-today-paid-orders', undefined, {
            timeout: 5000,
          })
          expect(paid.textContent).toBe(String(today.paidOrders))
          expect(screen.getByTestId('admin-dashboard-today-items').textContent).toBe(
            String(today.units),
          )

          const sales = screen.getByTestId('admin-dashboard-today-sales')
          expect(sales.dataset['currency']).toBe(store.currency)
          expect(sales.dataset['minor']).toBe(String(store.netCapturedMinor))
          expect(sales.textContent).toBe(formatMoneyCompact(store.netCapturedMinor, store.currency))
          expect(screen.getByText('Sales today').parentElement!.textContent).toContain(
            formatMoney(store.netCapturedMinor, store.currency),
          )
          // A negative day keeps its minus sign.
          expect(sales.textContent!.startsWith('-')).toBe(store.netCapturedMinor < 0)

          const shown = screen.queryAllByTestId('admin-dashboard-today-sales-other').map((el) => ({
            currency: el.dataset['currency'],
            minor: el.dataset['minor'],
            // Full or compact, the amount is the row's own, in the row's own currency.
            inItsCurrency: [formatMoney, formatMoneyCompact].some((format) =>
              el.textContent!.includes(
                format(Number(el.dataset['minor']), el.dataset['currency']!),
              ),
            ),
          }))
          expect(shown).toEqual(
            today.money.slice(1).map((row: TodayMoney) => ({
              currency: row.currency,
              minor: String(row.netCapturedMinor),
              inItsCurrency: true,
            })),
          )

          expect(screen.getByText(`Today in ${today.timezone}`).textContent).toBe(
            `Today in ${today.timezone}`,
          )
          expect(screen.queryByText(`Today in ${BROWSER_ZONE}`)).toBeNull()
        } finally {
          view.unmount()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 8, examples: [[NEGATIVE_DAY]], endOnFailure: true },
    )
  }, 60_000)
})
