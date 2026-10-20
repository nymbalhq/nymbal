import type { PaymentConfirmContext, PaymentConfirmation } from '@nymbalhq/sdk'
import type { NymbalPaymentElement } from '@nymbalhq/web-components'
import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'
import { submitOnce } from '../lib/submit-once.js'

const steps = ['contact', 'shipping', 'payment'] as const
type Step = (typeof steps)[number]

let currentStep: Step = 'contact'

const stepsEl = document.getElementById('checkout-steps-container')
const contactSection = document.getElementById('checkout-contact')
const shippingSection = document.getElementById('checkout-shipping')
const paymentSection = document.getElementById('checkout-payment')
const summaryEl = document.getElementById('checkout-summary')
const errorEl = document.getElementById('checkout-error')

function showStep(step: Step) {
  currentStep = step
  const sections: Record<Step, HTMLElement | null> = {
    contact: contactSection,
    shipping: shippingSection,
    payment: paymentSection,
  }
  steps.forEach((s) => {
    const el = sections[s]
    if (el) el.style.display = s === step ? '' : 'none'
  })
  updateStepIndicator()
}

function updateStepIndicator() {
  if (!stepsEl) return
  const currentIndex = steps.indexOf(currentStep)
  steps.forEach((step, index) => {
    const stepEl = stepsEl.querySelector(`[data-testid="checkout-step-${step}"]`)
    const dividerBefore = stepEl?.previousElementSibling
    if (!stepEl) return
    stepEl.className = 'checkout-step'
    if (index < currentIndex) stepEl.classList.add('completed')
    else if (index === currentIndex) stepEl.classList.add('active')
    if (dividerBefore?.classList.contains('checkout-step-divider')) {
      dividerBefore.className = 'checkout-step-divider'
      if (index <= currentIndex) dividerBefore.classList.add('completed')
    }
  })
}

function showError(message: string) {
  if (errorEl) {
    errorEl.textContent = message
    errorEl.style.display = 'block'
  }
}

function hideError() {
  if (errorEl) {
    errorEl.style.display = 'none'
    errorEl.textContent = ''
  }
}

function getFormValues(form: HTMLFormElement): Record<string, string> {
  const data = new FormData(form)
  const result: Record<string, string> = {}
  data.forEach((value, key) => {
    result[key] = String(value)
  })
  return result
}

function renderSummary() {
  if (!summaryEl) return
  const cartState = client.cart.getState()
  const items = cartState.items ?? []
  const currency = cartState.currency ?? 'GBP'

  summaryEl.innerHTML = `
    <h2 class="checkout-summary-title">Order Summary</h2>
    <div class="checkout-summary-items">
      ${items
        .map(
          (item) => `
        <div class="checkout-summary-item">
          <span class="checkout-summary-item-name">${item.productName}</span>
          <span class="checkout-summary-item-qty">x${item.qty}</span>
          <span class="checkout-summary-item-price">${formatPrice(item.priceMinor * item.qty, currency)}</span>
        </div>
      `,
        )
        .join('')}
    </div>
    <dl>
      <div class="checkout-summary-row">
        <dt>Subtotal</dt>
        <dd>${formatPrice(cartState.subtotalMinor, currency)}</dd>
      </div>
      <div class="checkout-summary-row">
        <dt>Shipping</dt>
        <dd>Calculated next</dd>
      </div>
    </dl>
    <div class="checkout-summary-total">
      <span>Total</span>
      <span>${formatPrice(cartState.subtotalMinor, currency)}</span>
    </div>
  `
}

// Contact form
const contactForm = document.getElementById('contact-form') as HTMLFormElement | null
contactForm?.addEventListener('submit', (e) => {
  e.preventDefault()
  hideError()
  const values = getFormValues(contactForm)
  if (!values.email) {
    showError('Please enter your email address.')
    return
  }
  client.checkout.setEmail(values.email)
  showStep('shipping')
})

// Shipping form
const shippingForm = document.getElementById('shipping-form') as HTMLFormElement | null
shippingForm?.addEventListener('submit', (e) => {
  e.preventDefault()
  hideError()
  const values = getFormValues(shippingForm)

  if (!values.addressLine1 || !values.city || !values.postalCode || !values.country) {
    showError('Please complete your shipping address.')
    return
  }

  client.checkout.setShippingAddress({
    firstName: values.firstName ?? '',
    lastName: values.lastName ?? '',
    addressLine1: values.addressLine1,
    addressLine2: values.addressLine2 || undefined,
    city: values.city,
    region: values.region ?? '',
    postalCode: values.postalCode,
    country: values.country,
  })
  client.checkout.setShippingMethod({
    carrier: 'Standard',
    service: 'Standard Shipping',
    amountMinor: 0,
    currency: client.cart.getState().currency ?? 'GBP',
    estimatedDays: 5,
  })
  showStep('payment')
})

// The payment step is the store's: the element renders the payments adapter's client half through its driver.
const paymentForm = document.getElementById('payment-form') as HTMLFormElement | null
const paymentEl = paymentForm?.querySelector<NymbalPaymentElement>('nymbal-payment-element') ?? null
const placeOrderBtn = paymentForm?.querySelector<HTMLButtonElement>('[data-testid="place-order"]')
const paymentBlocked = () => paymentEl?.status === 'error'

// While the element cannot take a payment (an unknown driver, a form that failed to load), no order is placed.
let heldByPayment = false
function syncPlaceOrder() {
  if (!placeOrderBtn) return
  const blocked = paymentBlocked()
  if (blocked) placeOrderBtn.disabled = true
  else if (heldByPayment) placeOrderBtn.disabled = false
  heldByPayment = blocked
}
paymentEl?.addEventListener('nymbal:payment:status', syncPlaceOrder)
syncPlaceOrder()
paymentForm?.addEventListener(
  'submit',
  (e) => {
    if (!paymentBlocked()) return
    e.preventDefault()
    e.stopImmediatePropagation()
  },
  true,
)

// Place Order renders where Continue was, so the second click of a double-click on Continue lands on it. A click that
// continues a multi-click is not a decision to pay: the first click of one on Place Order has already submitted.
placeOrderBtn?.addEventListener('click', (e) => {
  if (e.detail > 1) e.preventDefault()
})

/** No element (a page without a payment step) has nothing to confirm, as a null client does. */
function confirmPayment(
  clientSecret: string,
  context: PaymentConfirmContext,
): Promise<PaymentConfirmation> {
  return paymentEl?.confirm(clientSecret, context) ?? Promise.resolve({ ok: true, confirmed: false })
}

// Payment form
submitOnce(paymentForm, async () => {
  hideError()

  if (placeOrderBtn) placeOrderBtn.textContent = 'Processing...'
  const stay = (message: string) => {
    showError(message)
    if (placeOrderBtn) placeOrderBtn.textContent = 'Place Order'
  }
  const leaveFor = (orderNumber: string) => {
    client.checkout.reset()
    window.location.href = `/order/${encodeURIComponent(orderNumber)}`
    return 'leaving' as const
  }

  try {
    const sameAsShipping = (document.getElementById('billing-same') as HTMLInputElement)?.checked
    if (sameAsShipping) {
      const shippingAddr = client.checkout.getState().shippingAddress
      if (shippingAddr) client.checkout.setBillingAddress(shippingAddr)
    } else {
      const billingForm = document.getElementById('billing-form') as HTMLFormElement
      const values = getFormValues(billingForm)
      client.checkout.setBillingAddress({
        firstName: values.firstName ?? '',
        lastName: values.lastName ?? '',
        addressLine1: values.addressLine1,
        addressLine2: values.addressLine2 || undefined,
        city: values.city,
        region: values.region ?? '',
        postalCode: values.postalCode,
        country: values.country,
      })
    }

    const result = await client.checkout.submitPayment()
    if (result === null) {
      // A resubmit of a cart that already became an order (Back, then Place Order) goes to that order.
      const { placedOrderNumber, error } = client.checkout.getState()
      if (placedOrderNumber) return leaveFor(placedOrderNumber)
      return stay(error ?? 'Payment failed. Please try again.')
    }
    if (result.payment.status === 'failed') {
      return stay(client.checkout.getState().error ?? 'Payment failed. Please try again.')
    }
    // Confirmed only when the driver says the payment went through; otherwise the order page shows it awaiting payment.
    if (result.payment.status === 'requires_action') {
      const { email, billingAddress } = client.checkout.getState()
      const confirmation = await confirmPayment(result.paymentIntent.clientSecret, {
        email: email || undefined,
        billing: billingAddress ?? undefined,
      })
      if (!confirmation.ok) return stay(confirmation.error)
      if (confirmation.confirmed) client.checkout.markConfirmed()
    }
    return leaveFor(result.orderNumber)
  } catch (err: any) {
    stay(err.message ?? 'Payment failed. Please try again.')
  }
})

// Billing same-as-shipping toggle
const billingSameCheckbox = document.getElementById('billing-same') as HTMLInputElement | null
const billingFields = document.getElementById('billing-fields')
billingSameCheckbox?.addEventListener('change', () => {
  if (billingFields) {
    billingFields.style.display = billingSameCheckbox.checked ? 'none' : ''
  }
})

// Init
showStep('contact')
renderSummary()
client.cart.subscribe(renderSummary)
