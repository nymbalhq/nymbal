import type { Logger } from '@nymbalhq/types'

// The check a sign-in makes against the merchant's old platform, for an address the store has no password for, while
// old passwords are honoured. One documented contract: POST { email, password } with a shared bearer, answered
// 200 { valid, customer? }. Every limit here is per process and in memory, as the HTTP layer's are.

export const REMOTE_SECRET_ENV = 'NYMBAL_LEGACY_AUTH_SECRET'
export const REMOTE_SECRET_MIN_LENGTH = 32
/** The default of the config's `remote.timeoutMs`. */
export const REMOTE_TIMEOUT_MS = 5000
/** At phpass's own cut, so a caller-chosen password cannot slow the old platform's answer, and so the decoy, much. */
export const REMOTE_PASSWORD_MAX_BYTES = 256
export const REMOTE_EMAIL_MAX_BYTES = 254
export const REMOTE_ADDRESS_CAP = 5
export const REMOTE_ADDRESS_WINDOW_MS = 3_600_000
export const REMOTE_BREAKER_FAILURES = 5
export const REMOTE_BREAKER_WINDOW_MS = 60_000
export const REMOTE_BREAKER_OPEN_MS = 600_000
export const REMOTE_DECOY_SAMPLES = 20
export const REMOTE_DECOY_MAX_AGE_MS = 600_000
/** The newest samples kept whatever their age, so a quiet store never falls back to the constant default. */
export const REMOTE_DECOY_KEEP = 5
export const REMOTE_DECOY_DEFAULT_MS = 200

const PROFILE_FIELDS = ['firstName', 'lastName', 'phone'] as const
const PROFILE_FIELD_MAX_LENGTH = 200
/** The cap map's size that triggers the first sweep of expired entries, as the HTTP limiter's does. */
const PRUNE_THRESHOLD = 1024

export interface RemoteProfile {
  firstName?: string
  lastName?: string
  phone?: string
}

export type RemoteAnswer =
  | { status: 'ok'; profile: RemoteProfile }
  | { status: 'bad' }
  /** A request was sent and failed. */
  | { status: 'unavailable' }
  /** Nothing was sent. */
  | { status: 'skipped'; why: 'input' | 'cap' | 'breaker' }

export interface OldPlatformCheck {
  check(email: string, password: string): Promise<RemoteAnswer>
  /** How long a refusal that sent nothing waits. */
  decoyMs(): number
}

export interface OldPlatformCheckOptions {
  url: string
  secret: string
  logger: Logger
  timeoutMs?: number
  fetch?: typeof fetch
  now?: () => number
  random?: () => number
}

const UNAVAILABLE: RemoteAnswer = { status: 'unavailable' }

/** What a request came to, and whether its failure says the old platform is down or overloaded. */
interface Outcome {
  answer: RemoteAnswer
  counts: boolean
  /** A status or an error's name for the debug line; never anything the request carried. */
  reason?: string
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

function profileOf(customer: unknown): RemoteProfile {
  const profile: RemoteProfile = {}
  if (typeof customer !== 'object' || customer === null) return profile
  for (const field of PROFILE_FIELDS) {
    const value = (customer as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.length <= PROFILE_FIELD_MAX_LENGTH)
      profile[field] = value
  }
  return profile
}

function answerOf(body: unknown): RemoteAnswer {
  if (typeof body !== 'object' || body === null) return UNAVAILABLE
  const { valid, customer } = body as Record<string, unknown>
  if (valid === false) return { status: 'bad' }
  if (valid !== true) return UNAVAILABLE
  return { status: 'ok', profile: profileOf(customer) }
}

function errorReason(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code
  return typeof code === 'string' ? `${name} ${code}` : name
}

export function createOldPlatformCheck(opts: OldPlatformCheckOptions): OldPlatformCheck {
  const { url, secret, logger } = opts
  const timeoutMs = opts.timeoutMs ?? REMOTE_TIMEOUT_MS
  const fetchOf = opts.fetch ?? fetch
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random

  const caps = new Map<string, { count: number; resetAt: number }>()
  let pruneAt = PRUNE_THRESHOLD
  let failures: number[] = []
  let openedAt: number | undefined
  const samples: Array<{ ms: number; at: number }> = []

  /** Refused before anything is counted: what `register` would refuse, a spaced copy of an address, or caller-sized. */
  function acceptable(email: string, sent: string, password: string): boolean {
    return (
      email.includes('@') &&
      email === email.trim() &&
      bytes(sent) <= REMOTE_EMAIL_MAX_BYTES &&
      bytes(password) <= REMOTE_PASSWORD_MAX_BYTES
    )
  }

  function breakerOpen(t: number): boolean {
    if (openedAt === undefined) return false
    if (t < openedAt + REMOTE_BREAKER_OPEN_MS) return true
    openedAt = undefined
    failures = []
    return false
  }

  function failed(t: number): void {
    // A request in flight when the breaker opened finishes uncounted.
    if (breakerOpen(t)) return
    failures = failures.filter((at) => t - at < REMOTE_BREAKER_WINDOW_MS)
    failures.push(t)
    if (failures.length < REMOTE_BREAKER_FAILURES) return
    openedAt = t
    failures = []
    logger.warn(
      { failures: REMOTE_BREAKER_FAILURES, openMs: REMOTE_BREAKER_OPEN_MS },
      'the old platform failed repeatedly; sign-ins are not checked against it for a while',
    )
  }

  /** Takes one of the address's slots, before the request is awaited, so checks in flight together cannot pass it. */
  function takeSlot(key: string, t: number): boolean {
    const entry = caps.get(key)
    if (entry !== undefined && entry.resetAt > t) {
      if (entry.count >= REMOTE_ADDRESS_CAP) return false
      entry.count += 1
      return true
    }
    // Keys are caller-chosen, so expired entries are swept once the map reaches `pruneAt`.
    if (caps.size >= pruneAt) {
      for (const [k, e] of caps) if (e.resetAt <= t) caps.delete(k)
      pruneAt = Math.max(PRUNE_THRESHOLD, caps.size * 2)
    }
    caps.set(key, { count: 1, resetAt: t + REMOTE_ADDRESS_WINDOW_MS })
    return true
  }

  async function ask(email: string, password: string): Promise<Outcome> {
    try {
      const res = await fetchOf(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
        // A redirect is answered as a plain non-200, so the password goes only to the configured host.
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (res.status !== 200) {
        await res.body?.cancel()
        // Only what a down or overloaded old platform answers: a caller can earn a 4xx with its own input.
        const counts = res.status >= 500 || res.status === 429
        return { answer: UNAVAILABLE, counts, reason: `status ${res.status}` }
      }
      const answer = answerOf(await res.json())
      return answer === UNAVAILABLE
        ? { answer, counts: false, reason: 'outside the contract' }
        : { answer, counts: false }
    } catch (err) {
      // A body that is not JSON is the endpoint's own fault; a timeout or a dropped connection is an outage.
      return {
        answer: UNAVAILABLE,
        counts: !(err instanceof SyntaxError),
        reason: errorReason(err),
      }
    }
  }

  return {
    async check(email, password) {
      const sent = email.toLowerCase()
      if (!acceptable(email, sent, password)) return { status: 'skipped', why: 'input' }
      const started = now()
      if (breakerOpen(started)) return { status: 'skipped', why: 'breaker' }
      if (!takeSlot(sent, started)) return { status: 'skipped', why: 'cap' }
      const outcome = await ask(sent, password)
      const ended = now()
      if (outcome.answer.status === 'unavailable') {
        logger.debug({ reason: outcome.reason }, 'the old platform check was unavailable')
        if (outcome.counts) failed(ended)
      } else {
        samples.push({ ms: ended - started, at: ended })
        if (samples.length > REMOTE_DECOY_SAMPLES) samples.shift()
      }
      return outcome.answer
    },

    decoyMs() {
      const t = now()
      const fromKept = samples.length - REMOTE_DECOY_KEEP
      const eligible = samples.filter(
        (s, i) => i >= fromKept || t - s.at <= REMOTE_DECOY_MAX_AGE_MS,
      )
      if (eligible.length === 0) return REMOTE_DECOY_DEFAULT_MS
      return eligible[Math.floor(random() * eligible.length)]!.ms
    },
  }
}
