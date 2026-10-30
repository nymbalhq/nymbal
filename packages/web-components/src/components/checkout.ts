import '@nymbalhq/sdk/ns/cart'
import '@nymbalhq/sdk/ns/checkout'
import { css, html, nothing } from 'lit'
import type { PaymentConfirmation, PaymentConfirmContext } from '@nymbalhq/sdk'
import type { Address, CartItem } from '@nymbalhq/types'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { renderField } from '../form-element.js'
import { formatPrice } from '../format.js'
import { shownCart } from '../cart-projection.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'
import { NymbalAddressForm } from './address-form.js'
import type { NymbalPaymentElement } from './payment-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-checkout',
  reactName: 'Checkout',
  // The cart a server read (cart-projection.ts), shown in the summary until the cart store settles.
  attributes: [{ name: 'cart', prop: 'cart', type: 'json' }],
  events: [
    {
      name: 'nymbal:checkout:placed',
      prop: 'onPlaced',
      detail: '{ orderNumber: string; orderKey?: string }',
    },
  ],
  parts: [
    'layout',
    'main',
    'title',
    'steps',
    'step',
    'step-active',
    'step-done',
    'step-divider',
    'step-divider-done',
    'error',
    'section',
    'form',
    'section-title',
    'field',
    'label',
    'input',
    'billing-same',
    'billing',
    'billing-title',
    'payment',
    'actions',
    'back',
    'submit',
    'terms',
    'summary',
    'summary-title',
    'items',
    'item',
    'item-name',
    'item-variant',
    'item-qty',
    'item-price',
    'summary-row',
    'subtotal',
    'total',
  ],
  slots: [
    'payment',
    'title',
    'contact-continue-label',
    'shipping-continue-label',
    'place-order-label',
    'terms',
    'summary-title',
  ],
  children: true,
}

const STEPS = ['contact', 'shipping', 'payment'] as const
type Step = (typeof STEPS)[number]
const STEP_LABELS: Record<Step, string> = {
  contact: 'Contact',
  shipping: 'Shipping',
  payment: 'Payment',
}

/** Outlasts the 500 ms an OS allows between the two clicks of a double click. */
const STEP_HEIGHT_HOLD_MS = 600
const PAYMENT_FAILED = 'Payment failed. Please try again.'

/** No payment element: nothing to confirm, as for a payments adapter with no client half. */
const NO_PAYMENT_STEP: PaymentConfirmation = { ok: true, confirmed: false }

/**
 * The checkout: contact, shipping, then payment with billing, beside the order summary. It drives the SDK's checkout
 * store, and on an order dispatches `nymbal:checkout:placed`; the page navigates. The payment element is the page's
 * light-DOM child in the `payment` slot, so the payment driver's UI shares the document tree and is mounted once.
 */
export class NymbalCheckout extends NymbalElement {
  static override schema = SCHEMA
  static uses = [NymbalAddressForm]
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      [hidden] {
        display: none !important;
      }
      [part~='layout'] {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--nymbal-spacing-xl, 2rem);
      }
      @media (min-width: 769px) {
        [part~='layout'] {
          grid-template-columns: 1fr 380px;
          align-items: start;
        }
      }
      [part~='title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        font-size: 1.75rem;
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='steps'] {
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: var(--nymbal-spacing-xl, 2rem);
        padding: var(--nymbal-spacing-md, 1rem) 0;
        counter-reset: step;
      }
      [part~='step'] {
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-muted, #71717a);
        white-space: nowrap;
      }
      [part~='step']::before {
        counter-increment: step;
        content: counter(step);
        display: flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        flex-shrink: 0;
        border: 2px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-full, 9999px);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='step-active'] {
        color: var(--nymbal-color-primary, #18181b);
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='step-active']::before {
        background-color: var(--nymbal-color-primary, #18181b);
        border-color: var(--nymbal-color-primary, #18181b);
        color: var(--nymbal-color-text-inverse, #fff);
      }
      [part~='step-done']::before {
        content: '\\2713';
        background-color: var(--nymbal-color-success, #16a34a);
        border-color: var(--nymbal-color-success, #16a34a);
        color: var(--nymbal-color-text-inverse, #fff);
      }
      [part~='step-divider'] {
        width: 40px;
        height: 2px;
        flex-shrink: 0;
        margin: 0 var(--nymbal-spacing-sm, 0.5rem);
        background-color: var(--nymbal-color-border, #e4e4e7);
      }
      [part~='step-divider-done'] {
        background-color: var(--nymbal-color-success, #16a34a);
      }
      @media (max-width: 640px) {
        [part~='step'] span {
          display: none;
        }
        [part~='step-divider'] {
          width: 24px;
        }
      }
      [part~='section-title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        color: var(--nymbal-color-primary, #18181b);
      }
      [part~='billing-same'] {
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        margin-bottom: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        cursor: pointer;
      }
      [part~='billing-title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-base, 1rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='payment'] {
        margin-top: var(--nymbal-spacing-md, 1rem);
      }
      [part~='actions'] {
        display: flex;
        justify-content: space-between;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        margin-top: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='submit'] {
        flex: 1;
        padding: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-base, 1rem);
      }
      [part~='terms'] {
        margin: var(--nymbal-spacing-sm, 0.5rem) 0 0;
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-muted, #71717a);
        text-align: center;
      }
      [part~='summary'] {
        position: sticky;
        top: 80px;
        padding: var(--nymbal-spacing-lg, 1.5rem);
        background-color: #fafafa;
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
      }
      [part~='summary-title'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        padding-bottom: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        color: var(--nymbal-color-primary, #18181b);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='items'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        margin-bottom: var(--nymbal-spacing-md, 1rem);
      }
      [part~='item'] {
        display: flex;
        justify-content: space-between;
        align-items: start;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
      [part~='item-name'] {
        flex: 1;
        min-width: 0;
      }
      [part~='item-variant'],
      [part~='item-qty'] {
        flex-shrink: 0;
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='item-price'] {
        flex-shrink: 0;
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      dl {
        margin: 0;
      }
      dd {
        margin: 0;
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='summary-row'] {
        display: flex;
        justify-content: space-between;
        padding: var(--nymbal-spacing-xs, 0.25rem) 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
      [part~='summary-row'] dt {
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='total'] {
        display: flex;
        justify-content: space-between;
        margin-top: var(--nymbal-spacing-sm, 0.5rem);
        padding-top: var(--nymbal-spacing-md, 1rem);
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        color: var(--nymbal-color-primary, #18181b);
        border-top: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
    `,
  ]

  private step: Step = 'contact'
  private error: string | null = null
  private billingSame = true
  private placing = false
  private placed = false
  /** True from a step change until the next animation frame, so a second click of a double click is ignored. */
  private stepChanging = false
  private stepTurn = 0
  private heightRelease: ReturnType<typeof setTimeout> | undefined

  declare cart: unknown

  protected override stores() {
    return [this.client.cart]
  }

  protected override storeSettled(): void {
    this.cart = undefined
  }

  override connectedCallback(): void {
    super.connectedCallback()
    this.addEventListener('nymbal:payment:status', this.onPaymentStatus)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.removeEventListener('nymbal:payment:status', this.onPaymentStatus)
    this.releaseMainHeight()
  }

  private readonly onPaymentStatus = (): void => this.requestUpdate()

  private paymentElement(): NymbalPaymentElement | null {
    return this.querySelector<NymbalPaymentElement>('nymbal-payment-element')
  }

  /**
   * Read at each render, so a status the child reached during its own upgrade, before this listened, still holds.
   * Without a client (a server render) there is no light DOM to read, and no order to place.
   */
  private paymentBlocked(): boolean {
    return this.readsStores && this.paymentElement()?.status === 'error'
  }

  private addressForm(prefix: 'shipping' | 'billing'): NymbalAddressForm | null {
    return this.renderRoot.querySelector<NymbalAddressForm>(
      `nymbal-address-form[id-prefix="${prefix}"]`,
    )
  }

  private go(step: Step): void {
    this.holdMainHeight()
    this.step = step
    this.error = null
    this.stepChanging = true
    const turn = ++this.stepTurn
    requestAnimationFrame(() => {
      if (turn === this.stepTurn) this.stepChanging = false
    })
    this.requestUpdate()
  }

  /**
   * Keeps the main column at least as tall as the step it replaces until a double click is over. A shorter next step
   * would shorten the page under a still cursor, and the second click would land on whatever rose there (a footer
   * link), outside this element, where neither multi-click guard sees it. Released after 600 ms, past the 500 ms an OS
   * allows between the two clicks of a double click, so the column then settles to the shown step's own height.
   */
  private holdMainHeight(): void {
    const main = this.renderRoot.querySelector<HTMLElement>("[part~='main']")
    if (main === null) return
    const height = main.offsetHeight
    if (height > (Number.parseFloat(main.style.minHeight) || 0))
      main.style.minHeight = `${height}px`
    clearTimeout(this.heightRelease)
    this.heightRelease = setTimeout(() => this.releaseMainHeight(), STEP_HEIGHT_HOLD_MS)
  }

  private releaseMainHeight(): void {
    clearTimeout(this.heightRelease)
    this.heightRelease = undefined
    const main = this.renderRoot.querySelector<HTMLElement>("[part~='main']")
    if (main !== null) main.style.minHeight = ''
  }

  private showError(message: string): void {
    this.error = message
    this.requestUpdate()
  }

  /**
   * Whether a submit of `step`'s form goes ahead. The step setters are synchronous, so by a double click's second
   * click the next step has rendered under the cursor: a submit in the frame of a step change is not the shopper's.
   */
  private accepts(event: Event, step: Step): boolean {
    event.preventDefault()
    return this.step === step && !this.stepChanging
  }

  /** The second click of a multi-click is not a decision to continue or to pay; the first one already submitted. */
  private readonly onSubmitClick = (event: MouseEvent): void => {
    if (event.detail > 1) event.preventDefault()
  }

  private readonly onContact = (event: Event): void => {
    if (!this.accepts(event, 'contact')) return
    const email =
      this.renderRoot.querySelector<HTMLInputElement>('#contact-email')?.value.trim() ?? ''
    if (email === '') return this.showError('Please enter your email address.')
    this.client.checkout.setEmail(email)
    this.go('shipping')
  }

  private readonly onShipping = (event: Event): void => {
    if (!this.accepts(event, 'shipping')) return
    const form = this.addressForm('shipping')
    if (form === null || !form.reportValidity()) return
    this.client.checkout.setShippingAddress(form.value)
    this.client.checkout.setShippingMethod({
      carrier: 'Standard',
      service: 'Standard Shipping',
      amountMinor: 0,
      currency: this.client.cart.getState().currency || 'GBP',
      estimatedDays: 5,
    })
    this.go('payment')
  }

  private billingAddress(): Address | null {
    if (this.billingSame) return this.client.checkout.getState().shippingAddress
    const form = this.addressForm('billing')
    if (form === null || !form.reportValidity()) return null
    return form.value
  }

  private readonly onPlace = (event: Event): void => {
    if (!this.accepts(event, 'payment')) return
    if (this.placing || this.placed || this.paymentBlocked()) return
    const billing = this.billingAddress()
    if (billing === null) return
    this.placing = true
    this.error = null
    this.requestUpdate()
    void this.place(billing)
  }

  /** Calls the SDK before its first `await`, so the in-flight flag set by the caller covers the order request. */
  private async place(billing: Address): Promise<void> {
    const checkout = this.client.checkout
    try {
      checkout.setBillingAddress(billing)
      const result = await checkout.submitPayment()
      if (result === null) {
        // A resubmit of a cart that already became an order (Back, then Place Order) goes to that order.
        const { placedOrderNumber, placedOrderKey, error } = checkout.getState()
        if (placedOrderNumber) return this.leaveFor(placedOrderNumber, placedOrderKey ?? undefined)
        return this.stay(error ?? PAYMENT_FAILED)
      }
      if (result.payment.status === 'failed') {
        return this.stay(checkout.getState().error ?? PAYMENT_FAILED)
      }
      // Confirmed only when the driver says the payment went through; otherwise the order shows it awaiting payment.
      if (result.payment.status === 'requires_action') {
        const { email, billingAddress } = checkout.getState()
        const confirmation = await this.confirm(result.paymentIntent.clientSecret, {
          ...(email !== '' && { email }),
          ...(billingAddress !== null && { billing: billingAddress }),
        })
        if (!confirmation.ok) return this.stay(confirmation.error)
        if (confirmation.confirmed) checkout.markConfirmed()
      }
      this.leaveFor(result.orderNumber, result.orderKey)
    } catch (err) {
      this.stay(err instanceof Error && err.message !== '' ? err.message : PAYMENT_FAILED)
    }
  }

  private confirm(
    clientSecret: string,
    context: PaymentConfirmContext,
  ): Promise<PaymentConfirmation> {
    return this.paymentElement()?.confirm(clientSecret, context) ?? Promise.resolve(NO_PAYMENT_STEP)
  }

  private stay(message: string): void {
    this.placing = false
    this.showError(message)
  }

  /**
   * Place Order stays disabled from here through the page's navigation. `orderKey`, when the answer carried one, lets
   * the order's page read it with no session.
   */
  private leaveFor(orderNumber: string, orderKey: string | undefined): void {
    this.client.checkout.reset()
    this.placing = false
    this.placed = true
    this.requestUpdate()
    this.dispatchEvent(
      new CustomEvent('nymbal:checkout:placed', {
        bubbles: true,
        composed: true,
        detail: { orderNumber, ...(orderKey !== undefined && { orderKey }) },
      }),
    )
  }

  private readonly onBillingSame = (event: Event): void => {
    this.billingSame = (event.target as HTMLInputElement).checked
    this.requestUpdate()
  }

  private back(step: Step): () => void {
    return () => {
      if (!this.placing && !this.placed) this.go(step)
    }
  }

  private renderSteps() {
    const current = STEPS.indexOf(this.step)
    return html`
      <div part="steps" data-testid="checkout-steps">
        ${STEPS.map((step, index) => {
          const state = index < current ? ' step-done' : index === current ? ' step-active' : ''
          return html`
            ${index > 0
              ? html`<div
                  part="step-divider${index <= current ? ' step-divider-done' : ''}"
                  aria-hidden="true"
                ></div>`
              : nothing}
            <div
              part="step${state}"
              data-testid="checkout-step-${step}"
              aria-current=${index === current ? 'step' : nothing}
            >
              <span>${STEP_LABELS[step]}</span>
            </div>
          `
        })}
      </div>
    `
  }

  private renderContact() {
    return html`
      <section part="section" data-testid="checkout-contact" ?hidden=${this.step !== 'contact'}>
        <form part="form" @submit=${this.onContact}>
          <h2 part="section-title">Contact Information</h2>
          ${renderField({
            id: 'contact-email',
            name: 'email',
            label: 'Email Address',
            type: 'email',
            autocomplete: 'email',
            required: true,
            placeholder: 'you@example.com',
          })}
          <div part="actions">
            <button
              type="submit"
              part="submit"
              class="btn btn-primary"
              data-testid="contact-continue"
              @click=${this.onSubmitClick}
            >
              <slot name="contact-continue-label">Continue to Shipping</slot>
            </button>
          </div>
        </form>
      </section>
    `
  }

  private renderShipping() {
    return html`
      <section part="section" data-testid="checkout-shipping" ?hidden=${this.step !== 'shipping'}>
        <form part="form" novalidate @submit=${this.onShipping}>
          <h2 part="section-title">Shipping Address</h2>
          <nymbal-address-form
            id-prefix="shipping"
            data-testid="shipping-form"
          ></nymbal-address-form>
          <div part="actions">
            <button
              type="button"
              part="back"
              class="btn btn-secondary"
              @click=${this.back('contact')}
            >
              Back
            </button>
            <button
              type="submit"
              part="submit"
              class="btn btn-primary"
              data-testid="shipping-continue"
              @click=${this.onSubmitClick}
            >
              <slot name="shipping-continue-label">Continue to Payment</slot>
            </button>
          </div>
        </form>
      </section>
    `
  }

  private renderPayment() {
    const busy = this.placing || this.placed
    return html`
      <section part="section" data-testid="checkout-payment" ?hidden=${this.step !== 'payment'}>
        <form part="form" novalidate @submit=${this.onPlace}>
          <h2 part="section-title">Payment</h2>
          <label part="billing-same">
            <input
              type="checkbox"
              id="billing-same"
              data-testid="billing-same"
              .checked=${this.billingSame}
              @change=${this.onBillingSame}
            />
            Billing address same as shipping
          </label>
          <div part="billing" data-testid="billing-address" ?hidden=${this.billingSame}>
            <h3 part="billing-title">Billing Address</h3>
            <nymbal-address-form id-prefix="billing"></nymbal-address-form>
          </div>
          <div part="payment"><slot name="payment"></slot></div>
          <div part="actions">
            <button
              type="button"
              part="back"
              class="btn btn-secondary"
              ?disabled=${busy}
              @click=${this.back('shipping')}
            >
              Back
            </button>
            <button
              type="submit"
              part="submit"
              class="btn btn-primary"
              data-testid="place-order"
              ?disabled=${busy || this.paymentBlocked()}
              @click=${this.onSubmitClick}
            >
              ${this.placing
                ? 'Processing...'
                : html`<slot name="place-order-label">Place Order</slot>`}
            </button>
          </div>
          <p part="terms">
            <slot name="terms">By placing your order, you agree to our terms and conditions.</slot>
          </p>
        </form>
      </section>
    `
  }

  private renderLine(item: CartItem, currency: string) {
    return html`
      <div part="item">
        <span part="item-name">${item.productName}</span>
        ${item.variantName ? html`<span part="item-variant">${item.variantName}</span>` : nothing}
        <span part="item-qty">x${item.qty}</span>
        <span part="item-price">${formatPrice(item.priceMinor * item.qty, currency)}</span>
      </div>
    `
  }

  private renderSummary() {
    const cart = shownCart(this, this.cart, this.readsStores ? this.client : null)
    const currency = cart.currency || 'GBP'
    const subtotal = formatPrice(cart.subtotalMinor, currency)
    return html`
      <aside part="summary" data-testid="checkout-summary">
        <h2 part="summary-title"><slot name="summary-title">Order Summary</slot></h2>
        ${cart.items.length === 0
          ? nothing
          : html`<div part="items">
              ${cart.items.map((item) => this.renderLine(item, currency))}
            </div>`}
        <dl>
          <div part="summary-row subtotal">
            <dt>Subtotal</dt>
            <dd data-testid="cart-subtotal">${subtotal}</dd>
          </div>
          <div part="summary-row">
            <dt>Shipping</dt>
            <dd>Standard, free</dd>
          </div>
        </dl>
        <div part="total">
          <span>Total</span>
          <span>${subtotal}</span>
        </div>
      </aside>
    `
  }

  protected override render() {
    return html`
      <h1 part="title"><slot name="title">Checkout</slot></h1>
      ${this.renderSteps()}
      ${this.error === null
        ? nothing
        : html`<div part="error" role="alert" data-testid="checkout-error">${this.error}</div>`}
      <div part="layout">
        <div part="main">
          ${this.renderContact()} ${this.renderShipping()} ${this.renderPayment()}
        </div>
        ${this.renderSummary()}
      </div>
    `
  }
}
