import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, withoutAuthRateRules } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { login, primedShopper } from '../support/security.js'

// P1-06 AC-5 and AC-6 on a served kernel (SQLite) with no user rule for `/api/auth/login`, so the built-in default
// (10 per 15m, block) applies, keyed by IP and by the lowercased email; failures count, a success clears the email
// bucket only, and the IP bucket expires with its window. Kills: no default login rule, the guard running after the
// handler, successes counted against the limit, a success clearing the IP bucket, no per-email key, `trustProxy`
// defaulting to true.

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
  const email = `login-${randomUUID()}@p1-06.test`
  const { customer } = await s.kernel.services.auth.register({ email, password: PASSWORD })
  return { email, id: customer.id }
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
      const sprayed = (i: number): string => `spray5b-${i}-${randomUUID()}@p1-06.test`

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

  it('AC-6a: with trustProxy true, eleven wrong logins for one email from eleven X-Forwarded-For addresses give 429 on the 11th; eleven wrong logins for eleven emails from eleven addresses all answer 401', async () => {
    const trusting = (c: NymbalConfig): NymbalConfig => {
      const base = withoutAuthRateRules(c)
      return { ...base, http: { ...base.http, trustProxy: true } }
    }
    await withServed(trusting, async (s) => {
      const customer = await registered(s)
      const shop = await primedShopper(s.baseUrl)

      const control: number[] = []
      for (let i = 0; i <= LIMIT; i += 1) {
        const answer = await login(
          s.baseUrl,
          shop.jar,
          { email: `other-${i}-${randomUUID()}@p1-06.test`, password: WRONG },
          { 'x-forwarded-for': `10.1.0.${i + 1}` },
        )
        control.push(answer.status)
      }
      expect(control).toEqual(Array.from({ length: LIMIT + 1 }, () => 401))

      const oneEmail: number[] = []
      for (let i = 0; i <= LIMIT; i += 1) {
        const answer = await login(
          s.baseUrl,
          shop.jar,
          // The per-account key is the lowercased email, so the case changes nothing.
          { email: i % 2 === 0 ? customer.email : customer.email.toUpperCase(), password: WRONG },
          { 'x-forwarded-for': `10.2.0.${i + 1}` },
        )
        oneEmail.push(answer.status)
      }
      expect(oneEmail.slice(0, LIMIT)).toEqual(Array.from({ length: LIMIT }, () => 401))
      expect(oneEmail[LIMIT]).toBe(429)
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
          { email: `spray-${i}-${randomUUID()}@p1-06.test`, password: WRONG },
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
