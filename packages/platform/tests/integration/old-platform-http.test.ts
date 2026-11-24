import { afterEach, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { REMOTE_SECRET_ENV } from '../../src/services/legacy-remote.js'
import { createKernel } from '../support/kernel.js'
import {
  bodyOf,
  startOldPlatform,
  VALID_FALSE,
  validTrue,
  type FakeOldPlatform,
} from '../../src/tests/old-platform.js'
import { login, me, openPasswordStore, type PasswordStore } from '../support/password-reset.js'
import {
  dateIn,
  OLD_PLATFORM_SECRET,
  refusalOf,
  REFUSED,
  tag,
} from '../support/suites/old-platform-sign-in.js'

// A booted store whose config names the old platform, over HTTP: a shopper the store has never seen signs in at the
// storefront's route with their old password, and a refusal that asked nobody takes as long as one that asked. The
// config is parsed with an HTTPS URL, as loadConfig parses a store's file, then pointed at the in-process fake.

const saved = process.env[REMOTE_SECRET_ENV]
const open: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  for (const x of open.splice(0).reverse()) await x.close()
  if (saved === undefined) delete process.env[REMOTE_SECRET_ENV]
  else process.env[REMOTE_SECRET_ENV] = saved
})

function pointedAt(config: NymbalConfig, url: string): NymbalConfig {
  const parsed = nymbalConfigSchema.parse({
    ...config,
    security: {
      ...config.security,
      auth: {
        ...config.security.auth,
        legacy: { until: dateIn(30), remote: { url: 'https://old.example/nymbal/check' } },
      },
    },
  }) as NymbalConfig
  const legacy = parsed.security.auth.legacy!
  return {
    ...parsed,
    security: {
      ...parsed.security,
      auth: { ...parsed.security.auth, legacy: { ...legacy, remote: { ...legacy.remote!, url } } },
    },
  }
}

async function storeWithOldPlatform(): Promise<{ s: PasswordStore; fake: FakeOldPlatform }> {
  process.env[REMOTE_SECRET_ENV] = OLD_PLATFORM_SECRET
  const fake = await startOldPlatform()
  open.push(fake)
  const s = await openPasswordStore((opts) =>
    createKernel({
      dialect: 'sqlite',
      ...opts,
      configure: (config) => pointedAt(opts.configure(config), fake.url),
    }),
  )
  open.push(s)
  return { s, fake }
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

async function timed<T>(call: () => Promise<T>): Promise<[number, T]> {
  const started = performance.now()
  const answer = await call()
  return [performance.now() - started, answer]
}

describe('AC-14: a first sign-in over HTTP', () => {
  it('AC-14: an unknown shopper signs in at POST /api/auth/login with the password the old platform accepts and gets 200, the customer, an access token and the refresh cookie; /api/customers/me answers their email and the old platform’s first name; with the old platform down the same request answers 401 in the envelope a wrong password gets', async () => {
    const { s, fake } = await storeWithOldPlatform()
    const email = `first-${tag()}@old.test`
    fake.reply = () => validTrue({ firstName: 'Grace' })
    const signedIn = await login(s, email, 'old-platform-password')
    const profile = await me(s, signedIn.body.data?.accessToken ?? 'none')
    const profileBody = JSON.parse(profile.text || '{}') as {
      data?: { email?: string; firstName?: string }
    }

    const native = await s.k.services.auth.register({
      email: `native-${tag()}@old.test`,
      password: 'native-correct-horse',
    })
    const wrong = await login(s, native.customer.email, 'wrong-password')
    await fake.close()
    const down = await login(s, `down-${tag()}@old.test`, 'old-platform-password')
    const envelope = (a: typeof wrong) => ({
      status: a.status,
      code: a.body.error?.code,
      message: a.body.error?.message,
      keys: Object.keys(a.body).sort(),
      errorKeys: Object.keys(a.body.error ?? {}).sort(),
    })

    expect([
      signedIn.status,
      signedIn.body.data?.customer?.email,
      typeof signedIn.body.data?.accessToken,
      signedIn.refreshCookie !== undefined,
    ]).toEqual([200, email, 'string', true])
    expect([profile.status, profileBody.data?.email, profileBody.data?.firstName]).toEqual([
      200,
      email,
      'Grace',
    ])
    expect(envelope(down)).toEqual(envelope(wrong))
    expect([down.status, down.body.error?.code]).toEqual([401, 'auth.invalid_credentials'])
    expect(fake.requests.map((r) => (bodyOf(r) as { email: string }).email)).toEqual([email])
  }, 30_000)
})

describe('AC-11: a refusal that asked nobody waits as long as one that asked', () => {
  it('AC-11: with the old platform answering valid: false after 300 ms and five sign-ins seeding the samples, the median refusal over HTTP for a native wrong password is within 150 ms of the median for unknown addresses, and the old platform received all ten requests', async () => {
    const { s, fake } = await storeWithOldPlatform()
    fake.reply = async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return VALID_FALSE
    }
    const seeds: string[] = []
    for (let i = 0; i < 5; i += 1) {
      seeds.push(
        await refusalOf(s.k.app.services.auth.login(`seed-${i}-${tag()}@old.test`, 'old-or-wrong')),
      )
    }
    const native = await s.k.services.auth.register({
      email: `native-${tag()}@old.test`,
      password: 'native-correct-horse',
    })
    const nativeMs: number[] = []
    const unknownMs: number[] = []
    const statuses: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const [n, a] = await timed(() => login(s, native.customer.email, 'wrong-password'))
      const [u, b] = await timed(() => login(s, `unknown-${i}-${tag()}@old.test`, 'old-or-wrong'))
      nativeMs.push(n)
      unknownMs.push(u)
      statuses.push(a.status, b.status)
    }
    expect(seeds).toEqual(Array<string>(5).fill(REFUSED))
    expect(statuses).toEqual(Array<number>(10).fill(401))
    expect(fake.requests).toHaveLength(10)
    expect(
      Math.abs(median(nativeMs) - median(unknownMs)),
      `native ${nativeMs.map(Math.round).join(', ')} ms; unknown ${unknownMs.map(Math.round).join(', ')} ms`,
    ).toBeLessThanOrEqual(150)
  }, 60_000)
})
