import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, withoutAuthRateRules } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { login, primedShopper } from '../support/security.js'

// AC-1, AC-5 and AC-6 on a served kernel (SQLite) with no user rule for `/api/auth/login`, so the built-in default
// (10 per 15m, block) applies. Only the address bucket refuses: failures count under the address and under the
// lowercased email, a success clears the email's count only, and the address bucket expires with its window. Failures
// for one email from other addresses never refuse its owner.

const PASSWORD = 'correct-horse-battery'
const WRONG = 'wrong-password'
const LIMIT = 10

async function served(configure: (c: NymbalConfig) => NymbalConfig): Promise<ServedKernel> {
  const kernel = await createKernel({ dialect: 'sqlite', configure })
  return serveKernel(kernel)
}

async function withServed(
  configure: (c: NymbalConfig) => NymbalConfig,
  body: (s: ServedKernel, raw: RawReader) => Promise<void>,
): Promise<void> {
  const s = await served(configure)
  const raw = openRaw(s.kernel.dialect, s.kernel.target)
  try {
    await body(s, raw)
  } finally {
    await raw.close()
    await s.stop()
  }
}

async function registered(s: ServedKernel): Promise<{ email: string; id: string }> {
  const email = `login-${randomUUID()}@security.test`
  const { customer } = await s.kernel.services.auth.register({ email, password: PASSWORD })
  return { email, id: customer.id }
}

/**
 * The built-in login limits behind one proxy hop: the socket peer (127.0.0.1) is the proxy, and the X-Forwarded-For
 * entry it appended is the client.
 */
function oneHop(c: NymbalConfig): NymbalConfig {
  const base = withoutAuthRateRules(c)
  return { ...base, http: { ...base.http, trustProxy: 1 } }
}

function eventsNaming(raw: RawReader, email: string): Promise<number> {
  return raw.count('events', 'envelope LIKE ?', [`%${email}%`])
}

describe('login rate limit (built-in default)', () => {
  it('AC-5: from one IP, 10 wrong-password logins answer 401; the 11th, with the right password, answers 429 rate_limit.block with retry-after >= 1 and leaves no refresh-token row or event behind', async () => {
    await withServed(withoutAuthRateRules, async (s, raw) => {
      const customer = await registered(s)
      const shop = await primedShopper(s.baseUrl)

      const statuses: number[] = []
      for (let i = 0; i < LIMIT; i += 1) {
        statuses.push(
          (await login(s.baseUrl, shop.jar, { email: customer.email, password: WRONG })).status,
        )
      }
      expect(statuses).toEqual(Array.from({ length: LIMIT }, () => 401))

      const tokensBefore = await raw.count('refresh_tokens', 'customer_id = ?', [customer.id])
      const eventsBefore = await eventsNaming(raw, customer.email)

      const blocked = await login(s.baseUrl, shop.jar, {
        email: customer.email,
        password: PASSWORD,
      })
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(429)
      expect(blocked.body.error?.code).toBe('rate_limit.block')
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)

      expect(await raw.count('refresh_tokens', 'customer_id = ?', [customer.id])).toBe(tokensBefore)
      expect(await eventsNaming(raw, customer.email)).toBe(eventsBefore)
    })
  })

  it('AC-5: 15 successful logins in a row from one IP all answer 200, because successes are not counted; 10 failures after them still answer 401 and the 11th 429', async () => {
    await withServed(withoutAuthRateRules, async (s, raw) => {
      const customer = await registered(s)
      const shop = await primedShopper(s.baseUrl)
      const tokensBefore = await raw.count('refresh_tokens', 'customer_id = ?', [customer.id])
      const runs = LIMIT + 5

      const statuses: number[] = []
      for (let i = 0; i < runs; i += 1) {
        statuses.push(
          (await login(s.baseUrl, shop.jar, { email: customer.email, password: PASSWORD })).status,
        )
      }
      expect(statuses).toEqual(Array.from({ length: runs }, () => 200))
      expect(await raw.count('refresh_tokens', 'customer_id = ?', [customer.id])).toBe(
        tokensBefore + runs,
      )

      // The limiter is live on this server, and the successes added nothing to either bucket: a full run of failures
      // still fits before the 429.
      const failures: number[] = []
      for (let i = 0; i <= LIMIT; i += 1) {
        failures.push(
          (await login(s.baseUrl, shop.jar, { email: customer.email, password: WRONG })).status,
        )
      }
      expect(failures.slice(0, LIMIT)).toEqual(Array.from({ length: LIMIT }, () => 401))
      expect(failures[LIMIT]).toBe(429)
    })
  })

  it('AC-5b: from one IP, 9 wrong logins at 9 emails, a successful login to another account, and a wrong login at a 10th email answer 401, 200, 401; the success does not clear the IP bucket, so the next login, right password included, answers 429', async () => {
    await withServed(withoutAuthRateRules, async (s) => {
      const own = await registered(s)
      const next = await registered(s)
      const shop = await primedShopper(s.baseUrl)
      const sprayed = (i: number): string => `spray5b-${i}-${randomUUID()}@security.test`

      const before: number[] = []
      for (let i = 0; i < LIMIT - 1; i += 1) {
        before.push(
          (await login(s.baseUrl, shop.jar, { email: sprayed(i), password: WRONG })).status,
        )
      }
      expect(before).toEqual(Array.from({ length: LIMIT - 1 }, () => 401))

      const success = await login(s.baseUrl, shop.jar, { email: own.email, password: PASSWORD })
      expect(success.status, JSON.stringify(success.body)).toBe(200)

      const tenth = await login(s.baseUrl, shop.jar, { email: sprayed(LIMIT), password: WRONG })
      expect(tenth.status, JSON.stringify(tenth.body)).toBe(401)

      // Ten failures sit in the IP bucket whatever the success did to the email buckets.
      const blocked = await login(s.baseUrl, shop.jar, { email: next.email, password: PASSWORD })
      expect(blocked.status, JSON.stringify(blocked.body)).toBe(429)
      expect(blocked.body.error?.code).toBe('rate_limit.block')
      expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    })
  })

  it('AC-1: with trustProxy 1, for 1 to 10 attacker addresses sharing ten wrong logins for one email, the owner signing in from an eleventh address answers 200 with a new session, and a further wrong login for that email from an attacker address answers 401, or 429 only when that address holds ten failures of its own', async () => {
    await withServed(oneHop, async (s, raw) => {
      const shop = await primedShopper(s.baseUrl)
      let run = 0
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: LIMIT }), async (spread) => {
          run += 1
          const owner = await registered(s)
          const attackers = Array.from({ length: spread }, (_, i) => `10.30.${run}.${i + 1}`)
          const failuresAt = new Map<string, number>()
          const wrong: number[] = []
          for (let i = 0; i < LIMIT; i += 1) {
            const from = attackers[i % spread]!
            const answer = await login(
              s.baseUrl,
              shop.jar,
              // The account count is the lowercased email's, so the case changes nothing.
              { email: i % 2 === 0 ? owner.email : owner.email.toUpperCase(), password: WRONG },
              { 'x-forwarded-for': from },
            )
            wrong.push(answer.status)
            failuresAt.set(from, (failuresAt.get(from) ?? 0) + 1)
          }
          const sessionsBefore = await raw.count('refresh_tokens', 'customer_id = ?', [owner.id])
          const signIn = await login(
            s.baseUrl,
            shop.jar,
            { email: owner.email, password: PASSWORD },
            { 'x-forwarded-for': `10.31.${run}.1` },
          )
          const sessionsAfter = await raw.count('refresh_tokens', 'customer_id = ?', [owner.id])
          const again = await login(
            s.baseUrl,
            shop.jar,
            { email: owner.email, password: WRONG },
            { 'x-forwarded-for': attackers[0]! },
          )

          expect(wrong).toEqual(wrong.map(() => 401))
          expect(signIn.status, JSON.stringify(signIn.body)).toBe(200)
          expect(signIn.body.data?.customer.id).toBe(owner.id)
          expect(sessionsAfter).toBe(sessionsBefore + 1)
          expect(again.status).toBe(failuresAt.get(attackers[0]!)! >= LIMIT ? 429 : 401)
        }),
        { numRuns: 4, examples: [[1], [2], [LIMIT]] },
      )
    })
  }, 90_000)

  it("AC-1: with trustProxy 1, ten wrong logins from one address across ten emails make that address's eleventh login, the right password included, 429 rate_limit.block, while the same account signs in from another address", async () => {
    await withServed(oneHop, async (s) => {
      const owner = await registered(s)
      const shop = await primedShopper(s.baseUrl)
      const sprayer = '10.32.0.1'

      const sprayed: number[] = []
      for (let i = 0; i < LIMIT; i += 1) {
        const answer = await login(
          s.baseUrl,
          shop.jar,
          { email: `spray1-${i}-${randomUUID()}@security.test`, password: WRONG },
          { 'x-forwarded-for': sprayer },
        )
        sprayed.push(answer.status)
      }
      const fromSprayer = await login(
        s.baseUrl,
        shop.jar,
        { email: owner.email, password: PASSWORD },
        { 'x-forwarded-for': sprayer },
      )
      const fromElsewhere = await login(
        s.baseUrl,
        shop.jar,
        { email: owner.email, password: PASSWORD },
        { 'x-forwarded-for': '10.32.0.2' },
      )

      expect(sprayed).toEqual(sprayed.map(() => 401))
      expect(fromSprayer.status, JSON.stringify(fromSprayer.body)).toBe(429)
      expect(fromSprayer.body.error?.code).toBe('rate_limit.block')
      expect(Number(fromSprayer.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect(fromElsewhere.status, JSON.stringify(fromElsewhere.body)).toBe(200)
    })
  })

  it('AC-6a: with trustProxy 1, eleven wrong logins for eleven emails from eleven X-Forwarded-For addresses all answer 401', async () => {
    await withServed(oneHop, async (s) => {
      const shop = await primedShopper(s.baseUrl)

      const control: number[] = []
      for (let i = 0; i <= LIMIT; i += 1) {
        const answer = await login(
          s.baseUrl,
          shop.jar,
          { email: `other-${i}-${randomUUID()}@security.test`, password: WRONG },
          { 'x-forwarded-for': `10.1.0.${i + 1}` },
        )
        control.push(answer.status)
      }
      expect(control).toEqual(Array.from({ length: LIMIT + 1 }, () => 401))
    })
  })

  it('AC-6b: with trustProxy at its default, X-Forwarded-For does not change the IP bucket: eleven wrong logins for eleven emails from eleven claimed addresses give 429 on the 11th', async () => {
    await withServed(withoutAuthRateRules, async (s) => {
      const shop = await primedShopper(s.baseUrl)

      const statuses: number[] = []
      for (let i = 0; i <= LIMIT; i += 1) {
        const answer = await login(
          s.baseUrl,
          shop.jar,
          { email: `spray-${i}-${randomUUID()}@security.test`, password: WRONG },
          { 'x-forwarded-for': `10.3.0.${i + 1}` },
        )
        statuses.push(answer.status)
      }
      expect(statuses.slice(0, LIMIT)).toEqual(Array.from({ length: LIMIT }, () => 401))
      expect(statuses[LIMIT]).toBe(429)
      expect(s.kernel.config.http.trustProxy).toBe(false)
    })
  })
})
