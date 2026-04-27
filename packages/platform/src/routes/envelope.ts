import { HttpError, NotFoundError, NymbalError, type ResponseEnvelope } from '@nymbal/types'

export interface Envelope<T> {
  data?: T
  meta?: Record<string, unknown>
  error?: { code: string; message: string; context?: Record<string, unknown> }
}

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200): ResponseEnvelope<Envelope<T>> {
  const body: Envelope<T> = { data, ...(meta !== undefined && { meta }) }
  return { status, body }
}

export function fail(code: string, message: string, status = 400, context?: Record<string, unknown>): ResponseEnvelope<Envelope<never>> {
  const body: Envelope<never> = {
    error: { code, message, ...(context !== undefined && { context }) },
  }
  return { status, body }
}

export function renderError(err: unknown): ResponseEnvelope<Envelope<never>> {
  if (err instanceof HttpError) {
    return fail(err.code, err.message, err.status)
  }
  if (err instanceof NotFoundError) {
    return fail(err.code, err.message, 404, err.context)
  }
  if (err instanceof NymbalError) {
    return fail(err.code, err.message, 500, err.context)
  }
  const message = err instanceof Error ? err.message : String(err)
  return fail('internal', message, 500)
}
