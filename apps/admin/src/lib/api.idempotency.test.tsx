import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OrderStatusSelect } from '@/components/orders/OrderStatusSelect'
import { clearToken, setToken } from '@/lib/auth'
import { InventoryPage } from '@/pages/InventoryPage'
import { ProductEditPage } from '@/pages/ProductEditPage'
import { renderWithProviders } from '@/tests/render'

// Acceptance tests for P3-04 AC-4 (spec P3-04-audit-trail, decision 5): the admin sends one Idempotency-Key per user
// intent. A stock adjust, a status change and a product save each send a well-formed key; two clicks inside one intent
// (a double click that lands before the re-render disables the button) send the same key; the next intent (the next
// adjust of a row, the next status, the next save) a new one; and the admin's own re-sends of a request, after a CSRF
// refusal and after a 401 refresh, reuse that request's key. The pages run against a fake API (fetch stubbed); nothing
// here knows how the key is made or held.
// Kills: no key sent (today); a fresh key per network attempt, which defeats idempotency; one key reused across intents,
// which the API would answer as a replay or a 409.

const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

interface Call {
  method: string
  path: string
  key: string | null
  authorization: string | null
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const ROWS = ['v-a', 'v-b'].map((variantId, i) => ({
  variantId,
  productId: `p-${i}`,
  productName: `Product ${i}`,
  sku: `SKU-${i}`,
  options: [],
  stock: 10,
  threshold: 0,
  status: 'in_stock',
  updatedAt: '2026-10-21T10:00:00.000Z',
}))

const PRODUCT = {
  id: 'p-1',
  slug: 'widget',
  name: 'Widget',
  description: '',
  shortDescription: '',
  status: 'active',
  type: 'simple',
  seoTitle: '',
  seoDescription: '',
  media: [],
  variants: [],
  categoryIds: [],
  metadata: {},
  createdAt: '2026-10-21T10:00:00.000Z',
  updatedAt: '2026-10-21T10:00:00.000Z',
}

const ORDER = {
  id: 'o-1',
  orderNumber: 'NYM-1',
  status: 'processing',
  totalMinor: 1000,
  currency: 'GBP',
}

/**
 * A fake API. `refuseCsrfOnce` answers the first unsafe call to a matching path 403 `csrf.invalid`; `expireOnce`
 * answers matching unsafe calls 401 until one carries the refreshed token.
 */
function fakeApi(opts: { refuseCsrfOnce?: RegExp; expireOnce?: RegExp } = {}) {
  const calls: Call[] = []
  let refusedCsrf = false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const path = url.pathname
    calls.push({
      method,
      path,
      key: headers.get('idempotency-key'),
      authorization: headers.get('authorization'),
    })
    const unsafe = method !== 'GET'

    if (path === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (path === '/api/auth/refresh')
      return json({ data: { accessToken: 'fresh-1', expiresIn: 900 } })
    if (path === '/api/admin/me') {
      return json({
        data: { userId: 'u-1', roles: ['admin'], storeName: 'Shop', environment: 'development' },
      })
    }
    if (unsafe && opts.refuseCsrfOnce?.test(path) && !refusedCsrf) {
      refusedCsrf = true
      return json({ error: { code: 'csrf.invalid', message: 'CSRF token invalid' } }, 403)
    }
    if (
      unsafe &&
      opts.expireOnce?.test(path) &&
      headers.get('authorization') !== 'Bearer fresh-1'
    ) {
      return json({ error: { code: 'auth.token_expired', message: 'expired' } }, 401)
    }
    if (path === '/api/admin/inventory') return json({ data: ROWS })
    const adjusted = /^\/api\/admin\/inventory\/([^/]+)\/adjust$/.exec(path)
    if (adjusted) return json({ data: { newQty: 11, variantId: adjusted[1] } })
    if (/^\/api\/admin\/inventory\/[^/]+\/history$/.test(path)) return json({ data: [] })
    if (
      path === `/api/admin/products/${PRODUCT.slug}` ||
      path === `/api/admin/products/${PRODUCT.id}`
    ) {
      return json({ data: PRODUCT })
    }
    if (/^\/api\/admin\/orders\/o-1\//.test(path)) return json({ data: ORDER })
    return json({ data: {} })
  })
  return {
    calls,
    /** The keys of the unsafe calls to `pattern`, in order. */
    keysTo: (pattern: RegExp) =>
      calls.filter((c) => c.method !== 'GET' && pattern.test(c.path)).map((c) => c.key),
    callsTo: (pattern: RegExp) => calls.filter((c) => c.method !== 'GET' && pattern.test(c.path)),
  }
}

beforeAll(() => {
  // Radix Select measures and captures the pointer, which jsdom does not implement.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.scrollIntoView ??= () => {}
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearToken()
})

const ADJUST_A = /^\/api\/admin\/inventory\/v-a\/adjust$/
const ADJUST_ANY = /^\/api\/admin\/inventory\/[^/]+\/adjust$/

async function inventoryRow(variantId: string) {
  const row = await screen.findByTestId(`admin-inventory-adjust-${variantId}`, undefined, {
    timeout: 5000,
  })
  return {
    setDelta: (n: number) =>
      fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: String(n) } }),
    apply: () => within(row).getByRole('button', { name: 'Apply' }),
  }
}

function expectWellFormed(keys: Array<string | null>, what: string): void {
  expect(keys.length, `${what}: requests sent`).toBeGreaterThan(0)
  for (const key of keys) {
    expect(key !== null && KEY_PATTERN.test(key), `${what}: key ${JSON.stringify(key)}`).toBe(true)
  }
}

describe('P3-04 AC-4: the admin sends one Idempotency-Key per intent', () => {
  it('AC-4: a stock adjust sends a well-formed key, and a double click on Apply within the one action sends that same key', async () => {
    const api = fakeApi()
    renderWithProviders(<InventoryPage />)
    const row = await inventoryRow('v-a')

    row.setDelta(2)
    act(() => {
      row.apply().click()
      row.apply().click()
    })
    await waitFor(() => expect(api.callsTo(ADJUST_A).length).toBeGreaterThan(0))

    const keys = api.keysTo(ADJUST_A)
    expectWellFormed(keys, 'adjust')
    expect(new Set(keys).size, `keys ${JSON.stringify(keys)}`).toBe(1)
  })

  it('AC-4: the next adjust of the same row, and an adjust of the next row, each send a new key', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const api = fakeApi()
    renderWithProviders(<InventoryPage />)
    const a = await inventoryRow('v-a')
    const b = await inventoryRow('v-b')

    a.setDelta(1)
    fireEvent.click(a.apply())
    await waitFor(() => expect(api.callsTo(ADJUST_A).length).toBe(1))
    // The row's Apply is held for a moment after an adjust; the next adjust of it comes after.
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    a.setDelta(1)
    await waitFor(() => expect(a.apply()).toBeEnabled())
    fireEvent.click(a.apply())
    await waitFor(() => expect(api.callsTo(ADJUST_A).length).toBe(2))
    b.setDelta(1)
    fireEvent.click(b.apply())
    await waitFor(() => expect(api.callsTo(ADJUST_ANY).length).toBe(3))

    const keys = api.keysTo(ADJUST_ANY)
    expectWellFormed(keys, 'adjusts')
    expect(new Set(keys).size, `keys ${JSON.stringify(keys)}`).toBe(keys.length)
  })

  it('AC-4: a status change sends a well-formed key, and the next status change a new one', async () => {
    const api = fakeApi()
    const user = userEvent.setup()
    const { rerender } = renderWithProviders(
      <OrderStatusSelect
        orderId="o-1"
        currentStatus="confirmed"
        orderNumber="NYM-1"
        capturedMinor={1000}
      />,
    )

    await user.click(screen.getByTestId('admin-order-status-select'))
    await user.click(await screen.findByTestId('admin-order-status-option-processing'))
    await waitFor(() => expect(api.callsTo(/\/api\/admin\/orders\/o-1\/process$/).length).toBe(1))
    rerender(
      <OrderStatusSelect
        orderId="o-1"
        currentStatus="processing"
        orderNumber="NYM-1"
        capturedMinor={1000}
      />,
    )
    await user.click(screen.getByTestId('admin-order-status-select'))
    await user.click(await screen.findByTestId('admin-order-status-option-shipped'))
    await waitFor(() => expect(api.callsTo(/\/api\/admin\/orders\/o-1\/ship$/).length).toBe(1))

    const keys = api.keysTo(/\/api\/admin\/orders\/o-1\/(process|ship)$/)
    expectWellFormed(keys, 'status changes')
    expect(new Set(keys).size, `keys ${JSON.stringify(keys)}`).toBe(keys.length)
  })

  it('AC-4: a product save sends a well-formed key; a double click on Save sends that same key; the next save, after an edit, a new one', async () => {
    const api = fakeApi()
    const SAVE = /^\/api\/admin\/products\/p-1$/
    renderWithProviders(
      <Routes>
        <Route path="/products/:slug" element={<ProductEditPage />} />
      </Routes>,
      { initialPath: '/products/widget' },
    )
    const name = await screen.findByTestId('admin-product-name', undefined, { timeout: 5000 })
    await waitFor(() => expect(name).toHaveValue(PRODUCT.name))

    fireEvent.change(name, { target: { value: 'Widget, renamed' } })
    act(() => {
      screen.getByTestId('admin-product-save').click()
      screen.getByTestId('admin-product-save').click()
    })
    await waitFor(() => expect(api.callsTo(SAVE).length).toBeGreaterThan(0))
    await waitFor(() => expect(screen.getByTestId('admin-product-save')).toBeEnabled())
    const firstIntent = api.keysTo(SAVE)

    fireEvent.change(name, { target: { value: 'Widget, renamed again' } })
    fireEvent.click(screen.getByTestId('admin-product-save'))
    await waitFor(() => expect(api.callsTo(SAVE).length).toBe(firstIntent.length + 1))
    const next = api.keysTo(SAVE).at(-1)!

    expectWellFormed([...firstIntent, next], 'saves')
    expect(new Set(firstIntent).size, `first save's keys ${JSON.stringify(firstIntent)}`).toBe(1)
    expect(firstIntent.includes(next), `the next save's key ${next}`).toBe(false)
  })

  it('AC-4: the re-send after a CSRF refusal carries the refused request’s key', async () => {
    const api = fakeApi({ refuseCsrfOnce: ADJUST_A })
    renderWithProviders(<InventoryPage />)
    const row = await inventoryRow('v-a')

    row.setDelta(3)
    fireEvent.click(row.apply())
    await waitFor(() => expect(api.callsTo(ADJUST_A).length).toBe(2))

    const keys = api.keysTo(ADJUST_A)
    expectWellFormed(keys, 'adjust and its CSRF re-send')
    expect(keys[1]).toBe(keys[0])
  })

  it('AC-4: the re-send after a 401 and the shared refresh carries the first attempt’s key', async () => {
    const api = fakeApi({ expireOnce: ADJUST_A })
    setToken('expired')
    renderWithProviders(<InventoryPage />)
    const row = await inventoryRow('v-a')

    row.setDelta(4)
    fireEvent.click(row.apply())
    await waitFor(() => expect(api.callsTo(ADJUST_A).length).toBe(2))

    const attempts = api.callsTo(ADJUST_A)
    expect(attempts.map((c) => c.authorization)).toEqual(['Bearer expired', 'Bearer fresh-1'])
    expectWellFormed(
      attempts.map((c) => c.key),
      'adjust and its re-send',
    )
    expect(attempts[1]!.key).toBe(attempts[0]!.key)
  })
})
