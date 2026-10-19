import {
  CheckoutError,
  HttpError,
  NotFoundError,
  NymbalError,
  OrderConflictError,
  StatusTransitionError,
  ValidationError,
  type ResponseEnvelope,
} from '@nymbalhq/types'

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
}

export function renderError(err: unknown): ResponseEnvelope<Envelope<never>> {
  if (err instanceof HttpError) {
    return fail(err.code, err.message, err.status)
  }
  if (err instanceof NotFoundError) {
    return fail(err.code, err.message, 404, err.context)
  }
  if (err instanceof ValidationError) {
    return fail(err.code, err.message, 400, err.context)
  }
  // A transition the table forbids, or money that does not allow the command: the caller's to fix, never a fault.
  if (err instanceof StatusTransitionError || err instanceof OrderConflictError) {
    return fail(err.code, err.message, 409, err.context)
  }
  if (err instanceof CheckoutError) {
    return fail(err.code, err.message, CHECKOUT_STATUS[err.code] ?? 500, err.context)
  }
  if (err instanceof NymbalError) {
    return fail(err.code, err.message, 500, err.context)
  }
  const message = err instanceof Error ? err.message : String(err)
  return fail('internal', message, 500)
}
