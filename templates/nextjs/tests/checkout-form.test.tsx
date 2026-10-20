// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createNymbalClient,
  registerPaymentDriver,
  type NymbalClient,
  type PaymentDriver,
} from '@nymbalhq/sdk'
import { NymbalProvider } from '@nymbalhq/react'
import { registerClient, registerComponents } from '@nymbalhq/web-components'
import type { ComponentType } from 'react'
import { CheckoutForm as CheckoutFormComponent } from '../components/client/CheckoutForm'
import {
  deferred,
  installFakeStripe,
  type Deferred,
  type FakeStripe,
} from '../../../tests/support/fake-stripe'

// P2-05 AC-2 (Next), after P1-12 AC-6: the checkout form with the real @nymbalhq/react provider, the real SDK store
// over a fake `fetch` and the real <nymbal-payment-element> (registered as NymbalSetup registers the components), given
// the store's capabilities report as the checkout page's server component passes it. The form follows the server's
// `payment.status` and, on `requires_action`, asks the element to confirm with the submit response's client secret
// before it navigates: `{ ok: true, confirmed: true }` marks the checkout confirmed and goes to /order/<n>;
// `{ ok: true, confirmed: false }` goes there as pending; `{ ok: false, error }` stays with the error shown and Place
// Order enabled. The drivers: one registered as a project's client bootstrap would (no template change), the built-in
// test-mode and stripe (a fake window.Stripe, no network), a null client and an unknown driver (error shown, Place
// Order disabled). Kills: a form that still branches on the vendor or its env vars, a driver that is not called, a
// redirect before or after a failed confirmation, and an SDK state that claims a payment the API does not have.

const API = 'http://api.test'
const ORDER_NUMBER = 'NYM-1042'
const CLIENT_SECRET = 'pi_p2_05_next_secret_7f3a'
const DECLINE = 'Your card was declined (p2-05 next).'

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

vi.mock('next/navigation', () => ({
  useRouter: () => navigation.router,
  usePathname: () => '/checkout',
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/lib/format', () => ({
  formatPrice: (minor: number, currency: string) => `${currency} ${(minor / 100).toFixed(2)}`,
}))

vi.mock('@/styles/pages/checkout.module.css', () => ({ default: {} }))

type Confirmation = Awaited<ReturnType<PaymentDriver['confirm']>>
type PaymentClient = { driver: string; options: Record<string, string> } | null
type PaymentOutcome = { status: 'succeeded' | 'requires_action' | 'failed'; reason?: string }

function reportWith(client: PaymentClient) {
  return {
    payments: { capabilities: ['intent', 'capture', 'refund'], client },
    search: { capabilities: ['index', 'search', 'facet'] },
    catalog: {
      sortKeys: ['newest', 'price-asc', 'price-desc', 'name-asc', 'name-desc'],
      defaultSort: 'newest',
    },
  }
}

/** The API as the SDK sees it; records every request so a test can tell when the submit was answered. */
function fakeApi(payment: PaymentOutcome, client: PaymentClient) {
  const requests: Array<{ method: string; path: string }> = []
  const orderStatus =
    payment.status === 'succeeded'
      ? 'confirmed'
      : payment.status === 'failed'
        ? 'cancelled'
        : 'pending'
  const cart = {
    token: 'cart-p2-05-next',
    items: [
      {
        variantId: 'var-1',
        productId: 'prod-1',
        productName: 'Driver Widget',
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
    orderId: 'ord-p2-05-next',
    orderNumber: ORDER_NUMBER,
    paymentIntent: {
      id: 'pi_p2_05_next',
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
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-p2-05' } })
    if (url.pathname === '/api/cart') return json(200, { data: cart })
    if (url.pathname === '/api/capabilities') return json(200, { data: reportWith(client) })
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

interface Watch {
  claimedPaid(): boolean
}

/** The form takes the report as `capabilities`, the prop app/checkout/page.tsx passes from its server-side read. */
const CheckoutForm = CheckoutFormComponent as unknown as ComponentType<{
  capabilities: ReturnType<typeof reportWith>
}>

const clients: NymbalClient[] = []

/** Renders the checkout page's client half with the report its server component read. */
function renderCheckout(client: PaymentClient): Watch {
  const sdk = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
  clients.push(sdk)
  registerClient(sdk)
  const statuses: string[] = []
  sdk.checkout.subscribe(() => statuses.push(sdk.checkout.getState().paymentStatus))
  render(
    <NymbalProvider client={sdk}>
      <CheckoutForm capabilities={reportWith(client)} />
    </NymbalProvider>,
  )
  return { claimedPaid: () => statuses.includes('succeeded') }
}

function fill(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

async function fillToPayment(): Promise<HTMLButtonElement> {
  fill('contact-email', 'ada@p2-05.test')
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
  return (await screen.findByTestId('place-order')) as HTMLButtonElement
}

/** Contact, shipping, then Place Order once the form lets the shopper press it. */
async function placeOrder() {
  const button = await fillToPayment()
  await vi.waitFor(() => expect(button.disabled).toBe(false))
  fireEvent.click(button)
}

function paymentElement(): HTMLElement & { confirm?: (secret: string) => Promise<Confirmation> } {
  const el = document.querySelector('nymbal-payment-element')
  if (el === null) throw new Error('the checkout form rendered no <nymbal-payment-element>')
  return el as HTMLElement
}

const errorText = () =>
  screen
    .queryAllByRole('alert')
    .map((el) => el.textContent ?? '')
    .join(' ')

const toOrderPage = () => navigation.calls.filter((href) => href.includes(`/order/${ORDER_NUMBER}`))

let stripe: FakeStripe | null = null
let seq = 0

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
  // The project's client bootstrap (lib/client.ts) registers it before any checkout renders.
  registerPaymentDriver(name, driver)
  return { client: { driver: name, options: {} }, answer, confirms }
}

beforeAll(() => {
  registerComponents()
})

beforeEach(() => {
  navigation.calls.length = 0
})

afterEach(() => {
  cleanup()
  stripe?.uninstall()
  stripe = null
  for (const client of clients.splice(0)) client.destroy()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('AC-2: the Next checkout confirms through the payment element', () => {
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
      const watch = renderCheckout(own.client)

      await placeOrder()
      await vi.waitFor(() => expect(own.confirms.length).toBeGreaterThan(0))
      expect(paymentElement().querySelector('[data-p2-05-own-driver]')).not.toBeNull()
      own.answer.resolve(answer)
      await vi.waitFor(() =>
        expect(toOrderPage().length + (errorText().includes(DECLINE) ? 1 : 0)).toBeGreaterThan(0),
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
    renderCheckout(own.client)

    await placeOrder()
    await vi.waitFor(() => expect(own.confirms.length).toBeGreaterThan(0))
    own.answer.resolve({ ok: false, error: DECLINE })
    await vi.waitFor(() => expect(errorText()).toContain(DECLINE))

    const button = screen.getByTestId('place-order') as HTMLButtonElement
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    expect(toOrderPage()).toEqual([])
  })

  it('AC-2: test-mode on requires_action (a +stub-pending order) shows "Test mode — payment skipped", goes to /order/<n> as pending, and never marks the checkout confirmed', async () => {
    const client = { driver: 'test-mode', options: {} }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = renderCheckout(client)

    const button = await fillToPayment()
    await vi.waitFor(() =>
      expect(paymentElement().textContent).toContain('Test mode — payment skipped'),
    )
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(watch.claimedPaid()).toBe(false)
    expect(api.checkoutPosts()).toBe(1)
  })

  it('AC-2: a null client renders no payment UI; requires_action goes to /order/<n> as pending and never marks the checkout confirmed', async () => {
    const api = fakeApi({ status: 'requires_action' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = renderCheckout(null)

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(watch.claimedPaid()).toBe(false)
    const element = paymentElement()
    expect(element.textContent?.trim()).toBe('')
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
    const client = { driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_next_ok' } }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = renderCheckout(client)

    const button = await fillToPayment()
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await vi.waitFor(() => expect(stripe!.confirmCalls.length).toBeGreaterThan(0))
    confirmation.resolve({ paymentIntent: { status: 'succeeded' } })
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(stripe.confirmCalls.map((c) => c.clientSecret)).toEqual([CLIENT_SECRET])
    expect(navigationsAtConfirm).toEqual([0])
    expect(stripe.keys).toContain('pk_test_p2_05_next_ok')
    expect(paymentElement().contains(stripe.cards[0]!.mountedOn)).toBe(true)
    expect(watch.claimedPaid()).toBe(true)
  })

  it('AC-2: stripe on requires_action sends the contact email and the billing address (same as shipping) to confirmCardPayment as billing_details', async () => {
    stripe = installFakeStripe()
    const client = { driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_next_bill' } }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    renderCheckout(client)

    const button = await fillToPayment()
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(stripe.confirmCalls.map((c) => c.data)).toEqual([
      {
        payment_method: {
          card: stripe.cards.at(-1)!.handle,
          billing_details: {
            email: 'ada@p2-05.test',
            name: 'Ada Buyer',
            address: {
              line1: '1 Main St',
              city: 'London',
              state: 'England',
              postal_code: 'E1 6AN',
              country: 'GB',
            },
          },
        },
      },
    ])
  })

  it('AC-2: stripe answering with a Stripe error stays on checkout with its message, Place Order enabled, no navigation and no confirmed claim', async () => {
    stripe = installFakeStripe()
    stripe.answer = async () => ({ error: { message: 'Your card was declined (stripe next).' } })
    const client = { driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_next_err' } }
    const api = fakeApi({ status: 'requires_action' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const watch = renderCheckout(client)

    const button = await fillToPayment()
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))
    await vi.waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    await vi.waitFor(() => expect(errorText()).toContain('Your card was declined (stripe next).'))

    await vi.waitFor(() =>
      expect((screen.getByTestId('place-order') as HTMLButtonElement).disabled).toBe(false),
    )
    expect(toOrderPage()).toEqual([])
    expect(watch.claimedPaid()).toBe(false)
  })

  it('AC-2: an unknown driver shows payment-element-error and keeps Place Order disabled: pressing it places no order', async () => {
    const client = { driver: 'p2-05-unregistered', options: {} }
    const api = fakeApi({ status: 'succeeded' }, client)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    renderCheckout(client)

    const button = await fillToPayment()
    await vi.waitFor(() =>
      expect(
        paymentElement().querySelector('[data-testid="payment-element-error"]'),
      ).not.toBeNull(),
    )
    await vi.waitFor(() => expect(button.disabled).toBe(true))
    fireEvent.click(button)

    expect(api.checkoutPosts()).toBe(0)
    expect(toOrderPage()).toEqual([])
  })

  it('AC-2: succeeded at the server goes to /order/<n> without asking the driver to confirm', async () => {
    const api = fakeApi({ status: 'succeeded' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const own = ownDriver()
    renderCheckout(own.client)

    await placeOrder()
    await vi.waitFor(() => expect(toOrderPage().length).toBeGreaterThan(0))

    expect(own.confirms).toEqual([])
    expect(api.checkoutPosts()).toBe(1)
  })

  it('AC-2: failed at the server stays on checkout with an error and no navigation, and the driver is never asked', async () => {
    const api = fakeApi({ status: 'failed', reason: 'stub_declined' }, null)
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const own = ownDriver()
    renderCheckout(own.client)

    await placeOrder()
    await vi.waitFor(() => expect(errorText().trim().length).toBeGreaterThan(0))

    expect(toOrderPage()).toEqual([])
    expect(own.confirms).toEqual([])
  })
})
