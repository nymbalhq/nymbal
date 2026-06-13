import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaymentError } from '@nymbal/types'
import { createStripePaymentsAdapter, type StripePaymentsConfig } from './stripe-adapter.js'
import { createLogger } from '../../logger.js'

const { constructorCalls, stripeStubs } = vi.hoisted(() => {
  return {
    constructorCalls: [] as Array<{ key: string; options: Record<string, unknown> }>,
    stripeStubs: {
      paymentIntentsCreate: vi.fn(),
      paymentIntentsRetrieve: vi.fn(),
      paymentIntentsCapture: vi.fn(),
      refundsCreate: vi.fn(),
      balanceRetrieve: vi.fn(),
      constructEvent: vi.fn(),
    },
  }
})

vi.mock('stripe', () => {
  class MockStripe {
    paymentIntents = {
      create: stripeStubs.paymentIntentsCreate,
      retrieve: stripeStubs.paymentIntentsRetrieve,
      capture: stripeStubs.paymentIntentsCapture,
    }
    refunds = { create: stripeStubs.refundsCreate }
    balance = { retrieve: stripeStubs.balanceRetrieve }
    webhooks = { constructEvent: stripeStubs.constructEvent }
    constructor(key: string, options: Record<string, unknown>) {
      constructorCalls.push({ key, options })
    }
  }
  return { default: MockStripe }
})

const logger = createLogger({ pretty: false, level: 'error' })

const baseConfig: StripePaymentsConfig = {
  secretKey: 'sk_test_unit',
  webhookSecret: 'whsec_test_unit',
}

function buildAdapter(config: StripePaymentsConfig = baseConfig) {
  return createStripePaymentsAdapter({ logger, config })
}

/** Realistic (partial) Stripe PaymentIntent API response shape. */
function stripeIntentResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_unit_1',
    object: 'payment_intent',
    amount: 1000,
    amount_received: 0,
    client_secret: 'pi_unit_1_secret_abc',
    currency: 'gbp',
    status: 'requires_payment_method',
    metadata: {},
    ...overrides,
  }
}

beforeEach(() => {
  constructorCalls.length = 0
  stripeStubs.paymentIntentsCreate.mockReset()
  stripeStubs.paymentIntentsRetrieve.mockReset()
  stripeStubs.paymentIntentsCapture.mockReset()
  stripeStubs.refundsCreate.mockReset()
  stripeStubs.balanceRetrieve.mockReset()
  stripeStubs.constructEvent.mockReset()
})

describe('createStripePaymentsAdapter — client configuration', () => {
  it('passes host, port and protocol through to the Stripe client when configured', () => {
    buildAdapter({
      ...baseConfig,
      host: '127.0.0.1',
      port: 12111,
      protocol: 'http',
    })
    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]!.key).toBe('sk_test_unit')
    expect(constructorCalls[0]!.options).toEqual({
      host: '127.0.0.1',
      port: 12111,
      protocol: 'http',
    })
  })

  it('omits host, port and protocol when not configured so production defaults apply', () => {
    buildAdapter()
    expect(constructorCalls).toHaveLength(1)
    expect(constructorCalls[0]!.options).toEqual({})
    expect(constructorCalls[0]!.options).not.toHaveProperty('host')
    expect(constructorCalls[0]!.options).not.toHaveProperty('port')
    expect(constructorCalls[0]!.options).not.toHaveProperty('protocol')
  })

  it('passes apiVersion through when configured and omits it otherwise', () => {
    buildAdapter({ ...baseConfig, apiVersion: '2025-02-24.acacia' })
    buildAdapter()
    expect(constructorCalls[0]!.options).toEqual({ apiVersion: '2025-02-24.acacia' })
    expect(constructorCalls[1]!.options).not.toHaveProperty('apiVersion')
  })

  it('throws PaymentError not_configured when secretKey is missing', () => {
    expect(() => buildAdapter({ ...baseConfig, secretKey: '' })).toThrowError(PaymentError)
    try {
      buildAdapter({ ...baseConfig, secretKey: '' })
    } catch (err) {
      expect((err as PaymentError).code).toBe('payment.not_configured')
    }
  })

  it('throws PaymentError not_configured when webhookSecret is missing', () => {
    expect(() => buildAdapter({ ...baseConfig, webhookSecret: '' })).toThrowError(PaymentError)
    try {
      buildAdapter({ ...baseConfig, webhookSecret: '' })
    } catch (err) {
      expect((err as PaymentError).code).toBe('payment.not_configured')
    }
  })

  it('declares payments kind, stripe provider and capabilities, and initialize resolves', async () => {
    const adapter = buildAdapter()
    expect(adapter.kind).toBe('payments')
    expect(adapter.providerName).toBe('stripe')
    expect(adapter.capabilities).toEqual(['intent', 'capture', 'refund', 'webhook'])
    await expect(adapter.initialize({})).resolves.toBeUndefined()
  })
})

describe('createStripePaymentsAdapter — payment intents', () => {
  it('createPaymentIntent maps the Stripe response to the canonical PaymentIntent shape', async () => {
    stripeStubs.paymentIntentsCreate.mockResolvedValue(stripeIntentResponse())
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({
      amountMinor: 1000,
      currency: 'GBP',
      orderRef: 'order-1',
      customerId: 'cust-1',
      metadata: { source: 'unit' },
    })
    expect(intent).toEqual({
      id: 'pi_unit_1',
      clientSecret: 'pi_unit_1_secret_abc',
      amountMinor: 1000,
      currency: 'GBP',
      status: 'requires_payment_method',
    })
    // Stripe expects lowercase currency and minor units on the wire.
    expect(stripeStubs.paymentIntentsCreate).toHaveBeenCalledWith({
      amount: 1000,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: { source: 'unit', orderRef: 'order-1', customerId: 'cust-1' },
    })
  })

  it('createPaymentIntent omits orderRef/customerId metadata when params are absent', async () => {
    stripeStubs.paymentIntentsCreate.mockResolvedValue(
      stripeIntentResponse({ client_secret: null }),
    )
    const adapter = buildAdapter()
    const intent = await adapter.createPaymentIntent({ amountMinor: 1000, currency: 'GBP' })
    expect(intent.clientSecret).toBe('')
    expect(stripeStubs.paymentIntentsCreate).toHaveBeenCalledWith({
      amount: 1000,
      currency: 'gbp',
      automatic_payment_methods: { enabled: true },
      metadata: {},
    })
  })

  it('createPaymentIntent wraps provider failures in PaymentError intent_failed', async () => {
    const cause = new Error('stripe is down')
    stripeStubs.paymentIntentsCreate.mockRejectedValue(cause)
    const adapter = buildAdapter()
    const error = await adapter
      .createPaymentIntent({ amountMinor: 1000, currency: 'GBP' })
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.intent_failed')
    expect((error as PaymentError).cause).toBe(cause)
  })
})

describe('createStripePaymentsAdapter — capture', () => {
  it('capturePayment maps amount_received, currency and status', async () => {
    stripeStubs.paymentIntentsCapture.mockResolvedValue(
      stripeIntentResponse({ amount_received: 750, status: 'succeeded' }),
    )
    const adapter = buildAdapter()
    const capture = await adapter.capturePayment('pi_unit_1', 750)
    expect(capture).toEqual({
      paymentId: 'pi_unit_1',
      capturedAmountMinor: 750,
      currency: 'GBP',
      status: 'succeeded',
    })
    expect(stripeStubs.paymentIntentsCapture).toHaveBeenCalledWith('pi_unit_1', {
      amount_to_capture: 750,
    })
  })

  it('capturePayment falls back to amount when amount_received is missing and sends no amount_to_capture', async () => {
    stripeStubs.paymentIntentsCapture.mockResolvedValue(
      stripeIntentResponse({ amount_received: null, status: 'succeeded' }),
    )
    const adapter = buildAdapter()
    const capture = await adapter.capturePayment('pi_unit_1')
    expect(capture.capturedAmountMinor).toBe(1000)
    expect(stripeStubs.paymentIntentsCapture).toHaveBeenCalledWith('pi_unit_1', {})
  })

  it('capturePayment wraps provider failures in PaymentError capture_failed', async () => {
    stripeStubs.paymentIntentsCapture.mockRejectedValue(new Error('no such intent'))
    const adapter = buildAdapter()
    const error = await adapter
      .capturePayment('pi_missing')
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.capture_failed')
  })
})

describe('createStripePaymentsAdapter — refunds', () => {
  it('refund maps the Stripe refund response to the canonical Refund shape', async () => {
    stripeStubs.refundsCreate.mockResolvedValue({
      id: 're_unit_1',
      object: 'refund',
      amount: 400,
      currency: 'gbp',
      reason: 'requested_by_customer',
      status: 'succeeded',
    })
    const adapter = buildAdapter()
    const refund = await adapter.refund('pi_unit_1', 400, 'requested_by_customer')
    expect(refund).toEqual({
      refundId: 're_unit_1',
      paymentId: 'pi_unit_1',
      amountMinor: 400,
      currency: 'GBP',
      reason: 'requested_by_customer',
      status: 'succeeded',
    })
    expect(stripeStubs.refundsCreate).toHaveBeenCalledWith({
      payment_intent: 'pi_unit_1',
      amount: 400,
      reason: 'requested_by_customer',
    })
  })

  it('refund defaults reason to null and status to pending, omitting optional request params', async () => {
    stripeStubs.refundsCreate.mockResolvedValue({
      id: 're_unit_2',
      object: 'refund',
      amount: 1000,
      currency: 'gbp',
      reason: null,
      status: null,
    })
    const adapter = buildAdapter()
    const refund = await adapter.refund('pi_unit_1')
    expect(refund.reason).toBeNull()
    expect(refund.status).toBe('pending')
    expect(stripeStubs.refundsCreate).toHaveBeenCalledWith({ payment_intent: 'pi_unit_1' })
  })

  it('refund wraps provider failures in PaymentError refund_failed', async () => {
    stripeStubs.refundsCreate.mockRejectedValue(new Error('already refunded'))
    const adapter = buildAdapter()
    const error = await adapter
      .refund('pi_unit_1', 400)
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.refund_failed')
  })
})

describe('createStripePaymentsAdapter — status and health', () => {
  it('getPaymentStatus passes Stripe statuses through and maps canceled to cancelled', async () => {
    const adapter = buildAdapter()
    stripeStubs.paymentIntentsRetrieve.mockResolvedValueOnce(
      stripeIntentResponse({ status: 'succeeded' }),
    )
    await expect(adapter.getPaymentStatus('pi_unit_1')).resolves.toBe('succeeded')
    stripeStubs.paymentIntentsRetrieve.mockResolvedValueOnce(
      stripeIntentResponse({ status: 'canceled' }),
    )
    await expect(adapter.getPaymentStatus('pi_unit_1')).resolves.toBe('cancelled')
  })

  it('getPaymentStatus maps unknown provider statuses to failed', async () => {
    stripeStubs.paymentIntentsRetrieve.mockResolvedValue(
      stripeIntentResponse({ status: 'some_future_status' }),
    )
    const adapter = buildAdapter()
    await expect(adapter.getPaymentStatus('pi_unit_1')).resolves.toBe('failed')
  })

  it('healthCheck reports healthy when balance retrieval succeeds', async () => {
    stripeStubs.balanceRetrieve.mockResolvedValue({ object: 'balance', livemode: false })
    const adapter = buildAdapter()
    await expect(adapter.healthCheck()).resolves.toEqual({ status: 'healthy' })
  })

  it('healthCheck reports down with the error detail when balance retrieval fails', async () => {
    stripeStubs.balanceRetrieve.mockRejectedValue(new Error('connection refused'))
    const adapter = buildAdapter()
    await expect(adapter.healthCheck()).resolves.toEqual({
      status: 'down',
      detail: 'connection refused',
    })
  })

  it('healthCheck stringifies non-Error failures in the detail', async () => {
    stripeStubs.balanceRetrieve.mockRejectedValue('boom')
    const adapter = buildAdapter()
    await expect(adapter.healthCheck()).resolves.toEqual({ status: 'down', detail: 'boom' })
  })
})

describe('createStripePaymentsAdapter — webhooks', () => {
  it('maps payment_intent.succeeded to payment.captured with normalised currency', async () => {
    stripeStubs.constructEvent.mockReturnValue({
      id: 'evt_unit_1',
      type: 'payment_intent.succeeded',
      data: {
        object: stripeIntentResponse({ amount_received: 1000, status: 'succeeded' }),
      },
    })
    const adapter = buildAdapter()
    const result = await adapter.parseWebhook('{"id":"evt_unit_1"}', 't=1,v1=sig')
    expect(result.verified).toBe(true)
    expect(result.eventId).toBe('evt_unit_1')
    expect(result.kind).toBe('payment.captured')
    expect(result.paymentIntentId).toBe('pi_unit_1')
    expect(result.amountMinor).toBe(1000)
    expect(result.currency).toBe('GBP')
    expect(stripeStubs.constructEvent).toHaveBeenCalledWith(
      '{"id":"evt_unit_1"}',
      't=1,v1=sig',
      'whsec_test_unit',
    )
  })

  it('falls back to amount when amount_received is missing on payment_intent.succeeded', async () => {
    stripeStubs.constructEvent.mockReturnValue({
      id: 'evt_unit_2',
      type: 'payment_intent.succeeded',
      data: { object: stripeIntentResponse({ amount_received: null, status: 'succeeded' }) },
    })
    const adapter = buildAdapter()
    const result = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(result.amountMinor).toBe(1000)
  })

  it('maps payment_intent.payment_failed to payment.failed with the provider reason', async () => {
    stripeStubs.constructEvent.mockReturnValue({
      id: 'evt_unit_3',
      type: 'payment_intent.payment_failed',
      data: {
        object: stripeIntentResponse({
          status: 'requires_payment_method',
          last_payment_error: { message: 'Your card was declined.' },
        }),
      },
    })
    const adapter = buildAdapter()
    const result = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(result.kind).toBe('payment.failed')
    expect(result.paymentIntentId).toBe('pi_unit_1')
    expect(result.reason).toBe('Your card was declined.')
  })

  it('defaults the failure reason when Stripe provides no last_payment_error', async () => {
    stripeStubs.constructEvent.mockReturnValue({
      id: 'evt_unit_4',
      type: 'payment_intent.payment_failed',
      data: { object: stripeIntentResponse({ last_payment_error: null }) },
    })
    const adapter = buildAdapter()
    const result = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(result.kind).toBe('payment.failed')
    expect(result.reason).toBe('payment failed')
  })

  it('maps charge.refunded to payment.refunded resolving string and object payment_intent refs', async () => {
    const adapter = buildAdapter()
    stripeStubs.constructEvent.mockReturnValueOnce({
      id: 'evt_unit_5',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_unit_1',
          object: 'charge',
          payment_intent: 'pi_unit_1',
          amount_refunded: 250,
          currency: 'gbp',
        },
      },
    })
    const fromString = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(fromString.kind).toBe('payment.refunded')
    expect(fromString.paymentIntentId).toBe('pi_unit_1')
    expect(fromString.amountMinor).toBe(250)
    expect(fromString.currency).toBe('GBP')

    stripeStubs.constructEvent.mockReturnValueOnce({
      id: 'evt_unit_6',
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_unit_2',
          object: 'charge',
          payment_intent: { id: 'pi_unit_2' },
          amount_refunded: 100,
          currency: 'gbp',
        },
      },
    })
    const fromObject = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(fromObject.paymentIntentId).toBe('pi_unit_2')
  })

  it('returns kind ignored for unhandled event types', async () => {
    stripeStubs.constructEvent.mockReturnValue({
      id: 'evt_unit_7',
      type: 'customer.created',
      data: { object: { id: 'cus_unit_1', object: 'customer' } },
    })
    const adapter = buildAdapter()
    const result = await adapter.parseWebhook('{}', 't=1,v1=sig')
    expect(result).toEqual({ verified: true, eventId: 'evt_unit_7', kind: 'ignored' })
  })

  it('throws PaymentError webhook_invalid when signature verification fails', async () => {
    stripeStubs.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload')
    })
    const adapter = buildAdapter()
    const error = await adapter
      .parseWebhook('{}', 't=1,v1=bad')
      .then(() => null)
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PaymentError)
    expect((error as PaymentError).code).toBe('payment.webhook_invalid')
  })
})
