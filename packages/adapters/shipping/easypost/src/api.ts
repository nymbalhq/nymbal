import { AdapterError } from '@nymbalhq/types'

export const DEFAULT_API_BASE = 'https://api.easypost.com/v2/'
export const DEFAULT_TIMEOUT_MS = 10_000

export type Json = Record<string, unknown>

export const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export interface EasyPostApi {
  /** The answer's JSON for a 2xx. A 4xx but 429 rejects `shipping.refused` with EasyPost's message; anything else `shipping.unavailable`. */
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json>
  /** The same request's status alone, for health; throws only when EasyPost could not be reached. */
  status(path: string, signal: AbortSignal): Promise<number>
}

function messageOf(body: unknown): string | undefined {
  const error = isObject(body) ? body['error'] : undefined
  const message = isObject(error) ? error['message'] : undefined
  return typeof message === 'string' && message !== '' ? message : undefined
}

/** Why a request got no answer, without anything from the request itself. */
function reasonOf(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'no answer in time'
  }
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause
  return typeof cause?.code === 'string' ? cause.code : 'unreachable'
}

/** EasyPost's API under `apiBase`, HTTP Basic with the key as the user and no password. */
export function easyPostApi(opts: {
  apiKey: string
  apiBase: string
  timeoutMs: number
}): EasyPostApi {
  const base = opts.apiBase.endsWith('/') ? opts.apiBase : `${opts.apiBase}/`
  const authorization = `Basic ${Buffer.from(`${opts.apiKey}:`, 'utf8').toString('base64')}`
  const urlOf = (path: string) => new URL(path, base)

  return {
    async request(method, path, body) {
      const what = `${method} ${path.split('?')[0]}`
      let status: number
      let answer: unknown
      try {
        const res = await fetch(urlOf(path), {
          method,
          headers: {
            authorization,
            accept: 'application/json',
            ...(body !== undefined && { 'content-type': 'application/json' }),
          },
          ...(body !== undefined && { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        })
        status = res.status
        const text = await res.text()
        try {
          answer = text === '' ? null : (JSON.parse(text) as unknown)
        } catch {
          answer = null
        }
      } catch (error) {
        throw new AdapterError(
          'shipping.unavailable',
          `EasyPost did not answer ${what}: ${reasonOf(error)}`,
          { context: { provider: 'easypost' } },
        )
      }
      if (status >= 200 && status < 300) {
        if (!isObject(answer)) {
          throw new AdapterError('shipping.unavailable', `EasyPost answered ${what} without JSON`, {
            context: { provider: 'easypost', status },
          })
        }
        return answer
      }
      if (status === 429 || status >= 500) {
        throw new AdapterError('shipping.unavailable', `EasyPost answered ${what} with ${status}`, {
          context: { provider: 'easypost', status },
        })
      }
      throw new AdapterError(
        'shipping.refused',
        `EasyPost refused ${what} (${status}): ${messageOf(answer) ?? 'no message'}`,
        { context: { provider: 'easypost', status } },
      )
    },

    async status(path, signal) {
      const res = await fetch(urlOf(path), {
        headers: { authorization, accept: 'application/json' },
        signal,
      })
      await res.body?.cancel()
      return res.status
    },
  }
}
