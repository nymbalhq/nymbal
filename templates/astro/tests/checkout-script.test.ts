// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// P1-12 AC-6 and decision 12 (Astro): the checkout script (`src/scripts/checkout.ts`) on the checkout page's markup,
// with the real SDK client store over a fake `fetch` and Stripe mocked, `confirmCardPayment` deferred. Decision 2: the
// script follows the server's `payment.status`, not PUBLIC_NYMBAL_PAYMENTS_PROVIDER: `requires_action` with a Stripe
// client confirms first and leaves for /order/<n> only after the confirmation resolves without error; `succeeded`
// leaves straight away; `failed` stays on checkout with the reason. Kills: the script losing the branch (an env check
// that confirms a server-captured payment again, or a redirect for a failed payment) and a redirect after a Stripe
// error.

const API = 'http://api.test'
const ORDER_NUMBER = 'NYM-2042'
const CLIENT_SECRET = 'pi_ac6_astro_secret_91bc'

const stripe = vi.hoisted(() => ({
  confirmCardPayment: (() => undefined) as unknown as ReturnType<typeof vi.fn>,
  mounted: 0,
  elements() {
    return {
      create() {
        return {
          mount() {
            stripe.mounted += 1
          },
        }
      },
    }
  },
}))

vi.mock('@stripe/stripe-js', () => ({
  loadStripe: () => Promise.resolve(stripe),
}))

// The storefront's custom elements are not under test; the SDK client the script drives is real.
vi.mock('@nymbalhq/web-components', () => ({
  registerClient: () => undefined,
  registerComponents: () => undefined,
}))

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

function fakeApi(payment: PaymentOutcome) {
  const requests: Array<{ method: string; path: string }> = []
  const orderStatus =
    payment.status === 'succeeded'
      ? 'confirmed'
      : payment.status === 'failed'
        ? 'cancelled'
        : 'pending'
  const cart = {
    token: 'cart-ac6-astro',
    items: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productName: 'Deferred Widget',
        variantName: 'Default',
        priceMinor: 1800,
        imageUrl: '',
        qty: 1,
      },
    ],
    subtotalMinor: 1800,
    currency: 'GBP',
  }
  const checkout = {
    orderId: 'ord-ac6-astro',
    orderNumber: ORDER_NUMBER,
    paymentIntent: {
      id: 'pi_ac6_astro',
      clientSecret: CLIENT_SECRET,
      amountMinor: 1800,
      currency: 'GBP',
      status: payment.status === 'requires_action' ? 'requires_payment_method' : payment.status,
    },
    currency: 'GBP',
    totalMinor: 1800,
    orderStatus,
    payment,
  }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
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

/** Every way the script can leave the page: `location.href = …`, `assign`, `replace`. */
function fakeLocation() {
  const navigations: string[] = []
  let href = 'http://shop.test/checkout'
  const location = {
    get href() {
      return href
    },
    set href(next: string) {
      navigations.push(next)
      href = new URL(next, href).toString()
    },
    assign(next: string) {
      navigations.push(next)
    },
    replace(next: string) {
      navigations.push(next)
    },
    reload() {},
    get origin() {
      return new URL(href).origin
    },
    get pathname() {
      return new URL(href).pathname
    },
    get search() {
      return new URL(href).search
    },
    get hash() {
      return new URL(href).hash
    },
    get host() {
      return new URL(href).host
    },
    get hostname() {
      return new URL(href).hostname
    },
    get protocol() {
      return new URL(href).protocol
    },
  }
  return { navigations, location }
}

/** The ids and names `src/pages/checkout.astro` (and its AddressForm) give the script. */
const address = (id: string) =>
  [
    'firstName',
    'lastName',
    'addressLine1',
    'addressLine2',
    'city',
    'region',
    'postalCode',
    'country',
  ]
    .map((name) => `<input id="${id}-${name}" name="${name}" data-testid="${id}-${name}" />`)
    .join('')

const CHECKOUT_MARKUP = `
  <div id="checkout-steps-container">
    <div data-testid="checkout-step-contact"></div>
    <div class="checkout-step-divider"></div>
    <div data-testid="checkout-step-shipping"></div>
    <div class="checkout-step-divider"></div>
    <div data-testid="checkout-step-payment"></div>
  </div>
  <div id="checkout-error" style="display:none;" data-testid="checkout-error" role="alert"></div>
  <section id="checkout-contact">
    <form id="contact-form">
      <input type="email" id="contact-email" name="email" data-testid="contact-email" />
      <button type="submit" data-testid="contact-continue">Continue</button>
    </form>
  </section>
  <section id="checkout-shipping" style="display:none;">
    <form id="shipping-form">
      <div data-testid="shipping-form">${address('shipping')}</div>
      <button type="submit" data-testid="shipping-continue">Continue</button>
    </form>
  </section>
  <section id="checkout-payment" style="display:none;">
    <form id="payment-form" novalidate>
      <input type="checkbox" id="billing-same" checked />
      <div id="billing-fields" style="display:none;"><div id="billing-form">${address('billing')}</div></div>
      <div id="stripe-card-element" data-testid="stripe-card-element"></div>
      <button type="submit" data-testid="place-order">Place Order</button>
    </form>
  </section>
  <aside id="checkout-summary" data-testid="checkout-summary"></aside>
`

function byTestId<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (el === null) throw new Error(`no [data-testid="${id}"] in the checkout markup`)
  return el
}

function setValue(id: string, value: string) {
  byTestId<HTMLInputElement>(id).value = value
}

async function loadCheckout(env: { stripeConfigured: boolean }) {
  vi.stubEnv('PUBLIC_NYMBAL_API_URL', API)
  vi.stubEnv('PUBLIC_NYMBAL_PAYMENTS_PROVIDER', env.stripeConfigured ? 'stripe' : 'native-stub')
  vi.stubEnv('PUBLIC_STRIPE_PUBLISHABLE_KEY', env.stripeConfigured ? 'pk_test_ac6' : '')
  vi.resetModules()
  document.body.innerHTML = CHECKOUT_MARKUP
  await import('../src/scripts/checkout')
  // The script mounts Stripe's card element on load when a Stripe client is configured.
  if (env.stripeConfigured) await vi.waitFor(() => expect(stripe.mounted).toBeGreaterThan(0))
}

/** Contact, shipping, then Place Order, as the shopper submits each form. */
function placeOrder() {
  setValue('contact-email', 'ada@ac6.test')
  byTestId('contact-continue').click()
  setValue('shipping-firstName', 'Ada')
  setValue('shipping-lastName', 'Buyer')
  setValue('shipping-addressLine1', '1 Main St')
  setValue('shipping-city', 'London')
  setValue('shipping-region', 'England')
  setValue('shipping-postalCode', 'E1 6AN')
  setValue('shipping-country', 'GB')
  byTestId('shipping-continue').click()
  byTestId('place-order').click()
}

let nav: ReturnType<typeof fakeLocation>

const toOrderPage = () => nav.navigations.filter((href) => href.includes(`/order/${ORDER_NUMBER}`))

beforeEach(() => {
  stripe.mounted = 0
  nav = fakeLocation()
  vi.stubGlobal('location', nav.location)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AC-6: the Astro checkout script follows the server payment status', () => {
  it('AC-6: requires_action with Stripe configured: confirmCardPayment gets the submit response secret, no navigation before it resolves, navigation to /order/<n> after', async () => {
    const api = fakeApi({ status: 'requires_action' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const confirmation = deferred<{
      paymentIntent?: { status: string }
      error?: { message: string }
    }>()
    stripe.confirmCardPayment = vi.fn(() => confirmation.promise)
    await loadCheckout({ stripeConfigured: true })

    placeOrder()
    await vi.waitFor(() => expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(1))
    const navigationsWhilePending = toOrderPage().length

    confirmation.resolve({ paymentIntent: { status: 'succeeded' } })
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

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
    await loadCheckout({ stripeConfigured: true })

    placeOrder()
    await vi.waitFor(() => expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(1))
    confirmation.resolve({ error: { message: 'Your card was declined (ac6).' } })

    await vi.waitFor(() =>
      expect(byTestId('checkout-error').textContent).toContain('Your card was declined (ac6).'),
    )
    expect(toOrderPage()).toEqual([])
  })

  it('AC-6: succeeded with Stripe configured goes to /order/<n> without asking Stripe to confirm', async () => {
    const api = fakeApi({ status: 'succeeded' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await loadCheckout({ stripeConfigured: true })

    placeOrder()
    await vi.waitFor(() =>
      expect(
        api.requests.filter((r) => r.method === 'POST' && r.path === '/api/checkout'),
      ).toHaveLength(1),
    )
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })

  it('AC-6: failed stays on checkout with the error shown, no navigation, and Stripe is never asked', async () => {
    const api = fakeApi({ status: 'failed', reason: 'stub_declined' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await loadCheckout({ stripeConfigured: true })

    placeOrder()
    await vi.waitFor(() =>
      expect(byTestId('checkout-error').textContent?.trim().length ?? 0).toBeGreaterThan(0),
    )

    expect(toOrderPage()).toEqual([])
    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })

  it('AC-6: requires_action on a store with no Stripe client (a +stub-pending order) goes to /order/<n> to show it awaiting payment', async () => {
    const api = fakeApi({ status: 'requires_action' })
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    stripe.confirmCardPayment = vi.fn(() => deferred().promise)
    await loadCheckout({ stripeConfigured: false })

    placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(stripe.confirmCardPayment).toHaveBeenCalledTimes(0)
  })
})
