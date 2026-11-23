import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import type { ReportSeries, ReportSummary } from '@nymbalhq/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReportsPage } from '@/pages/ReportsPage'
import { formatStoreDay } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { renderWithProviders } from '@/tests/render'

// The Reports page against a fake GET /api/admin/reports: every figure shown is a field of the answer the page got,
// labelled with that section's own window. Today (T) comes from the series answer; the browser's clock is set two
// days later, so a page that reads its own clock asks for, and lists, the wrong days.

const T = '2026-11-03'
const CLOSED = '2026-11-02'
const TZ = 'Europe/London'
const BROWSER_NOW = new Date('2026-11-05T12:00:00.000Z')
const DAY_MS = 86_400_000

/** The day `n` days from `day`, on UTC epoch milliseconds: the test's own oracle. */
function shift(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!) + n * DAY_MS).toISOString().slice(0, 10)
}

/** Every day from `from` to `to`, newest first. */
function daysNewestFirst(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = to; day >= from; day = shift(day, -1)) days.push(day)
  return days
}

const FROM_30 = shift(T, -30)
const FROM_7 = shift(T, -7)
const RUNWAY_EARLIEST = shift(CLOSED, -27)

const label = (window: { from: string; to: string }) =>
  `${formatStoreDay(window.from)} to ${formatStoreDay(window.to)}`

const SOURCE_LABEL: Record<string, string> = {
  storefront: 'Storefront',
  import: 'Imported',
  'agent:claude': 'Agent: claude',
}

const DEFINITIONS = {
  capturedMinor: 'Money captured by payments.',
  paidOrders: 'Orders paid.',
  partial: 'True when the row or total holds today.',
}

const BASIS = {
  paidPerCheckoutStarted: 'Paid orders divided by checkouts started, storefront orders only.',
  paidPerCartWithItems: 'Paid orders divided by carts with items, storefront orders only.',
  paidPerMeasuredViewer: 'Paid orders divided by measured viewers, storefront orders only.',
}

type Figures = [captured: number, refunded: number, paid: number]

function figures([capturedMinor, refundedMinor, paidOrders]: Figures) {
  return {
    capturedMinor,
    refundedMinor,
    netCapturedMinor: capturedMinor - refundedMinor,
    paidOrders,
  }
}

/** A currency's row, its figures the sum of its sources as the server builds them. */
function moneyRow(currency: string, sources: Record<string, Figures>) {
  const bySource = Object.entries(sources).map(([source, f]) => ({
    source,
    currency,
    ...figures(f),
  }))
  const sum = (pick: (s: (typeof bySource)[number]) => number) =>
    bySource.reduce((n, s) => n + pick(s), 0)
  return {
    currency,
    ...figures([
      sum((s) => s.capturedMinor),
      sum((s) => s.refundedMinor),
      sum((s) => s.paidOrders),
    ]),
    bySource,
  }
}

function seriesRow(day: string, currency: string, sources: Record<string, Figures>) {
  return { bucket: day, partial: day === T, timezone: TZ, ...moneyRow(currency, sources) }
}

interface Store {
  since: string | null
  series: Array<ReturnType<typeof seriesRow>>
  /** Each currency's sources, and whether its total runs through today. */
  totals: Array<{ currency: string; sources: Record<string, Figures>; partial: boolean }>
}

const STORE: Store = {
  since: '2026-09-01',
  series: [
    seriesRow('2026-10-26', 'GBP', { storefront: [5000, 0, 2] }),
    seriesRow('2026-11-01', 'GBP', { storefront: [1000, 3500, 1] }),
    seriesRow(T, 'GBP', { storefront: [2000, 0, 1] }),
    seriesRow('2026-10-30', 'EUR', { 'agent:claude': [7000, 0, 1] }),
  ],
  totals: [
    {
      currency: 'GBP',
      sources: { storefront: [100_000, 4000, 4], import: [23_456, 0, 2] },
      partial: true,
    },
    { currency: 'EUR', sources: { 'agent:claude': [88_800, 1200, 3] }, partial: false },
  ],
}

/** Typed from the literal; its shape is checked where it reaches the fake API (`Answers`). */
function seriesOf(store: Store) {
  return {
    window: { from: FROM_30, to: T, timezone: TZ, grain: 'day' as const, closedThrough: CLOSED },
    since: store.since,
    definitions: DEFINITIONS,
    money: { series: store.series },
    funnel: { series: [] },
  }
}

function summaryOf(store: Store, from: string) {
  const closed = { from, to: CLOSED, timezone: TZ }
  const runwayFrom =
    store.since !== null && store.since > RUNWAY_EARLIEST ? store.since : RUNWAY_EARLIEST
  return {
    window: { from, to: T, timezone: TZ, grain: null, closedThrough: CLOSED },
    since: store.since,
    definitions: DEFINITIONS,
    money: {
      totals: store.totals.map((t) => ({
        ...moneyRow(t.currency, t.sources),
        window: { from, to: t.partial ? T : CLOSED, timezone: TZ },
        partial: t.partial,
      })),
    },
    funnel: {
      totals: [
        {
          source: 'agent:claude',
          window: closed,
          viewers: 0,
          cartsWithItems: 6,
          checkoutsStarted: 7,
          paymentsFailed: 1,
          paidOrders: 3,
        },
        {
          source: 'import',
          window: closed,
          viewers: 0,
          cartsWithItems: 0,
          checkoutsStarted: 0,
          paymentsFailed: 0,
          paidOrders: 2,
        },
        {
          source: 'storefront',
          window: closed,
          viewers: 500,
          cartsWithItems: 120,
          checkoutsStarted: 15,
          paymentsFailed: 2,
          paidOrders: 4,
        },
      ],
    },
    rates: {
      paidPerCheckoutStarted: {
        rate: 4 / 15,
        paidOrders: 4,
        checkoutsStarted: 15,
        basis: BASIS.paidPerCheckoutStarted,
        window: closed,
      },
      paidPerCartWithItems: {
        rate: 4 / 120,
        paidOrders: 4,
        cartsWithItems: 120,
        basis: BASIS.paidPerCartWithItems,
        window: closed,
      },
      paidPerMeasuredViewer: {
        rate: 4 / 500,
        paidOrders: 4,
        viewers: 500,
        basis: BASIS.paidPerMeasuredViewer,
        window: closed,
      },
    },
    // In the API's order, which no key of the items sorts: not units, name, money or count, either way.
    topProducts: {
      window: closed,
      items: [
        {
          productId: 'p-scarf',
          productName: 'Wool Scarf',
          currency: 'GBP',
          units: 3,
          lineSubtotalMinor: 4500,
          bySource: [],
        },
        {
          productId: 'p-hat',
          productName: 'Alpaca Hat',
          currency: 'EUR',
          units: 9,
          lineSubtotalMinor: 9900,
          bySource: [],
        },
        {
          productId: 'p-socks',
          productName: 'Merino Socks',
          currency: 'GBP',
          units: 5,
          lineSubtotalMinor: 1500,
          bySource: [],
        },
      ],
    },
    zeroResultSearches: {
      window: { from, to: T, timezone: TZ },
      items: [
        { term: 'velvet', searches: 2 },
        { term: 'azure', searches: 7 },
        { term: 'moss', searches: 4 },
      ],
    },
    stockRunway: {
      window: { from: runwayFrom, to: CLOSED, timezone: TZ },
      items: [
        {
          variantId: 'v-out',
          productId: 'p-scarf',
          productName: 'Wool Scarf',
          sku: 'WS-1',
          stock: 0,
          unitsSold: 9,
          windowDays: 28,
          daysLeft: 0,
          reason: 'No stock left.',
        },
        {
          variantId: 'v-soon',
          productId: 'p-hat',
          productName: 'Alpaca Hat',
          sku: 'AH-2',
          stock: 2,
          unitsSold: 140,
          windowDays: 28,
          daysLeft: 0.4,
        },
        {
          variantId: 'v-ok',
          productId: 'p-socks',
          productName: 'Merino Socks',
          sku: 'MS-3',
          stock: 40,
          unitsSold: 87,
          windowDays: 28,
          daysLeft: 12.9,
        },
      ],
    },
  }
}

interface Refusal {
  status: number
  code: string
  message: string
}

interface Answers {
  series: ReportSeries | Refusal
  summary: (from: string, to: string) => ReportSummary | Refusal
}

const isRefusal = (a: unknown): a is Refusal =>
  typeof a === 'object' && a !== null && 'status' in a && 'message' in a

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

/** Stubs fetch with the reports route; returns the query of every reports request, in the order sent. */
function reportsApi(answers: Answers): URLSearchParams[] {
  const sent: URLSearchParams[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    if (url.pathname !== '/api/admin/reports') return json({ data: {} })
    sent.push(url.searchParams)
    const answer = url.searchParams.has('grain')
      ? answers.series
      : answers.summary(url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '')
    if (isRefusal(answer)) {
      return json({ error: { code: answer.code, message: answer.message } }, answer.status)
    }
    return json({ data: answer })
  })
  return sent
}

function storeApi(store: Store, edit: (s: ReportSummary) => ReportSummary = (s) => s) {
  return reportsApi({ series: seriesOf(store), summary: (from) => edit(summaryOf(store, from)) })
}

const renderPage = () => renderWithProviders(<ReportsPage />, { initialPath: '/reports' })

const tid = (...parts: string[]) => ['admin-reports', ...parts].join('-')
const byId = (...parts: string[]) => screen.getByTestId(tid(...parts))
const textOf = (...parts: string[]) => byId(...parts).textContent ?? ''

/** The element's text nodes (the page's, with no parts), one per cell or label, joined with a mark no figure holds,
 * so two adjacent cells such as £960.00 and 4 never read as one figure. */
function cellsOf(...parts: string[]): string {
  const root = parts.length === 0 ? document.body : byId(...parts)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    texts.push(node.textContent ?? '')
  }
  return texts.join('\u241f')
}

/** `want` with no sign before it, and for a count no digit or separator either, and no digit after: £25.00 is not read
 * in -£25.00, 4 not in 14 or 4.5. */
function reading(want: string): RegExp {
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const before = /^\d/.test(want) ? '(?<![\\d.,\\-\u2212])' : '(?<![\\-\u2212])'
  return new RegExp(`${before}${escaped}(?!\\d)`)
}

/** `want` as a whole figure: no sign or digit before it, and no digit or grouped digits after it, so JP¥100,011 is
 * not read in JP¥100,011,234. */
function wholeFigure(want: string): RegExp {
  const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\d.,\\-\u2212])${escaped}(?![\\d]|[.,]\\d)`)
}

function expectReads(text: string, want: string, what: string): void {
  expect(text, `${what} reads ${want}`).toMatch(reading(want))
}

/** A section's window label, `<from> to <to>`, with no digit before it (so 6 Oct is not read in 26 Oct). */
function expectLabel(text: string, window: { from: string; to: string }, what: string): void {
  expect(text, `${what} window`).toMatch(reading(label(window)))
}

/** The store days of a currency's day rows, in the order shown. */
function dayRows(currency: string): string[] {
  const row = new RegExp(`^${tid('day', currency)}-(\\d{4}-\\d{2}-\\d{2})$`)
  return [...document.querySelectorAll<HTMLElement>('[data-testid]')]
    .map((el) => row.exec(el.dataset['testid'] ?? '')?.[1])
    .filter((d): d is string => d !== undefined)
}

const allTestIds = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid]')].map(
    (el) => el.dataset['testid'] ?? '',
  )

const FIELDS = ['capturedMinor', 'refundedMinor', 'netCapturedMinor'] as const
const CELL = {
  capturedMinor: 'captured',
  refundedMinor: 'refunded',
  netCapturedMinor: 'net',
} as const

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true })
  vi.setSystemTime(BROWSER_NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what the page asks for', () => {
  // Kills: today from the browser clock; `to` left out, so today's zero-result searches are dropped; the series read
  // sent again on a range change.
  it('AC-2: opening sends grain=day with no from or to, then from=T-30&to=T with no grain, T the first answer’s window.to; Last 7 days sends from=T-7&to=T and no second grain read', async () => {
    const sent = storeApi(STORE)
    const user = userEvent.setup()
    renderPage()

    await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(2))
    const [first, second] = sent
    expect([...first!.entries()]).toEqual([['grain', 'day']])
    expect(Object.fromEntries(second!.entries())).toEqual({ from: shift(T, -30), to: T })
    await waitFor(() => expect(byId('range-30')).toHaveAttribute('aria-pressed', 'true'))

    await user.click(byId('range-7'))
    await waitFor(() =>
      expect(sent.map((q) => Object.fromEntries(q.entries()))).toContainEqual({
        from: shift(T, -7),
        to: T,
      }),
    )
    // The 7-day answer is on the page, so any read the range change sent has been sent.
    await waitFor(() =>
      expect(textOf('searches-window')).toMatch(reading(label({ from: shift(T, -7), to: T }))),
    )
    expect(sent.filter((q) => q.has('grain')).length, 'series reads').toBe(1)
    expect(sent.filter((q) => !q.has('grain')).map((q) => q.get('to'))).toEqual(
      sent.filter((q) => !q.has('grain')).map(() => T),
    )
    expect(byId('range-7')).toHaveAttribute('aria-pressed', 'true')
    expect(byId('range-30')).toHaveAttribute('aria-pressed', 'false')
  })
})

describe('money per currency', () => {
  // Kills: currencies summed, or one formatted in the other's currency; a total summed from the day rows; a total
  // labelled from the chosen range, or not marked when it holds today.
  it('AC-3: property: each currency’s total cells read formatMoney of its own figures and its paid orders, one source row per bySource entry, its window from its own window marked (so far) exactly when partial, and no figure summed across currencies', async () => {
    const sourceFigures = fc.tuple(
      fc.integer({ min: 100_000, max: 90_000_000 }),
      // Below the least captured, so every net is positive.
      fc.integer({ min: 1, max: 99_999 }),
      fc.integer({ min: 1, max: 900 }),
    )
    const totals = fc
      .uniqueArray(fc.constantFrom('GBP', 'EUR', 'JPY', 'KWD', 'USD'), {
        minLength: 2,
        maxLength: 3,
      })
      .chain((currencies) =>
        fc.tuple(
          ...currencies.map((currency) =>
            fc.record({
              currency: fc.constant(currency),
              partial: fc.boolean(),
              sources: fc
                .uniqueArray(
                  fc.tuple(fc.constantFrom('storefront', 'import', 'agent:claude'), sourceFigures),
                  {
                    selector: ([source]) => source,
                    minLength: 1,
                    maxLength: 3,
                  },
                )
                .map((entries) => Object.fromEntries(entries) as Record<string, Figures>),
            }),
          ),
        ),
      )

    await fc.assert(
      fc.asyncProperty(totals, async (generated) => {
        const store: Store = { ...STORE, series: [], totals: generated }
        const summary = summaryOf(store, FROM_30)
        storeApi(store)
        const view = renderPage()
        try {
          for (const total of summary.money.totals) {
            const c = total.currency
            await screen.findByTestId(tid('total', c, 'captured'), undefined, { timeout: 5000 })
            for (const field of FIELDS) {
              expectReads(
                cellsOf('total', c, CELL[field]),
                formatMoney(total[field], c),
                `${c} ${field}`,
              )
            }
            expectReads(cellsOf('total', c, 'paid'), String(total.paidOrders), `${c} paid orders`)

            const windowText = textOf('total', c, 'window')
            expectLabel(windowText, total.window, `${c} total`)
            expect(windowText.includes('(so far)'), `${c} total marked so far`).toBe(total.partial)

            const rows = allTestIds().filter((id) => id.startsWith(tid('source', c) + '-'))
            expect(rows.sort()).toEqual(
              total.bySource.map((s) => tid('source', c, s.source)).sort(),
            )
            for (const s of total.bySource) {
              const row = cellsOf('source', c, s.source)
              expect(row).toContain(SOURCE_LABEL[s.source])
              for (const field of FIELDS) {
                expectReads(row, formatMoney(s[field], c), `${c} ${s.source} ${field}`)
              }
              expectReads(row, String(s.paidOrders), `${c} ${s.source} paid orders`)
            }
          }

          // The page's cells, not its text run together, read for whole figures only.
          const page = cellsOf()
          for (const field of FIELDS) {
            const sum = summary.money.totals.reduce((n, t) => n + t[field], 0)
            for (const total of summary.money.totals) {
              // A sum that equals one of this currency's own figures is on the page legitimately.
              const own = [total, ...total.bySource].flatMap((f) => FIELDS.map((k) => f[k]))
              if (own.includes(sum)) continue
              expect(
                page,
                `the ${field} of every currency summed, in ${total.currency}`,
              ).not.toMatch(wholeFigure(formatMoney(sum, total.currency)))
            }
          }
        } finally {
          view.unmount()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 8 },
    )
  })

  it('AC-3: GBP (through today, so far) and EUR (closed days) each read their own money.totals row, not a sum of their day rows, and no element reads the GBP+EUR sum', async () => {
    storeApi(STORE)
    renderPage()
    const summary = summaryOf(STORE, FROM_30)
    const [gbp, eur] = summary.money.totals

    await screen.findByTestId(tid('total', 'GBP', 'captured'))
    await screen.findByTestId(tid('total', 'EUR', 'captured'))
    expect(
      allTestIds()
        .filter((id) => /^admin-reports-currency-[A-Z]{3}$/.test(id))
        .sort(),
    ).toEqual([tid('currency', 'EUR'), tid('currency', 'GBP')])

    for (const total of [gbp!, eur!]) {
      const c = total.currency
      const fromDays = STORE.series.filter((r) => r.currency === c)
      for (const field of FIELDS) {
        expectReads(cellsOf('total', c, CELL[field]), formatMoney(total[field], c), `${c} ${field}`)
        const daySum = fromDays.reduce((n, r) => n + r[field], 0)
        const closedDaySum = fromDays
          .filter((r) => r.bucket !== T)
          .reduce((n, r) => n + r[field], 0)
        expect(
          daySum === total[field] || closedDaySum === total[field],
          'the fixture tells a sum from the total',
        ).toBe(false)
      }
    }
    expect(textOf('total', 'GBP', 'window')).toMatch(
      reading(`${label({ from: FROM_30, to: T })} (so far)`),
    )
    expectLabel(textOf('total', 'EUR', 'window'), { from: FROM_30, to: CLOSED }, 'EUR total')
    expect(textOf('total', 'EUR', 'window')).not.toContain('so far')

    const body = document.body.textContent ?? ''
    for (const field of FIELDS) {
      const sum = gbp![field] + eur![field]
      for (const c of ['GBP', 'EUR']) expect(body).not.toContain(formatMoney(sum, c))
    }
    for (const total of [gbp!, eur!]) {
      const paid = cellsOf('total', total.currency, 'paid')
      expectReads(paid, String(total.paidOrders), `${total.currency} paid orders`)
      expect(paid).not.toMatch(reading(String(gbp!.paidOrders + eur!.paidOrders)))
    }
  })
})

describe('a row per store day', () => {
  // Kills: only days with rows listed, so a day with no sales vanishes; today unmarked; days before `since` shown as
  // zero sales; the list stepped from the range rather than the later of from and since.
  it('AC-4: GBP lists every day from since through T newest first, a day with no row at zero, T marked Today (so far), a negative net with its minus sign, and Figures start on <since>; on Last 7 days it lists T-7 through T', async () => {
    const since = '2026-10-25'
    const store: Store = { ...STORE, since }
    storeApi(store)
    const user = userEvent.setup()
    renderPage()

    await screen.findByTestId(tid('day', 'GBP', T))
    expect(dayRows('GBP')).toEqual(daysNewestFirst(since, T))
    expect(byId('since')).toHaveTextContent(`Figures start on ${formatStoreDay(since)}`)

    const empty = '2026-11-02'
    for (const cell of ['captured', 'refunded', 'net']) {
      expectReads(cellsOf('day', 'GBP', empty, cell), formatMoney(0, 'GBP'), `${empty} ${cell}`)
    }
    expectReads(cellsOf('day', 'GBP', empty, 'paid'), '0', `${empty} paid`)

    const negative = store.series.find((r) => r.bucket === '2026-11-01' && r.currency === 'GBP')!
    expect(negative.netCapturedMinor).toBeLessThan(0)
    expectReads(
      cellsOf('day', 'GBP', '2026-11-01', 'net'),
      formatMoney(negative.netCapturedMinor, 'GBP'),
      '1 Nov net',
    )

    const today = store.series.find((r) => r.bucket === T && r.currency === 'GBP')!
    expect(byId('day', 'GBP', T)).toHaveAttribute('data-partial', 'true')
    expect(byId('day', 'GBP', T)).toHaveTextContent('Today (so far)')
    expectReads(
      cellsOf('day', 'GBP', T, 'captured'),
      formatMoney(today.capturedMinor, 'GBP'),
      'today captured',
    )
    const marked = dayRows('GBP').filter((d) => byId('day', 'GBP', d).dataset['partial'] === 'true')
    expect(marked).toEqual([T])

    await user.click(byId('range-7'))
    await waitFor(() => expect(dayRows('GBP')).toEqual(daysNewestFirst(FROM_7, T)))
    expect(dayRows('GBP').length).toBe(8)
  })
})

describe('no history, and history that is all today', () => {
  // Kills: a store with no history reads as one that sold nothing at 0%; a store whose sales are all today's shows no
  // money because the page keys its sections off closed days.
  it('AC-5: with since null the page reads No figures yet and shows no currency section, rate or list', async () => {
    const store: Store = { since: null, series: [], totals: [] }
    const sent = storeApi(store, (s) => ({
      ...s,
      funnel: { totals: [] },
      rates: {
        paidPerCheckoutStarted: {
          ...s.rates.paidPerCheckoutStarted,
          rate: null,
          paidOrders: 0,
          checkoutsStarted: 0,
          reason: 'Fewer than 5 checkouts started in the window, too few to state a rate.',
        },
        paidPerCartWithItems: {
          ...s.rates.paidPerCartWithItems,
          rate: null,
          paidOrders: 0,
          cartsWithItems: 0,
          reason: 'Fewer than 5 carts with items in the window, too few to state a rate.',
        },
        paidPerMeasuredViewer: {
          ...s.rates.paidPerMeasuredViewer,
          rate: null,
          paidOrders: 0,
          viewers: 0,
          reason: 'Fewer than 20 viewers in the window, too few to state a rate.',
        },
      },
      topProducts: { ...s.topProducts, items: [] },
      zeroResultSearches: { ...s.zeroResultSearches, items: [] },
      stockRunway: { ...s.stockRunway, items: [] },
    }))
    const view = renderPage()

    // Both answers are in, so the empty state is not judged before the summary could have added a section.
    await waitFor(() => expect(sent.filter((q) => !q.has('grain')).length).toBe(1))
    await waitFor(() => expect(view.queryClient.isFetching()).toBe(0))
    expect(await screen.findByTestId(tid('empty'))).toHaveTextContent('No figures yet')
    const shown = allTestIds().filter((id) =>
      /^admin-reports-(currency-|rate-|day-|top-products$|searches$|runway$)/.test(id),
    )
    expect(shown).toEqual([])
  })

  it('AC-5: with since = T the currency section shows its total marked (so far), the one day row is today, and each rate shows its reason', async () => {
    const store: Store = {
      since: T,
      series: [seriesRow(T, 'GBP', { storefront: [2000, 0, 1] })],
      totals: [{ currency: 'GBP', sources: { storefront: [2000, 0, 1] }, partial: true }],
    }
    const reasons = {
      paidPerCheckoutStarted:
        'Fewer than 5 checkouts started in the window, too few to state a rate.',
      paidPerCartWithItems: 'Fewer than 5 carts with items in the window, too few to state a rate.',
      paidPerMeasuredViewer: 'Fewer than 20 viewers in the window, too few to state a rate.',
    }
    storeApi(store, (s) => ({
      ...s,
      funnel: { totals: [] },
      rates: {
        paidPerCheckoutStarted: {
          ...s.rates.paidPerCheckoutStarted,
          rate: null,
          paidOrders: 0,
          checkoutsStarted: 0,
          reason: reasons.paidPerCheckoutStarted,
        },
        paidPerCartWithItems: {
          ...s.rates.paidPerCartWithItems,
          rate: null,
          paidOrders: 0,
          cartsWithItems: 0,
          reason: reasons.paidPerCartWithItems,
        },
        paidPerMeasuredViewer: {
          ...s.rates.paidPerMeasuredViewer,
          rate: null,
          paidOrders: 0,
          viewers: 0,
          reason: reasons.paidPerMeasuredViewer,
        },
      },
    }))
    renderPage()

    await screen.findByTestId(tid('currency', 'GBP'))
    expect(textOf('total', 'GBP', 'window')).toMatch(
      reading(`${label({ from: FROM_30, to: T })} (so far)`),
    )
    expectReads(cellsOf('total', 'GBP', 'captured'), formatMoney(2000, 'GBP'), 'GBP captured')
    expect(dayRows('GBP')).toEqual([T])
    for (const [key, reason] of Object.entries(reasons)) {
      expect(textOf('rate', key)).toContain(reason)
      expect(textOf('rate', key)).toContain('—')
    }
    expect(screen.queryByTestId(tid('empty'))).not.toBeInTheDocument()
  })
})

describe('conversion rates', () => {
  // Kills: the page dividing the counts itself, stating a rate the server refused under its floor.
  it('AC-6: each rate reads the server’s rate to one decimal with its basis; a null rate reads — and its reason, and 1 paid of 3 checkouts shows no 33.3% anywhere', async () => {
    const reason = 'Fewer than 5 checkouts started in the window, too few to state a rate.'
    storeApi(STORE, (s) => ({
      ...s,
      rates: {
        ...s.rates,
        paidPerCheckoutStarted: {
          ...s.rates.paidPerCheckoutStarted,
          rate: null,
          paidOrders: 1,
          checkoutsStarted: 3,
          reason,
        },
      },
    }))
    renderPage()

    await screen.findByTestId(tid('rate', 'paidPerCartWithItems'))
    const shown = {
      paidPerCheckoutStarted: cellsOf('rate', 'paidPerCheckoutStarted'),
      paidPerCartWithItems: cellsOf('rate', 'paidPerCartWithItems'),
      paidPerMeasuredViewer: cellsOf('rate', 'paidPerMeasuredViewer'),
    }
    expectReads(shown.paidPerCartWithItems, '3.3%', 'paid per cart (4 / 120)')
    expectReads(shown.paidPerMeasuredViewer, '0.8%', 'paid per viewer (4 / 500)')
    expect(shown.paidPerCheckoutStarted).toContain('—')
    expect(shown.paidPerCheckoutStarted).toContain(reason)
    for (const [key, text] of Object.entries(shown)) {
      expect(text).toContain(BASIS[key as keyof typeof BASIS])
    }
    expect(document.body.textContent).not.toContain('33.3%')
  })
})

describe('top products, zero-result searches and stock runway', () => {
  // Kills: a list re-sorted; runway rounded up, or 0.4 days shown as out of stock; a section labelled with the chosen
  // range, so 28 days of runway read as 7.
  it('AC-7: each list keeps the API’s order with its figures; runway reads 12 days, less than a day and Out of stock; on Last 7 days the runway, searches, top products and rates read their own windows', async () => {
    storeApi(STORE)
    const user = userEvent.setup()
    renderPage()
    const summary = summaryOf(STORE, FROM_30)

    await screen.findByTestId(tid('top-products'))
    await waitFor(() =>
      expect(cellsOf('top-products')).toContain(summary.topProducts.items[0]!.productName),
    )
    const productText = cellsOf('top-products')
    const at = summary.topProducts.items.map((item) => productText.indexOf(item.productName))
    expect(
      at.every((i) => i >= 0),
      `every product named: ${at.join(', ')}`,
    ).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    summary.topProducts.items.forEach((item, i) => {
      const segment = productText.slice(at[i], at[i + 1])
      expectReads(segment, String(item.units), `${item.productName} units`)
      expectReads(
        segment,
        formatMoney(item.lineSubtotalMinor, item.currency),
        `${item.productName} subtotal`,
      )
    })

    const searchRows = allTestIds().filter((id) => id.startsWith(tid('search') + '-'))
    expect(searchRows).toEqual(summary.zeroResultSearches.items.map((s) => tid('search', s.term)))
    for (const s of summary.zeroResultSearches.items) {
      expect(textOf('search', s.term)).toContain(s.term)
      expectReads(cellsOf('search', s.term), String(s.searches), `${s.term} searches`)
    }

    const runway = summary.stockRunway.items
    const runwayRows = allTestIds()
      .map((id) => /^admin-reports-runway-(.+)-days$/.exec(id)?.[1])
      .filter((v): v is string => v !== undefined)
    expect(runwayRows).toEqual(runway.map((r) => r.variantId))
    expect(textOf('runway', 'v-ok', 'days').trim()).toBe('12 days')
    expect(textOf('runway', 'v-soon', 'days').trim()).toBe('less than a day')
    expect(textOf('runway', 'v-out', 'days').trim()).toBe('Out of stock')
    const runwayText = cellsOf('runway')
    const skuAt = runway.map((r) => runwayText.indexOf(r.sku))
    expect(
      skuAt.every((i) => i >= 0),
      `every SKU shown: ${skuAt.join(', ')}`,
    ).toBe(true)
    expect([...skuAt].sort((a, b) => a - b)).toEqual(skuAt)
    runway.forEach((r, i) => {
      expectReads(
        runwayText.slice(skuAt[i]! + r.sku.length, skuAt[i + 1]),
        String(r.stock),
        `${r.sku} stock`,
      )
    })

    await user.click(byId('range-7'))
    const week = summaryOf(STORE, FROM_7)
    await waitFor(() =>
      expectLabel(textOf('searches-window'), week.zeroResultSearches.window, 'searches'),
    )
    expect(week.stockRunway.window.from, 'the fixture’s runway is 28 closed days').toBe(
      RUNWAY_EARLIEST,
    )
    expectLabel(textOf('runway-window'), week.stockRunway.window, 'runway')
    expectLabel(textOf('top-products-window'), week.topProducts.window, 'top products')
    expectLabel(textOf('rates-window'), week.rates.paidPerCartWithItems.window, 'rates')
    expect(textOf('runway-window')).not.toContain(formatStoreDay(FROM_7))
  })

  it('AC-7: an empty top products, searches or runway list reads None in this range', async () => {
    storeApi(STORE, (s) => ({
      ...s,
      topProducts: { ...s.topProducts, items: [] },
      zeroResultSearches: { ...s.zeroResultSearches, items: [] },
      stockRunway: { ...s.stockRunway, items: [] },
    }))
    renderPage()

    await screen.findByTestId(tid('currency', 'GBP'))
    const lists = ['top-products', 'searches', 'runway'].map((id) => textOf(id))
    expect(lists.map((text) => text.includes('None in this range'))).toEqual([true, true, true])
  })
})

describe('a refused read', () => {
  // Kills: a refusal that leaves a blank page or an endless skeleton.
  it('AC-8: a 500 or a 403 on the series read or on the summary read shows the response’s message and no figures', async () => {
    const refusals: Refusal[] = [
      { status: 500, code: 'INTERNAL', message: 'The report store is unavailable.' },
      { status: 403, code: 'FORBIDDEN', message: 'Reports need the admin role.' },
    ]
    const shown: string[] = []
    for (const refusal of refusals) {
      for (const read of ['series', 'summary'] as const) {
        reportsApi({
          series: read === 'series' ? refusal : seriesOf(STORE),
          summary: (from) => (read === 'summary' ? refusal : summaryOf(STORE, from)),
        })
        const view = renderPage()
        const error = await screen.findByTestId(tid('error'), undefined, { timeout: 5000 })
        expect(error, `${refusal.status} on the ${read} read`).toHaveTextContent(refusal.message)
        shown.push(
          ...allTestIds().filter((id) =>
            /^admin-reports-(currency-|total-|day-|rate-|funnel-)/.test(id),
          ),
        )
        view.unmount()
        vi.unstubAllGlobals()
      }
    }
    expect(shown).toEqual([])
  })
})

describe('the funnel', () => {
  // Kills: the funnel's paid orders taken from the money totals; a source's counts landing in another source's row.
  it('AC-12: one funnel row per funnel.totals entry with that source’s five counts, storefront paid 4 while the GBP money total says 6, and the funnel window its own', async () => {
    storeApi(STORE)
    renderPage()
    const summary = summaryOf(STORE, FROM_30)

    await screen.findByTestId(tid('funnel', 'storefront'))
    const rows = allTestIds().filter(
      (id) => /^admin-reports-funnel-[^-]+$/.test(id) && id !== tid('funnel-window'),
    )
    expect(rows.sort()).toEqual(summary.funnel.totals.map((f) => tid('funnel', f.source)).sort())

    const cells = {
      viewers: 'viewers',
      cartsWithItems: 'carts',
      checkoutsStarted: 'checkouts',
      paymentsFailed: 'failed',
      paidOrders: 'paid',
    } as const
    const read = summary.funnel.totals.map((f) =>
      Object.fromEntries(
        Object.entries(cells).map(([field, cell]) => [
          field,
          textOf('funnel', f.source, cell).replace(/\D/g, ''),
        ]),
      ),
    )
    expect(read).toEqual(
      summary.funnel.totals.map((f) =>
        Object.fromEntries(
          Object.keys(cells).map((field) => [field, String(f[field as keyof typeof cells])]),
        ),
      ),
    )
    const gbp = summary.money.totals.find((t) => t.currency === 'GBP')!
    expect(textOf('funnel', 'storefront', 'paid').replace(/\D/g, '')).not.toBe(
      String(gbp.paidOrders),
    )
    expectLabel(textOf('funnel-window'), summary.funnel.totals[0]!.window, 'funnel')
  })
})

describe('the page in context', () => {
  // A store day given to the page is never moved by the browser's zone: checked here only for the since note in a
  // zone west of UTC, since AC-1 owns the arithmetic.
  it('AC-4: in Los Angeles the since note and today’s row name the store’s own days', async () => {
    const original = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      storeApi({ ...STORE, since: '2026-10-25' })
      renderPage()
      await screen.findByTestId(tid('day', 'GBP', T))
      expect(byId('since')).toHaveTextContent('Figures start on 25 Oct 2026')
      expect(dayRows('GBP')[0]).toBe(T)
      expect(within(byId('day', 'GBP', T)).queryByText(/2 Nov/)).not.toBeInTheDocument()
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})
