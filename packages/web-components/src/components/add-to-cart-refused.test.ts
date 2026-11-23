import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient, type NymbalClient } from '@nymbalhq/sdk'
import { registerClient } from '../registry.js'

// An add to cart the store refuses says why, under the button that made it, and is not reported as an add. The real
// SDK client over a fake `fetch`, so a refusal reaches the element as the API sends it: an error envelope with a code,
// or a request that never gets an answer.

const API = 'http://api.test'
const VARIANT = 'var-refused'
const OTHER_VARIANT = 'var-other'
const POLL = { interval: 1, timeout: 1000 }

const LIMIT_SENTENCE = 'You can have at most 99 of this item in your cart.'
const GENERAL_SENTENCE = 'This item could not be added. Please try again.'

/** How the API answers one add: accepted, refused with a code and status, or not answered at all. */
type Answer =
  | { kind: 'accept' }
  | { kind: 'refuse'; code: string; status: number }
  | { kind: 'network' }

const LIMIT: Answer = { kind: 'refuse', code: 'cart.qty_limit', status: 422 }

function fakeApi() {
  let posts = 0
  let next: Answer = { kind: 'accept' }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const cart = (qty: number) => ({
    data: {
      token: 'cart-refused',
      items:
        qty === 0
          ? []
          : [
              {
                variantId: VARIANT,
                productId: 'prod-refused',
                productName: 'Limited Mug',
                variantName: 'Default',
                priceMinor: 1000,
                imageUrl: '',
                qty,
              },
            ],
      subtotalMinor: qty * 1000,
      currency: 'GBP',
    },
  })
  let held = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-refused' } })
    if (url.pathname === '/api/cart/items' && method === 'POST') {
      posts += 1
      const answer = next
      if (answer.kind === 'network') throw new TypeError('fetch failed')
      if (answer.kind === 'refuse') {
        return json(answer.status, { error: { code: answer.code, message: 'refused by the API' } })
      }
      const body = JSON.parse(String(init?.body)) as { qty: number }
      held += body.qty
      return json(200, cart(held))
    }
    if (url.pathname === '/api/cart') return json(200, cart(held))
    return json(404, { error: { code: 'not_found', message: url.pathname } })
  }
  return {
    fetchImpl,
    posts: () => posts,
    answerNext: (answer: Answer) => {
      next = answer
    },
  }
}

/**
 * Every refusal of an add: the 99-per-line limit, any other API code (none the SDK answers by retrying or refreshing:
 * a 401 refreshes the session, a 403 `csrf.invalid` refetches the token), or a failure that carries no code.
 */
const aRefusal: fc.Arbitrary<Answer> = fc.oneof(
  fc.constant(LIMIT),
  fc.record({
    kind: fc.constant('refuse' as const),
    code: fc
      .tuple(fc.stringMatching(/^[a-z]{1,10}$/), fc.stringMatching(/^[a-z_]{1,14}$/))
      .map(([area, name]) => `${area}.${name}`)
      .filter((code) => code !== 'cart.qty_limit' && code !== 'csrf.invalid'),
    status: fc.integer({ min: 400, max: 599 }).filter((s) => s !== 401),
  }),
  fc.constant<Answer>({ kind: 'network' }),
)

function sentenceFor(answer: Answer): string {
  return answer.kind === 'refuse' && answer.code === 'cart.qty_limit'
    ? LIMIT_SENTENCE
    : GENERAL_SENTENCE
}

// The element is a Lit element in an open shadow root, read through `shadowRoot` once its render has settled.
function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

let api: ReturnType<typeof fakeApi>
let client: NymbalClient

beforeEach(() => {
  api = fakeApi()
  vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
  client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })
  registerClient(client)
})

afterEach(() => {
  document.body.innerHTML = ''
  client.destroy()
  vi.unstubAllGlobals()
})

interface Mounted {
  el: HTMLElement
  added: unknown[]
  button: () => HTMLButtonElement
  alerts: () => Element[]
}

async function mount(variantId = VARIANT): Promise<Mounted> {
  const el = document.createElement('nymbal-add-to-cart')
  el.setAttribute('variant-id', variantId)
  const added: unknown[] = []
  el.addEventListener('nymbal:cart:item-added', (e) => added.push((e as CustomEvent).detail))
  document.body.appendChild(el)
  await settled(el)
  const root = shadow(el)
  return {
    el,
    added,
    button: () => root.querySelector('button')!,
    alerts: () => [...root.querySelectorAll('[part~="error"]')],
  }
}

/** Clicks once with the API answering `answer`, and waits until that add has been answered and rendered. */
async function clickAnswered(m: Mounted, answer: Answer): Promise<void> {
  api.answerNext(answer)
  await vi.waitFor(() => expect(m.button().disabled).toBe(false), POLL)
  const sent = api.posts()
  m.button().click()
  await vi.waitFor(() => {
    expect(api.posts()).toBe(sent + 1)
    expect(client.cart.getState().loading).toBe(false)
  }, POLL)
  // The element reads the store's answer after the add resolves: one more turn, then its render.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await settled(m.el)
}

describe('a refused add to cart says why and is not reported as an add', () => {
  it('AC-1: property: for any refusal (cart.qty_limit, any other code, or no code), one click dispatches no item-added and leaves one role="alert" error part with the sentence for its code, and the button is enabled again', async () => {
    await fc.assert(
      fc.asyncProperty(aRefusal, async (refusal) => {
        const m = await mount()
        await clickAnswered(m, refusal)

        const alerts = m.alerts()
        expect(m.added, 'item-added events after a refused add').toEqual([])
        expect(
          alerts.map((a) => ({
            role: a.getAttribute('role'),
            testid: a.getAttribute('data-testid'),
            text: a.textContent?.trim(),
          })),
          'the error parts after a refused add',
        ).toEqual([{ role: 'alert', testid: 'add-to-cart-error', text: sentenceFor(refusal) }])
        expect(m.button().disabled, 'the button after a refused add').toBe(false)
        m.el.remove()
      }),
      { numRuns: 40 },
    )
  })

  it('AC-2: property: over any run of accepted and refused clicks, an alert stands after a click exactly when that click was refused, and item-added fires once per accepted click', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.oneof(fc.constant<Answer>({ kind: 'accept' }), aRefusal), {
          minLength: 2,
          maxLength: 6,
        }),
        async (answers) => {
          const m = await mount()
          const shown: number[] = []
          for (const answer of answers) {
            await clickAnswered(m, answer)
            shown.push(m.alerts().length)
          }
          const accepted = answers.filter((a) => a.kind === 'accept').length
          expect(shown, 'alerts standing after each click').toEqual(
            answers.map((a) => (a.kind === 'accept' ? 0 : 1)),
          )
          expect(m.added.length, 'item-added events').toBe(accepted)
          m.el.remove()
        },
      ),
      { numRuns: 25 },
    )
  })

  it('AC-2: after a refusal, a click whose add succeeds removes the alert and dispatches one item-added', async () => {
    const m = await mount()
    await clickAnswered(m, LIMIT)
    const before = { alerts: m.alerts().length, added: m.added.length }

    await clickAnswered(m, { kind: 'accept' })

    expect(before, 'after the refused click').toEqual({ alerts: 1, added: 0 })
    expect(
      { alerts: m.alerts().length, added: m.added.length },
      'after the accepted click',
    ).toEqual({ alerts: before.alerts - 1, added: before.added + 1 })
  })

  it('AC-2: setting variant-id to the value it holds keeps the alert; changing it to another variant removes it with no click', async () => {
    const m = await mount()
    await clickAnswered(m, LIMIT)
    const afterRefusal = m.alerts().length
    const posts = api.posts()

    // The product page sets the same id again on every product-store change.
    m.el.setAttribute('variant-id', VARIANT)
    await settled(m.el)
    const afterSameId = m.alerts().length

    m.el.setAttribute('variant-id', OTHER_VARIANT)
    await settled(m.el)
    const afterOtherId = m.alerts().length

    expect([afterRefusal, afterSameId, afterOtherId], 'alerts: refused, same id, other id').toEqual(
      [1, 1, 0],
    )
    expect(api.posts(), 'no add is sent by a variant change').toBe(posts)
  })

  it('AC-2: a second add-to-cart on the page shows no alert when the first one is refused', async () => {
    const first = await mount()
    const second = await mount(OTHER_VARIANT)

    await clickAnswered(first, LIMIT)
    await settled(second.el)

    expect(
      { first: first.alerts().length, second: second.alerts().length },
      'alerts on each add-to-cart after the first one is refused',
    ).toEqual({ first: 1, second: 0 })
    expect([first.added.length, second.added.length]).toEqual([0, 0])
  })
})
