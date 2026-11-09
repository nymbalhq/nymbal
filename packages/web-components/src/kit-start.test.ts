import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { startKit, type KitResult } from './kit-start.js'
import { getClient } from './registry.js'

// A theme page's start-up: the kit reads two metas, probes the API twice, then defines its elements and wires the
// page, against a real client whose only fake is `fetch`.
//
// tests/setup.ts defines every element in this document, so `customElements` is a registry of the test's own: what the
// kit defined is what the test reads back, per run, while the elements in the page (real, from the setup) still render.
// The kit's listeners on `document` outlive a run, so each run removes the ones the last left.

const API = 'https://shop.example.test'
const STORE = 'https://store.example.test'
const API_META = 'nymbal:api-url'
const STORE_META = 'nymbal:store-url'
const CSRF = '/api/csrf'
const CART = '/api/cart'
const CART_ITEMS = '/api/cart/items'
const CAPABILITIES = '/api/capabilities'
const FAILED_MESSAGE = 'We could not update your cart. Please try again.'
const NOTIFY_ME = 'nymbal-notify-me'
const FIVE = [
  'nymbal-add-to-cart',
  'nymbal-cart-drawer',
  'nymbal-mini-cart',
  'nymbal-quantity-selector',
  'nymbal-toast',
]

interface Sent {
  method: string
  path: string
  credentials: RequestCredentials | undefined
  body?: unknown
}

type Answer = () => Response | Promise<Response>

interface Plan {
  /** The answers to `GET /api/csrf`, in order; once they run out, the token `SAME`. */
  csrf?: Answer[]
  cart?: Answer
  /** The answers to `POST /api/cart/items`, in order; once they run out, an empty cart. */
  addItem?: Answer[]
  capabilities?: Answer
}

const SAME = 'same-token'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const token =
  (value: string): Answer =>
  () =>
    json({ data: { token: value } })
const cartAnswer: Answer = () => json({ data: { items: [], subtotalMinor: 0, currency: 'GBP' } })
const failing: Answer = () => json({ error: { code: 'internal', message: 'boom' } }, 500)

interface Run {
  /** The tags the kit defined, in the registry of this run. */
  tags: Map<string, CustomElementConstructor>
  sent: Sent[]
  paths: () => string[]
  errors: () => string[]
}

let errorSpy: MockInstance<typeof console.error>
const documentListeners: Array<
  [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]
> = []

function forgetDocumentListeners(): void {
  for (const [type, listener, options] of documentListeners.splice(0)) {
    document.removeEventListener(type, listener, options)
  }
}

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const add = document.addEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      documentListeners.push([type, listener, options])
      add(type, listener, options)
    },
  )
})

afterEach(() => {
  forgetDocumentListeners()
  document.head.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function meta(name: string, content: string): void {
  const el = document.createElement('meta')
  el.setAttribute('name', name)
  el.setAttribute('content', content)
  document.head.appendChild(el)
}

/** A fresh page with the metas given (`null` leaves one out), its own registry and a fake API. */
function openPage(options: { api?: string | null; store?: string | null; plan?: Plan } = {}): Run {
  const { api = API, store = STORE, plan = {} } = options
  forgetDocumentListeners()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  errorSpy.mockClear()
  if (api !== null) meta(API_META, api)
  if (store !== null) meta(STORE_META, store)

  const tags = new Map<string, CustomElementConstructor>()
  vi.stubGlobal('customElements', {
    get: (tag: string) => tags.get(tag),
    define: (tag: string, element: CustomElementConstructor) => {
      tags.set(tag, element)
    },
    whenDefined: () => Promise.resolve(),
    upgrade: () => undefined,
  })

  const csrf = [...(plan.csrf ?? [])]
  const addItem = [...(plan.addItem ?? [])]
  const sent: Sent[] = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const { pathname } = new URL(href)
    const method = (init.method ?? 'GET').toUpperCase()
    sent.push({
      method,
      path: pathname,
      credentials: init.credentials,
      ...(typeof init.body === 'string' && { body: JSON.parse(init.body) as unknown }),
    })
    if (pathname === CSRF) return (csrf.shift() ?? token(SAME))()
    if (pathname === CART && method === 'GET') return (plan.cart ?? cartAnswer)()
    if (pathname === CART_ITEMS && method === 'POST') return (addItem.shift() ?? cartAnswer)()
    if (pathname === CAPABILITIES) {
      return (plan.capabilities ?? (() => json({ data: { email: { delivers: true } } })))()
    }
    return json({ error: { code: 'not_found', message: pathname } }, 404)
  })

  return {
    tags,
    sent,
    paths: () => sent.map((s) => s.path),
    errors: () => errorSpy.mock.calls.map((args) => args.map(String).join(' ')),
  }
}

/** Lets every pending microtask and timer-0 turn run, so anything the kit would do early has done it. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

type Rendering = HTMLElement & { updateComplete: Promise<unknown> }

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

function element(tag: string, parent: Element = document.body): Rendering {
  const el = document.createElement(tag) as Rendering
  parent.appendChild(el)
  return el
}

/** The toasts on screen: what each says and its type. */
async function shownToasts(): Promise<Array<{ message: string; type: string | null }>> {
  const toast = document.querySelector<Rendering>('nymbal-toast')
  if (toast === null) throw new Error('no nymbal-toast on the page')
  await toast.updateComplete
  return [...shadow(toast).querySelectorAll('[part~="item"]')].map((item) => ({
    message: item.querySelector('[part~="message"]')?.textContent?.trim() ?? '',
    type: item.getAttribute('data-type'),
  }))
}

/** Clicks a real quantity selector's increase button `times` times, as the shopper does. */
async function stepUp(selector: Rendering, times: number): Promise<void> {
  await selector.updateComplete
  const increase = shadow(selector).querySelector<HTMLButtonElement>('[part~="increment"]')
  if (increase === null) throw new Error('the selector rendered no increment button')
  for (let i = 0; i < times; i += 1) {
    increase.click()
    await selector.updateComplete
  }
}

describe('a page whose metas cannot work', () => {
  it('AC-1: with either meta absent, startKit answers misconfigured, logs one console.error naming that meta, sends no request and defines no element', async () => {
    const cases = [
      { absent: API_META, other: STORE_META, page: { api: null } },
      { absent: STORE_META, other: API_META, page: { store: null } },
    ]
    for (const { absent, other, page } of cases) {
      const run = openPage(page)
      await expect(startKit(), absent).resolves.toBe('misconfigured' satisfies KitResult)
      expect(run.errors(), absent).toHaveLength(1)
      expect(run.errors()[0], absent).toContain(absent)
      expect(run.errors()[0], absent).not.toContain(other)
      expect(run.sent, absent).toEqual([])
      expect([...run.tags.keys()], absent).toEqual([])
    }
  })

  it('AC-1: property: either meta not an absolute http(s) URL answers misconfigured with the meta named, no request and no element', async () => {
    const NOT_HTTP = [
      '',
      '   ',
      'shop.example.test',
      '/api',
      '//shop.example.test',
      'ftp://shop.example.test',
      'javascript:alert(1)',
      'mailto:a@b.test',
      'localhost:3000',
      'http://',
      'https://',
    ]
    const bad = fc.oneof(
      fc.constantFrom(...NOT_HTTP),
      fc.string({ maxLength: 40 }).filter((s) => !/^\s*https?:/i.test(s)),
    )
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('api', 'store'), bad, async (which, value) => {
        const named = which === 'api' ? API_META : STORE_META
        const run = openPage(which === 'api' ? { api: value } : { store: value })

        await expect(startKit()).resolves.toBe('misconfigured')

        expect(run.errors()).toHaveLength(1)
        expect(run.errors()[0]).toContain(named)
        expect(run.sent).toEqual([])
        expect(run.tags.size).toBe(0)
      }),
      { numRuns: 60 },
    )
  })
})

describe('the probe', () => {
  it('AC-2: two GET /api/csrf answering the same token: started, and the elements are defined and the cart read only after the second answer; each probe sends credentials and no request names a refresh or auth path', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const run = openPage({ plan: { csrf: [() => first.promise, () => second.promise] } })

    const result = startKit()
    await settle()
    expect(run.paths(), 'the second probe waits for the first answer').toEqual([CSRF])
    expect(run.tags.size).toBe(0)

    first.resolve(json({ data: { token: 'one-token' } }))
    await settle()
    expect(run.paths(), 'no cart read before the second answer').toEqual([CSRF, CSRF])
    expect(run.tags.size, 'no element before the second answer').toBe(0)

    second.resolve(json({ data: { token: 'one-token' } }))
    await expect(result).resolves.toBe('started')

    expect(FIVE.filter((tag) => !run.tags.has(tag))).toEqual([])
    expect(run.sent.filter((s) => s.path === CART && s.method === 'GET')).toHaveLength(1)
    expect(run.sent.filter((s) => s.path === CSRF).map((s) => s.credentials)).toEqual([
      'include',
      'include',
    ])
    expect(run.paths().filter((path) => /auth|refresh/.test(path))).toEqual([])
  })

  it('AC-3: property: two different tokens answer cross-site with one console.error holding the page origin, the API origin and one registrable domain, whatever the two hosts are; equal tokens start', async () => {
    const hosts = fc.constantFrom(
      'https://shop.example.test',
      'https://shop.example.test:8443',
      'http://localhost:3999',
      'https://other-site.example',
    )
    const twoTokens = fc.tuple(fc.uuid(), fc.uuid()).filter(([a, b]) => a !== b)
    await fc.assert(
      fc.asyncProperty(hosts, twoTokens, async (api, [a, b]) => {
        const run = openPage({ api, plan: { csrf: [token(a), token(b)] } })

        await expect(startKit()).resolves.toBe('cross-site')

        expect(run.errors()).toHaveLength(1)
        const message = run.errors()[0]
        expect(message).toContain(location.origin)
        expect(message).toContain(new URL(api).origin)
        expect(message).toContain('one registrable domain')
        expect(run.tags.size).toBe(0)
        expect(run.paths()).not.toContain(CART)

        const same = openPage({ api, plan: { csrf: [token(a), token(a)] } })
        await expect(startKit()).resolves.toBe('started')
        expect(same.errors()).toEqual([])
      }),
      { numRuns: 25 },
    )
  })

  it('AC-4: a probe fetch that rejects, answers non-2xx or has no token, on either probe: unreachable, one console.error holding the page origin, the API URL and http.cors.allowedOrigins; no element defined and no cart read', async () => {
    const BROKEN: Array<[string, Answer]> = [
      ['rejects', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['answers 500', () => json({ error: { code: 'internal' } }, 500)],
      ['answers 403', () => json({}, 403)],
      ['answers no token', () => json({ data: {} })],
      ['answers no data', () => json({})],
      ['answers not JSON', () => new Response('<html>nope</html>', { status: 200 })],
    ]
    for (const [name, broken] of BROKEN) {
      for (const position of [0, 1] as const) {
        const csrf = position === 0 ? [broken] : [token('t'), broken]
        const run = openPage({ plan: { csrf } })
        const label = `${name} on probe ${position + 1}`

        await expect(startKit(), label).resolves.toBe('unreachable')

        expect(run.errors(), label).toHaveLength(1)
        const message = run.errors()[0]
        expect(message, label).toContain(location.origin)
        expect(message, label).toContain(API)
        expect(message, label).toContain('http.cors.allowedOrigins')
        expect(run.tags.size, label).toBe(0)
        expect(
          run.paths().filter((path) => path !== CSRF),
          label,
        ).toEqual([])
      }
    }
  })
})

describe('what the kit defines', () => {
  it('AC-5: property: after started the five tags are defined and nothing else, so no product-card, checkout or site-header; a tag the page defined first stays the page’s', async () => {
    class ThemeElement extends HTMLElement {}
    await fc.assert(
      fc.asyncProperty(fc.subarray(FIVE), async (ownTags) => {
        const run = openPage()
        for (const tag of ownTags) run.tags.set(tag, ThemeElement)

        await expect(startKit()).resolves.toBe('started')

        expect([...run.tags.keys()].sort()).toEqual(FIVE)
        for (const tag of ['nymbal-product-card', 'nymbal-checkout', 'nymbal-site-header']) {
          expect(run.tags.has(tag), tag).toBe(false)
        }
        for (const tag of ownTags) expect(run.tags.get(tag), tag).toBe(ThemeElement)
        for (const tag of FIVE.filter((t) => !ownTags.includes(t))) {
          expect(run.tags.get(tag), tag).not.toBe(ThemeElement)
        }
      }),
      { numRuns: 16 },
    )
  })

  it('AC-6: with a notify-me on the page it is defined exactly when the store delivers email, one capabilities read either way; a page without one sends no capabilities request', async () => {
    const cases: Array<[string, Answer, boolean]> = [
      ['delivers', () => json({ data: { email: { delivers: true } } }), true],
      ['does not deliver', () => json({ data: { email: { delivers: false } } }), false],
      ['the read answers 500', () => json({ error: { code: 'internal' } }, 500), false],
      ['the read rejects', () => Promise.reject(new TypeError('Failed to fetch')), false],
    ]
    for (const [name, capabilities, defined] of cases) {
      const run = openPage({ plan: { capabilities } })
      element(NOTIFY_ME)

      await expect(startKit(), name).resolves.toBe('started')

      expect(run.tags.has(NOTIFY_ME), name).toBe(defined)
      expect(
        run.paths().filter((path) => path === CAPABILITIES),
        name,
      ).toHaveLength(1)
    }

    const plain = openPage()
    await expect(startKit()).resolves.toBe('started')
    expect(plain.tags.has(NOTIFY_ME)).toBe(false)
    expect(plain.paths().filter((path) => path === CAPABILITIES)).toEqual([])
  })
})

describe('the page wiring', () => {
  it('AC-7: a page with no drawer or toast has exactly one of each after started; one that prints them, or either, still has exactly one, and the printed one is the one kept', async () => {
    const cases = [
      { drawer: false, toast: false },
      { drawer: true, toast: false },
      { drawer: false, toast: true },
      { drawer: true, toast: true },
    ]
    for (const printed of cases) {
      openPage()
      const drawer = printed.drawer ? element('nymbal-cart-drawer') : null
      const toast = printed.toast ? element('nymbal-toast') : null

      await expect(startKit()).resolves.toBe('started')

      const label = JSON.stringify(printed)
      expect(document.body.querySelectorAll('nymbal-cart-drawer').length, label).toBe(1)
      expect(document.body.querySelectorAll('nymbal-toast').length, label).toBe(1)
      const lost = [drawer, toast].filter((el) => el !== null && !document.body.contains(el))
      expect(lost, `${label}: the page's own element is still the one there`).toEqual([])
    }
  })

  it('AC-8: property: checkout-clicked goes to <store>/checkout, for a store URL with and without a trailing slash, not to the WordPress site', async () => {
    const stores = fc.constantFrom(
      'https://shop.example.test',
      'https://shop.example.test:8443',
      'http://localhost:4331',
    )
    await fc.assert(
      fc.asyncProperty(stores, fc.boolean(), async (store, slash) => {
        const pageOrigin = location.origin
        openPage({ store: slash ? `${store}/` : store })
        const visited: string[] = []
        const visit = (href: string | URL): void => {
          visited.push(String(href))
        }
        vi.stubGlobal('location', {
          origin: pageOrigin,
          get href(): string {
            return `${pageOrigin}/`
          },
          set href(value: string) {
            visit(value)
          },
          assign: visit,
          replace: visit,
        })

        await expect(startKit()).resolves.toBe('started')
        document.dispatchEvent(
          new CustomEvent('nymbal:cart:checkout-clicked', { bubbles: true, composed: true }),
        )

        expect(visited).toEqual([`${store}/checkout`])
        expect(visited[0]?.startsWith(pageOrigin)).toBe(pageOrigin === store)
        vi.stubGlobal('location', { origin: pageOrigin, href: `${pageOrigin}/` })
      }),
      { numRuns: 12 },
    )
  })

  it('AC-9: property: quantity changed sets qty on the add button in the selector’s nearest container, not on one in another container, and leaves one that only body holds', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (steps) => {
        openPage()
        const box = (parent: Element = document.body): HTMLElement => {
          const el = document.createElement('div')
          parent.appendChild(el)
          return el
        }

        const first = box()
        const firstSelector = element('nymbal-quantity-selector', first)
        const firstButton = element('nymbal-add-to-cart', first)
        const second = box()
        const secondSelector = element('nymbal-quantity-selector', second)
        const secondButton = element('nymbal-add-to-cart', second)

        const outer = box()
        const inner = box(outer)
        const nestedSelector = element('nymbal-quantity-selector', inner)
        const innerButton = element('nymbal-add-to-cart', inner)
        const outerButton = element('nymbal-add-to-cart', outer)

        const shared = box()
        const lifted = box(shared)
        const liftedSelector = element('nymbal-quantity-selector', lifted)
        const liftedButton = element('nymbal-add-to-cart', shared)

        const loneSelector = element('nymbal-quantity-selector')
        const loneButton = element('nymbal-add-to-cart')

        await expect(startKit()).resolves.toBe('started')

        await stepUp(firstSelector, steps)
        expect(firstButton.getAttribute('qty')).toBe(String(1 + steps))
        expect(secondButton.getAttribute('qty')).toBeNull()

        await stepUp(secondSelector, steps + 1)
        expect(secondButton.getAttribute('qty')).toBe(String(2 + steps))
        expect(firstButton.getAttribute('qty'), 'the other row kept its own').toBe(
          String(1 + steps),
        )

        await stepUp(nestedSelector, steps)
        expect(innerButton.getAttribute('qty')).toBe(String(1 + steps))
        expect(outerButton.getAttribute('qty'), 'only the nearest takes it').toBeNull()

        await stepUp(liftedSelector, steps)
        expect(liftedButton.getAttribute('qty'), 'the nearest ancestor holding one').toBe(
          String(1 + steps),
        )

        await stepUp(loneSelector, steps)
        expect(loneButton.getAttribute('qty'), 'body is no container').toBeNull()
      }),
      { numRuns: 8 },
    )
  })

  it('a slow capabilities read holds nothing back: the drawer and toast are on the page and a quantity change reaches the button before it answers, and the notify-me is defined after', async () => {
    const slow = deferred<Response>()
    const run = openPage({ plan: { capabilities: () => slow.promise } })
    element(NOTIFY_ME)
    const row = document.createElement('div')
    document.body.appendChild(row)
    const selector = element('nymbal-quantity-selector', row)
    const button = element('nymbal-add-to-cart', row)

    const started = startKit()
    await settle()

    expect(run.paths()).toContain(CAPABILITIES)
    expect(run.tags.has(NOTIFY_ME), 'the read has not answered').toBe(false)
    expect(document.body.querySelectorAll('nymbal-cart-drawer').length).toBe(1)
    expect(document.body.querySelectorAll('nymbal-toast').length).toBe(1)
    await stepUp(selector, 2)
    expect(button.getAttribute('qty')).toBe('3')

    slow.resolve(json({ data: { email: { delivers: true } } }))
    await expect(started).resolves.toBe('started')
    expect(run.tags.has(NOTIFY_ME)).toBe(true)
    expect(document.body.querySelectorAll('nymbal-cart-drawer').length).toBe(1)
  })

  it('AC-11: an alert subscribed through the kit carries the store as its link origin, added to the request as given', async () => {
    const run = openPage()
    await startKit()
    const request = {
      email: 'shopper@example.test',
      variantId: 'variant-1',
      kind: 'back_in_stock' as const,
    }

    await getClient()
      .adapter.alerts.subscribe(request)
      .catch(() => undefined)

    const posted = run.sent.filter((s) => s.method === 'POST' && s.path === '/api/alerts/subscribe')
    expect(posted.map((s) => s.body)).toEqual([{ ...request, linkOrigin: new URL(STORE).origin }])
  })

  it('AC-10: one failed addItem shows one error toast with the fixed text; a later success shows none; a later failure shows one more', async () => {
    openPage({ plan: { addItem: [failing, cartAnswer, failing] } })
    await expect(startKit()).resolves.toBe('started')
    const failedToast = { message: FAILED_MESSAGE, type: 'error' }

    await getClient().cart.addItem('variant-1', 1)
    await settle()
    expect(await shownToasts()).toEqual([failedToast])

    await getClient().cart.addItem('variant-1', 1)
    await settle()
    expect(await shownToasts(), 'a success adds none').toEqual([failedToast])

    await getClient().cart.addItem('variant-1', 1)
    await settle()
    expect(await shownToasts(), 'each failed change is its own toast').toEqual([
      failedToast,
      failedToast,
    ])
  })

  it('AC-10: a failed first cart load on a plain page shows no toast, and the kit still starts', async () => {
    const run = openPage({ plan: { cart: failing } })

    await expect(startKit()).resolves.toBe('started')
    await settle()

    expect(await shownToasts()).toEqual([])
    expect(run.paths()).toContain(CART)
  })
})
