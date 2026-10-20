// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerPaymentDriver, type PaymentDriver } from '@nymbalhq/sdk'
import {
  deferred,
  installFakeStripe,
  type Deferred,
  type FakeStripe,
} from '../../../tests/support/fake-stripe'

// P2-05 AC-2 (Astro), after P1-12 AC-6: the checkout script (`src/scripts/checkout.ts`) on the checkout page's markup,
// with the real SDK client over a fake `fetch` and the real <nymbal-payment-element>, which the page renders with the
// payments client half from GET /api/capabilities. The script follows the server's `payment.status` and, on
// `requires_action`, asks the element to confirm with the submit response's client secret before it navigates:
// `{ ok: true, confirmed: true }` marks the checkout confirmed and goes to /order/<n>; `{ ok: true, confirmed: false }`
// goes there as pending; `{ ok: false, error }` stays on checkout with the error shown and Place Order enabled. The
// drivers: one registered as a project's client bootstrap would (no template change), the built-in test-mode and
// stripe (a fake window.Stripe, no network), a null client and an unknown driver (error shown, Place Order disabled).
// Kills: a script that still branches on the vendor or its env vars, a driver that is not called, a redirect before
// or after a failed confirmation, and an SDK state that claims a payment the API does not have (markConfirmed for a
// pending order).

// One SDK and one web-components instance for the whole file: the custom element, defined once per window, must look
// drivers up in the same registry the test registers them in, across the module resets that rerun the script.
vi.mock('@nymbalhq/sdk', async (importOriginal) => {
  const g = globalThis as { __p205Sdk?: unknown }
  g.__p205Sdk ??= await importOriginal()
  return g.__p205Sdk as object
})
vi.mock('@nymbalhq/web-components', async (importOriginal) => {
  const g = globalThis as { __p205Wc?: unknown }
  g.__p205Wc ??= await importOriginal()
  return g.__p205Wc as object
})

const API = 'http://api.test'
const ORDER_NUMBER = 'NYM-2042'
const CLIENT_SECRET = 'pi_p2_05_astro_secret_91bc'
const DECLINE = 'Your card was declined (p2-05 astro).'

type Confirmation = Awaited<ReturnType<PaymentDriver['confirm']>>
type PaymentClient = { driver: string; options: Record<string, string> } | null
type PaymentOutcome = { status: 'succeeded' | 'requires_action' | 'failed'; reason?: string }

function fakeApi(payment: PaymentOutcome, client: PaymentClient) {
  const requests: Array<{ method: string; path: string }> = []
  const orderStatus =
    payment.status === 'succeeded'
      ? 'confirmed'
      : payment.status === 'failed'
        ? 'cancelled'
        : 'pending'
  const cart = {
    token: 'cart-p2-05-astro',
    items: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productName: 'Driver Widget',
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
    orderId: 'ord-p2-05-astro',
    orderNumber: ORDER_NUMBER,
    paymentIntent: {
      id: 'pi_p2_05_astro',
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
  const capabilities = {
    payments: { capabilities: ['intent', 'capture', 'refund'], client },
    search: { capabilities: ['index', 'search', 'facet'] },
    catalog: {
      sortKeys: ['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc'],
      defaultSort: 'newest',
    },
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
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-p2-05' } })
    if (url.pathname === '/api/cart') return json(200, { data: cart })
    if (url.pathname === '/api/capabilities') return json(200, { data: capabilities })
    if (url.pathname === '/api/checkout' && method === 'POST') return json(200, { data: checkout })
    if (url.pathname === `/api/orders/${ORDER_NUMBER}`) {
      return json(200, { data: { orderNumber: ORDER_NUMBER, status: orderStatus } })
    }
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
  const checkoutPosts = () =>
    requests.filter((r) => r.method === 'POST' && r.path === '/api/checkout').length
  return { requests, fetchImpl, checkoutPosts }
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

/**
 * The page as checkout.astro renders it: the payment element carries the report's client half as JSON, and Place
 * Order is rendered enabled (the script, not the markup, holds it while the element cannot take a payment).
 */
const checkoutMarkup = (client: PaymentClient) => `
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
      <nymbal-payment-element data-testid="payment-element" client='${JSON.stringify(client)}'></nymbal-payment-element>
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

const errorText = () => byTestId('checkout-error').textContent ?? ''

/** What the SDK's checkout state said along the way: `succeeded` after a `requires_action` comes from markConfirmed. */
interface Watch {
  claimedPaid(): boolean
}

/**
 * Loads the page: markup first (the server render), then the client bootstrap and the checkout script, as the page's
 * module scripts run. `bootstrap` registers a project's own driver, as `src/lib/client.ts` would, before any of it.
 */
async function loadCheckout(client: PaymentClient, bootstrap?: () => void): Promise<Watch> {
  vi.stubEnv('PUBLIC_NYMBAL_API_URL', API)
  vi.resetModules()
  bootstrap?.()
  document.body.innerHTML = checkoutMarkup(client)
  const { client: sdk } = await import('../src/lib/client')
  const statuses: string[] = []
  sdk.checkout.subscribe(() => statuses.push(sdk.checkout.getState().paymentStatus))
  await import('../src/scripts/checkout')
  return { claimedPaid: () => statuses.includes('succeeded') }
}

function fillToPayment() {
  setValue('contact-email', 'ada@p2-05.test')
  byTestId('contact-continue').click()
  setValue('shipping-firstName', 'Ada')
  setValue('shipping-lastName', 'Buyer')
  setValue('shipping-addressLine1', '1 Main St')
  setValue('shipping-city', 'London')
  setValue('shipping-region', 'England')
  setValue('shipping-postalCode', 'E1 6AN')
  setValue('shipping-country', 'GB')
  byTestId('shipping-continue').click()
}

/** Contact, shipping, then Place Order once the page lets the shopper press it. */
async function placeOrder() {
  fillToPayment()
  const button = byTestId<HTMLButtonElement>('place-order')
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  button.click()
}

let nav: ReturnType<typeof fakeLocation>
let stripe: FakeStripe | null = null
let seq = 0

const toOrderPage = () => nav.navigations.filter((href) => href.includes(`/order/${ORDER_NUMBER}`))

/** A driver of the project's own whose confirm the test answers; records each secret and the navigations so far. */
function ownDriver() {
  const name = `p2-05-own-${++seq}`
  const answer: Deferred<Confirmation> = deferred()
  const confirms: Array<{ secret: string; navigationsBefore: number }> = []
  const driver: PaymentDriver = {
    mount(el: HTMLElement) {
      el.insertAdjacentHTML('beforeend', '<p data-p2-05-own-driver>Own driver</p>')
    },
    confirm(clientSecret: string) {
      confirms.push({ secret: clientSecret, navigationsBefore: toOrderPage().length })
      return answer.promise
    },
  }
  return {
    client: { driver: name, options: {} },
    answer,
    confirms,
    register: () => registerPaymentDriver(name, driver),
  }
}

beforeEach(() => {
  nav = fakeLocation()
  vi.stubGlobal('location', nav.location)
})

afterEach(() => {
  stripe?.uninstall()
  stripe = null
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AC-2: the Astro checkout confirms through the payment element', () => {
  const outcomes: Array<{ name: string; answer: Confirmation }> = [
    { name: 'confirmed', answer: { ok: true, confirmed: true } },
    { name: 'ok and not confirmed', answer: { ok: true, confirmed: false } },
    { name: 'declined', answer: { ok: false, error: DECLINE } },
  ]

  for (const { name, answer } of outcomes) {
    it(`AC-2: requires_action, a driver from the client bootstrap answers ${name}: confirm gets the response's secret before any navigation; /order/<n> iff ok; markConfirmed iff confirmed`, async () => {
      const api = fakeApi({ status: 'requires_action' }, null)
      vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
      const own = ownDriver()
      const watch = await loadCheckout(own.client, own.register)
      await vi.waitFor(() =>
        expect(byTestId('payment-element').querySelector('[data-p2-05-own-driver]')).not.toBeNull(),
      )

      await placeOrder()
      await vi.waitFor(() => expect(own.confirms.length).toBeGreaterThan(0))
      own.answer.resolve(answer)
      await vi.waitFor(() =>
        expect(toOrderPage().length + (errorText().trim() === '' ? 0 : 1)).toBeGreaterThan(0),
      )

      expect(own.confirms).toEqual([{ secret: CLIENT_SECRET, navigationsBefore: 0 }])
      expect(toOrderPage().length > 0).toBe(answer.ok)
      expect(errorText().includes(DECLINE)).toBe(!answer.ok)
      expect(watch.claimedPaid()).toBe(answer.ok && answer.confirmed)
      expect(api.checkoutPosts()).toBe(1)
    })
  }

  it('AC-2: after a declined confirmation Place Order is enabled again and the shopper is still on checkout', async () => {
    const api = fakeApi({ status: 'requires_action' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const own = ownDriver()
    await loadCheckout(own.client, own.register)

    await placeOrder()
    await vi.waitFor(() => expect(own.confirms.length).toBeGreaterThan(0))
    own.answer.resolve({ ok: false, error: DECLINE })
    await vi.waitFor(() => expect(errorText()).toContain(DECLINE))

    await vi.waitFor(() => expect(byTestId<HTMLButtonElement>('place-order').disabled).toBe(false))
    expect(toOrderPage()).toEqual([])
  })

  it('AC-2: test-mode on requires_action (a +stub-pending order) shows "Test mode — payment skipped", goes to /order/<n> as pending, and never marks the checkout confirmed', async () => {
    const client = { driver: 'test-mode', options: {} }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = await loadCheckout(client)
    await vi.waitFor(() =>
      expect(byTestId('payment-element').textContent).toContain('Test mode — payment skipped'),
    )

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(watch.claimedPaid()).toBe(false)
    expect(api.checkoutPosts()).toBe(1)
  })

  it('AC-2: a null client renders no payment UI; requires_action goes to /order/<n> as pending and never marks the checkout confirmed', async () => {
    const api = fakeApi({ status: 'requires_action' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = await loadCheckout(null)

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    const element = byTestId('payment-element') as HTMLElement & {
      confirm?: (secret: string) => Promise<Confirmation>
    }
    expect(element.textContent?.trim()).toBe('')
    expect(watch.claimedPaid()).toBe(false)
    // The element is the package's, upgraded: a null client's confirm is ok and confirms nothing.
    expect(await element.confirm?.(CLIENT_SECRET)).toEqual({ ok: true, confirmed: false })
  })

  it('AC-2: stripe (a fake window.Stripe, no network) on requires_action: confirmCardPayment gets the secret before any navigation, then the checkout is confirmed and goes to /order/<n>', async () => {
    stripe = installFakeStripe()
    const confirmation = deferred<{ paymentIntent?: { status: string } }>()
    const navigationsAtConfirm: number[] = []
    stripe.answer = () => {
      navigationsAtConfirm.push(toOrderPage().length)
      return confirmation.promise
    }
    const client = { driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_astro_ok' } }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = await loadCheckout(client)
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))

    await placeOrder()
    await vi.waitFor(() => expect(stripe!.confirmCalls.length).toBeGreaterThan(0))
    confirmation.resolve({ paymentIntent: { status: 'succeeded' } })
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(stripe.confirmCalls.map((c) => c.clientSecret)).toEqual([CLIENT_SECRET])
    expect(navigationsAtConfirm).toEqual([0])
    expect(stripe.keys).toContain('pk_test_p2_05_astro_ok')
    expect(watch.claimedPaid()).toBe(true)
  })

  it('AC-2: stripe answering with a Stripe error stays on checkout with its message, Place Order enabled, no navigation and no confirmed claim', async () => {
    stripe = installFakeStripe()
    stripe.answer = async () => ({ error: { message: 'Your card was declined (stripe astro).' } })
    const client = { driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_astro_err' } }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = await loadCheckout(client)
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))

    await placeOrder()
    await vi.waitFor(() => expect(errorText()).toContain('Your card was declined (stripe astro).'))

    await vi.waitFor(() => expect(byTestId<HTMLButtonElement>('place-order').disabled).toBe(false))
    expect(toOrderPage()).toEqual([])
    expect(watch.claimedPaid()).toBe(false)
  })

  it('AC-2: an unknown driver shows payment-element-error and keeps Place Order disabled: pressing it places no order', async () => {
    const client = { driver: 'p2-05-unregistered', options: {} }
    const api = fakeApi({ status: 'succeeded' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    await loadCheckout(client)
    await vi.waitFor(() =>
      expect(
        byTestId('payment-element').querySelector('[data-testid="payment-element-error"]'),
      ).not.toBeNull(),
    )

    fillToPayment()
    const button = byTestId<HTMLButtonElement>('place-order')
    await vi.waitFor(() => expect(button.disabled).toBe(true))
    button.click()

    expect(api.checkoutPosts()).toBe(0)
    expect(toOrderPage()).toEqual([])
  })

  it('AC-2: succeeded at the server goes to /order/<n> without asking the driver to confirm', async () => {
    const api = fakeApi({ status: 'succeeded' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const own = ownDriver()
    await loadCheckout(own.client, own.register)

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(own.confirms).toEqual([])
    expect(api.checkoutPosts()).toBe(1)
  })

  it('AC-2: failed at the server stays on checkout with the error shown, no navigation, and the driver is never asked', async () => {
    const api = fakeApi({ status: 'failed', reason: 'stub_declined' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const own = ownDriver()
    await loadCheckout(own.client, own.register)

    await placeOrder()
    await vi.waitFor(() => expect(errorText().trim().length).toBeGreaterThan(0))

    expect(toOrderPage()).toEqual([])
    expect(own.confirms).toEqual([])
  })
})
