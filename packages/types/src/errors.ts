export type ErrorContext = Record<string, unknown>

export class NymbalError extends Error {
  readonly code: string
  readonly context: ErrorContext

  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = this.constructor.name
    this.code = code
    this.context = options.context ?? {}
  }

  toJSON(): { name: string; code: string; message: string; context: ErrorContext } {
    return { name: this.name, code: this.code, message: this.message, context: this.context }
  }
}

export class ConfigError extends NymbalError {
  constructor(
    message: string,
    options: {
      cause?: unknown
      context?: ErrorContext
      code?: `config.${string}` | `adapter.${string}`
    } = {},
  ) {
    super(options.code ?? 'config.invalid', message, options)
  }
}

export class ValidationError extends NymbalError {
  constructor(message: string, options: { cause?: unknown; context?: ErrorContext } = {}) {
    super('validation.failed', message, options)
  }
}

export class NotFoundError extends NymbalError {
  constructor(
    resource: string,
    identifier: unknown,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super('not_found', `${resource} not found: ${String(identifier)}`, {
      ...options,
      context: { resource, identifier, ...(options.context ?? {}) },
    })
  }
}

export class AdapterError extends NymbalError {
  constructor(
    code: string,
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(`adapter.${code}`, message, options)
  }
}

export class HttpError extends NymbalError {
  readonly status: number

  constructor(
    status: number,
    message: string,
    options: { cause?: unknown; context?: ErrorContext; code?: string } = {},
  ) {
    super(options.code ?? `http.${status}`, message, options)
    this.status = status
  }
}

export class AuthError extends HttpError {
  constructor(
    code: 'unauthorized' | 'forbidden' | 'invalid_credentials' | 'token_expired' | 'token_invalid',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    const status = code === 'forbidden' ? 403 : 401
    super(status, message, { ...options, code: `auth.${code}` })
  }
}

export class PaymentError extends NymbalError {
  constructor(
    code:
      | 'intent_failed'
      | 'capture_failed'
      // A definite refusal: no money moved.
      | 'refund_rejected'
      // An outcome the shop cannot know (a timeout, a provider fault): money may have moved.
      | 'refund_unknown'
      | 'cancel_refused'
      | 'webhook_invalid'
      | 'not_configured',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(`payment.${code}`, message, options)
  }
}

/** A command the order's money does not allow (confirm unpaid, cancel paid, refund beyond the capture). */
export class OrderConflictError extends NymbalError {
  constructor(
    code:
      | 'order.unpaid'
      | 'order.paid'
      | 'order.stock_unavailable'
      | 'order.payment_in_progress'
      | 'refund.not_captured'
      | 'refund.exceeds_captured'
      | 'refund.request_reused',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(code, message, options)
  }
}

export class CheckoutError extends NymbalError {
  constructor(
    code:
      | 'cart_empty'
      | 'in_progress'
      | 'payment_in_progress'
      | 'variant_missing'
      | 'out_of_stock'
      | 'reservation_failed'
      | 'finalize_failed',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(`checkout.${code}`, message, options)
  }
}

/** A cart command that would take a line above `max`; `onCart` is what the line held before it. */
export class CartLimitError extends NymbalError {
  constructor(variantId: string, max: number, onCart: number) {
    super('cart.qty_limit', `a cart line holds at most ${max}`, {
      context: { variantId, max, onCart },
    })
  }
}

export class StatusTransitionError extends NymbalError {
  constructor(
    entity: string,
    fromStatus: string,
    toStatus: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(
      'status.invalid_transition',
      `Invalid ${entity} status transition: ${fromStatus} → ${toStatus}`,
      {
        ...options,
        context: { entity, fromStatus, toStatus, ...(options.context ?? {}) },
      },
    )
  }
}
