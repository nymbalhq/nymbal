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
    const response = await this.doFetch(method, path, body)

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

  private async doFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {}

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }

    const token = this.getAccessToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const cartToken = this.getCartToken?.()
    if (cartToken) {
      headers['Cookie'] = `nymbal.cart=${cartToken}`
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
