'use client'

import { useState, useCallback, useEffect, useRef, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { PaymentElement, useCheckout, useCart, useNymbalClient } from '@nymbalhq/react'
import type { PaymentConfirmation } from '@nymbalhq/sdk'
import type { NymbalPaymentElement } from '@nymbalhq/web-components'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/checkout.module.css'

import type { Address, StoreCapabilities } from '@nymbalhq/types'
type AddressFields = Pick<
  Address,
  'firstName' | 'lastName' | 'addressLine1' | 'city' | 'region' | 'postalCode' | 'country'
> & { addressLine2: string }

const emptyAddress: AddressFields = {
  firstName: '',
  lastName: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  region: '',
  postalCode: '',
  country: '',
}

const STEP_LABELS = ['Contact', 'Shipping', 'Payment'] as const

function StepIndicator({ current }: { current: number }) {
  return (
    <div className={styles.steps} data-testid="checkout-steps">
      {STEP_LABELS.map((label, i) => (
        <div
          key={label}
          className={`${styles.step} ${i < current ? styles.stepCompleted : ''} ${i === current ? styles.stepActive : ''}`}
        >
          <span className={styles.stepNumber}>{i + 1}</span>
          <span className={styles.stepLabel}>{label}</span>
        </div>
      ))}
    </div>
  )
}

function AddressFormFields({
  prefix,
  values,
  onChange,
}: {
  prefix: string
  values: AddressFields
  onChange: (field: keyof AddressFields, value: string) => void
}) {
  return (
    <div className={styles.formGrid}>
      <div>
        <label htmlFor={`${prefix}-firstName`}>First Name</label>
        <input
          id={`${prefix}-firstName`}
          data-testid={`${prefix}-firstName`}
          type="text"
          value={values.firstName}
          onChange={(e) => onChange('firstName', e.target.value)}
          required
          autoComplete="given-name"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-lastName`}>Last Name</label>
        <input
          id={`${prefix}-lastName`}
          data-testid={`${prefix}-lastName`}
          type="text"
          value={values.lastName}
          onChange={(e) => onChange('lastName', e.target.value)}
          required
          autoComplete="family-name"
        />
      </div>
      <div className={styles.formGridFull}>
        <label htmlFor={`${prefix}-addressLine1`}>Address Line 1</label>
        <input
          id={`${prefix}-addressLine1`}
          data-testid={`${prefix}-addressLine1`}
          type="text"
          value={values.addressLine1}
          onChange={(e) => onChange('addressLine1', e.target.value)}
          required
          autoComplete="address-line1"
        />
      </div>
      <div className={styles.formGridFull}>
        <label htmlFor={`${prefix}-addressLine2`}>Address Line 2 (optional)</label>
        <input
          id={`${prefix}-addressLine2`}
          data-testid={`${prefix}-addressLine2`}
          type="text"
          value={values.addressLine2}
          onChange={(e) => onChange('addressLine2', e.target.value)}
          autoComplete="address-line2"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-city`}>City</label>
        <input
          id={`${prefix}-city`}
          data-testid={`${prefix}-city`}
          type="text"
          value={values.city}
          onChange={(e) => onChange('city', e.target.value)}
          required
          autoComplete="address-level2"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-region`}>State / County</label>
        <input
          id={`${prefix}-region`}
          data-testid={`${prefix}-region`}
          type="text"
          value={values.region}
          onChange={(e) => onChange('region', e.target.value)}
          required
          autoComplete="address-level1"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-postalCode`}>Postcode</label>
        <input
          id={`${prefix}-postalCode`}
          data-testid={`${prefix}-postalCode`}
          type="text"
          value={values.postalCode}
          onChange={(e) => onChange('postalCode', e.target.value)}
          required
          autoComplete="postal-code"
        />
      </div>
      <div>
        <label htmlFor={`${prefix}-country`}>Country (2-letter code)</label>
        <input
          id={`${prefix}-country`}
          data-testid={`${prefix}-country`}
          type="text"
          value={values.country}
          onChange={(e) => onChange('country', e.target.value)}
          required
          autoComplete="country"
          placeholder="GB"
        />
      </div>
    </div>
  )
}

/** The checkout, given the store's capabilities as the page's server component read them. */
export function CheckoutForm({ capabilities }: { capabilities: StoreCapabilities }) {
  const router = useRouter()
  const client = useNymbalClient()
  const checkout = useCheckout()
  const cart = useCart()
  const paymentClient = capabilities.payments.client
  const paymentRef = useRef<NymbalPaymentElement | null>(null)
  // An element that cannot take a payment (an unknown driver, a form that failed to load) holds Place Order.
  const [paymentBlocked, setPaymentBlocked] = useState(false)

  const [step, setStep] = useState(0)
  const [email, setEmail] = useState('')
  const [shippingAddress, setShippingAddress] = useState<AddressFields>(emptyAddress)
  const [billingAddress, setBillingAddress] = useState<AddressFields>(emptyAddress)
  const [sameAsShipping, setSameAsShipping] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const cartCurrency = cart.currency ?? 'GBP'

  // The element renders on the payment step; its status may already be settled when this runs.
  useEffect(() => {
    const el = paymentRef.current
    if (step !== 2 || el === null) return
    const sync = () => setPaymentBlocked(el.status === 'error')
    sync()
    el.addEventListener('nymbal:payment:status', sync)
    return () => el.removeEventListener('nymbal:payment:status', sync)
  }, [step])

  const updateShipping = useCallback((field: keyof AddressFields, value: string) => {
    setShippingAddress((prev) => ({ ...prev, [field]: value }))
  }, [])

  const updateBilling = useCallback((field: keyof AddressFields, value: string) => {
    setBillingAddress((prev) => ({ ...prev, [field]: value }))
  }, [])

  const handleContact = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setError(null)
      if (!email) {
        setError('Please enter your email address.')
        return
      }
      checkout.setEmail(email)
      setStep(1)
    },
    [email, checkout],
  )

  const handleShipping = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      setError(null)
      if (
        !shippingAddress.addressLine1 ||
        !shippingAddress.city ||
        !shippingAddress.postalCode ||
        !shippingAddress.country
      ) {
        setError('Please complete your shipping address.')
        return
      }
      checkout.setShippingAddress({
        firstName: shippingAddress.firstName,
        lastName: shippingAddress.lastName,
        addressLine1: shippingAddress.addressLine1,
        addressLine2: shippingAddress.addressLine2 || undefined,
        city: shippingAddress.city,
        region: shippingAddress.region,
        postalCode: shippingAddress.postalCode,
        country: shippingAddress.country,
      })
      checkout.setShippingMethod({
        carrier: 'Standard',
        service: 'Standard Shipping',
        amountMinor: 0,
        currency: cartCurrency,
        estimatedDays: 5,
      })
      setStep(2)
    },
    [shippingAddress, checkout, cartCurrency],
  )

  const handlePlaceOrder = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()
      if (paymentBlocked) return

      setProcessing(true)
      setError(null)

      const fields = sameAsShipping ? shippingAddress : billingAddress
      const billing = {
        firstName: fields.firstName,
        lastName: fields.lastName,
        addressLine1: fields.addressLine1,
        addressLine2: fields.addressLine2 || undefined,
        city: fields.city,
        region: fields.region,
        postalCode: fields.postalCode,
        country: fields.country,
      }
      checkout.setBillingAddress(billing)

      const stay = (message: string) => {
        setError(message)
        setProcessing(false)
      }
      const leaveFor = (orderNumber: string) => {
        router.push(`/order/${encodeURIComponent(orderNumber)}`)
      }

      try {
        // The submit's own result, never the render-time snapshot, which still holds the state from before it.
        const result = await checkout.submitPayment()
        if (result === null) {
          // A resubmit of a cart that already became an order (Back, then Place Order) goes to that order.
          const { placedOrderNumber, error: submitError } = client.checkout.getState()
          if (placedOrderNumber) return leaveFor(placedOrderNumber)
          return stay(submitError ?? 'Something went wrong.')
        }
        if (result.payment.status === 'failed') {
          return stay(client.checkout.getState().error ?? 'Payment failed.')
        }
        // Confirmed only when the driver says the payment went through; otherwise the order page shows it pending.
        if (result.payment.status === 'requires_action') {
          const confirmation: PaymentConfirmation = (await paymentRef.current?.confirm(
            result.paymentIntent.clientSecret,
            { email: email || undefined, billing },
          )) ?? { ok: true, confirmed: false }
          if (!confirmation.ok) return stay(confirmation.error)
          if (confirmation.confirmed) checkout.markConfirmed()
        }
        leaveFor(result.orderNumber)
      } catch (err) {
        stay(err instanceof Error ? err.message : 'Something went wrong.')
      }
    },
    [
      paymentBlocked,
      email,
      shippingAddress,
      billingAddress,
      sameAsShipping,
      checkout,
      client,
      router,
    ],
  )

  return (
    <>
      {processing && (
        <div className={styles.processing}>
          <div className="spinner spinner-lg" role="status" />
          <p className={styles.processingText}>Processing your order...</p>
        </div>
      )}
      {/* Hidden, not unmounted, while processing: the payment driver confirms with what it mounted. */}
      <div
        className={`container ${styles.page}`}
        style={processing ? { display: 'none' } : undefined}
      >
        <h1 className={styles.pageTitle}>Checkout</h1>
        <StepIndicator current={step} />

        <div className={styles.layout}>
          <div className={styles.formArea}>
            {error && (
              <div className={styles.paymentError} role="alert">
                {error}
              </div>
            )}

            {step === 0 && (
              <form onSubmit={handleContact}>
                <div className={styles.formSection}>
                  <h2 className={styles.formSectionTitle}>Contact Information</h2>
                  <div className="form-group">
                    <label htmlFor="checkout-email">Email Address</label>
                    <input
                      id="contact-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      data-testid="contact-email"
                      placeholder="you@example.com"
                      autoComplete="email"
                    />
                  </div>
                </div>
                <div className={styles.formActions}>
                  <span />
                  <button type="submit" className="btn btn-primary" data-testid="contact-continue">
                    Continue to Shipping
                  </button>
                </div>
              </form>
            )}

            {step === 1 && (
              <form onSubmit={handleShipping}>
                <div className={styles.formSection} data-testid="shipping-address">
                  <h2 className={styles.formSectionTitle}>Shipping Address</h2>
                  <AddressFormFields
                    prefix="shipping"
                    values={shippingAddress}
                    onChange={updateShipping}
                  />
                </div>
                <div className={styles.formActions}>
                  <button type="button" className="btn btn-secondary" onClick={() => setStep(0)}>
                    Back
                  </button>
                  <button type="submit" className="btn btn-primary" data-testid="shipping-continue">
                    Continue to Payment
                  </button>
                </div>
              </form>
            )}

            {step === 2 && (
              <form onSubmit={handlePlaceOrder}>
                <div className={styles.formSection}>
                  <h2 className={styles.formSectionTitle}>Billing Address</h2>
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--nymbal-spacing-sm)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={sameAsShipping}
                      onChange={(e) => setSameAsShipping(e.target.checked)}
                      style={{ width: 'auto' }}
                    />
                    Same as shipping address
                  </label>
                  {!sameAsShipping && (
                    <div
                      data-testid="billing-address"
                      style={{ marginTop: 'var(--nymbal-spacing-md)' }}
                    >
                      <AddressFormFields
                        prefix="bill"
                        values={billingAddress}
                        onChange={updateBilling}
                      />
                    </div>
                  )}
                </div>

                <div
                  className={styles.formSection}
                  style={{ marginTop: 'var(--nymbal-spacing-lg)' }}
                >
                  {paymentClient !== null && <h2 className={styles.formSectionTitle}>Payment</h2>}
                  <PaymentElement
                    ref={paymentRef}
                    client={paymentClient}
                    data-testid="payment-element"
                  />
                </div>

                <div className={styles.formActions}>
                  <button type="button" className="btn btn-secondary" onClick={() => setStep(1)}>
                    Back
                  </button>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={paymentBlocked || processing}
                    data-testid="place-order"
                  >
                    Place Order
                  </button>
                </div>
              </form>
            )}
          </div>

          <aside className={styles.orderSummary}>
            <h2 className={styles.orderSummaryTitle}>Order Summary</h2>
            {cart.items?.map((item) => (
              <div key={item.variantId} className={styles.orderItem}>
                {item.imageUrl && (
                  <div className={styles.orderItemImage}>
                    <img src={item.imageUrl} alt={item.productName} />
                  </div>
                )}
                <div className={styles.orderItemInfo}>
                  <p className={styles.orderItemName}>{item.productName}</p>
                  <p className={styles.orderItemQty}>Qty: {item.qty}</p>
                </div>
                <span className={styles.orderItemPrice}>
                  {formatPrice(item.priceMinor * item.qty, cartCurrency)}
                </span>
              </div>
            ))}
            <hr className={styles.summaryDivider} />
            <div className={styles.summaryRow}>
              <span>Subtotal</span>
              <span data-testid="cart-subtotal">
                {formatPrice(cart.subtotalMinor ?? 0, cartCurrency)}
              </span>
            </div>
            <hr className={styles.summaryDivider} />
            <div className={`${styles.summaryRow} ${styles.summaryTotal}`}>
              <span>Total</span>
              <span>{formatPrice(cart.subtotalMinor ?? 0, cartCurrency)}</span>
            </div>
          </aside>
        </div>
      </div>
    </>
  )
}
