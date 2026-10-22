import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCheckoutStore,
  NymbalApiError,
  registerPaymentDriver,
  type CheckoutStore,
  type PaymentConfirmation,
  type PaymentConfirmContext,
  type PaymentDriver,
} from '@nymbalhq/sdk'
import type { Address } from '@nymbalhq/types'
import { setupMockClient } from '../testing/index.js'

// P2-16 AC-2, AC-3 and AC-4: `nymbal-checkout` runs the checkout the templates ran (Decisions 2-4). The SDK under it is
// the real checkout store over a fake adapter, so `submitPayment()` answers as it does in a store: a result, or null
// with `error` (and `placedOrderNumber` on a 409 that names an order). Every call the element makes on it, the payment
// driver double's `confirm`, and each `nymbal:checkout:placed` the document hears go into one log, in order.
//
// A frame is one `requestAnimationFrame` callback. As AC-2 says, each step's submits and the click that follows are
// dispatched after a frame has passed since the step change, and the k rapid submits of one step land within one frame;
// the stray submits that follow a step change (the second click of a double click, a second Enter) land in that same
// frame, so only the multi-click rule (Decision 4) stops them.
//
// Kills: a double click that skips a step or places twice; billing sent as the shipping address when the shopper
// entered another; a form stuck after a failure, re-armed after a success, or a second order; a navigation event
// with no reset before it; place-order enabled while the payment element errors; the payment card remounted per step.

const CHECKOUT = 'nymbal-checkout'
const PAYMENT = 'nymbal-payment-element'

type Step =
  | 'setEmail'
  | 'setShippingAddress'
  | 'setShippingMethod'
  | 'setBillingAddress'
  | 'submitPayment'
const STEP_CALLS: Step[] = [
  'setEmail',
  'setShippingAddress',
  'setShippingMethod',
  'setBillingAddress',
  'submitPayment',
]
type Logged = Step | 'markConfirmed' | 'reset' | 'confirm' | 'placed'
interface Entry {
  name: Logged
  args: unknown[]
}

type Confirmation = PaymentConfirmation
type CreateAnswer = () => Promise<unknown>

/** The method both templates fix today (Decision 3), in the cart's currency. */
const FIXED_METHOD = {
  carrier: 'Standard',
  service: 'Standard Shipping',
  amountMinor: 0,
  estimatedDays: 5,
}

interface Rig {
  el: HTMLElement
  pay: HTMLElement & { status: string }
  log: Entry[]
  /** How many times the fake adapter was asked to create a checkout. */
  creates(): number
  /** The next `checkout.create` answers with this. */
  answerCreate(answer: CreateAnswer): void
  /** The driver's `confirm` answers with this from now on. */
  answerConfirm(answer: Confirmation): void
  mounts: HTMLElement[]
  store: CheckoutStore
  currency: string
}

let seq = 0
const listeners: Array<() => void> = []

afterEach(() => {
  for (const off of listeners.splice(0)) off()
})

function result(n: string, status: 'succeeded' | 'requires_action' | 'failed', reason?: string) {
  return {
    orderId: `ord-${n}`,
    orderNumber: n,
    paymentIntent: {
      id: `pi_${n}`,
      clientSecret: `pi_secret_${n}`,
      amountMinor: 1800,
      currency: 'GBP',
      status: 'requires_payment_method',
    },
    currency: 'GBP',
    totalMinor: 1800,
    orderStatus: status === 'succeeded' ? 'confirmed' : 'pending',
    payment: reason === undefined ? { status } : { status, reason },
  }
}

/** A payment driver of the test's own: it records each mount and confirm, and answers confirm as told. */
function driverDouble(log: Entry[]) {
  const name = `p2-16-driver-${++seq}`
  const mounts: HTMLElement[] = []
  let answer: Confirmation = { ok: true, confirmed: false }
  let mountResult: () => Promise<void> | void = () => undefined
  const driver: PaymentDriver = {
    mount(el: HTMLElement) {
      mounts.push(el)
      const card = document.createElement('div')
      card.setAttribute('data-p216-card', String(mounts.length))
      el.append(card)
      return mountResult()
    },
    confirm(clientSecret: string, context?: PaymentConfirmContext) {
      log.push({ name: 'confirm', args: [clientSecret, context] })
      return Promise.resolve(answer)
    },
  }
  registerPaymentDriver(name, driver)
  return {
    client: JSON.stringify({ driver: name, options: {} }),
    mounts,
    answer: (next: Confirmation) => {
      answer = next
    },
    mountWith: (fn: () => Promise<void> | void) => {
      mountResult = fn
    },
  }
}

/**
 * The SDK client with the real checkout store over a fake adapter, a payment driver double, and `nymbal-checkout`
 * with the payment element as its `payment`-slotted child, connected. `pay` is used as given when passed (already
 * connected elsewhere, say).
 */
async function rig(
  opts: { pay?: HTMLElement; driver?: ReturnType<typeof driverDouble>; log?: Entry[] } = {},
): Promise<Rig> {
  const log = opts.log ?? []
  const client = setupMockClient() as unknown as Record<string, unknown>
  const currency = (client['cart'] as { getState(): { currency: string } }).getState().currency
  let creates = 0
  let nextCreate: CreateAnswer = () => Promise.resolve(result('NYM-P216-DEFAULT', 'succeeded'))
  const adapter = {
    checkout: {
      create: () => {
        creates += 1
        return nextCreate()
      },
    },
  }
  const store = createCheckoutStore(adapter as unknown as Parameters<typeof createCheckoutStore>[0])
  const logged =
    <K extends Step | 'markConfirmed' | 'reset'>(name: K) =>
    (...args: unknown[]) => {
      log.push({ name, args })
      return (store[name] as (...a: unknown[]) => unknown)(...args)
    }
  client['checkout'] = {
    ...store,
    setEmail: logged('setEmail'),
    setShippingAddress: logged('setShippingAddress'),
    setShippingMethod: logged('setShippingMethod'),
    setBillingAddress: logged('setBillingAddress'),
    submitPayment: logged('submitPayment'),
    markConfirmed: logged('markConfirmed'),
    reset: logged('reset'),
  }

  const onPlaced = (event: Event) => {
    log.push({
      name: 'placed',
      args: [(event as CustomEvent<{ orderNumber: string }>).detail?.orderNumber],
    })
  }
  document.addEventListener('nymbal:checkout:placed', onPlaced)
  listeners.push(() => document.removeEventListener('nymbal:checkout:placed', onPlaced))

  const driver = opts.driver ?? driverDouble(log)
  const pay = (opts.pay ?? document.createElement(PAYMENT)) as Rig['pay']
  if (opts.pay === undefined) pay.setAttribute('client', driver.client)
  pay.setAttribute('slot', 'payment')
  const el = document.createElement(CHECKOUT)
  el.append(pay)
  document.body.append(el)
  await settle(el)
  return {
    el,
    pay,
    log,
    creates: () => creates,
    answerCreate: (answer) => {
      nextCreate = answer
    },
    answerConfirm: driver.answer,
    mounts: driver.mounts,
    store,
    currency,
  }
}

// ─── The shopper's hand ─────────────────────────────────────────────────────

/** Every element matching `selector` in `root` and in every open shadow root beneath it. */
function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

function rootOf(el: HTMLElement): ShadowRoot {
  expect(el.shadowRoot, 'nymbal-checkout renders in an open shadow root').not.toBeNull()
  return el.shadowRoot!
}

function byTestId<T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string): T {
  const found = deepAll(rootOf(el), `[data-testid="${id}"]`)[0]
  expect(found, `[data-testid="${id}"] inside nymbal-checkout`).toBeDefined()
  return found as T
}

/** The form that holds a step's submit button: each step is its own form (Decision 1). */
function formOf(button: HTMLElement): HTMLFormElement {
  const form = button.closest('form')
  expect(form, `${button.getAttribute('data-testid')} sits in a form`).not.toBeNull()
  return form!
}

/** Lit renders in microtasks, so this never lets an animation frame pass. */
async function settle(el: HTMLElement): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await (el as unknown as { updateComplete?: Promise<unknown> }).updateComplete
    const nested = el.shadowRoot === null ? [] : deepAll(el.shadowRoot, '*')
    await Promise.all(
      nested.map(
        (node) => (node as unknown as { updateComplete?: Promise<unknown> }).updateComplete,
      ),
    )
  }
}

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** Settles the render of a step change, then lets one frame pass, as a shopper's next action would. */
async function afterFrame(el: HTMLElement): Promise<void> {
  await settle(el)
  await nextFrame()
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  input.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

const FIELDS = [
  'firstName',
  'lastName',
  'addressLine1',
  'addressLine2',
  'city',
  'region',
  'postalCode',
  'country',
] as const

function fillAddress(el: HTMLElement, prefix: 'shipping' | 'billing', address: Address): void {
  for (const field of FIELDS)
    type(byTestId<HTMLInputElement>(el, `${prefix}-${field}`), address[field] ?? '')
}

/** The click a browser fires for the `count`th press of a multi-click. */
function click(button: HTMLElement, count: number): void {
  button.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: count }),
  )
}

/** k submits within one frame: the shopper's click, then k - 1 more submits of the same form. */
function rapid(el: HTMLElement, testId: string, k: number): void {
  const button = byTestId(el, testId)
  const form = formOf(button)
  click(button, 1)
  for (let i = 1; i < k; i += 1) form.requestSubmit()
}

/** In the frame of a step change: the double click's second click, and a second submit, on the next step's button. */
function stray(el: HTMLElement, testId: string): void {
  const button = byTestId(el, testId)
  click(button, 2)
  formOf(button).requestSubmit()
}

function setBillingSame(el: HTMLElement, same: boolean): void {
  const box = byTestId<HTMLInputElement>(el, 'billing-same')
  expect(box.checked, 'billing-same is checked by default').toBe(true)
  if (!same) box.click()
  expect(box.checked).toBe(same)
}

const names = (log: Entry[]): Logged[] => log.map((e) => e.name)
const calls = (log: Entry[], name: Logged): Entry[] => log.filter((e) => e.name === name)
const stepCalls = (log: Entry[]): Entry[] =>
  log.filter((e) => (STEP_CALLS as Logged[]).includes(e.name))

/** What `nymbal-address-form`'s `value` reads for the address typed into it: an empty second line is left out. */
function asTyped(address: Address): Address {
  const { addressLine2, ...rest } = address
  return addressLine2 === undefined || addressLine2 === '' ? rest : { ...rest, addressLine2 }
}

// ─── Generated shoppers ─────────────────────────────────────────────────────

const word = fc.stringMatching(/^[A-Z][a-z]{1,9}$/)
const email = fc
  .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z]{1,8}$/))
  .map(([user, host]) => `${user}@${host}.test`)
const address: fc.Arbitrary<Address> = fc
  .record({
    firstName: word,
    lastName: word,
    addressLine1: word.map((w) => `${w} Street`),
    addressLine2: fc.option(word, { nil: undefined }),
    city: word,
    region: word,
    postalCode: fc.stringMatching(/^[A-Z]{2}[0-9] [0-9][A-Z]{2}$/),
    country: fc.constantFrom('GB', 'FR', 'IE', 'DE'),
  })
  .map(
    ({ addressLine2, ...rest }): Address =>
      asTyped(addressLine2 === undefined ? rest : { ...rest, addressLine2 }),
  )
const k = fc.integer({ min: 1, max: 5 })

interface Shopper {
  email: string
  shipping: Address
  billingSame: boolean
  billing: Address
}

const shopper: fc.Arbitrary<Shopper> = fc.record({
  email,
  shipping: address,
  billingSame: fc.boolean(),
  billing: address,
})

const SHOPPER: Shopper = {
  email: 'ada@p2-16.test',
  shipping: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    addressLine1: '1 Analytical Row',
    city: 'London',
    region: 'Greater London',
    postalCode: 'E1 6AN',
    country: 'GB',
  },
  billingSame: true,
  billing: {
    firstName: 'Charles',
    lastName: 'Babbage',
    addressLine1: '5 Difference Lane',
    addressLine2: 'Floor 2',
    city: 'Bristol',
    region: 'Avon',
    postalCode: 'BS1 5TR',
    country: 'IE',
  },
}

/** Contact and shipping, each submitted once a frame after its step shows, up to the payment step. */
async function walkToPayment(r: Rig, s: Shopper): Promise<void> {
  await afterFrame(r.el)
  type(byTestId<HTMLInputElement>(r.el, 'contact-email'), s.email)
  rapid(r.el, 'contact-continue', 1)
  await afterFrame(r.el)
  fillAddress(r.el, 'shipping', s.shipping)
  rapid(r.el, 'shipping-continue', 1)
  await settle(r.el)
  setBillingSame(r.el, s.billingSame)
  await settle(r.el)
  if (!s.billingSame) fillAddress(r.el, 'billing', s.billing)
  await afterFrame(r.el)
}

// ─── AC-2 ───────────────────────────────────────────────────────────────────

describe('P2-16 AC-2: the flow calls the SDK once per step, in order', () => {
  it('AC-2: property: over generated contacts, addresses and k = 1-5 rapid submits per step (with a double click and a second submit landing on each next step), one setEmail, one setShippingAddress + setShippingMethod, one setBillingAddress + submitPayment, in that order; billing is the shipping address passed with billing-same, else the billing form’s values', async () => {
    await fc.assert(
      fc.asyncProperty(shopper, k, k, k, async (s, kContact, kShipping, kPlace) => {
        document.body.innerHTML = ''
        const r = await rig()
        r.answerCreate(() => Promise.resolve(result('NYM-P216-AC2', 'succeeded')))

        // Contact.
        await afterFrame(r.el)
        type(byTestId<HTMLInputElement>(r.el, 'contact-email'), s.email)
        rapid(r.el, 'contact-continue', kContact)
        await settle(r.el)
        // The shipping step has rendered under the cursor, in the same frame: filled, then hit again.
        fillAddress(r.el, 'shipping', s.shipping)
        stray(r.el, 'shipping-continue')
        await settle(r.el)
        expect(names(stepCalls(r.log)), 'after the contact step').toEqual(['setEmail'])

        // Shipping, a frame later.
        await nextFrame()
        rapid(r.el, 'shipping-continue', kShipping)
        await settle(r.el)
        setBillingSame(r.el, s.billingSame)
        await settle(r.el)
        if (!s.billingSame) fillAddress(r.el, 'billing', s.billing)
        stray(r.el, 'place-order')
        await settle(r.el)
        expect(names(stepCalls(r.log)), 'after the shipping step').toEqual([
          'setEmail',
          'setShippingAddress',
          'setShippingMethod',
        ])

        // Place order, a frame later.
        await nextFrame()
        rapid(r.el, 'place-order', kPlace)
        await vi.waitFor(() => expect(names(r.log)).toContain('placed'))

        const steps = stepCalls(r.log)
        expect(names(steps)).toEqual(STEP_CALLS)
        expect(r.creates(), 'orders created').toBe(1)
        const [contact, shipping, method, billing] = steps
        expect(contact!.args).toEqual([s.email])
        expect(shipping!.args).toEqual([s.shipping])
        expect(method!.args).toEqual([{ ...FIXED_METHOD, currency: r.currency }])
        expect(billing!.args).toEqual([s.billingSame ? shipping!.args[0] : s.billing])
      }),
      { numRuns: 30 },
    )
  }, 60_000)

  it('AC-2: multi-click: a frame after the contact submit a click {detail: 2} on shipping-continue makes no setShippingAddress; a frame after the shipping submit a click {detail: 2} on place-order makes no setBillingAddress or submitPayment; the click {detail: 1} that follows places exactly one order', async () => {
    const r = await rig()
    r.answerCreate(() => Promise.resolve(result('NYM-P216-MULTI', 'succeeded')))

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    fillAddress(r.el, 'shipping', SHOPPER.shipping)
    click(byTestId(r.el, 'shipping-continue'), 2)
    await settle(r.el)
    expect(names(stepCalls(r.log)), 'a detail-2 click on shipping-continue').toEqual(['setEmail'])

    click(byTestId(r.el, 'shipping-continue'), 1)
    await afterFrame(r.el)
    // The first click advanced to payment; the second lands on Place Order, rendered where Continue was.
    click(byTestId(r.el, 'place-order'), 2)
    await afterFrame(r.el)
    expect(names(stepCalls(r.log)), 'a detail-2 click on place-order').toEqual([
      'setEmail',
      'setShippingAddress',
      'setShippingMethod',
    ])
    expect(r.creates()).toBe(0)
    expect(calls(r.log, 'placed')).toEqual([])

    click(byTestId(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(calls(r.log, 'placed')).toHaveLength(1))
    expect(calls(r.log, 'submitPayment')).toHaveLength(1)
    expect(r.creates()).toBe(calls(r.log, 'submitPayment').length)
  })

  it('AC-2: billing that differs is the billing nymbal-address-form’s value, not the shipping address', async () => {
    const r = await rig()
    r.answerCreate(() => Promise.resolve(result('NYM-P216-BILL', 'succeeded')))
    await walkToPayment(r, { ...SHOPPER, billingSame: false })

    const billingForm = deepAll(rootOf(r.el), 'nymbal-address-form').find(
      (node) => node.getAttribute('id-prefix') === 'billing',
    )
    expect(billingForm, 'the billing block is a nymbal-address-form').toBeDefined()
    // The element's `value` is the contract; what its inputs hold is its own business.
    const entered: Address = { ...SHOPPER.billing, firstName: 'Augusta', city: 'Ockham' }
    Object.defineProperty(billingForm, 'value', { configurable: true, get: () => entered })

    click(byTestId(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(calls(r.log, 'placed')).toHaveLength(1))
    const [billing] = calls(r.log, 'setBillingAddress')
    expect(billing!.args).toEqual([entered])
    expect(billing!.args[0]).not.toEqual(calls(r.log, 'setShippingAddress')[0]!.args[0])
  })
})

// ─── AC-3 ───────────────────────────────────────────────────────────────────

type Outcome =
  | 'succeeded'
  | 'confirmed'
  | 'unconfirmed'
  | 'declined'
  | 'failed'
  | 'placed409'
  | 'network'
const OUTCOMES: Outcome[] = [
  'succeeded',
  'confirmed',
  'unconfirmed',
  'declined',
  'failed',
  'placed409',
  'network',
]
const PLACES = new Set<Outcome>(['succeeded', 'confirmed', 'unconfirmed', 'placed409'])
const ASKS_DRIVER = new Set<Outcome>(['confirmed', 'unconfirmed', 'declined'])

/** What one place-order press makes, in order, for each outcome (Decision 3). */
const SEQUENCE: Record<Outcome, Logged[]> = {
  succeeded: ['setBillingAddress', 'submitPayment', 'reset', 'placed'],
  confirmed: ['setBillingAddress', 'submitPayment', 'confirm', 'markConfirmed', 'reset', 'placed'],
  unconfirmed: ['setBillingAddress', 'submitPayment', 'confirm', 'reset', 'placed'],
  declined: ['setBillingAddress', 'submitPayment', 'confirm'],
  failed: ['setBillingAddress', 'submitPayment'],
  placed409: ['setBillingAddress', 'submitPayment', 'reset', 'placed'],
  network: ['setBillingAddress', 'submitPayment'],
}

/** Sets what the server and the driver answer for attempt `i`; returns what that attempt must show or place. */
function stage(r: Rig, outcome: Outcome, i: number): { orderNumber?: string; message?: string } {
  const n = `NYM-P216-${i}`
  switch (outcome) {
    case 'succeeded':
      r.answerCreate(() => Promise.resolve(result(n, 'succeeded')))
      return { orderNumber: n }
    case 'confirmed':
      r.answerCreate(() => Promise.resolve(result(n, 'requires_action')))
      r.answerConfirm({ ok: true, confirmed: true })
      return { orderNumber: n }
    case 'unconfirmed':
      r.answerCreate(() => Promise.resolve(result(n, 'requires_action')))
      r.answerConfirm({ ok: true, confirmed: false })
      return { orderNumber: n }
    case 'declined': {
      const message = `Card declined (p2-16 attempt ${i})`
      r.answerCreate(() => Promise.resolve(result(n, 'requires_action')))
      r.answerConfirm({ ok: false, error: message })
      return { message }
    }
    case 'failed': {
      const reason = `p216_declined_${i}`
      r.answerCreate(() => Promise.resolve(result(n, 'failed', reason)))
      return { message: reason }
    }
    case 'placed409': {
      const placed = `NYM-P216-PLACED-${i}`
      r.answerCreate(() =>
        Promise.reject(
          new NymbalApiError('checkout.cart_empty', `This cart is already order ${placed}`, 409, {
            orderNumber: placed,
          }),
        ),
      )
      return { orderNumber: placed }
    }
    case 'network': {
      const message = `Failed to fetch (p2-16 attempt ${i})`
      r.answerCreate(() => Promise.reject(new TypeError(message)))
      return { message }
    }
  }
}

const errorText = (el: HTMLElement): string => {
  const found = deepAll(rootOf(el), '[data-testid="checkout-error"]')[0]
  return found?.textContent ?? ''
}

describe('P2-16 AC-3: outcomes', () => {
  it('AC-3: property: over outcome sequences, a success or a 409-placed fires exactly one nymbal:checkout:placed with its orderNumber after checkout.reset(), and place-order stays disabled; a failure fires none, shows its message in checkout-error and re-enables place-order; on requires_action confirm gets the response’s clientSecret and { email, billing } before reset and placed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...OUTCOMES), { minLength: 1, maxLength: 4 }),
        shopper,
        async (outcomes, s) => {
          document.body.innerHTML = ''
          const r = await rig()
          await walkToPayment(r, s)
          await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
          const billing = s.billingSame ? s.shipping : s.billing
          const placeOrder = () => byTestId<HTMLButtonElement>(r.el, 'place-order')

          // The shopper presses until an order is placed; place-order is locked from then on.
          const placedAt = outcomes.findIndex((o) => PLACES.has(o))
          const run = placedAt === -1 ? outcomes : outcomes.slice(0, placedAt + 1)
          for (const [i, outcome] of run.entries()) {
            const want = stage(r, outcome, i)
            const places = PLACES.has(outcome)
            const from = r.log.length
            await nextFrame()
            click(placeOrder(), 1)

            const shown = () =>
              places
                ? names(r.log.slice(from)).includes('placed')
                : errorText(r.el).includes(want.message!) && !placeOrder().disabled
            await vi.waitFor(() => expect(shown(), `attempt ${i} (${outcome}) settles`).toBe(true))
            const attempt = r.log.slice(from)

            expect(r.creates(), `attempt ${i}: one order request each`).toBe(i + 1)
            expect(
              names(attempt).filter((n) => n !== 'setEmail'),
              `attempt ${i} (${outcome}): calls and events in order`,
            ).toEqual(SEQUENCE[outcome])
            expect(calls(attempt, 'confirm').map((c) => c.args)).toEqual(
              ASKS_DRIVER.has(outcome)
                ? [[`pi_secret_NYM-P216-${i}`, { email: s.email, billing }]]
                : [],
            )
            expect(calls(attempt, 'placed').map((e) => e.args[0])).toEqual(
              places ? [want.orderNumber] : [],
            )
            expect(placeOrder().disabled, 'disabled after a success, enabled after a failure').toBe(
              places,
            )
            expect(
              places || errorText(r.el).includes(want.message!),
              'checkout-error shows it',
            ).toBe(true)
          }

          // One more press: nothing once an order is placed, one more request after a failure.
          const placedOnce = placedAt !== -1
          const createsBefore = r.creates()
          await nextFrame()
          click(placeOrder(), 1)
          await afterFrame(r.el)
          expect(calls(r.log, 'placed')).toHaveLength(placedOnce ? 1 : 0)
          expect(r.creates() - createsBefore, 'requests from one more press').toBe(
            placedOnce ? 0 : 1,
          )
          expect(placeOrder().disabled).toBe(placedOnce)
        },
      ),
      { numRuns: 40 },
    )
  }, 90_000)

  it('AC-3: a payment element already in error before nymbal-checkout connects keeps place-order disabled, and pressing it submits nothing', async () => {
    const pay = document.createElement(PAYMENT)
    pay.setAttribute('client', 'not json')
    document.body.append(pay)
    expect((pay as unknown as { status: string }).status, 'the child errored on its own').toBe(
      'error',
    )

    const r = await rig({ pay })
    await walkToPayment(r, SHOPPER)
    const button = byTestId<HTMLButtonElement>(r.el, 'place-order')
    expect(button.disabled).toBe(true)
    click(button, 1)
    formOf(button).requestSubmit()
    await afterFrame(r.el)
    expect(calls(r.log, 'submitPayment')).toEqual([])
    expect(r.creates()).toBe(0)
  })

  it('AC-3: a payment element that reports error after nymbal-checkout connected (its driver failed to mount) disables place-order, and pressing it submits nothing', async () => {
    const log: Entry[] = []
    const driver = driverDouble(log)
    let fail!: (err: Error) => void
    driver.mountWith(() => new Promise<void>((_, reject) => (fail = reject)))
    const r = await rig({ driver, log })
    await walkToPayment(r, SHOPPER)
    expect(r.pay.status, 'still mounting when the shopper reaches payment').toBe('pending')

    fail(new Error('The card form could not load (p2-16).'))
    await vi.waitFor(() => expect(r.pay.status).toBe('error'))
    await afterFrame(r.el)
    const button = byTestId<HTMLButtonElement>(r.el, 'place-order')
    expect(button.disabled).toBe(true)
    click(button, 1)
    formOf(button).requestSubmit()
    await afterFrame(r.el)
    expect(calls(r.log, 'submitPayment')).toEqual([])
    expect(r.creates()).toBe(calls(r.log, 'submitPayment').length)
  })
})

// ─── AC-4 ───────────────────────────────────────────────────────────────────

describe('P2-16 AC-4: the payment element mounts once', () => {
  it('AC-4: contact → shipping → back to contact → shipping → payment mounts the driver once, and the payment element is the same node, never removed, throughout', async () => {
    const r = await rig()
    const removed: Node[] = []
    const observer = new MutationObserver((records) => {
      for (const record of records) removed.push(...record.removedNodes)
    })
    observer.observe(r.el, { childList: true, subtree: true })
    const card = () => r.pay.querySelector('[data-p216-card]')
    const sameNode = (where: string) => {
      expect(r.el.querySelector(PAYMENT), where).toBe(r.pay)
      expect(r.pay.isConnected, where).toBe(true)
    }

    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    const first = card()
    sameNode('contact')

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    sameNode('shipping')

    const shippingForm = formOf(byTestId(r.el, 'shipping-continue'))
    const back = [...shippingForm.querySelectorAll('button')].find((b) =>
      /back/i.test(b.textContent ?? ''),
    )
    expect(back, 'a Back button in the shipping step').toBeDefined()
    back!.click()
    await afterFrame(r.el)
    sameNode('back on contact')
    expect(calls(r.log, 'setShippingAddress')).toEqual([])

    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    fillAddress(r.el, 'shipping', SHOPPER.shipping)
    click(byTestId(r.el, 'shipping-continue'), 1)
    await afterFrame(r.el)
    sameNode('payment')
    expect(calls(r.log, 'setShippingAddress')).toHaveLength(1)
    observer.disconnect()

    expect(r.mounts).toHaveLength(1)
    expect(r.mounts[0]).toBe(r.pay)
    expect(card(), 'the card the driver mounted is still the one shown').toBe(first)
    expect(removed.filter((node) => node === r.pay || node === first)).toEqual([])
  })
})

describe('P2-16 diff review B1: a step change never moves what is under the cursor', () => {
  // happy-dom lays nothing out, so the main column's height is modelled: the shown step's own height, raised to the
  // column's min-height, as a browser lays out a block. Payment is shorter than shipping, as on a desktop store.
  const STEP_HEIGHT = { contact: 260, shipping: 720, payment: 410 } as const

  function laidOut(el: HTMLElement): HTMLElement {
    const main = rootOf(el).querySelector<HTMLElement>("[part~='main']")
    expect(main, "[part~='main'] inside nymbal-checkout").not.toBeNull()
    Object.defineProperty(main!, 'offsetHeight', {
      configurable: true,
      get: () => {
        const shown = (Object.keys(STEP_HEIGHT) as Array<keyof typeof STEP_HEIGHT>).find(
          (step) => !byTestId(el, `checkout-${step}`).hidden,
        )
        const own = shown === undefined ? 0 : STEP_HEIGHT[shown]
        return Math.max(own, Number.parseFloat(main!.style.minHeight) || 0)
      },
    })
    return main!
  }

  // Kills: the shorter payment step rendered at its own height in the frame of the shipping submit, so the page
  // shortens and a double click's second click lands on a footer link that rose under the cursor.
  it('B1: shipping → payment: within the step-change frame, and a frame later, the main column is no shorter than the shipping step it replaced', async () => {
    const r = await rig()
    const main = laidOut(r.el)

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    fillAddress(r.el, 'shipping', SHOPPER.shipping)
    const before = main.offsetHeight
    expect(before).toBe(STEP_HEIGHT.shipping)

    click(byTestId(r.el, 'shipping-continue'), 1)
    await settle(r.el)
    expect(byTestId(r.el, 'checkout-payment').hidden, 'the payment step is shown').toBe(false)
    expect(main.offsetHeight, 'in the step-change frame').toBeGreaterThanOrEqual(before)

    await nextFrame()
    expect(
      main.offsetHeight,
      'a frame later, when a second click can still come',
    ).toBeGreaterThanOrEqual(before)
  })
})
