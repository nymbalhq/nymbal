import { screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Customer, ProductSnapshot } from '@nymbalhq/types'
import { AssistantRecordCard } from '@/components/assistant/AssistantRecordCard'
import { CustomerProfileCard } from '@/components/customers/CustomerProfileCard'
import { formatMoney } from '@/lib/money'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import type { CustomerStats } from '@/types'
import { CustomersListPage } from './CustomersListPage'
import { ProductsListPage } from './ProductsListPage'

// Product prices and customer totals carry no currency of their own: each surface shows them in the store's, which the
// signed-in session answer (GET /api/admin/me) names, and shows a dash until that answer is in. The admin API is faked
// at fetch; the session answer is given, held until the test releases it, or refused.

const AT = '2026-11-20T10:00:00.000Z'
const CURRENCIES = ['GBP', 'USD', 'JPY', 'KWD']
const DASH = '—'

const PRODUCT: ProductSnapshot = {
  id: 'prod-tea',
  slug: 'green-tea',
  name: 'Green Tea',
  description: '',
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
      id: 'prod-tea-v',
      productId: 'prod-tea',
      sku: 'TEA-1',
      name: 'Default',
      priceMinor: 1500,
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

const CUSTOMER: Customer = {
  id: 'cust-ada',
  email: 'ada@customers.test',
  firstName: 'Ada',
  lastName: 'Byron',
  phone: '',
  addresses: [],
  orderCount: 4,
  totalSpentMinor: 5000,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: AT,
  updatedAt: AT,
}

const STATS: CustomerStats = {
  orderCount: 2,
  lifetimeRevenueMinor: 3500,
  avgOrderValueMinor: 1750,
  firstOrderAt: AT,
  lastOrderAt: AT,
}

/** The customer the assistant's card reads, with its own lifetime figure. */
const CARD_STATS: CustomerStats = { ...STATS, orderCount: 17, lifetimeRevenueMinor: 98_765 }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

type Session = { currency: string } | 'held' | 'refused'

/** The admin API these surfaces read; `release` answers a held session with `currency`. */
function fakeApi(session: Session) {
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
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    switch (url.pathname) {
      case '/api/admin/me':
        if (session === 'held') return held
        if (session === 'refused') {
          return json({ error: { code: 'internal', message: 'Something went wrong' } }, 500)
        }
        return answer(session.currency)
      case '/api/admin/products':
        return json({ data: [PRODUCT], meta: { total: 1 } })
      case '/api/admin/customers':
        return json({ data: { customers: [CUSTOMER] } })
      case `/api/admin/customers/${CUSTOMER.id}`:
        return json({ data: { customer: CUSTOMER, stats: CARD_STATS } })
      default:
        return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
    }
  })
  return { release }
}

/** Text as a reader sees it: whitespace (ICU's no-break spaces included) as single spaces. */
const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
const shownAs = (minor: number, currency: string) => formatMoney(minor, currency).replace(/\s+/g, ' ')

/** Each currency's sign as the admin writes it: £, US$, JP¥, KWD. */
const SIGNS = CURRENCIES.map((c) => formatMoney(0, c).replace(/[\d.,\s]/g, ''))
const signsIn = (el: Element) => SIGNS.filter((sign) => text(el).includes(sign))

/** The cell of the row with test id `rowId` under the column headed `heading`. */
function cellUnder(rowId: string, heading: string): HTMLElement {
  const row = screen.getByTestId(rowId)
  const table = row.closest('table')
  if (table === null) throw new Error(`${rowId} is not in a table`)
  const headings = within(table)
    .getAllByRole('columnheader')
    .map((th) => text(th))
  const column = headings.indexOf(heading)
  if (column < 0) throw new Error(`no column headed ${heading}: ${headings.join(' | ')}`)
  return within(row).getAllByRole('cell')[column]!
}

const PRODUCT_ROW = `admin-products-row-${PRODUCT.id}`
const CUSTOMER_ROW = `admin-customers-row-${CUSTOMER.id}`
const LIFETIME = 'admin-customer-stat-lifetime-value'
const AVG_ORDER = 'admin-customer-stat-avg-order'
const CARD = `admin-assistant-record-customer-${CUSTOMER.id}`

const price = () => cellUnder(PRODUCT_ROW, 'Price')
const totalSpent = () => cellUnder(CUSTOMER_ROW, 'Total Spent')

/** The four surfaces under one session: both lists, the customer's profile and the assistant's customer card. */
function renderSurfaces() {
  return renderWithProviders(
    <>
      <ProductsListPage />
      <CustomersListPage />
      <CustomerProfileCard customer={CUSTOMER} stats={STATS} />
      <AssistantRecordCard record={{ kind: 'customer', id: CUSTOMER.id }} />
    </>,
  )
}

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('product prices and customer totals in the store currency', () => {
  it('AC-2: the products list shows a first variant’s 1500 minor units in the store currency, for GBP, USD, JPY and KWD; a JPY row holds no £', async () => {
    const rows = new Map<string, string>()
    for (const currency of CURRENCIES) {
      fakeApi({ currency })
      const view = renderWithProviders(<ProductsListPage />)
      await screen.findByTestId(PRODUCT_ROW)

      await waitFor(() => expect(text(price()), currency).toBe(shownAs(1500, currency)))
      rows.set(currency, text(screen.getByTestId(PRODUCT_ROW)))
      view.unmount()
      vi.unstubAllGlobals()
    }
    expect(rows.get('JPY')).not.toContain('£')
  })

  it('AC-3: the customers list shows a customer’s 5000 minor units spent in the store currency, for GBP, USD, JPY and KWD', async () => {
    for (const currency of CURRENCIES) {
      fakeApi({ currency })
      const view = renderWithProviders(<CustomersListPage />)
      await screen.findByTestId(CUSTOMER_ROW)

      await waitFor(() => expect(text(totalSpent()), currency).toBe(shownAs(5000, currency)))
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('AC-4: the customer’s profile shows lifetime value 3500 and average order 1750 in the store currency, for GBP, USD, JPY and KWD', async () => {
    for (const currency of CURRENCIES) {
      fakeApi({ currency })
      const view = renderWithProviders(<CustomerProfileCard customer={CUSTOMER} stats={STATS} />)

      await waitFor(() => {
        expect(text(screen.getByTestId(LIFETIME)), currency).toContain(shownAs(3500, currency))
        expect(text(screen.getByTestId(AVG_ORDER)), currency).toContain(shownAs(1750, currency))
      })
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('AC-5: the assistant’s customer card shows a JPY store’s 98765 lifetime as JP¥98,765, with no £', async () => {
    fakeApi({ currency: 'JPY' })
    renderWithProviders(<AssistantRecordCard record={{ kind: 'customer', id: CUSTOMER.id }} />)
    const card = await screen.findByTestId(CARD)
    await waitFor(() => expect(text(card)).toContain(`${CUSTOMER.firstName} ${CUSTOMER.lastName}`))

    await waitFor(() => expect(text(card)).toContain(shownAs(98_765, 'JPY')))
    expect(text(card)).not.toContain('£')
  })

  it('AC-7: until the session answer is in, the price, the total spent, both profile stats and the card’s lifetime read — with no currency sign beside names and counts; once it answers JPY they read the JPY amounts', async () => {
    const api = fakeApi('held')
    renderSurfaces()
    await screen.findByTestId(PRODUCT_ROW)
    await screen.findByTestId(CUSTOMER_ROW)
    const card = await screen.findByTestId(CARD)
    await waitFor(() => expect(text(card)).toContain(CUSTOMER.email))

    expect(text(price()), 'the price').toBe(DASH)
    expect(text(totalSpent()), 'the total spent').toBe(DASH)
    expect(text(within(screen.getByTestId(LIFETIME)).getByText(DASH)), 'lifetime value').toBe(DASH)
    expect(text(within(screen.getByTestId(AVG_ORDER)).getByText(DASH)), 'average order').toBe(DASH)
    expect(text(card), 'the card').toContain(DASH)
    const surfaces = [
      screen.getByTestId(PRODUCT_ROW),
      screen.getByTestId(CUSTOMER_ROW),
      screen.getByTestId(LIFETIME),
      screen.getByTestId(AVG_ORDER),
      card,
    ]
    expect(surfaces.map(signsIn), 'currency signs shown').toEqual(surfaces.map(() => []))
    expect(text(screen.getByTestId(PRODUCT_ROW))).toContain(PRODUCT.name)
    expect(text(cellUnder(CUSTOMER_ROW, 'Orders'))).toBe(String(CUSTOMER.orderCount))

    api.release('JPY')

    await waitFor(() => expect(text(price())).toBe(shownAs(1500, 'JPY')))
    expect(text(totalSpent())).toBe(shownAs(5000, 'JPY'))
    expect(text(screen.getByTestId(LIFETIME))).toContain(shownAs(3500, 'JPY'))
    expect(text(screen.getByTestId(AVG_ORDER))).toContain(shownAs(1750, 'JPY'))
    expect(text(card)).toContain(shownAs(98_765, 'JPY'))
  })

  it('AC-7: with the session answer refused, the money reads — with no currency sign while names and counts render', async () => {
    fakeApi('refused')
    const view = renderSurfaces()
    await screen.findByTestId(PRODUCT_ROW)
    await screen.findByTestId(CUSTOMER_ROW)
    const card = await screen.findByTestId(CARD)
    await waitFor(() => expect(text(card)).toContain(CUSTOMER.email))

    expect(text(price()), 'the price').toBe(DASH)
    await waitFor(() => expect(view.queryClient.getQueryState(['me'])?.status).toBe('error'))

    expect(text(price()), 'the price').toBe(DASH)
    expect(text(totalSpent()), 'the total spent').toBe(DASH)
    expect(text(within(screen.getByTestId(LIFETIME)).getByText(DASH)), 'lifetime value').toBe(DASH)
    expect(text(within(screen.getByTestId(AVG_ORDER)).getByText(DASH)), 'average order').toBe(DASH)
    expect(text(card), 'the card').toContain(DASH)
    const surfaces = [
      screen.getByTestId(PRODUCT_ROW),
      screen.getByTestId(CUSTOMER_ROW),
      screen.getByTestId(LIFETIME),
      screen.getByTestId(AVG_ORDER),
      card,
    ]
    expect(surfaces.map(signsIn), 'currency signs shown').toEqual(surfaces.map(() => []))
    expect(text(screen.getByTestId(PRODUCT_ROW))).toContain(PRODUCT.name)
    expect(text(cellUnder(CUSTOMER_ROW, 'Orders'))).toBe(String(CUSTOMER.orderCount))
    expect(text(card)).toContain(`${CARD_STATS.orderCount} orders`)
  })
})
