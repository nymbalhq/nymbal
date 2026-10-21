// @vitest-environment jsdom
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPaymentDriver,
  registerPaymentDriver,
  type PaymentConfirmContext,
  type PaymentDriver,
} from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'
import {
  installFakeStripe,
  STRIPE_JS,
  type FakeStripe,
} from '../../../../tests/support/fake-stripe.js'

// P2-05 AC-2 (the element): <nymbal-payment-element client='<json>'> renders the payments adapter's client half
// through the SDK's driver registry, and its confirm(clientSecret) is the driver's. The built-in drivers come from
// registerComponents() (tests/setup.ts calls it): `test-mode` shows "Test mode — payment skipped" and confirms
// nothing; `stripe` loads Stripe.js once from js.stripe.com (a fake window.Stripe here, no network), mounts a card and
// confirms with confirmCardPayment. A null client renders nothing and confirms nothing; an unknown driver shows
// payment-element-error. Kills: a driver that is not called, an answer the element reshapes (a decline reported as
// paid), and a Stripe.js loaded once per element.

type Confirmation = Awaited<ReturnType<PaymentDriver['confirm']>>

let stripe: FakeStripe | null = null

beforeEach(() => {
  setupMockClient()
})

afterEach(() => {
  stripe?.uninstall()
  stripe = null
  vi.unstubAllGlobals()
})

interface PaymentElement extends HTMLElement {
  confirm(clientSecret: string, context?: PaymentConfirmContext): Promise<Confirmation>
}

/** What a checkout holds when it confirms: the shopper's email and the billing address it set. */
const CONTEXT: PaymentConfirmContext = {
  email: 'ada@p2-05.test',
  billing: {
    firstName: 'Ada',
    lastName: 'Buyer',
    addressLine1: '1 Main St',
    addressLine2: 'Flat 2',
    city: 'London',
    region: 'England',
    postalCode: 'E1 6AN',
    country: 'GB',
  },
}

/** The same context as Stripe's `billing_details`. */
const BILLING_DETAILS = {
  email: 'ada@p2-05.test',
  name: 'Ada Buyer',
  address: {
    line1: '1 Main St',
    line2: 'Flat 2',
    city: 'London',
    state: 'England',
    postal_code: 'E1 6AN',
    country: 'GB',
  },
}

/** The element as a page renders it: the client half as JSON in its `client` attribute. */
function mount(client: unknown): PaymentElement {
  const el = document.createElement('nymbal-payment-element') as PaymentElement
  el.setAttribute('client', JSON.stringify(client))
  document.body.appendChild(el)
  return el
}

/** A driver of the project's own, recording what the element hands it. */
function recordingDriver(answer: (secret: string) => Promise<Confirmation>) {
  const mounts: Array<{ el: HTMLElement; options: Record<string, string> }> = []
  const confirms: string[] = []
  const contexts: Array<PaymentConfirmContext | undefined> = []
  const driver: PaymentDriver = {
    mount(el: HTMLElement, options: Record<string, string>) {
      mounts.push({ el, options })
      el.insertAdjacentHTML('beforeend', '<p data-p2-05-driver>own driver</p>')
    },
    confirm(clientSecret: string, context?: PaymentConfirmContext) {
      confirms.push(clientSecret)
      contexts.push(context)
      return answer(clientSecret)
    },
  }
  return { driver, mounts, confirms, contexts }
}

/** Lets a render queued on a microtask or the next task run: absence can only be read once it has had its turn. */
async function settled(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const arbSecret = fc.stringMatching(/^pi_[A-Za-z0-9]{1,24}_secret_[A-Za-z0-9]{1,16}$/)

const arbConfirmation: fc.Arbitrary<Confirmation> = fc.oneof(
  fc.record({ ok: fc.constant(true as const), confirmed: fc.boolean() }),
  fc.record({ ok: fc.constant(false as const), error: fc.string({ minLength: 1, maxLength: 40 }) }),
)

describe('nymbal-payment-element', () => {
  it('AC-2: registerComponents registers the built-in test-mode and stripe drivers', () => {
    expect(typeof getPaymentDriver('test-mode')?.confirm).toBe('function')
    expect(typeof getPaymentDriver('stripe')?.confirm).toBe('function')
  })

  it('AC-2: test-mode renders "Test mode — payment skipped" and, for any client secret, confirm resolves ok and not confirmed', async () => {
    const el = mount({ driver: 'test-mode', options: {} })
    await vi.waitFor(() => expect(el.textContent).toContain('Test mode — payment skipped'))

    await fc.assert(
      fc.asyncProperty(arbSecret, async (secret) => {
        expect(await el.confirm(secret)).toEqual({ ok: true, confirmed: false })
      }),
      { numRuns: 25 },
    )
  })

  it('AC-2: a null client renders nothing, and confirm resolves ok and not confirmed', async () => {
    const el = mount(null)
    await settled()

    expect(el.textContent?.trim()).toBe('')
    expect(el.querySelector('[data-testid="payment-element-error"]')).toBeNull()
    expect(await el.confirm('pi_null_secret_1')).toEqual({ ok: true, confirmed: false })
  })

  it('AC-2: an unknown driver shows payment-element-error and mounts nothing', async () => {
    const el = mount({ driver: 'p2-05-no-such-driver', options: {} })

    await vi.waitFor(() =>
      expect(el.querySelector('[data-testid="payment-element-error"]')).not.toBeNull(),
    )
    expect(el.textContent).not.toContain('Test mode — payment skipped')
  })

  it('AC-2: a driver registered with registerPaymentDriver is mounted inside the element with the client options, and over generated answers confirm passes the secret in and the driver’s answer out unchanged', async () => {
    let next: Confirmation = { ok: true, confirmed: true }
    const own = recordingDriver(async () => next)
    registerPaymentDriver('p2-05-own', own.driver)
    expect(getPaymentDriver('p2-05-own')).toBe(own.driver)
    const options = { accountHint: 'acct_p2_05', locale: 'en-GB' }

    const el = mount({ driver: 'p2-05-own', options })
    await vi.waitFor(() => expect(own.mounts.length).toBeGreaterThan(0))
    expect(own.mounts).toHaveLength(1)
    expect(own.mounts[0]!.options).toEqual(options)
    expect(el.contains(own.mounts[0]!.el)).toBe(true)
    expect(el.querySelector('[data-p2-05-driver]')).not.toBeNull()

    await fc.assert(
      fc.asyncProperty(arbSecret, arbConfirmation, async (secret, answer) => {
        next = answer
        const before = own.confirms.length

        const got = await el.confirm(secret)

        expect(got).toEqual(answer)
        expect(own.confirms.slice(before)).toEqual([secret])
      }),
      { numRuns: 50 },
    )
  })

  it('AC-2: stripe loads https://js.stripe.com/v3 once for two elements, makes its client with the publishable key, and mounts a card inside each element', async () => {
    stripe = installFakeStripe()
    const network = vi.fn(async () => new Response('', { status: 599 }))
    vi.stubGlobal('fetch', network)

    const first = mount({ driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_a' } })
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))
    const second = mount({ driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_a' } })
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(1))

    expect(stripe.scripts()).toHaveLength(1)
    expect(stripe.scripts()[0]!.getAttribute('src')!.startsWith(STRIPE_JS)).toBe(true)
    expect(new Set(stripe.keys)).toEqual(new Set(['pk_test_p2_05_a']))
    expect(stripe.cards.map((c) => c.type)).toEqual(['card', 'card'])
    expect(first.contains(stripe.cards[0]!.mountedOn)).toBe(true)
    expect(second.contains(stripe.cards[1]!.mountedOn)).toBe(true)
    expect(network).not.toHaveBeenCalled()
  })

  it('AC-2: stripe confirm sends the client secret to confirmCardPayment with the mounted card: success is confirmed, a Stripe error is ok: false with its message', async () => {
    stripe = installFakeStripe()
    const el = mount({ driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_b' } })
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))

    stripe.answer = async () => ({ paymentIntent: { status: 'succeeded' } })
    const paid = await el.confirm('pi_p2_05_ok_secret_1')
    stripe.answer = async () => ({ error: { message: 'Your card was declined (p2-05).' } })
    const declined = await el.confirm('pi_p2_05_decline_secret_2')

    expect(paid).toEqual({ ok: true, confirmed: true })
    expect(declined).toEqual({ ok: false, error: 'Your card was declined (p2-05).' })
    expect(stripe.confirmCalls.map((c) => c.clientSecret)).toEqual([
      'pi_p2_05_ok_secret_1',
      'pi_p2_05_decline_secret_2',
    ])
    // The card the shopper typed into is the one confirmed: the element's own mounted card.
    const confirmedWith = stripe.confirmCalls.map(
      (c) => (c.data as { payment_method?: { card?: unknown } } | undefined)?.payment_method?.card,
    )
    expect(confirmedWith).toEqual([stripe.cards[0]!.handle, stripe.cards[0]!.handle])
  })

  it('AC-2: confirm hands the driver the checkout’s email and billing address as given', async () => {
    const own = recordingDriver(async () => ({ ok: true, confirmed: true }))
    registerPaymentDriver('p2-05-own-context', own.driver)
    const el = mount({ driver: 'p2-05-own-context', options: {} })
    await vi.waitFor(() => expect(own.mounts.length).toBeGreaterThan(0))

    await el.confirm('pi_p2_05_ctx_secret_1', CONTEXT)

    expect(own.confirms).toEqual(['pi_p2_05_ctx_secret_1'])
    expect(own.contexts).toEqual([CONTEXT])
  })

  it('AC-2: stripe confirm sends the checkout’s email, name and billing address to confirmCardPayment as billing_details, beside the mounted card', async () => {
    stripe = installFakeStripe()
    const el = mount({ driver: 'stripe', options: { publishableKey: 'pk_test_p2_05_c' } })
    await vi.waitFor(() => expect(stripe!.cards.length).toBeGreaterThan(0))

    expect(await el.confirm('pi_p2_05_billing_secret_1', CONTEXT)).toEqual({
      ok: true,
      confirmed: true,
    })

    expect(stripe.confirmCalls).toEqual([
      {
        clientSecret: 'pi_p2_05_billing_secret_1',
        data: {
          payment_method: { card: stripe.cards[0]!.handle, billing_details: BILLING_DETAILS },
        },
      },
    ])
  })
})
