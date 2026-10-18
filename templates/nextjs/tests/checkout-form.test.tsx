// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

// P1-12 AC-6 (Next): the checkout form with the real @nymbalhq/react provider and the real SDK store over a fake
// `fetch`, `next/navigation` and Stripe mocked, `confirmCardPayment` deferred. Decision 2: the form follows the
// server's `payment.status`, not an env var: `requires_action` with Stripe configured confirms with Stripe and goes to
// the order page only after the confirmation resolves without error; `succeeded` goes straight there; `failed` stays.
// Kills: the handler reading the render-time snapshot (Stripe never confirms), the effect redirecting on "order
// created" before Stripe, and a redirect after a Stripe error.

const API = 'http://api.test'
const ORDER_NUMBER = 'NYM-1042'
const CLIENT_SECRET = 'pi_ac6_next_secret_7f3a'

const navigation = vi.hoisted(() => {
  const calls: string[] = []
  const router = {
    push: (href: string) => {
      calls.push(href)
    },
    replace: (href: string) => {
      calls.push(href)
    },
    prefetch: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    refresh: () => undefined,
  }
  return { calls, router }
})

const stripe = vi.hoisted(() => ({
  confirmCardPayment: (() => undefined) as unknown as ReturnType<typeof vi.fn>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => navigation.router,
  usePathname: () => '/checkout',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: () => Promise.resolve(stripe),
}))

vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: { children: unknown }) => children,
  CardElement: () => null,
  useStripe: () => stripe,
  useElements: () => ({ getElement: () => ({ card: 'mounted' }) }),
}))

vi.mock('@/lib/format', () => ({
  formatPrice: (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`,
}))

vi.mock('@/styles/pages/checkout.module.css', () => ({ default: {} }))

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type PaymentOutcome = { status: 'succeeded' | 'requires_action' | 'failed'; reason?: string }

/** The API as the SDK sees it; records every request so a test can tell when the submit was answered. */
function fakeApi(payment: PaymentOutcome) {
  const requests: Array<{ method: string; path: string }> = []
  const orderStatus =
    payment.status === 'succeeded'
      ? 'confirmed'
      : payment.status === 'failed'
        ? 'cancelled'
        : 'pending'
  const cart = {
    token: 'cart-ac6',
    items: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productName: 'Deferred Widget',
        variantName: 'Default',
        priceMinor: 2500,
        imageUrl: '',
        qty: 1,
      },
    ],
    subtotalMinor: 2500,
    currency: 'GBP',
  }
  const checkout = {
    orderId: 'ord-ac6',
    orderNumber: ORDER_NUMBER,
    paymentIntent: {
      id: 'pi_ac6_next',
      clientSecret: CLIENT_SECRET,
      amountMinor: 2500,
      currency: 'GBP',
      status: payment.status === 'requires_action' ? 'requires_payment_method' : payment.status,
    },
    currency: 'GBP',
    totalMinor: 2500,
    orderStatus,
    payment,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    requests.push({ method, path: url.pathname })
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-ac6' } })
    if (url.pathname === '/api/cart') return json(200, { data: cart })
    if (url.pathname === '/api/checkout' && method === 'POST') return json(200, { data: checkout })
    if (url.pathname === `/api/orders/${ORDER_NUMBER}`) {
      return json(200, { data: { orderNumber: ORDER_NUMBER, status: orderStatus } })
    }
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
  return { requests, fetchImpl }
}

async function renderCheckout(env: { stripeConfigured: boolean }) {
  vi.stubEnv(
    'NEXT_PUBLIC_NYMBAL_PAYMENTS_PROVIDER',
    env.stripeConfigured ? 'stripe' : 'native-stub',
  )
  vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', env.stripeConfigured ? 'pk_test_ac6' : '')
  vi.resetModules()
  const { createNymbalClient } = await import('@nymbalhq/sdk')
  const { NymbalProvider } = await import('@nymbalhq/react')
  const { CheckoutForm } = await import('../components/client/CheckoutForm')
  const client = createNymbalClient({ baseUrl: API })
  render(
    <NymbalProvider client={client}>
      <CheckoutForm />
    </NymbalProvider>,
  )
}

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

/** Contact, shipping, then Place Order: the shopper's path to the submit. */
async function placeOrder() {
  fill('contact-email', 'ada@ac6.test')
  fireEvent.click(screen.getByTestId('contact-continue'))
  await screen.findByTestId('shipping-firstName')
  fill('shipping-firstName', 'Ada')
  fill('shipping-lastName', 'Buyer')
  fill('shipping-addressLine1', '1 Main St')
  fill('shipping-city', 'London')
  fill('shipping-region', 'England')
  fill('shipping-postalCode', 'E1 6AN')
  fill('shipping-country', 'GB')
  fireEvent.click(screen.getByTestId('shipping-continue'))
  const button = await screen.findByTestId('place-order')
  fireEvent.click(button)
}

const toOrderPage = (calls: string[]) =>
  calls.filter((href) => href.includes(`/order/${ORDER_NUMBER}`))

beforeEach(() => {
  navigation.calls.length = 0
})

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('AC-6: Next CheckoutForm follows the server payment status', () => {
  it('AC-6: requires_action with Stripe configured: confirmCardPayment gets the submit response secret, no navigation before it resolves, navigation to /order/<n> after', async () => {
    const api = fakeApi({ status: 'requires_action' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const confirmation = deferred<{
      paymentIntent?: { status: string }
      error?: { message: string }
    }>()
    stripe.confirmCardPayment = vi.fn(() => confirmation.promise)
    await renderCheckout({ stripeConfigured: true })

    await placeOrder()
    await vi.waitFor(() =>
      expect(
        api.requests.filter((r) => r.method === 'POST' && r.path === '/api/checkout'),
      ).toHaveLength(1),
    )
    await vi.waitFor(() => expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(1))
    const navigationsWhilePending = toOrderPage(navigation.calls).length

    confirmation.resolve({ paymentIntent: { status: 'succeeded' } })
    await vi.waitFor(() => expect(toOrderPage(navigation.calls).length).toBeGreaterThan(0))

    expect(navigationsWhilePending).toBe(0)
    expect(vi.mocked(stripe.confirmCardPayment).mock.calls[0]![0]).toBe(CLIENT_SECRET)
  })

  it('AC-6: requires_action with Stripe configured and a Stripe error: the error is shown and there is no navigation', async () => {
    const api = fakeApi({ status: 'requires_action' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const confirmation = deferred<{
      paymentIntent?: { status: string }
      error?: { message: string }
    }>()
    stripe.confirmCardPayment = vi.fn(() => confirmation.promise)
    await renderCheckout({ stripeConfigured: true })

    await placeOrder()
    await vi.waitFor(() => expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(1))
    confirmation.resolve({ error: { message: 'Your card was declined (ac6).' } })

    const shown = await screen.findByText(/Your card was declined \(ac6\)\./)
    expect(shown.textContent).toContain('Your card was declined (ac6).')
    expect(toOrderPage(navigation.calls)).toEqual([])
  })

  it('AC-6: succeeded with Stripe configured goes to /order/<n> without asking Stripe to confirm', async () => {
    const api = fakeApi({ status: 'succeeded' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await renderCheckout({ stripeConfigured: true })

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage(navigation.calls).length).toBeGreaterThan(0))

    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })

  it('AC-6: failed stays on checkout with an error and no navigation, and Stripe is never asked', async () => {
    const api = fakeApi({ status: 'failed', reason: 'stub_declined' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await renderCheckout({ stripeConfigured: true })

    await placeOrder()
    const alert = await screen.findByRole('alert')

    expect(alert.textContent?.trim().length ?? 0).toBeGreaterThan(0)
    expect(toOrderPage(navigation.calls)).toEqual([])
    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })

  it('AC-6: requires_action on a store with no Stripe client (a +stub-pending order) goes to /order/<n> to show it awaiting payment', async () => {
    const api = fakeApi({ status: 'requires_action' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await renderCheckout({ stripeConfigured: false })

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage(navigation.calls).length).toBeGreaterThan(0))

    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })
})
