import {
  CartLimitError,
  CartPromotionError,
  CheckoutError,
  HttpError,
  NotFoundError,
  NymbalError,
  OrderConflictError,
  ReviewRefusedError,
  StatusTransitionError,
  ValidationError,
  type Logger,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import { scrubDeep } from '../settings/secret-set.js'

export interface Envelope<T> {
  data?: T
  meta?: Record<string, unknown>
  error?: { code: string; message: string; context?: Record<string, unknown> }
}

export function ok<T>(
  data: T,
  meta?: Record<string, unknown>,
  status = 200,
): ResponseEnvelope<Envelope<T>> {
  const body: Envelope<T> = { data, ...(meta !== undefined && { meta }) }
  return { status, body }
}

export function fail(
  code: string,
  message: string,
  status = 400,
  context?: Record<string, unknown>,
): ResponseEnvelope<Envelope<never>> {
  const body: Envelope<never> = {
    error: { code, message, ...(context !== undefined && { context }) },
  }
  return { status, body }
}

/**
 * What the shopper can fix answers 4xx. `finalize_failed` is a fault and stays 5xx: the payment provider retries a
 * webhook only on a non-2xx.
 */
const CHECKOUT_STATUS: Record<string, number> = {
  'checkout.cart_empty': 409,
  'checkout.in_progress': 409,
  'checkout.payment_in_progress': 409,
  'checkout.out_of_stock': 409,
  'checkout.reservation_failed': 409,
  'checkout.variant_missing': 422,
  'checkout.total_changed': 409,
  'checkout.promotions_unavailable': 503,
}

const INTERNAL_MESSAGE = 'Internal server error'

/**
 * The answer for an error a route caught, with no secret Settings hold in its message or context. An error that is not
 * Nymbal's own (a driver's, the runtime's) answers a generic 500 and is logged to `logger`, its text kept from the
 * caller.
 */
export function renderError(err: unknown, logger?: Logger): ResponseEnvelope<Envelope<never>> {
  if (!(err instanceof NymbalError)) {
    logger?.error({ err }, 'a route failed on an error that is not a Nymbal error')
    return fail('internal', INTERNAL_MESSAGE, 500)
  }
  return scrubDeep(errorEnvelope(err))
}

function errorEnvelope(err: NymbalError): ResponseEnvelope<Envelope<never>> {
  if (err instanceof HttpError) {
    return fail(err.code, err.message, err.status)
  }
  if (err instanceof NotFoundError) {
    return fail(err.code, err.message, 404, err.context)
  }
  if (err instanceof ValidationError || err instanceof CartLimitError) {
    return fail(err.code, err.message, 400, err.context)
  }
  if (err instanceof CartPromotionError) {
    return fail(
      err.code,
      err.message,
      err.code === 'cart.promotions_unavailable' ? 503 : 400,
      err.context,
    )
  }
  // A transition the table forbids, or money that does not allow the command: the caller's to fix, never a fault.
  if (err instanceof StatusTransitionError || err instanceof OrderConflictError) {
    return fail(err.code, err.message, 409, err.context)
  }
  // A store may refuse a review; `not_a_buyer` is a permission, the rest conflict with what the store holds or takes.
  if (err instanceof ReviewRefusedError) {
    return fail(err.code, err.message, err.refusal === 'not_a_buyer' ? 403 : 409, err.context)
  }
  if (err instanceof CheckoutError) {
    return fail(err.code, err.message, CHECKOUT_STATUS[err.code] ?? 500, err.context)
  }
  return fail(err.code, err.message, 500, err.context)
}
