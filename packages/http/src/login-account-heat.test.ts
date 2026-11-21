import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { Logger, RequestContext } from '@nymbalhq/types'
import { createSecurityGuard, type SecurityGuard } from './security-middleware.js'

// Failed logins for one account from many addresses do not refuse its owner at the login rule's count; they are the
// operator's signal instead: one warn per window once the account's failures reach that count (10 per 15 minutes,
// built in). A success clears the account's count. Address buckets are not accounts and warn nothing. The account is
// refused only at ten times the rule's count (login-account-ceiling.test.ts), which no run here reaches: k stops at 30.

const LIMIT = 10
const LOGIN = '/api/auth/login'

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
    body: { email, password: 'wrong-password' },
    headers: {},
    cookies: {},
    requestId: 'req',
    correlationId: 'corr',
    logger,
    ip,
  }
}

interface Rig {
  guard: SecurityGuard
  logged: Logged[]
  /** One login through the guard as the adapter runs it: refused, or answered `status` by the handler. */
  login(ip: string, email: string, status: number): number
}

function rig(): Rig {
  const { logger, logged } = recordingLogger()
  const guard = createSecurityGuard(securitySchema.parse({ adapter: 'middleware', csrf: false }))
  return {
    guard,
    logged,
    login(ip, email, status) {
      const ctx = loginContext(ip, email, logger)
      const refused = guard.admit(ctx)
      if (refused) return refused.status
      return guard.finish(ctx, { status, body: {} }).status
    },
  }
}

/** The warns whose fields or message name `email`. */
function warnsNaming(logged: Logged[], email: string): Logged[] {
  return logged.filter(
    (entry) =>
      entry.level === 'warn' &&
      JSON.stringify(entry.args).toLowerCase().includes(email.toLowerCase()),
  )
}

const warns = (logged: Logged[]) => logged.filter((entry) => entry.level === 'warn')

let runs = 0
/** A new address per call, with no digit in it, so a count in a log line cannot be read from the email. */
function fresh(label: string): string {
  runs += 1
  let n = runs
  let letters = ''
  while (n > 0) {
    letters = String.fromCharCode(97 + (n % 26)) + letters
    n = Math.floor(n / 26)
  }
  return `${label}-${letters}@heat.test`
}

describe('AC-2: account heat is one warn per window', () => {
  it('AC-2: for k failures of one account from k distinct addresses, k from 1 to 30, the account is named in exactly one warn once k reaches 10 and in none below it, and that warn carries the count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 * LIMIT }), (k) => {
        const { logged, login } = rig()
        const email = fresh('owner')
        for (let i = 0; i < k; i += 1)
          login(`10.20.${Math.floor(i / 250)}.${(i % 250) + 1}`, email, 401)
        const named = warnsNaming(logged, email)

        expect(named.length).toBe(k >= LIMIT ? 1 : 0)
        expect(named.map((warn) => /\b10\b/.test(JSON.stringify(warn.args)))).toEqual(
          named.map(() => true),
        )
      }),
      { numRuns: 40, examples: [[LIMIT - 1], [LIMIT], [LIMIT + 1], [2 * LIMIT]] },
    )
  })

  it('AC-2: a success for the account clears its count: ten failures warn once, nine after the success add none, the tenth after it warns again', () => {
    const { logged, login } = rig()
    const email = fresh('cleared')
    const from = (n: number) => `10.21.0.${n}`

    for (let i = 1; i <= LIMIT; i += 1) login(from(i), email, 401)
    const afterFirstTen = warnsNaming(logged, email).length
    login(from(100), email, 200)
    for (let i = 11; i < 11 + LIMIT - 1; i += 1) login(from(i), email, 401)
    const afterNine = warnsNaming(logged, email).length
    login(from(50), email, 401)
    const afterTen = warnsNaming(logged, email).length

    expect(afterFirstTen).toBe(1)
    expect(afterNine).toBe(afterFirstTen)
    expect(afterTen).toBe(afterFirstTen + 1)
  })

  it('AC-2: addresses that fail at other emails, each email below the count, produce no warn, even once an address is past its own count', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: LIMIT - 1 }),
        fc.integer({ min: LIMIT, max: 2 * LIMIT }),
        (addresses, perEmail, perAddress) => {
          const { logged, login } = rig()
          const emails = Array.from({ length: perAddress }, () => fresh('sprayed'))
          // Each address tries `perAddress` emails; each email is tried from at most `perEmail` addresses.
          for (let a = 0; a < Math.min(addresses, perEmail); a += 1) {
            for (const email of emails) login(`10.22.${a}.1`, email, 401)
          }

          expect(warns(logged)).toEqual([])
        },
      ),
      { numRuns: 30 },
    )
  })
})
