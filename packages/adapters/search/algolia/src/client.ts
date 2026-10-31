import { AdapterError, errorText } from '@nymbalhq/types'

export const REQUEST_TIMEOUT_MS = 5000
/** How long a write may take to be published before the call gives up on it. */
export const TASK_TIMEOUT_MS = 120_000

/** The search slot's config block: the adapter's `ctx.config`. */
export interface AlgoliaConnection {
  appId: string
  apiKey: string
  /** The index the catalogue lives in; `products` when unset. */
  indexName?: string
  /** One origin for reads and writes in place of Algolia's own hosts: a proxy, or a test server. */
  host?: string
}

export type Host = 'read' | 'write'

export interface AlgoliaClient {
  readonly writeBase: string
  readonly readBase: string
  /** The parsed JSON answer of a 2xx; an AdapterError for any other status or no answer within the timeout. */
  request<T>(host: Host, method: string, path: string, body?: unknown): Promise<T>
  /** Resolves once the task is published, so a read after it sees the write. */
  waitForTask(index: string, taskID: number): Promise<void>
}

/** The `/1/indexes/<name>` path of an index. */
export const indexPath = (name: string): string => `/1/indexes/${encodeURIComponent(name)}`

/** Thrown when Algolia could not be reached at all, as opposed to an answer refusing the call. */
export const UNREACHABLE = 'adapter.algolia_unreachable'
/** Thrown for an answer other than 2xx; its context carries the status. */
export const API_ERROR = 'adapter.algolia_api'
/** Thrown when a write was not published within TASK_TIMEOUT_MS. */
export const TASK_TIMEOUT = 'adapter.algolia_task_timeout'

function messageOf(body: unknown, text: string): string {
  const message = (body as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message !== '') return message
  return text === '' ? 'no error message' : text.slice(0, 200)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether the error, or any error under it, repeats `secret` (undici's header check quotes the value it refused). */
function repeats(error: unknown, secret: string): boolean {
  for (let e = error, depth = 0; e !== undefined && e !== null && depth < 8; depth++) {
    const { message, stack, cause } = e as { message?: unknown; stack?: unknown; cause?: unknown }
    if ([String(e), message, stack].some((t) => typeof t === 'string' && t.includes(secret))) {
      return true
    }
    e = cause
  }
  return false
}

export function createAlgoliaClient(connection: AlgoliaConnection): AlgoliaClient {
  const override = connection.host?.replace(/\/+$/, '')
  const writeBase = override ?? `https://${connection.appId}.algolia.net`
  const readBase = override ?? `https://${connection.appId}-dsn.algolia.net`
  const secret = typeof connection.apiKey === 'string' ? connection.apiKey : ''
  const redact = (text: string) => (secret === '' ? text : text.split(secret).join('***'))

  async function request<T>(host: Host, method: string, path: string, body?: unknown): Promise<T> {
    const base = host === 'read' ? readBase : writeBase
    let response: Response
    let text: string
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          'X-Algolia-Application-Id': connection.appId,
          'X-Algolia-API-Key': connection.apiKey,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      text = await response.text()
    } catch (error) {
      // An error that repeats the key is not kept as the cause: a logger would print it.
      const keep = secret === '' || !repeats(error, secret)
      throw new AdapterError(
        'algolia_unreachable',
        redact(`Algolia at ${base} did not answer ${method} ${path}: ${errorText(error)}`),
        { ...(keep && { cause: error }), context: { method, path } },
      )
    }
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown)
    } catch {
      // A proxy's error page is not JSON: the status still says what happened.
      parsed = undefined
    }
    if (!response.ok) {
      throw new AdapterError(
        'algolia_api',
        redact(
          `Algolia answered ${method} ${path} with ${response.status}: ${messageOf(parsed, redact(text))}`,
        ),
        { context: { method, path, status: response.status } },
      )
    }
    return parsed as T
  }

  return {
    writeBase,
    readBase,
    request,
    async waitForTask(index, taskID) {
      const deadline = Date.now() + TASK_TIMEOUT_MS
      let delay = 25
      for (;;) {
        const task = await request<{ status?: string }>(
          'write',
          'GET',
          `${indexPath(index)}/task/${taskID}`,
        )
        if (task?.status === 'published') return
        if (Date.now() + delay > deadline) {
          throw new AdapterError(
            'algolia_task_timeout',
            `Algolia did not publish task ${taskID} on ${index} within ${TASK_TIMEOUT_MS / 1000} s`,
            { context: { index, taskID } },
          )
        }
        await sleep(delay)
        delay = Math.min(delay * 2, 1000)
      }
    },
  }
}
