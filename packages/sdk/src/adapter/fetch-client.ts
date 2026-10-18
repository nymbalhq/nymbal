export class NymbalApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'NymbalApiError'
  }
}

export interface FetchClientOptions {
  baseUrl: string
  credentials?: RequestCredentials
  getAccessToken?: () => string | null
  getCartToken?: () => string | null
  onUnauthorized?: () => Promise<void>
}

const CSRF_HEADER = 'x-csrf-token'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

interface Envelope<T> {
  data?: T
  meta?: Record<string, unknown>
  error?: { code: string; message: string; context?: Record<string, unknown> }
}

export class FetchClient {
  private readonly baseUrl: string
  private readonly credentials: RequestCredentials
  private readonly getAccessToken: () => string | null
  private readonly getCartToken: (() => string | null) | undefined
  private readonly onUnauthorized: (() => Promise<void>) | undefined
  private handlingUnauthorized = false
  /** The token `GET /api/csrf` answered: the API's `nymbal.csrf` cookie, which this origin may not be able to read. */
  private csrfToken: Promise<string> | null = null

  constructor(options: FetchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.credentials = options.credentials ?? 'include'
    this.getAccessToken = options.getAccessToken ?? (() => null)
    this.getCartToken = options.getCartToken
    this.onUnauthorized = options.onUnauthorized
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestWithMeta<T>(method, path, body)).data
  }

  /** Like `request`, keeping the envelope's `meta` (pagination cursors live there). */
  async requestWithMeta<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T; meta: Record<string, unknown> }> {
    let response = await this.doFetch(method, path, body)

    // A stale token (the cookie was replaced or expired) is fetched again once; a second refusal is thrown.
    if (await this.isCsrfRejection(response)) {
      this.csrfToken = null
      response = await this.doFetch(method, path, body)
    }

    if (response.status === 401 && this.onUnauthorized && !this.handlingUnauthorized) {
      this.handlingUnauthorized = true
      try {
        await this.onUnauthorized()
      } finally {
        this.handlingUnauthorized = false
      }
      const retry = await this.doFetch(method, path, body)
      return this.parseResponse<T>(retry)
    }

    return this.parseResponse<T>(response)
  }

  private csrf(): Promise<string> {
    this.csrfToken ??= this.fetchCsrfToken().catch((err: unknown) => {
      this.csrfToken = null
      throw err
    })
    return this.csrfToken
  }

  private async fetchCsrfToken(): Promise<string> {
    const response = await globalThis.fetch(`${this.baseUrl}/api/csrf`, {
      method: 'GET',
      credentials: this.credentials,
    })
    const { data } = await this.parseResponse<{ token: string }>(response)
    return data.token
  }

  private async isCsrfRejection(response: Response): Promise<boolean> {
    if (response.status !== 403) return false
    const text = await response.clone().text()
    try {
      return (JSON.parse(text) as Envelope<unknown>).error?.code === 'csrf.invalid'
    } catch {
      return false
    }
  }

  private async doFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {}
    const cookies: string[] = []

    if (UNSAFE_METHODS.has(method.toUpperCase())) {
      const csrf = await this.csrf()
      headers[CSRF_HEADER] = csrf
      // Outside a browser there is no cookie jar to send the pair's cookie half; a browser drops this header.
      cookies.push(`nymbal.csrf=${csrf}`)
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const token = this.getAccessToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const cartToken = this.getCartToken?.()
    if (cartToken) {
      cookies.unshift(`nymbal.cart=${cartToken}`)
    }
    if (cookies.length > 0) {
      headers['Cookie'] = cookies.join('; ')
    }

    return globalThis.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  }

  private async parseResponse<T>(
    response: Response,
  ): Promise<{ data: T; meta: Record<string, unknown> }> {
    const text = await response.text()
    if (!text) {
      return { data: undefined as T, meta: {} }
    }

    const envelope = JSON.parse(text) as Envelope<T>

    if (envelope.error) {
      throw new NymbalApiError(
        envelope.error.code,
        envelope.error.message,
        response.status,
        envelope.error.context,
      )
    }

    return { data: envelope.data as T, meta: envelope.meta ?? {} }
  }
}
