import { randomBytes } from 'node:crypto'

// A shopper's HTTP client for a store and its storefront, shared by `nymbal verify` and `nymbal heartbeat`: bounded
// requests, the API's double-submit CSRF pair, the cookies the API sets, and the page checks. A failed request or
// check throws `StepFailed`, whose message is the step's detail.

/** A step that cannot pass: its message is the step's detail. */
export class StepFailed extends Error {}

const JAVASCRIPT = /^(text|application)\/javascript\s*(;|$)/i
const HTML = /^text\/html\s*(;|$)/i

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
}
const unescapeHtml = (html: string) =>
  html.replace(/&(?:amp|lt|gt|quot|#39|#x27);/gi, (e) => ENTITIES[e.toLowerCase()] ?? e)

/** Whether a page shows `text`, as written or HTML-escaped. */
export const pageShows = (html: string, text: string): boolean =>
  html.includes(text) || unescapeHtml(html).includes(text)

const messageOf = (err: unknown): string => {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'no answer in time'
    const cause = (err as { cause?: unknown }).cause
    const why = cause instanceof Error && cause.message !== err.message ? `: ${cause.message}` : ''
    return `${err.message}${why}`
  }
  return String(err)
}

export interface PageAnswer {
  status: number
  type: string
  text: string
}

/** An API answer: the envelope's `data`, and its `error` when it refused. */
export interface ApiAnswer {
  status: number
  data: unknown
  error?: { code?: unknown; message?: unknown; context?: Record<string, unknown> }
}

/** The API's answer body. */
type Envelope = { data?: unknown; error?: ApiAnswer['error'] }

export interface StoreClientOptions {
  fetch?: typeof fetch
  /** Per request; default 10 s. */
  requestTimeoutMs?: number
}

export interface StoreClient {
  request(url: URL, init?: RequestInit): Promise<PageAnswer>
  api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiAnswer>
  /** An API call that must answer 200; its `data`. */
  api200(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown>
  /** An HTML page that must answer 200 text/html. */
  htmlPage(url: URL): Promise<string>
  /** Every same-origin `<script src>` the page names must be served as JavaScript; another origin's is not fetched. */
  scriptsServed(html: string, pageUrl: URL): Promise<number>
}

export function createStoreClient(
  target: { apiUrl: string; storefrontUrl?: string },
  options: StoreClientOptions = {},
): StoreClient {
  const doFetch = options.fetch ?? fetch
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000
  const storefrontOrigin =
    target.storefrontUrl === undefined ? undefined : new URL(target.storefrontUrl).origin

  // The API's double-submit CSRF pair, and the cart cookie it sets.
  const csrf = randomBytes(32).toString('hex')
  const jar = new Map<string, string>([['nymbal.csrf', csrf]])

  async function request(url: URL, init: RequestInit = {}): Promise<PageAnswer> {
    const label = `${init.method ?? 'GET'} ${url.pathname}`
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) })
      const text = await res.text()
      return { status: res.status, type: res.headers.get('content-type') ?? '', text }
    } catch (err) {
      throw new StepFailed(`${label}: ${messageOf(err)}`)
    }
  }

  async function api(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<ApiAnswer> {
    const url = new URL(path, target.apiUrl)
    const label = `${method} ${url.pathname}`
    try {
      const res = await doFetch(url, {
        method,
        headers: {
          cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
          'x-csrf-token': csrf,
          ...(body !== undefined && { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      })
      for (const set of res.headers.getSetCookie()) {
        const pair = set.split(';')[0] ?? ''
        const eq = pair.indexOf('=')
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
      const text = await res.text()
      let envelope: Envelope | null = null
      try {
        envelope = text === '' ? null : (JSON.parse(text) as Envelope)
      } catch {
        envelope = null
      }
      return {
        status: res.status,
        data: envelope?.data ?? null,
        ...(envelope?.error !== undefined && { error: envelope.error }),
      }
    } catch (err) {
      throw new StepFailed(`${label}: ${messageOf(err)}`)
    }
  }

  async function api200(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<unknown> {
    const answer = await api(method, path, body, headers)
    if (answer.status !== 200) {
      throw new StepFailed(
        `${method} ${new URL(path, target.apiUrl).pathname} answered ${answer.status}`,
      )
    }
    return answer.data
  }

  async function htmlPage(url: URL): Promise<string> {
    const page = await request(url)
    if (page.status !== 200) throw new StepFailed(`GET ${url.pathname} answered ${page.status}`)
    if (!HTML.test(page.type)) {
      throw new StepFailed(`GET ${url.pathname} is ${page.type || 'untyped'}, not text/html`)
    }
    return page.text
  }

  async function scriptsServed(html: string, pageUrl: URL): Promise<number> {
    const sources = new Set<string>()
    for (const match of html.matchAll(
      /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )) {
      const src = match[1] ?? match[2] ?? match[3] ?? ''
      if (src === '') continue
      const url = new URL(src, pageUrl)
      if (url.origin === storefrontOrigin) sources.add(url.href)
    }
    for (const href of sources) {
      const url = new URL(href)
      const script = await request(url)
      if (script.status !== 200) {
        throw new StepFailed(`script ${url.pathname} answered ${script.status}`)
      }
      if (!JAVASCRIPT.test(script.type)) {
        throw new StepFailed(
          `script ${url.pathname} is ${script.type || 'untyped'}, not JavaScript`,
        )
      }
    }
    return sources.size
  }

  return { request, api, api200, htmlPage, scriptsServed }
}
