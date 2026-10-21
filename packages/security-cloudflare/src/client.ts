import { AdapterError, errorText } from '@nymbalhq/types'
import type { Phase, Rule } from './rules.js'

export const DEFAULT_API_BASE = 'https://api.cloudflare.com/client/v4'
export const REQUEST_TIMEOUT_MS = 5000

/** The `security.cloudflare` block: the adapter's `ctx.config`. */
export interface CloudflareConnection {
  zoneId?: string
  apiToken?: string
  apiBase?: string
}

export const CREDENTIALS_HINT =
  'check security.cloudflare.zoneId and apiToken (CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN): the token needs ' +
  'Zone › Zone › Read and Zone › Zone WAF › Edit on the zone'

/** The token or zone was refused (401 or 403), or the config has none. */
export class CloudflareCredentialsError extends AdapterError {
  constructor(detail: string, context: Record<string, unknown> = {}) {
    super('cloudflare_credentials', `Cloudflare: ${detail}; ${CREDENTIALS_HINT}`, { context })
  }
}

interface Envelope<T> {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
  result?: T
}

export interface Zone {
  id: string
  name?: string
  plan?: { legacy_id?: string; name?: string }
}

/** The Cloudflare v4 API as the adapter uses it: the zone, and one phase's entrypoint ruleset. */
export interface CloudflareClient {
  zone(): Promise<Zone>
  /** The phase's rules, or undefined when the phase was never written (404). */
  entrypoint(phase: Phase): Promise<Rule[] | undefined>
  /** Replaces the phase's rules whole, creating the entrypoint when it is absent. */
  putEntrypoint(phase: Phase, rules: Rule[]): Promise<void>
}

export function hasCredentials(
  connection: CloudflareConnection,
): connection is Required<Pick<CloudflareConnection, 'zoneId' | 'apiToken'>> &
  CloudflareConnection {
  return Boolean(connection.zoneId) && Boolean(connection.apiToken)
}

function apiErrors(body: unknown): string {
  const errors = (body as Envelope<unknown> | null)?.errors ?? []
  const messages = errors.map((e) => e.message).filter((m): m is string => typeof m === 'string')
  return messages.length > 0 ? messages.join('; ') : 'no error message'
}

export function createClient(connection: CloudflareConnection): CloudflareClient {
  const base = (connection.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const zonePath = `/zones/${encodeURIComponent(connection.zoneId ?? '')}`

  async function request(
    method: 'GET' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    if (!hasCredentials(connection)) {
      throw new CloudflareCredentialsError('no zone ID or API token is configured')
    }
    let response: Response
    let text: string
    try {
      response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${connection.apiToken}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      text = await response.text()
    } catch (error) {
      throw new AdapterError(
        'cloudflare_unreachable',
        `Cloudflare API at ${base} did not answer ${method} ${path}: ${errorText(error)}`,
        { cause: error, context: { method, path } },
      )
    }
    let parsed: unknown
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown)
    } catch {
      // A proxy's error page is not JSON: a failure still goes by its status, and a success is refused below.
      parsed = undefined
    }
    if (response.status === 401 || response.status === 403) {
      throw new CloudflareCredentialsError(
        `${method} ${path} was refused (${response.status}: ${apiErrors(parsed)})`,
        { status: response.status },
      )
    }
    if (response.ok && (typeof parsed !== 'object' || parsed === null)) {
      throw new AdapterError(
        'cloudflare_api',
        `Cloudflare answered ${method} ${path} with ${response.status} and no JSON body`,
        { context: { method, path, status: response.status } },
      )
    }
    return { status: response.status, body: parsed }
  }

  const failed = (method: string, path: string, status: number, body: unknown): AdapterError =>
    new AdapterError(
      'cloudflare_api',
      `Cloudflare answered ${method} ${path} with ${status}: ${apiErrors(body)}`,
      { context: { method, path, status } },
    )

  return {
    async zone() {
      const { status, body } = await request('GET', zonePath)
      if (status === 404) {
        throw new CloudflareCredentialsError(`zone ${connection.zoneId} was not found`, { status })
      }
      if (status !== 200) throw failed('GET', zonePath, status, body)
      return (body as Envelope<Zone>).result as Zone
    },
    async entrypoint(phase) {
      const path = `${zonePath}/rulesets/phases/${phase}/entrypoint`
      const { status, body } = await request('GET', path)
      if (status === 404) return undefined
      if (status !== 200) throw failed('GET', path, status, body)
      return (body as Envelope<{ rules?: Rule[] }>).result?.rules ?? []
    },
    async putEntrypoint(phase, rules) {
      const path = `${zonePath}/rulesets/phases/${phase}/entrypoint`
      const { status, body } = await request('PUT', path, { rules })
      if (status !== 200) throw failed('PUT', path, status, body)
    },
  }
}
