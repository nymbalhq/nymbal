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
