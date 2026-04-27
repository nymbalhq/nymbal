'use client'

import { useState, useCallback, useEffect, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { useCheckout, useCart } from '@nymbal/react'
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { loadStripe } from '@stripe/stripe-js'
import { formatPrice } from '@/lib/format'
import styles from '@/styles/pages/checkout.module.css'

const stripeKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? ''
const isStub = process.env.NEXT_PUBLIC_NYMBAL_PAYMENTS_PROVIDER === 'native-stub' || !stripeKey
const stripePromise = isStub ? null : loadStripe(stripeKey)

import type { Address } from '@nymbal/types'
type AddressFields = Pick<Address, 'firstName' | 'lastName' | 'addressLine1' | 'city' | 'region' | 'postalCode' | 'country'> & { addressLine2: string }

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

function CheckoutFormInner() {
  const router = useRouter()
  const checkout = useCheckout()
  const cart = useCart()
  const stripe = useStripe()
  const elements = useElements()

  const [step, setStep] = useState(0)
  const [email, setEmail] = useState('')
  const [shippingAddress, setShippingAddress] = useState<AddressFields>(emptyAddress)
  const [billingAddress, setBillingAddress] = useState<AddressFields>(emptyAddress)
  const [sameAsShipping, setSameAsShipping] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const cartCurrency = cart.currency ?? 'GBP'

  useEffect(() => {
    if (checkout.paymentStatus === 'succeeded' && checkout.order) {
      router.push(`/order/${checkout.order.orderNumber}`)
    }
    if (checkout.paymentStatus === 'failed' && checkout.error) {
      setError(checkout.error)
      setProcessing(false)
    }
  }, [checkout.paymentStatus, checkout.order, checkout.error, router])

  const updateShipping = useCallback(
    (field: keyof AddressFields, value: string) => {
      setShippingAddress((prev) => ({ ...prev, [field]: value }))
    },
    [],
  )

  const updateBilling = useCallback(
    (field: keyof AddressFields, value: string) => {
      setBillingAddress((prev) => ({ ...prev, [field]: value }))
    },
    [],
  )

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
      if (!shippingAddress.addressLine1 || !shippingAddress.city || !shippingAddress.postalCode || !shippingAddress.country) {
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
      if (!isStub && (!stripe || !elements)) return

      setProcessing(true)
      setError(null)

      const billing = sameAsShipping ? shippingAddress : billingAddress
      checkout.setBillingAddress({
        firstName: billing.firstName,
        lastName: billing.lastName,
        addressLine1: billing.addressLine1,
        addressLine2: billing.addressLine2 || undefined,
        city: billing.city,
        region: billing.region,
        postalCode: billing.postalCode,
        country: billing.country,
      })

      try {
        await checkout.submitPayment()

        if (!isStub && stripe && elements && checkout.order?.paymentIntent?.clientSecret) {
          const cardEl = elements.getElement(CardElement)
          if (!cardEl) {
            setError('Card element not found.')
            setProcessing(false)
            return
          }

          const { error: stripeError } = await stripe.confirmCardPayment(
            checkout.order.paymentIntent.clientSecret,
            {
              payment_method: {
                card: cardEl,
                billing_details: {
                  email,
                  address: {
                    line1: billing.addressLine1,
                    line2: billing.addressLine2 || undefined,
                    city: billing.city,
                    state: billing.region,
                    postal_code: billing.postalCode,
                    country: billing.country,
                  },
                },
              },
            },
          )

          if (stripeError) {
            setError(stripeError.message ?? 'Payment failed.')
            setProcessing(false)
            return
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Something went wrong.')
        setProcessing(false)
      }
    },
    [stripe, elements, email, shippingAddress, billingAddress, sameAsShipping, checkout],
  )

  if (processing) {
    return (
      <div className={styles.processing}>
        <div className="spinner spinner-lg" role="status" />
        <p className={styles.processingText}>Processing your order...</p>
      </div>
    )
  }

  return (
    <div className={`container ${styles.page}`}>
      <h1 className={styles.pageTitle}>Checkout</h1>
      <StepIndicator current={step} />

      <div className={styles.layout}>
        <div className={styles.formArea}>
          {error && (
            <div className={styles.paymentError} role="alert">{error}</div>
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
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setStep(0)}
                >
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
                <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--nymbal-spacing-sm)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={sameAsShipping}
                    onChange={(e) => setSameAsShipping(e.target.checked)}
                    style={{ width: 'auto' }}
                  />
                  Same as shipping address
                </label>
                {!sameAsShipping && (
                  <div data-testid="billing-address" style={{ marginTop: 'var(--nymbal-spacing-md)' }}>
                    <AddressFormFields
                      prefix="bill"
                      values={billingAddress}
                      onChange={updateBilling}
                    />
                  </div>
                )}
              </div>

              <div className={styles.formSection} style={{ marginTop: 'var(--nymbal-spacing-lg)' }}>
                <h2 className={styles.formSectionTitle}>Payment</h2>
                {isStub ? (
                  <div className={styles.paymentElement} data-testid="card-element">
                    <p style={{ color: 'var(--nymbal-color-text-muted, #9ca3af)', fontSize: '0.875rem', margin: 0 }}>
                      Test mode — payment skipped
                    </p>
                  </div>
                ) : (
                  <div className={styles.paymentElement} data-testid="card-element">
                    <CardElement
                      options={{
                        style: {
                          base: {
                            fontSize: '16px',
                            color: '#1a1a1a',
                            '::placeholder': { color: '#9ca3af' },
                          },
                        },
                      }}
                    />
                  </div>
                )}
              </div>

              <div className={styles.formActions}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setStep(1)}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={(!isStub && !stripe) || processing}
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
            <span data-testid="cart-subtotal">{formatPrice(cart.subtotalMinor ?? 0, cartCurrency)}</span>
          </div>
          <hr className={styles.summaryDivider} />
          <div className={`${styles.summaryRow} ${styles.summaryTotal}`}>
            <span>Total</span>
            <span>{formatPrice(cart.subtotalMinor ?? 0, cartCurrency)}</span>
          </div>
        </aside>
      </div>
    </div>
  )
}

export function CheckoutForm() {
  return (
    <Elements stripe={stripePromise}>
      <CheckoutFormInner />
    </Elements>
  )
}
