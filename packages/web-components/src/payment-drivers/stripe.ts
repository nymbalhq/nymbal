import type { PaymentConfirmation, PaymentDriver } from '@nymbalhq/sdk'

// Stripe.js from Stripe's own host, as Stripe requires, so no project installs a Stripe package to take a card.
const STRIPE_JS = 'https://js.stripe.com/v3/'

interface StripeCard {
  mount(target: HTMLElement): void
}

interface StripeInstance {
  elements(): { create(type: 'card', options?: Record<string, unknown>): StripeCard }
  confirmCardPayment(
    clientSecret: string,
    data: { payment_method: { card: StripeCard } },
  ): Promise<{ paymentIntent?: { status: string }; error?: { message?: string } }>
}

type StripeFactory = (publishableKey: string) => StripeInstance

let loading: Promise<StripeFactory> | null = null

/** `window.Stripe`, injecting Stripe.js once per page when it is not there yet. */
function loadStripeJs(): Promise<StripeFactory> {
  const win = window as unknown as { Stripe?: StripeFactory }
  if (win.Stripe) return Promise.resolve(win.Stripe)
  loading ??= new Promise<StripeFactory>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = STRIPE_JS
    script.async = true
    script.addEventListener('load', () => {
      if (win.Stripe) resolve(win.Stripe)
      else reject(new Error('Stripe.js loaded but window.Stripe is missing.'))
    })
    script.addEventListener('error', () => {
      loading = null
      script.remove()
      reject(new Error('Stripe.js could not be loaded.'))
    })
    document.head.appendChild(script)
  })
  return loading
}

const instances = new Map<string, StripeInstance>()
let mounted: Array<{ host: HTMLElement; stripe: StripeInstance; card: StripeCard }> = []

/** A card form from Stripe.js; confirm pays the intent with the card the shopper typed into. */
export const stripeDriver: PaymentDriver = {
  async mount(el, options) {
    const key = options['publishableKey']
    if (!key)
      throw new Error('Card payments are not configured: the store has no Stripe publishable key.')
    const factory = await loadStripeJs()
    let stripe = instances.get(key)
    if (stripe === undefined) {
      stripe = factory(key)
      instances.set(key, stripe)
    }
    const target = document.createElement('div')
    target.className = 'nymbal-payment-card'
    el.replaceChildren(target)
    const card = stripe.elements().create('card', {
      style: {
        base: { fontSize: '16px', color: '#1a1a1a', '::placeholder': { color: '#9ca3af' } },
      },
    })
    card.mount(target)
    mounted = [
      ...mounted.filter((m) => m.host.isConnected && m.host !== el),
      { host: el, stripe, card },
    ]
  },

  async confirm(clientSecret): Promise<PaymentConfirmation> {
    const current = mounted.findLast((m) => m.host.isConnected) ?? mounted.at(-1)
    if (current === undefined) return { ok: false, error: 'The card form is not ready.' }
    const result = await current.stripe.confirmCardPayment(clientSecret, {
      payment_method: { card: current.card },
    })
    if (result.error) return { ok: false, error: result.error.message ?? 'Payment failed.' }
    // `processing` is accepted but not paid yet: the webhook confirms it.
    return { ok: true, confirmed: result.paymentIntent?.status === 'succeeded' }
  },
}
