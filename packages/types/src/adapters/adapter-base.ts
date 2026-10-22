import type { Logger } from './http.js'

export type HealthStatus = 'healthy' | 'degraded' | 'down'

export interface HealthReport {
  status: HealthStatus
  detail?: string
}

/** How long a health check may run before it reports `down`. */
export const HEALTH_CHECK_TIMEOUT_MS = 5000

export interface BoundedHealthCheckOptions {
  /** `HEALTH_CHECK_TIMEOUT_MS` when not given. */
  timeoutMs?: number
  /** Values an error's message must never show (a URL's user, password or query values); each becomes `***`. */
  redact?: readonly string[]
}

/** An error's message for a report; an AggregateError (a refused connection to every address of a name) lists its own. */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error.message !== '') return error.message
  const inner = (error as { errors?: unknown }).errors
  if (Array.isArray(inner) && inner.length > 0) return inner.map(errorText).join('; ')
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : error.name
}

/**
 * The shortest value worth removing from text as a secret. A shorter one is too likely to be an ordinary word (a local
 * password of `nymbal`), whose removal garbles the text; user info and query strings go with the URL rewrite anyway.
 */
export const SECRET_MIN_LENGTH = 8

/**
 * The values in a connection URL that are credentials or may carry one: its password and its query values, and its
 * user unless `user` is false, each as written and decoded, if at least `SECRET_MIN_LENGTH` long. A user is worth
 * hiding in a driver's error, not in our own text.
 */
export function connectionSecrets(url: string, options: { user?: boolean } = {}): string[] {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return []
  }
  const raw = [
    ...(options.user === false ? [] : [parsed.username]),
    parsed.password,
    ...parsed.searchParams.values(),
  ]
  const decoded = raw.map((value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  })
  return [...new Set([...raw, ...decoded])].filter((value) => value.length >= SECRET_MIN_LENGTH)
}

/**
 * A connection URL as it may be printed: `scheme://host:port/path`, with no user, password, query or fragment. Text
 * that is not a URL comes back as `<unparsable url>`, since it may be a URL with a secret the parser could not read.
 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return '<unparsable url>'
  }
}

/**
 * Runs `check` within the bound. A check that throws is `down` with the error's message, every `redact` value in it
 * replaced; one still running when the bound passes is `down` with `timed out after <n> ms`, and its signal aborted.
 */
export async function boundedHealthCheck(
  check: (signal: AbortSignal) => Promise<HealthReport> | HealthReport,
  options: BoundedHealthCheckOptions = {},
): Promise<HealthReport> {
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<HealthReport>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve({ status: 'down', detail: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)
  })
  const failed = (error: unknown): HealthReport => {
    let detail = errorText(error)
    for (const secret of options.redact ?? []) {
      if (secret !== '') detail = detail.split(secret).join('***')
    }
    return { status: 'down', detail }
  }
  try {
    // Started inside a promise so a check that throws before returning one, or returns a plain report, is still
    // mapped rather than escaping the caller.
    const checked = Promise.resolve()
      .then(() => check(controller.signal))
      .catch(failed)
    return await Promise.race([checked, timedOut])
  } finally {
    clearTimeout(timer)
  }
}

export interface AdapterBase {
  /** What this adapter offers, for the app's per-slot report; each adapter answers for itself. */
  capabilities(): readonly string[]
  readonly producesEvents: readonly string[]
  readonly consumesEvents: readonly string[]
  initialize(config: unknown): Promise<void>
  healthCheck(): Promise<HealthReport>
}

/** The commerce slots a store's config names a provider for. */
export type CommerceSlot =
  | 'payments'
  | 'email'
  | 'reviews'
  | 'search'
  | 'analytics'
  | 'shipping'
  | 'tax'
  | 'ai'

/** Every slot an adapter package can fill: the commerce slots and the infrastructure primitives. */
export type Slot = CommerceSlot | 'documentStore' | 'eventBus' | 'media'

/**
 * What the kernel hands an adapter package's `createAdapter`. A package that serves more than one slot switches on
 * `slot`; `config` is a commerce slot's `config` block from nymbal.config.ts, or a primitive's connection block.
 */
export interface AdapterContext {
  slot: Slot
  config: Record<string, unknown>
  logger: Logger
  env: NodeJS.ProcessEnv
}

/**
 * One field of a slot's config block that a store owner may fill from the admin's Settings, as a provider package
 * declares it in its `settings` export. The config block wins, then `env`, then a saved value.
 */
export interface AdapterSetting {
  /** A dot path inside the slot's config block: `secretKey`, `smtp.pass`. */
  path: string
  label: string
  /** Stored encrypted and never shown again once saved. */
  secret: boolean
  /** The environment variable that sets the field when the config block does not. */
  env?: string
  /**
   * The adapter works without it (SMTP without authentication), so a secret left unset does not leave the slot
   * unconfigured.
   */
  optional?: boolean
}

/** What a provider package exports: `createAdapter`, and the fields it lets Settings fill. */
export interface ProviderPackageModule {
  createAdapter(ctx: AdapterContext): unknown
  settings?: readonly AdapterSetting[]
}
