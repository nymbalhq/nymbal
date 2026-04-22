export type ErrorContext = Record<string, unknown>

export class NymbalError extends Error {
  readonly code: string
  readonly context: ErrorContext

  constructor(code: string, message: string, options: { cause?: unknown; context?: ErrorContext } = {}) {
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
  constructor(message: string, options: { cause?: unknown; context?: ErrorContext } = {}) {
    super('config.invalid', message, options)
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
    code: 'intent_failed' | 'capture_failed' | 'refund_failed' | 'webhook_invalid' | 'not_configured',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(`payment.${code}`, message, options)
  }
}

export class CheckoutError extends NymbalError {
  constructor(
    code: 'cart_empty' | 'variant_missing' | 'out_of_stock' | 'reservation_failed' | 'finalize_failed',
    message: string,
    options: { cause?: unknown; context?: ErrorContext } = {},
  ) {
    super(`checkout.${code}`, message, options)
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
