import { AdapterError } from '@nymbalhq/types'

export type Json = Record<string, unknown>

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Talon.One's answer to one PUT: its status and its JSON, `undefined` when the body was not JSON. */
export interface Answered {
  status: number
  body: unknown
}

export interface TalonOneApi {
  /** `PUT /v2/customer_sessions/<id>`; rejects only when Talon.One gave no answer in time or could not be reached. */
  putSession(
    step: string,
    id: string,
    body: unknown,
    opts?: { dry?: boolean; idempotencyKey?: string; signal?: AbortSignal },
  ): Promise<Answered>
}

/** Why a request got no answer, without anything from the request itself. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'no answer in time'
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : 'unreachable'
}

export const unavailable = (message: string, context: Json): AdapterError =>
  new AdapterError('promotions.unavailable', message, {
    context: { provider: 'talon-one', ...context },
  })

/** Talon.One's Integration API under `base` (no trailing slash), the key in `Authorization: ApiKey-v1 <key>`. */
export function talonOneApi(opts: {
  base: string
  apiKey: string
  timeoutMs: number
}): TalonOneApi {
  const authorization = `ApiKey-v1 ${opts.apiKey}`
  return {
    async putSession(step, id, body, { dry = false, idempotencyKey, signal } = {}) {
      const url = `${opts.base}/v2/customer_sessions/${encodeURIComponent(id)}${dry ? '?dry=true' : ''}`
      const timeout = AbortSignal.timeout(opts.timeoutMs)
      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: {
            authorization,
            accept: 'application/json',
            'content-type': 'application/json',
            ...(idempotencyKey !== undefined && { 'idempotency-key': idempotencyKey }),
          },
          body: JSON.stringify(body),
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        })
        const text = await res.text()
        let parsed: unknown
        try {
          parsed = JSON.parse(text) as unknown
        } catch {
          parsed = undefined
        }
        return { status: res.status, body: parsed }
      } catch (error) {
        throw unavailable(`Talon.One did not answer ${step}: ${reasonOf(error)}`, { step })
      }
    },
  }
}
