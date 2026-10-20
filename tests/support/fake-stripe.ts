// P2-05 AC-2 support: a stand-in for Stripe.js in jsdom, with no network. The `stripe` payment driver injects
// <script src="https://js.stripe.com/v3"> and uses `window.Stripe`; this watches the document for that script and,
// when one is added, plays the browser's part: `window.Stripe` appears and the script fires `load`. jsdom fetches no
// script itself (no `resources` option), so nothing leaves the process. Every call the driver makes is recorded.
// Once loaded, Stripe.js stays loaded for the window, as in a browser: `window.Stripe` outlives `uninstall()` and
// routes to whichever fake is installed, so a driver that loads the script once per page keeps working across tests.
// Use a publishable key of each test's own: a driver may keep one Stripe instance per key.

export const STRIPE_JS = 'https://js.stripe.com/v3'

export type StripeAnswer = { paymentIntent?: { status: string }; error?: { message: string } }

export interface FakeCard {
  type: string
  /** The element (or the element a selector names) the card was mounted on. */
  mountedOn: Element | null
  /** The object `elements().create()` returned: what a confirm must hand back as `payment_method.card`. */
  handle: object
}

export interface FakeStripe {
  /** The publishable key of every `window.Stripe(key)` call. */
  keys: string[]
  cards: FakeCard[]
  confirmCalls: Array<{ clientSecret: string; data: unknown }>
  /** What `confirmCardPayment` resolves; replace per test. */
  answer: (clientSecret: string) => Promise<StripeAnswer>
  /** The Stripe.js scripts in the document. */
  scripts(): HTMLScriptElement[]
  uninstall(): void
}

interface StripeWindow {
  Stripe?: (key: string) => unknown
}

let current: ((key: string) => unknown) | null = null

function trampoline(key: string): unknown {
  if (current === null) throw new Error('window.Stripe called with no fake Stripe installed')
  return current(key)
}

export function installFakeStripe(): FakeStripe {
  const fake: FakeStripe = {
    keys: [],
    cards: [],
    confirmCalls: [],
    answer: async () => ({ paymentIntent: { status: 'succeeded' } }),
    scripts: () =>
      [...document.querySelectorAll('script')].filter((s) =>
        (s.getAttribute('src') ?? '').startsWith(STRIPE_JS),
      ),
    uninstall: () => {
      observer.disconnect()
      if (current === stripeFactory) current = null
    },
  }

  const stripeFactory = (key: string) => {
    fake.keys.push(key)
    return {
      elements: () => ({
        create: (type: string) => {
          const handle = {
            mount: (target: Element | string) => {
              card.mountedOn = typeof target === 'string' ? document.querySelector(target) : target
            },
            on: () => undefined,
            destroy: () => undefined,
            unmount: () => undefined,
          }
          const card: FakeCard = { type, mountedOn: null, handle }
          fake.cards.push(card)
          return handle
        },
      }),
      confirmCardPayment: (clientSecret: string, data?: unknown) => {
        fake.confirmCalls.push({ clientSecret, data })
        return fake.answer(clientSecret)
      },
    }
  }

  current = stripeFactory
  const loaded = (script: HTMLScriptElement) => {
    ;(window as StripeWindow).Stripe = trampoline
    setTimeout(() => script.dispatchEvent(new Event('load')), 0)
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (
          node instanceof HTMLScriptElement &&
          (node.getAttribute('src') ?? '').startsWith(STRIPE_JS)
        ) {
          loaded(node)
        }
      }
    }
  })
  observer.observe(document, { childList: true, subtree: true })
  return fake
}

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
