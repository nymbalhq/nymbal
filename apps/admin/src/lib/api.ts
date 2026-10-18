import { getToken, refreshSession } from '@/lib/auth'

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type UrlQuery = Record<string, string | number | boolean | undefined | null>

const CSRF_HEADER = 'x-csrf-token'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let csrfToken: Promise<string> | null = null

/** The token `GET /api/csrf` answers for the API's `nymbal.csrf` cookie, fetched once and cached. */
function csrf(): Promise<string> {
  csrfToken ??= fetch('/api/csrf')
    .then(async (response) => {
      const body = (await response.json()) as { data?: { token?: string } }
      if (!response.ok || !body.data?.token) {
        throw new ApiError(
          'csrf.unavailable',
          `GET /api/csrf answered ${response.status}`,
          response.status,
        )
      }
      return body.data.token
    })
    .catch((err: unknown) => {
      csrfToken = null
      throw err
    })
  return csrfToken
}

async function isCsrfRejection(response: Response): Promise<boolean> {
  if (response.status !== 403) return false
  const body = (await response
    .clone()
    .json()
    .catch(() => ({}))) as { error?: { code?: string } }
  return body.error?.code === 'csrf.invalid'
}

/**
 * `fetch` with the CSRF token on unsafe methods. A refusal of the token (the cookie changed) fetches a fresh one and
 * retries once; a second refusal is returned as it is.
 */
export async function fetchWithCsrf(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!UNSAFE_METHODS.has(method)) return fetch(url, init)
  const send = async (): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set(CSRF_HEADER, await csrf())
    return fetch(url, { ...init, headers })
  }
  const response = await send()
  if (!(await isCsrfRejection(response))) return response
  csrfToken = null
  return send()
}

function buildUrl(path: string, query?: UrlQuery): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * Whether a call answered 401 with `sentToken` may be retried: once, after the shared refresh, or at once when a
 * concurrent refresh already replaced the token it sent. A session lost since it was sent is not refreshed again.
 */
async function renewedAfter401(sentToken: string | null): Promise<boolean> {
  const current = getToken()
  if (current !== sentToken) return current !== null
  return refreshSession()
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: UrlQuery,
  retried = false,
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const url = buildUrl(path, query)
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    // Only declare a JSON content type when a body is actually sent —
    // Fastify rejects empty bodies that claim application/json.
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const response = await fetchWithCsrf(url, init)

  if (response.status === 401) {
    // An /api/auth/* 401 is an answer about credentials, never an expired access token.
    if (!retried && !path.startsWith('/api/auth/') && (await renewedAfter401(token))) {
      return request<T>(method, path, body, query, true)
    }
    const errData = (await response.json().catch(() => ({}))) as Record<string, unknown>
    const errObj = (errData as { error?: { code?: string; message?: string } }).error
    throw new ApiError(errObj?.code ?? 'UNAUTHORIZED', errObj?.message ?? 'Unauthorized', 401)
  }

  const data = (await response.json()) as Record<string, unknown>

  if (!response.ok) {
    const errObj = (
      data as { error?: { code?: string; message?: string; context?: Record<string, unknown> } }
    ).error
    throw new ApiError(
      errObj?.code ?? 'UNKNOWN_ERROR',
      errObj?.message ?? `HTTP ${response.status}`,
      response.status,
      errObj?.context,
    )
  }

  // Unwrap { data: T } envelope
  if ('data' in data) {
    return data['data'] as T
  }

  return data as T
}

export const api = {
  get<T>(path: string, query?: UrlQuery): Promise<T> {
    return request<T>('GET', path, undefined, query)
  },
  post<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('POST', path, body)
  },
  patch<T>(path: string, body?: unknown): Promise<T> {
    return request<T>('PATCH', path, body)
  },
  delete<T>(path: string): Promise<T> {
    return request<T>('DELETE', path)
  },
}
