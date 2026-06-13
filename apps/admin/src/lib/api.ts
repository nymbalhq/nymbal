import { getToken, clearToken } from '@/lib/auth'

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public context?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

type QueryParams = Record<string, string | number | boolean | undefined | null>

function buildUrl(path: string, query?: QueryParams): string {
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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: QueryParams
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
  const response = await fetch(url, init)

  if (response.status === 401) {
    clearToken()
    const errData = await response.json().catch(() => ({})) as Record<string, unknown>
    const errObj = (errData as { error?: { code?: string; message?: string } }).error
    throw new ApiError(
      errObj?.code ?? 'UNAUTHORIZED',
      errObj?.message ?? 'Unauthorized',
      401
    )
  }

  const data = await response.json() as Record<string, unknown>

  if (!response.ok) {
    const errObj = (data as { error?: { code?: string; message?: string; context?: Record<string, unknown> } }).error
    throw new ApiError(
      errObj?.code ?? 'UNKNOWN_ERROR',
      errObj?.message ?? `HTTP ${response.status}`,
      response.status,
      errObj?.context
    )
  }

  // Unwrap { data: T } envelope
  if ('data' in data) {
    return data['data'] as T
  }

  return data as T
}

export const api = {
  get<T>(path: string, query?: QueryParams): Promise<T> {
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
