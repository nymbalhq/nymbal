// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// P1-15 AC-3: the real Astro form scripts over their page markup, with the real SDK client over a fake `fetch` that
// holds each form's mutating response pending. Two `form.requestSubmit()` calls send exactly one request to that form's
// route: `requestSubmit()` fires `submit` even while the handler has disabled the button, so a handler with no
// in-flight flag of its own (today: every one of them) sends two. Once the held response is refused, the guard lets go:
// a third submit sends one more request, so a guard that locks the form for good does not pass. Pattern:
// `checkout-script.test.ts`.
//
// P2-15 moved login, register and profile into `nymbal-login-form`, `nymbal-register-form` and
// `nymbal-profile-form` (decision 7 deletes `auth-forms.ts` and `profile-form.ts`); their one-call-per-submission case
// is P2-15 AC-4 (`packages/web-components/src/components/account-forms.test.ts`). Checkout and review stay here.

const API = 'http://api.test'

// The storefront's custom elements are not under test; the SDK client the scripts drive is real.
vi.mock('@nymbalhq/web-components', () => ({
  registerClient: () => undefined,
  registerComponents: () => undefined,
}))

interface Route {
  method: string
  path: string
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const CUSTOMER = {
  id: 'cus-ac3',
  email: 'ada@ac3.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '',
}

const CART = {
  token: 'cart-ac3',
  items: [
    {
      variantId: 'var-1',
      productId: 'prod-1',
      productName: 'Guarded Widget',
      variantName: 'Default',
      priceMinor: 1200,
      imageUrl: '',
      qty: 1,
    },
  ],
  subtotalMinor: 1200,
  currency: 'GBP',
}

/**
 * Answers every read at once and holds the mutating route's responses until `refuseHeld()`, which answers each with a
 * 400 the handler shows as an error (a 401 would start the SDK's refresh).
 */
function fakeApi(mutating: Route) {
  const requests: Route[] = []
  const held: Array<(response: Response) => void> = []
  const isMutating = (r: Route) => r.method === mutating.method && r.path === mutating.path
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const route = { method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname }
    requests.push(route)
    if (isMutating(route)) return new Promise<Response>((resolve) => held.push(resolve))
    if (route.path === '/api/csrf')
      return Promise.resolve(json(200, { data: { token: 'csrf-ac3' } }))
    if (route.path === '/api/cart') return Promise.resolve(json(200, { data: CART }))
    if (route.path === '/api/customers/me' && route.method === 'GET') {
      return Promise.resolve(json(200, { data: CUSTOMER }))
    }
    if (route.path.endsWith('/reviews') && route.method === 'GET') {
      return Promise.resolve(json(200, { data: { reviews: [], averageRating: 0, count: 0 } }))
    }
    return Promise.resolve(json(404, { error: { code: 'not_found', message: route.path } }))
  }
  return {
    requests,
    fetchImpl,
    sent: () => requests.filter(isMutating).length,
    refuseHeld() {
      for (const resolve of held.splice(0)) {
        resolve(json(400, { error: { code: 'ac3.refused', message: 'Refused by the AC-3 fake.' } }))
      }
    },
  }
}

/** A location the scripts can read (`search`) and leave by (`href = …`) without jsdom navigating. */
function fakeLocation(start: string) {
  let href = start
  return {
    get href() {
      return href
    },
    set href(next: string) {
      href = new URL(next, href).toString()
    },
    assign() {},
    replace() {},
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
}

/**
 * Waits until the scripts stop fetching: every read is answered at once, so a handler that is going to send its request
 * has sent it once five macrotask turns pass with no new request.
 */
async function quiesce(api: ReturnType<typeof fakeApi>) {
  let last = api.requests.length
  let quietTurns = 0
  for (let turn = 0; turn < 200 && quietTurns < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    quietTurns = api.requests.length === last ? quietTurns + 1 : 0
    last = api.requests.length
  }
}

function byTestId<T extends HTMLElement>(id: string): T {
  const el = document.querySelector<T>(`[data-testid="${id}"]`)
  if (el === null) throw new Error(`no [data-testid="${id}"] in the markup`)
  return el
}

function setValue(id: string, value: string) {
  byTestId<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value = value
}

/** The ids, names and test ids of `src/components/ReviewForm.astro` for product `prod-1`. */
const REVIEW_MARKUP = `
  <form id="review-form" data-product-id="prod-1" data-testid="review-form">
    <select id="review-rating" name="rating" required data-testid="review-rating">
      <option value="">Select a rating</option>
      <option value="5">5 - Excellent</option>
      <option value="4">4 - Very Good</option>
      <option value="3">3 - Good</option>
      <option value="2">2 - Fair</option>
      <option value="1">1 - Poor</option>
    </select>
    <input type="text" id="review-title" name="title" required data-testid="review-title" />
    <textarea id="review-body" name="body" required data-testid="review-body"></textarea>
    <button type="submit" data-testid="review-submit">Submit Review</button>
    <p id="review-form-message" style="display:none;"></p>
  </form>
`

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

/** The ids and names `src/pages/checkout.astro` (and its AddressForm) give the checkout script. */
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
      <nymbal-payment-element data-testid="payment-element" client="null"></nymbal-payment-element>
      <button type="submit" data-testid="place-order">Place Order</button>
    </form>
  </section>
  <aside id="checkout-summary" data-testid="checkout-summary"></aside>
`

/**
 * The review script moved out of its inline `<script>` (P1-15 decision 3). Resolved when the test runs, not when the
 * file is transformed, so a missing one fails its own test and not the others.
 */
const importScript = (name: string): Promise<unknown> =>
  import(/* @vite-ignore */ `../src/scripts/${name}.ts`)

interface FormCase {
  name: string
  route: Route
  page: string
  markup: string
  formId: string
  submitTestId: string
  load: () => Promise<unknown>
  /** Fills the form (and walks any earlier steps) so that a submit reaches the mutating request. */
  fill: () => void
}

const cases: FormCase[] = [
  {
    name: 'place order',
    route: { method: 'POST', path: '/api/checkout' },
    page: 'http://shop.test/checkout',
    markup: CHECKOUT_MARKUP,
    formId: 'payment-form',
    submitTestId: 'place-order',
    load: () => import('../src/scripts/checkout'),
    fill: () => {
      setValue('contact-email', 'ada@ac3.test')
      byTestId('contact-continue').click()
      setValue('shipping-firstName', 'Ada')
      setValue('shipping-lastName', 'Lovelace')
      setValue('shipping-addressLine1', '1 Guard St')
      setValue('shipping-city', 'London')
      setValue('shipping-region', 'England')
      setValue('shipping-postalCode', 'E1 6AN')
      setValue('shipping-country', 'GB')
      byTestId('shipping-continue').click()
    },
  },
  {
    name: 'review',
    route: { method: 'POST', path: '/api/reviews' },
    page: 'http://shop.test/product/guarded-widget',
    markup: REVIEW_MARKUP,
    formId: 'review-form',
    submitTestId: 'review-submit',
    load: () => importScript('review-form'),
    fill: () => {
      setValue('review-rating', '5')
      setValue('review-title', 'Submitted once')
      setValue('review-body', 'A double submit makes one review.')
    },
  },
]

beforeEach(() => {
  localStorage.setItem('nymbal.auth.accessToken', 'token-ac3')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
  document.body.innerHTML = ''
})

describe('AC-3: every mutating Astro form sends one request for two submits', () => {
  for (const form of cases) {
    it(`AC-3: ${form.name}: two requestSubmit() calls send one ${form.route.method} ${form.route.path}; after it is refused, a third sends one more`, async () => {
      const api = fakeApi(form.route)
      vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
      vi.stubGlobal('location', fakeLocation(form.page))
      vi.stubEnv('PUBLIC_NYMBAL_API_URL', API)
      vi.resetModules()
      document.body.innerHTML = form.markup
      await form.load()
      await quiesce(api)
      form.fill()

      const el = document.getElementById(form.formId) as HTMLFormElement
      el.requestSubmit()
      el.requestSubmit()
      await vi.waitFor(() => expect(api.sent()).toBeGreaterThan(0))
      await quiesce(api)
      const whileHeld = api.sent()
      expect(whileHeld).toBe(1)

      api.refuseHeld()
      const button = byTestId<HTMLButtonElement>(form.submitTestId)
      await vi.waitFor(() => expect(button.disabled).toBe(false))
      el.requestSubmit()
      await vi.waitFor(() => expect(api.sent()).toBeGreaterThan(whileHeld))
      await quiesce(api)

      expect(api.sent()).toBe(whileHeld + 1)
    })
  }
})
