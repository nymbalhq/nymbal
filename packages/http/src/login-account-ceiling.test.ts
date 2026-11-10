import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger, RequestContext } from '@nymbalhq/types'
import { createSecurityGuard } from './security-middleware.js'

// Failed logins for one account are capped across every client address at ten times the login rule (10 per 15 minutes
// built in, so 100). The first 100 failures reach the handler wherever they come from, so ten requests from anywhere
// lock nobody out; from the 101st every login for that account is refused before the handler, the right password
// included, until its window ends or a success below the ceiling clears the count. Each address here sends one login,
// so the address bucket (10 per address) never refuses and every refusal is the account's. At the ceiling one warn
// names the account and the count.

const CEILING = 100
const LOGIN = '/api/auth/login'
const WINDOW_MS = 15 * 60_000

interface Logged {
  level: string
  args: unknown[]
}

/** A logger whose children write to the same record, as the adapter's request loggers do. */
function recordingLogger(): { logger: Logger; logged: Logged[] } {
  const logged: Logged[] = []
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      logged.push({ level, args })
    }
  const logger = {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    fatal: at('fatal'),
    child: () => logger,
  } as unknown as Logger
  return { logger, logged }
}

function loginContext(ip: string, email: string, logger: Logger): RequestContext {
  return {
    method: 'POST',
    path: LOGIN,
    url: LOGIN,
    params: {},
    query: {},
    body: { email, password: 'a-password' },
    headers: {},
    cookies: {},
    requestId: 'req',
    correlationId: 'corr',
    logger,
    ip,
  }
}

interface Answer {
  status: number
  /** Whether the guard let the request reach the handler. */
  reached: boolean
  code: string | undefined
  retryAfter: number
}

interface Rig {
  logged: Logged[]
  /** One login through the guard as the adapter runs it: refused, or answered `status` by the handler. */
  login(ip: string, email: string, status: number): Answer
}

function rig(): Rig {
  const { logger, logged } = recordingLogger()
  const guard = createSecurityGuard(securitySchema.parse({ adapter: 'middleware', csrf: false }))
  return {
    logged,
    login(ip, email, status) {
      const ctx = loginContext(ip, email, logger)
      const refused = guard.admit(ctx)
      if (refused) {
        const body = refused.body as { error?: { code?: string } } | undefined
        return {
          status: refused.status,
          reached: false,
          code: body?.error?.code,
          retryAfter: Number(refused.headers?.['retry-after'] ?? 0),
        }
      }
      const done = guard.finish(ctx, { status, body: {} })
      return { status: done.status, reached: true, code: undefined, retryAfter: 0 }
    },
  }
}

/** The i-th client address of a run: distinct for i up to 900, and no octet is 100, so no address reads as the count. */
const address = (i: number): string => `10.${Math.floor(i / 90)}.${(i % 90) + 1}.7`
/** An address no run's failures came from. */
const FRESH = '192.0.2.55'

let runs = 0
/** A new account per call, with no digit in it, so a count in a log line cannot be read from the email. */
function fresh(label: string): string {
  runs += 1
  let n = runs
  let letters = ''
  while (n > 0) {
    letters = String.fromCharCode(97 + (n % 26)) + letters
    n = Math.floor(n / 26)
  }
  return `${label}-${letters}@ceiling.test`
}

/** The warns that name `email` and carry the ceiling's count. */
function ceilingWarns(logged: Logged[], email: string): Logged[] {
  return logged.filter((entry) => {
    const text = JSON.stringify(entry.args)
    return (
      entry.level === 'warn' &&
      text.toLowerCase().includes(email.toLowerCase()) &&
      new RegExp(`\\b${CEILING}\\b`).test(text)
    )
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('AC-3: one account’s failed logins are capped across every address at the ceiling', () => {
  it('AC-3: property: for k failures of one email from k distinct addresses, k from 1 to 300, the first 100 reach the handler and every later one is refused 429 rate_limit.block with retry-after; then the owner, from a fresh address with the email in other case and the right password, is refused exactly when k reached 100; one warn names the account and the count at the ceiling and none before it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 * CEILING }), (k) => {
        const { logged, login } = rig()
        const email = fresh('owner')

        const answers = Array.from({ length: k }, (_, i) => login(address(i), email, 401))

        expect(answers.map((a) => a.reached)).toEqual(answers.map((_, i) => i < CEILING))
        const refused = answers.slice(CEILING)
        expect(refused.map((a) => [a.status, a.code, a.retryAfter >= 1])).toEqual(
          refused.map(() => [429, 'rate_limit.block', true]),
        )
        const owner = login(FRESH, email.toUpperCase(), 200)
        expect([owner.status, owner.reached]).toEqual(k >= CEILING ? [429, false] : [200, true])
        expect(ceilingWarns(logged, email)).toHaveLength(k >= CEILING ? 1 : 0)
      }),
      { numRuns: 40, examples: [[CEILING - 1], [CEILING], [CEILING + 1], [3 * CEILING]] },
    )
  })

  it('AC-3: property: below the ceiling a success from a fresh address clears the account’s count: after k failures (k from 1 to 99) and that success, 100 more failures reach the handler and the next is refused', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: CEILING - 1 }), (k) => {
        const { login } = rig()
        const email = fresh('cleared')
        for (let i = 0; i < k; i += 1) login(address(i), email, 401)

        const success = login(FRESH, email, 200)
        const after = Array.from({ length: CEILING + 1 }, (_, i) =>
          login(address(k + i), email, 401),
        )

        expect(success.reached).toBe(true)
        expect(after.map((a) => a.reached)).toEqual(after.map((_, i) => i < CEILING))
      }),
      { numRuns: 25, examples: [[1], [CEILING - 1]] },
    )
  })

  it('AC-3: the end of the window reopens a capped account: refused at the 101st failure, a login from a fresh address once the window has passed reaches the handler', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    const { login } = rig()
    const email = fresh('reopened')
    for (let i = 0; i < CEILING; i += 1) login(address(i), email, 401)
    const capped = login(FRESH, email, 200)

    vi.setSystemTime(Date.now() + WINDOW_MS + 1)
    const reopened = login(FRESH, email, 200)

    expect([capped.status, capped.reached]).toEqual([429, false])
    expect(capped.retryAfter).toBeLessThanOrEqual(WINDOW_MS / 1000)
    expect([reopened.status, reopened.reached]).toEqual([200, true])
  })
})
