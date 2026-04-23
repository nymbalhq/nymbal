import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

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

// Stripe setup
let stripe: any = null
let cardElement: any = null

async function mountStripe() {
  try {
    const { loadStripe } = await import('@stripe/stripe-js')
    const stripeKey = (import.meta as any).env?.PUBLIC_STRIPE_PUBLISHABLE_KEY
    if (!stripeKey) return

    stripe = await loadStripe(stripeKey)
    if (!stripe) return

    const elements = stripe.elements()
    cardElement = elements.create('card', {
      style: {
        base: {
          fontSize: '14px',
          color: '#18181b',
          '::placeholder': { color: '#71717a' },
        },
      },
    })

    const cardContainer = document.getElementById('stripe-card-element')
    if (cardContainer) cardElement.mount(cardContainer)
  } catch {
    // Stripe unavailable
  }
}

mountStripe()

// Payment form
const paymentForm = document.getElementById('payment-form') as HTMLFormElement | null
paymentForm?.addEventListener('submit', async (e) => {
  e.preventDefault()
  hideError()

  const submitBtn = paymentForm.querySelector('[data-testid="place-order"]') as HTMLButtonElement | null
  if (submitBtn) {
    submitBtn.disabled = true
    submitBtn.textContent = 'Processing...'
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

    await client.checkout.submitPayment()

    const state = client.checkout.getState()

    if (state.paymentStatus === 'failed') {
      showError(state.error ?? 'Payment failed.')
      if (submitBtn) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Place Order'
      }
      return
    }

    if (stripe && cardElement && state.order?.paymentIntent?.clientSecret) {
      const { error } = await stripe.confirmCardPayment(state.order.paymentIntent.clientSecret, {
        payment_method: { card: cardElement },
      })
      if (error) {
        showError(error.message ?? 'Payment failed.')
        if (submitBtn) {
          submitBtn.disabled = false
          submitBtn.textContent = 'Place Order'
        }
        return
      }
    }

    const orderId = state.order?.orderId
    client.checkout.reset()
    window.location.href = `/order/${orderId}`
  } catch (err: any) {
    showError(err.message ?? 'Payment failed. Please try again.')
    if (submitBtn) {
      submitBtn.disabled = false
      submitBtn.textContent = 'Place Order'
    }
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
