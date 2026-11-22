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
import { formatPrice } from '../format.js'
import { setupMockClient } from '../testing/index.js'

// `nymbal-checkout` runs the checkout. The SDK under it is the real checkout store over a fake adapter, so `quote()`
// and `submitPayment()` answer as they do in a store: a quote or a result, or null with `error` (and
// `placedOrderNumber` on a 409 that names an order). Every call the element makes on it, the payment driver double's
// `confirm`, and each `nymbal:checkout:placed` the document hears go into one log, in order.
//
// A frame is one `requestAnimationFrame` callback. As AC-2 says, each step's submits and the click that follows are
// dispatched after a frame has passed since the step change, and the k rapid submits of one step land within one frame;
// the stray submits that follow a step change (the second click of a double click, a second Enter) land in that same
// frame, so only the multi-click rule stops them.

const CHECKOUT = 'nymbal-checkout'
const PAYMENT = 'nymbal-payment-element'

type Step =
  | 'setEmail'
  | 'setShippingAddress'
  | 'quote'
  | 'selectShippingOption'
  | 'setBillingAddress'
  | 'submitPayment'
const STEP_CALLS: Step[] = [
  'setEmail',
  'setShippingAddress',
  'quote',
  'selectShippingOption',
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
/** What the fake adapter's `checkout.quote` was asked: the shipping address and the option, if any. */
interface QuoteAsk {
  shippingAddress: Address
  shippingOptionId?: string
  email?: string
}
type QuoteAnswer = (ask: QuoteAsk) => Promise<unknown>

interface Option {
  id: string
  name: string
  amountMinor: number
  estimatedDays: number | null
}

const OPTIONS: Option[] = [
  { id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: 3 },
  { id: 'express', name: 'Express', amountMinor: 499, estimatedDays: 1 },
  { id: 'collect', name: 'Click and collect', amountMinor: 0, estimatedDays: null },
]

interface Priced {
  subtotalMinor?: number
  discountMinor?: number
  taxMinor?: number
  inclusive?: boolean
  currency?: string
  options?: Option[]
}

/** The quote for `optionId`: its totals add up as the server's do. */
function quoteOf(optionId: string, p: Priced = {}) {
  const options = p.options ?? OPTIONS
  const option = options.find((o) => o.id === optionId) ?? options[0]!
  const subtotal = p.subtotalMinor ?? 1800
  const discount = p.discountMinor ?? 0
  const tax = p.taxMinor ?? 0
  const inclusive = p.inclusive ?? false
  const currency = p.currency ?? 'GBP'
  return {
    currency,
    options,
    shippingOptionId: option.id,
    totals: {
      currency,
      subtotalMinor: subtotal,
      discountTotalMinor: discount,
      shippingTotalMinor: option.amountMinor,
      shippingDiscountMinor: 0,
      taxTotalMinor: tax,
      totalMinor: subtotal - discount + option.amountMinor + (inclusive ? 0 : tax),
      pricesIncludeTax: inclusive,
      lines: [],
      applied: [],
    },
  }
}

interface Rig {
  el: HTMLElement
  pay: HTMLElement & { status: string }
  log: Entry[]
  /** How many times the fake adapter was asked to create a checkout. */
  creates(): number
  /** What each `checkout.create` was sent, in order. */
  created: Array<Record<string, unknown>>
  /** The next `checkout.create` answers with this. */
  answerCreate(answer: CreateAnswer): void
  /** What each `checkout.quote` was asked, in order. */
  quotes: QuoteAsk[]
  /** Every `checkout.quote` from now on answers with this; by default, `quoteOf` the option asked for. */
  answerQuote(answer: QuoteAnswer): void
  /** The driver's `confirm` answers with this from now on. */
  answerConfirm(answer: Confirmation): void
  mounts: HTMLElement[]
  store: CheckoutStore
  currency: string
  /** The mock client the element reads, its cart store included. */
  client: Record<string, unknown>
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
  const name = `checkout-el-driver-${++seq}`
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
  const created: Array<Record<string, unknown>> = []
  let nextCreate: CreateAnswer = () => Promise.resolve(result('NYM-P216-DEFAULT', 'succeeded'))
  const quotes: QuoteAsk[] = []
  let quoteAnswer: QuoteAnswer = (ask) =>
    Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard'))
  const adapter = {
    checkout: {
      create: (details: Record<string, unknown>) => {
        creates += 1
        created.push(structuredClone(details))
        return nextCreate()
      },
      quote: (ask: QuoteAsk) => {
        quotes.push(structuredClone(ask))
        return quoteAnswer(ask)
      },
    },
  }
  const store = createCheckoutStore(adapter as unknown as Parameters<typeof createCheckoutStore>[0])
  const logged =
    <K extends Step | 'markConfirmed' | 'reset'>(name: K) =>
    (...args: unknown[]) => {
      log.push({ name, args })
      // `quote` and `selectShippingOption` are the store's from this change on.
      const method = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!
      return method(...args)
    }
  client['checkout'] = {
    ...store,
    setEmail: logged('setEmail'),
    setShippingAddress: logged('setShippingAddress'),
    quote: logged('quote'),
    selectShippingOption: logged('selectShippingOption'),
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
    created,
    answerCreate: (answer) => {
      nextCreate = answer
    },
    quotes,
    answerQuote: (answer) => {
      quoteAnswer = answer
    },
    answerConfirm: driver.answer,
    mounts: driver.mounts,
    store,
    currency,
    client,
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

/** The form that holds a step's submit button: each step is its own form. */
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

/**
 * Settles until `step` is the one shown, bounded: the shipping step moves on only once its quote answers, a promise
 * the fake adapter settles in microtasks. Uses no timer, so it holds under fake timers.
 */
async function untilStep(el: HTMLElement, step: 'contact' | 'shipping' | 'payment'): Promise<void> {
  for (let turn = 0; turn < 50 && byTestId(el, `checkout-${step}`).hidden; turn += 1) {
    await Promise.resolve()
    await settle(el)
  }
  expect(byTestId(el, `checkout-${step}`).hidden, `the ${step} step is shown`).toBe(false)
}

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
  email: 'ada@checkout-el.test',
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
  await untilStep(r.el, 'payment')
  setBillingSame(r.el, s.billingSame)
  await settle(r.el)
  if (!s.billingSame) fillAddress(r.el, 'billing', s.billing)
  await afterFrame(r.el)
}

// ─── AC-2 ───────────────────────────────────────────────────────────────────

describe('AC-2: the flow calls the SDK once per step, in order', () => {
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
    await untilStep(r.el, 'payment')
    await afterFrame(r.el)
    // The first click advanced to payment; the second lands on Place Order, rendered where Continue was.
    click(byTestId(r.el, 'place-order'), 2)
    await afterFrame(r.el)
    expect(names(stepCalls(r.log)), 'a detail-2 click on place-order').toEqual([
      'setEmail',
      'setShippingAddress',
      'quote',
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

/** What one place-order press makes, in order, for each outcome. */
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
      const message = `Card declined (checkout-el attempt ${i})`
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
      const message = `Failed to fetch (checkout-el attempt ${i})`
      r.answerCreate(() => Promise.reject(new TypeError(message)))
      return { message }
    }
  }
}

const errorText = (el: HTMLElement): string => {
  const found = deepAll(rootOf(el), '[data-testid="checkout-error"]')[0]
  return found?.textContent ?? ''
}

describe('AC-3: outcomes', () => {
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

    fail(new Error('The card form could not load (checkout-el).'))
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

describe('AC-4: the payment element mounts once', () => {
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
    await untilStep(r.el, 'payment')
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

describe('a step change never moves what is under the cursor', () => {
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
  // shortens and a double click's second click lands on a footer link that rose under the cursor; and a hold never
  // released, which leaves the payment step a blank gap the height of the shipping step above the summary.
  it("B1, W1: shipping → payment: the main column is no shorter than the shipping step it replaced until 600 ms after the step change, which follows the quote's answer (a double click is at most 500 ms), then it is the payment step's own height", async () => {
    const r = await rig()
    const main = laidOut(r.el)
    let answer: () => void = () => undefined
    r.answerQuote(
      (ask) =>
        new Promise((resolve) => {
          answer = () => resolve(quoteOf(ask.shippingOptionId ?? 'standard'))
        }),
    )

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    fillAddress(r.el, 'shipping', SHOPPER.shipping)
    const before = main.offsetHeight
    expect(before).toBe(STEP_HEIGHT.shipping)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      click(byTestId(r.el, 'shipping-continue'), 1)
      await settle(r.el)
      expect(
        byTestId(r.el, 'checkout-shipping').hidden,
        'the shipping step stays until the quote answers',
      ).toBe(false)
      // The quote takes 300 ms: the step change, and the hold's 600 ms, start at its answer.
      vi.advanceTimersByTime(300)
      answer()
      await untilStep(r.el, 'payment')
      expect(main.offsetHeight, 'in the step-change frame').toBeGreaterThanOrEqual(before)

      vi.advanceTimersByTime(500)
      expect(
        main.offsetHeight,
        "500 ms later, when a double click's second click can still come",
      ).toBeGreaterThanOrEqual(before)

      vi.advanceTimersByTime(100)
      expect(main.offsetHeight, '600 ms later, the hold is released').toBe(STEP_HEIGHT.payment)
    } finally {
      vi.useRealTimers()
    }
  })

  // Kills: a release timer left from the first step change cutting short the hold of a later one, and a timer that
  // outlives the element.
  it('W1: a step change inside the hold restarts its 600 ms, and disconnecting releases it', async () => {
    const r = await rig()
    const main = laidOut(r.el)

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    click(byTestId(r.el, 'contact-continue'), 1)
    await afterFrame(r.el)
    fillAddress(r.el, 'shipping', SHOPPER.shipping)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      click(byTestId(r.el, 'shipping-continue'), 1)
      await untilStep(r.el, 'payment')
      await afterFrame(r.el)
      vi.advanceTimersByTime(400)
      const back = byTestId(r.el, 'checkout-payment').querySelector<HTMLElement>("[part~='back']")
      expect(back, "the payment step's back button").not.toBeNull()
      click(back!, 1)
      await afterFrame(r.el)
      expect(byTestId(r.el, 'checkout-shipping').hidden, 'back on the shipping step').toBe(false)
      click(byTestId(r.el, 'shipping-continue'), 1)
      await untilStep(r.el, 'payment')
      await afterFrame(r.el)
      expect(byTestId(r.el, 'checkout-payment').hidden, 'the payment step is shown again').toBe(
        false,
      )

      vi.advanceTimersByTime(500)
      expect(
        main.offsetHeight,
        '900 ms after the first step change, 500 ms after the last',
      ).toBeGreaterThanOrEqual(STEP_HEIGHT.shipping)

      r.el.remove()
      expect(main.style.minHeight, 'disconnected, the hold is released').toBe('')
      expect(vi.getTimerCount(), 'no release timer outlives the element').toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ─── AC-6 ───────────────────────────────────────────────────────────────────

// AC-6: `nymbal:checkout:placed` carries the key the server answered with the order, so the page it opens can read the
// order: from a success's result, or from the context of a 409 that names the order. An answer with no key gives a
// detail with no orderKey property at all.
describe('AC-6: the placed event carries the order key', () => {
  const placedKey = fc.option(fc.stringMatching(/^[A-Za-z0-9_-]{43}$/), { nil: undefined })

  it('AC-6: property: on a success (paid, or awaiting the driver) and on a 409 naming an order, nymbal:checkout:placed’s detail is { orderNumber, orderKey } from that answer, and { orderNumber } alone when the answer has no key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<'succeeded' | 'unconfirmed' | 'placed409'>(
          'succeeded',
          'unconfirmed',
          'placed409',
        ),
        placedKey,
        fc.stringMatching(/^NYM-[0-9]{4}$/),
        async (outcome, orderKey, orderNumber) => {
          document.body.innerHTML = ''
          const details: unknown[] = []
          const onPlaced = (event: Event) => details.push((event as CustomEvent).detail)
          document.addEventListener('nymbal:checkout:placed', onPlaced)
          listeners.push(() => document.removeEventListener('nymbal:checkout:placed', onPlaced))

          const r = await rig()
          const withKey = orderKey === undefined ? {} : { orderKey }
          if (outcome === 'placed409') {
            r.answerCreate(() =>
              Promise.reject(
                new NymbalApiError(
                  'checkout.cart_empty',
                  `This cart is already order ${orderNumber}`,
                  409,
                  { orderNumber, ...withKey },
                ),
              ),
            )
          } else {
            const answer = result(
              orderNumber,
              outcome === 'succeeded' ? 'succeeded' : 'requires_action',
            )
            r.answerCreate(() => Promise.resolve({ ...answer, ...withKey }))
            r.answerConfirm({ ok: true, confirmed: false })
          }
          await walkToPayment(r, SHOPPER)
          await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
          await nextFrame()
          click(byTestId<HTMLButtonElement>(r.el, 'place-order'), 1)
          await vi.waitFor(() =>
            expect(details.length, `${outcome}: placed`).toBeGreaterThanOrEqual(1),
          )

          expect(
            details,
            `${outcome}, ${orderKey === undefined ? 'no key' : 'a key'}`,
          ).toStrictEqual([{ orderNumber, ...withKey }])
        },
      ),
      { numRuns: 16 },
    )
  }, 90_000)
})

// ─── AC-8 ───────────────────────────────────────────────────────────────────

// AC-8: a signed-in shopper whose session ended before Place Order. The order request is refused with
// auth.token_invalid and the SDK has dropped the token, so a second press would go out as a guest: Place Order stays
// disabled, and the shopper is sent to sign in again, back to /checkout. Any other refusal is a failure as before.
describe('AC-8: a session that has ended at Place Order', () => {
  const SESSION_EXPIRED = 'Your session has expired. Sign in again to place your order.'
  const SIGN_IN = '/account/login?redirect=%2Fcheckout'
  const refusal = fc.constantFrom(
    'auth.token_invalid',
    'auth.token_invalid',
    'checkout.invalid',
    'inventory.insufficient',
    'checkout.payment_in_progress',
  )

  it('AC-8: property: a refusal with auth.token_invalid shows the session-expired message and a checkout-sign-in link back to /checkout, places nothing, keeps the shopper on the payment step with their entries, and k more presses submit nothing; any other refusal shows its own message and the next press submits again', async () => {
    await fc.assert(
      fc.asyncProperty(shopper, refusal, k, async (s, code, presses) => {
        document.body.innerHTML = ''
        const r = await rig()
        const message = `Refused (${code})`
        r.answerCreate(() => Promise.reject(new NymbalApiError(code, message, 401)))
        await walkToPayment(r, s)
        await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
        const placeOrder = () => byTestId<HTMLButtonElement>(r.el, 'place-order')
        const signIn = () => deepAll(rootOf(r.el), '[data-testid="checkout-sign-in"]')
        const ended = code === 'auth.token_invalid'

        await nextFrame()
        click(placeOrder(), 1)
        await vi.waitFor(() => expect(r.creates(), 'the order request').toBe(1))
        await afterFrame(r.el)

        expect(errorText(r.el), `checkout-error after ${code}`).toBe(
          ended ? SESSION_EXPIRED : message,
        )
        expect(
          signIn().map((a) => a.getAttribute('href')),
          'checkout-sign-in',
        ).toEqual(ended ? [SIGN_IN] : [])
        expect(calls(r.log, 'placed')).toEqual([])
        expect(byTestId(r.el, 'checkout-step-payment').getAttribute('aria-current')).toBe('step')
        expect(byTestId(r.el, 'checkout-payment').hidden).toBe(false)
        const { email, shippingAddress, billingAddress } = r.store.getState()
        expect({ email, shippingAddress, billingAddress }, 'the shopper’s entries').toEqual({
          email: s.email,
          shippingAddress: s.shipping,
          billingAddress: s.billingSame ? s.shipping : s.billing,
        })
        expect(placeOrder().disabled, 'place-order after the refusal').toBe(ended)

        // After an ended session, k more presses (and submits of the form); after any other refusal, one.
        const more = ended ? presses : 1
        const submitted = calls(r.log, 'submitPayment').length
        for (let i = 0; i < more; i += 1) {
          await nextFrame()
          click(placeOrder(), 1)
          formOf(placeOrder()).requestSubmit()
        }
        await afterFrame(r.el)
        await vi.waitFor(() =>
          expect(
            calls(r.log, 'submitPayment').length - submitted,
            `submits from ${more} more presses`,
          ).toBe(ended ? 0 : 1),
        )
        expect(r.creates() - 1).toBe(calls(r.log, 'submitPayment').length - submitted)
        expect(calls(r.log, 'placed')).toEqual([])
      }),
      { numRuns: 12, endOnFailure: true },
    )
  }, 90_000)

  it('AC-8: sign-in-href names where checkout-sign-in goes', async () => {
    const r = await rig()
    const href = '/members/sign-in?next=%2Fcheckout'
    r.el.setAttribute('sign-in-href', href)
    r.answerCreate(() =>
      Promise.reject(
        new NymbalApiError('auth.token_invalid', 'the access token is not valid', 401),
      ),
    )
    await walkToPayment(r, SHOPPER)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    await nextFrame()
    click(byTestId<HTMLButtonElement>(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(r.creates()).toBe(1))
    await afterFrame(r.el)

    expect(
      deepAll(rootOf(r.el), '[data-testid="checkout-sign-in"]').map((a) => a.getAttribute('href')),
    ).toEqual([href])
  })
})

// ─── AC-11 ──────────────────────────────────────────────────────────────────

// AC-11: an order that needs the payment confirmed on the page (requires_action) is never left for its order page
// unpaid because nothing on the page can confirm it. Only a payment element that says there is nothing to confirm (no
// client half) lets the order through unconfirmed.
describe('AC-11: requires_action with nothing on the page to take the payment', () => {
  const NO_PAYMENT = 'Payment could not be taken on this page. Please reload and try again.'

  const pages = {
    'no nymbal-payment-element': (r: Rig) => r.pay.remove(),
    'a nymbal-payment-element with no confirm method (never upgraded)': (r: Rig) =>
      Object.defineProperty(r.pay, 'confirm', { value: undefined, configurable: true }),
  }

  for (const [page, strip] of Object.entries(pages)) {
    it(`AC-11: with ${page}, checkout-error says the payment could not be taken, no nymbal:checkout:placed fires, markConfirmed is never called, and Place Order is enabled again`, async () => {
      const r = await rig()
      strip(r)
      r.answerCreate(() => Promise.resolve(result('NYM-P420-1', 'requires_action')))
      await walkToPayment(r, SHOPPER)
      const placeOrder = () => byTestId<HTMLButtonElement>(r.el, 'place-order')

      await nextFrame()
      click(placeOrder(), 1)
      await vi.waitFor(() => expect(r.creates()).toBe(1))
      await afterFrame(r.el)

      expect(errorText(r.el)).toBe(NO_PAYMENT)
      expect(calls(r.log, 'placed')).toEqual([])
      expect(calls(r.log, 'markConfirmed')).toEqual([])
      expect(placeOrder().disabled).toBe(false)
      // Enabled for real: the next press asks the server again.
      r.answerCreate(() => Promise.resolve(result('NYM-P420-2', 'requires_action')))
      await nextFrame()
      click(placeOrder(), 1)
      await vi.waitFor(() => expect(r.creates()).toBe(2))
      await afterFrame(r.el)
      expect(calls(r.log, 'placed')).toEqual([])
    })
  }

  it('AC-11: a nymbal-payment-element with no client half (no driver) has nothing to confirm, so the order is placed as before', async () => {
    const r = await rig({ pay: document.createElement(PAYMENT) })
    r.answerCreate(() => Promise.resolve(result('NYM-P420-3', 'requires_action')))
    await walkToPayment(r, SHOPPER)

    await nextFrame()
    click(byTestId<HTMLButtonElement>(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(calls(r.log, 'placed')).toHaveLength(1))

    expect(calls(r.log, 'placed').map((e) => e.args[0])).toEqual(['NYM-P420-3'])
    expect(calls(r.log, 'markConfirmed')).toEqual([])
    expect(errorText(r.el)).toBe('')
  })
})

// ─── The quote on the page ──────────────────────────────────────────────────

const NO_SHIPPING = "We don't deliver to this address."
const TOTAL_UNAVAILABLE = "We couldn't work out your total just now. Please try again."
const TOTAL_CHANGED = 'The total has changed. Please check it and place your order again.'
const EXPIRED = 'Your session has expired. Sign in again to place your order.'

/** A quote answer the test releases when it chooses. */
function heldQuote(
  answer: (ask: QuoteAsk) => unknown = (ask) => quoteOf(ask.shippingOptionId ?? 'standard'),
) {
  let release: () => void = () => undefined
  const respond: QuoteAnswer = (ask) =>
    new Promise((resolve) => {
      release = () => resolve(answer(ask))
    })
  return { respond, release: () => release() }
}

/** A cart of one line at `subtotalMinor`, as the cart store holds it. */
function cartOf(r: Rig, subtotalMinor: number, currency = 'GBP'): void {
  const cart = r.client['cart'] as { setState(partial: Record<string, unknown>): void }
  cart.setState({
    currency,
    subtotalMinor,
    itemCount: 1,
    items: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Lamp',
        variantName: '',
        priceMinor: subtotalMinor,
        imageUrl: '',
        qty: 1,
      },
    ],
  })
}

/** Every node in the order summary carrying this test id. */
const inSummary = (el: HTMLElement, id: string): Element[] =>
  deepAll(byTestId(el, 'checkout-summary'), `[data-testid="${id}"]`)

/** The text of each summary row a test id sits in: its label and its amount. */
const rowsOf = (el: HTMLElement, id: string): string[] =>
  inSummary(el, id).map((node) => {
    const row = node.closest("[part~='summary-row']") ?? node.parentElement ?? node
    return row.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })

/** The one summary row a test id sits in. */
function rowText(el: HTMLElement, id: string): string {
  const rows = rowsOf(el, id)
  expect(rows, `${id} in the summary`).toHaveLength(1)
  return rows[0]!
}

function totalText(el: HTMLElement): string {
  const part = deepAll(byTestId(el, 'checkout-summary'), "[part~='total']")[0]
  expect(part, "the summary's total part").toBeDefined()
  return part!.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

interface ShownOption {
  id: string
  input: HTMLInputElement
  label: string
}

/** The delivery choice's radios: the option id each is for, the radio, and the text it is labelled with. */
function radios(el: HTMLElement): ShownOption[] {
  const prefix = 'checkout-shipping-option-'
  return deepAll(rootOf(el), `[data-testid^="${prefix}"]`).map((node) => {
    const input = (
      node instanceof HTMLInputElement ? node : node.querySelector('input[type="radio"]')
    ) as HTMLInputElement
    const labelled =
      node instanceof HTMLInputElement ? (node.closest('label') ?? node.parentElement) : node
    return {
      id: node.getAttribute('data-testid')!.slice(prefix.length),
      input,
      label: labelled?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    }
  })
}

const checkedIds = (el: HTMLElement): string[] =>
  radios(el)
    .filter((o) => o.input?.checked)
    .map((o) => o.id)

/** Contact, then the shipping address submitted once, a frame after each step shows; no wait for the quote. */
async function submitShipping(r: Rig, s: Shopper = SHOPPER): Promise<void> {
  await afterFrame(r.el)
  type(byTestId<HTMLInputElement>(r.el, 'contact-email'), s.email)
  rapid(r.el, 'contact-continue', 1)
  await afterFrame(r.el)
  fillAddress(r.el, 'shipping', s.shipping)
  rapid(r.el, 'shipping-continue', 1)
  await settle(r.el)
}

/** Chooses the option `id` on the payment step. */
async function choose(r: Rig, id: string): Promise<void> {
  const option = radios(r.el).find((o) => o.id === id)
  expect(option, `a radio for ${id}`).toBeDefined()
  option!.input.click()
  await settle(r.el)
}

const amountLabel = (amountMinor: number, currency: string): string =>
  amountMinor === 0 ? 'Free' : formatPrice(amountMinor, currency)

const arbPriced = fc.record({
  subtotalMinor: fc.integer({ min: 100, max: 500_000 }),
  discountShare: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 50 })),
  taxMinor: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 90_000 })),
  inclusive: fc.boolean(),
  currency: fc.constantFrom('GBP', 'EUR', 'USD'),
})

const pricedOf = (p: {
  subtotalMinor: number
  discountShare: number
  taxMinor: number
  inclusive: boolean
  currency: string
}): Priced => ({
  subtotalMinor: p.subtotalMinor,
  discountMinor: Math.floor((p.subtotalMinor * p.discountShare) / 100),
  taxMinor: p.taxMinor,
  inclusive: p.inclusive,
  currency: p.currency,
})

describe('AC-15: the payment step shows the quote', () => {
  // Kills: a summary that prints "Standard, free" and the subtotal as the total before anything is known, or a step
  // that moves to payment before the quote answers (or without asking for one).
  it('AC-15: before a quote the summary says shipping is calculated at the next step, with the subtotal as the total; a shipping submit makes one quote request for the address typed and moves to payment when it answers', async () => {
    const r = await rig()
    cartOf(r, 2_350)
    const held = heldQuote((ask) =>
      quoteOf(ask.shippingOptionId ?? 'express', { subtotalMinor: 2_350 }),
    )
    r.answerQuote(held.respond)

    await afterFrame(r.el)
    type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
    rapid(r.el, 'contact-continue', 1)
    await afterFrame(r.el)
    expect(byTestId(r.el, 'checkout-summary').textContent).toContain('calculated at the next step')
    expect(totalText(r.el)).toContain(formatPrice(2_350, 'GBP'))
    fillAddress(r.el, 'shipping', SHOPPER.shipping)
    rapid(r.el, 'shipping-continue', 1)
    await settle(r.el)

    expect(r.quotes.map((q) => q.shippingAddress)).toEqual([SHOPPER.shipping])
    expect(byTestId(r.el, 'checkout-payment').hidden, 'payment waits for the quote').toBe(true)

    held.release()
    await untilStep(r.el, 'payment')
    expect(r.quotes).toHaveLength(1)
    expect(totalText(r.el)).toContain(formatPrice(2_350 + 499, 'GBP'))
  })

  // Kills: a delivery choice that is not the quote's (a missing option, a price shown as 0 that is charged, the
  // wrong one checked), or a summary row the order will not carry (a tax row at 0, tax labelled as added on top when
  // it is included), or amounts in the store's currency rather than the quote's.
  it('AC-15: property: for generated quotes, one radio per option labelled with its name and price ("Free" at 0) with the quote’s option checked, and the summary’s subtotal, discount (only above 0), shipping, tax (only above 0, "Tax (included)" by the flag) and total are the quote’s, in its currency', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbPriced,
        fc.constantFrom(...OPTIONS.map((o) => o.id)),
        async (p, chosen) => {
          document.body.innerHTML = ''
          const r = await rig()
          const priced = pricedOf(p)
          const q = quoteOf(chosen, priced)
          r.answerQuote(() => Promise.resolve(q))
          await walkToPayment(r, SHOPPER)

          const shown = radios(r.el)
          expect(shown.map((o) => o.id)).toEqual(OPTIONS.map((o) => o.id))
          for (const option of OPTIONS) {
            const label = shown.find((o) => o.id === option.id)!.label
            expect(label, option.id).toContain(option.name)
            expect(label, option.id).toContain(amountLabel(option.amountMinor, q.currency))
          }
          expect(checkedIds(r.el)).toEqual([chosen])

          const t = q.totals
          const option = OPTIONS.find((o) => o.id === chosen)!
          expect(rowText(r.el, 'cart-subtotal')).toContain(formatPrice(t.subtotalMinor, q.currency))
          const discount = formatPrice(t.discountTotalMinor, q.currency)
          expect(
            rowsOf(r.el, 'checkout-summary-discount').map((row) => row.includes(discount)),
          ).toEqual(t.discountTotalMinor > 0 ? [true] : [])
          const shipping = rowText(r.el, 'checkout-summary-shipping')
          expect(shipping).toContain(option.name)
          expect(shipping).toContain(amountLabel(option.amountMinor, q.currency))
          const taxRows = rowsOf(r.el, 'checkout-summary-tax')
          const tax = formatPrice(t.taxTotalMinor, q.currency)
          expect(taxRows.map((row) => row.includes(tax))).toEqual(t.taxTotalMinor > 0 ? [true] : [])
          expect(
            taxRows.map((row) => /\bTax\b/.test(row) && row.includes('Tax (included)')),
          ).toEqual(t.taxTotalMinor > 0 ? [t.pricesIncludeTax] : [])
          expect(totalText(r.el)).toContain(formatPrice(t.totalMinor, q.currency))
        },
      ),
      { numRuns: 15 },
    )
  }, 90_000)
})

describe('AC-16: what is shown is what is sent', () => {
  /** Option changes from the first quote's option, never the same one twice running. */
  const arbChanges = fc
    .array(fc.constantFrom(...OPTIONS.map((o) => o.id)), { minLength: 1, maxLength: 4 })
    .map((ids) =>
      ids.reduce<string[]>(
        (out, id) => (id === (out.at(-1) ?? 'standard') ? out : [...out, id]),
        [],
      ),
    )
    .filter((changes) => changes.length > 0)

  // Kills: a summary that shows one option's total while Place Order acknowledges another (a late answer kept, the
  // radio's value sent with the old total), or a press while the total is still moving.
  it('AC-16: property: after each option change settles the total part reads the checked option’s quote total, Place Order is disabled while a change is in flight, and one press submits that option and that total as expectedTotalMinor', async () => {
    await fc.assert(
      fc.asyncProperty(arbPriced, arbChanges, async (p, changes) => {
        document.body.innerHTML = ''
        const r = await rig()
        const priced = pricedOf(p)
        await walkToPayment(r, SHOPPER)
        await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
        r.answerQuote((ask) => Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard', priced)))
        const placeOrder = () => byTestId<HTMLButtonElement>(r.el, 'place-order')

        for (const [i, id] of changes.entries()) {
          const want = quoteOf(id, priced)
          const held = heldQuote(() => want)
          r.answerQuote(held.respond)
          await choose(r, id)
          expect(placeOrder().disabled, `change ${i} in flight`).toBe(true)
          held.release()
          await vi.waitFor(() =>
            expect(totalText(r.el), `change ${i} to ${id}`).toContain(
              formatPrice(want.totals.totalMinor, want.currency),
            ),
          )
          expect(checkedIds(r.el)).toEqual([id])
        }

        const last = quoteOf(changes.at(-1)!, priced)
        await afterFrame(r.el)
        expect(placeOrder().disabled).toBe(false)
        click(placeOrder(), 1)
        await vi.waitFor(() => expect(r.creates()).toBe(1))
        expect([r.created[0]!['shippingOptionId'], r.created[0]!['expectedTotalMinor']]).toEqual([
          last.shippingOptionId,
          last.totals.totalMinor,
        ])
      }),
      { numRuns: 12 },
    )
  }, 90_000)

  // Kills: a summary left on a quote for a cart the shopper has since changed (a cart drawer on the payment step), so
  // Place Order sends a total the server refuses; or a later mount on the same client showing a quote it never asked for.
  it('AC-16: when the cart changes on the payment step the summary and the total sent are the new cart’s quote, and a later checkout on the same client shows shipping as calculated at the next step until it quotes', async () => {
    const r = await rig()
    cartOf(r, 1_800)
    await walkToPayment(r, SHOPPER)
    expect(totalText(r.el)).toContain(formatPrice(1_800, 'GBP'))
    r.answerQuote((ask) =>
      Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard', { subtotalMinor: 3_600 })),
    )

    const cart = r.client['cart'] as { getState(): { items: unknown[] }; setState(p: object): void }
    const [line] = cart.getState().items as Array<Record<string, unknown>>
    cart.setState({ subtotalMinor: 3_600, itemCount: 2, items: [{ ...line, qty: 2 }] })
    await vi.waitFor(() => expect(totalText(r.el)).toContain(formatPrice(3_600, 'GBP')))

    expect(r.quotes).toHaveLength(2)
    expect(rowText(r.el, 'cart-subtotal')).toContain(formatPrice(3_600, 'GBP'))
    expect(r.store.getState().quote?.totals.totalMinor).toBe(3_600)
    await afterFrame(r.el)
    expect(byTestId<HTMLButtonElement>(r.el, 'place-order').disabled).toBe(false)

    r.el.remove()
    const again = document.createElement(CHECKOUT)
    document.body.append(again)
    await settle(again)
    expect(r.store.getState().quote, 'the store still holds the last mount’s quote').not.toBeNull()
    expect(byTestId(again, 'checkout-summary').textContent).toContain('calculated at the next step')
    expect(inSummary(again, 'checkout-summary-shipping')).toEqual([])
    expect(totalText(again)).toContain(formatPrice(3_600, 'GBP'))
    expect(radios(again)).toEqual([])
  })
})

describe('AC-17: every quote refusal has one answer', () => {
  const STAYS: Array<[string, () => Error, string]> = [
    [
      '422 checkout.no_shipping',
      () => new NymbalApiError('checkout.no_shipping', 'No option ships there', 422),
      NO_SHIPPING,
    ],
    [
      '503 checkout.tax_unavailable',
      () => new NymbalApiError('checkout.tax_unavailable', 'The tax engine is down', 503),
      TOTAL_UNAVAILABLE,
    ],
    [
      '503 checkout.promotions_unavailable',
      () => new NymbalApiError('checkout.promotions_unavailable', 'The engine is down', 503),
      TOTAL_UNAVAILABLE,
    ],
    [
      'a 429',
      () => new NymbalApiError('rate_limit.exceeded', 'Too many requests', 429),
      TOTAL_UNAVAILABLE,
    ],
    ['a 503', () => new NymbalApiError('internal', 'Service unavailable', 503), TOTAL_UNAVAILABLE],
    [
      'any other refusal',
      () => new NymbalApiError('checkout.variant_missing', 'Variant missing: v-1', 422),
      TOTAL_UNAVAILABLE,
    ],
    ['a rejected fetch', () => new TypeError('Failed to fetch'), TOTAL_UNAVAILABLE],
  ]

  // Kills: a shopper who cannot be delivered to reaching payment, an outage shown as the server's raw message, or a
  // shipping step that never asks again.
  it.each(STAYS)(
    'AC-17: %s shows its message in checkout-error, stays on the shipping step, and the next submit quotes again',
    async (_what, refusal, message) => {
      const r = await rig()
      r.answerQuote(() => Promise.reject(refusal()))

      await submitShipping(r)
      await vi.waitFor(() => expect(errorText(r.el)).toBe(message))

      expect(byTestId(r.el, 'checkout-shipping').hidden).toBe(false)
      expect(byTestId(r.el, 'checkout-payment').hidden).toBe(true)
      expect(r.quotes).toHaveLength(1)

      r.answerQuote((ask) => Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard')))
      await nextFrame()
      click(byTestId(r.el, 'shipping-continue'), 1)
      await untilStep(r.el, 'payment')
      expect(r.quotes).toHaveLength(2)
      expect(errorText(r.el)).toBe('')
    },
  )

  it('AC-17: auth.token_invalid on the quote shows the session-expired message and the checkout-sign-in link, and stays on the shipping step', async () => {
    const r = await rig()
    r.answerQuote(() =>
      Promise.reject(
        new NymbalApiError('auth.token_invalid', 'the access token is not valid', 401),
      ),
    )

    await submitShipping(r)
    await vi.waitFor(() => expect(errorText(r.el)).toBe(EXPIRED))

    expect(
      deepAll(rootOf(r.el), '[data-testid="checkout-sign-in"]').map((a) => a.getAttribute('href')),
    ).toEqual(['/account/login?redirect=%2Fcheckout'])
    expect(byTestId(r.el, 'checkout-shipping').hidden).toBe(false)
    expect(byTestId(r.el, 'checkout-payment').hidden).toBe(true)
  })

  // Kills: a shopper whose earlier choice is no longer offered stranded on the shipping step.
  it('AC-17: checkout.shipping_option_unavailable quotes once more with no option and moves on with that answer', async () => {
    const r = await rig()
    await walkToPayment(r, SHOPPER)
    await choose(r, 'express')
    await vi.waitFor(() => expect(checkedIds(r.el)).toEqual(['express']))
    const back = byTestId(r.el, 'checkout-payment').querySelector<HTMLElement>("[part~='back']")
    expect(back, "the payment step's back button").not.toBeNull()
    await nextFrame()
    click(back!, 1)
    await untilStep(r.el, 'shipping')
    let asked = 0
    r.answerQuote((ask) => {
      asked += 1
      return asked === 1
        ? Promise.reject(
            new NymbalApiError('checkout.shipping_option_unavailable', 'Not offered', 409, {
              options: [OPTIONS[0], OPTIONS[2]],
            }),
          )
        : Promise.resolve(
            quoteOf(ask.shippingOptionId ?? 'standard', { options: [OPTIONS[0]!, OPTIONS[2]!] }),
          )
    })
    const before = r.quotes.length

    await nextFrame()
    click(byTestId(r.el, 'shipping-continue'), 1)
    await untilStep(r.el, 'payment')

    expect(r.quotes.slice(before).map((q) => q.shippingOptionId)).toEqual(['express', undefined])
    expect(checkedIds(r.el)).toEqual(['standard'])
    expect(radios(r.el).map((o) => o.id)).toEqual(['standard', 'collect'])
  })

  // Kills: a changed total that leaves the old summary on screen, or is taken for an order.
  it('AC-17: a Place Order refused checkout.total_changed shows the new quote’s summary and the total-changed message, fires no nymbal:checkout:placed, and enables Place Order', async () => {
    const r = await rig()
    await walkToPayment(r, SHOPPER)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    expect(totalText(r.el)).toContain(formatPrice(1_800, 'GBP'))
    r.answerCreate(() =>
      Promise.reject(
        new NymbalApiError('checkout.total_changed', 'The total has changed', 409, {
          quoted: 1_800,
          due: 2_299,
        }),
      ),
    )
    r.answerQuote((ask) =>
      Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard', { subtotalMinor: 2_299 })),
    )

    await nextFrame()
    click(byTestId<HTMLButtonElement>(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(errorText(r.el)).toBe(TOTAL_CHANGED))
    await afterFrame(r.el)

    expect(totalText(r.el)).toContain(formatPrice(2_299, 'GBP'))
    expect(totalText(r.el)).not.toContain(formatPrice(1_800, 'GBP'))
    expect(calls(r.log, 'placed')).toEqual([])
    expect(byTestId<HTMLButtonElement>(r.el, 'place-order').disabled).toBe(false)
  })

  // Kills: an option change whose quote fails leaving no delivery choice, no total and no message, so Place Order
  // refuses for a reason the shopper cannot see.
  it.each([
    ['a rejected fetch', () => new TypeError('Failed to fetch')],
    ['a 429', () => new NymbalApiError('rate_limit.exceeded', 'Too many requests', 429)],
    [
      '503 checkout.tax_unavailable',
      () => new NymbalApiError('checkout.tax_unavailable', 'The tax engine is down', 503),
    ],
  ])(
    'AC-17: %s on an option change shows its message in checkout-error and keeps the last quote, its option checked, and Place Order sends that option and total',
    async (_what, refusal) => {
      const r = await rig()
      await walkToPayment(r, SHOPPER)
      await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
      const kept = quoteOf('standard')
      r.answerQuote(() => Promise.reject(refusal()))

      await choose(r, 'express')
      await vi.waitFor(() => expect(errorText(r.el)).toBe(TOTAL_UNAVAILABLE))
      await afterFrame(r.el)

      expect(radios(r.el).map((o) => o.id)).toEqual(OPTIONS.map((o) => o.id))
      expect(checkedIds(r.el)).toEqual(['standard'])
      expect(rowText(r.el, 'checkout-summary-shipping')).toContain('Standard')
      expect(totalText(r.el)).toContain(formatPrice(kept.totals.totalMinor, 'GBP'))
      click(byTestId<HTMLButtonElement>(r.el, 'place-order'), 1)
      await vi.waitFor(() => expect(r.creates()).toBe(1))
      expect([r.created[0]!['shippingOptionId'], r.created[0]!['expectedTotalMinor']]).toEqual([
        'standard',
        kept.totals.totalMinor,
      ])
    },
  )
})

describe('AC-18: double submits', () => {
  // Kills: a double click that quotes twice (and lets the late answer win), or that places two checkouts.
  it('AC-18: property: k rapid shipping submits make one quote request, and k rapid Place Order presses make one submitPayment', async () => {
    await fc.assert(
      fc.asyncProperty(k, k, async (kShipping, kPlace) => {
        document.body.innerHTML = ''
        const r = await rig()
        r.answerCreate(() => Promise.resolve(result('NYM-AC18', 'succeeded')))
        const held = heldQuote()
        r.answerQuote(held.respond)

        await afterFrame(r.el)
        type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
        rapid(r.el, 'contact-continue', 1)
        await afterFrame(r.el)
        fillAddress(r.el, 'shipping', SHOPPER.shipping)
        rapid(r.el, 'shipping-continue', kShipping)
        await settle(r.el)
        expect(r.quotes, `${kShipping} shipping submits`).toHaveLength(1)
        held.release()
        await untilStep(r.el, 'payment')
        expect(r.quotes).toHaveLength(1)

        await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
        await nextFrame()
        rapid(r.el, 'place-order', kPlace)
        await vi.waitFor(() => expect(calls(r.log, 'placed')).toHaveLength(1))
        expect(calls(r.log, 'submitPayment'), `${kPlace} presses`).toHaveLength(1)
        expect(r.creates()).toBe(1)
      }),
      { numRuns: 12 },
    )
  }, 90_000)

  it('AC-18: property: after a total_changed refusal, k rapid presses make one more submitPayment', async () => {
    await fc.assert(
      fc.asyncProperty(k, async (kPlace) => {
        document.body.innerHTML = ''
        const r = await rig()
        await walkToPayment(r, SHOPPER)
        await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
        r.answerCreate(() =>
          Promise.reject(
            new NymbalApiError('checkout.total_changed', 'The total has changed', 409, {
              quoted: 1_800,
              due: 1_900,
            }),
          ),
        )
        r.answerQuote(() => Promise.resolve(quoteOf('standard', { subtotalMinor: 1_900 })))
        await nextFrame()
        click(byTestId(r.el, 'place-order'), 1)
        await vi.waitFor(() => expect(errorText(r.el)).toBe(TOTAL_CHANGED))
        const submitted = calls(r.log, 'submitPayment').length

        r.answerCreate(() => Promise.resolve(result('NYM-AC18-2', 'succeeded')))
        await afterFrame(r.el)
        rapid(r.el, 'place-order', kPlace)
        await vi.waitFor(() => expect(calls(r.log, 'placed')).toHaveLength(1))
        expect(calls(r.log, 'submitPayment').length - submitted, `${kPlace} presses`).toBe(1)
        expect(r.created.at(-1)!['expectedTotalMinor']).toBe(1_900)
      }),
      { numRuns: 8 },
    )
  }, 90_000)
})

describe('AC-26: Back after an order', () => {
  // Kills: the shipping step stranding the shopper on a refusal it never asks the server to resolve, so Back then
  // Place Order no longer lands on the order the cart became.
  it('AC-26: a placed guest checkout, then Back and contact and shipping again: the quote is refused cart_empty naming the order, the step moves to payment with no quote, and one Place Order posts one checkout with no total whose keyed refusal fires nymbal:checkout:placed with the order and its key', async () => {
    const details: unknown[] = []
    const onPlaced = (event: Event) => details.push((event as CustomEvent).detail)
    document.addEventListener('nymbal:checkout:placed', onPlaced)
    listeners.push(() => document.removeEventListener('nymbal:checkout:placed', onPlaced))
    const orderNumber = 'NYM-2601'
    const firstKey = 'A'.repeat(43)
    const laterKey = 'B'.repeat(43)

    const r = await rig()
    r.answerCreate(() =>
      Promise.resolve({ ...result(orderNumber, 'succeeded'), orderKey: firstKey }),
    )
    await walkToPayment(r, SHOPPER)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    await nextFrame()
    click(byTestId(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(details).toHaveLength(1))

    // Back: the checkout page again, over the same SDK, with the cart now the order on the server.
    r.answerQuote(() =>
      Promise.reject(
        new NymbalApiError(
          'checkout.cart_empty',
          `This cart is already order ${orderNumber}`,
          409,
          {
            orderNumber,
          },
        ),
      ),
    )
    r.answerCreate(() =>
      Promise.reject(
        new NymbalApiError(
          'checkout.cart_empty',
          `This cart is already order ${orderNumber}`,
          409,
          {
            orderNumber,
            orderKey: laterKey,
          },
        ),
      ),
    )
    r.el.remove()
    const again = document.createElement(CHECKOUT)
    again.append(r.pay)
    document.body.append(again)
    await settle(again)
    const back: Rig = { ...r, el: again }
    const quotesBefore = r.quotes.length
    const createdBefore = r.created.length

    await walkToPayment(back, SHOPPER)

    expect(r.quotes.length - quotesBefore).toBe(1)
    expect(byTestId(again, 'checkout-summary').textContent).toContain('calculated at the next step')
    const placeOrder = byTestId<HTMLButtonElement>(again, 'place-order')
    expect(placeOrder.disabled).toBe(false)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    await nextFrame()
    click(placeOrder, 1)
    await vi.waitFor(() => expect(details).toHaveLength(2))

    expect(r.created.slice(createdBefore).map((c) => c['expectedTotalMinor'])).toEqual([undefined])
    expect(details[1]).toStrictEqual({ orderNumber, orderKey: laterKey })
  })
})

// ─── Discount codes in the checkout summary ─────────────────────────────────

interface CartDouble {
  setState(partial: Record<string, unknown>): void
  addCode?: (code: string) => Promise<void>
  removeCode?: (code: string) => Promise<void>
}

/** A cart of one line at `subtotalMinor` with its codes and the totals the API gave for them, as the store holds it. */
function codedCart(
  r: Rig,
  p: { subtotalMinor: number; discountMinor: number; codes: Array<{ code: string; status: string }> },
): void {
  const cart = r.client['cart'] as CartDouble
  cart.setState({
    currency: 'GBP',
    subtotalMinor: p.subtotalMinor,
    itemCount: 1,
    items: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Lamp',
        variantName: '',
        priceMinor: p.subtotalMinor,
        imageUrl: '',
        qty: 1,
      },
    ],
    loading: false,
    error: null,
    errorCode: null,
    totals: {
      currency: 'GBP',
      subtotalMinor: p.subtotalMinor,
      discountTotalMinor: p.discountMinor,
      shippingTotalMinor: 0,
      shippingDiscountMinor: 0,
      taxTotalMinor: 0,
      totalMinor: p.subtotalMinor - p.discountMinor,
      pricesIncludeTax: false,
      lines: [],
      applied: [],
    },
    promotions: { codes: p.codes, unavailable: false },
  })
}

const noSpace = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, '')
const summaryDiscounts = (el: HTMLElement): string[] =>
  inSummary(el, 'checkout-summary-discount').map((n) => noSpace(n.textContent))
const summaryTotal = (el: HTMLElement): string => {
  const totals = inSummary(el, 'checkout-summary-total')
  expect(totals, 'checkout-summary-total in the summary').toHaveLength(1)
  return noSpace(totals[0]!.textContent)
}

/** Whether Apply and each Remove of the summary's code block are disabled. */
function codeControls(el: HTMLElement): { apply: boolean[]; removes: boolean[] } {
  return {
    apply: inSummary(el, 'discount-code-apply').map((b) => (b as HTMLButtonElement).disabled),
    removes: inSummary(el, 'discount-code-remove').map((b) => (b as HTMLButtonElement).disabled),
  }
}

describe('AC-16: the checkout summary shows a cart’s discount at every step', () => {
  // Kills: the undiscounted total shown before the address (the summary reading the subtotal), a quote's own discount
  // replaced by the cart's after it answers, or a code block missing from a step.
  it('AC-16: property: before a quote the summary shows "−<cart discountTotalMinor>" and checkout-summary-total = the cart’s totalMinor; after the quote, the quote’s discount and total; the code block is in the summary on the contact, shipping and payment steps', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1_000, max: 200_000 }),
        fc.integer({ min: 1, max: 50 }),
        async (subtotalMinor, share) => {
          document.body.innerHTML = ''
          const r = await rig()
          const discount = Math.floor((subtotalMinor * share) / 100)
          codedCart(r, {
            subtotalMinor,
            discountMinor: discount,
            codes: [{ code: 'SAVE10', status: 'accepted' }],
          })
          await settle(r.el)
          const blocks: number[] = [inSummary(r.el, 'discount-code-input').length]

          expect(summaryDiscounts(r.el), 'before a quote').toEqual([
            expect.stringContaining(`−${formatPrice(discount, 'GBP')}`),
          ])
          expect(summaryTotal(r.el), 'before a quote').toContain(
            formatPrice(subtotalMinor - discount, 'GBP'),
          )

          // The quote evaluates the codes again: its discount, not the cart's, is the one it charges.
          const quoted = quoteOf('standard', { subtotalMinor, discountMinor: discount + 1 })
          r.answerQuote(() => Promise.resolve(quoted))
          await afterFrame(r.el)
          type(byTestId<HTMLInputElement>(r.el, 'contact-email'), SHOPPER.email)
          rapid(r.el, 'contact-continue', 1)
          await afterFrame(r.el)
          blocks.push(inSummary(r.el, 'discount-code-input').length)
          fillAddress(r.el, 'shipping', SHOPPER.shipping)
          rapid(r.el, 'shipping-continue', 1)
          await untilStep(r.el, 'payment')
          await settle(r.el)
          blocks.push(inSummary(r.el, 'discount-code-input').length)

          expect(blocks, 'the code block on contact, shipping and payment').toEqual([1, 1, 1])
          expect(summaryDiscounts(r.el), 'after the quote').toEqual([
            expect.stringContaining(`−${formatPrice(quoted.totals.discountTotalMinor, 'GBP')}`),
          ])
          expect(summaryTotal(r.el), 'after the quote').toContain(
            formatPrice(quoted.totals.totalMinor, 'GBP'),
          )
        },
      ),
      { numRuns: 5 },
    )
  }, 60_000)

  // Kills: a code added or removed while the order is being placed, or after it was.
  it('AC-16: Apply and every Remove of the code block are enabled on the payment step, disabled while Place Order is in flight, and stay disabled once the order is placed', async () => {
    const r = await rig()
    codedCart(r, {
      subtotalMinor: 1_800,
      discountMinor: 180,
      codes: [{ code: 'SAVE10', status: 'accepted' }],
    })
    r.answerQuote((ask) =>
      Promise.resolve(
        quoteOf(ask.shippingOptionId ?? 'standard', { subtotalMinor: 1_800, discountMinor: 180 }),
      ),
    )
    await walkToPayment(r, SHOPPER)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    let release: () => void = () => undefined
    r.answerCreate(
      () =>
        new Promise((resolve) => {
          release = () => resolve(result('NYM-CODES-PLACED', 'succeeded'))
        }),
    )
    const before = codeControls(r.el)

    click(byTestId(r.el, 'place-order'), 1)
    await vi.waitFor(() => expect(r.creates()).toBe(1))
    await settle(r.el)
    const placing = codeControls(r.el)
    release()
    await vi.waitFor(() => expect(names(r.log)).toContain('placed'))
    await settle(r.el)
    const placed = codeControls(r.el)

    expect({ before, placing, placed }).toEqual({
      before: { apply: [false], removes: [false] },
      placing: { apply: [true], removes: [true] },
      placed: { apply: [true], removes: [true] },
    })
  })
})

describe('AC-17: a code changed on the payment step quotes again', () => {
  // Kills: a cart key that ignores codes, so Place Order sends the old quote's total and the shopper meets
  // total_changed after pressing it.
  it('AC-17: a code applied, then removed, through the summary’s code block on the payment step each quotes again with Place Order disabled until the new quote answers; the summary shows each new quote and one press sends the last quote’s total', async () => {
    const r = await rig()
    codedCart(r, { subtotalMinor: 2_000, discountMinor: 0, codes: [] })
    r.answerQuote((ask) =>
      Promise.resolve(quoteOf(ask.shippingOptionId ?? 'standard', { subtotalMinor: 2_000 })),
    )
    await walkToPayment(r, SHOPPER)
    await vi.waitFor(() => expect(r.pay.status).toBe('ready'))
    expect(r.quotes).toHaveLength(1)
    const cart = r.client['cart'] as CartDouble
    cart.addCode = async (code) =>
      codedCart(r, { subtotalMinor: 2_000, discountMinor: 200, codes: [{ code, status: 'accepted' }] })
    cart.removeCode = async () => codedCart(r, { subtotalMinor: 2_000, discountMinor: 0, codes: [] })
    const placeOrder = () => byTestId<HTMLButtonElement>(r.el, 'place-order')

    const discounted = quoteOf('standard', { subtotalMinor: 2_000, discountMinor: 200 })
    const added = heldQuote(() => discounted)
    r.answerQuote(added.respond)
    type(byTestId<HTMLInputElement>(r.el, 'discount-code-input'), 'SAVE10')
    byTestId<HTMLButtonElement>(r.el, 'discount-code-apply').click()
    await vi.waitFor(() => expect(r.quotes).toHaveLength(2))
    await settle(r.el)
    expect(placeOrder().disabled, 'the add’s quote in flight').toBe(true)
    added.release()
    await vi.waitFor(() =>
      expect(summaryTotal(r.el)).toContain(formatPrice(discounted.totals.totalMinor, 'GBP')),
    )
    expect(summaryDiscounts(r.el)).toEqual([expect.stringContaining(`−${formatPrice(200, 'GBP')}`)])

    const full = quoteOf('standard', { subtotalMinor: 2_000, discountMinor: 0 })
    const removed = heldQuote(() => full)
    r.answerQuote(removed.respond)
    byTestId<HTMLButtonElement>(r.el, 'discount-code-remove').click()
    await vi.waitFor(() => expect(r.quotes).toHaveLength(3))
    await settle(r.el)
    expect(placeOrder().disabled, 'the remove’s quote in flight').toBe(true)
    removed.release()
    await vi.waitFor(() =>
      expect(summaryTotal(r.el)).toContain(formatPrice(full.totals.totalMinor, 'GBP')),
    )
    expect(summaryDiscounts(r.el)).toEqual([])

    await afterFrame(r.el)
    expect(placeOrder().disabled).toBe(false)
    click(placeOrder(), 1)
    await vi.waitFor(() => expect(r.creates()).toBe(1))
    expect(r.created[0]!['expectedTotalMinor']).toBe(full.totals.totalMinor)
  })
})
