import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createKernel, withoutAuthRateRules } from '../support/kernel.js'
import {
  change,
  login,
  mailedToken,
  me,
  openPasswordStore,
  registered,
  reset,
  neverIssued,
  type PasswordStore,
} from '../support/password-reset.js'

// The account ceiling over HTTP, on a served kernel (SQLite) behind the loopback proxy, so X-Forwarded-For is each
// request's client address. The login rule is set to RULE per address, so the account ceiling, ten times the rule, is
// reached in RULE * 10 failures; the password routes keep their built-in limits. A capped account answers like an
// address with no account, and its owner's way out is real: the reset link is not held behind the login cap, and a
// reset or a change of password clears the account's count, so the next sign-in from anywhere answers 200. A refusal
// clears nothing, and nothing clears an address's own bucket.

const RULE = 2
/** Ten times the login rule (the built-in rule is 10, so 100). */
const CEILING = RULE * 10

let s: PasswordStore
let addresses = 0
/** A client address no request of this file has come from. */
const fresh = (): string => {
  addresses += 1
  return `198.18.${Math.floor(addresses / 250)}.${(addresses % 250) + 1}`
}

beforeAll(async () => {
  s = await openPasswordStore((opts) => createKernel({ dialect: 'sqlite', ...opts }), {
    rateLimit: (config) => ({
      ...withoutAuthRateRules(config).security.rateLimit,
      '/api/auth/login': { requests: RULE, window: '15m', action: 'block' },
    }),
  })
}, 60_000)

afterAll(async () => {
  await s?.close()
})

afterEach(() => {
  vi.useRealTimers()
})

/** CEILING failed sign-ins for `email`, each from an address of its own. */
async function capped(email: string): Promise<void> {
  for (let i = 0; i < CEILING; i += 1) {
    const answer = await login(s, email, `wrong-${i}-password`, { forwardedFor: fresh() })
    expect(answer.status, `failure ${i + 1} of ${CEILING}`).toBe(401)
  }
}

/** An address whose own login bucket is full: RULE failures at an email nobody has. */
async function fullAddress(): Promise<string> {
  const address = fresh()
  for (let i = 0; i < RULE; i += 1) {
    await login(s, `filler-${randomUUID().slice(0, 8)}@reset.test`, 'wrong-password', {
      forwardedFor: address,
    })
  }
  return address
}

describe('AC-4: the account ceiling over HTTP', () => {
  // Defect: the cap is decided from the customer row, which enumerates.
  it('AC-4: past the ceiling a registered address, with its right password, and a never-registered address get 429 with byte-equal bodies and retry-after', async () => {
    const owner = await registered(s, 'ac4-equal')
    const nobody = `ac4-nobody-${randomUUID().slice(0, 8)}@reset.test`
    // The clock stands still, so both windows end at one instant and retry-after cannot differ by a second.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
    for (let i = 0; i < CEILING; i += 1) {
      await login(s, owner.email, `wrong-${i}-password`, { forwardedFor: fresh() })
      await login(s, nobody, `wrong-${i}-password`, { forwardedFor: fresh() })
    }

    const known = await login(s, owner.email, owner.password, { forwardedFor: fresh() })
    const unknown = await login(s, nobody, owner.password, { forwardedFor: fresh() })

    expect([known.status, unknown.status]).toEqual([429, 429])
    expect(known.text).toBe(unknown.text)
    expect(known.headers.get('retry-after')).toBe(unknown.headers.get('retry-after'))
  }, 60_000)

  // Defect: reset is held behind the login cap; or finish clears under ctx.path, or not at all, so an owner who reset
  // on the storefront still gets 429 from /api/auth/login.
  it('AC-4: while an account is capped its reset link signs it in, and the next sign-in from a fresh address answers 200; a refused reset clears nothing, and the reset clears no address bucket', async () => {
    const owner = await registered(s, 'ac4-reset')
    await capped(owner.email)
    const whileCapped = await login(s, owner.email, owner.password, { forwardedFor: fresh() })
    const refusedReset = await reset(s, neverIssued(), `ac4-${randomUUID()}`, {
      forwardedFor: fresh(),
    })
    const afterRefusal = await login(s, owner.email, owner.password, { forwardedFor: fresh() })
    const token = await mailedToken(s, owner.email)
    const busy = await fullAddress()
    const next = `ac4-reset-${randomUUID()}`

    const answer = await reset(s, token, next, { forwardedFor: busy })
    const fromBusy = await login(s, owner.email, next, { forwardedFor: busy })
    const fromFresh = await login(s, owner.email, next, { forwardedFor: fresh() })

    expect([whileCapped.status, refusedReset.status, afterRefusal.status]).toEqual([429, 400, 429])
    expect(answer.status, answer.text).toBe(200)
    expect((await me(s, answer.body.data!.accessToken!)).status).toBe(200)
    expect(fromBusy.status, 'the address bucket stands').toBe(429)
    expect(fromFresh.status, fromFresh.text).toBe(200)
  }, 60_000)

  // Defect: the change clears under ctx.path, or not at all; or a refused change clears the count.
  it('AC-4: a session that outlived the cap changes the password, and the next sign-in from a fresh address answers 200; a refused change clears nothing, and the change clears no address bucket', async () => {
    const owner = await registered(s, 'ac4-change')
    await capped(owner.email)
    const whileCapped = await login(s, owner.email, owner.password, { forwardedFor: fresh() })
    const refusedChange = await change(
      s,
      owner.accessToken,
      'not-the-password',
      `ac4-${randomUUID()}`,
      {
        forwardedFor: fresh(),
      },
    )
    const afterRefusal = await login(s, owner.email, owner.password, { forwardedFor: fresh() })
    const busy = await fullAddress()
    const next = `ac4-change-${randomUUID()}`

    const answer = await change(s, owner.accessToken, owner.password, next, { forwardedFor: busy })
    const fromBusy = await login(s, owner.email, next, { forwardedFor: busy })
    const fromFresh = await login(s, owner.email, next, { forwardedFor: fresh() })

    expect([whileCapped.status, refusedChange.status, afterRefusal.status]).toEqual([429, 400, 429])
    expect(answer.status, answer.text).toBe(200)
    expect(fromBusy.status, 'the address bucket stands').toBe(429)
    expect(fromFresh.status, fromFresh.text).toBe(200)
  }, 60_000)
})
