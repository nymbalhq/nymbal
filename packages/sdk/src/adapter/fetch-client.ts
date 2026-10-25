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

/** Per request: headers sent beside the client's own. */
export interface RequestOptions {
  headers?: Record<string, string>
  /**
   * The token refresh itself (what `onUnauthorized` sends through this client): its 401 is thrown, never waited on or
   * sent again, so a refused refresh cannot wait on itself. An unmarked one that is refused is cut off after
   * 10 s with the original 401.
   */
  authRefresh?: boolean
}

/**
 * The longest a refused request waits on a refresh before its 401 is thrown: far beyond one healthy refresh round trip,
 * and the bound on a refresh that, unmarked, waits on itself.
 */
const REFRESH_WAIT_MS = 10_000

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
  /** The refresh a refused request started, which every request refused meanwhile waits on rather than its own. */
  private refreshing: Promise<void> | null = null
  /** The token `GET /api/csrf` answered: the API's `nymbal.csrf` cookie, which this origin may not be able to read. */
  private csrfToken: Promise<string> | null = null

  constructor(options: FetchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.credentials = options.credentials ?? 'include'
    this.getAccessToken = options.getAccessToken ?? (() => null)
    this.getCartToken = options.getCartToken
    this.onUnauthorized = options.onUnauthorized
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    return (await this.requestWithMeta<T>(method, path, body, options)).data
  }

  /** Like `request`, keeping the envelope's `meta` (pagination cursors live there). */
  async requestWithMeta<T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<{ data: T; meta: Record<string, unknown> }> {
    // Read before the first await: the refresh, if any, in flight when this request was sent.
    const sentDuring = this.refreshing
    let { response, bearer } = await this.doFetch(method, path, body, options)

    // A stale token (the cookie was replaced or expired) is fetched again once; a second refusal is thrown.
    if (await this.isCsrfRejection(response)) {
      this.csrfToken = null
      ;({ response, bearer } = await this.doFetch(method, path, body, options))
    }

    if (response.status === 401 && this.onUnauthorized && options.authRefresh !== true) {
      const pending = this.refreshing
      const retry = async () =>
        this.parseResponse<T>((await this.doFetch(method, path, body, options)).response)
      if (pending === null && this.getAccessToken() !== bearer) {
        // A refresh that ended after this was sent has replaced its token already.
        return retry()
      }
      if (pending !== null && pending === sentDuring) {
        // Sent during the refresh with the token it replaces: sent again once it has, and only if it did.
        if ((await this.waitFor(pending)) && this.getAccessToken() !== bearer) return retry()
      } else if (await this.waitFor(pending ?? this.refresh(this.onUnauthorized))) {
        // Every request refused with the old token waits on the one refresh and is sent again once.
        return retry()
      }
    }

    return this.parseResponse<T>(response)
  }

  /** Whether the refresh ended within `REFRESH_WAIT_MS`; a refresh that fails throws here, as it always has. */
  private async waitFor(refresh: Promise<void>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), REFRESH_WAIT_MS)
    })
    try {
      return await Promise.race([refresh.then(() => true as const), bound])
    } finally {
      clearTimeout(timer)
    }
  }

  private refresh(onUnauthorized: () => Promise<void>): Promise<void> {
    const refresh = Promise.resolve()
      .then(onUnauthorized)
      .finally(() => {
        this.refreshing = null
      })
    this.refreshing = refresh
    return refresh
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

  private async doFetch(
    method: string,
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<{ response: Response; bearer: string | null }> {
    const headers: Record<string, string> = { ...options.headers }
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

    const response = await globalThis.fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      credentials: this.credentials,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    return { response, bearer: token }
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
