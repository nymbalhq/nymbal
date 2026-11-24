import { request as playwrightRequest, type APIRequestContext, type Page } from '@playwright/test'
import { placeOrder, signInAsAdmin } from '../../support/admin'
import { adminToken } from '../../support/checkout'
import { API_URL } from '../../support/csrf'
import { expect, test } from '../../support/fixtures'

// The Reports page on a real store: after a paid order and a search that found nothing, the page shows what
// GET /api/admin/reports answers for the same range, read in the same attempt. The store is shared with other admin
// journeys, so every figure is compared with the answer, never with a count this journey expects.

interface MoneyFigures {
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
}

interface MoneyRow extends MoneyFigures {
  currency: string
  bySource: Array<MoneyFigures & { source: string }>
}

interface Series {
  window: { to: string }
  money: { series: Array<MoneyRow & { bucket: string; partial: boolean }> }
}

interface Rate {
  rate: number | null
  reason?: string
}

interface Summary {
  money: { totals: Array<MoneyRow & { partial: boolean }> }
  rates: Record<'paidPerCheckoutStarted' | 'paidPerCartWithItems' | 'paidPerMeasuredViewer', Rate>
  zeroResultSearches: { items: Array<{ term: string; searches: number }> }
}

async function report<T>(request: APIRequestContext, token: string, query: string): Promise<T> {
  const res = await request.get(`${API_URL}/api/admin/reports${query}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  expect(res.status(), `GET /api/admin/reports${query}: ${await res.text()}`).toBe(200)
  return ((await res.json()) as { data: T }).data
}

/** The store day `n` days from `day`, on UTC parts. */
function shift(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) + n * 86_400_000).toISOString().slice(0, 10)
}

/** An amount as the admin formats it: en-GB, with the currency's ISO 4217 digits. */
function money(amountMinor: number, currency: string): string {
  const digits = new Intl.NumberFormat('en-GB', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits!
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits)
}

const percent = (rate: number) =>
  new Intl.NumberFormat('en-GB', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate)

/** `want` with no sign before it, and for a count no digit or separator either, and no digit after. */
function reading(want: string): RegExp {
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = /^\d/.test(want) ? '(?<![\\d.,\\-−])' : '(?<![\\-−])'
  return new RegExp(`${before}${escaped}(?!\\d)`)
}

/** The element's text nodes joined with a mark no figure holds, so adjacent cells never read as one figure. */
function cellsOf(page: Page, testId: string): Promise<string> {
  return page.getByTestId(testId).evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    const texts: string[] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      texts.push(node.textContent ?? '')
    }
    return texts.join('␟')
  })
}

async function expectFigures(page: Page, prefix: string, row: MoneyFigures, currency: string) {
  const cells: Array<[string, string]> = [
    ['captured', money(row.capturedMinor, currency)],
    ['refunded', money(row.refundedMinor, currency)],
    ['net', money(row.netCapturedMinor, currency)],
    ['paid', String(row.paidOrders)],
  ]
  for (const [cell, want] of cells) {
    expect(await cellsOf(page, `${prefix}-${cell}`), `${prefix}-${cell}`).toMatch(reading(want))
  }
}

test.describe('Reports', () => {
  test('AC-10: from the sidebar, Reports shows today’s row and the money totals, by-source rows, rates and today’s zero-result search of GET /api/admin/reports for the same range, totals marked so far', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000)
    const token = await adminToken(request)
    const term = `0reports${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`

    const guest = await playwrightRequest.newContext()
    let orderNumber: string
    try {
      orderNumber = (
        await placeOrder(
          guest,
          `e2e-reports-${Date.now()}-${Math.floor(Math.random() * 1e6)}@nymbal.dev`,
        )
      ).orderNumber
      // As the search page sends it: a shopper's whole-catalogue search that finds nothing.
      const miss = await guest.get(
        `${API_URL}/api/products/search?q=${encodeURIComponent(term)}&origin=page`,
      )
      expect(miss.status(), await miss.text()).toBe(200)
      expect(((await miss.json()) as { data: { total: number } }).data.total).toBe(0)
    } finally {
      await guest.dispose()
    }
    const order = await request.get(
      `${API_URL}/api/admin/orders/${encodeURIComponent(orderNumber)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    )
    expect(order.status(), await order.text()).toBe(200)
    const currency = ((await order.json()) as { data: { currency: string } }).data.currency

    await signInAsAdmin(page)
    await page.getByTestId('admin-nav-reports').click()
    await expect(page).toHaveURL(/\/admin\/reports\/?$/)
    await expect(
      page.locator('main').getByRole('heading', { name: 'Reports', level: 1 }),
    ).toHaveText('Reports')

    // The rollup applies a paid order and a search once the relay delivers them, so the attempt is retried.
    await expect(async () => {
      await page.reload()
      const series = await report<Series>(request, token, '?grain=day')
      const today = series.window.to
      const day = series.money.series.find((r) => r.bucket === today && r.currency === currency)
      expect(day?.paidOrders ?? 0, `today's ${currency} row`).toBeGreaterThanOrEqual(1)
      const summary = await report<Summary>(
        request,
        token,
        `?from=${shift(today, -30)}&to=${today}`,
      )
      const total = summary.money.totals.find((t) => t.currency === currency)
      expect(total?.paidOrders ?? 0, `the ${currency} total`).toBeGreaterThanOrEqual(
        day!.paidOrders,
      )
      const search = summary.zeroResultSearches.items.find((s) => s.term === term)
      expect(search?.searches ?? 0, `${term} in the answer`).toBeGreaterThanOrEqual(1)

      const dayId = `admin-reports-day-${currency}-${today}`
      await expect(page.getByTestId(dayId)).toHaveAttribute('data-partial', 'true', {
        timeout: 10_000,
      })
      await expectFigures(page, dayId, day!, currency)

      await expectFigures(page, `admin-reports-total-${currency}`, total!, currency)
      expect(total!.partial, 'the API marks the total partial').toBe(true)
      expect(await cellsOf(page, `admin-reports-total-${currency}-window`)).toContain('(so far)')
      for (const source of total!.bySource) {
        const row = await cellsOf(page, `admin-reports-source-${currency}-${source.source}`)
        for (const want of [
          money(source.capturedMinor, currency),
          money(source.refundedMinor, currency),
          money(source.netCapturedMinor, currency),
          String(source.paidOrders),
        ]) {
          expect(row, `${source.source} row`).toMatch(reading(want))
        }
      }

      for (const [key, rate] of Object.entries(summary.rates)) {
        const shown = await cellsOf(page, `admin-reports-rate-${key}`)
        if (rate.rate === null) expect(shown, key).toContain(rate.reason!)
        else expect(shown, key).toMatch(reading(percent(rate.rate)))
      }

      expect(await cellsOf(page, `admin-reports-search-${term}`)).toMatch(
        reading(String(search!.searches)),
      )
    }).toPass({ timeout: 90_000, intervals: [1_000, 2_000, 5_000] })
  })
})
