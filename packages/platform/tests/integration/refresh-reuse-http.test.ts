import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { primedShopper } from '../support/security.js'
import { shopper } from '../support/shopper.js'

// Over HTTP, on a clock the test sets (Date faked, timers real): a refresh cookie that was rotated, presented again
// after the 30 s reuse window, answers 401 auth.token_invalid and ends every session of its customer, so the
// successor cookie and the customer's second device, signed in on its own, answer 401 too.

const REFRESH_COOKIE = 'nymbal.refresh'
const WINDOW_MS = 30_000
const PASSWORD = 'correct-horse-battery'

let s: ServedKernel

beforeAll(async () => {
  s = await serveKernel(await createKernel({ dialect: 'sqlite' }))
}, 60_000)

afterAll(async () => {
  await s?.stop()
})

afterEach(() => {
  vi.useRealTimers()
})

/** A browser of its own, signed in with the customer's password; its jar holds the refresh cookie. */
async function signedInDevice(email: string) {
  const device = await primedShopper(s.baseUrl)
  const login = await device.call('POST', '/api/auth/login', { email, password: PASSWORD })
  expect(login.status, JSON.stringify(login.body)).toBe(200)
  return device
}

describe('AC-17: a refresh cookie replayed after the window ends every session', () => {
  it('AC-17: POST /api/auth/refresh with a rotated cookie past the window answers 401 auth.token_invalid; then the successor cookie and the customer’s second device answer 401 too', async () => {
    const t0 = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    const email = `reuse-${randomUUID()}@http.test`
    await s.kernel.services.auth.register({ email, password: PASSWORD })
    const first = await signedInDevice(email)
    const second = await signedInDevice(email)
    const rotated = first.jar.get(REFRESH_COOKIE)!

    const rotation = await first.call('POST', '/api/auth/refresh')
    expect(rotation.status).toBe(200)
    expect(first.jar.get(REFRESH_COOKIE)).not.toBe(rotated)

    vi.setSystemTime(t0 + WINDOW_MS + 1000)
    const thief = shopper(s.baseUrl, new Map([...first.jar, [REFRESH_COOKIE, rotated]]))
    const answers = []
    for (const [who, device] of [
      ['the replayed rotated cookie', thief],
      ['the successor cookie', first],
      ['the second device', second],
    ] as const) {
      const res = await device.call('POST', '/api/auth/refresh')
      answers.push([who, res.status, res.body.error?.code])
    }

    expect(answers).toEqual(answers.map(([who]) => [who, 401, 'auth.token_invalid']))
  })
})
