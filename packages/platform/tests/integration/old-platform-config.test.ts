import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { ConfigError } from '@nymbalhq/types'
import { runAsActor } from '../../src/audit/actor.js'
import {
  REMOTE_SECRET_ENV,
  REMOTE_SECRET_MIN_LENGTH,
  REMOTE_TIMEOUT_MS,
} from '../../src/services/legacy-remote.js'
import { createKernel, kernelConfig, type Kernel } from '../support/kernel.js'
import { bodyOf, startOldPlatform, type FakeOldPlatform } from '../../src/tests/old-platform.js'
import {
  dateIn,
  importer,
  refusalOf,
  REFUSED,
  tag,
} from '../support/suites/old-platform-sign-in.js'

// `security.auth.legacy.remote` in a store's config: the schema (which loadConfig runs on the file) takes only an
// HTTPS URL without credentials, a timeout from 500 to 10000 ms and a block with its sunset; createApp takes the
// shared secret from NYMBAL_LEGACY_AUTH_SECRET, at least 32 characters, and a booted store asks the old platform with
// it. The schema is the only place the scheme is checked, so a booted store is pointed at the in-process fake by
// parsing an HTTPS config and then setting `remote.url` to the fake's http://127.0.0.1:<port>.

const URL_KEY = 'security.auth.legacy.remote.url'
const TIMEOUT_KEY = 'security.auth.legacy.remote.timeoutMs'
const UNTIL_KEY = 'security.auth.legacy.until'
const HTTPS_URL = 'https://old.example/nymbal/check'

function withLegacyBlock(
  config: NymbalConfig,
  legacy: Record<string, unknown>,
): Record<string, unknown> {
  return { ...config, security: { ...config.security, auth: { ...config.security.auth, legacy } } }
}

/** What loadConfig would tell the operator, one `key: message` line per issue; empty when the block parses. */
function refusalLines(legacy: Record<string, unknown>): string[] {
  const result = nymbalConfigSchema.safeParse(withLegacyBlock(kernelConfig('sqlite'), legacy))
  return result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
}

describe('AC-13: the config block', () => {
  it('AC-13: a remote.url over http, not a URL, or holding a user name or password is refused naming the key, and the credentials case’s message does not echo them', () => {
    const urls = [
      'http://old.example/nymbal/check',
      'not a url',
      'https://user:pass@old.example/check',
      'https://user@old.example/check',
      'https://shop:Hunter2-x9@old.example/check',
    ]
    const got = urls.map((url) => {
      const lines = refusalLines({ until: dateIn(30), remote: { url } })
      return [
        url,
        lines.some((l) => l.startsWith(`${URL_KEY}:`)),
        lines.some((l) => /user:pass|pass@|Hunter2-x9/.test(l)),
      ]
    })
    expect(got).toEqual(urls.map((url) => [url, true, false]))
  })

  it('AC-13: timeoutMs outside 500 to 10000, or not an integer, is refused naming the key; the bounds parse', () => {
    const verdict = (timeoutMs: number) => {
      const lines = refusalLines({ until: dateIn(30), remote: { url: HTTPS_URL, timeoutMs } })
      return lines.length === 0
        ? 'parses'
        : lines.some((l) => l.startsWith(`${TIMEOUT_KEY}:`))
          ? 'refused'
          : lines.join('; ')
    }
    const cases: Array<[number, string]> = [
      [0, 'refused'],
      [60_000, 'refused'],
      [499, 'refused'],
      [10_001, 'refused'],
      [1_500.5, 'refused'],
      [500, 'parses'],
      [10_000, 'parses'],
    ]
    expect(cases.map(([ms]) => [ms, verdict(ms)])).toEqual(cases)
  })

  it('AC-13: a block with remote and no until is refused at until; a valid block parses with timeoutMs REMOTE_TIMEOUT_MS (5000)', () => {
    const noUntil = refusalLines({ remote: { url: HTTPS_URL } })
    const parsed = nymbalConfigSchema.parse(
      withLegacyBlock(kernelConfig('sqlite'), { until: dateIn(30), remote: { url: HTTPS_URL } }),
    )
    expect(noUntil.some((l) => l.startsWith(`${UNTIL_KEY}:`))).toBe(true)
    expect(parsed.security.auth.legacy?.remote).toEqual({
      url: HTTPS_URL,
      timeoutMs: REMOTE_TIMEOUT_MS,
    })
    expect(REMOTE_TIMEOUT_MS).toBe(5_000)
  })
})

describe('AC-13: the shared secret at boot', () => {
  let fake: FakeOldPlatform
  const saved = process.env[REMOTE_SECRET_ENV]
  const open: Kernel[] = []

  beforeAll(async () => {
    fake = await startOldPlatform()
  })
  afterAll(async () => {
    await fake?.close()
  })
  afterEach(async () => {
    for (const k of open.splice(0)) await k.close()
    if (saved === undefined) delete process.env[REMOTE_SECRET_ENV]
    else process.env[REMOTE_SECRET_ENV] = saved
  })

  /** A store booted from a config parsed with an HTTPS URL, then pointed at the fake, with the variable as given. */
  async function boot(secret: string | undefined): Promise<Kernel> {
    if (secret === undefined) delete process.env[REMOTE_SECRET_ENV]
    else process.env[REMOTE_SECRET_ENV] = secret
    const k = await createKernel({
      dialect: 'sqlite',
      configure: (config) => {
        const parsed = nymbalConfigSchema.parse(
          withLegacyBlock(config, { until: dateIn(30), remote: { url: HTTPS_URL } }),
        ) as NymbalConfig
        const legacy = parsed.security.auth.legacy!
        return {
          ...parsed,
          security: {
            ...parsed.security,
            auth: {
              ...parsed.security.auth,
              legacy: { ...legacy, remote: { ...legacy.remote!, url: fake.url } },
            },
          },
        }
      },
    })
    open.push(k)
    return k
  }

  async function bootError(secret: string | undefined) {
    const error = await boot(secret).then(
      () => null,
      (e: unknown) => e,
    )
    return [
      error instanceof ConfigError,
      (error as ConfigError | null)?.code,
      String((error as Error | null)?.message).includes(REMOTE_SECRET_ENV),
      String((error as Error | null)?.message).includes(String(REMOTE_SECRET_MIN_LENGTH)),
    ]
  }

  it('AC-13: with remote set, NYMBAL_LEGACY_AUTH_SECRET unset or 31 characters rejects createApp with ConfigError auth.legacy_remote_secret naming the variable', async () => {
    const refused = [
      await bootError(undefined),
      await bootError('s'.repeat(REMOTE_SECRET_MIN_LENGTH - 1)),
    ]
    expect([REMOTE_SECRET_ENV, REMOTE_SECRET_MIN_LENGTH]).toEqual(['NYMBAL_LEGACY_AUTH_SECRET', 32])
    expect(refused).toEqual([
      [true, 'auth.legacy_remote_secret', true, true],
      [true, 'auth.legacy_remote_secret', true, true],
    ])
  }, 30_000)

  it('AC-13: with a 32-character secret the store boots and a marker customer’s sign-in reaches the fake with that bearer', async () => {
    const secret = `${tag()}${'k'.repeat(REMOTE_SECRET_MIN_LENGTH - 8)}`
    const k = await boot(secret)
    const email = `boot-${tag()}@old.test`
    await runAsActor(importer, () => k.services.auth.importCustomer({ email }))
    fake.requests.splice(0)
    const answer = await refusalOf(k.services.auth.login(email, 'an-old-password'))
    expect(secret).toHaveLength(REMOTE_SECRET_MIN_LENGTH)
    expect([
      answer,
      fake.requests.map((r) => [r.headers.authorization, (bodyOf(r) as { email: string }).email]),
    ]).toEqual([REFUSED, [[`Bearer ${secret}`, email]]])
  }, 30_000)
})
